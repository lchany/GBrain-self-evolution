#!/usr/bin/env bash
set -euo pipefail

APPLY=0
TARGET_HOME="${HOME:-}"
usage() {
  cat <<'USAGE'
Usage: install-client-assets.sh [--home PATH] [--apply] [--help]

Default is dry-run. --apply installs only GBrain rules and skills through
gbrain install-client. It does not create, copy, read, or probe credentials.
Network access is controlled by the cloud firewall allowlist.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --home) TARGET_HOME="${2:?missing --home value}"; shift ;;
    --apply) APPLY=1 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

[[ -n "${TARGET_HOME}" ]] || { printf 'HOME is required\n' >&2; exit 2; }
[[ -d "${TARGET_HOME}" ]] || { printf 'HOME does not exist: %s\n' "${TARGET_HOME}" >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
if [[ "${APPLY}" == 0 ]]; then
  printf 'DRY-RUN: install GBrain rules and skills under %s\n' "${TARGET_HOME}"
  exit 0
fi
HOME="${TARGET_HOME}" XDG_CONFIG_HOME="${TARGET_HOME}/.config" CODEX_HOME="${TARGET_HOME}/.codex" \
  bun "${ROOT}/src/cli.ts" install-client --json
