# GBrain MCP 使用与认证指南

本文档面向需要手动调用 GBrain MCP 的操作人员，也适合未来 agent 快速查阅。请把它当作一份“最小可用速查卡”。需要把 GBrain 接入 OpenCode 时，先按 [OpenCode 客户端安装部署指南](CLIENT_INSTALL_DEPLOYMENT.md) 完成客户端配置和 OAuth 认证。

**核心占位符**：本文所有示例里的 `<server>` 都是服务器地址占位符，请替换为实际值；不要把真实 IP 写进本仓库任何文件。

**v1 实现范围**：
- 默认查询 (`query`/`search`) 只返回已发布知识；`inbox/` 草稿不会出现在默认结果里。
- 不存在生命周期钩子（lifecycle hook），所有写入都必须通过 MCP 工具或 CLI 显式完成。
- 升级通用经验（`promote` 到 `knowledge/` / `runbooks/`）必须逐条人工输入 `PROMOTE <target-slug>`，agent 不会自动完成。

---

## 1. MCP 端点

| 用途 | URL |
| --- | --- |
| MCP JSON-RPC | `http://<server>:3131/mcp` |
| OAuth token | `http://<server>:3131/token` |
| 只读 Web UI | `http://<server>:3132`（不在本文范围内） |
| 审核 Web UI | `http://<server>:3132/admin/review`（见 [WEB_UI_REVIEW.md](WEB_UI_REVIEW.md)） |

MCP 采用 JSON-RPC 2.0 over HTTP POST。响应是 `text/event-stream`（SSE）格式，客户端需要解析 `data:` 帧，不能直接按单个 JSON 对象处理。

---

## 2. 身份认证流程

### 2.1 凭证文件

以下两个现有客户端专供命令行脚本使用：

- `local-read`：scope 为 `read`，只读。
- `local-writer`：scope 为 `read write`，可写入和更新页面。

它们使用 `client_credentials`，不适用于 OpenCode 的浏览器 OAuth 流程。OpenCode 必须使用单独预注册的 `authorization_code,refresh_token` 客户端；不要把 `local-read` 或 `local-writer` 的 secret 写进 `opencode.json`。反过来，OpenCode 的 `clientId` 是公开的 OAuth 标识，不附带 client secret，**不得用于本指南的 `client_credentials` 手动换 token 流程**——那只会返回 `invalid_client` 或 `unsupported_grant_type`。手动 JSON-RPC 永远只使用 `local-read` / `local-writer`。

服务器端原始文件位于 `/etc/gbrain/clients/<client>.env`。请把需要使用的客户端文件复制到本机：

```bash
sudo install -m 0600 /etc/gbrain/clients/local-read.env ~/.config/gbrain/local-read.env
sudo install -m 0600 /etc/gbrain/clients/local-writer.env ~/.config/gbrain/local-writer.env
```

这些文件权限应为 `600`，内容大致如下（值已隐去）。为保证子进程（例如 `curl` 调用链中的 `python3`）能看到变量，**变量名需以 `export` 前置**：

```bash
export GBRAIN_MCP_URL=http://<server>:3131/mcp
export GBRAIN_TOKEN_ENDPOINT=http://<server>:3131/token
export GBRAIN_CLIENT_ID=<CLIENT_ID>
export GBRAIN_CLIENT_SECRET=<CLIENT_SECRET>
export GBRAIN_SCOPES=read           # local-writer.env 里为 "read write"
```

### 2.2 换取 access_token

`access_token` 是短期的，调用前用 `client_credentials` 流程重新换取。如果 env 文件未使用 `export`，需要用 `set -a` 把所有自动导出：

