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

## 2. 安装规则、skills 与双客户端守卫

```bash
bun src/cli.ts install-client --json
```

安装器只安装：

- `~/.config/opencode/AGENTS.md`
- `~/.config/opencode/skills/gbrain-capture/SKILL.md`
- `~/.config/opencode/skills/gbrain-review/SKILL.md`
- `~/.config/opencode/hooks/gbrain-project-check.py`
- `~/.config/opencode/hooks/gbrain-experience-guard.py`
- `~/.config/opencode/plugins/gbrain-experience-guard.ts`
- `~/.codex/AGENTS.md`
- `~/.codex/skills/gbrain-capture/SKILL.md`
- `~/.codex/skills/gbrain-review/SKILL.md`
- `~/.codex/hooks/gbrain-project-check.py`
- `~/.codex/hooks/gbrain-experience-guard.py`
- `~/.codex/hooks.json` 中由 GBrain 管理的 `SessionStart` 和 `UserPromptSubmit` handler

## OpenCode 与 Codex 只读 Recall 守卫

安装器默认启用只读 Recall 守卫。非平凡回合只生成一次性 recall token；主 Agent 派发独立
Recall Worker，并只接收受字段、条数和总字节限制的结构化 envelope。守卫不会调用 MCP、写入
GBrain、保存原始 prompt、命令、工具输出或 transcript，也不会中断正在运行的命令。

自动 Closeout 已关闭。Codex 不再安装 GBrain 管理的 `PostToolUse` 或 `Stop` 经验处理器；OpenCode
不再转发工具事件、注入 system transform 或在 `session.idle` 后发起内部续跑。安装或升级时会移除
旧的 GBrain 管理处理器，并保留其他来源的 Hook。只有用户明确要求保存经验时，Agent 才使用
`gbrain-capture` 完成搜索去重、脱敏、写入和回读验证。

守卫不会创建倒计时、后台等待任务或恢复会话；长期任务仍应使用合适的作业管理器、日志和检查点机制。永久禁用经验守卫时运行：

```bash
gbrain install-client --no-experience-hook --json
```

此参数移除两端经验脚本、Codex 的 `UserPromptSubmit` 经验 handler，并禁用 OpenCode 插件中的经验路径。
两端项目身份检查和用户已有的其他 Hook/插件不受影响。

它不会读取或生成 `local-read.env`、`local-writer.env`、Bearer token 或
client secret。

Codex Hook 在 `startup|resume` 时运行；OpenCode 插件在每个 session 的首个 `chat.message`
运行。两者都检查当前 `cwd` 直接目录中的
`.gbrain-project.yaml`，以及当前目录显式提交的 `.gbrain/project.yaml`。Hook 本身不
调用 MCP；缺少本地标记时注入 `GBRAIN_PROJECT_BOOTSTRAP_REQUIRED`，要求主 Agent 立即
派发独立 bootstrap 子 Agent。仓库已有 ID 时子 Agent 精确校验并绑定；两种标记都没有时，
并发会话在一小时 lease 内原子复用 Hook 提供的 `GBRAIN_PROJECT_BOOTSTRAP_CREATION_KEY`，子 Agent
必须使用该键调用 `ensure_project` 创建 ID、绑定本地标记并读取登记页验证，不得自行生成新键；
成功后执行 Hook 提供的 `complete-bootstrap` 命令清除 lease。

Codex 会对新增或变化的非托管 Hook 执行一次性信任检查。首次安装或更新后，
在 Codex 中运行 `/hooks`，确认来源和命令后信任该 Hook。此后每次启动或恢复
会话都会自动执行。OpenCode 从用户配置的 `plugins/` 目录自动加载适配器，无需 `/hooks` 信任步骤。

安装后的规则默认要求 Agent 使用中文说明经验召回、手动采集结果、预分类和
审核结论。命令、代码、路径、协议字段和错误原文可以保留英文。

经验工作流区分只读召回和写入：

1. 非平凡任务开始时，Agent 先通过 MCP 只读召回已有经验。
2. 关键失败只触发故障召回；同类故障第 2 次独立出现时，Agent 停止盲目
   重试并整理错误总结。
3. 只有用户明确要求持久化时，候选经验才完成搜索去重、自动脱敏、固定模板整理和预分类。
4. Agent 简要说明预分类和目标 slug，并写入。
5. Agent 随即调用 `get_page` 验证写入；用户后续要求修改时更新或删除草稿。
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
`gbrain-capture` 完成脱敏、预分类和同步写入。admin client 管理、审核页面和
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
