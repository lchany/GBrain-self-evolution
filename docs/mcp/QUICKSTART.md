# GBrain 快速上手

本指南面向已经部署好 GBrain 服务、需要马上开始写入和审核知识的用户。所有命令示例均可在 Linux/macOS 终端直接复制执行。

**核心占位符**：`<server>` 替换为实际服务器地址，不要写入真实 IP、token 或 secret。

**v1 边界**：
- 默认查询不包含 `inbox/` 草稿。
- 没有 lifecycle hook，所有步骤都要显式执行。
- 升级通用经验必须人工输入 `PROMOTE <target-slug>`。

---

## 1. 前置条件

- 已安装 `gbrain` CLI（源码运行：`bun run src/cli.ts <cmd>`；全局安装：`gbrain <cmd>`）。
- `~/.config/gbrain/local-read.env` 和 `local-writer.env` 已存在，权限 `600`。
- 服务健康：`gbrain review list` 能返回空列表或草稿列表。

如果还没有 env 文件，可让服务端管理员执行：

```bash
sudo install -m 0600 /etc/gbrain/clients/local-read.env ~/.config/gbrain/local-read.env
sudo install -m 0600 /etc/gbrain/clients/local-writer.env ~/.config/gbrain/local-writer.env
```

或者用 `gbrain install-client` 自动安装：

```bash
gbrain install-client \
  --read-env-source /tmp/local-read.env \
  --writer-env-source /tmp/local-writer.env \
  --json
```

---

## 2. 查询已有知识

### 2.1 语义+关键词混合查询

```bash
gbrain query "MCP 写入规范" --limit 10
```

### 2.2 关键词搜索

```bash
gbrain search "MCP" --limit 10
```

### 2.3 列出 inbox 草稿

```bash
gbrain review list
```

> 默认 `search`/`query` 不会返回 `inbox/` 草稿，必须通过 `gbrain review list` 或 `list_pages include_prefixes: ["inbox/"]` 查看。

---

## 3. 捕获一条成功案例

假设你刚刚验证了一种安全的 MCP 调用方式，需要把经验记录下来：

```bash
gbrain capture \
  --title "MCP 写入前必须先搜索" \
  --summary "调用 put_page 前，先用 search 或 query 检查是否已有同名或同主题页面，避免重复。验证通过：连续两次用相同标题写入，第二次返回同一 slug，说明 search-before-create 生效。" \
  --evidence "todo-11/mcp-smoke-test" \
  --evidence "todo-11/search-before-create-check" \
  --type knowledge \
  --sensitivity internal \
  --json
```

期望输出：

```json
{
  "ok": true,
  "mode": "online",
  "slug": "inbox/mcp-write-before-search",
  "status": "draft",
  "verification": "unverified",
  "search_before_create": true
}
```

捕获会强制写入 `inbox/`，`status: draft`，`verification: unverified`。

---

## 4. 审核并保留

### 4.1 查看草稿

```bash
gbrain review show inbox/mcp-write-before-search
```

### 4.2 生成计划（只读）

```bash
gbrain review plan inbox/mcp-write-before-search \
  --action keep \
  --target projects/mcp-write-before-search \
  --type project
```

### 4.3 正式保留到项目路径

```bash
gbrain review keep inbox/mcp-write-before-search \
  --target projects/mcp-write-before-search \
  --type project
```

> `keep` 到 `projects/` / `incidents/` / `decisions/` / `environments/` / `agent-skills/` 不需要 `verification: verified`。
> **注意**：`keep` 到 `knowledge/` 或 `runbooks/` 在实现上会被映射为 `promote`，因此仍需要 `verification: verified` 和 `PROMOTE <target-slug>` 确认。

### 4.4 验证保留结果

```bash
gbrain review verify projects/mcp-write-before-search
```

也可以用：

```bash
gbrain query "MCP 写入前必须先搜索" --limit 5
```

### 4.5 升级到通用知识（需要更多证据）

如果要升级到 `knowledge/` 或 `runbooks/`，草稿必须满足 `verification: verified`，且需要人工确认：

```bash
gbrain review promote inbox/mcp-write-before-search \
  --target knowledge/mcp-write-before-search \
  --type knowledge \
  --confirm "PROMOTE knowledge/mcp-write-before-search"
```

> 确认短语必须**逐字匹配** `PROMOTE <target-slug>`。从 `gbrain capture` 生成的草稿默认 `verification: unverified`，直接 promote 会失败并返回 `unverified_promote`。

---

## 5. 中文交互式审核

不带参数运行 `gbrain review`：

```text
$ gbrain review
待审核草稿
1. inbox/mcp-write-before-search   knowledge   unverified   draft   MCP 写入前必须先搜索

选择要审核的 draft: 1
草稿: inbox/mcp-write-before-search
选择处置动作: needs-evidence / reject / keep / promote / merge
选择处置动作: keep
目标 slug: projects/mcp-write-before-search
目标类型: project
```

> 如果选择 `runbook` 或 `knowledge` 作为目标类型，CLI 会按 `promote` 处理并要求输入 `PROMOTE <target-slug>`。

交互流程：
1. 输入草稿编号。
2. 选择动作。
3. 对 `keep`、`promote`、`merge` 输入目标 slug 和类型。
4. 对 `promote` 输入 `PROMOTE <target-slug>` 确认短语。
5. 对 `reject` 和 `needs-evidence` 输入原因。

---

## 6. 离线捕获与重试

