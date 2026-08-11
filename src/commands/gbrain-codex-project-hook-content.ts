export const GBRAIN_CODEX_PROJECT_HOOK_STATUS = '检查当前目录的 GBrain 项目 ID';
export const GBRAIN_CODEX_PROJECT_HOOK_FILENAME = 'gbrain-project-check.py';

export const GBRAIN_CODEX_PROJECT_HOOK = String.raw`#!/usr/bin/env python3
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

MARKER_NAME = ".gbrain-project.yaml"
REFERENCE_NAME = os.path.join(".gbrain", "project.yaml")
PROJECT_ID_RE = re.compile(r"^prj-[0-9a-f]{16}$")
MAX_MARKER_BYTES = 4096
CREATION_KEY_RE = re.compile(r"^gpc_[A-Za-z0-9_-]{16,80}$")
BOOTSTRAP_LEASE_SECONDS = 60 * 60


def emit(message, warning):
    payload = {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": message,
        },
    }
    if warning:
        payload["systemMessage"] = message
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def marker_is_trusted(metadata):
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        return False
    if hasattr(os, "getuid"):
        current_uid = os.getuid()
        if metadata.st_uid not in (current_uid, 0):
            return False
    return (metadata.st_mode & stat.S_IWOTH) == 0


def directory_is_trusted(metadata):
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        return False
    if hasattr(os, "getuid"):
        current_uid = os.getuid()
        if metadata.st_uid not in (current_uid, 0):
            return False
    return (metadata.st_mode & stat.S_IWOTH) == 0


def parse_project_id(content):
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    if len(lines) != 2 or lines[0] != "schema_version: 1":
        return None
    match = re.fullmatch(r"project_id:\s*(\S+)\s*", lines[1])
    if match is None or PROJECT_ID_RE.fullmatch(match.group(1)) is None:
        return None
    return match.group(1)


def read_reference_project_id(cwd):
    reference_path = os.path.join(cwd, REFERENCE_NAME)
    try:
        parent_metadata = os.lstat(os.path.dirname(reference_path))
        metadata = os.lstat(reference_path)
    except FileNotFoundError:
        return None
    except OSError:
        return None
    if not directory_is_trusted(parent_metadata):
        return None
    if not marker_is_trusted(metadata) or metadata.st_size > MAX_MARKER_BYTES:
        return None

    descriptor = None
    try:
        open_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(reference_path, open_flags)
        opened_metadata = os.fstat(descriptor)
        if (
            not marker_is_trusted(opened_metadata)
            or opened_metadata.st_dev != metadata.st_dev
            or opened_metadata.st_ino != metadata.st_ino
        ):
            return None
        with os.fdopen(descriptor, "r", encoding="utf-8") as reference_file:
            descriptor = None
            return parse_project_id(reference_file.read(MAX_MARKER_BYTES + 1))
    except (OSError, UnicodeError):
        return None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def bootstrap_state_root():
    root = Path(__file__).resolve().parent.parent / "gbrain-project-bootstrap"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root_metadata = root.lstat()
    if not directory_is_trusted(root_metadata) or root_metadata.st_mode & 0o077:
        raise RuntimeError("bootstrap state directory is not trusted")
    os.chmod(root, 0o700)
    return root


def bootstrap_state_path(root, cwd):
    digest = hashlib.sha256(cwd.encode("utf-8", "surrogatepass")).hexdigest()
    return root / f"{digest}.json"


@contextmanager
def bootstrap_lock(root, cwd):
    digest = hashlib.sha256(cwd.encode("utf-8", "surrogatepass")).hexdigest()
    path = root / f"{digest}.lock"
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        metadata = os.fstat(descriptor)
        if not marker_is_trusted(metadata) or metadata.st_mode & 0o077:
            raise RuntimeError("bootstrap lock is not trusted")
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def read_bootstrap_state(path):
    if not path.exists() and not path.is_symlink():
        return None
    metadata = path.lstat()
    if not marker_is_trusted(metadata) or metadata.st_size > 512 or metadata.st_mode & 0o077:
        raise RuntimeError("bootstrap state is not trusted")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("bootstrap state is invalid")
    creation_key = value.get("creation_key")
    created_at = value.get("created_at")
    if (
        not isinstance(creation_key, str)
        or CREATION_KEY_RE.fullmatch(creation_key) is None
        or isinstance(created_at, bool)
        or not isinstance(created_at, (int, float))
    ):
        raise RuntimeError("bootstrap state is invalid")
    return value


def write_bootstrap_state(path, value):
    descriptor, temporary = tempfile.mkstemp(prefix=".bootstrap-", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = None
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def bootstrap_creation_key(cwd):
    root = bootstrap_state_root()
    path = bootstrap_state_path(root, cwd)
    with bootstrap_lock(root, cwd):
        state = read_bootstrap_state(path)
        now = time.time()
        age = now - state["created_at"] if state is not None else None
        if state is not None and age is not None and 0 <= age <= BOOTSTRAP_LEASE_SECONDS:
            return state["creation_key"]
        creation_key = "gpc_" + secrets.token_urlsafe(24)
        write_bootstrap_state(path, {"creation_key": creation_key, "created_at": now})
        return creation_key


def read_bound_project_id(cwd):
    marker_path = os.path.join(cwd, MARKER_NAME)
    try:
        metadata = os.lstat(marker_path)
    except OSError:
        return None
    if not marker_is_trusted(metadata) or metadata.st_size > MAX_MARKER_BYTES:
        return None
    descriptor = None
    try:
        descriptor = os.open(marker_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        opened_metadata = os.fstat(descriptor)
        if (
            not marker_is_trusted(opened_metadata)
            or opened_metadata.st_dev != metadata.st_dev
            or opened_metadata.st_ino != metadata.st_ino
        ):
            return None
        with os.fdopen(descriptor, "r", encoding="utf-8") as marker_file:
            descriptor = None
            return parse_project_id(marker_file.read(MAX_MARKER_BYTES + 1))
    except (OSError, UnicodeError):
        return None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def complete_bootstrap(cwd, creation_key):
    if read_bound_project_id(cwd) is None:
        return "marker_missing"
    root = bootstrap_state_root()
    path = bootstrap_state_path(root, cwd)
    with bootstrap_lock(root, cwd):
        state = read_bootstrap_state(path)
        if state is None:
            return "already_completed"
        if not secrets.compare_digest(state["creation_key"], creation_key):
            return "key_mismatch"
        path.unlink()
        return "completed"


def main():
    try:
        event = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError):
        emit("GBrain 项目 ID 启动检查失败：Hook 输入不是有效 JSON；会话继续。", True)
        return

    cwd = event.get("cwd") if isinstance(event, dict) else None
    if not isinstance(cwd, str) or not cwd or "\x00" in cwd or not os.path.isabs(cwd):
        emit("GBrain 项目 ID 启动检查失败：缺少合法的绝对 cwd；会话继续。", True)
        return

    marker_path = os.path.join(cwd, MARKER_NAME)
    try:
        metadata = os.lstat(marker_path)
    except FileNotFoundError:
        reference_project_id = read_reference_project_id(cwd)
        if reference_project_id is not None:
            emit(
                "GBrain 项目 ID 启动检查：当前目录存在仓库项目身份记录 "
                + reference_project_id
                + "；GBRAIN_PROJECT_BOOTSTRAP_REQUIRED：必须立即派发独立子 Agent，并在其 prompt 中加入 "
                "GBRAIN_PROJECT_BOOTSTRAP_WORKER；子 Agent 通过 MCP 精确校验或 ensure_project 复用该 ID，"
                "再执行 bind --resolved 并读取登记页验证。带有 worker 标记的子 Agent 不得继续派生子 Agent。",
                False,
            )
            return
        try:
            creation_key = bootstrap_creation_key(cwd)
        except (OSError, RuntimeError, UnicodeError):
            emit(
                "GBrain 项目 ID 启动检查：当前目录未绑定，且无法安全建立 bootstrap 协调状态；"
                "未派发创建任务，会话继续。",
                True,
            )
            return
        complete_command = (
            "python3 " + shlex.quote(str(Path(__file__).resolve()))
            + " complete-bootstrap --cwd " + shlex.quote(cwd)
            + " --creation-key " + shlex.quote(creation_key)
        )
        emit(
            "GBrain 项目 ID 启动检查：当前目录未找到 .gbrain-project.yaml；"
            "未向父目录或其他目录查找。GBRAIN_PROJECT_BOOTSTRAP_REQUIRED："
            "必须立即派发独立子 Agent，并在其 prompt 中加入 GBRAIN_PROJECT_BOOTSTRAP_WORKER；"
            "子 Agent 必须使用以下协调键调用 ensure_project，禁止自行生成新键："
            "GBRAIN_PROJECT_BOOTSTRAP_CREATION_KEY=" + creation_key + "；"
            "随后 bind --resolved 写入本地标记并读取登记页验证，成功后执行协调状态清理命令："
            + complete_command + "。"
            "带有 GBRAIN_PROJECT_BOOTSTRAP_WORKER 的子 Agent 直接执行 bootstrap，不得继续派生子 Agent。",
            True,
        )
        return
    except OSError:
        emit("GBrain 项目 ID 启动检查失败：当前目录标记不可访问；会话继续。", True)
        return

    if not marker_is_trusted(metadata):
        emit(
            "GBrain 项目 ID 启动检查：当前目录标记不可信"
            "（必须是可信所有者持有、非符号链接且不可被所有人写入的普通文件）；会话继续。",
            True,
        )
        return
    if metadata.st_size > MAX_MARKER_BYTES:
        emit("GBrain 项目 ID 启动检查：当前目录标记格式无效；会话继续。", True)
        return

    descriptor = None
    try:
        open_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(marker_path, open_flags)
        opened_metadata = os.fstat(descriptor)
        if (
            not marker_is_trusted(opened_metadata)
            or opened_metadata.st_dev != metadata.st_dev
            or opened_metadata.st_ino != metadata.st_ino
        ):
            emit("GBrain 项目 ID 启动检查：当前目录标记在读取时发生变化或变得不可信；会话继续。", True)
            return
        with os.fdopen(descriptor, "r", encoding="utf-8") as marker_file:
            descriptor = None
            project_id = parse_project_id(marker_file.read(MAX_MARKER_BYTES + 1))
    except (OSError, UnicodeError):
        emit("GBrain 项目 ID 启动检查失败：当前目录标记不可读；会话继续。", True)
        return
    finally:
        if descriptor is not None:
            os.close(descriptor)

    if project_id is None:
        emit("GBrain 项目 ID 启动检查：当前目录标记格式无效；会话继续。", True)
        return

    emit(
        "GBrain 项目 ID 启动检查：当前目录已绑定 "
        + project_id
        + "；本次未检查父目录、其他目录或服务端。",
        False,
    )


def complete_bootstrap_command():
    parser = argparse.ArgumentParser(prog="gbrain-project-check.py complete-bootstrap")
    parser.add_argument("complete-bootstrap", nargs="?")
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--creation-key", required=True)
    args = parser.parse_args()
    if not os.path.isabs(args.cwd) or "\x00" in args.cwd or CREATION_KEY_RE.fullmatch(args.creation_key) is None:
        json.dump({"ok": False, "error": "invalid_bootstrap_completion"}, sys.stdout)
        sys.stdout.write("\n")
        return 1
    status_value = complete_bootstrap(args.cwd, args.creation_key)
    completed = status_value in {"completed", "already_completed"}
    json.dump({"ok": completed, "status": status_value}, sys.stdout)
    sys.stdout.write("\n")
    return 0 if completed else 1


if __name__ == "__main__":
    if len(sys.argv) > 1:
        raise SystemExit(complete_bootstrap_command())
    main()
`;
