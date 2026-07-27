# OpenCode 客户端安装部署指南

本文档用于把一台 OpenCode 客户端接入已经运行的 GBrain 远程 MCP 服务。客户端操作由用户自行执行；服务端管理员只负责预注册 OAuth 客户端并安全地交付 `client_id`。

**版本范围**：以下配置以 OpenCode 1.18.x 的 v1 配置格式为准，**已在 OpenCode 1.18.4 验证**。建议使用 1.18.4 或更高 1.18.x；更低版本可能缺少 `mcp debug`、`mcp auth list` 等子命令。不要套用 OpenCode v2 的 `mcp.servers` 或 OAuth snake_case 字段。

**v1 实现范围**：
- GBrain 不提供客户端生命周期钩子（lifecycle hook）。所有接入动作都是显式命令或配置步骤。
- 客户端读写凭证通过 `~/.config/gbrain/local-read.env` 和 `local-writer.env` 管理，或通过 `gbrain install-client` 自动安装。
- 默认查询只返回已确认知识，`inbox/` 草稿不会出现在默认结果里。

文中所有地址和名称均为占位符。不要把真实 IP、token、client secret 或原始认证文件写进本文档、聊天记录或 Git。

## 1. 部署结果

完成后应满足：

- OpenCode 通过 `http://<server>:3131/mcp` 连接 GBrain。
- OpenCode 使用浏览器 OAuth `authorization_code` 流程，并可用 `refresh_token` 自动续期。
- 每台客户端使用独立的 OAuth `client_id`，便于单独撤销。
- 默认只授予 `read`；只有明确需要写入知识库的受信任客户端才授予 `read write`。
- OpenCode 配置中不保存 access token、refresh token 或 client secret。
- 命令行脚本（`gbrain` CLI）通过 `~/.config/gbrain/local-read.env` 和 `local-writer.env` 读取 MCP 地址和 `client_credentials`；不要把这两个文件用于 OpenCode 的浏览器 OAuth 流程。

## 2. 角色与占位符

| 占位符 | 含义 | 示例形状 |
| --- | --- | --- |
| `<server>` | GBrain 服务端地址 | 主机名或 IP，不写入仓库 |
| `<client-name>` | 客户端的唯一短名，建议 `用户-主机` 形式 | `alice-workstation-a` |
| `<CLIENT_ID>` | 服务端注册后返回的公开 OAuth client ID | `gbrain_cl_...` |
| `<user>`、`<client-host>` | SSH 登录用户和客户端主机 | 仅用于无浏览器场景 |

操作分工：

1. **服务端管理员**执行第 3 节，返回 `<CLIENT_ID>`。
2. **客户端用户**执行第 4 至第 8 节；移除或卸载时执行第 9.2 或 9.4 节。
3. 服务端管理员仅在撤销客户端时执行第 9.3 节。
4. **命令行用户**如需 `gbrain` CLI 的 `capture`、`review`、`install-client` 等功能，执行第 10 节。

## 3. 服务端管理员：预注册 OpenCode OAuth 客户端

GBrain 的动态客户端注册应保持关闭。不要复用现有的 `local-read` 或 `local-writer`，它们使用 `client_credentials`，不适用于 OpenCode 的浏览器 OAuth 流程。

### 3.1 只读客户端（默认）

在 GBrain 服务端执行：

```bash
/usr/local/bin/gbrain auth register-client "opencode-<client-name>" \
  --grant-types authorization_code,refresh_token \
  --scopes "read" \
  --redirect-uri http://127.0.0.1:19876/mcp/oauth/callback \
  --token-endpoint-auth-method none
```

### 3.2 受信任的读写客户端

只有客户端确实需要调用 `put_page`、`delete_page` 等写工具时才使用：

```bash
/usr/local/bin/gbrain auth register-client "opencode-<client-name>" \
  --grant-types authorization_code,refresh_token \
  --scopes "read write" \
  --redirect-uri http://127.0.0.1:19876/mcp/oauth/callback \
  --token-endpoint-auth-method none
```

命令应显示：

- `Client ID: gbrain_cl_...`
- `Grant types: authorization_code, refresh_token`
- `Token auth method: none`
- `Client Secret: <public client — none issued>`

