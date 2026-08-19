# GBrain 客户端规则说明

本文档说明 GBrain 客户端规则块的来源、含义、安装方式和更新语义。它面向需要理解 agent 行为约定、或需要手动维护规则块的用户。

**核心原则**：规则只是约定，不是生命周期钩子。GBrain v1 不依赖 SessionStart、PreToolUse、PostToolUse、PostCompact 或 Stop 钩子来触发 capture/review。所有沉淀都是显式命令、技能或 AGENTS 规则触发的。

---

## 1. 规则块来源

本归档提供两份规则片段：

| 文件 | 用途 | 目标文件 |
| --- | --- | --- |
| `rules/opencode-AGENTS.gbrain.md` | OpenCode 用户级规则片段 | `~/.config/opencode/AGENTS.md` |
| `rules/home-AGENTS.gbrain.md` | 通用用户级规则片段 | `~/.config/opencode/AGENTS.md` 或 `~/.codex/AGENTS.md` |

两份片段的内容基本一致，只是所在文件不同。它们都是归档副本，其中的非回环真实 IP 已被脱敏为占位符。不要反向还原占位符。

---

## 2. 规则含义

规则块在 AGENTS.md 中以 `## GBrain Knowledge Rules` 开头，包含以下子节。

### 2.1 默认查询与双路召回

> GBrain is the default project knowledge and experience system.

GBrain 是默认的项目知识与经验系统。agent 在执行非平凡任务前，应先查询 GBrain。

> Default lookup excludes `inbox/`

默认查询（`search` / `query`）**不包含** `inbox/` 草稿。未审核内容不会污染当前决策。

> Two lanes

查询必须走两条路：

1. 可复用成功经验：`knowledge/`、`runbooks/`、相关 `decisions/`、`projects/`。
2. 失败/错题经验：相关 `incidents/`、错题集、已验证无效方案。

查到相关内容后，agent 应给出 3-5 行召回摘要，分类为“可复用”和“禁止重犯”。

### 2.2 出错后查询

任何命令失败、验证失败、反复尝试失败、方案无效、SSH/Docker/NPU/CANN/MindSpeed/VERL/profiling/training 错误，或策略改变后，agent 必须先查询 GBrain 的 `incidents/` / 错题集，再开始下一轮尝试。不要在未检查失败经验的情况下重复同样假设。

### 2.3 Capture 触发条件

规则块把 capture 触发条件分为三类：

- **MUST 捕获**：用户给出长期规则（“以后”“永远”“必须”“不要”等）、做出架构/流程/配置/部署/工具决策、确认 root cause 且已验证修复、方案被硬证据证明无效、项目里程碑/关闭完成、用户明确要求记录。
- **SHOULD 捕获**：首次打通可复用流程、形成 runbook、发现环境/机器/网络/部署/数据集事实、新正确路径替代旧方案、决策避免重大风险。
- **NEVER 捕获**：闲聊、无证据猜测、一次性噪音、raw transcript、raw tool output、密集日志、原始 JSON、认证响应、密码/token/私钥、真实个人姓名/员工号/账号、未匿名化非回环 IP/hostname/机器别名。

### 2.4 Inbox-first 与 writer 规则

所有新沉淀必须写入 `inbox/<slug>`，状态为 `status: draft`、`verification: unverified`。草稿的 `type` 只是建议，最终类型由人工审核决定。

通过 MCP 直接写页面时，agent 必须：

- 先加载 `gbrain-knowledge-writer` 技能。
- 执行 search-before-create。
- 有重复主题时更新已有页面，而不是创建新页面。
- 使用 MCP `put_page`。
- 遵守 9 字段 frontmatter 契约。
- 只在 `source_refs` 中放证据指针，正文不写 raw transcript 或密集日志。

### 2.5 人工审核门禁

升级通用经验必须使用 `gbrain-review` 技能：

- `gbrain review list/show/plan/verify` 为只读。
- `keep` 保留到 `projects/` / `incidents/` / `decisions/` / `environments/` / `agent-skills/`。
- `promote` 到 `knowledge/` 或通用 `runbooks/` 必须逐条人工确认，确认短语必须逐字匹配 `PROMOTE <target-slug>`。
- `merge` 需要 `MERGE <target-slug>` 确认。
- `reject` 和 `needs-evidence` 必须给出原因。
- 若 target 写入后检索验证失败，或审核记录写入失败，不得删除原 `inbox/` 草稿。

