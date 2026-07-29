#!/usr/bin/env bash
set -euo pipefail

URL=http://127.0.0.1:3131
usage() {
  cat <<'USAGE'
Usage: verify-server.sh [--url URL]

Read-only checks for the HTTP service. It does not print credentials and does
not write files. A healthy MCP listener returns 405 for GET /mcp and /health
returns 200.
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
[[ "${mcp}" == 405 ]] || { printf 'MCP readiness failed: HTTP %s\n' "${mcp}" >&2; exit 1; }
