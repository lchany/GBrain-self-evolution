#!/usr/bin/env bash
set -euo pipefail

args=(
  /usr/local/bin/gbrain serve --http
  --port "${GBRAIN_HTTP_PORT:-3131}"
  --bind "${GBRAIN_HTTP_BIND:-127.0.0.1}"
  --allow-anonymous-mcp
  --suppress-bootstrap-token
)

if [[ "${GBRAIN_PUBLIC_URL:-}" == https://* ]]; then
  args+=(--public-url "${GBRAIN_PUBLIC_URL}")
elif [[ -n "${GBRAIN_PUBLIC_URL:-}" ]]; then
  printf 'Ignoring non-HTTPS GBRAIN_PUBLIC_URL; configure TLS before enabling OAuth public discovery.\n' >&2
fi

exec "${args[@]}"
