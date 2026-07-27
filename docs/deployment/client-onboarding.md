# GBrain 客户端接入指南

本文档面向需要在本地工作站上接入 GBrain 的用户。它把客户端安装分成四条并行的轨道：

1. OpenCode 通过浏览器 OAuth 连接 GBrain 远程 MCP。
2. `gbrain` CLI 通过 `local-read.env` / `local-writer.env` 使用 `client_credentials`。
3. 在 OpenCode / Codex 中安装完整的 GBrain 规则与技能。
4. 无浏览器/无桌面场景的 SSH 端口转发。

完成后，客户端应能：

- 在 OpenCode 会话中调用 GBrain 的 `get_brain_identity`、`search` 等 MCP 工具。
- 在命令行执行 `gbrain review list`、`gbrain capture` 等操作。
- 在 OpenCode / Codex 的规则与技能引导下完成 recall、capture、review 工作流。

**前提**：服务端管理员已经部署 GBrain，预注册了 OpenCode OAuth 客户端，并交付了 `local-read.env` / `local-writer.env`。

**占位符约定**：文中 `<server>` 表示 GBrain 服务端地址，`<CLIENT_ID>` 表示服务端预注册的 OpenCode OAuth client ID。不要把真实 IP、token、client secret 或原始认证文件写入本仓库任何文件。

---

## 1. 四条接入轨道

### 轨道 1：OpenCode 远程 MCP 浏览器 OAuth

这条轨道让 OpenCode 通过 HTTP MCP 调用 GBrain。它使用浏览器 `authorization_code` 流程，OpenCode 自动管理 refresh token。

#### 1.1 安装或检查 OpenCode

```bash
opencode --version
```

如果尚未安装，使用官方安装器：

```bash
curl -fsSL https://opencode.ai/install | bash
```

#### 1.2 合并 MCP 配置

编辑全局用户配置 `~/.config/opencode/opencode.json`（Linux/macOS 默认；Windows 用户可执行 `opencode debug paths` 确认全局配置位置）。如果该文件已存在，**只新增或修改 `mcp.gbrain` 字段**，不要整文件覆盖。

最小配置示例：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "gbrain": {
      "type": "remote",
      "url": "http://<server>:3131/mcp",
      "enabled": true,
      "oauth": {
        "clientId": "<CLIENT_ID>",
        "scope": "read"
      }
    }
  }
}
```

需要写入知识库的受信任客户端把 `scope` 改为：

```jsonc
"scope": "read write"
```

配置约束：

- `url` 必须以 `/mcp` 结尾。
- `scope` 不得超过服务端注册范围。
- 公共 PKCE 客户端没有 `clientSecret`，不要添加空值或伪造 secret。
- 不要在 `headers.Authorization` 中写入长期 bearer token。
- 如果使用项目级 `opencode.json`，生产 `<CLIENT_ID>` 应优先放在用户配置中。
- 本文使用 OpenCode 1.18.x 的 `clientId`；不要改成 v2 的 `client_id`。

完整 OAuth 注册、认证、撤销流程见 [docs/mcp/CLIENT_INSTALL_DEPLOYMENT.md](../mcp/CLIENT_INSTALL_DEPLOYMENT.md)。本文不再重复。

#### 1.3 完成 OAuth 认证

```bash
opencode mcp auth gbrain
```

OpenCode 会启动本地回调监听器并打开浏览器。授权完成后，浏览器应跳转到：

```text
http://127.0.0.1:19876/mcp/oauth/callback
```

不要手工复制授权码、access token 或 refresh token 到配置文件。

---

### 轨道 2：CLI client_credentials 与 env 文件

`gbrain` CLI 不使用 OpenCode 的浏览器 OAuth `clientId`。它使用独立的 `client_credentials` 客户端，通过 `~/.config/gbrain/local-read.env` 和 `local-writer.env` 换取 token。

#### 2.1 放置 env 文件

从服务端安全复制两个文件到临时位置，再移入目标目录：

```bash
# 示例：从服务端复制到 /tmp，不要提交到 Git
scp root@<server>:/etc/gbrain/clients/local-read.env /tmp/local-read.env
scp root@<server>:/etc/gbrain/clients/local-writer.env /tmp/local-writer.env
chmod 600 /tmp/local-read.env /tmp/local-writer.env

