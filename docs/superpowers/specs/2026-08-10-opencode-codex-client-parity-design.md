# OpenCode 与 Codex 客户端能力对齐设计

日期：2026-08-10
状态：已批准，待实施

## 目标

`gbrain install-client` 默认同时为 OpenCode 和 Codex 安装以下能力：

- 用户级 GBrain 规则；
- `gbrain-capture` 与 `gbrain-review` skills；
- 当前目录项目身份检查与 bootstrap 协调；
- 独立经验收尾、结构化 receipt 校验和有界 fail-open。

`--no-experience-hook` 只关闭两端的经验收尾能力。两端仍保留项目身份检查。

## 约束

- Hook 和插件不调用 MCP，不写 GBrain，不读取 transcript。
- 本地状态只保存哈希、布尔值、时间戳、合法项目 ID、creation key 和合法 `inbox/` slug。
- OpenCode 与 Codex 使用独立状态目录，避免两个客户端的 session ID 或 turn ID 发生碰撞。
- 安装器保留用户已有的 Codex Hook 配置和 OpenCode 插件，不覆盖非 GBrain 管理的内容。
- OpenCode 没有与 Codex `Stop` block 等价的插件 Hook。OpenCode 在 `session.idle` 后通过 `promptAsync` 续跑收尾，因此用户可能先看到一次阶段性答复。

## 方案

Codex 继续直接执行现有 Python 项目检查和经验守卫。OpenCode 安装薄 TypeScript 插件，把客户端事件转换为 Python 守卫已接受的事件格式。

该方案让两端共享项目 marker 校验、bootstrap lease、文件权限检查、并发锁、经验分类、receipt 验证和 fail-open 规则。OpenCode 插件只负责事件转换、上下文注入和会话续跑。

## 安装布局

Codex 保持现有布局：

```text
~/.codex/AGENTS.md
~/.codex/skills/gbrain-capture/SKILL.md
~/.codex/skills/gbrain-review/SKILL.md
~/.codex/hooks/gbrain-project-check.py
~/.codex/hooks/gbrain-experience-guard.py
~/.codex/hooks.json
```

OpenCode 增加一个项目与经验适配器：

```text
~/.config/opencode/AGENTS.md
~/.config/opencode/skills/gbrain-capture/SKILL.md
~/.config/opencode/skills/gbrain-review/SKILL.md
~/.config/opencode/hooks/gbrain-project-check.py
~/.config/opencode/hooks/gbrain-experience-guard.py
~/.config/opencode/plugins/gbrain-experience-guard.ts
```

OpenCode 插件同时负责项目身份和经验事件适配。`--no-experience-hook` 会把插件中的经验路径设为禁用并删除经验脚本，同时保留该插件和项目脚本，因此项目检查仍会运行。

## OpenCode 项目身份流程

1. 项目插件在每个 session 的首个 `chat.message` 运行一次项目检查脚本。
2. 插件使用 OpenCode 提供的 session ID 和当前 `directory` 构造 `SessionStart` 事件。
3. 脚本检查 `directory` 直接目录中的 `.gbrain-project.yaml` 和 `.gbrain/project.yaml`。
4. 插件把脚本返回的 `additionalContext` 追加到当前用户消息，使 Agent 在首次推理前看到项目状态或 bootstrap 指令。
5. 插件按 session 记录已检查状态，后续消息不重复注入。插件重载或新 session 会重新检查。

项目 bootstrap worker、creation-key lease 和 `complete-bootstrap` 继续由现有 Python 实现管理。OpenCode 脚本位于自身配置目录，因此 lease 状态写入 OpenCode 自己的 `gbrain-project-bootstrap` 目录。

## OpenCode 经验收尾流程

### 用户消息

`chat.message` 把用户文本转换为 `UserPromptSubmit` 事件。Python 守卫判断任务是否非平凡，并在需要时返回一次性 worker token。插件把返回的 `additionalContext` 追加到当前消息。

### 工具完成

`tool.execute.after` 把工具名、参数、输出元数据和 call ID 转换为 `PostToolUse` 事件。Python 守卫只落盘最小化证据。若该事件首次触发收尾要求，插件缓存返回的上下文，并在下一次 `experimental.chat.system.transform` 中注入，然后立即清除缓存。

### Session idle

