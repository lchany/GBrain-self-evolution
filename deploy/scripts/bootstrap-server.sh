#!/usr/bin/env bash
set -euo pipefail

APPLY=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ARCHIVE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
SYSTEMD_SRC="${ARCHIVE_ROOT}/deploy/systemd"
ENV_SRC="${ARCHIVE_ROOT}/deploy/env"

usage() {
  cat <<'USAGE'
用法：bootstrap-server.sh [--apply] [--help]

默认 dry-run：只打印将执行的服务器安装步骤，不写 /etc、不安装 unit、不执行 systemctl。
传入 --apply 后才会执行写入和 systemctl 动作。

步骤顺序：
  1. 预检 bun/git/systemctl 是否存在，并检查 /opt/gbrain 是否存在。
  2. 创建 /etc/gbrain 等目录。
  3. 安装示例 env 到 /etc/gbrain/*.env，权限 0600；已存在则跳过，避免覆盖真实配置。
  4. 安装 systemd 模板到 /etc/systemd/system/，去掉 .example 后缀；已存在则跳过。
  5. systemctl daemon-reload。
  6. enable --now HTTP/WebUI 服务与 sync/doctor timer。

安全约束：脚本不读取、不打印真实 env 内容；所有写入和 systemctl 动作都在 --apply 分支内。
USAGE
}

redact_word() {
  local word="$1"
  case "${word}" in
    *TOKEN*|*SECRET*|*PASSWORD*|*KEY*|*DATABASE_URL*) printf '<redacted>' ;;
    *) printf '%s' "${word}" ;;
  esac
}

log() {
  local first=1 word
  for word in "$@"; do
    if [[ "${first}" == "0" ]]; then
      printf ' '
    fi
    redact_word "${word}"
    first=0
  done
  printf '\n'
}

fail() {
  log "ERROR:" "$@" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "未知参数：$1" ;;
  esac
  shift
done

require_cmd() {
  local cmd="$1"
  if command -v "${cmd}" >/dev/null 2>&1; then
    log "PASS preflight command" "${cmd}"
    return 0
  fi
  if [[ "${APPLY}" == "1" ]]; then
    fail "缺少必要命令" "${cmd}"
  fi
  log "WARN dry-run missing command" "${cmd}"
}

require_path() {
  local path="$1"
  if [[ -e "${path}" ]]; then
    log "PASS preflight path" "${path}"
    return 0
  fi
  if [[ "${APPLY}" == "1" ]]; then
    fail "缺少必要路径" "${path}"
  fi
  log "WARN dry-run missing path" "${path}"
}

run_apply_command() {
  local description="$1"
  local command_text="$2"
  if [[ "${APPLY}" == "1" ]]; then
    log "APPLY" "${description}"
    bash -c "${command_text}"
  else
    log "DRY-RUN" "${description}" "=>" "${command_text}"
  fi
}

install_if_missing() {
  local src="$1"
  local dest="$2"
  local mode="$3"
  local owner="$4"
  local group="$5"

  [[ -f "${src}" ]] || fail "源文件不存在" "${src}"
  if [[ "${APPLY}" == "1" ]]; then
    if [[ -e "${dest}" ]]; then
      log "SKIP existing" "${dest}"
      return 0
    fi
    log "APPLY install" "${src}" "->" "${dest}"
    install -D -m "${mode}" -o "${owner}" -g "${group}" "${src}" "${dest}"
  else
    log "DRY-RUN install -D -m" "${mode}" "-o" "${owner}" "-g" "${group}" "${src}" "${dest}"
  fi
}

main() {
  if [[ "${APPLY}" == "1" ]]; then
    log "模式：APPLY，会执行写入和 systemctl 动作。"
  else
    log "模式：DRY-RUN，不会写入文件或调用 systemctl。"
  fi

  require_cmd bun
  require_cmd git
  require_cmd systemctl
  require_path /opt/gbrain

  run_apply_command "创建 /etc/gbrain" "install -d -m 0750 -o root -g root /etc/gbrain"
  run_apply_command "创建 /etc/gbrain/clients" "install -d -m 0750 -o root -g root /etc/gbrain/clients"

  install_if_missing "${ENV_SRC}/gbrain-serve.env.example" "/etc/gbrain/gbrain-serve.env" "0600" "root" "root"
  install_if_missing "${ENV_SRC}/webui.env.example" "/etc/gbrain/webui.env" "0600" "root" "root"
  install_if_missing "${ENV_SRC}/gbrain-maintenance.env.example" "/etc/gbrain/gbrain-maintenance.env" "0600" "root" "root"

  install_if_missing "${SYSTEMD_SRC}/gbrain-serve-http.service.example" "/etc/systemd/system/gbrain-serve-http.service" "0644" "root" "root"
  install_if_missing "${SYSTEMD_SRC}/gbrain-webui.service.example" "/etc/systemd/system/gbrain-webui.service" "0644" "root" "root"
  install_if_missing "${SYSTEMD_SRC}/gbrain-sync.service.example" "/etc/systemd/system/gbrain-sync.service" "0644" "root" "root"
  install_if_missing "${SYSTEMD_SRC}/gbrain-sync.timer.example" "/etc/systemd/system/gbrain-sync.timer" "0644" "root" "root"
  install_if_missing "${SYSTEMD_SRC}/gbrain-doctor.service.example" "/etc/systemd/system/gbrain-doctor.service" "0644" "root" "root"
  install_if_missing "${SYSTEMD_SRC}/gbrain-doctor.timer.example" "/etc/systemd/system/gbrain-doctor.timer" "0644" "root" "root"

  run_apply_command "重载 systemd" "systemctl daemon-reload"
  run_apply_command "启用运行服务和 timer" "systemctl enable --now gbrain-serve-http.service gbrain-webui.service gbrain-sync.timer gbrain-doctor.timer"
}

main