```bash
# 方式 1：env 文件已经 export
source ~/.config/gbrain/local-read.env

# 方式 2：env 文件未 export 时，显式打开自动导出
set -a
source ~/.config/gbrain/local-read.env
set +a

GBRAIN_BEARER=$(curl -sS -X POST "$GBRAIN_TOKEN_ENDPOINT" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "client_id=$GBRAIN_CLIENT_ID" \
  --data-urlencode "client_secret=$GBRAIN_CLIENT_SECRET" \
  --data-urlencode "scope=$GBRAIN_SCOPES" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
```

> 不要直接复制 `$GBRAIN_BEARER` 的值到文档、聊天记录或 Git 里。后续示例用 `<TOKEN-local-read>` 表示。

### 2.3 调用 MCP 时的必要请求头

所有 MCP 请求必须带：

```bash
-H 'Authorization: Bearer <TOKEN>'
-H 'Content-Type: application/json'
-H 'Accept: application/json, text/event-stream'
```

缺少 `Accept: application/json, text/event-stream` 会收到 406 错误。

---

## 3. 协议自描述

客户端在 `initialize` 响应中可看到 GBrain 的操作说明，以及 `tools`、`prompts`、`resources` 三类能力。当前服务还发布以下自描述内容：

- prompts：`search_knowledge`、`capture_knowledge`。
- resources：`gbrain://guide/workflows`、`gbrain://schema/page`。
- tools：每个工具均带 MCP annotations，客户端可据此判断只读性、破坏性、幂等性和开放世界访问属性。

### 3.1 列出和读取 prompts

```bash
curl -sS -H "Authorization: Bearer <TOKEN-local-read>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"prompts/list","params":{},"id":1}' \
  http://<server>:3131/mcp

curl -sS -H "Authorization: Bearer <TOKEN-local-read>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"prompts/get","params":{"name":"search_knowledge","arguments":{"query":"MCP"}},"id":2}' \
  http://<server>:3131/mcp
```

`search_knowledge` 要求 `query`；`capture_knowledge` 要求 `content`，并接受可选的 `slug`。未知 prompt 或缺少必填参数时，服务返回 `-32602 InvalidParams`，错误消息会提示先调用 `prompts/list`。

### 3.2 列出和读取 resources

```bash
curl -sS -H "Authorization: Bearer <TOKEN-local-read>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"resources/list","params":{},"id":3}' \
  http://<server>:3131/mcp

curl -sS -H "Authorization: Bearer <TOKEN-local-read>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"resources/read","params":{"uri":"gbrain://guide/workflows"},"id":4}' \
  http://<server>:3131/mcp
```

写入前应读取 `gbrain://guide/workflows` 和 `gbrain://schema/page`。未知 URI 同样返回 `-32602 InvalidParams`，并提示先调用 `resources/list`。

---

## 4. 列出 MCP 工具

```bash
curl -sS -H "Authorization: Bearer <TOKEN-local-read>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}' \
  http://<server>:3131/mcp
```

返回的 SSE 帧里会包含工具列表。当前已验证存在的工具包括（但不限于）：

- `get_brain_identity`
- `search`
- `query`
- `get_page`
- `list_pages`
- `put_page`
- `delete_page`

实际可用工具以 `tools/list` 返回值为准。

---

## 5. 典型 JSON-RPC 调用示例

所有示例都使用 `tools/call` 方法，参数结构为 `{"name": "工具名", "arguments": {...}}`。

### 5.1 获取 brain 基本信息

```bash
curl -sS -H "Authorization: Bearer <TOKEN-local-read>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_brain_identity","arguments":{}},"id":2}' \
  http://<server>:3131/mcp
```

### 5.2 关键词搜索

```bash
curl -sS -H "Authorization: Bearer <TOKEN-local-read>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search","arguments":{"query":"MCP","limit":10}},"id":3}' \
  http://<server>:3131/mcp
```

`query` 的调用结构与 `search` 相同，支持语义+关键词混合检索：

```bash
curl -sS -H "Authorization: Bearer <TOKEN-local-read>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"query","arguments":{"query":"知识库写入","limit":10}},"id":4}' \
  http://<server>:3131/mcp
```

