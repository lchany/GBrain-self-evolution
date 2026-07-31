export const GBRAIN_CODEX_PROJECT_HOOK_STATUS = '检查当前目录的 GBrain 项目 ID';
export const GBRAIN_CODEX_PROJECT_HOOK_FILENAME = 'gbrain-project-check.py';

export const GBRAIN_CODEX_PROJECT_HOOK = String.raw`#!/usr/bin/env python3
import json
import os
import re
import stat
import sys

MARKER_NAME = ".gbrain-project.yaml"
PROJECT_ID_RE = re.compile(r"^prj-[0-9a-f]{16}$")
MAX_MARKER_BYTES = 4096


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


def parse_project_id(content):
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    if len(lines) != 2 or lines[0] != "schema_version: 1":
        return None
    match = re.fullmatch(r"project_id:\s*(\S+)\s*", lines[1])
    if match is None or PROJECT_ID_RE.fullmatch(match.group(1)) is None:
        return None
    return match.group(1)


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
        emit(
            "GBrain 项目 ID 启动检查：当前目录未找到 .gbrain-project.yaml；"
            "未向父目录或其他目录查找。",
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


if __name__ == "__main__":
    main()
`;
