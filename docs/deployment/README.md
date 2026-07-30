# GBrain 自进化体系部署总览

本文档是 `gbrain-self-evolution-deployment-package` 的单点入口。它面向三种角色，告诉他们应该读哪份文档、执行哪些步骤，以及这套体系的核心边界。

归档本身是一个 patch-based distribution：GBrain 源码改动在 `patches/gbrain-self-evolution.patch`，oh-my-openagent 客户端改动在 `patches/oh-my-openagent-gbrain.patch`，规则、技能和文档以普通文件交付。生产环境已在 `/opt/gbrain` 完成部署，`gbrain-serve-http.service` 已重启并确认 active。F1-F5 最终结论均为 APPROVE。

## 这个包做什么

- 交付 GBrain 服务端 MCP/OAuth 硬化与无 hook 捕获/审核功能的源码补丁。
- 交付 OpenCode/Codex 客户端规则、技能与 AGENTS 规则片段。
- 提供服务器端、客户端和审阅者三类角色的部署文档与验证清单。
- 通过 patch + 文档 + 规则 + 技能的组合，让审阅者在独立 clone 上复现同一套部署。

## 这个包不做的事

- **不提供 lifecycle hook**。v1 没有 SessionStart、PreToolUse、PostToolUse、PostCompact 或 Stop 钩子。所有沉淀都是显式命令、技能或 AGENTS 规则触发的。
- **不自动升级知识**。`inbox/` 草稿不会自动变成 `knowledge/` 或通用 `runbooks/`。`promote` 必须逐条人工输入 `PROMOTE <target-slug>` 确认。
- **不全量 vendoring 源码**。服务端改动以 patch 形式交付，不是完整源码副本。客户端规则、技能和文档是普通文件。
- **不把 secret 放进仓库**。归档不包含 token、client secret、私钥、bearer 值、GitHub PAT、AWS key 或非回环真实 IP。临时凭证只在安装时通过安全通道传输，不提交。
- **不替代 GBrain 运维手册**。生产恢复、数据库重建、凭证轮换等操作仍由 `docs/OPERATIONS.md` 负责。

## 三个角色

### 1. 服务器管理员

负责在新机器或现有生产机器上应用 GBrain 补丁、安装依赖、重启服务、配置 OAuth client 与本地 `local-read` / `local-writer` 凭证。

入口文档：[docs/deployment/new-machine-bootstrap.md](new-machine-bootstrap.md)（由并行 worker 创建）。

管理员还需要预注册每台 OpenCode 客户端的 OAuth 客户端，安全交付 `client_id`，并在客户端退役时执行撤销。具体注册与撤销命令见 [docs/mcp/CLIENT_INSTALL_DEPLOYMENT.md](../mcp/CLIENT_INSTALL_DEPLOYMENT.md) 第 3 节和第 9.3 节。

### 2. 客户端用户/操作员

负责在本地工作站上安装 OpenCode、配置 MCP、完成 OAuth 认证、安装本地规则与技能，并执行 capture/review 操作。

入口文档：

- [docs/deployment/client-onboarding.md](client-onboarding.md)（由并行 worker 创建）：客户端接入总流程。
- [docs/deployment/agent-rules.md](agent-rules.md)（由并行 worker 创建）：代理行为与规则约定。
- [docs/mcp/CLIENT_INSTALL_DEPLOYMENT.md](../mcp/CLIENT_INSTALL_DEPLOYMENT.md)：OpenCode 浏览器 OAuth 接入、MCP 配置、故障排查。
- [docs/mcp/QUICKSTART.md](../mcp/QUICKSTART.md)：gbrain CLI 的 capture/review 快速上手。
- [docs/mcp/MCP_USAGE_GUIDE.md](../mcp/MCP_USAGE_GUIDE.md)：手动 JSON-RPC、scope 隔离、writer 工作流、错误速查。

安装完成后，客户端应具备：

- `~/.config/gbrain/local-read.env` 和 `local-writer.env`，权限 `600`。
- `gbrain-capture` 和 `gbrain-review` 技能。
- OpenCode/Codex 用户级 AGENTS 规则中的 GBrain 规则块。

### 3. 审阅者/人工门禁所有者

负责确认 `inbox/` 草稿是否应保留、升级、合并、退回或删除。审阅者需要理解：