**默认查询不包含 `inbox/`**：
`search` 和 `query` 默认只返回已确认知识；`inbox/` 草稿不会出现在默认结果里。要列出草稿，请用 `list_pages` 并显式指定 `include_prefixes: ["inbox/"]`。

### 5.3 写入/更新页面

**只能使用 `local-writer` 凭证**。`put_page` 需要 slug 和完整的 Markdown 内容（含 YAML frontmatter）。

```bash
curl -sS -H "Authorization: Bearer <TOKEN-local-writer>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc":"2.0",
    "method":"tools/call",
    "params":{
      "name":"put_page",
      "arguments":{
        "slug":"inbox/mcp-usage-guide-example",
        "content":"---\ntype: knowledge\ndate: 2026-07-24\nstatus: draft\nsensitivity: internal\nverification: unverified\napplicability:\n  - gbrain-mcp\nnon_applicable: []\nsource_refs:\n  - mcp-usage-guide-draft\nmigrated_from: null\n---\n\n# 示例页面\n\n这是 MCP put_page 的 inbox 草稿：路径在 inbox/，type 仍为目标类型，status 固定为 draft。\n"
      }
    },
    "id":5
  }' \
  http://<server>:3131/mcp
```

成功后可在响应里看到 `status: created_or_updated`。如果写入的是探针页面，请调用 `delete_page` 及时清理：

```bash
curl -sS -H "Authorization: Bearer <TOKEN-local-writer>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"delete_page","arguments":{"slug":"inbox/mcp-usage-guide-example"}},"id":6}' \
  http://<server>:3131/mcp
```

---

## 6. MCP Contract：读取过滤与分页

MCP 读取工具（`search`、`query`、`list_pages`）共享同一套过滤参数和分页元数据。完整规范见 [MCP_CONTRACT.md](MCP_CONTRACT.md)。

### 6.1 读取过滤参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `include_prefixes` | `string[]` | slug 前缀白名单，如 `["knowledge/", "runbooks/"]` |
| `exclude_prefixes` | `string[]` | slug 前缀黑名单 |
| `status` | `string` | `draft`、`reviewed`、`verified`、`migrated-legacy` |
| `verification` | `string` | `unverified`、`verified` |
| `limit` | `number` | 每页最大数量，默认 20~50，最大 100 |
| `offset` | `number` | 分页偏移，从 0 开始 |

**默认值**：`search`/`query` 默认不返回 `inbox/` 草稿；只有显式传入 `include_prefixes: ["inbox/"]` 才会列出草稿。

### 6.2 分页信封

当请求包含 `include_prefixes`、`exclude_prefixes`、`status`、`verification` 或 `offset` 时，返回结构会变为信封：

```jsonc
{
  "count": 10,
  "total_count": 42,
  "has_more": true,
  "next_offset": 10,
  "limit": 10,
  "offset": 0,
  "items": [ ... ]
}
```

### 6.3 列出 inbox 草稿

```bash
curl -sS -H "Authorization: Bearer <TOKEN-local-read>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_pages","arguments":{"include_prefixes":["inbox/"],"limit":50}},"id":7}' \
  http://<server>:3131/mcp
```

---

## 7. Scope 与凭证隔离

| 客户端 | Scope | 允许的操作 |
| --- | --- | --- |
| `local-read` | `read` | `tools_list`、`get_brain_identity`、`search`、`query`、`get_page`、`list_pages` 等 |
| `local-writer` | `read write` | 除只读操作外，还可 `put_page`、`delete_page` |

**红线**：`put_page` 绝不能用 `local-read` 的 token。如果误用，响应会包含 `insufficient_scope` 或 403 类错误，不会写入任何内容。

---

## 8. Writer 写入工作流

只有受信任的 writer 客户端才应使用 `local-writer` 凭证。写入前请按以下顺序执行：

