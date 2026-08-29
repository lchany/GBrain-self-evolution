# 项目经验写入硬绑定：TDD 证据

日期：2026-07-31

## 行为目标

远程 `put_page` 只接受已经绑定规范项目 ID、且当前写入 source 中存在一致
项目登记页的项目经验。未绑定项目候选必须在发起 MCP 写入前停止。

## RED

命令：

```bash
bun test test/put-page-validation.test.ts test/gbrain-capture.test.ts
```

旧实现结果：25 项通过，6 项失败。失败覆盖：

- 待绑定项目经验仍可进入 inbox；
- 非项目类型仍可声明 `record_kind: project-experience`；
- inbox 项目经验未校验登记页不存在或身份不一致；
- 未绑定项目候选仍可继续生成；
- 非项目候选仍可携带项目 ID。

客户端规则与 MCP schema 的契约测试也先在旧文案上失败：

```bash
bun test test/gbrain-client-installer.test.ts \
  test/mcp-discovery.test.ts \
  test/put-page-validation.test.ts
```

结果：29 项通过，2 项失败。失败原因分别是安装器尚未声明“未绑定不得调用
`put_page`”，以及 MCP 页面 schema 尚未声明项目经验写入前必须绑定。

## GREEN

实现后运行核心行为测试：

```bash
bun test test/put-page-validation.test.ts test/gbrain-capture.test.ts
```

结果：31 项通过，0 项失败。

更新客户端规则、MCP schema 和 source 隔离断言后运行：

```bash
bun test test/gbrain-client-installer.test.ts \
  test/mcp-discovery.test.ts \
  test/put-page-validation.test.ts
```

结果：31 项通过，0 项失败。

## 关键断言

- `project_binding: pending` 的项目经验返回
  `project_binding_required`；
- `record_kind: project-experience` 必须配合 `type: project`；
- 规范项目 ID 对应的登记页不存在或身份不一致时返回
  `project_registry_not_found`；
- 登记页只在当前写入 source 中查询；
- 只有精确的 `projects/<project_id>/index` 会被识别为登记页，嵌套的
  `.../index` 项目经验仍必须执行登记页查询；
- 未绑定结构化项目候选在调用任何 writer/MCP 接口前失败；
- 普通非项目 inbox 草稿保持原有行为。

## 尚未覆盖

- 真实 Postgres HTTP MCP 传输的端到端写入成功路径由部署验收覆盖；
- 既有待绑定草稿不迁移、不删除，本次只验证其后续更新会被新门禁拒绝。
