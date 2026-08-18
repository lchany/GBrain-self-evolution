# 防火墙白名单内免登录 MCP 恢复设计

## 背景

生产服务器升级到 GBrain `0.46.18.0` 后，部署 wrapper 移除了旧版启动参数
`--allow-anonymous-mcp`。服务因此开始要求 Bearer/OAuth，Codex 在没有凭据时显示
“MCP server is not logged in”。这违反了已经确认的部署约定：客户端网络访问由云防火墙
白名单控制，Codex 和 OpenCode 不注册、不登录、不接收长期凭据。

本次修复只恢复这个既有契约，不启用 DCR，不创建或分发 Token，也不改变管理员审核认证。

## 采用方案

复用仓库中已经提交的实现，而不是新建一套认证旁路：

- `8587167` 提供显式 `allowAnonymousMcp` 模式、匿名 `AuthInfo` 和操作目录过滤。
- `b9427f1` 让部署 wrapper 显式启用该模式，并验证真实匿名 MCP 端点。

该模式默认关闭。只有生产 wrapper 明确传入 `--allow-anonymous-mcp` 时才生效。

## 权限与信任边界

免登录只适用于 `/mcp`。匿名请求取得固定身份：

- `clientId`/`clientName`: `cloud-firewall-allowlist`
- scopes: `read`, `write`
- `sourceId`: `default`
- operation context: `remote: true`

服务在发布工具目录时同时过滤操作，只保留非 `localOnly` 且 scope 为 `read` 或 `write`
的工具。因此匿名客户端不能获得 `admin`、`agent`、`sources_admin`、`users_admin`，也不能
调用本机专用操作。工具层原有参数校验、内容安全检查、来源路由和写入规则继续生效。

以下入口不变：

- `/admin` 与审核页面继续要求 Basic Auth。
- 审核写入继续使用服务器内部 writer credential 和 `whoami` 来源证明。
- webhook 等独立写入口继续要求其原有 OAuth scope。
- OAuth 元数据和已注册客户端继续可用，但客户端不再被强制要求登录。

## 部署方式

只向隔离的 `v0.46.18.0` 候选树合入上述最小提交内容，保留已经部署的审核 UI、安全日志、
Basic Auth、Origin 校验和 loopback writer 修复。不得修改远端 `/opt/gbrain` 脏工作区，
不得复制本地 `src/cli.ts` 中无关的未提交改动。

候选验证通过后，先备份当前二进制与 wrapper，再原子替换并重启 systemd。回滚只需恢复
上一份二进制和 wrapper。

## 验收标准

1. 不带 Authorization 的 MCP `initialize` 返回成功，不再返回 401。
2. 无凭据客户端能调用 `whoami` 和 `search`，身份为固定白名单匿名身份、来源为 `default`。
3. 匿名 `tools/list` 不包含 admin、用户/来源管理、agent 或 local-only 工具。
4. 选择一个无副作用或可逆的 write 调用验证 `write` scope，随后清理测试数据。
5. `/admin/review` 无 Basic Auth 仍返回 401，正确 Basic Auth 返回 200。
6. DCR 保持关闭，Codex 无需执行 `codex mcp login gbrain`。
7. 服务健康、审核分类 UI 和内部 writer 回归测试继续通过。

## 已知风险

该方案把网络身份边界交给云防火墙。任何进入白名单网络路径的调用者都拥有 GBrain
`read + write` 权限，因此防火墙规则必须保持最小化。当前生产端点仍是明文 HTTP；白名单
限制可达性，但不等同于 TLS 加密。本次修复不扩大到 TLS 迁移，后续应单独规划 HTTPS。