---

## 3. 安装方式

### 3.1 自动安装：managed block

运行 `gbrain install-client` 时，安装器会在 `~/.config/opencode/AGENTS.md` 和 `~/.codex/AGENTS.md` 中写入一个“托管块”。托管块使用以下标记：

```text
<!-- GBRAIN_CLIENT_RULES_START -->
...
<!-- GBRAIN_CLIENT_RULES_END -->
```

再次运行 `gbrain install-client` 时，安装器会查找这两个标记，替换标记之间的内容，不会重复追加。这保证规则块可以幂等地更新。

### 3.2 手动安装：append once

从本归档手动安装时，把 `rules/opencode-AGENTS.gbrain.md` 或 `rules/home-AGENTS.gbrain.md` 的规则片段追加到目标 AGENTS.md 文件末尾。**只追加一次**。后续更新时，人工对比归档中的规则副本与本地 AGENTS.md，合并差异。

手动块没有 `GBRAIN_CLIENT_RULES_START/END` 标记。如果你既运行过 `gbrain install-client` 又手动追加过规则，请检查 AGENTS.md 中是否出现重复块，并删除重复内容。

---

## 4. 更新与幂等性

| 安装方式 | 更新行为 | 幂等性 |
| --- | --- | --- |
| `gbrain install-client` | 替换 `GBRAIN_CLIENT_RULES_START/END` 之间的托管块 | 是，可重复运行 |
| 手动 append | 不会自动替换；需要人工对比合并 | 否，重复 append 会产生重复块 |

更新规则时：

1. 如果之前使用 `gbrain install-client`，直接重新运行即可。
2. 如果之前是手动 append，先删除旧块，再追加新块。
3. 不要把真实 IP、token、secret 写进 AGENTS.md。

---

## 5. 无钩子不变性

GBrain v1 客户端规则**不安装也不依赖任何生命周期钩子**：

- 没有 SessionStart 钩子来自动查询 GBrain。
- 没有 PreToolUse/PostToolUse 钩子来自动 capture。
- 没有 PostCompact 钩子来自动总结。
- 没有 Stop 钩子来自动提交草稿。

所有行为都通过 AGENTS.md 规则文本和技能文档被模型阅读后形成。agent 是否执行 capture/review，取决于它在当前会话中是否加载并遵循了这些规则与技能。

这意味着：

- 规则安装后不会“后台运行”。
- 模型仍然可能遗漏 capture/review；规则块和技能的存在是为了提高触发率，不是强制 hook。
- 重要经验应由用户在会话中明确指示 capture，或事后通过 `gbrain capture` CLI 手动补录。

---

## 6. 与技能的关系

| 规则/技能 | 作用 |
| --- | --- |
| AGENTS.md 规则块 | 告诉模型何时 recall、何时 capture、何时 review、哪些内容禁止写入。 |
| `gbrain-capture` 技能 | 提供 capture 的触发条件、内容结构、CLI 命令和自检清单。 |
| `gbrain-review` 技能 | 提供审核流程、人工门禁和 CLI 命令。 |
| `gbrain-knowledge-writer` 技能 | 提供受信任 writer 客户端直接通过 MCP `put_page` 写入规范页面的完整工作流。 |

规则块是“为什么做”和“什么时候做”，技能是“怎么做”。两者配合使用。

---

## 7. 相关文档

- 客户端接入总流程：[client-onboarding.md](client-onboarding.md)
- 规则片段：`rules/opencode-AGENTS.gbrain.md`、`rules/home-AGENTS.gbrain.md`
- 技能文档：`skills/gbrain-capture/SKILL.md`、`skills/gbrain-review/SKILL.md`、`skills/gbrain-knowledge-writer/SKILL.md`
- gbrain CLI 快速上手：[docs/mcp/QUICKSTART.md](../mcp/QUICKSTART.md)
- MCP 使用与认证：[docs/mcp/MCP_USAGE_GUIDE.md](../mcp/MCP_USAGE_GUIDE.md)
- 部署总览：[README.md](README.md)
