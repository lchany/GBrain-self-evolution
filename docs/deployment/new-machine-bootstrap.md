# GBrain 新机器部署

## 1. 准备源码与数据库

```bash
git clone --branch gbrain-review-ui --single-branch \
  https://github.com/lchany/GBrain-self-evolution.git /opt/gbrain
cd /opt/gbrain
bun install --frozen-lockfile
bun run build:admin-embedded
bun run build
sudo install -m 0755 bin/gbrain /usr/local/bin/gbrain
```

不要从 `garrytan/gbrain` 部署此服务。部署前确认：

```bash
git remote get-url origin
git branch --show-current
/usr/local/bin/gbrain serve --help | grep allow-anonymous-mcp
```

预期仓库为 `lchany/GBrain-self-evolution`，分支为 `gbrain-review-ui`，
并且帮助中包含 `--allow-anonymous-mcp`。

准备 PostgreSQL/pgvector，按本项目现有 `gbrain init` 文档初始化数据库，
并执行 `gbrain doctor`。不要把 `DATABASE_URL` 写入本仓库。

## 2. 安装服务模板

```bash
sudo install -d -m 0755 /etc/gbrain
sudo install -m 0644 deploy/systemd/gbrain-serve-http.service.example \
  /etc/systemd/system/gbrain-serve-http.service
sudo install -m 0600 deploy/env/gbrain-serve.env.example \
  /etc/gbrain/gbrain-serve.env
sudo rm -f /etc/systemd/system/gbrain-serve-http.service.d/20-http-basic.conf
sudo systemctl daemon-reload
```

编辑 `/etc/gbrain/gbrain-serve.env`，至少填写：

- `GBRAIN_PUBLIC_URL`：TLS 反代后的 HTTPS 地址。
- `GBRAIN_HOME`：服务用户的数据目录父目录，配置实际位于
  `/var/lib/gbrain/.gbrain/`。
- `GBRAIN_ADMIN_BASIC_USER` 和 `GBRAIN_ADMIN_BASIC_PASSWORD`：admin/review Basic Auth。
- `GBRAIN_ADMIN_ORIGIN`：浏览器实际访问 admin/review 的精确 origin。
- `GBRAIN_HTTP_BIND`：反代在同机时使用 `127.0.0.1`。

服务模板显式启用 `--allow-anonymous-mcp`。这表示云防火墙已完成源地址
白名单后，白名单客户端可以直接调用 read/write MCP；admin scope 不会被
匿名请求获得。不要在未配置云防火墙和 TLS 终止前把服务绑定到公网接口。

```bash
sudo systemctl enable --now gbrain-serve-http.service
sudo deploy/scripts/verify-server.sh
```

如果已有旧的脏源码目录，先保留它，再把目标分支 clone 到独立目录；不要
在脏工作树上直接 build。`bootstrap-server.sh --apply` 会拒绝错误仓库、错误
分支和脏工作树，创建 `gbrain` 服务用户，将旧 `/root/.gbrain` 配置迁移到
`/var/lib/gbrain`（目标目录不存在时），修正知识库目录权限，并在目标
checkout 内重新构建和安装二进制。

## 3. 云防火墙和 TLS 要求

- 云防火墙只放行受信任客户端源地址到 TLS 入口。
- TLS 反代把请求转发到本机 `127.0.0.1:3131`。
- `GBRAIN_PUBLIC_URL` 与浏览器访问的 HTTPS origin 必须一致。
- 不要设置会信任不受控 `X-Forwarded-For` 的 proxy 配置。

## 4. 排障

- `/health` 非 200：先检查数据库连接和 migration/doctor 输出。
- `GET /mcp` 非 405：服务未正确监听或请求未到达 GBrain。
- admin/review 返回 401：检查 Basic Auth 用户名、密码和浏览器发送的认证头。
- review POST 返回 403：检查 `GBRAIN_ADMIN_ORIGIN` 是否与浏览器 origin 精确相等。
- 客户端连接超时：检查云防火墙白名单、TLS 反代和 DNS，不要向客户端安装器添加凭据参数。
