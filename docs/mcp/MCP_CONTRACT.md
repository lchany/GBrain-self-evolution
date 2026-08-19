# GBrain MCP Contract

本文档描述 GBrain MCP 服务 v1 的契约细节，适用于手动调用 MCP、编写 mcp-builder 兼容客户端、或调试跨客户端行为。

**核心原则**：
- 所有 MCP 调用都是 JSON-RPC 2.0 over HTTP POST。
- 响应使用 SSE（`text/event-stream`）格式；客户端需解析 `data:` 帧。
- 读取工具共享同一套过滤参数和分页元数据。
- `put_page` 在服务端进行 schema 验证和 unsafe content 扫描。
- 默认查询不返回 `inbox/` 草稿；需要显式 `include_prefixes: ["inbox/"]`。
- v1 没有 lifecycle hook，写入操作必须显式调用。

---

## 1. 传输与认证

### 1.1 端点

| 端点 | URL |
| --- | --- |
| MCP | `http://<server>:3131/mcp` |
| OAuth token | `http://<server>:3131/token` |

### 1.2 请求头

```http
Authorization: Bearer <TOKEN>
Content-Type: application/json
Accept: application/json, text/event-stream
```

缺少 `Accept: application/json, text/event-stream` 会返回 `406 Not Acceptable`。

### 1.3 凭证隔离

- **OpenCode**：使用浏览器 OAuth 流程，`client_id` 在 `~/.config/opencode/opencode.json` 中配置，无 `client_secret`。
- **命令行脚本**：使用 `client_credentials`，凭证存于 `~/.config/gbrain/local-read.env`（`read` scope）和 `local-writer.env`（`read write` scope）。
- 两者凭证不可混用：OpenCode 的 `client_id` 不能用于 `client_credentials`；`local-read` 的 token 不能用于写操作。

---

## 2. 读取工具过滤参数

以下工具共享同一套过滤参数：

- `search`
- `query`
- `list_pages`

### 2.1 参数列表

| 参数 | 类型 | 约束 | 默认值 |
| --- | --- | --- | --- |
| `include_prefixes` | `string[]` | 1~20 项，每项 1~200 字符，安全 slug 前缀 | 无 |
| `exclude_prefixes` | `string[]` | 1~20 项，每项 1~200 字符，安全 slug 前缀 | 无 |
| `status` | `string` | `draft`、`reviewed`、`verified`、`migrated-legacy` | 无 |
| `verification` | `string` | `unverified`、`verified` | 无 |
| `limit` | `number` | 整数 1~100 | 工具特定（search 20，list_pages 50） |
| `offset` | `number` | 整数 0~10000 | 0 |

**安全前缀规则**：
- 不允许以 `/` 开头。
- 不允许包含 `..`、`\`、空白字符、控制字符或通配符 `*?[]{}`。

### 2.2 默认排除 inbox

`search` 和 `query` 默认不返回 `inbox/` 草稿。要列出草稿，必须显式调用：

```json
{
  "name": "list_pages",
  "arguments": {
    "include_prefixes": ["inbox/"],
    "limit": 50
  }
}
```

### 2.3 分页信封

当请求包含 `include_prefixes`、`exclude_prefixes`、`status`、`verification` 或 `offset` 时，返回结果变为信封结构：

```json
{
  "count": 10,
  "total_count": 42,
  "has_more": true,
  "next_offset": 10,
  "limit": 10,
  "offset": 0,
  "items": [
    { "slug": "knowledge/mcp-contract", "title": "GBrain MCP Contract", "type": "knowledge" }
  ]
}
```

字段含义：
- `count`：当前页返回数量。
- `total_count`：过滤后总数量。
- `has_more`：是否还有下一页。
- `next_offset`：下一页偏移；没有更多时为 `null`。
- `limit`：本次请求的 limit。
- `offset`：本次请求的 offset。
- `items`：当前页结果。

### 2.4 调用示例

```bash
curl -sS -H "Authorization: Bearer <TOKEN-local-read>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "list_pages",
      "arguments": {
        "include_prefixes": ["knowledge/"],
        "status": "verified",
        "limit": 10,
        "offset": 0
      }
    },
    "id": 1
  }' \
  http://<server>:3131/mcp
```

---

## 3. put_page 写入契约

### 3.1 必需参数

```json
{
  "name": "put_page",
  "arguments": {
    "slug": "inbox/example-note",
    "content": "---\ntype: knowledge\n...\n---\n\n正文"
  }
}
```

- `slug`：非空字符串，长度不超过 255。
- `content`：完整 Markdown，含 YAML frontmatter。

### 3.2 slug 规则

- 只允许小写字母、数字、连字符 `-`。
- 分段以 `/` 分隔。
- 不允许以 `/` 结尾、不允许 `.md` 后缀。
- CJK 字符在 v0.32.7+ 允许使用。

### 3.3 9 字段 frontmatter

`strictSchema` 为 true（即远程 MCP 调用）时，schema 管理路径必须包含以下字段：

```yaml
---
type: knowledge        # 必须：knowledge/project/incident/runbook/decision/environment/agent-skill/legacy
date: 2026-07-26       # 必须：YYYY-MM-DD
status: draft          # 必须：draft/reviewed/verified/migrated-legacy
sensitivity: internal  # 必须：public/internal/private
verification: unverified # 必须：unverified/verified
applicability:
  - capture-candidate    # 必须：非空字符串列表
