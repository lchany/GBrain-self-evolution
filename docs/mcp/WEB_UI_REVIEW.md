# GBrain Web 审核界面（/admin/review）

本文档描述服务端渲染的 GBrain 审核控制台：引导操作者从 inbox 分诊到安全的审核决定，全程中文界面，保留 promote/merge 人工确认门禁，并定义结果回执、端点契约、Origin/CSRF 规则与浏览器安全 JSON 契约。

## 流程总览

1. **Inbox 分诊台** `GET /admin/review` — 导航式列表。仅支持现有 API 筛选（`type`、`verification`、`stale`、`project_id`）；风险与重复列在预检前一律显示「未预检」；每行通过「开始审核」进入详情。列表不含任何写入控件。
2. **草稿详情** `GET /admin/review/detail/<slug>` — 摘要优先：草稿类型、用途、证据充分性、敏感内容状态、重复状态、建议下一步；元数据与内容为可展开的浏览器安全预览（脱敏 + 最长 2000 字符）。处理方式以中文决策卡呈现：常用处理（留在项目内、变成通用经验、合并到已有内容、先补证据）与更多处理方式（丢弃这条草稿、修复审核记录、清理草稿残留）。
3. **目标选择或审核说明** `GET /admin/review/plan/<slug>?action=<action>` — 目标类型必须由人工从七种审核目标类型（knowledge、runbook、incident、decision、project、environment、agent-skill）中选择，绝不从源页 PageType 推断。keep/promote 生成确定性 slug（规范前缀 + inbox 尾部，小写化、非法字符转 `-`、合并重复 `-`、最长 80 字符），先做 `engine.getPage(targetSlug)` 精确冲突检查，再做有界重复候选搜索；merge 只能选择当前审核来源内已存在的页面；手动输入 slug 是带校验的高级路径。`reject` 与 `needs_evidence` 先要求填写非空审核说明，才能进入预检。
4. **预检** `GET /admin/review/plan/<slug>?action=...&target_type=...&target=...` — 只读预览：选择的操作、来源、目标、影响、证据缺口、敏感内容检查、重复检查、门禁结果、确认要求。promote/merge 的确认门禁显示「待输入确认短语」；预检不会授权或执行写入。
5. **确认执行** `POST /admin/api/review/confirm` — 服务端重新解析确认短语、重新运行全部门禁，全部通过后才执行写入计划。
6. **审核结果** — 浏览器表单提交（`Accept: text/html`）返回 HTML 结果页；其他客户端返回浏览器安全 JSON（见下文契约）。
7. **审核历史** `GET /admin/review/history` — 读取 `decisions/reviews/*`，展示操作含义、来源、目标、状态与日期。

项目经验额外受项目身份门禁约束：已绑定草稿只能写入
`projects/<project_id>/` 下与 frontmatter 一致的目录；晋升到全局
`knowledge/` 或 `runbooks/` 时删除活动绑定字段，但必须保留
`source_project_ids` 作为来源追踪。

## HTML 结果页面

确认执行的回执是中文审计回执，只包含固定九字段：

| 字段 | 含义 |
| --- | --- |
| `ok` | 执行是否成功 |
| `code` | 稳定结果码（成功为 `ok`；执行失败为 `review_error`；门禁失败为对应门禁码） |
| `message` | 固定中文说明 |
| `source` | 来源 inbox 草稿 slug |
| `action` | 执行的动作（keep/promote/merge/reject/needs_evidence/repair/cleanup） |
| `target` | 目标页 slug（无目标动作与门禁失败时为 `null`） |
| `review_slug` | 审核记录页 slug（门禁失败时为 `null`） |
| `retrieval_verified` | 目标页检索验证是否通过 |
| `next_action` | 中文下一步提示 |

检索验证或审核记录写入失败时，文案明确说明 **inbox 草稿已保留，需要修复后重试**（建议使用「修复审核记录」）；草稿在验证或审核记录写入失败时不会被删除。

## 端点契约

### `GET /admin/api/review/inbox`

返回 inbox 草稿列表（浏览器安全投影）：`{ drafts: [{ slug, type, title, verification, status, updated_at, stale, project_id? }] }`。`project_id` 仅在草稿具有该值时返回，并与其他动态字段一样先经过共享脱敏器。查询参数：`type`、`verification`、`stale`、`project_id`。

### `GET /admin/api/review/inbox/<slug>`

返回单个草稿的浏览器安全详情：列表字段 + 允许清单内的 frontmatter 元数据（`date`、`status`、`sensitivity`、`verification`、`applicability`、`non_applicable`、`review_action`）、证据引用计数、摘要（证据充分性/敏感内容状态/重复状态/建议下一步）、脱敏内容预览与时间线预览（最长 2000 字符）。404：`{ error: 'not_found' }`。

