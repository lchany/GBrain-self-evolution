# GBrain 服务器新机器启动指南

本文档面向需要在一台全新 Linux 服务器上从零部署 GBrain 自进化知识沉淀体系的操作人员。按顺序执行后，应能得到与生产环境一致的运行态：HTTP MCP 服务、只读 Web UI、定时同步与 doctor 服务，以及预注册的 OAuth 客户端。

**边界说明**：

- 这是一份服务器端部署指南，不涉及客户端 OpenCode 配置。客户端接入请见 `docs/mcp/CLIENT_INSTALL_DEPLOYMENT.md`。
- 本文不处理云防火墙/安全组。端口 3131（HTTP MCP）和 3132（Web UI）的源 IP 限制必须在云提供商控制台完成，见第 14 节安全边界。
- 所有命令示例中的 `<server>`、`<DB_PASSWORD>`、`<CLIENT_ID>`、`<CLIENT_SECRET>` 均为占位符，不要把真实值写进本文档或仓库。

---

## 0. 前置假设

目标机器应满足以下条件：

- Linux 发行版，使用 systemd 作为 init 系统。
- 已拥有 root 或 sudo 权限。
- 已安装 `git`。
- 已安装 Bun（推荐 1.x 最新稳定版）。验证方式：

  ```bash
  command -v bun
  bun --version
  ```

  如果未安装，参考 <https://bun.sh/docs/installation>。
- 已安装 PostgreSQL 15 并启动，且已安装与当前 PostgreSQL 版本兼容的 `pgvector` 扩展。
- 机器对 `github.com` 有出站访问，用于克隆上游仓库。
- 云防火墙/安全组已规划：仅允许可信源 IP 访问 3131/3132，所有其他源 IP 应被拒绝。

---

## 1. 克隆归档仓库

在服务器上选择工作目录，克隆 `GBrain-self-evolution` 归档仓库。该仓库包含源码补丁、客户端规则、技能和部署模板。

```bash
git clone https://github.com/lchany/GBrain-self-evolution.git /opt/gbrain-self-evolution
```

后续所有补丁和模板都从这里读取。不要把它当作运行时目录，最终可执行文件和知识源应放在 `/opt/gbrain` 和 `/opt/gbrain-knowledge`。

---

## 2. 克隆 GBrain 上游并应用补丁

这一步是**把补丁应用到 GBrain 源码检出**，而不是直接写入 `/opt/gbrain`。先在临时构建目录完成源码准备，再在第 5 步同步到 `/opt/gbrain`。

```bash
cd /opt/gbrain-self-evolution
git clone https://github.com/garrytan/gbrain.git gbrain-checkout
cd gbrain-checkout
git checkout 1fabbb9849f23703ee2898699868ce8101e7b61d

# 先检查补丁是否可应用
git apply --check ../patches/gbrain-self-evolution.patch

# 应用补丁
git apply ../patches/gbrain-self-evolution.patch
```

如果 `git apply --check` 报错，先不要强制执行。检查上游基线是否已变动，或补丁路径是否相对于当前目录正确。

---

## 3. 可选：克隆 oh-my-openagent 基线并应用补丁

仅当你需要维护客户端规则、技能或 AGENTS 规则源时才执行。运行时不需要这份源码，但补丁后的源码是生成客户端分发包的来源。

```bash
cd /opt/gbrain-self-evolution
git clone https://github.com/code-yeongyu/oh-my-openagent.git omo-checkout
cd omo-checkout
git checkout e3556c35d2c3879aeec1d7043ecc52e37bf1d3d3

git apply --check ../patches/oh-my-openagent-gbrain.patch
git apply ../patches/oh-my-openagent-gbrain.patch
```

如果不需要修改客户端规则，可以跳过此步。

---

## 4. 安装依赖

在第 2 步准备的 GBrain 源码目录中安装依赖。

```bash
cd /opt/gbrain-self-evolution/gbrain-checkout
bun install
```

Bun 会直接运行 TypeScript 源码，无需单独的构建产物。

---

## 5. 创建 /opt/gbrain 布局和 /usr/local/bin/gbrain 包装器

把补丁后的 GBrain 源码同步到运行目录，并创建全局可执行包装器。

