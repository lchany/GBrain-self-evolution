# GBrain 客户端接入

客户端接入依赖云服务器防火墙白名单，不依赖 `install-client` 分发凭据。

下面是客户端的完整安装流程。假设服务端地址为
`https://<PUBLIC_GBRAIN_HOST>`，并且当前客户端出口地址已经加入云服务器
防火墙白名单。

## 1. 安装客户端 CLI

在客户端机器上 clone 完整分支：

```bash
git clone --branch gbrain-review-ui --single-branch \
  https://github.com/lchany/GBrain-self-evolution.git ~/gbrain-client
cd ~/gbrain-client
bun install --frozen-lockfile
```

后续命令都在 `~/gbrain-client` 执行。也可以先编译本地 CLI：

```bash
bun run build
./bin/gbrain --help
```

## 2. 安装规则、skills 与 Codex 启动检查

```bash
bun src/cli.ts install-client --json
```

安装器只安装：

- `~/.config/opencode/AGENTS.md`
- `~/.config/opencode/skills/gbrain-capture/SKILL.md`
- `~/.config/opencode/skills/gbrain-review/SKILL.md`
- `~/.codex/AGENTS.md`
- `~/.codex/skills/gbrain-capture/SKILL.md`
- `~/.codex/skills/gbrain-review/SKILL.md`
- `~/.codex/hooks/gbrain-project-check.py`
- `~/.codex/hooks/gbrain-experience-guard.py`
- `~/.codex/hooks.json` 中由 GBrain 管理的 `SessionStart`、`UserPromptSubmit`、`PostToolUse` 和 `Stop` handler

## Codex 经验收尾守卫

安装器默认启用经验收尾守卫。它在用户提交 prompt 和本地工具完成后只记录最小化元数据，
并在 Agent 准备结束当前回合时检查是否已有结构化经验回执。它不会调用 MCP、不会写入
GBrain、不会保存原始 prompt、命令、工具输出或 transcript，也不会中断正在运行的命令。

默认 `enforce` 模式下，非平凡回合缺少回执时，`Stop` 返回 `decision: "block"`，Codex
自动创建一次续跑 prompt，让 Agent 完成只读召回、去重和候选判断。最多续跑两次；回执仍
无效或 Hook 自身异常时 fail-open。发现候选后，完整正文和预分类仍必须由 Agent 展示给
用户，并沿用 5 分钟写入前审核规则。Hook 不代替用户审核。

长时间训练、监控或夜间无人值守任务应在启动进程时设置：

```bash
GBRAIN_EXPERIENCE_HOOK_MODE=unattended codex exec ...
```

也可以设置一个有限的持久时间窗口：

```bash
gbrain experience-hook mode unattended --for 12h
gbrain experience-hook mode unattended --until 2026-08-06T08:00:00+08:00
gbrain experience-hook status --json
gbrain experience-hook mode enforce
```

优先级为环境变量、有效的定时模式、默认 `enforce`。模式在 `UserPromptSubmit` 时锁存到
当前回合，因此定时窗口在长回合中途到期也不会在该回合结束时重新启用阻止。`unattended`
只保证不阻止回合结束，不负责守护任务进程；长期任务本身仍应使用合适的作业管理器、日志
和检查点机制。永久禁用经验守卫时运行：

```bash
gbrain install-client --no-experience-hook --json
```

此参数只移除 GBrain 管理的三个经验 handler，不影响项目身份 `SessionStart` Hook 或用户
已有的其他 Hook。

它不会读取或生成 `local-read.env`、`local-writer.env`、Bearer token 或
client secret。

Codex Hook 在 `startup|resume` 时运行，检查 Hook 输入 `cwd` 直接目录中的
`.gbrain-project.yaml`，以及当前目录显式提交的 `.gbrain/project.yaml`。它不
调用 MCP，也不会自动创建项目 ID。存在仓库身份指针但没有本地标记时，提示
项目写入前先通过 MCP 精确校验并绑定；两者都缺失、不可信或格式错误时只显示
中文警告并继续会话。

Codex 会对新增或变化的非托管 Hook 执行一次性信任检查。首次安装或更新后，
在 Codex 中运行 `/hooks`，确认来源和命令后信任该 Hook。此后每次启动或恢复
会话都会自动执行。