只把 `Client ID` 交给对应客户端用户。`client_id` 用于标识客户端，不是密码；仍应避免把生产值提交到公共仓库。建议通过一次性加密消息、密码管理器或当面交付，不要在公共聊天或邮件明文粘贴。

**管理员交接清单**：保存 `Client ID`、客户端名称、scope（`read` 或 `read write`）和注册时间。该 client id 是后续第 9.3 节撤销的唯一定位符。

## 4. 客户端：安装或检查 OpenCode

先检查现有安装：

```bash
opencode --version
```

如果尚未安装，使用 OpenCode 官方安装器：

```bash
curl -fsSL https://opencode.ai/install | bash
```

重新打开终端后再次确认：

```bash
opencode --version
```

如果命令仍不可见，按安装器输出把 OpenCode 的 bin 目录加入 `PATH`，不要猜测或创建另一个同名包装脚本。

## 5. 客户端：合并 MCP 配置

编辑全局用户配置 `~/.config/opencode/opencode.json`（Linux/macOS 默认；Windows 用户可执行 `opencode debug paths` 确认全局配置位置）。OpenCode 会合并不同配置层；如果该文件已存在，**只新增或修改 `mcp.gbrain` 字段**，不要整文件覆盖现有 provider、model、plugin、permission 或其他 MCP 配置。

最小可用整文件示例（**已有配置时请只复制 `mcp.gbrain` 这一个对象到现有 `mcp` 字段下**）：

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

读写客户端把 `scope` 改为：

```jsonc
"scope": "read write"
```

配置约束：

- `url` 必须以 `/mcp` 结尾。
- `scope` 不得超过服务端注册范围。
- 公共 PKCE 客户端没有 `clientSecret`，不要添加空值或伪造 secret。
- 不要在 `headers.Authorization` 中写入长期 bearer token。
- 如果使用项目级 `opencode.json`，它可能被提交到 Git；生产 `<CLIENT_ID>` 应优先放在用户配置中。
- 本文使用 OpenCode 1.18.x 的 `clientId`；不要改成 v2 的 `client_id`。
- **OpenCode 的 `clientId` 仅用于 OpenCode 自身的 OAuth 流程；手动 curl/JSON-RPC 或 `gbrain` CLI 必须使用 `local-read`/`local-writer` 的 client_credentials 凭证，不得复用该 `clientId`**。

## 6. 客户端：完成 OAuth 认证

执行：

```bash
opencode mcp auth gbrain
```

OpenCode 会启动本地回调监听器并打开浏览器。授权完成后，浏览器应跳转到：

```text
http://127.0.0.1:19876/mcp/oauth/callback
```

不要手工复制授权码、access token 或 refresh token 到配置文件。OpenCode 自行保存并刷新 OAuth 凭证。

### 6.1 客户端是无桌面的远程主机

**前置条件**：用于打开浏览器的工作站必须能直接访问 `http://<server>:3131`（OAuth 授权/发现端点所在的服务端），同时能够通过 SSH 隧道回连客户端的 `127.0.0.1:19876`。如果工作站与 `<server>:3131` 之间受限（云安全组、内网隔离等），需要先放行或换一台能直连的工作站。

从有浏览器的工作站建立 SSH 本地端口转发，再在同一 SSH 会话中执行认证：

```bash
ssh -L 19876:127.0.0.1:19876 <user>@<client-host>
opencode mcp auth gbrain
```

如果远程主机不能自动打开浏览器，OpenCode 会显示授权 URL。复制该 URL，在建立隧道的工作站浏览器中打开。浏览器访问本机 `127.0.0.1:19876` 时，SSH 会把回调转发到远程客户端上的 OpenCode。

OpenCode 1.18.x 没有内置跨主机回调隧道；这里的 `ssh -L` 是外部端口转发方案。

安全要求：

- 不要在防火墙上开放 19876。
- 不要把回调地址改成客户端的公网 IP。
- 认证完成后退出 SSH 会话即可关闭端口转发。

## 7. 验证部署

### 7.1 查看 MCP 状态

```bash
opencode mcp list
opencode mcp auth list
```

`gbrain` 应显示为已连接或可用，OAuth 状态应为已认证，而不是未认证或失败。

