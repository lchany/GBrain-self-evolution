# GBrain 部署入口

## 服务端

新机器部署按以下顺序执行：

1. 安装 Bun、PostgreSQL/pgvector 和 systemd 依赖。
2. clone 本仓库并执行 `bun install`。
3. 初始化 GBrain 数据库和知识源。
4. 复制 `deploy/env/gbrain-serve.env.example` 为 root-owned、0600 的环境文件，填写 Basic Auth 和 admin origin。
5. 用 `deploy/systemd/gbrain-serve-http.service.example` 安装服务并执行 `systemctl daemon-reload`。
6. 确认云服务器防火墙只允许受信任客户端源地址，并由 TLS 反向代理终止 HTTPS。
7. 执行 `deploy/scripts/verify-server.sh`，确认 `/health` 为 200、`GET /mcp` 为 405。

服务使用 `--allow-anonymous-mcp` 时，白名单客户端获得匿名 `read+write`
权限；admin 操作和 `/admin/review` 仍由 Basic Auth 保护。

## 客户端

客户端不需要从 `install-client` 获取凭据。执行：

```bash
gbrain install-client --json
```

或在隔离的目标 home 中执行：

```bash
deploy/scripts/install-client-assets.sh --home "$HOME" --apply
```

这两个入口只安装规则与 `gbrain-capture`、`gbrain-review` skills，不读写
credential env，不执行写入探针。客户端能否连接由云服务器防火墙白名单和
网络路由决定。

## 明确不做的事

- 不把真实 IP、密码、token、client secret 或 auth/env 文件提交到仓库。
- 不安装 OpenCode/Codex lifecycle hook。
- 不通过客户端安装器创建或分发凭据。
- 不把 admin 权限授予匿名 MCP 客户端。
