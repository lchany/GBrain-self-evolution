# GBrain 自进化知识沉淀体系归档

这是 `GBrain-self-evolution` 的本地归档仓库。它不是源仓库镜像，而是一个可复现的交付包：GBrain 源码改动以 patch 形式交付，客户端文档、技能和 AGENTS 规则以普通文件交付。归档用于让审阅者在不依赖当前工作树的情况下，重新部署同一套 GBrain 自进化知识沉淀体系。

归档已发布到 GitHub：`https://github.com/lchany/GBrain-self-evolution`。最终交付形式为 patch-based distribution：GBrain 源码改动以 patch 形式交付，客户端规则、技能和文档以普通文件交付。生产环境已在 `/opt/gbrain` 完成部署，`gbrain-serve-http.service` 已重启并处于 active 状态。F1-F5 最终结论均为 APPROVE（F2 初审 REJECT，修正后 re-review APPROVE）。

## 两个 change wave

### Wave 1：OAuth / HTTP MCP hardening

来自前一个部署项目的未提交 GBrain 工作树改动。主要覆盖 HTTP MCP/OAuth 服务、token/DCR、HTTP transport、serve-http E2E 和 MCP dispatch 相关硬化。

### Wave 2：no-hook capture/review system

来自本次 `gbrain-no-hook-capture-implementation` 计划。核心路径是：`capture -> inbox/draft -> review -> keep/promote/merge/reject/repair/cleanup`。客户端只安装规则和技能，不依赖 OpenCode/Codex 生命周期 hook 自动沉淀。

## 源仓库基线

### GBrain

- 路径：`/home/l30002999/source_code/gbrain`（归档生成时的本地路径，仅溯源；部署时改用下方 remote clone）
- HEAD：`1fabbb9849f23703ee2898699868ce8101e7b61d`
- remote：`origin https://github.com/garrytan/gbrain.git`
- 归档补丁：`patches/gbrain-self-evolution.patch`
- 范围：完整工作树 delta，排除 `.omo/`。

### oh-my-openagent

- 路径：`/home/l30002999/source_code/oh-my-openagent`（归档生成时的本地路径，仅溯源；部署时改用下方 remote clone）
- HEAD：`e3556c35d2c3879aeec1d7043ecc52e37bf1d3d3`
- remote：`origin https://github.com/code-yeongyu/oh-my-openagent.git`，`fork https://github.com/code-yeongyu/oh-my-openagent.git`
- 归档补丁：`patches/oh-my-openagent-gbrain.patch`
- 范围：只包含本计划显式路径；不包含 generated aggregate copies，也不包含其它 dirty state。

## 目录结构

```text
GBrain-self-evolution/
├── README.md
├── patches/
│   ├── gbrain-self-evolution.patch
│   └── oh-my-openagent-gbrain.patch
├── docs/
│   ├── EVIDENCE.md
│   ├── OPERATIONS.md
│   ├── knowledge-source/
│   └── mcp/
├── skills/
│   ├── gbrain-capture/SKILL.md
│   ├── gbrain-review/SKILL.md
│   └── gbrain-knowledge-writer/SKILL.md
└── rules/
    ├── opencode-AGENTS.gbrain.md
    └── home-AGENTS.gbrain.md
```

## 在新 clone 上应用补丁

### 应用 GBrain 补丁

```bash
git clone <gbrain-remote> gbrain
cd gbrain
git checkout 1fabbb9849f23703ee2898699868ce8101e7b61d
git apply --check /path/to/GBrain-self-evolution/patches/gbrain-self-evolution.patch
git apply /path/to/GBrain-self-evolution/patches/gbrain-self-evolution.patch
```

### 应用 oh-my-openagent 补丁

```bash
git clone <oh-my-openagent-remote> oh-my-openagent
cd oh-my-openagent
git checkout e3556c35d2c3879aeec1d7043ecc52e37bf1d3d3
git apply --check /path/to/GBrain-self-evolution/patches/oh-my-openagent-gbrain.patch
git apply /path/to/GBrain-self-evolution/patches/oh-my-openagent-gbrain.patch
```

这些文件是 `git diff` 格式补丁，推荐用 `git apply`。如果审阅流程要求 `git am`，请先由审阅者把补丁封装成邮件格式 commit，再执行 `git am`。

## 安装规则和技能

### 手动安装

1. 将 `rules/opencode-AGENTS.gbrain.md` 中的规则片段追加到目标 OpenCode 用户规则文件。
2. 将 `rules/home-AGENTS.gbrain.md` 中的规则片段追加到目标用户级 `AGENTS.md`。
3. 将 `skills/gbrain-capture`、`skills/gbrain-review`、`skills/gbrain-knowledge-writer` 复制到目标客户端的 OpenCode skill 目录。
4. 使用 `docs/mcp/QUICKSTART.md` 和 `docs/mcp/CLIENT_INSTALL_DEPLOYMENT.md` 检查 MCP endpoint、token、env 文件权限和 read/write probe。

### 通过 GBrain 安装器安装

应用 GBrain 补丁后，可以使用：

```bash
gbrain install-client
```

该安装器负责落地客户端规则、技能、env 文件和探针。安装后仍需按 `docs/EVIDENCE.md` 的边界进行 smoke test，确认真实客户端配置和数据库没有被误触。

## 生产部署指南

目标生产目录为 `/opt/gbrain`。部署时将 GBrain 补丁应用到生产代码基线，安装依赖并运行现有测试/探针后，重启服务：

```bash
systemctl restart gbrain-serve-http.service
```

这是服务重启，通常是数秒级，不是机器重启。本次归档没有要求数据库 schema migration；部署重点是让远端 HTTP MCP 服务加载已验证的代码更改。

生产环境已于 2026-07-27 完成部署，`gbrain-serve-http.service` 已重启并确认 active。最终 F5 live gate 已通过：默认读取不暴露 `inbox/`，显式 `include_prefixes` 可读取 inbox 草稿，read-token 尝试写入被 `insufficient_scope` 拒绝，权限边界与文档一致。

## F5 最终结论

F5 E2E/live transcript 最终结论：APPROVE。

历史状态：生产部署前，live endpoint 曾出现部署滞后，远端服务尚未加载本地工作树中已验证的默认 `inbox/` 排除等修正。该状态已在 2026-07-27 生产部署并重启服务后被覆盖。

## 部署文档指针

- `docs/deployment/README.md`：部署总览入口
- `docs/deployment/new-machine-bootstrap.md`：服务器端新机器启动流程
- `docs/deployment/client-onboarding.md`：客户端接入流程
- `docs/deployment/agent-rules.md`：代理行为与规则约定

## 隐私说明

- 归档不包含 `.omo/`、`node_modules/`、`dist/`、原始 evidence dump 或 boulder state。
- 规则副本是归档副本，不修改 live AGENTS 文件。
- 非 loopback 真实 IP、token、private key、bearer 值、GitHub PAT、AWS key 等必须在推送前保持清除或占位。
- 允许保留合成测试 fixture、正则定义和占位符。

## 证据摘要

详见 `docs/EVIDENCE.md`。该文件只收录 curated gate/evidence summary，不收录原始 transcript 或密集日志。