### 7.2 通过真实 OpenCode 会话验证

启动 OpenCode：

```bash
opencode
```

在会话中依次要求：

1. 调用 GBrain 的 `get_brain_identity`。
2. 调用 `search` 搜索一个已知主题，并返回命中的 slug。
3. 让 agent 展示该工具的来源，断言其属于名为 `gbrain` 的 MCP 连接（如果无法在 UI 中确认，可回到 `opencode mcp list` 验证 `gbrain` 已连接）。

OpenCode 1.18.x 的对话工具面不保证直接呈现 MCP prompts/resources，因此不要把“对话中能列出 prompts/resources”作为客户端部署通过条件。服务端自描述能力使用 [MCP 使用与认证指南](MCP_USAGE_GUIDE.md) 中的协议级方法验证。

只读客户端不要用写入操作做生产连接探针。其权限以服务端注册的 `read` scope 为准；**需要验证 scope 隔离时，服务端管理员应使用 [MCP 使用与认证指南](MCP_USAGE_GUIDE.md) 第 2.2 节的 `client_credentials` 流程拿到该只读 client 的 token，然后调用 `put_page`，预期返回 `insufficient_scope` 或 403**。读写客户端必须遵循 [MCP 使用与认证指南](MCP_USAGE_GUIDE.md) 的 search-before-write 工作流：在 OpenCode 中用自然语言指示 agent 先搜索再创建/更新/删除测试页，并立即清理；手动 JSON-RPC 才参考 USAGE 的 curl 示例。

### 7.3 失败判定

以下任一情况都表示部署尚未完成：

- OpenCode 要求粘贴长期 bearer token。
- OAuth 回调报 `redirect_uri` 不匹配。
- `opencode mcp list` 显示未认证、连接失败或找不到 `gbrain`。
- 能读取但 scope 超出服务端注册值，或只读客户端可以成功写入。
- 会话中看不到 GBrain tools，或无法调用 `get_brain_identity` / `search`。

## 8. 常见问题

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| `redirect_uri` 不匹配 | 服务端注册值不是 OpenCode 固定回调地址 | 撤销错误客户端，按第 3 节重新注册；不要直接改数据库 |
| 浏览器访问回调失败 | OpenCode 在远程主机监听，而浏览器在本地工作站 | 使用第 6.1 节的 `ssh -L` 转发 |
| 401 / 未认证 | OAuth 尚未完成、凭证已失效或客户端已撤销 | 重新执行 `opencode mcp auth gbrain` |
| 403 / `insufficient_scope` | 请求工具超出客户端 scope | 使用允许的只读工具；确需写入时由管理员注册新的读写客户端 |
| 连接超时 | 客户端到 `<server>:3131` 的网络路径不可达 | 检查路由、防火墙和服务状态；不要把 19876 当作服务端端口 |
| 找不到 GBrain tools | URL 缺少 `/mcp`，或服务端版本不正确 | 修正 URL；由服务端管理员检查当前部署 |

OAuth 连接仍不清楚时执行：

```bash
opencode mcp debug gbrain
```

该命令用于检查 OAuth discovery、客户端配置和连接阶段，不要把包含凭证的完整调试输出粘贴到公共位置。

## 9. 升级、移除和撤销

### 9.1 升级 OpenCode

```bash
opencode upgrade
opencode --version
opencode mcp list
```

升级后不应重新注册 OAuth 客户端。只有凭证失效时才重新执行 `opencode mcp auth gbrain`。

### 9.2 从一台客户端移除 GBrain

先注销 OAuth：

```bash
opencode mcp logout gbrain
```

然后从 `~/.config/opencode/opencode.json` 删除 `mcp.gbrain`，保留文件中的其他配置。再次执行：

```bash
opencode mcp list
```

列表中不应再出现 `gbrain`。

### 9.3 服务端撤销该客户端

移除客户端配置不会撤销服务端授权。客户端永久退役或设备丢失时，服务端管理员使用注册输出中的完整 client ID 执行：

```bash
/usr/local/bin/gbrain auth revoke-client "<CLIENT_ID>"
```

每台机器独立注册后，撤销一台不会影响其他客户端。

### 9.4 完全卸载 OpenCode

只有不再使用 OpenCode 本身时才执行官方卸载命令：

