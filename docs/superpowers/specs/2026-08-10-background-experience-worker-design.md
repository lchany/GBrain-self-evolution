# 后台经验 Worker 与主 Agent 上下文隔离设计

日期：2026-08-10  
状态：已获用户确认，待实现

## 决策

GBrain 的经验召回和经验写入必须由独立子 Agent 执行。主 Agent 不读取召回原文、
去重过程、草稿正文、服务器校验详情或重试日志，只接收固定大小的结构化结果。

“后台”表示执行上下文隔离，不表示 fire-and-forget：

- 任务开始时，主 Agent 等待召回 Worker 返回最小结果，再执行可能受经验影响的工作。
- 任务结束时，主 Agent 等待收尾 Worker 完成写入和回读验证，再输出最终答复。
- Worker 遇到可修复的服务端拒绝时，在自己的上下文中修改并重试；主 Agent 继续等待。

这项规则只覆盖 GBrain 客户端规则定义的经验召回、故障召回、经验去重和 `inbox/`
写入。普通知识查询、用户明确要求查看页面正文、项目身份 bootstrap，以及其他 GBrain
业务操作不自动套用本设计。

## 问题

当前客户端规则存在两个相互冲突的路径：

1. 非平凡任务开始时，规则要求“Agent 先通过 MCP 只读召回”，因此主 Agent 会直接
   接收搜索结果和页面内容。
2. 任务结束时，经验守卫要求主 Agent 派发独立收尾子 Agent，但 receipt 校验依赖父
   session/turn 观察到 `put_page` 和 `get_page` 工具事件。

第二条假设不适用于所有子 Agent runtime。子 Agent 可以在不同 session/turn 中成功写入并
回读页面，但父 Hook 看不到这些工具事件，于是把真实成功判定为“回执证据无效”。重复派发
只会增加上下文和请求成本，不能修复关联边界。

## 方案选择

### 方案 A：仅强化提示词

在安装规则和 skills 中要求主 Agent 委派召回与写入。实现成本最低，但无法发现主 Agent
绕过委派，也无法可靠处理丢失或无效 receipt。

### 方案 B：双阶段 token 与显式 Worker receipt（采用）

守卫分别签发 recall token 和 closeout token。Worker 使用 token 显式登记最终结果；守卫按
token 关联父任务和子任务，不再要求 MCP 工具事件出现在父 session/turn。token 单次使用、
保存哈希并设置有效期。

该方案同时解决跨 runtime 关联和上下文隔离，且不要求 Hook 调用 MCP、读取 transcript 或
保存经验正文。

### 方案 C：所有经验操作改为 GBrain Minion job

Minion 提供持久队列、重试和可观察性，但强制要求 worker 基础设施，并增加短任务延迟。
它适合作为长任务或原生子 Agent 不可用时的后备路径，不作为默认实现。

## 事务模型

### 任务开始：Recall Worker

1. `UserPromptSubmit` 对非平凡任务签发一次性 recall token，并注入
   `GBRAIN_EXPERIENCE_RECALL_REQUIRED`。
2. 主 Agent 派发独立 Recall Worker，只传递完成匹配所需的脱敏任务目标、项目 ID 和 token。
3. Worker 执行 `search|query`，对候选执行 `get_page`，并完成“直接适用 / 部分适用 /
   不适用”分类。
4. Worker 提交显式 recall receipt，再向主 Agent 返回最小结果 envelope。
5. 主 Agent 等待 envelope。只有其中的强制约束或直接适用结论可以进入主上下文；原文和
   检索过程留在 Worker 会话。

Recall Worker 不写 GBrain。没有匹配是正常结果，不触发重试或经验写入。

### 任务结束：Closeout Worker

1. 非平凡任务或符合条件的工具事件签发一次性 closeout token，并注入
   `GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED`。
2. 主 Agent 只传递脱敏后的任务目标、变更、失败、验证证据、项目 ID 和 token。
3. Worker 独立完成召回、`get_page` 去重、候选判断、模板整理、`put_page` 和最终
   `get_page` 验证。
4. 服务端返回可修复错误时，Worker 根据错误修正文档或绑定状态，然后重试同一事务。
5. 回读内容和目标 slug 一致后，Worker 提交 captured receipt，并返回最小结果 envelope。
6. 主 Agent 等待有效 receipt 后再输出最终答复。

Worker 不得在第一次 `put_page` 被拒绝后把中间错误交回主 Agent。它也不得用相同请求进行
无条件循环重试。

## 错误分类与退出条件

Worker 在自身会话中处理以下可恢复错误：

- 固定模板字段或章节不完整；
- `status`、`verification`、`authority`、`instruction_scope` 或 `source_refs` 不合规；
- 项目登记页未精确验证、项目绑定缺失或 slug 不合法；
- 已有页面要求合并或更新，而不是创建重复页面；
- `put_page` 成功但 `get_page` 尚未返回一致内容。

只有以下不可自行消除的情况可以结束为 blocked：

- MCP 权限不足或认证失效；
- 服务持续不可用；
- 项目身份冲突需要用户选择；
- 用户要求与服务端安全策略冲突；
- 达到明确的安全或资源上限。