```bash
# 创建运行时目录
sudo mkdir -p /opt/gbrain

# 同步源码。保留 .git 以便后续升级 diff；也可用 rsync 排除 node_modules
sudo rsync -a --delete \
  --exclude='node_modules' \
  --exclude='.omo' \
  --exclude='dist' \
  /opt/gbrain-self-evolution/gbrain-checkout/ /opt/gbrain/

# 重新在 /opt/gbrain 安装依赖
sudo -H bun install --cwd /opt/gbrain

# 创建全局包装器
sudo tee /usr/local/bin/gbrain >/dev/null <<'EOF'
#!/bin/sh
exec /root/.bun/bin/bun /opt/gbrain/src/cli.ts "$@"
EOF

sudo chmod +x /usr/local/bin/gbrain
```

> 说明：上面的包装器使用 `/root/.bun/bin/bun`。如果你的 Bun 安装路径不同，先用 `command -v bun` 确认，并替换为实际路径。如果机器上只有单个 Bun 安装，也可以写成：
>
> ```bash
> #!/bin/sh
> exec "$(command -v bun)" /opt/gbrain/src/cli.ts "$@"
> ```
>
> 但生产环境通常固定为 root 安装路径，避免 PATH 差异导致服务启动失败。

验证：

```bash
/usr/local/bin/gbrain --version
/usr/local/bin/gbrain doctor
```

---

## 6. 创建 Postgres 角色与数据库

以能创建角色和数据库的 PostgreSQL 超级用户登录，执行：

```bash
sudo -u postgres psql <<'EOF'
CREATE ROLE gbrain WITH LOGIN PASSWORD '<DB_PASSWORD>' SUPERUSER BYPASSRLS;
CREATE DATABASE gbrain OWNER gbrain;
EOF
```

- `SUPERUSER` 和 `BYPASSRLS` 只在初始化 schema 期间需要。GBrain 的 migration 会创建扩展、表和函数，完成后应收回额外权限。
- 最小权限保留策略：在 `gbrain init` 成功后，根据当前 GBrain 版本文档确认最低权限，通常可保留 `LOGIN`、`CREATEDB`、`CONNECT`、`TEMP` 以及对 GBrain 表的常规读写权限。

数据库连接 URL 格式：

```text
postgresql://gbrain:<DB_PASSWORD>@localhost:5432/gbrain
```

这个 URL 只在内存和配置文件中使用，不要写入任何 Markdown 或仓库文件。

---

## 7. 初始化 GBrain

设置 `GBRAIN_HOME` 和 `GBRAIN_DATABASE_URL`，然后运行非交互式初始化。

```bash
export GBRAIN_HOME=/root/.gbrain
export GBRAIN_DATABASE_URL=postgresql://gbrain:<DB_PASSWORD>@localhost:5432/gbrain

/usr/local/bin/gbrain init --non-interactive --no-embedding --json
```

- `--no-embedding` 避免首次初始化时触发外部嵌入 API 调用。
- 初始化会创建 `~/.gbrain/config.json`，其中包含 `engine`、`database_url` 和 `schema_pack`。

初始化完成后，确认 doctor 没有严重报错：

```bash
/usr/local/bin/gbrain doctor
```

---

## 8. 准备知识源仓库并执行全量无嵌入同步

创建知识源目录，把 `GBrain-self-evolution` 归档中的知识源复制到 `/opt/gbrain-knowledge/source`：

```bash
sudo mkdir -p /opt/gbrain-knowledge/source
sudo rsync -a --delete \
  /opt/gbrain-self-evolution/docs/knowledge-source/ \
  /opt/gbrain-knowledge/source/

# 确保后续 gbrain 进程可以读写
sudo chown -R root:root /opt/gbrain-knowledge
```

执行全量同步，不拉取、不嵌入：

```bash
export GBRAIN_HOME=/root/.gbrain
export GBRAIN_DATABASE_URL=postgresql://gbrain:<DB_PASSWORD>@localhost:5432/gbrain

/usr/local/bin/gbrain sync \
  --repo /opt/gbrain-knowledge/source \
  --full --no-pull --no-embed --yes

/usr/local/bin/gbrain stats
```

- `--full` 表示全量导入，不是增量 Git checkpoint。
- `--no-pull` 表示不尝试从远程拉取，适合本地知识源。
- `--no-embed` 跳过嵌入生成，后续可由定时任务或手动命令补做。

---

## 9. 安装环境变量模板与 systemd 单元

归档中的 `deploy/env/*.example` 和 `deploy/systemd/*.example` 由并行任务维护。你需要把它们复制到系统位置并填入实际值。

### 9.1 环境变量文件

