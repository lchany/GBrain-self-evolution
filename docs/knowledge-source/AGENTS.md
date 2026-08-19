# AGENTS.md: Writer Rules for This Knowledge Source

You are writing into the canonical GBrain knowledge source. Follow these
rules exactly. The full taxonomy is in [README.md](README.md) and the
frontmatter contract is in [SCHEMA.md](SCHEMA.md).

## 核心规则

- 第一版没有 lifecycle hook。所有沉淀由 AGENTS 规则、显式命令或 skill 触发。
- 所有新沉淀必须先进入 `inbox/`，使用 `status: draft` 和
  `verification: unverified`。`inbox/` 里的内容都不是已确认知识。
- agent 可以预先设置 `type`，例如 `type: incident`，但这只是建议，不是最终分类。人工审核决定真正的目标路径和类型。
- 禁止自动升级。agent 不能未经人工审核就把 `inbox/` 草稿升级到 `knowledge/` 或通用 `runbooks/`。
- 升级到通用经验必须输入人工确认短语：
  `PROMOTE <target-slug>`。
- 禁止保存 raw transcript：不允许保存完整聊天记录、完整工具输出、原始 JSON、认证响应或密集日志。只保留提炼后的结论，并把证据路径写到 `source_refs`。
- 写入前必须查询 GBrain（search-before-create），避免重复主题。
- 出错后、尝试新方案前，必须先查询相关 `incidents/` 和错题集。

## Writing workflow

1. **Search first.** Query GBrain for the topic by slug and keywords.
   Never create a page for a topic that already has one; update the
   existing page instead.
2. **Classify.** Pick exactly one page type and the matching topic path:
   `knowledge/`, `projects/`, `incidents/`, `runbooks/`, `decisions/`,
   `environments/`, `agent-skills/`, or `legacy-migration/`. Unreviewed
   material goes to `inbox/` with `status: draft`. The `type` you set
   on an `inbox/` draft is only a suggestion; the reviewer decides the
   real target path.

   Use the capture templates in `templates/`:
   - `templates/success-case.md` for success cases.
   - `templates/wrong-answer.md` for wrong-answer / 错题集 entries.
3. **Write a normalized page.** Use the frontmatter contract from
   SCHEMA.md verbatim: `type`, `date`, `status`, `sensitivity`,
   `verification`, `applicability`, `non_applicable`, `source_refs`,
   `migrated_from`. No extra speculative fields.
4. **Cite.** `source_refs` must point at real evidence (log path, doc
   URL, commit, session id). A page without evidence is a draft at best.
5. **Mark verification honestly.** `verification: verified` only after
   the claim was tested against its real surface. Root-cause hypotheses
   stay `unverified`.

## Never write

- Passwords, tokens, API keys, private keys, raw auth files.
- Real personal names, employee IDs, personal account names.
- Non-loopback IP addresses. Use placeholders like `<SERVER_IP>`.
- Raw session logs or dense command output. Distill; cite the path.
- Raw transcripts. Never store full chat logs, full tool output, raw
  JSON, authentication responses, or dense logs.
- Automatic promotions. Never move a draft out of `inbox/` without
  explicit human review.

## Slug discipline

- Lowercase alphanumeric plus hyphens only. No underscores, no
  uppercase, no `.md` in the slug field.
- The slug is the repo-relative path without extension, for example
  `runbooks/examples/example-runbook`.

## Query policy

- 默认查询排除 `inbox/`。普通检索只覆盖 `knowledge/`、`runbooks/`、
  `incidents/`、`decisions/`、`projects/`、`environments/` 和
  `agent-skills/`。
- 显式 review 或 draft 模式可以包含 `inbox/`。
- 避免把未审核草稿当作已确认知识使用。

## Legacy content

Pages migrated from the old Experience Vault / agent-evolutionism flow
live under `legacy-migration/` with `status: migrated-legacy` and a
non-null `migrated_from`. Never promote them to verified knowledge
without fresh tested evidence.
