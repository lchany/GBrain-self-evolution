# GBrain 项目自动匹配改为 MCP 执行

## 状态

- 日期：2026-07-30
- 状态：已实施并完成本机验证；远端服务待部署
- 适用范围：客户端项目检测、MCP 项目候选匹配、本地绑定

## 结论

项目候选匹配必须通过已连接的 GBrain MCP 执行，不能依赖本地 writer
凭据。客户端 CLI 只读取本地工作目录和 Git 信息，并在用户确认候选后写入
`.gbrain-project.yaml`。服务端 MCP 读取当前 Brain 和 Source 中的项目登记页，
按照统一规则返回候选。

这条边界符合数据归属：

- 客户端知道当前目录、Git remote 和项目根目录；
- 服务端知道项目登记页以及调用方可读取的 Source；
- 用户决定候选是否代表当前业务项目；
- 服务端在后续写入和晋升时再次验证项目登记页。

## 问题与根因

当前 `gbrain project match --json` 是只读命令，却复用了
`createLocalWriterToolCaller()`。默认调用因此要求
`~/.config/gbrain/local-writer.env` 中存在本地 writer 凭据。

客户端规则同时要求：

- 只通过已连接的 GBrain MCP 读写；
- 不安装本地 GBrain CLI 凭据；
- 未绑定项目运行 `gbrain project match --json`。

这三个行为不能同时成立。无本地 writer 凭据时，CLI 在读取任何项目登记页
前就会失败。即使 Agent 已经连接远程 MCP，CLI 进程也无法复用 Agent 持有的
MCP 会话。

现有绑定命令还有第二个断点：`gbrain project bind` 会再次通过本地 writer
连接读取登记页。因此，单独把候选搜索移到 MCP 后，确认候选仍然无法完成
本地绑定。

## 目标

- 无本地 writer 凭据的客户端可以通过已连接 MCP 自动查找项目候选。
- Git remote 只在客户端读取并规范化，不把本地路径发送给服务端。
- 服务端统一执行项目登记页分页、读取、校验和匹配。
- 唯一候选仍然需要人工确认。
- 确认后写本地标记不需要网络凭据。
- 未匹配、多候选、缺少确认和登记页失效时保持失败关闭。
- 保持 Brain 和 Source 路由边界，不跨越调用方的 Source 读取权限。

## 非目标

- 不让 MCP 读取客户端文件系统或 Git 配置。
- 不在没有候选时静默创建项目 ID 或项目登记页。
- 不把本地 writer 凭据作为降级方案。
- 不给匿名客户端开放项目晋升或管理员能力。
- 不为本地绑定引入离线队列、生命周期钩子或常驻进程。
- 不在本次修复中改变项目登记页和项目经验的持久化模型。

## 端到端流程

```text
Agent
  │
  ├─ 1. gbrain project current --json
  │      └─ 已绑定：通过 MCP get_page 验证登记页
  │
  └─ 2. 未绑定：gbrain project match --json
         └─ CLI 返回规范化 repository_ref、project_name 和 MCP 调用参数
                    │
                    ▼
             MCP match_project
                    │
                    ├─ 精确仓库候选
                    ├─ 名称或别名候选
                    └─ 无候选
                    │
                    ▼
              展示候选及依据
                    │
                    ▼
                用户确认
                    │
                    ▼
     gbrain project bind <project_id> --confirmed --json
                    │
                    └─ 原子写入 .gbrain-project.yaml
```

## CLI 契约

### `gbrain project current`

继续只读本地标记，不访问网络。

- 已绑定时返回 `project_id` 和标记路径；
- 未绑定时返回 `project_unbound`；
- Agent 取得已绑定 ID 后，必须通过 MCP `get_page` 验证
  `projects/<project_id>/index`。

### `gbrain project match`

改为本地上下文采集和 MCP 交接，不再直接查询项目登记页。JSON 输出示例：

```json
{
  "ok": true,
  "status": "mcp_required",
  "code": "project_match_via_mcp",
  "tool": "match_project",
  "arguments": {
    "repository_ref": "github.com/acme-example/agent-platform",
    "project_name": "agent-platform"
  }
}
```

规则：

