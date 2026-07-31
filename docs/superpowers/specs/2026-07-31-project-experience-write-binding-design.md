# 项目经验写入硬绑定设计

日期：2026-07-31  
状态：已批准并实现

## 结论

远程 MCP 客户端写入 `record_kind: project-experience` 时，服务端必须在
`put_page` 阶段要求规范项目 ID、已绑定状态和有效项目登记页。未绑定项目
经验不得进入 `inbox/`。

这项规则只收紧项目经验。普通 `knowledge`、`runbook` 和 `incident` 草稿
继续使用现有 inbox 校验。

## 问题

当前客户端规则要求项目经验写入前完成硬绑定，但服务端仍接受：

```yaml
type: project
record_kind: project-experience
project_binding: pending
project_id: null
```

服务端只在审核阶段阻止这类草稿晋升。远程客户端因此可以绕过客户端规则，
先写入无项目归属的项目经验。

现有登记页校验也跳过 `inbox/`。即使 inbox 项目经验提供了格式正确的
`project_id`，服务端也不会在写入时确认 `projects/<project_id>/index`
存在。

## 已考虑方案

### 方案一：只依赖客户端规则

客户端在调用 `put_page` 前检查本地标记。服务端不变。

该方案无法约束旧客户端、第三方客户端或手工 MCP 调用。客户端规则不是安全
边界，不采用。

### 方案二：允许待绑定写入，在审核阶段阻止

该方案维持当前行为。它支持先采集后绑定，但会积累没有项目归属的项目经验，
并且与“写入前必须硬绑定”的用户规则冲突，不采用。

### 方案三：在服务端写入阶段强制硬绑定

远程 `put_page` 在持久化前验证绑定字段、项目 ID 和登记页。客户端仍负责
匹配与人工确认，服务端负责最终拒绝不合规写入。

采用此方案。

## 服务端校验

### 项目经验识别

满足任一条件时，服务端把页面视为项目经验候选：

- `type: project`；
- `record_kind: project-experience`。

两者必须最终同时成立。`type: project` 缺少正确 `record_kind` 时返回
`record_kind_required`；其他类型不得声明 `record_kind: project-experience`。

### 必填条件

项目经验写入 `inbox/` 时必须同时满足：

```yaml
type: project
record_kind: project-experience
project_binding: bound
project_id: prj-0123456789abcdef
```

`project_id` 必须匹配：

```text
^prj-[0-9a-f]{16}$
```

以下输入直接拒绝：

- `project_binding: pending`；
- `project_id: null`；
- 缺少 `project_binding` 或 `project_id`；
- 项目 ID 格式错误；
- 绑定状态和项目 ID 不一致。

错误使用稳定代码 `project_binding_required` 或 `project_id_invalid`，并提示
客户端先执行项目匹配、人工确认和本地绑定。

### 项目登记页

格式校验通过后，`put_page` 在当前写入 source 中读取：

```text
projects/<project_id>/index
```

登记页必须满足：

- 页面存在；
- `record_kind: project-registry`；
- frontmatter `project_id` 与请求中的项目 ID 一致。

任一条件不满足时返回 `project_registry_not_found`，不执行页面写入、分块、
写穿或自动链接。

登记页校验同时覆盖 inbox 项目经验和 `projects/<project_id>/` 下的项目经验，
不再因 slug 以 `inbox/` 开头而跳过。

## 客户端行为

客户端流程保持为：

1. 运行 `gbrain project current --json`。
2. 未绑定时生成脱敏匹配参数。
3. 通过已连接 MCP 调用 `match_project`。
4. 展示全部候选，即使只有一个也等待用户确认。
5. 用户确认后运行
   `gbrain project bind <project_id> --confirmed --json`。
6. 重新读取当前绑定，并通过 MCP 读取项目登记页。
7. 只有以上步骤全部通过后才展示项目经验写入审核正文和调用 `put_page`。

无候选或多候选未确认时，客户端可以保留内存中的候选正文，但不得调用
`put_page`，不得创建本地离线队列。

生成的客户端规则和 `gbrain-capture` 技能必须明确说明：`pending` 只表示
尚未完成的候选状态，不是允许写入 inbox 的项目经验状态。

## 既有数据

本次改动不删除、不迁移、不自动修改已有待绑定项目草稿。

新校验生效后：

- 新建待绑定项目经验会被拒绝；
- 更新已有待绑定项目经验也会被拒绝；
- 已有页面仍可只读检查；
- 后续保留、退回或拒绝由人工审核决定。

页面 ID 不能替代项目 ID。

## 测试

### 校验单元测试

- 拒绝 inbox 中 `type: project` 与 `project_binding: pending`。
- 拒绝 inbox 中项目经验的 `project_id: null`。
- 拒绝格式错误的项目 ID。
- 拒绝非 project 类型声明 `record_kind: project-experience`。
- 接受绑定规范 ID 的项目经验格式。
- 保持普通非项目 inbox 草稿的现有行为。

### 操作集成测试

- 登记页不存在时，`put_page` 返回 `project_registry_not_found`。
- 登记页类型错误或 ID 不一致时拒绝写入。
- 登记页有效时允许项目经验写入。
- 校验失败时不调用页面写入方法。
- 登记页查询使用当前写入 source，不跨 source 猜测。

### 客户端测试

- 未绑定项目经验不会进入 MCP 写入流程。
- 安装器生成的规则要求先匹配、确认、绑定和验证登记页。
- 已绑定项目经验继续生成 `bound` 和规范 `project_id`。

## 文档同步

实现时更新以下当前状态文档：

- `docs/superpowers/specs/2026-07-30-gbrain-project-identity-design.md`；
- `docs/superpowers/specs/2026-07-30-mcp-project-matching-design.md`；
- `docs/architecture/KEY_FILES.md`；
- MCP 页面 schema；
- 客户端安装规则和 `gbrain-capture` 技能模板。

旧设计中“未绑定项目草稿可以进入 inbox”的描述必须删除，避免继续产生两套
互相冲突的规则。

## 部署与验收

本次改动不需要数据库迁移。

验收顺序：

1. 运行项目身份、捕获、MCP 操作和客户端安装相关测试。
2. 运行类型检查和静态门禁。
3. 构建服务端二进制。
4. 部署并重启 MCP 服务。
5. 通过公网 MCP 验证未绑定项目经验被拒绝。
6. 验证普通非项目 inbox 草稿仍可按原规则写入。