# 安装到目标路径
mkdir -p ~/.config/gbrain
install -m 0600 /tmp/local-read.env ~/.config/gbrain/local-read.env
install -m 0600 /tmp/local-writer.env ~/.config/gbrain/local-writer.env
rm -f /tmp/local-read.env /tmp/local-writer.env
```

目标路径与权限：

| 文件 | 路径 | 权限 |
| --- | --- | --- |
| 只读凭证 | `~/.config/gbrain/local-read.env` | `600` |
| 读写凭证 | `~/.config/gbrain/local-writer.env` | `600` |

文件内容大致如下（值已用占位符代替）：

```bash
export GBRAIN_MCP_URL=http://<server>:3131/mcp
export GBRAIN_TOKEN_ENDPOINT=http://<server>:3131/token
export GBRAIN_CLIENT_ID=<CLIENT_ID>
export GBRAIN_CLIENT_SECRET=<CLIENT_SECRET>
export GBRAIN_SCOPES=read           # local-writer.env 里为 "read write"
```

- `local-read.env` 的 scope 为 `read`，用于只读操作。
- `local-writer.env` 的 scope 为 `read write`，用于写入和更新页面。
- 这两个文件**不得**用于 OpenCode 的浏览器 OAuth 流程；OpenCode 的 `clientId` 也**不得**用于 CLI 的 `client_credentials`。

#### 2.2 验证 CLI 连接

```bash
gbrain review list
```

应返回空列表或当前 `inbox/` 草稿列表。如果报错 `missing local read credentials`，检查 env 文件是否存在且权限为 `600`。

---

### 轨道 3：OpenCode / Codex 规则与技能安装

为了让 agent 在会话中自动 recall、capture、review，需要把 GBrain 规则块和技能安装到 OpenCode 与 Codex 的用户级配置目录。

#### 3.1 安装目标路径

| 内容 | OpenCode 路径 | Codex 路径 |
| --- | --- | --- |
| 规则块 | `~/.config/opencode/AGENTS.md` | `~/.codex/AGENTS.md` |
| 技能目录 | `~/.config/opencode/skills/` | `~/.codex/skills/` |

#### 3.2 技能矩阵

| 技能 | 作用 | 是否由 `gbrain install-client` 自动安装 |
| --- | --- | --- |
| `gbrain-capture` | 把可复用经验捕获为 `inbox/` 草稿；定义 MUST/SHOULD/NEVER 触发条件。 | 是 |
| `gbrain-review` | 审核 `inbox/` 草稿，执行 keep/promote/merge/reject 等人工门禁。 | 是 |
| `gbrain-knowledge-writer` | 受信任 writer 客户端通过 MCP `put_page` 直接写入规范页面。 | **否**（需手动或脚本安装） |

**重要差异**：当前 `gbrain install-client` 默认只安装 `gbrain-capture` 和 `gbrain-review`，以及规则块、env 文件和探针。完整归档手动安装（或使用 `deploy/scripts/install-client-assets.sh`）会额外安装 `gbrain-knowledge-writer`。如果客户端需要手写或辅助生成符合 `SCHEMA.md` 的页面，必须补充安装该技能。

#### 3.3 安装方式 A：自动安装（推荐）

```bash
# 先从服务端安全复制 env 文件到临时位置
scp root@<server>:/etc/gbrain/clients/local-read.env /tmp/local-read.env
scp root@<server>:/etc/gbrain/clients/local-writer.env /tmp/local-writer.env
chmod 600 /tmp/local-read.env /tmp/local-writer.env

# 运行安装器
gbrain install-client \
  --read-env-source /tmp/local-read.env \
  --writer-env-source /tmp/local-writer.env \
  --json