### `GET /admin/api/review/targets`

只读目标搜索：`?q=<可选>&type=<可选>&limit=<1-50>`，返回 `{ targets: [{ slug, type, title, updated_at }] }`。内部绑定服务端审核来源；忽略客户端提交的 `source_id`；不返回正文、frontmatter、source refs 或异常细节。

### `POST /admin/api/review/plan`

预检规划。请求体（JSON 或 URL-encoded）：`kind`/`action`、`sourceSlug`、`targetSlug`/`target`、`targetType`/`target_type`、可选 `reviewNotes`。`reject` 与 `needs_evidence` 的 `reviewNotes` 必须是非空文本；缺失或仅空白时在调用 `planReview` 前返回 400。响应为浏览器安全计划：`{ ok, code, message, gates: [{ code, ok, message }], plan?: { action, source, target: { slug, type } | null } }`，不含门禁 `details`/`candidates`、执行 `steps`、`review_slug` 或原始 action payload。

### `POST /admin/api/review/confirm`

确认执行。请求体同 plan，外加 `confirmation`（promote/merge 必填）。`reject` 与 `needs_evidence` 再次要求非空 `reviewNotes`，确保预检之后不能绕过说明门禁。响应为固定九字段回执（见上表），状态码：

| 状态码 | 场景 |
| --- | --- |
| 200 | 执行成功 |
| 400 | 参数无效（`invalid_request`）或确认短语缺失/错误（`confirmation_required`） |
| 403 | Origin 校验失败（`forbidden`） |
| 409 | 门禁未通过（回执 `code` 为门禁码，`review_slug` 为 `null`） |
| 503 | 执行失败（回执 `code` 为 `review_error`）或内部错误（`{ error: 'review_error', message }`） |

JSON 与 URL-encoded 解析错误返回 400 `{ error: 'review_error', message: '审核操作失败，请查看服务端日志。' }`，不含异常细节。

### `GET /admin/api/review/history`

返回审核记录列表：`{ reviews: [{ slug, action, action_label, source, target, status, date, updated_at }] }`。`action_label` 为动作的中文含义；`source` 为被审核的 inbox 草稿 slug；`target` 为目标页 slug（无目标动作为 `null`）。不返回 `source_refs`、标题正文或任何敏感字段。

## Origin/CSRF 规则

- 每个 `/admin/api/review/*` POST（plan、confirm）在请求体解析**之前**执行严格同源 `Origin` 校验。
- 期望来源 `expectedAdminOrigin` 取自显式 `GBRAIN_ADMIN_ORIGIN`，未设置时回退到 `issuerUrl.origin`，**绝不**从 `Host` 或 `X-Forwarded-*` 请求头推导；伪造这些头不会改变期望来源。
- 以下情况一律返回固定 403（JSON `{ error: 'forbidden', message: '请求来源不被允许。' }`；`Accept: text/html` 客户端得到同文案 HTML 页）：缺失 `Origin`、`Origin: null`、畸形 Origin、多个 Origin（逗号连接）、与期望来源不匹配（含尾部斜杠等任何非精确相等的形式）。
- 校验失败的请求不会到达 `planReview`、writer 会话或 delete 路径。

## 确认规则

- `promote` → 必须精确输入 `PROMOTE <target-slug>`。
- `merge` → 必须精确输入 `MERGE <target-slug>`。
- Web 提交的 `keep` 若目标类型为 `knowledge` 或 `runbook`，会在适配层归一化为 `promote`，同样需要精确的 `PROMOTE <target-slug>`；直接 API 调用同样受此约束。
- 确认短语不自动填充、不本地化；CLI 与 Web 契约一致。

## 浏览器安全 JSON 契约

- 预检 JSON 只包含动作、来源、目标和固定门禁字段；确认结果 JSON 只包含固定九字段（见上表）。两者均不包含门禁 `details`、`candidates`、执行 `steps`、`review_slug`、`expected`、原始 action payload、原始 receipts、writer 回执/错误或异常文本。
- writer 返回的结构化错误与抛出的异常都映射为稳定 `review_error` 加固定中文文案；任何动态字段在渲染前都经过共享浏览器安全脱敏器（令牌、私钥、PII、原始转录、原始 JSON/认证响应、原始环境变量、密集日志一律隐藏或脱敏）。
- 所有 HTML 动态文本与属性先脱敏再 HTML 转义；URL 路径段使用 `encodeURIComponent`；不通过 `innerHTML` 注入审核数据。
