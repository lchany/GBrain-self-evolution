export const GBRAIN_CODEX_EXPERIENCE_HOOK_FILENAME = 'gbrain-experience-guard.py';
export const GBRAIN_CODEX_EXPERIENCE_HOOK_STATUS = 'GBrain 经验收尾守卫';

export const GBRAIN_CODEX_EXPERIENCE_HOOK = String.raw`#!/usr/bin/env python3
"""Codex turn-close guard for GBrain experience governance.

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
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
MAX_BLOCKS = 2
RETENTION_SECONDS = 7 * 24 * 60 * 60
REVIEW_TIMEOUT_SECONDS = 5 * 60
VALID_OUTCOMES = {"defer", "no_candidate", "previewed", "captured", "rejected"}
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


def _resume_path(root: Path, key: str) -> Path:
    return root / "resumes" / f"{key}.json"


def _new_turn_state(root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    pending = bool(_read_json(_pending_path(root, _session_key(payload))))
    return {
        "schema_version": SCHEMA_VERSION,
        "created_at": int(time.time()),
        "updated_at": int(time.time()),
        "session_key": _session_key(payload),
        "session_id": _safe_identifier(payload.get("session_id"), "missing-session"),
        "intent_nontrivial": False,
        "prior_pending": pending,
        "block_count": 0,
        "nonce_hash": None,
        "receipt": None,
        "review": None,
    }


def _load_turn(root: Path, payload: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    key = _turn_key(payload)
    resume = _read_json(_resume_path(root, key))
    original_key = resume.get("turn_key") if resume else None
    if isinstance(original_key, str) and re.fullmatch(r"[a-f0-9]{64}", original_key):
        state = _read_json(_turn_path(root, original_key))
        if state:
            return original_key, state
    state = _read_json(_turn_path(root, key)) or _new_turn_state(root, payload)
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
    expected_failure = tool_name == "Bash" and bool(EXPECTED_TEST_RE.search(command) or EXPECTED_NEGATIVE_RE.search(command))
    write_like = tool_name in {"apply_patch", "Edit", "Write"} or tool_name.endswith("__write_file")
    critical_bash = tool_name == "Bash" and bool(CRITICAL_BASH_RE.search(command))
    subagent = tool_name in {"Agent", "spawn_agent"} or tool_name.endswith("__spawn_agent")
    slug = tool_input.get("slug") if isinstance(tool_input.get("slug"), str) else None
    safe_slug = slug if slug and INBOX_SLUG_RE.fullmatch(slug) else None
    success = not failed
    return {
        "schema_version": SCHEMA_VERSION,
        "created_at": int(time.time()),
        "tool_name_hash": _hash(tool_name),
        "write_like": write_like,
        "critical_bash": critical_bash,
        "subagent": subagent,
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
        state.get("intent_nontrivial")
        or state.get("prior_pending")
        or len(events) >= 3
        or any(event.get("write_like") or event.get("critical_bash") or event.get("subagent") or event.get("unexpected_failure") for event in events)
    )


def _preview_is_complete(message: Any) -> bool:
    if not isinstance(message, str):
        return False
    required = [
        "预分类建议", "type:", "status: draft", "## 场景与目标", "## 适用条件",
        "## 不适用条件", "## 验证证据", "## 脱敏说明", "5 分钟", "inbox/",
    ]
    return all(part in message for part in required)


def _preview_has_verified_evidence(message: Any) -> bool:
    """Accept concrete execution evidence while preserving the service draft schema."""
    if not isinstance(message, str) or VERIFIED_EXECUTION_AUTHORITY_RE.search(message) is None:
        return False
    if SOURCE_REFS_RE.search(message) is None:
        return False
    sections = {match.group(1).strip(): match.group(2) for match in SECTION_RE.finditer(message)}
    evidence = sections.get("验证证据", "")
    values: list[str] = []
    for label in ("验证环境", "验证方法", "预期结果", "实际结果", "验证时间"):
        match = re.search(r"(?m)^\s*-\s*" + re.escape(label) + r"\s*[:：]\s*([^\n]+?)\s*$", evidence)
        if match is None:
            return False
        value = match.group(1).strip()
        if not value or UNVERIFIED_VALUE_RE.search(value):
            return False
        values.append(value)
    return bool(values)


def _preview_has_instruction_evidence(message: Any) -> bool:
    """Explicit global/project instructions are authoritative evidence, not hypotheses."""
    if not isinstance(message, str):
        return False
    scope = INSTRUCTION_SCOPE_RE.search(message)
    if INSTRUCTION_AUTHORITY_RE.search(message) is None or scope is None:
        return False
    source = INSTRUCTION_SOURCE_RE.search(message)
    return source is not None and source.group(1) == scope.group(1)


def _receipt_valid(receipt: dict[str, Any], events: list[dict[str, Any]], message: Any) -> tuple[bool, str]:
    outcome = receipt.get("outcome")
    if outcome not in VALID_OUTCOMES:
        return False, "unknown outcome"
    if outcome == "previewed":
        if not _preview_is_complete(message):
            return False, "preview missing the full template, preclassification, or five-minute notice"
        if not _preview_has_verified_evidence(message) and not _preview_has_instruction_evidence(message):
            return False, "preview must be either a verified experience with concrete evidence or an explicit global/project user instruction with authoritative source metadata"
    if outcome == "captured":
        slug = receipt.get("slug")
        put_slugs = {event.get("put_slug") for event in events}
        get_slugs = {event.get("get_slug") for event in events}
        if not isinstance(slug, str) or slug not in put_slugs or slug not in get_slugs:
            return False, "captured receipt lacks matching successful put_page and get_page evidence"
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


def _interrupt_path(root: Path, session_key: str) -> Path:
    return root / "interrupts" / f"{session_key}.json"


@contextmanager
def _session_lock(root: Path, session_key: str):
    if not re.fullmatch(r"[a-f0-9]{64}", session_key):
        raise RuntimeError("invalid session key")
    path = root / "locks" / f"{session_key}.lock"
    _secure_dir(path.parent)
    flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError("session lock is not a regular file")
        if hasattr(os, "getuid") and info.st_uid != os.getuid():
            raise RuntimeError("session lock has an untrusted owner")
        os.fchmod(fd, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def _unlink_state_file(path: Path) -> None:
    try:
        _secure_dir(path.parent)
        path.unlink()
    except FileNotFoundError:
        pass


def _clear_pending(root: Path, session_key: str) -> None:
    _unlink_state_file(_pending_path(root, session_key))
    _unlink_state_file(_interrupt_path(root, session_key))


def _review_timeout_seconds() -> int:
    if os.environ.get("GBRAIN_EXPERIENCE_HOOK_TESTING") != "1":
        return REVIEW_TIMEOUT_SECONDS
    raw = os.environ.get("GBRAIN_EXPERIENCE_HOOK_TEST_REVIEW_SECONDS", "")
    if not re.fullmatch(r"[1-9]|[12][0-9]|30", raw):
        return REVIEW_TIMEOUT_SECONDS
    return int(raw)


def _set_deferred(root: Path, state: dict[str, Any]) -> None:
    session_key = str(state.get("session_key") or "")
    if not re.fullmatch(r"[a-f0-9]{64}", session_key):
        raise RuntimeError("turn state lacks a valid session key")
    _clear_pending(root, session_key)
    _atomic_write(_pending_path(root, session_key), {
        "schema_version": SCHEMA_VERSION,
        "created_at": time.time(),
        "kind": "defer",
    })


def _resume_prompt(slug: str, token: str) -> str:
    return (
        "GBRAIN_REVIEW_RESUME: 静默审核期已结束且没有用户回复。"
        f"现在将刚才锁定的完整正文写入 {slug}，调用 get_page 验证后执行 "
        f"gbrain-experience-guard.py receipt --token {token} --outcome captured --slug {slug}。"
    )


def _start_wake_worker(token: str) -> None:
    if os.environ.get("GBRAIN_EXPERIENCE_HOOK_TESTING") == "1" and "GBRAIN_CODEX_BIN" not in os.environ:
        return
    subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "wake", "--token", token],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def _start_review(root: Path, key: str, state: dict[str, Any], slug: str) -> str:
    session_key = str(state.get("session_key") or "")
    if not re.fullmatch(r"[a-f0-9]{64}", session_key):
        raise RuntimeError("turn state lacks a valid session key")
    token = "gb_" + secrets.token_urlsafe(24)
    now = time.time()
    review = {
        "token_hash": _hash(token),
        "slug": slug,
        "created_at": now,
        "deadline_at": now + _review_timeout_seconds(),
        "status": "waiting",
    }
    state["review"] = review
    _save_turn(root, key, state)
    with _session_lock(root, session_key):
        _clear_pending(root, session_key)
        _atomic_write(_pending_path(root, session_key), {
            "schema_version": SCHEMA_VERSION,
            "kind": "review",
            "turn_key": key,
            "token_hash": review["token_hash"],
            "slug": slug,
            "session_id": state["session_id"],
            "created_at": now,
            "deadline_at": review["deadline_at"],
            "status": "waiting",
        })
    _start_wake_worker(token)
    return token


def _review_interrupted(root: Path, state: dict[str, Any], review: dict[str, Any]) -> bool:
    session_key = str(state.get("session_key") or "")
    interrupted = _read_json(_interrupt_path(root, session_key))
    interrupted_at = interrupted.get("created_at") if interrupted else None
    deadline = review.get("deadline_at")
    return isinstance(interrupted_at, (int, float)) and isinstance(deadline, (int, float)) and interrupted_at < deadline


def _save_review_status(root: Path, key: str, state: dict[str, Any], status_value: str) -> None:
    review = state.get("review")
    if not isinstance(review, dict):
        raise RuntimeError("turn state lacks review metadata")
    review["status"] = status_value
    state["review"] = review
    _save_turn(root, key, state)
    session_key = str(state.get("session_key") or "")
    pending = _read_json(_pending_path(root, session_key))
    if pending and pending.get("kind") == "review":
        pending["status"] = status_value
        _atomic_write(_pending_path(root, session_key), pending)


def _review_block(token: str, slug: str) -> None:
    _json_out({
        "systemMessage": (
            "完整经验正文已展示，已启动后台 5 分钟静默审核。收到任何用户消息会取消自动同意；"
            f"无回复时将恢复当前会话，以写入并验证锁定草稿 {slug}。Hook 本身不会调用 MCP。"
        ),
    })


def _capture_block(slug: str) -> None:
    _json_out({
        "decision": "block",
        "reason": (
            "5 分钟静默期已结束且没有用户消息，现已默认同意。请将刚才锁定的完整正文写入 "
            f"{slug}，调用 get_page 验证后，使用此前 wait 命令中的同一 token 记录 "
            f"captured 回执（slug 为 {slug}）。仅授权写入 inbox 草稿，不授权晋升。"
        ),
    })


def _block(root: Path, key: str, state: dict[str, Any], invalid_reason: str | None = None) -> None:
    if int(state.get("block_count", 0)) >= MAX_BLOCKS:
        _remove_turn(root, key)
        _json_out({"systemMessage": "GBrain 经验守卫连续两次未取得有效回执，已 fail-open，不再阻止当前回合结束。"})
        return
    token = "gb_" + secrets.token_urlsafe(24)
    state["nonce_hash"] = _hash(token)
    state["receipt"] = None
    state["block_count"] = int(state.get("block_count", 0)) + 1
    _save_turn(root, key, state)
    prefix = "上次回执证据无效。" if invalid_reason else ""
    receipt_command = f"python3 {shlex.quote(str(Path(__file__).resolve()))} receipt"
    reason = (
        f"{prefix}请执行 GBrain 经验收尾检查：先只读召回和去重，判断是否形成候选；"
        "候选写入仍必须按既有规则展示完整模板并等待用户审核，Hook 本身不得调用 MCP。"
        f"完成本次检查后执行：{receipt_command} "
        f"--token {token} --outcome <defer|no_candidate|previewed|captured|rejected>"
        "；previewed/captured 还需添加 --slug inbox/<slug>。"
    )
    _json_out({"decision": "block", "reason": reason})


def _handle_hook(root: Path, payload: dict[str, Any]) -> None:
    event_name = payload.get("hook_event_name")
    key, state = _load_turn(root, payload)
    if event_name == "UserPromptSubmit":
        prompt = payload.get("prompt") if isinstance(payload.get("prompt"), str) else ""
        session_key = _session_key(payload)
        with _session_lock(root, session_key):
            pending = _read_json(_pending_path(root, session_key))
            if prompt.startswith("GBRAIN_REVIEW_RESUME:") and pending and pending.get("status") == "waking":
                original_key = pending.get("turn_key")
                current_key = _turn_key(payload)
                if isinstance(original_key, str) and re.fullmatch(r"[a-f0-9]{64}", original_key):
                    _atomic_write(_resume_path(root, current_key), {"turn_key": original_key})
                    _json_out({})
                    return
        state["intent_nontrivial"] = bool(NONTRIVIAL_RE.search(prompt))
        _save_turn(root, key, state)
        with _session_lock(root, session_key):
            pending = _read_json(_pending_path(root, session_key))
            if pending and pending.get("kind") == "review":
                deadline = pending.get("deadline_at")
                now = time.time()
                if isinstance(deadline, (int, float)) and now < deadline:
                    _atomic_write(_interrupt_path(root, session_key), {
                        "schema_version": SCHEMA_VERSION,
                        "created_at": now,
                    })
                    _json_out({"systemMessage": "检测到用户消息，经验草稿的 5 分钟自动同意已取消；请按该消息处理。"})
                    return
                if isinstance(deadline, (int, float)):
                    pending["status"] = "approved"
                    _atomic_write(_pending_path(root, session_key), pending)
                    _json_out({"systemMessage": "经验草稿的 5 分钟静默期已经结束，应先按默认同意完成 inbox 写入与验证。"})
                    return
        _json_out({})
        return
    if event_name == "PostToolUse":
        tool_id = _safe_identifier(payload.get("tool_use_id"), secrets.token_hex(12))
        event_path = root / "events" / key / f"{_hash(tool_id)}.json"
        if not event_path.exists():
            _atomic_write(event_path, _tool_event(payload))
        if not _turn_path(root, key).exists():
            _save_turn(root, key, state)
        _json_out({})
        return
    if event_name != "Stop":
        _json_out({})
        return
    events = _events(root, key)
    if not _requires_closeout(state, events):
        _remove_turn(root, key)
        _json_out({})
        return
    receipt = state.get("receipt")
    if isinstance(receipt, dict):
        valid, reason = _receipt_valid(receipt, events, payload.get("last_assistant_message"))
        if valid:
            outcome = receipt.get("outcome")
            session_key = str(state.get("session_key") or _session_key(payload))
            if outcome == "previewed":
                slug = receipt.get("slug")
                if not isinstance(slug, str):
                    _block(root, key, state, "previewed receipt lacks an inbox slug")
                    return
                review = state.get("review")
                if not isinstance(review, dict):
                    token = _start_review(root, key, state, slug)
                    _review_block(token, slug)
                    return
                if _review_interrupted(root, state, review) or review.get("status") == "interrupted":
                    _clear_pending(root, session_key)
                    _remove_turn(root, key)
                    _json_out({})
                    return
                deadline = review.get("deadline_at")
                if review.get("status") == "approved" or (isinstance(deadline, (int, float)) and time.time() >= deadline):
                    _save_review_status(root, key, state, "approved")
                    _capture_block(slug)
                    return
                _json_out({
                    "decision": "block",
                    "reason": "经验草稿仍在 5 分钟静默审核期；请继续等待此前 wait 命令完成。",
                })
                return
            if outcome == "defer":
                _set_deferred(root, state)
            else:
                _clear_pending(root, session_key)
            _remove_turn(root, key)
            _json_out({})
            return
        _block(root, key, state, reason)
        return
    _block(root, key, state)


def _find_turn_for_token(root: Path, token: str) -> tuple[Path, dict[str, Any]] | None:
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
        if state:
            review = state.get("review") if isinstance(state.get("review"), dict) else {}
            hashes = [str(state.get("nonce_hash") or ""), str(review.get("token_hash") or "")]
            if any(secrets.compare_digest(candidate, digest) for candidate in hashes):
                return path, state
    return None


def _receipt_command(root: Path, args: argparse.Namespace) -> int:
    found = _find_turn_for_token(root, args.token)
    if not found:
        _json_out({"ok": False, "error": "invalid_or_expired_token"})
        return 1
    path, state = found
    if args.outcome not in VALID_OUTCOMES:
        _json_out({"ok": False, "error": "invalid_outcome"})
        return 1
    if args.slug is not None and not INBOX_SLUG_RE.fullmatch(args.slug):
        _json_out({"ok": False, "error": "invalid_inbox_slug"})
        return 1
    if args.outcome in {"previewed", "captured"} and args.slug is None:
        _json_out({"ok": False, "error": "slug_required"})
        return 1
    state["receipt"] = {"outcome": args.outcome, "slug": args.slug, "created_at": int(time.time())}
    state["nonce_hash"] = None
    if args.outcome == "previewed" and isinstance(state.get("review"), dict):
        session_key = str(state.get("session_key") or "")
        _clear_pending(root, session_key)
        state["review"] = None
    _atomic_write(path, state)
    _json_out({"ok": True, "outcome": args.outcome, "slug": args.slug})
    return 0


def _find_pending_for_token(root: Path, token: str) -> tuple[Path, dict[str, Any]] | None:
    directory = root / "pending"
    _secure_dir(directory)
    digest = _hash(token)
    for path in directory.glob("*.json"):
        try:
            pending = _read_json(path)
        except (OSError, ValueError, RuntimeError):
            continue
        if pending and secrets.compare_digest(str(pending.get("token_hash") or ""), digest):
            return path, pending
    return None


def _wait_command(root: Path, args: argparse.Namespace) -> int:
    found = _find_pending_for_token(root, args.token)
    if not found:
        _json_out({"ok": False, "error": "invalid_or_expired_token"})
        return 1
    pending_path, pending = found
    session_key = pending_path.stem
    while True:
        with _session_lock(root, session_key):
            current = _read_json(pending_path)
            if not current:
                _json_out({"ok": False, "error": "review_no_longer_pending"})
                return 1
            deadline = current.get("deadline_at")
            turn_key = current.get("turn_key")
            if not isinstance(deadline, (int, float)) or not isinstance(turn_key, str):
                raise RuntimeError("pending review metadata is invalid")
            turn_path = _turn_path(root, turn_key)
            turn_state = _read_json(turn_path)
            if not turn_state:
                _json_out({"ok": False, "error": "review_turn_missing"})
                return 1
            review = turn_state.get("review")
            if not isinstance(review, dict):
                _json_out({"ok": False, "error": "review_state_missing"})
                return 1
            if _review_interrupted(root, turn_state, review):
                _save_review_status(root, turn_key, turn_state, "interrupted")
                _json_out({"ok": True, "status": "interrupted", "slug": current.get("slug")})
                return 0
            now = time.time()
            if now >= deadline:
                _save_review_status(root, turn_key, turn_state, "approved")
                _json_out({
                    "ok": True,
                    "status": "approved",
                    "slug": current.get("slug"),
                    "next": "write_locked_preview_to_inbox_then_get_page_and_record_captured",
                })
                return 0
        time.sleep(min(0.25, max(0.01, deadline - now)))


def _wake_command(root: Path, args: argparse.Namespace) -> int:
    found = _find_pending_for_token(root, args.token)
    if not found:
        return 0
    pending_path, pending = found
    session_key = pending_path.stem
    deadline = pending.get("deadline_at")
    if not isinstance(deadline, (int, float)):
        return 1
    time.sleep(max(0, deadline - time.time()))
    with _session_lock(root, session_key):
        current = _read_json(pending_path)
        if not current or current.get("status") != "waiting":
            return 0
        turn_key = current.get("turn_key")
        if not isinstance(turn_key, str):
            return 1
        turn_state = _read_json(_turn_path(root, turn_key))
        review = turn_state.get("review") if turn_state else None
        if not turn_state or not isinstance(review, dict) or _review_interrupted(root, turn_state, review):
            return 0
        current["status"] = "waking"
        _atomic_write(pending_path, current)
        review["status"] = "waking"
        turn_state["review"] = review
        _save_turn(root, turn_key, turn_state)
        session_id = current.get("session_id")
        slug = current.get("slug")
        if not isinstance(session_id, str) or not SAFE_ID_RE.fullmatch(session_id) or not isinstance(slug, str):
            return 1
    codex_bin = os.environ.get("GBRAIN_CODEX_BIN", "codex")
    subprocess.Popen([codex_bin, "exec", "resume", session_id, _resume_prompt(slug, args.token)], start_new_session=True)
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="gbrain-experience-guard.py")
    subparsers = parser.add_subparsers(dest="command")
    receipt = subparsers.add_parser("receipt")
    receipt.add_argument("--token", required=True)
    receipt.add_argument("--outcome", required=True, choices=sorted(VALID_OUTCOMES))
    receipt.add_argument("--slug")
    wait = subparsers.add_parser("wait")
    wait.add_argument("--token", required=True)
    wake = subparsers.add_parser("wake")
    wake.add_argument("--token", required=True)
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
            if args.command == "wait":
                return _wait_command(root, args)
            if args.command == "wake":
                return _wake_command(root, args)
            raise ValueError("missing command")
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        if not isinstance(payload, dict):
            raise ValueError("hook input must be a JSON object")
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
