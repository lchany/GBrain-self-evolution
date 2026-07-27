---
name: gbrain-review
description: "Review GBrain inbox drafts with human gates. Use when promoting, keeping, merging, rejecting, verifying, repairing, or cleaning up inbox drafts; promotion to knowledge or general runbooks requires explicit human review and exact `PROMOTE <target-slug>` confirmation."
---

# gbrain-review

审核 GBrain `inbox/` 草稿并决定去向。它是人工审核门，不是自动升级器。

## 何时使用

- 用户要求审核、整理、升级、拒绝、合并 GBrain 草稿。
- `gbrain-capture` 写入了 `inbox/`，需要决定是否保留为项目事实、决策、incident、runbook、environment，或升级为通用经验。
- 项目里程碑、项目关闭、root cause 修复完成后，需要把候选经验放入人工审核流程。
- 需要验证某个 target slug 是否已经可检索。
- 部分失败后需要 `repair` 或 `cleanup`。

## 核心原则

- 默认从 `inbox/` 开始：未审核草稿不能当作已确认知识使用。
- `list`、`show`、`plan`、`verify` 是只读操作。
- `reject`、`needs-evidence`、`keep`、`promote`、`merge`、`repair`、`cleanup` 是写操作。
- `promote` 到 `knowledge/` 或通用 `runbooks/` 必须逐条人工确认。
- 确认短语必须精确为 `PROMOTE <target-slug>`；不能用回车、模糊同意或 agent 自行确认代替。
- 审核必须展示 source slug、target slug、目标 type、verification、适用/不适用条件、门禁结果和风险。
- 不得绕过 search-before-create；发现重复主题时使用 `merge` 或更新已有页。
- 若 target 写入后检索验证失败，不得删除原 `inbox/`。
- 若审核记录写入失败，不得删除原 `inbox/`；按提示使用 `repair`。

## CLI 命令面

```bash
gbrain review list [--limit 50] [--type incident] [--status draft] [--verification unverified]
gbrain review show inbox/<slug>
gbrain review plan inbox/<slug> --action <keep|promote|merge|reject|needs-evidence|repair|cleanup> --target <target-slug> --type <target-type>
gbrain review verify <target-slug>
gbrain review reject inbox/<slug> --reason "<原因>"
gbrain review needs-evidence inbox/<slug> --reason "<缺少什么证据>"
gbrain review keep inbox/<slug> --target <projects|decisions|incidents|runbooks|environments>/<slug> --type <project|decision|incident|runbook|environment>
gbrain review promote inbox/<slug> --target <knowledge|runbooks>/<slug> --type <knowledge|runbook> --confirm "PROMOTE <target-slug>"
gbrain review merge inbox/<slug> --target <existing-slug> --type <target-type> --confirm "MERGE <existing-slug>"
gbrain review repair inbox/<slug>
gbrain review cleanup inbox/<slug>
```

独立 bin 也可用：

```bash
gbrain-review <list|show|plan|reject|needs-evidence|keep|promote|merge|verify|repair|cleanup>
```

## 审核流程

1. `gbrain review list` 找到待审核草稿。
2. `gbrain review show inbox/<slug>` 查看建议类型、验证状态和风险。
3. `gbrain review plan ...` 先生成计划；检查 evidence、重复页、secret/raw transcript、目标路径和 verification 门禁。
4. 对项目内事实或决策，用 `keep` 进入 `projects/`、`decisions/`、`incidents/`、`runbooks/` 或 `environments/`。
5. 对跨项目通用经验，用 `promote`，并要求人类输入 `PROMOTE <target-slug>`。
6. 对重复主题，用 `merge` 合入已有页面。
7. 对证据不足，用 `needs-evidence`；不要删除草稿。
8. 对无价值或违规内容，用 `reject --reason`。
9. 写入后确认输出包含 target slug、review slug、receipts，并用 `verify` 或输出里的 retrieval result 确认可检索。

## 人工门禁

promote 前必须向用户展示：

- `source_slug: inbox/...`
- `target_slug: knowledge/...` 或 `runbooks/...`
- `target_type`
- `verification`
- `applicability` / `non_applicable`
- 重复页检查结果
- secret/raw transcript 检查结果
- 将进入通用经验的风险说明

只有用户明确提供 `PROMOTE <target-slug>` 后，才允许执行 promote。agent 不得自动补这个确认短语。

## 禁止事项

- 不自动 promote。
- 不把 `inbox/` 草稿当成默认查询结果。
- 不保存 raw transcript、raw tool output、密集日志或认证响应。
- 不写真实 GBrain URL、IP、token 或 secret；只使用 `<server>` 这类占位符。
- 不在检索验证失败、审核记录失败或重复目标未处理时删除 `inbox/`。