```bash
sudo mkdir -p /etc/gbrain/clients
sudo chmod 0700 /etc/gbrain

sudo cp /opt/gbrain-self-evolution/deploy/env/gbrain-serve.env.example /etc/gbrain/gbrain-serve.env
sudo cp /opt/gbrain-self-evolution/deploy/env/gbrain-maintenance.env.example /etc/gbrain/gbrain-maintenance.env
sudo cp /opt/gbrain-self-evolution/deploy/env/webui.env.example /etc/gbrain/webui.env
sudo cp /opt/gbrain-self-evolution/deploy/env/local-read.env.example /etc/gbrain/clients/local-read.env
sudo cp /opt/gbrain-self-evolution/deploy/env/local-writer.env.example /etc/gbrain/clients/local-writer.env

sudo chmod 0600 /etc/gbrain/*.env /etc/gbrain/clients/*.env
```

每个 env 文件至少包含：

- `GBRAIN_HOME=/root/.gbrain`
- `GBRAIN_DATABASE_URL=postgresql://gbrain:<DB_PASSWORD>@localhost:5432/gbrain`
- 服务端口与绑定地址（见第 13 节）
- OAuth 客户端的 `CLIENT_ID` 和 `CLIENT_SECRET`（见第 10 节）

> 注意：这些文件权限必须为 `0600`，且归 root 所有。不要把真实值写进归档仓库或本文档。

### 9.2 systemd 单元文件

```bash
sudo cp /opt/gbrain-self-evolution/deploy/systemd/gbrain-serve-http.service.example /etc/systemd/system/gbrain-serve-http.service
sudo cp /opt/gbrain-self-evolution/deploy/systemd/gbrain-webui.service.example /etc/systemd/system/gbrain-webui.service
sudo cp /opt/gbrain-self-evolution/deploy/systemd/gbrain-sync.service.example /etc/systemd/system/gbrain-sync.service
sudo cp /opt/gbrain-self-evolution/deploy/systemd/gbrain-sync.timer.example /etc/systemd/system/gbrain-sync.timer
sudo cp /opt/gbrain-self-evolution/deploy/systemd/gbrain-doctor.service.example /etc/systemd/system/gbrain-doctor.service
sudo cp /opt/gbrain-self-evolution/deploy/systemd/gbrain-doctor.timer.example /etc/systemd/system/gbrain-doctor.timer

sudo systemctl daemon-reload
```

服务清单：

| 服务 | 端口 | 说明 |
| --- | --- | --- |
| `gbrain-serve-http.service` | 3131 | HTTP MCP 服务 |
| `gbrain-webui.service` | 3132 | 只读 Web UI |
| `gbrain-sync.service` + `gbrain-sync.timer` | - | 增量同步（不要在这里加 `--full`） |
| `gbrain-doctor.service` + `gbrain-doctor.timer` | - | 定时健康检查 |

`ExecStart` 示例：

```ini
ExecStart=/usr/local/bin/gbrain serve --http --port 3131 --bind <bind-address>
```

---

## 10. 注册 OAuth 客户端

GBrain 的动态客户端注册应保持关闭。你需要手动注册三类客户端。

### 10.1 浏览器客户端（供 OpenCode 使用）

为每个客户端分别注册。默认只读：

```bash
/usr/local/bin/gbrain auth register-client "opencode-<client-name>" \
  --grant-types authorization_code,refresh_token \
  --scopes "read" \
  --redirect-uri http://127.0.0.1:19876/mcp/oauth/callback \
  --token-endpoint-auth-method none
```

需要写入权限的受信任客户端：

```bash
/usr/local/bin/gbrain auth register-client "opencode-<client-name>" \
  --grant-types authorization_code,refresh_token \
  --scopes "read write" \
  --redirect-uri http://127.0.0.1:19876/mcp/oauth/callback \
  --token-endpoint-auth-method none
```

- 输出中的 `Client ID` 应交付给对应客户端用户。
- 这类客户端没有 `client_secret`，redirect URI 必须固定为 `http://127.0.0.1:19876/mcp/oauth/callback`。

### 10.2 本地命令行客户端

```bash
/usr/local/bin/gbrain auth register-client local-read \
  --grant-types client_credentials \
  --scopes "read"

/usr/local/bin/gbrain auth register-client local-writer \
  --grant-types client_credentials \
  --scopes "read write"
```

将返回的 `client_id` 和 `client_secret` 写入：

- `/etc/gbrain/clients/local-read.env`
- `/etc/gbrain/clients/local-writer.env`

格式示例：

```bash
export GBRAIN_MCP_URL=http://127.0.0.1:3131/mcp
export GBRAIN_TOKEN_ENDPOINT=http://127.0.0.1:3131/token
export GBRAIN_CLIENT_ID=<CLIENT_ID>
export GBRAIN_CLIENT_SECRET=<CLIENT_SECRET>
export GBRAIN_SCOPES=read
```