1. **先搜索**。用 `search` 或 `query` 按 slug 和标题关键词查找是否已有相关页面。
2. **分类**。选择唯一一个 `type` 和对应的路径前缀。`inbox/` 是**草稿暂存路径**，与 `type` 字段正交：在 `inbox/` 写入时仍按目标主题填 `type`（如 `knowledge`），但 `status` 必须是 `draft`，等评审通过后 `put_page` 用正式路径覆盖：
   - `knowledge/` → `type: knowledge`
   - `projects/` → `type: project`
   - `incidents/` → `type: incident`
   - `runbooks/` → `type: runbook`
   - `decisions/` → `type: decision`
   - `environments/` → `type: environment`
   - `agent-skills/` → `type: agent-skill`
   - `inbox/<topic>` → `type: <目标类型>`，`status: draft`
   - `legacy-migration/` → `type: legacy`，`status: migrated-legacy`
3. **遵守 9 字段 frontmatter 契约**。必须字段：
   `type`、`date`、`status`、`sensitivity`、`verification`、`applicability`、`non_applicable`、`source_refs`、`migrated_from`。
   不要添加投机字段。详见 `../../source/SCHEMA.md`。
4. **填写 source_refs**。每条事实性结论都要能追溯到证据路径、文档 URL、commit 或 session id。
5. **更新而不是重复**。如果已有相关页面，用同一个 slug 更新；必要时在正文里注明合并来源。
6. **写后检查**。查看 `put_page` 返回的 `auto_links` 和状态，确认没有写错 slug 或产生重复。

更完整的 writer 流程参考 `../../skills/gbrain-knowledge-writer/SKILL.md`。

---

## 9. CLI 捕获与审核工作流

`gbrain` CLI 把凭证管理、搜索、写入和审核封装成本地命令。以下命令均从 gbrain 仓库源码或已安装包执行：

```bash
# 在 gbrain 源码目录下
bun run src/cli.ts capture <subcommand>
bun run src/cli.ts review <subcommand>
bun run src/cli.ts install-client

# 或已安装全局 gbrain 后
gbrain capture <subcommand>
gbrain review <subcommand>
gbrain install-client
```

### 9.1 结构化捕获

```bash
gbrain capture \
  --title "MCP 冒烟测试成功" \
  --summary "在本地环境完成了 MCP 工具列表示例，成功返回 tools/list 结果。" \
  --evidence "todo-11/mcp-smoke-test" \
  --type knowledge \
  --sensitivity internal \
  --json
```

输出示例：

```json
{
  "ok": true,
  "mode": "online",
  "slug": "inbox/mcp-smoke-test-success",
  "status": "draft",
  "verification": "unverified",
  "search_before_create": true
}
```

约束：
- 必须提供 `--title` 和 `--summary`（或 `--body`）。
- 必须至少提供一条 `--evidence`。
- `--type` 只能是 `knowledge`、`project`、`incident`、`runbook`、`decision`、`environment`、`agent-skill` 之一；最终类型由人工审核决定。
- 生成的 slug 始终落在 `inbox/`，且 `status: draft`、`verification: unverified`。即使传入 `--verification verified`，也会被强制为 `unverified`。
- 离线时会写入 `.omo/gbrain-capture/offline/*.json`，可用 `gbrain capture retry` 重放。

### 9.2 审核草稿