- 从当前 Git 工作区读取 `remote.origin.url`；
- 使用现有 `normalizeRepositoryRef()` 去除协议、用户名和 `.git`；
- `project_name` 使用 Git 工作区根目录名的小写形式；
- 不返回绝对路径；
- 没有 Git remote 时省略 `repository_ref`，仍可用项目名称生成弱候选；
- 已绑定时直接返回当前绑定，不生成 MCP 交接；
- 不读取本地 writer 环境文件，不发起网络请求。

保留命令名称可以避免旧客户端出现“未知命令”，但返回状态从候选结果改为
`mcp_required`。客户端规则和 Skill 必须明确继续调用 MCP，不能把交接结果
误认为已经完成匹配。

### `gbrain project bind`

新契约：

```text
gbrain project bind <project_id> --confirmed [--json]
```

规则：

- 缺少 `--confirmed` 时返回 `project_confirmation_required`；
- 校验 `project_id` 格式；
- 不访问网络，不读取本地 writer 凭据；
- 使用现有原子写入函数创建 `.gbrain-project.yaml`；
- 已绑定同一 ID 时保持幂等；
- 已绑定其他 ID 或已有无效标记时拒绝覆盖。

`--confirmed` 表示调用方已经展示 MCP 候选并获得用户明确确认。CLI 不是安全
边界：本地用户本来就能直接编辑标记文件。服务端仍在后续 `put_page` 和审核
晋升时校验项目登记页，不能因为存在本地标记而信任项目归属。

### `gbrain project init`

保持为可信本地管理员流程，不进入客户端自动匹配路径。普通客户端无候选时
维持 `project_binding: pending`，由管理员流程创建项目登记页；客户端不得
索取 writer 凭据或静默创建 ID。

## MCP `match_project` 契约

新增 read scope、非 mutating 的 MCP 操作：

```json
{
  "repository_ref": "github.com/acme-example/agent-platform",
  "project_name": "agent-platform"
}
```

至少提供一个字段。服务端重新规范化 `repository_ref`，拒绝不支持的协议、
带密码、查询参数、片段或路径穿越形式。`project_name` 去除首尾空白并按
不区分大小写匹配。

响应示例：

```json
{
  "ok": true,
  "status": "confirmation_required",
  "code": "project_match_confirmation_required",
  "candidates": [
    {
      "project_id": "prj-a81f0c4263d94217",
      "project_name": "acme-example agent platform",
      "registry_slug": "projects/prj-a81f0c4263d94217/index",
      "match_reason": "repository_ref"
    }
  ]
}
```

无候选时返回：

```json
{
  "ok": true,
  "status": "unmatched",
  "code": "project_match_not_found",
  "candidates": []
}
```

服务端按以下顺序匹配：

1. 分页列出调用方当前 Source 范围内 `projects/*/index`；
2. 读取页面并只保留合法 `project-registry`；
3. 优先返回 `repository_refs` 精确匹配的候选；
4. 没有仓库候选时，再按 `project_name` 和 `project_aliases` 匹配；
5. 按 `project_id` 去重并使用稳定顺序返回。

仓库精确匹配和名称弱匹配不混合。这样可以避免存在仓库精确候选时，名称
相同的其他项目制造无意义歧义。

所有登记页读取必须带上 `sourceScopeOpts(ctx)`。远程调用者只能看见授权
Source 中的候选，不能通过项目名称或仓库引用枚举其他 Source。

## 客户端规则和 Skill

安装器生成的 `AGENTS.md` 管理块与 `gbrain-capture` 必须使用同一流程：

1. 运行 `gbrain project current --json`；
2. 已绑定时，用 MCP `get_page` 验证登记页；
3. 未绑定时运行 `gbrain project match --json`，取得 MCP 参数；
4. 调用已连接 MCP 的 `match_project`；
5. 完整展示候选 ID、名称和匹配依据；
6. 即使只有一个候选也等待用户确认；
7. 用户确认后运行 `gbrain project bind <id> --confirmed --json`；
8. 无候选、多候选未选择或登记页失效时保持
   `project_binding: pending`，不得猜测。

面向用户的提示和错误说明使用中文。命令、错误码和 MCP 字段保留英文。

## 错误处理

稳定错误码：