non_applicable: []      # 必须：字符串列表
source_refs:            # 必须：非空字符串列表
  - evidence-pointer
migrated_from: null     # 必须：null（非 legacy 时）
---
```

### 3.4 路径与状态对照

| 路径前缀 | 允许状态 | 说明 |
| --- | --- | --- |
| `inbox/` | `draft` | 草稿暂存，verification 必须为 `unverified` |
| `knowledge/` | `reviewed`、`verified` | 通用经验 |
| `projects/` | `reviewed`、`verified` | 项目经验 |
| `runbooks/` | `reviewed`、`verified` | 运维手册 |
| `incidents/` | `reviewed`、`verified` | 错题/事故 |
| `decisions/` | `reviewed`、`verified` | 决策记录 |
| `environments/` | `reviewed`、`verified` | 环境信息 |
| `agent-skills/` | `reviewed`、`verified` | agent 技能 |
| `legacy-migration/` | `migrated-legacy` | 迁移内容，需 `migrated_from` |
| `decisions/reviews/` | `reviewed` | 审核记录，由 `gbrain review` 自动生成 |

### 3.5 删除与恢复

| 工具 | 行为 | 返回关键字段 |
| --- | --- | --- |
| `delete_page` | 软删除页面，72 小时内可恢复 | `status: "soft_deleted"`, `recoverable_until` |
| `restore_page` | 恢复被软删除的页面 | `status: "restored"`, `slug` |

软删除后的页面默认不会出现在 `search`/`query`/`list_pages`/`get_page` 结果中；验证删除状态需用 `get_page` 并传入 `include_deleted: true`。

### 3.6 Unsafe content 检查

`put_page` 会拒绝包含以下内容的页面：

- `sk-...`、AWS key、GitHub PAT、Slack token、以 `gbrain_` 开头的 secret 等。
- `-----BEGIN ... PRIVATE KEY-----` 私钥。
- 非回环 IPv4 地址。
- raw transcript、raw tool output、raw JSON 日志。
- 密集日志行（超过阈值）。
- content-sanity 判定为垃圾/超大内容。

---

## 4. mcp-builder 兼容建议

使用 MCP SDK 或 mcp-builder 编写客户端时，请遵守以下约定：

### 4.1 工具发现

1. 调用 `tools/list` 获取工具列表。
2. 根据 annotations 中的 `readOnlyHint`、`destructiveHint`、`idempotentHint` 决定是否在 UI 中启用。
3. 写操作前调用 `resources/read` 读取 `gbrain://schema/page` 和 `gbrain://guide/workflows`。

### 4.2 读取分页

- 始终使用 `limit` + `offset` 翻页。
- 检查 `has_more` 决定是否继续请求 `next_offset`。
- 查询草稿时显式传入 `include_prefixes: ["inbox/"]`。

### 4.3 写入流程

1. 先搜索：`search` 或 `query` 检查重复。
2. 选择 slug 和 type，确保路径与 type 一致。
3. 准备完整 frontmatter（9 字段）。
4. 调用 `put_page`。
5. 调用 `get_page` 验证写入。
6. 测试探针调用 `delete_page` 清理。

### 4.4 错误处理

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `invalid_params` | 参数或 frontmatter 不合法 | 按返回的 suggestion 修正 |
| `permission_denied` | scope 不足 | 换用 `local-writer` 或注册更大 scope |
| `insufficient_scope` | token scope 不支持写操作 | 换用 writer 凭证 |
| `page_not_found` | 页面不存在 | 检查 slug 或 `include_deleted: true` |
| `unsafe_content` | 包含 token/IP/日志 | 清理正文，把证据指针放进 `source_refs` |
| `duplicate_target` | 目标已存在 | 改用 merge 或更新已有页 |
| `unverified_promote` | 草稿未经验证 | 补充证据后改为 `verified` 或改用 `keep` |

---

## 5. 审核相关 MCP 操作

虽然 `gbrain review` 是推荐入口，但其底层仍通过 MCP 工具完成：

- `list_pages` + `include_prefixes: ["inbox/"]`：列出草稿。
- `get_page`：读取草稿。
- `search`：检查重复目标。
- `put_page`：写入目标页和审核记录页。
- `delete_page`：软删除原 `inbox/` 草稿。

审核流程门禁由 `gbrain review` CLI 或 Web UI 执行，不通过单独的 MCP 工具暴露。

---

## 6. v1 未实现事项

- 没有 lifecycle hook。
- 没有自动 promote；升级必须人工确认。
- 没有自动审核计划调度；所有审核由 `gbrain review` 或 Web UI 触发。
- 默认 `search`/`query` 不返回 `inbox/` 草稿。

---

## 7. 相关文档

- [MCP_USAGE_GUIDE.md](MCP_USAGE_GUIDE.md)
- [QUICKSTART.md](QUICKSTART.md)
- [WEB_UI_REVIEW.md](WEB_UI_REVIEW.md)
- [FAILURE_RECOVERY.md](FAILURE_RECOVERY.md)
- `../knowledge-source/SCHEMA.md`
- `../../skills/gbrain-knowledge-writer/SKILL.md`