blocked 只向主 Agent 返回脱敏错误码和建议动作。Worker 不返回服务端原始日志。相同条件下
的原样重试不增加尝试次数；只有修正文档、绑定或请求参数后才允许再次提交。

## 最小结果 Envelope

Recall Worker 只能返回：

```json
{
  "phase": "recall",
  "classification": "direct|partial|none",
  "constraints": ["最多三条直接影响当前任务的脱敏约束"],
  "receipt_status": "accepted|blocked"
}
```

Closeout Worker 只能返回：

```json
{
  "phase": "closeout",
  "outcome": "captured|no_candidate|blocked",
  "slug": "inbox/example-or-null",
  "verified": true,
  "receipt_status": "accepted|blocked",
  "blocker_code": null
}
```

Envelope 不得包含页面正文、搜索结果列表、模板、工具输出、重试轨迹或未脱敏错误。守卫和
客户端适配器对字段集合、字符串长度、数组长度和总字节数设置上限；超限结果按无效 receipt
处理，不注入主 Agent 上下文。

## Receipt 协议

- recall token 与 closeout token 使用不同前缀和状态机，避免阶段混用。
- 本地状态只保存 token 哈希、父 session/turn 的哈希、阶段、时间戳、最终状态和合法 slug。
- token 具有有效期，只能从 pending 进入一个终态；重放、跨阶段使用和终态覆盖均失败。
- Worker 通过显式 receipt 命令完成跨 session/turn 关联。父 Hook 不再以父 turn 内是否出现
  `put_page/get_page` 作为 captured 的必要条件。
- receipt 证明“受委派 Worker 已声明完成”，不是服务端内容的密码学证明。内容真实性仍由
  Worker 的 `put_page` 后 `get_page` 流程和 GBrain 服务端校验保证。
- Hook 不调用 MCP、不读取 transcript、不存储 task prompt、页面正文、命令或工具输出。

## Codex 与 OpenCode

Codex 和 OpenCode 使用同一 Python 守卫状态机，但各自保留独立状态目录。

- Codex 在 `UserPromptSubmit` 注入 recall token，在 `PostToolUse` 预备 closeout token，在
  `Stop` 校验两个阶段的 receipt。
- OpenCode 在 `chat.message` 注入 recall token，在 `tool.execute.after` 预备 closeout token，
  在 `session.idle` 校验 receipt；缺失 receipt 时通过 `promptAsync` 续跑。
- 两端都不得依赖子 Agent runtime 自动转发 Hook 工具事件。Worker 显式提交 receipt 是唯一
  跨 session/turn 完成信号。

若客户端没有子 Agent 能力，守卫返回明确的 delegation-unavailable 阻塞提示。它不得回退为
主 Agent 直接执行经验召回或写入。Minion 后备路径必须由用户配置或明确选择。

## 测试

### 状态机

- 非平凡 prompt 签发 recall token；同一 turn 不重复签发。
- recall 和 closeout token 不能跨阶段使用。
- 子 session/turn 提交的有效 receipt 可以完成父任务。
- token 重放、过期、终态覆盖和非法 slug 被拒绝。
- no-candidate 不要求 `put_page`，captured 要求合法 `inbox/` slug 和 `verified: true`。

### 上下文隔离

- Worker envelope 超出允许字段、条数、长度或总字节数时不进入主上下文。
- Hook 状态文件不出现 prompt、页面正文、搜索结果、工具输入或工具输出。
- 主 Agent 规则不再要求直接调用 MCP 执行经验召回或写入。

### 错误恢复

- 首次 `put_page` 返回模板校验错误时，Worker 修正后重试，并在回读一致后返回 captured。
- 去重冲突更新现有 inbox slug，不创建第二个草稿。
- 权限错误返回 blocked，不原样重试，也不泄露原始响应。

### 客户端一致性

- Codex `Stop` 和 OpenCode `session.idle` 都接受跨 turn Worker receipt。
- 缺失 receipt 时两端保持现有有界 fail-open，且不会指示主 Agent 自行完成经验事务。
- `--no-experience-hook` 同时关闭两端 recall 和 closeout 守卫，不影响项目身份检查。

## 验收标准

1. 一次非平凡任务的主 Agent transcript 中不存在 GBrain 页面正文、召回列表、草稿模板或
   `put_page` 校验日志。
2. Recall Worker 返回前，主 Agent 不执行会受召回约束影响的修改操作。
3. Closeout Worker 遇到一次可恢复服务端拒绝后能在自身会话内修正，并最终写入和回读成功。
4. 子 Agent 与父 Agent 位于不同 session/turn 时，父 Hook 接受有效显式 receipt。
5. 主 Agent 最终只看到本文定义的最小 envelope。
6. 现有项目 bootstrap、隐私、项目 ID 精确匹配和 `inbox/` 服务端校验不回归。

## 不在范围内

- 不把所有 GBrain MCP 查询都迁移到子 Agent。
- 不让 Hook 或客户端插件直接调用 MCP。
- 不在本地状态中保存经验正文或召回结果。
- 不为 receipt 提供服务端密码学证明。
- 不改变 GBrain inbox 的人工晋升流程。