- `project_match_via_mcp`：CLI 已生成 MCP 交接参数；
- `project_match_not_found`：MCP 没有找到候选；
- `project_match_confirmation_required`：存在候选，必须人工确认；
- `project_confirmation_required`：本地绑定缺少明确确认参数；
- `repository_ref_invalid`：仓库引用无法安全规范化；
- `project_match_input_required`：MCP 没有收到可用匹配信号；
- `project_registry_not_found`：确认前或后续验证时登记页不存在；
- `project_binding_conflict`：本地目录已经绑定其他项目。

错误响应不得包含凭据、环境变量、未经脱敏的远程 URL 或不必要的绝对路径。

## 测试策略

实现遵循 TDD，先提交能在旧实现上失败的行为测试。

### 核心匹配测试

- 仓库 URL 重新规范化；
- 精确仓库匹配优先于名称匹配；
- 无仓库候选时按名称或别名匹配；
- 多候选全部返回但不自动选择；
- 非登记页、ID 与 slug 不一致的登记页被忽略；
- 结果按项目 ID 去重并稳定排序；
- Source 范围传递到 `listPages` 和 `getPage`。

### CLI 测试

- `project match` 不调用 `createLocalWriterToolCaller` 路径；
- `project match` 只返回脱敏后的 MCP 交接参数；
- 无 Git remote 时仍返回名称参数；
- `project bind` 缺少 `--confirmed` 时不写文件；
- 确认后绑定不调用 MCP 或本地 writer；
- 同一 ID 重复绑定幂等，冲突 ID 拒绝覆盖。

### MCP 和安装器测试

- `match_project` 暴露为 read scope、非 mutating 工具；
- MCP 参数校验拒绝空输入和非法仓库引用；
- Codex 和 OpenCode 规则都要求 MCP 匹配和人工确认；
- `gbrain-capture` 不再把 CLI `match` 描述为候选查询完成态；
- 生成内容不要求本地 writer 凭据；
- 安装器重复运行保持幂等。

## 本机同步与验证

代码和测试通过后运行：

```bash
bun src/cli.ts install-client --json
```

同步后检查本机 Codex 和 OpenCode 管理块以及两个 GBrain Skills。验证内容：

- 本机规则包含 MCP `match_project`；
- 本机规则不要求本地 writer 凭据；
- `gbrain project match --json` 在无凭据环境中成功生成交接参数；
- `gbrain project bind` 在缺少确认时拒绝写入；
- 确认后生成的 `.gbrain-project.yaml` 可被 `project current` 读取。

远端服务只有部署包含 `match_project` 的新版本后，才能完成真实 MCP
端到端验证。本地代码、单元测试和安装器同步成功不等于远端服务已经具备
该工具。

## 方案取舍

### 采用：MCP 匹配，确认后本地绑定

该方案不分发凭据，保持 Source 权限边界，改动集中在操作层、CLI 交接和
客户端规则。服务端后续写入门禁继续提供最终一致性校验。

### 不采用：CLI 直接连接远端 MCP

CLI 无法复用 Agent 当前的 MCP 会话。为 CLI 单独配置令牌会重新引入本地
凭据，违反客户端规则。

### 不采用：签名绑定回执

服务端可为候选签名，再由 CLI 验证回执，但这需要密钥分发、过期和重放
语义。CLI 不是安全边界，服务端又会在写入时重新校验登记页，因此当前收益
不足以覆盖复杂度。

### 不采用：Agent 直接写标记文件

直接写文件可以工作，但会复制 ID 校验、原子写入、冲突处理和幂等逻辑。
保留本地 `bind --confirmed` 能让不同 Agent 使用同一实现。

## 验收标准

- 没有 `~/.config/gbrain/local-writer.env` 时，CLI 项目检测不再失败；
- 候选搜索确实由已连接 MCP 的 `match_project` 执行；
- MCP 只返回调用方 Source 范围内的合法项目登记页；
- 唯一候选不会自动绑定；
- 未确认时本地标记保持不存在；
- 确认后绑定不需要网络凭据；
- 无候选时不创建项目 ID；
- 本机生成规则与仓库生成源一致；
- 目标测试、类型检查、代码复审和仓库交付门禁全部通过。