`local-writer.env` 中 `GBRAIN_SCOPES="read write"`。保存后再次确认权限：

```bash
sudo chmod 0600 /etc/gbrain/clients/*.env
sudo chown root:root /etc/gbrain/clients/*.env
```

---

## 11. 启动并启用服务

```bash
sudo systemctl enable --now gbrain-serve-http.service
sudo systemctl enable --now gbrain-webui.service
sudo systemctl enable --now gbrain-sync.timer
sudo systemctl enable --now gbrain-doctor.timer
```

> `systemctl status active` 只表示 systemd 认为服务已启动，不等于端口已经监听。必须做 readiness probe。

### 11.1 Readiness probe 循环

以下脚本检查 `/mcp` 端口是否真正可用，期望 HTTP 405 或 401（表示服务已启动，拒绝非 POST 请求），而不是 connection refused。

```bash
URL="http://127.0.0.1:3131/mcp"
for i in 1 2 3 4 5 6 7 8; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$URL" || echo "000")
  if [ "$code" = "405" ] || [ "$code" = "401" ]; then
    echo "ready (HTTP $code)"
    exit 0
  fi
  echo "not ready (HTTP $code), waiting ${i}s..."
  sleep "$i"
done
echo "timeout"
exit 1
```

Web UI（3132）可类似检查，期望返回 200：

```bash
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3132
```

---

## 12. 实时冒烟测试

冒烟测试应在服务器本地执行，使用 `local-read` 凭证。不要暴露真实 token。

### 12.1 换取只读 token

```bash
set -a
source /etc/gbrain/clients/local-read.env
set +a

TOKEN=$(curl -sS -X POST "$GBRAIN_TOKEN_ENDPOINT" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "client_id=$GBRAIN_CLIENT_ID" \
  --data-urlencode "client_secret=$GBRAIN_CLIENT_SECRET" \
  --data-urlencode "scope=$GBRAIN_SCOPES" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
```

### 12.2 检查 /mcp 方法行为

GET 请求应返回 405：

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3131/mcp
# 期望：405
```

### 12.3 默认 list_pages 不应返回 inbox 草稿

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_pages","arguments":{"limit":50}},"id":1}' \
  http://127.0.0.1:3131/mcp
```

期望：结果中 `inbox/` 前缀的 slug 数量为 0。

### 12.4 显式 include_prefixes 可列出草稿

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_pages","arguments":{"include_prefixes":["inbox/"],"limit":50}},"id":2}' \
  http://127.0.0.1:3131/mcp
```

期望：结果中至少包含若干 `inbox/` 草稿（数量取决于实际知识源）。

### 12.5 读取正式页面

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_page","arguments":{"slug":"<known-formal-slug>"}},"id":3}' \
  http://127.0.0.1:3131/mcp
```

替换 `<known-formal-slug>` 为知识源中确认存在的正式 slug，例如 `knowledge/mcp-usage-guide`。

### 12.6 只读 token 写入应返回 insufficient_scope

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc":"2.0",
    "method":"tools/call",
    "params":{
      "name":"put_page",
      "arguments":{
        "slug":"inbox/smoke-test-read-token",
        "content":"---\ntype: knowledge\ndate: 2026-07-27\nstatus: draft\nsensitivity: internal\nverification: unverified\n---\n\n# smoke test\n\nThis page should be rejected.\n"
      }
    },
    "id":4
  }' \
  http://127.0.0.1:3131/mcp
```

期望：响应包含 `insufficient_scope` 或 403 类错误，不会写入任何内容。

---

## 13. 暴露到非回环地址

默认 `gbrain serve --http` 只监听 `127.0.0.1`。如果你需要让其他机器访问（例如云服务器上的 OpenCode 客户端），必须显式指定 `--bind` 和 `--public-url`。

```bash
# 只监听回环，仅本地客户端可用
/usr/local/bin/gbrain serve --http --port 3131