```bash
# 列出 inbox 草稿
gbrain review list

# 查看详情
gbrain review show inbox/mcp-smoke-test-success

# 生成计划（不写入）
gbrain review plan inbox/mcp-smoke-test-success \
  --action keep \
  --target projects/mcp-smoke-test-guide \
  --type project

# 保留到项目路径
gbrain review keep inbox/mcp-smoke-test-success \
  --target projects/mcp-smoke-test-guide \
  --type project

# 验证目标可检索
gbrain review verify projects/mcp-smoke-test-guide

# 升级到通用知识（需要 verification: verified + 人工确认）
gbrain review promote inbox/mcp-smoke-test-success \
  --target knowledge/mcp-smoke-test-guide \
  --type knowledge \
  --confirm "PROMOTE knowledge/mcp-smoke-test-guide"

# 证据不足，退回补材料
gbrain review needs-evidence inbox/mcp-smoke-test-success \
  --reason "缺少 curl 原始响应和返回的 tools/list 数量"

# 拒绝并删除
gbrain review reject inbox/mcp-smoke-test-success \
  --reason "测试探针，非知识"
```

> **实现细节**：`gbrain review keep` 的目标类型为 `knowledge` 或 `runbook` 时，CLI 会映射为 `promote` 并强制要求 `PROMOTE <target-slug>` 确认；其他类型（`project`、`incident`、`decision`、`environment`、`agent-skill`）直接走 `keep` 路径。

### 9.3 中文交互式审核

不带参数运行 `gbrain review` 会进入中文交互模式：

```text
gbrain review
待审核草稿
1. inbox/mcp-smoke-test-success   runbook    unverified   draft   中文标题

选择要审核的 draft: 1
草稿: inbox/mcp-smoke-test-success
选择处置动作: needs-evidence / reject / keep / promote / merge
选择处置动作: keep
目标 slug: projects/mcp-smoke-test-guide
目标类型: project
```

- `keep` 到 `project`/`incident`/`decision`/`environment`/`agent-skill` 直接执行。
- `keep` 到 `knowledge`/`runbook` 会被映射为 `promote` 并要求输入 `PROMOTE <target-slug>`。
- `promote` 会提示输入 `PROMOTE <target-slug>`；只有完全匹配的短语才通过门禁。
- `reject` 和 `needs-evidence` 必须输入原因。
- `merge` 会提示输入 `MERGE <target-slug>` 或目标 slug。

### 9.4 离线捕获与重试

如果本地 writer 凭证不可用，捕获会自动进入离线队列：

```bash
# 模拟离线环境
HOME=/tmp/no-gbrain-home gbrain capture \
  --title "离线测试" \
  --summary "没有 writer 凭证时进入离线队列。" \
  --evidence "offline-demo"
# 输出：offline_path: /tmp/no-gbrain-home/.omo/gbrain-capture/offline/...

# 恢复凭证后重试
gbrain capture retry --json
```

离线 JSON 文件包含完整候选记录，但**不包含** bearer token、client secret、原始 transcript 或完整工具输出。恢复网络后 `gbrain capture retry` 会逐条重试并删除成功项。

---

## 10. Web UI 审核流程

GBrain 在 `http://<server>:3132/admin/review` 提供只读审核页面。浏览器**永远看不到** writer token 或 client secret，所有写操作由服务端通过本地 writer 凭证执行。详见 [WEB_UI_REVIEW.md](WEB_UI_REVIEW.md)。

页面清单：
- `/admin/review`：inbox 草稿列表，支持按 type、verification、status、stale 过滤。
- `/admin/review/detail/<slug>`：草稿详情、frontmatter、风险检查、操作表单。
- `/admin/review/plan/<slug>`：审核计划，展示门禁结果和计划步骤。
- `/admin/api/review/confirm`：执行 plan + apply（需要 admin cookie）。
- `/admin/review/history`：已写入的 `decisions/reviews/*` 记录。

权限模型：
- 浏览页面需要 admin 认证（与现有 admin dashboard 共享 `requireAdmin`）。
- 写操作（keep/promote/merge/reject/needs-evidence/repair/cleanup）需要服务端已配置 `local-writer` 凭证。
- `promote` 和 `merge` 需要浏览器输入 `PROMOTE <target-slug>` 或 `MERGE <target-slug>`，与 CLI 门禁一致。

---

## 11. 禁止写入的内容

