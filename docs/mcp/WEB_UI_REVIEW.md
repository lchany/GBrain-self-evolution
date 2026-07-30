# GBrain Web UI 审核流程

GBrain 在 `http://<server>:3132/admin/review` 提供一套只读浏览 + 写操作门控的 Web UI，用于人工审核 `inbox/` 草稿。

**核心安全原则**：浏览器永远看不到 writer token 或 client secret；所有写操作由服务端通过本地 `local-writer` 凭证执行。

---

## 1. 入口与页面

| URL | 用途 |
| --- | --- |
| `/admin/review` | inbox 草稿列表 |
| `/admin/review/detail/<slug>` | 单篇草稿详情、frontmatter、操作表单 |
| `/admin/review/plan/<slug>` | 生成审核计划，展示门禁结果 |
| `/admin/api/review/confirm` | 执行审核计划（POST） |
| `/admin/review/history` | 已写入的 `decisions/reviews/*` 记录 |

---

## 2. 权限模型

### 2.1 浏览权限

所有 Web UI 页面共享现有 admin dashboard 的 `requireAdmin` cookie 认证。未认证请求会重定向到登录流程。

### 2.2 写操作权限

浏览之外的写操作需要两个条件同时满足：

1. 当前请求通过 `requireAdmin` 认证。
2. 服务端 `local-writer.env` 可用，且服务端能成功换得 writer token。

如果 writer 凭证缺失，写操作会失败并返回 `503 service_unavailable` 或错误页面。

systemd 部署通过 `LoadCredential` 将 root-owned 的
`/etc/gbrain/clients/local-writer.env` 作为只读 credential 暴露给服务。
非 systemd 部署可用 `GBRAIN_REVIEW_WRITER_ENV_PATH` 指定文件。审核 writer
连接 `GBRAIN_REVIEW_WRITER_MCP_URL`（默认建议
`http://127.0.0.1:3131/mcp`），不得从公网 issuer 或浏览器 Host 隐式推导。

### 2.3 浏览器侧安全

- 页面不会嵌入 bearer token、client secret 或 MCP URL。
- 确认执行通过 form POST 到 `/admin/api/review/confirm`。
- 服务端完成 plan + apply 后返回结构化结果页面。

---

## 3. 列表页

访问 `/admin/review` 显示当前所有未软删除的 `inbox/` 草稿。

列表字段：
- Slug（链接到详情页）
- 类型（`type`）
- 验证状态（`verification`）
- 状态（`status`）
- 是否过期（14 天未更新标记为 stale）
- 标题

过滤：
- 页面支持通过 query string 过滤：`type`、`verification`、`status`、`stale`、`project_id`。
- 例如：`/admin/review?type=knowledge&verification=unverified`。

---

## 4. 详情页

`/admin/review/detail/<slug>` 展示：
- Slug、标题、类型
- 完整 frontmatter 表格
- `compiled_truth` 正文
- timeline
- source_refs 列表
- 风险检查提示
- 操作表单：选择 `reject`、`needs_evidence`、`keep`、`promote`、`merge`，输入目标 slug 和目标类型

表单提交到 `/admin/review/plan/<slug>`，先生成审核计划。

---

## 5. 审核计划页

`/admin/review/plan/<slug>?action=...&target=...&target_type=...` 调用共享的 `planReview` 核心：

1. 检查 `review_date`。
2. 检查 source slug 是否属于 `inbox/`。
3. 读取 source page。
4. 验证 frontmatter。
5. 验证 target slug 和 type。
6. 检查 unsafe content。
7. 检查 verification 门禁。
8. 检查重复目标。
9. 对 `merge` 检查目标页是否存在。

门禁结果以表格展示，每个门禁显示 `code`、`ok`、`message`。

### 5.1 确认执行

门禁全部通过后，页面显示确认表单。表单包含隐藏字段 `sourceSlug`、`action`、`target`、`target_type`。

- 对 `reject`、`needs-evidence`、`keep`、`repair`、`cleanup`：直接点击按钮执行。
- 对 `promote`：必须输入 `PROMOTE <target-slug>`。
- 对 `merge`：必须输入 `MERGE <target-slug>` 或目标 slug。

表单 POST 到 `/admin/api/review/confirm`，服务端会：
1. 重新解析 action。
2. 校验确认短语。
3. 再次 `planReview`。
4. 门禁通过后 `applyReviewPlan`。
5. 返回 `plan` 和 `apply` 的 JSON 结果。

