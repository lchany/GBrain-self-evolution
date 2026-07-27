#!/usr/bin/env bash
set -euo pipefail

HOST="127.0.0.1"
HTTP_PORT="3131"
WEBUI_PORT="3132"
TOTAL=0
FAILED=0

usage() {
  cat <<'USAGE'
用法：verify-server.sh [--host HOST] [--http-port PORT] [--webui-port PORT] [--apply] [--help]

执行只读服务器检查，不需要任何凭据，也不会写文件或调用启停动作。
--apply 为兼容统一脚本界面保留，但本脚本没有写入动作，传入后仍只读。

检查项：
  - systemctl is-active：gbrain-serve-http.service、gbrain-webui.service、gbrain-sync.timer、gbrain-doctor.timer
  - TCP 连接：HTTP 3131、Web UI 3132
  - GET /mcp 期望 405，作为 MCP endpoint 活着但方法不匹配的健康信号
  - 未带认证的 MCP initialize POST 期望 401 或 400，作为服务存在且拒绝无凭据访问的健康信号
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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:?缺少 --host 值}"; shift ;;
    --http-port) HTTP_PORT="${2:?缺少 --http-port 值}"; shift ;;
    --webui-port) WEBUI_PORT="${2:?缺少 --webui-port 值}"; shift ;;
    --apply) log "INFO: verify-server 是只读脚本，--apply 不会改变行为。" ;;
    --help|-h) usage; exit 0 ;;
    *) log "ERROR: 未知参数：$1" >&2; exit 1 ;;
  esac
  shift
done

record() {
  local name="$1"
  local status="$2"
  local detail="$3"
  TOTAL=$((TOTAL + 1))
  if [[ "${status}" == "PASS" ]]; then
    log "PASS" "${name}" "-" "${detail}"
  else
    FAILED=$((FAILED + 1))
    log "FAIL" "${name}" "-" "${detail}"
  fi
}

check_unit_active() {
  local unit="$1"
  if ! command -v systemctl >/dev/null 2>&1; then
    record "unit ${unit}" "FAIL" "systemctl 不可用"
    return
  fi
  if systemctl is-active --quiet "${unit}"; then
    record "unit ${unit}" "PASS" "active"
  else
    record "unit ${unit}" "FAIL" "not active"
  fi
}

check_tcp() {
  local name="$1"
  local port="$2"
  if CHECK_HOST="${HOST}" CHECK_PORT="${port}" timeout 3 bash -c ': < /dev/tcp/${CHECK_HOST}/${CHECK_PORT}' >/dev/null 2>&1; then
    record "tcp ${name}" "PASS" "${HOST}:${port} 可连接"
  else
    record "tcp ${name}" "FAIL" "${HOST}:${port} 不可连接"
  fi
}

http_code() {
  local method="$1"
  local url="$2"
  shift 2
  curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -X "${method}" "$@" "${url}" 2>/dev/null || true
}

check_http_get_mcp() {
  if ! command -v curl >/dev/null 2>&1; then
    record "http GET /mcp" "FAIL" "curl 不可用"
    return
  fi
  local code
  code="$(http_code GET "http://${HOST}:${HTTP_PORT}/mcp")"
  if [[ "${code}" == "405" ]]; then
    record "http GET /mcp" "PASS" "HTTP ${code}"
  else
    record "http GET /mcp" "FAIL" "期望 405，实际 ${code:-no-response}"
  fi
}

check_mcp_initialize_no_auth() {
  if ! command -v curl >/dev/null 2>&1; then
    record "mcp initialize no auth" "FAIL" "curl 不可用"
    return
  fi
  local code
  code="$(http_code POST "http://${HOST}:${HTTP_PORT}/mcp" -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')"
  if [[ "${code}" == "401" || "${code}" == "400" ]]; then
    record "mcp initialize no auth" "PASS" "HTTP ${code}"
  else
    record "mcp initialize no auth" "FAIL" "期望 401/400，实际 ${code:-no-response}"
  fi
}

main() {
  log "模式：READ-ONLY，不读取凭据，不写文件，不启停服务。"
  check_unit_active gbrain-serve-http.service
  check_unit_active gbrain-webui.service
  check_unit_active gbrain-sync.timer
  check_unit_active gbrain-doctor.timer
  check_tcp "gbrain-http" "${HTTP_PORT}"
  check_tcp "gbrain-webui" "${WEBUI_PORT}"
  check_http_get_mcp
  check_mcp_initialize_no_auth

  if [[ "${FAILED}" == "0" ]]; then
    log "SUMMARY: PASS" "${TOTAL}/${TOTAL}" "checks passed"
    exit 0
  fi
  log "SUMMARY: FAIL" "$((TOTAL - FAILED))/${TOTAL}" "checks passed"
  exit 1
}

main