```bash
opencode uninstall --dry-run
opencode uninstall
```

`opencode uninstall` 会删除 OpenCode 及其相关文件；先用 `--dry-run` 查看范围。卸载 OpenCode 与撤销 GBrain OAuth 客户端是两个动作。设备退役时仍需完成第 9.3 节。

## 10. 命令行客户端：gbrain CLI

如果需要通过命令行捕获、审核和管理 GBrain 知识，除了 OpenCode MCP 外还需要安装 `gbrain` CLI 的本地凭证和 rules/skills。

### 10.1 快速安装：gbrain install-client

```bash
# 先复制服务端预置的 client_credentials 文件到临时位置
sudo install -m 0600 /etc/gbrain/clients/local-read.env /tmp/local-read.env
sudo install -m 0600 /etc/gbrain/clients/local-writer.env /tmp/local-writer.env

# 运行安装器
bunx gbrain install-client \
  --read-env-source /tmp/local-read.env \
  --writer-env-source /tmp/local-writer.env \
  --json
```

安装器会：
- 把 env 文件复制到 `~/.config/gbrain/local-read.env` 和 `local-writer.env`，权限设为 `600`。
- 在 OpenCode 和 Codex 用户级配置中写入 GBrain 规则块。
- 安装 `gbrain-capture` 和 `gbrain-review` 技能文件。
- 执行 `get_brain_identity`、`put_page`、`get_page`、`delete_page` 探针并立即删除探针。

输出永远被脱敏处理，不会打印 token、client secret 或 MCP URL。

### 10.2 手动安装凭证

如果不使用 `install-client`，请按 [MCP_USAGE_GUIDE.md](MCP_USAGE_GUIDE.md) 第 2.1 节把 `local-read.env` 和 `local-writer.env` 放到 `~/.config/gbrain/`，然后手动安装 `gbrain-capture` 和 `gbrain-review` 技能文件。

### 10.3 命令行读取/写入模型

- `local-read.env` 用于 `gbrain review list/show/plan/verify` 等只读操作。
- `local-writer.env` 用于 `gbrain capture`、`gbrain review keep/promote/merge/reject/needs-evidence/repair/cleanup` 等写操作。
- 两个 env 文件使用 `client_credentials` 换 token，与 OpenCode 的浏览器 OAuth 凭证完全隔离。
- 写操作会经过 `search-before-create` 门禁、`PROMOTE <target-slug>` 人工确认和 unsafe content 检查。

## 11. 最终检查表

- [ ] 每台客户端有独立的 `client_id`。
- [ ] grant types 为 `authorization_code,refresh_token`。
- [ ] token endpoint auth method 为 `none`，未签发 client secret。
- [ ] redirect URI 精确为 `http://127.0.0.1:19876/mcp/oauth/callback`。
- [ ] OpenCode 配置只合并了 `mcp.gbrain`，没有覆盖原配置。
- [ ] 配置、文档和 Git 中没有 token 或 secret。
- [ ] `opencode mcp list` 显示 GBrain 可用。
- [ ] 真实 OpenCode 会话能调用 `get_brain_identity` 和 `search`。
- [ ] 只读客户端无法写入；读写客户端遵循 search-before-write。
- [ ] 命令行 `gbrain install-client` 或手动安装完成，env 文件权限为 `600`。
- [ ] 命令行 `gbrain review list` 和 `gbrain capture` 能正常工作。
- [ ] 退役流程同时覆盖客户端注销、配置删除和服务端撤销。

## 12. 相关文档

- 手动 JSON-RPC、scope 与 writer 工作流：[MCP_USAGE_GUIDE.md](MCP_USAGE_GUIDE.md)
- 快速上手：[QUICKSTART.md](QUICKSTART.md)
- MCP Contract 详细规范：[MCP_CONTRACT.md](MCP_CONTRACT.md)
- Web UI 审核流程：[WEB_UI_REVIEW.md](WEB_UI_REVIEW.md)
- 失败恢复与离线重试：[FAILURE_RECOVERY.md](FAILURE_RECOVERY.md)
- GBrain 页面 schema：`../../source/SCHEMA.md`
- 服务端运维：`../../runbook/OPERATIONS.md`