- 默认查询排除 `inbox/`；显式 draft/review 模式才能看到未审核内容。
- `promote` 到 `knowledge/` 或通用 `runbooks/` 需要 `verification: verified` 和 `PROMOTE <target-slug>` 逐条确认。
- `merge` 需要 `MERGE <target-slug>` 确认。
- 所有写入页面禁止包含 secret、真实 IP、raw transcript 或密集日志。

审阅者不需要执行服务器部署，但需要会用 [docs/mcp/QUICKSTART.md](../mcp/QUICKSTART.md) 和 [docs/mcp/MCP_USAGE_GUIDE.md](../mcp/MCP_USAGE_GUIDE.md) 中的 `gbrain review` 命令，或 [docs/mcp/WEB_UI_REVIEW.md](../mcp/WEB_UI_REVIEW.md) 中的 Web UI 审核页面。

## 两波变更

### Wave 1：OAuth / HTTP MCP hardening

来自前一个部署项目的未提交 GBrain 工作树改动。覆盖 HTTP MCP/OAuth 服务、token/DCR、HTTP transport、serve-http E2E 和 MCP dispatch 相关硬化。

应用方式：把 `patches/gbrain-self-evolution.patch` 应用到 GBrain 基线 `1fabbb9849f23703ee2898699868ce8101e7b61d`，然后安装依赖、运行测试与探针，重启 `gbrain-serve-http.service`。

### Wave 2：no-hook capture/review system

来自本次 `gbrain-no-hook-capture-implementation` 计划。核心路径是 `capture -> inbox/draft -> review -> keep/promote/merge/reject/repair/cleanup`。客户端只安装规则和技能，不依赖 OpenCode/Codex 生命周期 hook 自动沉淀。

默认查询排除 `inbox/`；显式 `include_prefixes: ["inbox/"]` 才能列出草稿。`promote` 必须人工输入 `PROMOTE <target-slug>`。

### Wave 3：审核 UI 可靠性与浅色主题

`patches/gbrain-review-ui-portability.patch` 修复 Web UI 写操作的 writer
credential/loopback attestation 链路，使用 systemd `LoadCredential` 保护
root-owned 凭据，并将审核页面统一为极简灰白主题。补丁基线和应用命令见归档
根目录 README。

基线、范围与补丁应用命令详见归档根目录 [README.md](../../README.md)。

## 按角色选择文档

| 角色 | 必读 | 可选 |
| --- | --- | --- |
| 服务器管理员 | [new-machine-bootstrap.md](new-machine-bootstrap.md) | [docs/OPERATIONS.md](../OPERATIONS.md), [docs/mcp/CLIENT_INSTALL_DEPLOYMENT.md](../mcp/CLIENT_INSTALL_DEPLOYMENT.md) 第 3、9.3 节 |
| 客户端用户/操作员 | [client-onboarding.md](client-onboarding.md), [agent-rules.md](agent-rules.md), [docs/mcp/CLIENT_INSTALL_DEPLOYMENT.md](../mcp/CLIENT_INSTALL_DEPLOYMENT.md), [docs/mcp/QUICKSTART.md](../mcp/QUICKSTART.md) | [docs/mcp/MCP_USAGE_GUIDE.md](../mcp/MCP_USAGE_GUIDE.md), [docs/mcp/MCP_CONTRACT.md](../mcp/MCP_CONTRACT.md), [docs/mcp/FAILURE_RECOVERY.md](../mcp/FAILURE_RECOVERY.md) |
| 审阅者/人工门禁所有者 | [docs/mcp/QUICKSTART.md](../mcp/QUICKSTART.md) 第 4-5 节，[docs/mcp/MCP_USAGE_GUIDE.md](../mcp/MCP_USAGE_GUIDE.md) 第 8-9 节，[docs/knowledge-source/AGENTS.md](../knowledge-source/AGENTS.md) | [docs/mcp/WEB_UI_REVIEW.md](../mcp/WEB_UI_REVIEW.md), [docs/knowledge-source/README.md](../knowledge-source/README.md), [docs/knowledge-source/SCHEMA.md](../knowledge-source/SCHEMA.md) |

## 规则与技能安装

### 通过 `gbrain install-client` 自动安装

应用 GBrain 补丁后，在客户端运行：

