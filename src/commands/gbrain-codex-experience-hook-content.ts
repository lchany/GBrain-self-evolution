export const GBRAIN_CODEX_EXPERIENCE_HOOK_FILENAME = 'gbrain-experience-guard.py';
export const GBRAIN_CODEX_EXPERIENCE_HOOK_STATUS = 'GBrain 经验 Worker 守卫';

export const GBRAIN_CODEX_EXPERIENCE_HOOK = String.raw`#!/usr/bin/env python3
"""Codex worker guard for read-only GBrain experience recall.

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
EXPLICIT_RECALL_RE = re.compile(
    r"(召回.{0,12}经验|查(?:找|询)?.{0,12}(?:历史|既有|已有)经验|"
    r"(?:recall|search|look\s+up).{0,20}(?:experience|lesson))",
    re.IGNORECASE,
)
DECISION_INTENT_RE = re.compile(
    r"(选择|选型|比较.{0,16}方案|决定|决策|取舍|要不要|该不该|是否采用|是否切换|"
    r"改变.{0,12}(?:架构|策略|边界|规则)|设计.{0,12}(?:架构|策略|方案)|"
    r"choose|select|decid|trade[ -]?off|should\s+we|whether\s+to\s+(?:adopt|switch)|redesign)",
    re.IGNORECASE,
)
HIGH_IMPACT_RE = re.compile(
    r"(架构|技术栈|数据库|核心协议|认证|授权|权限|安全|隐私|密钥|生产环境|生产拓扑|"
    r"流量入口|基础设施|数据迁移|批量删除|不可逆|恢复策略|全局规则|项目规则|长期约束|"
    r"architecture|tech(?:nology)?\s+stack|database|core\s+protocol|auth(?:entication|orization)?|"
    r"permission|security|privacy|secret|production|topology|infrastructure|data\s+migration|"
    r"bulk\s+delet|irreversible|recovery\s+strategy|global\s+rule|project\s+rule|long-term\s+constraint)",
    re.IGNORECASE,
)
EXPECTED_TEST_RE = re.compile(
    r"(^|\s)(test|pytest|bun\s+(run\s+)?test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test)(\s|$)",
    re.IGNORECASE,
)
EXPECTED_NEGATIVE_RE = re.compile(r"(^|\s)(rg|grep|git\s+diff\s+--quiet)(\s|$)", re.IGNORECASE)
FAILED_RESPONSE_RE = re.compile(r"(process exited with code|exit[_ -]?code[\"']?\s*[:=])\s*[1-9]", re.IGNORECASE)
CANCELLED_OR_INPUT_ERROR_RE = re.compile(
    r"(cancelled|canceled|aborted by user|invalid (?:input|argument)|missing required (?:input|argument)|"
    r"用户取消|已取消|参数无效|缺少必填)",
    re.IGNORECASE,
)
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
    return {
        "schema_version": SCHEMA_VERSION,
        "created_at": int(time.time()),
        "updated_at": int(time.time()),
        "session_key": _session_key(payload),
        "decision_intent": False,
        "block_count": 0,
        "recall_token_hash": None,
        "closeout_token_hash": None,
        "worker_token_hash": None,
        "worker_phase": None,
        "closeout_worker": False,
        "recall_notified": False,
        "failure_recall_notified": False,
        "recall_kind": None,
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
    state.setdefault("worker_token_hash", None)
    state.setdefault("worker_phase", "closeout" if state.get("closeout_worker") else None)
    state.setdefault("recall_notified", False)
    state.setdefault("failure_recall_notified", False)
    state.setdefault("recall_kind", None)
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
    raw_command = tool_input.get("command", tool_input.get("cmd"))
    command = raw_command if isinstance(raw_command, str) else ""
    response = payload.get("tool_response")
    response_dict = response if isinstance(response, dict) else {}
    failed = bool(response_dict.get("isError") or response_dict.get("is_error") or response_dict.get("error"))
    exit_code = response_dict.get("exit_code")
    if isinstance(exit_code, int) and exit_code != 0:
        failed = True
    response_text = response if isinstance(response, str) else json.dumps(response_dict, ensure_ascii=False)
    if FAILED_RESPONSE_RE.search(response_text):
        failed = True
    shell_tool = tool_name.casefold() in {"bash", "exec_command"} or tool_name.casefold().endswith("__exec_command")
    expected_failure = shell_tool and bool(EXPECTED_TEST_RE.search(command) or EXPECTED_NEGATIVE_RE.search(command))
    cancelled_or_input_error = bool(CANCELLED_OR_INPUT_ERROR_RE.search(response_text))
    return {
        "schema_version": SCHEMA_VERSION,
        "created_at": int(time.time()),
        "tool_name_hash": _hash(tool_name),
        "unexpected_failure": failed and not expected_failure and not cancelled_or_input_error,
    }


def _requires_decision_recall(prompt: str) -> bool:
    return bool(EXPLICIT_RECALL_RE.search(prompt) or (DECISION_INTENT_RE.search(prompt) and HIGH_IMPACT_RE.search(prompt)))


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
        ):
            return False, "captured receipt requires a verified inbox slug"
    if outcome == "no_candidate" and (
        receipt.get("verified") is not True
        or receipt.get("slug") is not None
        or receipt.get("blocker_code") is not None
    ):
        return False, "no-candidate receipt requires verified recall and dedup"
    if outcome == "blocked":
        blocker_code = receipt.get("blocker_code")
        if (
            not isinstance(blocker_code, str)
            or not BLOCKER_CODE_RE.fullmatch(blocker_code)
            or receipt.get("slug") is not None
            or receipt.get("verified") is not False
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


def _parent_context(
    recall_token: str | None,
    closeout_token: str | None,
    event_name: str,
    recall_kind: str | None = None,
) -> dict[str, Any]:
    sections: list[str] = []
    if recall_token is not None:
        recall_command = _receipt_shell_command(recall_token)
        trigger = (
            "当前方案出现非预期错误后"
            if recall_kind == "failure"
            else "重大决策执行前"
        )
        scope = (
            "只传递脱敏后的操作类别、稳定错误码或错误类别和环境类型"
            if recall_kind == "failure"
            else "只传递脱敏任务目标"
        )
        sections.append(
            f"GBRAIN_EXPERIENCE_RECALL_REQUIRED：{trigger}，必须派发独立 Recall Worker。"
            f"主 Agent {scope}并等待最小结构化 envelope，不得自行调用 GBrain MCP 进行经验召回。"
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
            "--verified，captured 还必须追加 --slug inbox/<slug>，blocked 必须追加 --blocker-code <code>。"
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
        if recall_worker_match is not None:
            phase = "recall"
            token = recall_worker_match.group(1)
            found = _find_turn_for_token(root, token)
            if found is None or found[2] != phase:
                _remove_turn(root, key)
                _json_out({"systemMessage": f"GBRAIN_EXPERIENCE_{phase.upper()}_WORKER_INVALID：token 无效；Worker 不得继续。"})
                return
            state["decision_intent"] = False
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
            _json_out({
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": worker_context,
                },
            })
            return
        state["decision_intent"] = _requires_decision_recall(prompt)
        recall_token = _arm_phase(state, "recall") if state["decision_intent"] and not state.get("recall_notified") else None
        if recall_token is not None:
            state["recall_kind"] = "decision"
        _save_turn(root, key, state)
        if recall_token is not None:
            _json_out(_parent_context(recall_token, None, "UserPromptSubmit", "decision"))
        else:
            _json_out({})
        return
    if event_name == "PostToolUse":
        tool_event = _tool_event(payload)
        if state.get("worker_phase") or not tool_event.get("unexpected_failure") or state.get("failure_recall_notified"):
            _json_out({})
            return
        if state.get("recall_notified") and not isinstance(state.get("recall_receipt"), dict):
            _json_out({})
            return
        state["recall_receipt"] = None
        state["recall_notified"] = False
        recall_token = _arm_phase(state, "recall")
        state["failure_recall_notified"] = True
        state["recall_kind"] = "failure"
        _save_turn(root, key, state)
        _json_out(_parent_context(recall_token, None, "PostToolUse", "failure"))
        return
    if event_name != "Stop":
        _json_out({})
        return
    # Older installations may still invoke this script from a managed Stop
    # handler. Fail open and clear the turn so upgrading the generated script
    # disables automatic closeout before hooks.json is rewritten.
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
            if args.outcome is not None or args.slug is not None or args.verified or args.blocker_code is not None:
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
