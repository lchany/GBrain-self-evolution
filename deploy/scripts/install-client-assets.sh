#!/usr/bin/env bash
set -euo pipefail

APPLY=0
TARGET_HOME="${HOME:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ARCHIVE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
RULES_SRC="${ARCHIVE_ROOT}/rules"
SKILLS_SRC="${ARCHIVE_ROOT}/skills"
SKILLS=(gbrain-capture gbrain-review gbrain-knowledge-writer)

usage() {
  cat <<'USAGE'
用法：install-client-assets.sh [--home TARGET_HOME] [--apply] [--help]

默认 dry-run：只打印将写入 OpenCode/Codex 配置目录的规则片段和技能，不创建文件。
传入 --apply 后才会写入，且只允许写在 TARGET_HOME 之下，永不触碰 /etc 或 /opt。

安装内容：
  - rules/*.md -> TARGET_HOME/.config/opencode/rules/gbrain/ 和 TARGET_HOME/.codex/rules/gbrain/
  - skills/gbrain-capture、skills/gbrain-review、skills/gbrain-knowledge-writer
    -> TARGET_HOME/.config/opencode/skills/ 和 TARGET_HOME/.codex/skills/

说明：`gbrain install-client` 的生产安装器会自动安装 capture/review 和规则块；本归档 helper
额外安装 gbrain-knowledge-writer，便于离线审查部署资产。脚本不会安装 lifecycle hook。
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
    --home) TARGET_HOME="${2:?缺少 --home 值}"; shift ;;
    --apply) APPLY=1 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "未知参数：$1" ;;
  esac
  shift
done

[[ -n "${TARGET_HOME}" ]] || fail "HOME 不存在，请用 --home 指定目标用户目录"
[[ -d "${TARGET_HOME}" ]] || fail "目标 HOME 不存在" "${TARGET_HOME}"
TARGET_HOME="$(cd "${TARGET_HOME}" && pwd -P)"
case "${TARGET_HOME}" in
  /etc|/etc/*|/opt|/opt/*) fail "目标 HOME 不能位于 /etc 或 /opt" "${TARGET_HOME}" ;;
esac

ensure_under_home() {
  local path="$1"
  case "${path}" in
    "${TARGET_HOME}"/*) return 0 ;;
    *) fail "拒绝写入目标 HOME 之外" "${path}" ;;
  esac
}

copy_file() {
  local src="$1"
  local dest="$2"
  [[ -f "${src}" ]] || fail "源文件不存在" "${src}"
  ensure_under_home "${dest}"
  if [[ "${APPLY}" == "1" ]]; then
    log "APPLY copy" "${src}" "->" "${dest}"
    mkdir -p "$(dirname "${dest}")"
    cp "${src}" "${dest}"
  else
    log "DRY-RUN copy" "${src}" "->" "${dest}"
  fi
}

copy_dir() {
  local src="$1"
  local dest="$2"
  [[ -d "${src}" ]] || fail "源目录不存在" "${src}"
  ensure_under_home "${dest}"
  if [[ "${APPLY}" == "1" ]]; then
    log "APPLY copy-dir" "${src}" "->" "${dest}"
    mkdir -p "${dest}"
    cp -R "${src}/." "${dest}/"
  else
    log "DRY-RUN copy-dir" "${src}" "->" "${dest}"
  fi
}

main() {
  local opencode_dir="${TARGET_HOME}/.config/opencode"
  local codex_dir="${TARGET_HOME}/.codex"
  local rule rule_name skill

  if [[ "${APPLY}" == "1" ]]; then
    log "模式：APPLY，只写入目标 HOME 下的 OpenCode/Codex 配置目录。"
  else
    log "模式：DRY-RUN，不会创建或修改文件。"
  fi

  shopt -s nullglob
  local rules=("${RULES_SRC}"/*.md)
  shopt -u nullglob
  [[ "${#rules[@]}" -gt 0 ]] || fail "未找到规则片段" "${RULES_SRC}"

  for rule in "${rules[@]}"; do
    rule_name="$(basename "${rule}")"
    copy_file "${rule}" "${opencode_dir}/rules/gbrain/${rule_name}"
    copy_file "${rule}" "${codex_dir}/rules/gbrain/${rule_name}"
  done

  for skill in "${SKILLS[@]}"; do
    copy_dir "${SKILLS_SRC}/${skill}" "${opencode_dir}/skills/${skill}"
    copy_dir "${SKILLS_SRC}/${skill}" "${codex_dir}/skills/${skill}"
  done
}

main
