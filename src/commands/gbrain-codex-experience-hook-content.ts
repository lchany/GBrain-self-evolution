export const GBRAIN_CODEX_EXPERIENCE_HOOK_FILENAME = 'gbrain-experience-guard.py';
export const GBRAIN_CODEX_EXPERIENCE_HOOK_STATUS = 'GBrain 经验 Worker 守卫';

export const GBRAIN_CODEX_EXPERIENCE_HOOK = String.raw`#!/usr/bin/env python3
"""Codex worker guard for GBrain experience recall and closeout.

The hook never calls MCP and never stores raw prompts, commands, responses, or
transcripts. It records only bounded turn metadata and structured receipts.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import secrets
import shlex
import stat
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 3
MAX_BLOCKS = 2
RETENTION_SECONDS = 7 * 24 * 60 * 60
TOKEN_TTL_SECONDS = 24 * 60 * 60
VALID_CLOSEOUT_OUTCOMES = {"no_candidate", "captured", "blocked"}
VALID_RECALL_CLASSIFICATIONS = {"direct", "partial", "none"}
VALID_CANDIDATE_BASES = {
    "explicit_retention_request",
    "repeated_verified_incident",
    "verified_reusable_knowledge",
    "verified_project_milestone",
}
MAX_ENVELOPE_BYTES = 2048
MAX_CONSTRAINTS = 3
MAX_CONSTRAINT_CHARS = 240
VERIFIED_EXECUTION_AUTHORITY_RE = re.compile(r"(?m)^authority:\s*verified_execution\s*$")
SOURCE_REFS_RE = re.compile(r"(?ms)^source_refs:\s*\n(?:\s*-\s*[^\s#][^\n]*\n?)+")
SECTION_RE = re.compile(r"(?ms)^##\s+([^\n]+)\n(.*?)(?=^##\s+|\Z)")
INSTRUCTION_AUTHORITY_RE = re.compile(r"(?m)^authority:\s*user_explicit_instruction\s*$")
INSTRUCTION_SCOPE_RE = re.compile(r"(?m)^instruction_scope:\s*(global|project)\s*$")
INSTRUCTION_SOURCE_RE = re.compile(r"(?ms)^source_refs:\s*\n(?:\s*-\s*user_instruction:(global|project):[^\s#][^\n]*\n?)+")
UNVERIFIED_VALUE_RE = re.compile(r"(?:待验证|未验证|未知|不适用|猜测|推测|假设|\btbd\b|\bunknown\b|\bunverified\b)", re.IGNORECASE)
NONTRIVIAL_RE = re.compile(
    r"(修改|实现|开发|修复|部署|迁移|诊断|排查|安全|隐私|项目规则|总结|复盘|"
    r"modify|implement|build|fix|deploy|migrat|diagnos|debug|security|privacy|summari[sz]e)",
    re.IGNORECASE,
)
PERSIST_INTENT_RE = re.compile(
    r"(保存为经验|记录(?:这|该)?条?(?:规则|经验|知识)|写入(?:长期)?(?:记忆|经验)|沉淀为经验|"
    r"请记住|帮我记住|remember\s+(?:this|that)|save\s+(?:this|that)\s+(?:as\s+)?(?:memory|experience)|"
    r"record\s+(?:this|that)\s+(?:rule|experience|knowledge)|persist\s+(?:this|that))",
    re.IGNORECASE,
)
CRITICAL_BASH_RE = re.compile(
    r"(^|\s)(git\s+(commit|push)|docker|kubectl|helm|systemctl|ssh|scp|rsync|"
    r"npm\s+(install|publish)|pnpm\s+(install|publish)|bun\s+(install|publish)|"
    r"rm\s|mv\s|cp\s|chmod\s|chown\s|sed\s+-i|deploy|migrat)",
    re.IGNORECASE,
)
EXPECTED_TEST_RE = re.compile(
    r"(^|\s)(test|pytest|bun\s+(run\s+)?test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test)(\s|$)",
    re.IGNORECASE,
)
EXPECTED_NEGATIVE_RE = re.compile(r"(^|\s)(rg|grep|git\s+diff\s+--quiet)(\s|$)", re.IGNORECASE)
FAILED_RESPONSE_RE = re.compile(r"(process exited with code|exit[_ -]?code[\"']?\s*[:=])\s*[1-9]", re.IGNORECASE)
INBOX_SLUG_RE = re.compile(r"^inbox/[a-z0-9][a-z0-9/_-]{0,180}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,240}$")
RECALL_WORKER_RE = re.compile(r"(?:^|\n)GBRAIN_EXPERIENCE_RECALL_WORKER_TOKEN=(gbr_[A-Za-z0-9_-]+)(?:\n|$)")
CLOSEOUT_WORKER_RE = re.compile(r"(?:^|\n)GBRAIN_EXPERIENCE_CLOSEOUT_WORKER_TOKEN=((?:gbc|gb)_[A-Za-z0-9_-]+)(?:\n|$)")
BLOCKER_CODE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def _json_out(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", "replace")).hexdigest()


def _safe_identifier(value: Any, fallback: str) -> str:
    text = value if isinstance(value, str) else ""
    return text if SAFE_ID_RE.fullmatch(text) else fallback


def _raw_state_root() -> Path:
    configured = os.environ.get("GBRAIN_EXPERIENCE_HOOK_STATE_DIR")
    root = Path(configured).expanduser() if configured else Path.home() / ".codex" / "gbrain-experience-guard"
    if not root.is_absolute():
        raise RuntimeError("state directory must be an absolute path")
    return root


def _state_root() -> Path:
    root = _raw_state_root()
    if root.exists() or root.is_symlink():
        info = root.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise RuntimeError("state directory is not a trusted directory")
        if hasattr(os, "getuid") and info.st_uid != os.getuid():
            raise RuntimeError("state directory has an untrusted owner")
        if info.st_mode & 0o022:
            raise RuntimeError("state directory is group/world writable")
    else:
        root.mkdir(parents=True, mode=0o700)
    os.chmod(root, 0o700)
    return root


def _secure_dir(path: Path) -> None:
    root = _raw_state_root()
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise RuntimeError("state child escapes the state directory") from exc
    current = root
    for part in relative.parts:
        current = current / part
        if current.exists() or current.is_symlink():
            info = current.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise RuntimeError("state child is not a trusted directory")
            if hasattr(os, "getuid") and info.st_uid != os.getuid():
                raise RuntimeError("state child has an untrusted owner")
            if info.st_mode & 0o022:
                raise RuntimeError("state child is group/world writable")
        else:
            current.mkdir(mode=0o700)
        os.chmod(current, 0o700)


def _read_json(path: Path) -> dict[str, Any] | None:
    _secure_dir(path.parent)
    if not path.exists():
        return None
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise RuntimeError("state file is not a trusted regular file")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise RuntimeError("state file has an untrusted owner")
    if info.st_mode & 0o022:
        raise RuntimeError("state file is group/world writable")
    if info.st_size > 64 * 1024:
        raise RuntimeError("state file exceeds the size limit")
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else None


def _atomic_write(path: Path, value: dict[str, Any]) -> None:
    _secure_dir(path.parent)
    fd, temporary = tempfile.mkstemp(prefix=".gbrain-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def _cleanup(root: Path) -> None:
    cutoff = time.time() - RETENTION_SECONDS
    visited: list[Path] = []
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        directories[:] = [name for name in directories if not (current_path / name).is_symlink()]
        visited.extend(current_path / name for name in directories)
        for name in files:
            child = current_path / name
            try:
                info = child.lstat()
                if stat.S_ISREG(info.st_mode) and info.st_mtime < cutoff:
                    child.unlink()
            except OSError:
                continue
    for child in sorted(visited, reverse=True):
        try:
            child.rmdir()
        except OSError:
            continue


def _turn_key(payload: dict[str, Any]) -> str:
    session = _safe_identifier(payload.get("session_id"), "missing-session")
    turn = _safe_identifier(payload.get("turn_id"), "missing-turn")
    return _hash(session + "\0" + turn)


def _session_key(payload: dict[str, Any]) -> str:
    return _hash(_safe_identifier(payload.get("session_id"), "missing-session"))


def _turn_path(root: Path, key: str) -> Path:
    return root / "turns" / f"{key}.json"


def _pending_path(root: Path, session_key: str) -> Path:
    return root / "pending" / f"{session_key}.json"


@contextmanager
def _turn_lock(root: Path, key: str):
    if re.fullmatch(r"[a-f0-9]{64}", key) is None:
        raise RuntimeError("invalid turn lock key")
    path = root / "locks" / f"{key}.lock"
    _secure_dir(path.parent)
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
            raise RuntimeError("turn lock is not trusted")
        if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
            raise RuntimeError("turn lock has an untrusted owner")
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def _new_turn_state(root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    pending = bool(_read_json(_pending_path(root, _session_key(payload))))
    return {
        "schema_version": SCHEMA_VERSION,
        "created_at": int(time.time()),
        "updated_at": int(time.time()),
        "session_key": _session_key(payload),
        "intent_nontrivial": False,
        "explicit_persist_intent": False,
        "prior_pending": pending,
        "block_count": 0,
        "recall_token_hash": None,
        "closeout_token_hash": None,
        "worker_token_hash": None,
        "worker_phase": None,
        "closeout_worker": False,
        "recall_notified": False,
        "closeout_notified": False,
        "recall_receipt": None,
        "closeout_receipt": None,
    }


def _upgrade_turn_state(state: dict[str, Any]) -> dict[str, Any]:
    if int(state.get("schema_version", 1)) < SCHEMA_VERSION:
        legacy_receipt = state.get("receipt")
        if isinstance(legacy_receipt, dict) and not isinstance(state.get("closeout_receipt"), dict):
            state["closeout_receipt"] = legacy_receipt
        legacy_nonce = state.get("nonce_hash")
        if isinstance(legacy_nonce, str) and not state.get("closeout_token_hash"):
            state["closeout_token_hash"] = legacy_nonce
    state["schema_version"] = SCHEMA_VERSION
    state.setdefault("recall_token_hash", None)
    state.setdefault("closeout_token_hash", None)
    state.setdefault("explicit_persist_intent", False)
    state.setdefault("worker_token_hash", None)
    state.setdefault("worker_phase", "closeout" if state.get("closeout_worker") else None)
    state.setdefault("recall_notified", False)
    state.setdefault("closeout_notified", False)
    state.setdefault("recall_receipt", None)
    state.setdefault("closeout_receipt", None)
    state.pop("nonce_hash", None)
    state.pop("receipt", None)
    return state


def _load_turn(root: Path, payload: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    key = _turn_key(payload)
    state = _upgrade_turn_state(_read_json(_turn_path(root, key)) or _new_turn_state(root, payload))
    return key, state


def _save_turn(root: Path, key: str, state: dict[str, Any]) -> None:
    state["updated_at"] = int(time.time())
    _atomic_write(_turn_path(root, key), state)


def _tool_event(payload: dict[str, Any]) -> dict[str, Any]:
    tool_name = _safe_identifier(payload.get("tool_name"), "unknown")
    tool_input = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    command = tool_input.get("command") if isinstance(tool_input.get("command"), str) else ""
    response = payload.get("tool_response")
    response_dict = response if isinstance(response, dict) else {}
    failed = bool(response_dict.get("isError") or response_dict.get("is_error") or response_dict.get("error"))
    exit_code = response_dict.get("exit_code")
    if isinstance(exit_code, int) and exit_code != 0:
        failed = True
    if isinstance(response, str) and FAILED_RESPONSE_RE.search(response):
        failed = True
    output = response_dict.get("output")
    if isinstance(output, str) and FAILED_RESPONSE_RE.search(output):
        failed = True
    expected_failure = tool_name == "Bash" and bool(EXPECTED_TEST_RE.search(command) or EXPECTED_NEGATIVE_RE.search(command))
    write_like = tool_name in {"apply_patch", "Edit", "Write"} or tool_name.endswith("__write_file")
    critical_bash = tool_name == "Bash" and bool(CRITICAL_BASH_RE.search(command))
    slug = tool_input.get("slug") if isinstance(tool_input.get("slug"), str) else None
    safe_slug = slug if slug and INBOX_SLUG_RE.fullmatch(slug) else None
    success = not failed
    return {
        "schema_version": SCHEMA_VERSION,
        "created_at": int(time.time()),
        "tool_name_hash": _hash(tool_name),
        "write_like": write_like,
        "critical_bash": critical_bash,
        "unexpected_failure": failed and not expected_failure,
        "put_slug": safe_slug if tool_name == "mcp__gbrain__put_page" and success else None,
        "get_slug": safe_slug if tool_name == "mcp__gbrain__get_page" and success else None,
    }


def _events(root: Path, key: str) -> list[dict[str, Any]]:
    directory = root / "events" / key
    _secure_dir(directory)
    if not directory.exists():
        return []
    values: list[dict[str, Any]] = []
    for path in directory.glob("*.json"):
        try:
            value = _read_json(path)
            if value:
                values.append(value)
        except (OSError, ValueError, RuntimeError):
            continue
    return values


def _requires_closeout(state: dict[str, Any], events: list[dict[str, Any]]) -> bool:
    return bool(
        state.get("explicit_persist_intent")
        or state.get("prior_pending")
        or any(event.get("unexpected_failure") for event in events)
    )


def _requires_recall(state: dict[str, Any]) -> bool:
    return bool(
        state.get("intent_nontrivial")
        or state.get("explicit_persist_intent")
        or state.get("prior_pending")
    )


def _valid_constraints(value: Any) -> bool:
    return bool(
        isinstance(value, list)
        and len(value) <= MAX_CONSTRAINTS
        and all(isinstance(item, str) and 0 < len(item) <= MAX_CONSTRAINT_CHARS for item in value)
    )


def _envelope_fits(value: dict[str, Any]) -> bool:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) <= MAX_ENVELOPE_BYTES


def _recall_receipt_valid(receipt: dict[str, Any]) -> tuple[bool, str]:
    if receipt.get("classification") not in VALID_RECALL_CLASSIFICATIONS:
        return False, "unknown recall classification"
    if not _valid_constraints(receipt.get("constraints")):
        return False, "invalid recall constraints"
    if not _envelope_fits(receipt):
        return False, "recall envelope exceeds size limit"
    return True, "ok"


def _closeout_receipt_valid(receipt: dict[str, Any]) -> tuple[bool, str]:
    outcome = receipt.get("outcome")
    if outcome not in VALID_CLOSEOUT_OUTCOMES:
        return False, "unknown outcome"
    expected_status = "blocked" if outcome == "blocked" else "accepted"
    if receipt.get("receipt_status") != expected_status:
        return False, "closeout receipt status does not match outcome"
    if outcome == "captured":
        slug = receipt.get("slug")
        if (
            not isinstance(slug, str)
            or not INBOX_SLUG_RE.fullmatch(slug)
            or receipt.get("verified") is not True
            or receipt.get("blocker_code") is not None
            or receipt.get("candidate_basis") not in VALID_CANDIDATE_BASES
        ):
            return False, "captured receipt requires a verified inbox slug and valid candidate basis"
    if outcome == "no_candidate" and (
        receipt.get("verified") is not True
        or receipt.get("slug") is not None
        or receipt.get("blocker_code") is not None
        or receipt.get("candidate_basis") is not None
    ):
        return False, "no-candidate receipt requires verified recall and dedup"
    if outcome == "blocked":
        blocker_code = receipt.get("blocker_code")
        if (
            not isinstance(blocker_code, str)
            or not BLOCKER_CODE_RE.fullmatch(blocker_code)
            or receipt.get("slug") is not None
            or receipt.get("verified") is not False
            or receipt.get("candidate_basis") is not None
        ):
            return False, "blocked receipt requires a safe blocker code"
    if not _envelope_fits(receipt):
        return False, "closeout envelope exceeds size limit"
    return True, "ok"


def _remove_turn(root: Path, key: str) -> None:
    try:
        _secure_dir(_turn_path(root, key).parent)
        _turn_path(root, key).unlink()
    except FileNotFoundError:
        pass
    directory = root / "events" / key
    try:
        _secure_dir(directory)
    except RuntimeError:
        return
    if directory.exists() and not directory.is_symlink():
        for path in directory.glob("*.json"):
            try:
                path.unlink()
            except OSError:
                pass
        try:
            directory.rmdir()
        except OSError:
            pass


def _remove_turn_family(root: Path, key: str, state: dict[str, Any]) -> None:
    token_hashes = {
        value for value in (state.get("recall_token_hash"), state.get("closeout_token_hash"))
        if isinstance(value, str) and value
    }
    if token_hashes:
        turns = root / "turns"
        _secure_dir(turns)
        for path in list(turns.glob("*.json")):
            try:
                worker = _read_json(path)
            except (OSError, ValueError, RuntimeError):
                continue
            worker_hash = str(worker.get("worker_token_hash") or "") if worker else ""
            if any(secrets.compare_digest(worker_hash, token_hash) for token_hash in token_hashes):
                _remove_turn(root, path.stem)
    _remove_turn(root, key)


def _unlink_state_file(path: Path) -> None:
    try:
        _secure_dir(path.parent)
        path.unlink()
    except FileNotFoundError:
        pass


def _arm_phase(state: dict[str, Any], phase: str) -> str:
    if phase not in {"recall", "closeout"}:
        raise RuntimeError("unknown experience phase")
    token = ("gbr_" if phase == "recall" else "gbc_") + secrets.token_urlsafe(24)
    token_hash = _hash(token)
    state[f"{phase}_token_hash"] = token_hash
    state[f"{phase}_notified"] = True
    return token


def _receipt_shell_command(token: str | None = None) -> str:
    prefix = ""
    if os.environ.get("GBRAIN_EXPERIENCE_HOOK_RECEIPT_ENV") == "1":
        prefix = "GBRAIN_EXPERIENCE_HOOK_STATE_DIR=" + shlex.quote(str(_raw_state_root())) + " "
    command = prefix + "python3 " + shlex.quote(str(Path(__file__).resolve())) + " receipt"
    return command + (" --token " + shlex.quote(token) if token is not None else "")


def _parent_context(recall_token: str | None, closeout_token: str | None, event_name: str) -> dict[str, Any]:
    sections: list[str] = []
    if recall_token is not None:
        recall_command = _receipt_shell_command(recall_token)
        sections.append(
            "GBRAIN_EXPERIENCE_RECALL_REQUIRED：开始当前非平凡任务前，必须派发独立 Recall Worker。"
            "主 Agent 只传递脱敏任务目标并等待最小结构化 envelope，不得自行调用 GBrain MCP 进行经验召回。"
            f"\nGBRAIN_EXPERIENCE_RECALL_WORKER_TOKEN={recall_token}\n"
            f"Worker 完成只读召回和分类后执行：{recall_command} "
            "--classification <direct|partial|none> --constraints-json '<JSON array>'。"
            "constraints 最多三条；不得返回正文、搜索列表、模板或日志。"
        )
    if closeout_token is not None:
        closeout_command = _receipt_shell_command(closeout_token)
        sections.append(
            "GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED：最终答复前必须派发独立 Closeout Worker。"
            "Worker 独占召回、去重、模板整理、写入、可修复拒绝重试和回读验证；主 Agent 全程等待。"
            f"\nGBRAIN_EXPERIENCE_CLOSEOUT_WORKER_TOKEN={closeout_token}\n"
            f"Worker 完成后执行：{closeout_command} "
            "--outcome <no_candidate|captured|blocked>；captured/no_candidate 必须追加 "
            "--verified，captured 还必须追加 --slug inbox/<slug> 和 --candidate-basis "
            "<explicit_retention_request|repeated_verified_incident|verified_reusable_knowledge|verified_project_milestone>，"
            "blocked 必须追加 --blocker-code <code>。"
        )
    return {
        "hookSpecificOutput": {
            "hookEventName": event_name,
            "additionalContext": "\n\n".join(sections),
        },
    }


def _block(root: Path, key: str, state: dict[str, Any], phases: set[str], invalid_reason: str | None = None) -> None:
    if int(state.get("block_count", 0)) >= MAX_BLOCKS:
        _remove_turn_family(root, key, state)
        _json_out({"systemMessage": "GBrain 经验守卫连续两次未取得有效回执，已 fail-open，不再阻止当前回合结束。"})
        return
    recall_token = None
    closeout_token = None
    if "recall" in phases:
        state["recall_receipt"] = None
        recall_token = _arm_phase(state, "recall")
    if "closeout" in phases:
        state["closeout_receipt"] = None
        closeout_token = _arm_phase(state, "closeout")
    state["block_count"] = int(state.get("block_count", 0)) + 1
    _save_turn(root, key, state)
    prefix = "上次回执证据无效。" if invalid_reason else ""
    context = _parent_context(recall_token, closeout_token, "Stop")
    reason = prefix + str(context["hookSpecificOutput"]["additionalContext"])
    _json_out({"decision": "block", "reason": reason})


def _handle_hook(root: Path, payload: dict[str, Any]) -> None:
    event_name = payload.get("hook_event_name")
    key, state = _load_turn(root, payload)
    if event_name == "UserPromptSubmit":
        prompt = payload.get("prompt") if isinstance(payload.get("prompt"), str) else ""
        recall_worker_match = RECALL_WORKER_RE.search(prompt)
        closeout_worker_match = CLOSEOUT_WORKER_RE.search(prompt)
        if recall_worker_match is not None or closeout_worker_match is not None:
            phase = "recall" if recall_worker_match is not None else "closeout"
            match = recall_worker_match if recall_worker_match is not None else closeout_worker_match
            if match is None:
                raise RuntimeError("worker token match disappeared")
            token = match.group(1)
            found = _find_turn_for_token(root, token)
            if found is None or found[2] != phase:
                _remove_turn(root, key)
                _json_out({"systemMessage": f"GBRAIN_EXPERIENCE_{phase.upper()}_WORKER_INVALID：token 无效；Worker 不得继续。"})
                return
            state["intent_nontrivial"] = False
            state["explicit_persist_intent"] = False
            state["worker_phase"] = phase
            state["closeout_worker"] = phase == "closeout"
            state["worker_token_hash"] = _hash(token)
            _save_turn(root, key, state)
            receipt_command = _receipt_shell_command(token)
            if phase == "recall":
                worker_context = (
                    "GBRAIN_EXPERIENCE_RECALL_WORKER：只执行只读经验召回与分类，不得写 GBrain。"
                    f"完成后执行：{receipt_command} --classification <direct|partial|none> "
                    "--constraints-json '<JSON array>'。只返回 receipt 输出的最小 envelope，不要返回正文、"
                    "搜索列表或日志。不要再派生 Recall Worker。"
                )
            else:
                worker_context = (
                    "GBRAIN_EXPERIENCE_CLOSEOUT_WORKER：独占召回、去重、脱敏、写入、可修复拒绝重试与回读验证。"
                    f"完成后执行：{receipt_command} "
                    "--outcome <no_candidate|captured|blocked>；captured/no_candidate 追加 --verified，"
                    "captured 再追加 --slug inbox/<slug> 和 --candidate-basis "
                    "<explicit_retention_request|repeated_verified_incident|verified_reusable_knowledge|verified_project_milestone>，"
                    "blocked 追加 --blocker-code <code>。默认 no_candidate；只有一条资格路径成立且全部质量门禁通过时才能 captured。"
                    "按顺序搜索去重、选择资格路径，并检查新颖性、持久性、证据、可操作性、信息密度和载体必要性；"
                    "任一门禁失败即 no_candidate。任务复杂度、工具数量和完成状态不是候选依据。"
                    "只返回 receipt 输出的最小 envelope，不要返回正文、搜索列表、模板或日志。不要再派生 Closeout Worker。"
                )
            _json_out({
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": worker_context,
                },
            })
            return
        state["intent_nontrivial"] = bool(NONTRIVIAL_RE.search(prompt))
        state["explicit_persist_intent"] = bool(PERSIST_INTENT_RE.search(prompt))
        recall_token = _arm_phase(state, "recall") if _requires_recall(state) and not state.get("recall_notified") else None
        closeout_token = _arm_phase(state, "closeout") if _requires_closeout(state, []) and not state.get("closeout_notified") else None
        _save_turn(root, key, state)
        if recall_token is not None or closeout_token is not None:
            _json_out(_parent_context(recall_token, closeout_token, "UserPromptSubmit"))
        else:
            _json_out({})
        return
    if event_name == "PostToolUse":
        tool_id = _safe_identifier(payload.get("tool_use_id"), secrets.token_hex(12))
        event_path = root / "events" / key / f"{_hash(tool_id)}.json"
        if not event_path.exists():
            _atomic_write(event_path, _tool_event(payload))
        if not _turn_path(root, key).exists():
            _save_turn(root, key, state)
        events = _events(root, key)
        if not state.get("worker_phase") and not state.get("closeout_notified") and _requires_closeout(state, events):
            token = _arm_phase(state, "closeout")
            _save_turn(root, key, state)
            _json_out(_parent_context(None, token, "PostToolUse"))
        else:
            _json_out({})
        return
    if event_name != "Stop":
        _json_out({})
        return
    if state.get("worker_phase"):
        _json_out({})
        return
    events = _events(root, key)
    needs_recall = _requires_recall(state)
    needs_closeout = _requires_closeout(state, events)
    if not needs_recall and not needs_closeout:
        _remove_turn_family(root, key, state)
        _json_out({})
        return
    invalid_phases: set[str] = set()
    reasons: list[str] = []
    if needs_recall:
        recall_receipt = state.get("recall_receipt")
        if not isinstance(recall_receipt, dict):
            invalid_phases.add("recall")
            reasons.append("missing recall receipt")
        else:
            valid, reason = _recall_receipt_valid(recall_receipt)
            if not valid:
                invalid_phases.add("recall")
                reasons.append(reason)
    if needs_closeout:
        closeout_receipt = state.get("closeout_receipt")
        if not isinstance(closeout_receipt, dict):
            invalid_phases.add("closeout")
            reasons.append("missing closeout receipt")
        else:
            valid, reason = _closeout_receipt_valid(closeout_receipt)
            if not valid:
                invalid_phases.add("closeout")
                reasons.append(reason)
    if invalid_phases:
        _block(root, key, state, invalid_phases, "; ".join(reasons))
        return
    _unlink_state_file(_pending_path(root, str(state.get("session_key") or "")))
    _remove_turn_family(root, key, state)
    _json_out({})


def _find_turn_for_token(root: Path, token: str) -> tuple[Path, dict[str, Any], str] | None:
    turns = root / "turns"
    _secure_dir(turns)
    if not turns.exists():
        return None
    digest = _hash(token)
    for path in turns.glob("*.json"):
        try:
            state = _read_json(path)
        except (OSError, ValueError, RuntimeError):
            continue
        if not state:
            continue
        state = _upgrade_turn_state(state)
        updated_at = state.get("updated_at")
        if not isinstance(updated_at, (int, float)) or time.time() - updated_at > TOKEN_TTL_SECONDS:
            continue
        for phase in ("recall", "closeout"):
            if (
                not isinstance(state.get(f"{phase}_receipt"), dict)
                and secrets.compare_digest(str(state.get(f"{phase}_token_hash") or ""), digest)
            ):
                return path, state, phase
    return None


def _parse_constraints(raw: str | None) -> list[str]:
    if raw is None:
        return []
    parsed = json.loads(raw)
    if not _valid_constraints(parsed):
        raise ValueError("constraints must be a JSON array of at most three bounded strings")
    return parsed


def _receipt_command(root: Path, args: argparse.Namespace) -> int:
    found = _find_turn_for_token(root, args.token)
    if not found:
        _json_out({"ok": False, "error": "invalid_or_expired_token"})
        return 1
    path, _, phase = found
    with _turn_lock(root, path.stem):
        raw_state = _read_json(path)
        if raw_state is None:
            _json_out({"ok": False, "error": "invalid_or_expired_token"})
            return 1
        state = _upgrade_turn_state(raw_state)
        token_field = f"{phase}_token_hash"
        if not secrets.compare_digest(str(state.get(token_field) or ""), _hash(args.token)):
            _json_out({"ok": False, "error": "invalid_or_expired_token"})
            return 1
        if isinstance(state.get(f"{phase}_receipt"), dict):
            _json_out({"ok": False, "error": "invalid_or_expired_token"})
            return 1
        if phase == "recall":
            if (
                args.outcome is not None
                or args.slug is not None
                or args.verified
                or args.blocker_code is not None
                or args.candidate_basis is not None
            ):
                _json_out({"ok": False, "error": "phase_argument_mismatch"})
                return 1
            if args.classification not in VALID_RECALL_CLASSIFICATIONS:
                _json_out({"ok": False, "error": "classification_required"})
                return 1
            try:
                constraints = _parse_constraints(args.constraints_json)
            except (json.JSONDecodeError, ValueError) as exc:
                _json_out({"ok": False, "error": str(exc)})
                return 1
            envelope = {
                "phase": "recall",
                "classification": args.classification,
                "constraints": constraints,
                "receipt_status": "accepted",
            }
            valid, reason = _recall_receipt_valid(envelope)
            if not valid:
                _json_out({"ok": False, "error": reason})
                return 1
            state["recall_receipt"] = envelope
        else:
            if args.classification is not None or args.constraints_json is not None:
                _json_out({"ok": False, "error": "phase_argument_mismatch"})
                return 1
            if args.outcome not in VALID_CLOSEOUT_OUTCOMES:
                _json_out({"ok": False, "error": "outcome_required"})
                return 1
            if args.slug is not None and not INBOX_SLUG_RE.fullmatch(args.slug):
                _json_out({"ok": False, "error": "invalid_inbox_slug"})
                return 1
            envelope = {
                "phase": "closeout",
                "outcome": args.outcome,
                "slug": args.slug,
                "verified": bool(args.verified),
                "receipt_status": "blocked" if args.outcome == "blocked" else "accepted",
                "blocker_code": args.blocker_code,
            }
            if args.candidate_basis is not None:
                envelope["candidate_basis"] = args.candidate_basis
            valid, reason = _closeout_receipt_valid(envelope)
            if not valid:
                _json_out({"ok": False, "error": reason})
                return 1
            state["closeout_receipt"] = envelope
        state["updated_at"] = int(time.time())
        _atomic_write(path, state)
    _json_out(envelope)
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="gbrain-experience-guard.py")
    subparsers = parser.add_subparsers(dest="command")
    receipt = subparsers.add_parser("receipt")
    receipt.add_argument("--token", required=True)
    receipt.add_argument("--classification", choices=sorted(VALID_RECALL_CLASSIFICATIONS))
    receipt.add_argument("--constraints-json")
    receipt.add_argument("--outcome", choices=sorted(VALID_CLOSEOUT_OUTCOMES))
    receipt.add_argument("--slug")
    receipt.add_argument("--verified", action="store_true")
    receipt.add_argument("--blocker-code")
    receipt.add_argument("--candidate-basis", choices=sorted(VALID_CANDIDATE_BASES))
    return parser


def main() -> int:
    try:
        root = _state_root()
        _cleanup(root)
        _unlink_state_file(root / "mode.json")
        if len(sys.argv) > 1:
            args = _parser().parse_args()
            if args.command == "receipt":
                return _receipt_command(root, args)
            raise ValueError("missing command")
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        if not isinstance(payload, dict):
            raise ValueError("hook input must be a JSON object")
        with _turn_lock(root, _turn_key(payload)):
            _handle_hook(root, payload)
        return 0
    except Exception as exc:
        if len(sys.argv) > 1:
            _json_out({"ok": False, "error": str(exc)})
            return 1
        _json_out({"systemMessage": "GBrain 经验守卫异常，已 fail-open。"})
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;
