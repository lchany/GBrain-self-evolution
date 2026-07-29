# GBrain 客户端接入

客户端接入依赖云服务器防火墙白名单，不依赖 `install-client` 分发凭据。

## 安装规则与 skills

```bash
gbrain install-client --json
```

安装器只写入用户级 OpenCode/Codex 规则和两个 skills：

- `gbrain-capture`
- `gbrain-review`

它不会读取、创建或复制 `local-read.env`、`local-writer.env`、Bearer
token、client secret，也不会执行写入探针。

## 验证客户端路径

安装完成后，在已通过云防火墙白名单的客户端中调用 MCP：

```text
get_brain_identity
search
put_page
```

匿名 MCP 客户端只有 `read+write` 权限；admin 操作仍需通过服务器 admin
Basic Auth 或本机管理员 CLI。若调用超时，检查网络白名单和 TLS 反代，不要
把凭据参数重新加回 `install-client`。