所有通过 `put_page` 进入 GBrain 的页面都会经过服务端验证扫描。以下内容禁止写入：

- 密码、token、API key、私钥、原始认证文件。
- 真实个人姓名、员工 ID、个人账号。
- 非回环 IP 地址。请用 `<SERVER_IP>`、`<server>`、`<EXAMPLE_HOST>` 等占位符。
- 密集原始日志或完整命令输出。只把结论写进正文，把日志路径放进 `source_refs`。

详细规则见 `../../source/README.md` 和 `../../skills/gbrain-knowledge-writer/SKILL.md`。

---

## 12. 常见错误速查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 401 Unauthorized | token 缺失、过期或 client credentials 错误 | 重新换取 `access_token`，检查凭证文件权限是否为 `600` |
| 403 / `insufficient_scope` | 用 `local-read` token 调用了写操作 | 换成 `local-writer` 凭证 |
| 405 Method Not Allowed | 对 `/mcp` 使用了 GET 等非 POST 方法 | 改为 POST |
| 406 Not Acceptable | 缺少 `Accept: application/json, text/event-stream` | 补全请求头 |
| 连接超时 / Connection refused | 云安全组或服务不可达 | 确认云安全组允许 3131 且服务正在监听；主机不按源 IP 白名单限制，MCP 访问仍由 bearer token 控制 |
| `missing local writer credentials` | `~/.config/gbrain/local-writer.env` 不存在或缺少必要字段 | 运行 `gbrain install-client` 或按第 2 节复制 env 文件 |
| `PROMOTE <target-slug>` 失败 | 确认短语不匹配或升级目标未通过门禁 | 重新检查 target slug、verification、重复页和 unsafe content 门禁 |
| `writer_token_mint_failed` | token endpoint 返回 429 或凭证错误 | 等待 `Retry-After` 后重试，避免一个会话内多次 mint token |
| `put_page` 拒绝 unsafe content | 正文包含 token、IP、raw transcript 或密集日志 | 清理敏感内容，把证据指针放进 `source_refs` |

---

## 13. 失败恢复与离线重试

- `gbrain capture retry`：重放 `.omo/gbrain-capture/offline/*.json` 队列，成功后删除队列文件。
- `gbrain review repair inbox/<slug>`：当审核记录写入失败时，仅重新写入 review record，不删除原 `inbox/` 草稿。
- `gbrain review cleanup inbox/<slug>`：对探针或废弃草稿先写审核记录再软删除。
- `gbrain install-client`：重新安装 OpenCode/Codex 规则、skills 和本地 env 文件，并执行读写探针。
- 删除页面是**软删除**，72 小时内可恢复；`include_deleted: true` 可验证软删除是否落地。

详细操作见 [FAILURE_RECOVERY.md](FAILURE_RECOVERY.md)。

---

## 14. 成功案例与错题示例

### 14.1 成功案例：结构化捕获并保留为项目记录

场景：完成一次 MCP 冒烟测试后，需要把验证步骤保留为项目记录。

正确做法：
1. 用 `gbrain capture --title ... --summary ... --evidence ...` 写入 `inbox/`。
2. 用 `gbrain review show` 和 `gbrain review plan` 检查门禁。
3. 用 `gbrain review keep ... --target projects/... --type project` 保留到项目路径（`knowledge`/`runbook` 会被映射为 `promote`，需要 `verification: verified`）。
4. 用 `gbrain review verify` 确认目标可检索。
5. 清理探针：`gbrain review cleanup inbox/<probe>`。

结果：
- 目标 slug 出现在 `projects/` 且可被 `query` 检索。
- 审核记录写入 `decisions/reviews/`。
- 原 `inbox/` 草稿被软删除。

结论：
- 始终先写 inbox，再人工审核，再决定去向。
- `source_refs` 必须指向真实证据，不能把 curl 完整输出写进正文。
- 保留到 `knowledge/` / `runbooks/` 必须满足 `verification: verified` 和 `PROMOTE` 确认。

