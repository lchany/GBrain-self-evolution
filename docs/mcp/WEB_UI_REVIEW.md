# GBrain 经验审核界面

GBrain 的默认人工审核只做一件事：确定 inbox 草稿的最终分类。

## 审核者看到什么

打开 `/admin/review`，选择一条草稿进入详情页。详情页展示：

- 脱敏后的中文摘要、适用场景和验证状态；
- 大模型推荐的分类、使用场景和推荐理由；
- 一个分类下拉框；
- 一个确认按钮。

分类只有五项：

- `project`：项目经验
- `knowledge`：通用知识
- `runbook`：操作手册
- `incident`：故障经验
- `reject`：拒绝并删除

系统会预选模型建议。审核者同意时直接确认；不同意时修改下拉框后确认。
选择“拒绝并删除”后，按钮显示“确认并删除”。审核者不需要填写 slug、审核说明、
目标目录、确认短语，也不需要操作预检或门禁页面。

## 模型建议

新草稿应在采集时写入以下 frontmatter：

```yaml
review_recommendation:
  category: project
  scenario: 设计或修改当前项目的经验审核流程。
  reason: 这条规则只约束当前项目，不适合作为跨项目知识。
  generated_by: model
```

旧草稿缺少该字段时，详情页会自动通过受保护的同源 POST 请求调用服务端配置的
聊天模型。成功结果按 `source_id + slug + content_hash` 缓存在进程内，最多 256 项。
详情页 GET 本身不会调用模型，避免浏览器预取产生费用。

模型未配置、超时或返回非法 JSON 时，页面显示“暂时无法生成模型建议”并禁用确认。
系统不会用规则推断冒充模型结论。

## 确认后的服务端行为

浏览器只提交：

```json
{
  "sourceSlug": "inbox/example",
  "category": "incident"
}
```

服务端拒绝未知字段，重新读取最新草稿，自行生成目标 slug 和内部审核动作，然后复用
`planReview` 与 `applyReviewPlan` 完成内容检查、重复检查、写入、回读验证和审核记录。
分类只决定归档位置，不改变草稿原有的 `verification`。

“拒绝并删除”先写审核记录，再调用 writer 的 `delete_page`。该操作是软删除，遵循现有
72 小时恢复窗口。任何写入或验证失败都会保留 inbox 草稿。

## 安全边界

- 所有页面和接口都要求管理员认证。
- 两个新 POST 接口执行严格同源校验。
- 模型只接收浏览器安全投影，不接收原始 frontmatter、认证材料或密集日志。
- 推荐文本进入浏览器前再次脱敏并转义。
- writer URL 校验、source attestation 和服务端写入顺序保持不变。
- `review_recommendation` 只用于审核界面，不复制到最终知识页。

## 兼容接口

`/admin/api/review/plan`、`/admin/api/review/confirm` 和旧预检 HTML 路由暂时保留，
供已有集成兼容使用；默认审核页面不再链接这些入口。
