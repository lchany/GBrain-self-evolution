#!/usr/bin/env bash
set -euo pipefail

APPLY=0
PREFIX=/opt/gbrain
REPOSITORY=https://github.com/lchany/GBrain-self-evolution.git
BRANCH=gbrain-review-ui
BINARY=/usr/local/bin/gbrain
BUN="$(command -v bun || true)"
if [[ -z "${BUN}" ]]; then
  for candidate in /root/.bun/bin/bun /usr/local/bin/bun; do
    if [[ -x "${candidate}" ]]; then
      BUN="${candidate}"
      break
    fi
  done
fi
usage() {
  cat <<'USAGE'
Usage: bootstrap-server.sh [--apply] [--prefix PATH]

The script must be run from a clean checkout of the pinned repository and
branch. Default is dry-run. --apply builds the admin assets and CLI binary,
installs the binary and checked-in HTTP service/env templates, and removes the
known stale HTTP drop-in. It never creates secrets. The cloud firewall and TLS
proxy remain operator-managed prerequisites.
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
[[ -n "${BUN}" ]] || {
  printf 'bun executable not found; set PATH or install Bun\n' >&2
  exit 1
}
[[ -d "${ROOT}/.git" ]] || {
  printf 'source checkout is required: %s\n' "${ROOT}" >&2
  exit 1
}
REMOTE_URL="$(git -C "${ROOT}" remote get-url origin 2>/dev/null || true)"
case "${REMOTE_URL}" in
  "${REPOSITORY}"|git@github.com:lchany/GBrain-self-evolution.git) ;;
  *)
    printf 'wrong source repository: %s\nexpected: %s\n' "${REMOTE_URL}" "${REPOSITORY}" >&2
    exit 1
    ;;
esac
CURRENT_BRANCH="$(git -C "${ROOT}" branch --show-current)"
[[ "${CURRENT_BRANCH}" == "${BRANCH}" ]] || {
  printf 'wrong source branch: %s\nexpected: %s\n' "${CURRENT_BRANCH}" "${BRANCH}" >&2
  exit 1
}
[[ -z "$(git -C "${ROOT}" status --porcelain)" ]] || {
  printf 'source checkout is dirty: %s\n' "${ROOT}" >&2
  exit 1
}
if [[ "${APPLY}" == 0 ]]; then
  printf 'DRY-RUN: source=%s branch=%s\n' "${REPOSITORY}" "${BRANCH}"
  printf 'DRY-RUN: bun install --frozen-lockfile; bun run build:admin-embedded; bun run build\n'
  printf 'DRY-RUN: install %s/bin/gbrain %s\n' "${ROOT}" "${BINARY}"
  printf 'DRY-RUN: mkdir -p %s /opt/gbrain-knowledge/source /etc/gbrain\n' "${PREFIX}"
  printf 'DRY-RUN: install service and env templates; remove stale 20-http-basic.conf; systemctl daemon-reload\n'
  exit 0
fi

cd "${ROOT}"
"${BUN}" install --frozen-lockfile
"${BUN}" run build:admin-embedded
"${BUN}" run build
install -m 0755 "${ROOT}/bin/gbrain" "${BINARY}"
install -d -m 0755 "${PREFIX}" /opt/gbrain-knowledge/source /etc/gbrain
if ! getent group gbrain >/dev/null; then
  groupadd --system gbrain
fi
if ! getent passwd gbrain >/dev/null; then
  useradd --system --gid gbrain --home-dir /var/lib/gbrain --shell /usr/sbin/nologin gbrain
fi
install -d -o gbrain -g gbrain -m 0700 /var/lib/gbrain /var/lib/gbrain/.gbrain /run/gbrain
if [[ -f /var/lib/gbrain/config.json && ! -e /var/lib/gbrain/.gbrain/config.json ]]; then
  find /var/lib/gbrain -mindepth 1 -maxdepth 1 ! -name .gbrain -exec mv -t /var/lib/gbrain/.gbrain -- {} +
fi
if [[ -d /root/.gbrain && ! -e /var/lib/gbrain/.gbrain/config.json ]]; then
  cp -a /root/.gbrain/. /var/lib/gbrain/.gbrain/
fi
chown -R gbrain:gbrain /var/lib/gbrain /opt/gbrain-knowledge /run/gbrain
install -m 0644 "${ROOT}/deploy/systemd/gbrain-serve-http.service.example" /etc/systemd/system/gbrain-serve-http.service
if [[ ! -e /etc/gbrain/gbrain-serve.env ]]; then
  install -m 0600 "${ROOT}/deploy/env/gbrain-serve.env.example" /etc/gbrain/gbrain-serve.env
else
  printf 'Preserving existing /etc/gbrain/gbrain-serve.env\n'
fi
if ! grep -q '^GBRAIN_HOME=' /etc/gbrain/gbrain-serve.env; then
  printf '\nGBRAIN_HOME=/var/lib/gbrain\n' >> /etc/gbrain/gbrain-serve.env
fi
if ! grep -q '^GBRAIN_HTTP_PORT=' /etc/gbrain/gbrain-serve.env; then
  printf 'GBRAIN_HTTP_PORT=3131\n' >> /etc/gbrain/gbrain-serve.env
fi
if ! grep -q '^GBRAIN_HTTP_BIND=' /etc/gbrain/gbrain-serve.env; then
  printf 'GBRAIN_HTTP_BIND=0.0.0.0\n' >> /etc/gbrain/gbrain-serve.env
fi
if ! grep -q '^GBRAIN_PUBLIC_URL=' /etc/gbrain/gbrain-serve.env; then
  admin_origin="$(awk -F= '$1 == "GBRAIN_ADMIN_ORIGIN" { print substr($0, index($0, "=") + 1) }' /etc/gbrain/gbrain-serve.env)"
  [[ -n "${admin_origin}" ]] || {
    printf 'GBRAIN_PUBLIC_URL is required when GBRAIN_ADMIN_ORIGIN is unset\n' >&2
    exit 1
  }
  printf 'GBRAIN_PUBLIC_URL=%s\n' "${admin_origin}" >> /etc/gbrain/gbrain-serve.env
fi
rm -f /etc/systemd/system/gbrain-serve-http.service.d/20-http-basic.conf
systemctl daemon-reload
printf 'Installed %s from %s@%s. Fill placeholders in /etc/gbrain/gbrain-serve.env, then verify the TLS proxy and cloud firewall before starting.\n' "${BINARY}" "${REPOSITORY}" "${BRANCH}"