# 清理临时文件
rm -f /tmp/local-read.env /tmp/local-writer.env
```

安装器会：

- 把 env 文件复制到 `~/.config/gbrain/local-read.env` 和 `local-writer.env`，权限设为 `600`。
- 在 `~/.config/opencode/AGENTS.md` 和 `~/.codex/AGENTS.md` 中写入 GBrain 规则块。
- 把 `gbrain-capture` 和 `gbrain-review` 技能复制到 OpenCode 与 Codex 的技能目录。
- 执行 `get_brain_identity`、`put_page`、`get_page`、`delete_page` 探针并立即删除探针页面。

输出永远被脱敏处理，不会打印 token、client secret 或 MCP URL。

#### 3.4 安装方式 B：从本归档手动安装

如果不使用 `gbrain install-client`，按以下步骤执行：

1. 把 `rules/opencode-AGENTS.gbrain.md` 中的规则片段追加到 `~/.config/opencode/AGENTS.md`。
2. 把 `rules/home-AGENTS.gbrain.md` 中的规则片段追加到用户级 `~/.config/opencode/AGENTS.md` 或 `~/.codex/AGENTS.md`（按你的规则层级选择；Codex 用户则追加到 `~/.codex/AGENTS.md`）。
3. 把 `skills/gbrain-capture/` 和 `skills/gbrain-review/` 复制到 `~/.config/opencode/skills/` 和 `~/.codex/skills/`。
4. 如需 `gbrain-knowledge-writer`，额外把 `skills/gbrain-knowledge-writer/` 复制到上述两个技能目录。
5. 按轨道 1 和轨道 2 配置 MCP、完成 OAuth、放置 env 文件。

如果你偏好脚本化，可使用由并行 worker 创建的 `deploy/scripts/install-client-assets.sh`（由本归档交付）。该脚本会把技能复制到 OpenCode/Codex 技能目录，并提示你如何追加规则块。

---

### 轨道 4：无浏览器 / 无桌面场景

如果客户端是远程无桌面主机，而用于打开浏览器的工作站能够访问 `http://<server>:3131`，可使用 SSH 本地端口转发完成 OAuth 回调。

```bash
ssh -L 19876:127.0.0.1:19876 <user>@<client-host>
opencode mcp auth gbrain
```

如果远程主机不能自动打开浏览器，OpenCode 会显示授权 URL。复制该 URL，在建立隧道的工作站浏览器中打开。浏览器访问本机 `127.0.0.1:19876` 时，SSH 会把回调转发到远程客户端上的 OpenCode。

安全要求：

- 不要在防火墙上开放 19876。
- 不要把回调地址改成客户端的公网 IP。
- 认证完成后退出 SSH 会话即可关闭端口转发。

完整说明见 [docs/mcp/CLIENT_INSTALL_DEPLOYMENT.md](../mcp/CLIENT_INSTALL_DEPLOYMENT.md) 第 6.1 节。

---

## 2. 冒烟检查

### 2.1 OpenCode 侧

```bash
opencode mcp list
opencode mcp auth list
```

`gbrain` 应显示为已连接或可用，OAuth 状态应为已认证。

启动 OpenCode 会话后，依次要求 agent：

1. 调用 `get_brain_identity`。
2. 调用 `search` 搜索一个已知主题，并返回命中的 slug。
3. 让 agent 展示该工具的来源，断言其属于名为 `gbrain` 的 MCP 连接。

只读客户端**不要**用 `put_page` 等写操作做生产连接探针。scope 隔离验证是**服务器管理员**动作：请按 [docs/mcp/CLIENT_INSTALL_DEPLOYMENT.md](../mcp/CLIENT_INSTALL_DEPLOYMENT.md) 第 7.2 节或 [docs/mcp/MCP_USAGE_GUIDE.md](../mcp/MCP_USAGE_GUIDE.md) 第 2.2 节的 `client_credentials` 流程拿到该只读 client 的 token，再调用 `put_page`，预期返回 `insufficient_scope` 或 403。读写客户端必须遵循 search-before-write 工作流。