安装后的规则默认要求 Agent 使用中文说明经验召回、候选总结、预分类和
审核结论。命令、代码、路径、协议字段和错误原文可以保留英文。

经验工作流区分只读召回和写入：

1. 非平凡任务开始时，Agent 先通过 MCP 只读召回已有经验。
2. 关键失败只触发故障召回；同类故障第 2 次独立出现时，Agent 停止盲目
   重试并整理错误总结。
3. 候选经验先完成搜索去重、自动脱敏、固定模板整理和预分类。
4. Agent 展示完整正文，并告知用户 5 分钟确认期限。
5. 用户明确同意时立即写入；完整预览展示后 5 分钟没有任何回复时继续
   写入；拒绝、要求修改或含义不明的回复不会触发写入。
6. 所有草稿只写入 `inbox/`。写入后的正文锁定，后续人工审核只修改分类；
   正文有问题时退回并重新生成，不能在分类审核时静默修改。

新客户端或新 checkout 的项目身份恢复流程为：先运行
`gbrain project current --json`；未绑定时运行 `gbrain project match --json`。
如果返回仓库 `.gbrain/project.yaml` 中的 `project_id`，客户端调用 MCP
`match_project` 精确验证，成功后执行
`gbrain project bind <project_id> --resolved --json`。只有本地和仓库都没有
明确 ID 时，才调用 `ensure_project` 生成新项目身份。

固定模板位于安装后的 `gbrain-capture/SKILL.md`。其中适用条件、不适用
条件和召回提示都是必填项，用来避免后续仅凭相似错误文本误用经验。

## 3. 配置 OpenCode

先确认 OpenCode 已安装：

```bash
opencode --version
```

把服务端 MCP 加到当前用户配置：

```bash
opencode mcp add gbrain --url https://<PUBLIC_GBRAIN_HOST>/mcp
```

不要添加 `--bearer-token`，也不要配置 `headers.Authorization`。匿名访问
由云服务器防火墙白名单和服务端 `--allow-anonymous-mcp` 控制。

验证配置：

```bash
opencode mcp list
```

启动 OpenCode 后，要求 agent 依次调用：

```text
get_brain_identity
search
```

两个只读调用都应能到达服务端。验证 `put_page` 时，必须先让 Agent 按
`gbrain-capture` 展示完整脱敏预览和预分类，并执行 5 分钟限时审核；也可以
由用户明确声明仅本次连接测试免除逐条确认。admin client 管理、审核页面和
其他 admin 操作仍需通过浏览器访问 `/admin/review` 并使用 Basic Auth。

## 4. 配置 Codex

先确认 Codex 已安装：

```bash
codex --version
```

把服务端 MCP 加入 Codex：

```bash
codex mcp add gbrain --url https://<PUBLIC_GBRAIN_HOST>/mcp
```

不要设置 `GBRAIN_REMOTE_TOKEN`，也不要使用 `gbrain connect --token`。

验证配置：

```bash
codex mcp list
```

然后让 Codex 调用 `get_brain_identity` 和 `search` 做只读验证。需要验证
`put_page` 时，遵循与 OpenCode 相同的预览、限时审核和 `inbox/` 写入规则。

## 5. 验证客户端路径

安装完成后，在已通过云防火墙白名单的客户端中调用 MCP：

```text
get_brain_identity
search
```

只读调用成功后，再按 `gbrain-capture` 工作流验证一次 `put_page`。匿名
MCP 客户端只有 `read+write` 权限；admin 操作仍需通过服务器 admin Basic
Auth 或本机管理员 CLI。若调用超时，按以下顺序排查：

1. 客户端出口 IP 是否在云服务器防火墙白名单。
2. `https://<PUBLIC_GBRAIN_HOST>/health` 是否返回 200。
3. `GET https://<PUBLIC_GBRAIN_HOST>/mcp` 是否返回 405。
4. OpenCode/Codex 的 MCP URL 是否以 `/mcp` 结尾。
5. 服务端是否使用 `--allow-anonymous-mcp` 启动。

不要把凭据参数重新加回 `install-client`。