```bash
gbrain install-client \
  --read-env-source /tmp/local-read.env \
  --writer-env-source /tmp/local-writer.env \
  --json
```

安装器会：

- 写入 `~/.config/gbrain/local-read.env` 和 `local-writer.env`，权限 `600`。
- 在 `~/.config/opencode/AGENTS.md` 和 `~/.codex/AGENTS.md` 写入 GBrain 规则块。
- 安装 `gbrain-capture` 和 `gbrain-review` 技能。
- 执行读写探针并立即删除探针页面。

注意：`gbrain install-client` **默认不安装 `gbrain-knowledge-writer`**。如果客户端需要手写或辅助生成符合 SCHEMA.md 的页面，应额外复制 [skills/gbrain-knowledge-writer/SKILL.md](../../skills/gbrain-knowledge-writer/SKILL.md) 到 OpenCode/Codex skill 目录。

### 手动安装

1. 将 `rules/opencode-AGENTS.gbrain.md` 中的规则片段追加到目标 OpenCode 用户规则文件。
2. 将 `rules/home-AGENTS.gbrain.md` 中的规则片段追加到目标用户级 `AGENTS.md`。
3. 将 `skills/gbrain-capture` 和 `skills/gbrain-review` 复制到目标客户端的 OpenCode/Codex skill 目录。
4. 如需手写规范页面，额外复制 `skills/gbrain-knowledge-writer`。
5. 按 [docs/mcp/CLIENT_INSTALL_DEPLOYMENT.md](../mcp/CLIENT_INSTALL_DEPLOYMENT.md) 放置 env 文件、配置 MCP 并完成 OAuth 认证。

## 验证

所有角色完成各自步骤后，使用 [docs/deployment/verification-checklist.md](verification-checklist.md) 逐项检查。服务器检查、客户端检查、文档/隐私检查、no-hook 检查和发布检查分别列出可执行的命令或观察项。

## 隐私与红线

- 归档不包含 `.omo/`、`node_modules/`、`dist/`、原始 evidence dump 或 boulder state。
- 规则副本是归档副本，不修改 live AGENTS 文件。
- 非回环真实 IP、token、private key、bearer 值、GitHub PAT、AWS key 等必须在推送前清除或占位。
- 允许保留合成测试 fixture、正则定义和占位符。
- 所有写入 GBrain 的页面禁止包含密码、token、API key、私钥、raw transcript、密集日志、真实个人姓名或员工 ID。详见 [docs/knowledge-source/AGENTS.md](../knowledge-source/AGENTS.md)。

## 相关文档

- 归档根目录与基线说明：[README.md](../../README.md)
- 证据摘要与 gate 结论：[docs/EVIDENCE.md](../EVIDENCE.md)
- 生产运维与恢复：[docs/OPERATIONS.md](../OPERATIONS.md)
- OpenCode 客户端安装部署：[docs/mcp/CLIENT_INSTALL_DEPLOYMENT.md](../mcp/CLIENT_INSTALL_DEPLOYMENT.md)
- MCP 使用与认证：[docs/mcp/MCP_USAGE_GUIDE.md](../mcp/MCP_USAGE_GUIDE.md)
- 快速上手 capture/review：[docs/mcp/QUICKSTART.md](../mcp/QUICKSTART.md)
- MCP Contract：[docs/mcp/MCP_CONTRACT.md](../mcp/MCP_CONTRACT.md)
- Web UI 审核：[docs/mcp/WEB_UI_REVIEW.md](../mcp/WEB_UI_REVIEW.md)
- 失败恢复：[docs/mcp/FAILURE_RECOVERY.md](../mcp/FAILURE_RECOVERY.md)
- 知识源分类与规范：[docs/knowledge-source/README.md](../knowledge-source/README.md), [docs/knowledge-source/SCHEMA.md](../knowledge-source/SCHEMA.md), [docs/knowledge-source/AGENTS.md](../knowledge-source/AGENTS.md)
- 客户端规则：`rules/opencode-AGENTS.gbrain.md`, `rules/home-AGENTS.gbrain.md`
- 技能：`skills/gbrain-capture/SKILL.md`, `skills/gbrain-review/SKILL.md`, `skills/gbrain-knowledge-writer/SKILL.md`
- 服务端补丁：`patches/gbrain-self-evolution.patch`
- 客户端补丁：`patches/oh-my-openagent-gbrain.patch`
