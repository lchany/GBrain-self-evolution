#!/usr/bin/env bash
set -euo pipefail

APPLY=0
PREFIX=/opt/gbrain
usage() {
  cat <<'USAGE'
Usage: bootstrap-server.sh [--apply] [--prefix PATH]

Default is dry-run. --apply creates the documented runtime directories and
installs the checked-in HTTP service/env templates; it never creates secrets.
The cloud firewall and TLS proxy remain operator-managed prerequisites.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --prefix) PREFIX="${2:?missing --prefix value}"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
if [[ "${APPLY}" == 0 ]]; then
  printf 'DRY-RUN: mkdir -p %s /opt/gbrain-knowledge/source /etc/gbrain\n' "${PREFIX}"
  printf 'DRY-RUN: install service and env templates; chmod env 0600; systemctl daemon-reload\n'
  exit 0
fi

install -d -m 0755 "${PREFIX}" /opt/gbrain-knowledge/source /etc/gbrain
install -m 0644 "${ROOT}/deploy/systemd/gbrain-serve-http.service.example" /etc/systemd/system/gbrain-serve-http.service
install -m 0600 "${ROOT}/deploy/env/gbrain-serve.env.example" /etc/gbrain/gbrain-serve.env
systemctl daemon-reload
printf 'Installed templates. Fill placeholders in /etc/gbrain/gbrain-serve.env, then verify the TLS proxy and cloud firewall before starting.\n'
