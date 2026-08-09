export const GBRAIN_CODEX_EXPERIENCE_HOOK_FILENAME = 'gbrain-experience-guard.py';
export const GBRAIN_CODEX_EXPERIENCE_HOOK_STATUS = 'GBrain 经验收尾守卫';

export const GBRAIN_CODEX_EXPERIENCE_HOOK = String.raw`#!/usr/bin/env python3
"""Codex turn-close guard for GBrain experience governance.

The hook never calls MCP and never stores raw prompts, commands, responses, or
transcripts. It records only bounded turn metadata and structured receipts.
"""

from __future__ import annotations

import argparse
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

SCHEMA_VERSION = 1
MAX_BLOCKS = 2
RETENTION_SECONDS = 7 * 24 * 60 * 60
VALID_OUTCOMES = {"defer", "no_candidate", "captured", "rejected"}
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
    }


def _load_turn(root: Path, payload: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    key = _turn_key(payload)
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


def _receipt_valid(receipt: dict[str, Any], events: list[dict[str, Any]]) -> tuple[bool, str]:
    outcome = receipt.get("outcome")
    if outcome not in VALID_OUTCOMES:
        return False, "unknown outcome"
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


def _unlink_state_file(path: Path) -> None:
    try:
        _secure_dir(path.parent)
        path.unlink()
    except FileNotFoundError:
        pass


def _set_deferred(root: Path, state: dict[str, Any]) -> None:
    session_key = str(state.get("session_key") or "")
    if not re.fullmatch(r"[a-f0-9]{64}", session_key):
        raise RuntimeError("turn state lacks a valid session key")
    _atomic_write(_pending_path(root, session_key), {
        "schema_version": SCHEMA_VERSION,
        "created_at": time.time(),
        "kind": "defer",
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
        "如有候选，立即按固定模板脱敏后写入 inbox/，调用 get_page 验证。Hook 本身不得调用 MCP。"
        f"完成本次检查后执行：{receipt_command} "
        f"--token {token} --outcome <defer|no_candidate|captured|rejected>"
        "；captured 还需添加 --slug inbox/<slug>。"
    )
    _json_out({"decision": "block", "reason": reason})


def _handle_hook(root: Path, payload: dict[str, Any]) -> None:
    event_name = payload.get("hook_event_name")
    key, state = _load_turn(root, payload)
    if event_name == "UserPromptSubmit":
        prompt = payload.get("prompt") if isinstance(payload.get("prompt"), str) else ""
        state["intent_nontrivial"] = bool(NONTRIVIAL_RE.search(prompt))
        _save_turn(root, key, state)
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
        valid, reason = _receipt_valid(receipt, events)
        if valid:
            if receipt.get("outcome") == "defer":
                _set_deferred(root, state)
            else:
                _unlink_state_file(_pending_path(root, str(state.get("session_key") or "")))
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
        if state and secrets.compare_digest(str(state.get("nonce_hash") or ""), digest):
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
    if args.outcome == "captured" and args.slug is None:
        _json_out({"ok": False, "error": "slug_required"})
        return 1
    state["receipt"] = {"outcome": args.outcome, "slug": args.slug, "created_at": int(time.time())}
    state["nonce_hash"] = None
    _atomic_write(path, state)
    _json_out({"ok": True, "outcome": args.outcome, "slug": args.slug})
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="gbrain-experience-guard.py")
    subparsers = parser.add_subparsers(dest="command")
    receipt = subparsers.add_parser("receipt")
    receipt.add_argument("--token", required=True)
    receipt.add_argument("--outcome", required=True, choices=sorted(VALID_OUTCOMES))
    receipt.add_argument("--slug")
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