---

## 6. 历史页

`/admin/review/history` 读取 `decisions/reviews/` 下的审核记录，展示：
- 审核 slug
- 审核动作（`review_action`）
- 来源 slug
- 标题
- 更新日期

---

## 7. API 端点

### 7.1 GET `/admin/api/review/inbox`

返回草稿 JSON：

```json
{
  "drafts": [
    {
      "slug": "inbox/example",
      "type": "knowledge",
      "title": "示例",
      "verification": "unverified",
      "status": "draft",
      "updated_at": "2026-07-26T12:00:00.000Z",
      "stale": false
    }
  ]
}
```

### 7.2 GET `/admin/api/review/inbox/<slug>`

返回单篇草稿详情，字段与 `get_page` 一致。

### 7.3 POST `/admin/api/review/plan`

请求体示例：

```json
{
  "action": "promote",
  "sourceSlug": "inbox/example",
  "targetSlug": "knowledge/example",
  "targetType": "knowledge"
}
```

返回 `planResultToJson` 结构，包含 `ok`、`code`、`message`、`gates`、`plan`。

### 7.4 POST `/admin/api/review/confirm`

请求体示例：

```json
{
  "action": "promote",
  "sourceSlug": "inbox/example",
  "target": "knowledge/example",
  "target_type": "knowledge",
  "confirmation": "PROMOTE knowledge/example"
}
```

返回：

```json
{
  "plan": { ... },
  "apply": {
    "ok": true,
    "code": "ok",
    "message": "审核已应用。",
    "receipts": [
      { "ok": true, "code": "write_target", "message": "write_target 完成。" },
      { "ok": true, "code": "verified", "message": "检索验证通过：knowledge/example 可读。" },
      { "ok": true, "code": "write_review", "message": "write_review 完成。" },
      { "ok": true, "code": "delete_source", "message": "delete_source 完成。" }
    ]
  }
}
```

### 7.5 GET `/admin/api/review/history`

返回：

```json
{
  "reviews": [
    {
      "slug": "decisions/reviews/example-review-20260726",
      "review_action": "promote",
      "source": ["inbox/example"],
      "updated_at": "2026-07-26T12:05:00.000Z"
    }
  ]
}
```

---

## 8. 与 CLI 的关系

| 能力 | Web UI | CLI |
| --- | --- | --- |
| 浏览 inbox | `/admin/review` | `gbrain review list` |
| 查看详情 | `/admin/review/detail/<slug>` | `gbrain review show <slug>` |
| 生成计划 | `/admin/review/plan/<slug>` | `gbrain review plan ...` |
| 执行审核 | 表单 POST | `gbrain review keep/promote/merge/reject/needs-evidence/repair/cleanup` |
| 确认门控 | `PROMOTE <target-slug>` / `MERGE <target-slug>` | 同样的确认短语 |
| 历史 | `/admin/review/history` | 无直接对应 |

两者共用同一套 `planReview` / `applyReviewPlan` 核心，门禁逻辑完全一致。

---

## 9. 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 页面提示“服务不可用” | 服务端 `local-writer.env` 缺失或 token 失效 | systemd 检查 credential；非 systemd 检查 `GBRAIN_REVIEW_WRITER_ENV_PATH` 和 token endpoint |
| 点击废弃等写操作一直失败 | 服务进程读不到 writer credential，或 writer MCP URL 与 attestation URL 不一致 | 检查 systemd `LoadCredential`、`GBRAIN_REVIEW_WRITER_MCP_URL` 和 `GBRAIN_LOOPBACK_MCP_URL` |
| 门禁失败 | 草稿未经验证、重复目标、unsafe content | 按门禁 code 修正后重新 plan |
| 确认执行返回 400 | 确认短语不匹配 | 输入完整的 `PROMOTE <target-slug>` 或 `MERGE <target-slug>` |
| 列表为空 | 没有 inbox 草稿或全部被软删除 | 检查 `gbrain review list` 是否一致 |

---

## 10. 相关文档

- [MCP_USAGE_GUIDE.md](MCP_USAGE_GUIDE.md)
- [QUICKSTART.md](QUICKSTART.md)
- [MCP_CONTRACT.md](MCP_CONTRACT.md)
- [FAILURE_RECOVERY.md](FAILURE_RECOVERY.md)
- `../../skills/gbrain-review/SKILL.md`