# 监听所有接口，配合反向代理或公网 IP
/usr/local/bin/gbrain serve --http --port 3131 --bind 0.0.0.0 --public-url http://<server>:3131
```

- `--public-url` 用于 OAuth discovery 元数据中的 issuer URL，必须与客户端实际访问的地址一致。
- 即使使用 `--bind 0.0.0.0`，也不要依赖主机防火墙做源 IP 限制。访问边界必须在云防火墙/安全组完成。
- 不要在没有 TLS 的情况下直接暴露公网。生产环境应通过 HTTPS 反向代理（如 nginx、Caddy、云负载均衡）转发，并把 `--public-url` 设为 HTTPS 地址。

MCP 端点统一为：

```text
http://<server>:3131/mcp
```

---

## 14. 回滚与安全边界

### 14.1 不要恢复历史主机防火墙单元

- 源 IP 限制唯一可信边界是云防火墙/安全组。
- 不要在主机上创建或恢复 `gbrain-firewall` 相关的 systemd 单元、`iptables`、`nftables` 或 `firewalld` 规则。

### 14.2 不要保留旧 token 明文

- 备份、证据或恢复包中不应包含数据库 URL、密码、`client_id`/`client_secret`、bearer token 或刷新 token。
- 需要恢复客户端时，优先重新注册 OAuth 客户端并删除旧凭证文件。

### 14.3 回滚步骤

如果部署失败需要回滚：

1. 停止并禁用服务：

   ```bash
   sudo systemctl disable --now gbrain-serve-http.service gbrain-webui.service
   sudo systemctl disable --now gbrain-sync.timer gbrain-doctor.timer
   ```

2. 保留 `/opt/gbrain` 和 `/opt/gbrain-knowledge/source` 的副本用于排查，然后删除或重命名。
3. 如果数据库已初始化且需要完全重建，可 drop 后重建，然后重新执行第 6 至 8 步。
4. 撤销本次注册的 OAuth 客户端：

   ```bash
   /usr/local/bin/gbrain auth revoke-client "<CLIENT_ID>"
   ```

5. 不要撤销 `local-read`/`local-writer` 的 `client_id` 除非你能够立即重新注册并更新所有 env 文件，否则服务会中断。

---

## 15. 最终检查表

- [ ] 前置条件：systemd、git、Bun、PostgreSQL 15 + pgvector、出站访问 github.com 已就绪。
- [ ] 已克隆 `GBrain-self-evolution` 归档到 `/opt/gbrain-self-evolution`。
- [ ] 已克隆 GBrain 上游到 `/opt/gbrain-self-evolution/gbrain-checkout` 并 checkout 到 `1fabbb9849f23703ee2898699868ce8101e7b61d`。
- [ ] `git apply --check` 通过后，已应用 `patches/gbrain-self-evolution.patch`。
- [ ] 可选：已按需要 checkout oh-my-openagent 到 `e3556c35d2c3879aeec1d7043ecc52e37bf1d3d3` 并应用其补丁。
- [ ] 在 `/opt/gbrain` 执行 `bun install` 成功。
- [ ] `/usr/local/bin/gbrain` 包装器存在且可执行，内容指向 `/opt/gbrain/src/cli.ts` 和实际 Bun 路径。
- [ ] 已创建数据库角色和数据库，初始化期间拥有 `SUPERUSER` 和 `BYPASSRLS`，并计划初始化后收紧权限。
- [ ] `gbrain init --non-interactive --no-embedding` 成功。
- [ ] 已创建 `/opt/gbrain-knowledge/source` 并执行 `gbrain sync --repo /opt/gbrain-knowledge/source --full --no-pull --no-embed --yes`。
- [ ] 已安装 `/etc/gbrain/*.env` 和 `/etc/gbrain/clients/*.env`，权限 `0600`，所有真实值已填入占位符。
- [ ] 已安装 systemd 单元文件并执行 `daemon-reload`。
- [ ] 已注册 OpenCode 浏览器客户端（authorization_code + refresh_token，redirect URI 正确，无 client secret）。
- [ ] 已注册 `local-read` 和 `local-writer` client_credentials 客户端，并写入 `/etc/gbrain/clients/`。
- [ ] 已启动并启用所有服务，readiness probe 通过（`/mcp` 返回 405/401）。
- [ ] 实时冒烟通过：GET `/mcp` 返回 405；默认 `list_pages` 无 `inbox/`；显式 `include_prefixes` 可见草稿；`get_page` 正常；只读 token 写入返回 `insufficient_scope`。
- [ ] 如果暴露非回环，已配置 `--bind 0.0.0.0` 和 `--public-url`，且云防火墙已限制源 IP。
- [ ] 文档、env 文件和备份中没有任何真实 IP、token、密码或 client secret。

---

## 16. 相关文档

- 客户端接入与 OpenCode 配置：`docs/mcp/CLIENT_INSTALL_DEPLOYMENT.md`
- 手动 JSON-RPC 与 scope 边界：`docs/mcp/MCP_USAGE_GUIDE.md`
- 快速写入与审核流程：`docs/mcp/QUICKSTART.md`
- 日常运维与恢复：`docs/OPERATIONS.md`
- 客户端规则与技能：`rules/`、`skills/`
