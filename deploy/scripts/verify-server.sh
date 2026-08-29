#!/usr/bin/env bash
set -euo pipefail

URL=http://127.0.0.1:3131
usage() {
  cat <<'USAGE'
Usage: verify-server.sh [--url URL]

Read-only checks for the HTTP service. It does not print credentials and does
not write files. A healthy MCP listener returns 405 for GET /mcp, /health
returns 200, and the anonymous MCP initialize request returns 200.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="${2:?missing --url value}"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

health="$(curl -fsS -o /dev/null -w '%{http_code}' "${URL}/health")"
[[ "${health}" == 200 ]] || { printf 'health failed: HTTP %s\n' "${health}" >&2; exit 1; }
mcp="$(curl -sS -o /dev/null -w '%{http_code}' "${URL}/mcp")"
[[ "${mcp}" == 405 ]] || { printf 'MCP readiness failed: HTTP %s\n' "${mcp}" >&2; exit 1; }
initialize_body='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"gbrain-verify","version":"1"}}}'
anonymous_mcp="$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST "${URL}/mcp" \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  --data "${initialize_body}")"
case "${anonymous_mcp}" in
  200|202) ;;
  401) printf 'anonymous MCP failed: HTTP 401 (Missing Authorization)\n' >&2; exit 1 ;;
  *) printf 'anonymous MCP failed: HTTP %s\n' "${anonymous_mcp}" >&2; exit 1 ;;
esac
printf 'OK: health=200 mcp_get=405 anonymous_mcp=%s\n' "${anonymous_mcp}"