`session.idle` 转换为 `Stop` 事件。有效 receipt 使守卫返回空结果。缺少或无效 receipt 时，守卫返回 block 原因；OpenCode 插件通过 `client.session.promptAsync` 把该原因发送给同一 session，要求 Agent 继续派发或等待独立收尾 worker。守卫最多续跑两次，之后按现有规则 fail-open。

### Worker 隔离

独立 worker 的首个消息包含 `GBRAIN_EXPERIENCE_CLOSEOUT_WORKER_TOKEN`。Python 守卫识别该 token，并把 worker 的工具证据关联到父 session 的收尾状态。Worker 不再派生同类 worker。

## 事件映射

| OpenCode 入口 | Python 事件 | 用途 |
|---|---|---|
| session 首个 `chat.message` | `SessionStart` | 项目 marker 检查与 bootstrap 上下文 |
| `chat.message` | `UserPromptSubmit` | 非平凡任务识别与 token 预发 |
| `tool.execute.after` | `PostToolUse` | 写操作、关键命令、失败和 MCP receipt 证据 |
| `session.idle` | `Stop` | receipt 校验、续跑或 fail-open |

## 状态隔离

OpenCode 启动经验脚本时设置：

```text
GBRAIN_EXPERIENCE_HOOK_STATE_DIR=~/.config/opencode/gbrain-experience-guard
```

Codex 保持默认目录：

```text
~/.codex/gbrain-experience-guard
```

两个目录沿用现有所有者、文件类型、符号链接和权限检查。

## 错误处理

- Python 子进程超时、退出非零、输出非法 JSON 或插件事件字段缺失时，OpenCode 会话继续。
- 项目检查失败时，插件向当前消息追加项目检查警告。
- 经验事件失败时，插件缓存一条经验守卫警告，并在下一次模型调用或 idle 续跑中交给 Agent。
- 插件不把原始 prompt、工具参数或输出写入日志或状态文件。
- 插件销毁时清理内存中的 session 检查标记和待注入上下文。

## 安装器输出

`--json` 的 `surfaces` 同时报告两端的项目守卫和经验守卫：

- `name`；
- rules 路径；
- skills 列表；
- 项目脚本、适配器或配置路径；
- 经验脚本、适配器和模式；
- 经验 Hook 是否启用。

人类可读输出明确说明 OpenCode 与 Codex 均已安装，不再只提示 Codex `/hooks`。

## 测试

### 安装器

- 连续安装两次不会重复规则或 GBrain 管理项；
- 两端 rules、skills、脚本和适配器落在各自配置目录；
- 文件权限符合现有约束；
- `--no-experience-hook` 删除两端经验脚本并禁用经验事件，但保留两端项目检查；
- JSON summary 同时描述 OpenCode 和 Codex。

### OpenCode 插件

- 首个消息注入已绑定、仓库 ID 和未绑定 bootstrap 三种项目结果；
- 同一 session 后续消息不重复项目检查；
- 非平凡 prompt 在首次推理前得到 closeout token；
- 工具事件产生的收尾上下文在下一次模型调用前注入一次；
- 有效 worker receipt 使 idle 直接结束；
- 缺失 receipt 使 idle 对同一 session 发起续跑；
- 子进程失败时会话 fail-open，并得到不含敏感输入的警告。

### Codex 回归

现有项目 Hook、并发 creation-key、隔离 worker、receipt 和 Stop block 测试保持通过。

## 手工验收

1. 在隔离 HOME 中运行 `gbrain install-client --json`，检查两端安装清单。
2. 启动 OpenCode，创建一个未绑定目录的 session，确认首次消息收到 bootstrap 指令。
3. 在 OpenCode 执行一个非平凡任务，确认经验 token、独立 worker、receipt 和 idle 放行或续跑。
4. 启动 Codex，运行 `/hooks` 并在相同两类场景下确认现有行为未回归。
5. 使用 `--no-experience-hook` 重装，确认两端项目检查仍运行，经验收尾不再运行。

## 不在范围内

- 不修改 MCP 权限、认证或网络白名单策略。
- 不让插件直接调用 GBrain MCP。
- 不统一 OpenCode 与 Codex 的配置文件格式。
- 不为 OpenCode 模拟同步的 `Stop` block；平台只提供 idle 后续跑能力。
