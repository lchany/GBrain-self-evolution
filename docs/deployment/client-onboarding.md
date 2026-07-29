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

## 2. 安装规则与 skills

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

它不会读取或生成 `local-read.env`、`local-writer.env`、Bearer token 或
client secret。

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
put_page
```

三个调用都应能到达服务端；admin client 管理、审核页面和其他 admin 操作
仍需通过浏览器访问 `/admin/review` 并使用 Basic Auth。

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

然后让 Codex 调用 `get_brain_identity`、`search` 和 `put_page` 做实际验证。

## 5. 验证客户端路径

安装完成后，在已通过云防火墙白名单的客户端中调用 MCP：

```text
get_brain_identity
search
put_page
```

匿名 MCP 客户端只有 `read+write` 权限；admin 操作仍需通过服务器 admin
Basic Auth 或本机管理员 CLI。若调用超时，按以下顺序排查：

1. 客户端出口 IP 是否在云服务器防火墙白名单。
2. `https://<PUBLIC_GBRAIN_HOST>/health` 是否返回 200。
3. `GET https://<PUBLIC_GBRAIN_HOST>/mcp` 是否返回 405。
4. OpenCode/Codex 的 MCP URL 是否以 `/mcp` 结尾。
5. 服务端是否使用 `--allow-anonymous-mcp` 启动。

不要把凭据参数重新加回 `install-client`。