MCP 协议细节、手动 JSON-RPC 示例、scope 隔离和错误速查见 [docs/mcp/MCP_USAGE_GUIDE.md](../mcp/MCP_USAGE_GUIDE.md)。

### 2.2 CLI 侧

```bash
gbrain review list
gbrain capture --title "客户端接入冒烟测试" \
  --summary "完成 client-onboarding.md 四条轨道安装，OpenCode MCP 与 CLI 均可正常访问 GBrain。" \
  --evidence "client-onboarding/smoke-check" \
  --type project \
  --json
```

- `gbrain review list` 应能返回空列表或草稿列表。
- `gbrain capture` 应把草稿写入 `inbox/`，并返回 `status: draft`、`verification: unverified`。

---

## 3. 模型使用说明

规则与技能安装完成后，agent 会从 `~/.config/opencode/AGENTS.md` / `~/.codex/AGENTS.md` 的规则块以及 `gbrain-capture`、`gbrain-review`、`gbrain-knowledge-writer` 技能中学习 recall、capture、review 行为。

本文档**不重复教学**完整工作流。具体行为参考：

- 规则来源：`rules/opencode-AGENTS.gbrain.md`、`rules/home-AGENTS.gbrain.md`。
- 技能文档：`skills/gbrain-capture/SKILL.md`、`skills/gbrain-review/SKILL.md`、`skills/gbrain-knowledge-writer/SKILL.md`。
- 使用指南：[docs/mcp/QUICKSTART.md](../mcp/QUICKSTART.md)、[docs/mcp/MCP_USAGE_GUIDE.md](../mcp/MCP_USAGE_GUIDE.md)。

---

## 4. 只读与读写 scope 指导

- **默认 read**：大多数客户端只需要读取 GBrain 已有知识，使用 `read` scope。
- **读写 scope 仅授予受信任客户端**：只有确实需要调用 `put_page`、`delete_page` 等写工具的客户端才授予 `read write`。
- OpenCode 的 `clientId` 与 CLI 的 `client_credentials` 互相隔离，不要混用。
- 命令行写操作会经过 `search-before-create` 门禁、`PROMOTE <target-slug>` 人工确认和 unsafe content 检查。

---

## 5. 故障速查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| OpenCode 要求粘贴长期 bearer token | 配置中错误添加了 `headers.Authorization` | 删除该字段，改用 `opencode mcp auth gbrain` |
| `redirect_uri` 不匹配 | 服务端注册值不是 OpenCode 固定回调地址 | 撤销错误客户端，重新注册为 `http://127.0.0.1:19876/mcp/oauth/callback` |
| 浏览器访问回调失败 | OpenCode 在远程主机监听 | 使用轨道 4 的 `ssh -L` 转发 |
| `gbrain review list` 报 missing credentials | env 文件不存在或权限不对 | 检查 `~/.config/gbrain/local-read.env` 是否存在且为 `600` |
| 只读客户端能写入 | scope 超出服务端注册值 | 服务端撤销该 client，重新注册只读客户端 |
| 连接超时 | 客户端到 `<server>:3131` 不可达 | 检查路由、防火墙和服务状态；不要把 19876 当作服务端端口 |

---

## 6. 相关文档

- OpenCode 客户端安装部署详情：[docs/mcp/CLIENT_INSTALL_DEPLOYMENT.md](../mcp/CLIENT_INSTALL_DEPLOYMENT.md)
- gbrain CLI 快速上手：[docs/mcp/QUICKSTART.md](../mcp/QUICKSTART.md)
- MCP 协议与 writer 工作流：[docs/mcp/MCP_USAGE_GUIDE.md](../mcp/MCP_USAGE_GUIDE.md)
- MCP Contract 详细规范：[docs/mcp/MCP_CONTRACT.md](../mcp/MCP_CONTRACT.md)
- 客户端规则说明：[agent-rules.md](agent-rules.md)
- 部署总览：[README.md](README.md)