如果 writer 凭证暂时不可用，捕获会进入离线队列：

```bash
# 模拟没有 writer 凭证的环境
mkdir -p /tmp/gbrain-offline-test
HOME=/tmp/gbrain-offline-test gbrain capture \
  --title "离线捕获示例" \
  --summary "没有 writer 凭证时，候选会写入 .omo/gbrain-capture/offline/。" \
  --evidence "offline-demo" \
  --json
```

输出类似：

```json
{
  "ok": true,
  "mode": "offline",
  "offline_path": "/tmp/gbrain-offline-test/.omo/gbrain-capture/offline/20260726-...json",
  "slug": "inbox/offline-capture-example",
  "status": "draft",
  "verification": "unverified",
  "search_before_create": true,
  "reason": "writer_credentials_unavailable"
}
```

恢复凭证后重试：

```bash
# 复制离线文件到当前工作目录
mv /tmp/gbrain-offline-test/.omo/gbrain-capture/offline/* .omo/gbrain-capture/offline/

# 重试
gbrain capture retry --json
```

期望输出：

```json
{
  "ok": true,
  "retried": 1,
  "remaining": 0,
  "slugs": ["inbox/offline-capture-example"]
}
```

---

## 7. 给新客户端安装本地规则

新机器接入 GBrain 命令行时，执行：

```bash
# 从服务端临时复制凭证（不要提交到 Git）
scp root@<server>:/etc/gbrain/clients/local-read.env /tmp/local-read.env
scp root@<server>:/etc/gbrain/clients/local-writer.env /tmp/local-writer.env
chmod 600 /tmp/local-read.env /tmp/local-writer.env

# 安装客户端规则、技能和凭证
gbrain install-client \
  --read-env-source /tmp/local-read.env \
  --writer-env-source /tmp/local-writer.env \
  --json

# 清理临时文件
rm -f /tmp/local-read.env /tmp/local-writer.env
```

安装器会：
- 写入 `~/.config/gbrain/local-read.env` 和 `local-writer.env`（权限 `600`）。
- 在 `~/.config/opencode/AGENTS.md` 和 `~/.codex/AGENTS.md` 写入规则块。
- 安装 `gbrain-capture` 和 `gbrain-review` 技能。
- 执行读写探针并立即删除探针页面。

---

## 8. 常见失败处理

### 8.1 缺少凭证

```text
gbrain review list
missing local read credentials
```

处理：检查 `~/.config/gbrain/local-read.env` 是否存在且权限为 `600`，然后运行 `gbrain install-client`。

### 8.2 升级未通过门禁

```text
gbrain review promote inbox/... --target knowledge/... --type knowledge --confirm "..."
... unverified_promote
```

处理：草稿 `verification` 不是 `verified`，不能升级。先补充证据并修改原草稿，或改用 `keep` 保留到项目内路径。

### 8.3 重复目标

```text
... duplicate_target
```

处理：目标 slug 已存在。改用 `merge` 合并到已有页，或换一个 slug。

### 8.4 unsafe content

```text
... unsafe_content
```

处理：正文包含 token、IP、raw transcript 或密集日志。清理后重新 capture 或 review。

### 8.5 token endpoint 限流

如果看到 `writer_token_mint_failed` 或 429：

- 查看响应头 `Retry-After`。
- 一个会话内只 mint 一次 token；CLI 调用会优先复用已缓存的 bearer。
- 等待后再试，不要连续重试。

---

## 9. 完整端到端示例脚本

```bash
#!/usr/bin/env bash
set -euo pipefail

TITLE="MCP 快速上手探针"
SOURCE_SLUG="inbox/mcp-quickstart-probe-$(date +%Y%m%d-%H%M%S)"
TARGET_SLUG="projects/mcp-quickstart-probe"

echo "1. capture"
gbrain capture \
  --title "$TITLE" \
  --summary "本页仅用于验证 gbrain capture + review + verify 流程，不保留为知识。" \
  --evidence "todo-11/quickstart-script" \
  --type knowledge \
  --sensitivity internal \
  --json

echo "2. plan"
gbrain review plan "$SOURCE_SLUG" \
  --action keep \
  --target "$TARGET_SLUG" \
  --type project

echo "3. keep"
gbrain review keep "$SOURCE_SLUG" \
  --target "$TARGET_SLUG" \
  --type project

echo "4. verify"
gbrain review verify "$TARGET_SLUG"

echo "5. cleanup source and probe target"
gbrain review cleanup "$SOURCE_SLUG" || true
# target 不是 inbox/，用 delete_page 清理
# gbrain delete_page "$TARGET_SLUG" || true

echo "done"
```

> 脚本中 `cleanup` 后面的 `|| true` 是因为非 `inbox/` 的 probe target 可能受门禁限制；实际使用时应根据返回码处理。

---

## 10. 下一步

- 详细了解 MCP Contract：[MCP_CONTRACT.md](MCP_CONTRACT.md)
- 配置 OpenCode 浏览器接入：[CLIENT_INSTALL_DEPLOYMENT.md](CLIENT_INSTALL_DEPLOYMENT.md)
- 使用 Web UI 审核：[WEB_UI_REVIEW.md](WEB_UI_REVIEW.md)
- 失败恢复与离线重试：[FAILURE_RECOVERY.md](FAILURE_RECOVERY.md)
- 手写 MCP JSON-RPC：[MCP_USAGE_GUIDE.md](MCP_USAGE_GUIDE.md)