下次规则：
- 每次验证通过后，先捕获到 inbox，再执行 review。
- 探针页面必须立即 cleanup。

### 14.2 错题示例：用 promote 升级未经验证的草稿

场景：试图把一条只有标题和一句话的草稿直接 promote 到 `knowledge/`。

错误做法：
- 未检查 `verification` 和 `status` 就执行 `promote`。
- 未提供 `PROMOTE <target-slug>` 确认短语。
- 正文中把完整 API 响应粘贴进去。

失败结果：
- 门禁返回 `unverified_promote`（草稿 verification 不是 verified）。
- 门禁返回 `promote_confirmation_required`（缺少人工确认短语）。
- 门禁返回 `unsafe_content`（正文包含 raw JSON 或密集日志）。
- 原 `inbox/` 草稿未被删除，可重新补证据后再次审核。

结论：
- 草稿未经验证且缺少证据时不能升级。
- 升级通用知识必须人工逐条确认。
- 不能把原始工具输出写进 GBrain。

下次规则：
- 只有 `verification: verified` 且 evidence 充分时才 promote。
- 正文只写结论，证据放进 `source_refs`。
- 升级前用 `gbrain review plan` 预览门禁。

---

## 15. 复制粘贴冒烟测试

把下面脚本保存为 `gbrain-smoke.sh`，替换 `<server>` 后即可运行：

```bash
#!/usr/bin/env bash
set -euo pipefail

GBRAIN_MCP_URL="http://<server>:3131/mcp"
GBRAIN_TOKEN_ENDPOINT="http://<server>:3131/token"

# 1. 读取 local-read 凭证并换取 token
set -a
source ~/.config/gbrain/local-read.env
set +a
GBRAIN_BEARER=$(curl -sS -X POST "$GBRAIN_TOKEN_ENDPOINT" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "client_id=$GBRAIN_CLIENT_ID" \
  --data-urlencode "client_secret=$GBRAIN_CLIENT_SECRET" \
  --data-urlencode "scope=$GBRAIN_SCOPES" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

# 2. 列出工具
curl -sS -H "Authorization: Bearer $GBRAIN_BEARER" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}' \
  "$GBRAIN_MCP_URL" | tee /tmp/gbrain-tools-list.json

# 3. 获取 brain 身份
curl -sS -H "Authorization: Bearer $GBRAIN_BEARER" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_brain_identity","arguments":{}},"id":2}' \
  "$GBRAIN_MCP_URL" | tee /tmp/gbrain-identity.json

# 4. 搜索
curl -sS -H "Authorization: Bearer $GBRAIN_BEARER" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search","arguments":{"query":"MCP","limit":5}},"id":3}' \
  "$GBRAIN_MCP_URL" | tee /tmp/gbrain-search.json

echo "smoke test done"
```

写入测试请单独使用 `local-writer.env` 并在完成后删除探针页面。

---

## 16. 相关文档

- 快速上手：[QUICKSTART.md](QUICKSTART.md)
- 源仓库规范：`../../source/README.md`
- OpenCode 客户端安装部署：[CLIENT_INSTALL_DEPLOYMENT.md](CLIENT_INSTALL_DEPLOYMENT.md)
- MCP Contract 详细规范：[MCP_CONTRACT.md](MCP_CONTRACT.md)
- Web UI 审核流程：[WEB_UI_REVIEW.md](WEB_UI_REVIEW.md)
- 失败恢复与离线重试：[FAILURE_RECOVERY.md](FAILURE_RECOVERY.md)
- frontmatter 9 字段契约：`../../source/SCHEMA.md`
- 完整 writer 工作流：`../../skills/gbrain-knowledge-writer/SKILL.md`
- 运维与重建手册：`../../runbook/OPERATIONS.md`
- agent 切换启用说明：`../../cutover/ACTIVATE.md`
