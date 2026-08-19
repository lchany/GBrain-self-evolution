# GBrain 失败恢复与离线重试

本文档描述 `gbrain` CLI 和 MCP 写入失败后的恢复路径，包括离线队列、repair、cleanup 和常见错误处理。

---

## 1. 离线捕获队列

当 `gbrain capture --title ...` 无法换到 writer token 或 MCP 服务不可达时，命令不会失败退出，而是把候选记录写入本地队列。

### 1.1 队列位置

```text
<cwd>/.omo/gbrain-capture/offline/<timestamp>-<slug-tail>-<hash8>.json
```

例如：

```text
<cwd>/.omo/gbrain-capture/offline/20260726-mcp-offline-demo-a1b2c3d4.json
```

### 1.2 队列内容

离线 JSON 文件包含：

```json
{
  "schema_version": 1,
  "queued_at": "2026-07-26T12:00:00.000Z",
  "reason": "writer_credentials_unavailable",
  "candidate": {
    "schema_version": 1,
    "title": "离线示例",
    "suggested_type": "knowledge",
    "summary": "没有 writer 凭证时进入离线队列。",
    "evidence_refs": ["offline-demo"],
    "requested_verification": "unverified",
    "verification": "unverified",
    "sensitivity": "internal",
    "created_at": "2026-07-26T12:00:00.000Z",
    "slug": "inbox/offline-example"
  }
}
```

**注意**：离线队列不包含 bearer token、client secret、原始 transcript 或完整工具输出。

### 1.3 重试

恢复网络或凭证后，在包含 `.omo/gbrain-capture/offline/` 的目录执行：

```bash
gbrain capture retry --json
```

输出示例：

```json
{
  "ok": true,
  "retried": 1,
  "remaining": 0,
  "slugs": ["inbox/offline-example"]
}
```

- 成功的条目会写入 `inbox/` 并从队列删除。
- 失败的条目保留在队列中，等待下次重试。
- 重试时会重新执行 `search-before-create`。

### 1.4 手动处理队列

```bash
# 查看队列
ls .omo/gbrain-capture/offline/

# 手动检查候选内容
cat .omo/gbrain-capture/offline/20260726-*.json

# 删除错误候选
rm .omo/gbrain-capture/offline/20260726-错误候选.json
```

---

## 2. 审核失败修复

### 2.1 repair：重试写入审核记录

如果 `gbrain review keep/promote/merge/reject/needs-evidence` 执行后目标页写入成功，但审核记录写入失败，原 `inbox/` 草稿不会被删除。此时需要 `repair`：

```bash
gbrain review repair inbox/<slug> \
  --reason "补充审核记录：上次 apply 中 review record 写入失败"
```

`repair` 会重新生成并写入 `decisions/reviews/<slug>-review-<date>` 记录，但**不会**删除原 `inbox/` 草稿。

### 2.2 cleanup：清理废弃草稿

对于探针或废弃草稿，使用 `cleanup`：

```bash
gbrain review cleanup inbox/<slug> \
  --reason "探针页面，已验证完成"
```

`cleanup` 会先写审核记录，再软删除原 `inbox/` 草稿。

---

## 3. 常见错误与恢复

### 3.1 缺少 read 凭证

```text
gbrain review list
missing local read credentials
```

处理：

```bash
# 检查文件
ls -l ~/.config/gbrain/local-read.env

# 如果不存在，重新安装
gbrain install-client \
  --read-env-source /tmp/local-read.env \
  --writer-env-source /tmp/local-writer.env
```

### 3.2 缺少 writer 凭证

```text
gbrain capture --title ...
missing local writer credentials
```

处理：

```bash
# 检查文件
ls -l ~/.config/gbrain/local-writer.env

# 重新安装
gbrain install-client --writer-env-source /tmp/local-writer.env
```

### 3.3 token endpoint 429

```text
writer token mint failed: rate_limited
```

处理：

- 查看响应中的 `Retry-After` 头。
- 等待指定秒数。
- 一个会话只 mint 一次 token；CLI 会自动复用缓存。

### 3.4 promote 确认失败

```text
gbrain review promote ...
... promote_confirmation_required
```

处理：

- 确认短语必须精确为 `PROMOTE <target-slug>`。
- 检查 target slug 是否与 plan 一致。
- 不要省略 `PROMOTE` 前缀。

### 3.5 草稿未经验证

```text
... unverified_promote
```

处理：

- 草稿 `verification` 不是 `verified`，不能 promote 到 `knowledge/` / `runbooks/`。
- 先补充证据，更新原草稿到 `verification: verified`，或改用 `keep` 到项目内路径。

### 3.6 重复目标

```text
... duplicate_target
```

处理：

- 目标 slug 已存在。
- 改用 `merge` 合并到已有页。
- 或更换 target slug。

### 3.7 unsafe content

```text
... unsafe_content
```

处理：

- 检查正文是否包含 token、私钥、非回环 IP、raw transcript、密集日志。
- 清理后重新 capture，或更新原草稿后重新 review。
- 把证据文件路径放进 `source_refs`，不要写正文。

### 3.8 审核记录写入失败

```text
... apply_step_failed
```

处理：

- 查看 receipts 中哪一步失败。
- 如果是 `write_review` 失败，用 `gbrain review repair inbox/<slug>` 重试。
- 如果是 `delete_source` 失败，用 `gbrain review cleanup inbox/<slug>` 重试。
- 如果是 `write_target` 失败，检查目标 slug 是否合法、凭证 scope 是否包含 `write`。

---

## 4. 删除与恢复

### 4.1 软删除

`delete_page` 和 `gbrain review cleanup/reject` 都是软删除：

- 页面从默认搜索和 `get_page` 中隐藏。
- 72 小时内可恢复。
- 软删除页面可通过 `get_page` 加 `include_deleted: true` 验证。

### 4.2 验证软删除

```bash
gbrain query "inbox/my-probe" --limit 5
# 应无结果

# 使用 MCP 工具验证
curl -sS -H "Authorization: Bearer <TOKEN-local-writer>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_page","arguments":{"slug":"inbox/my-probe","include_deleted":true}},"id":1}' \
  http://<server>:3131/mcp
```

### 4.3 恢复软删除

```bash
curl -sS -H "Authorization: Bearer <TOKEN-local-writer>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"restore_page","arguments":{"slug":"inbox/my-probe"}},"id":2}' \
  http://<server>:3131/mcp
```

---

## 5. 清理检查清单

- [ ] 探针页面已用 `delete_page` 或 `gbrain review cleanup` 软删除。
- [ ] 已用 `get_page include_deleted: true` 验证软删除落地。
- [ ] 离线队列已用 `gbrain capture retry` 清空或手动删除不需要的条目。
- [ ] 审核记录已写入 `decisions/reviews/`。
- [ ] 没有真实 IP、token、client secret、个人姓名留在页面或 env 文件中。

---

## 6. 相关文档

- [QUICKSTART.md](QUICKSTART.md)
- [MCP_USAGE_GUIDE.md](MCP_USAGE_GUIDE.md)
- [MCP_CONTRACT.md](MCP_CONTRACT.md)
- [WEB_UI_REVIEW.md](WEB_UI_REVIEW.md)
- [CLIENT_INSTALL_DEPLOYMENT.md](CLIENT_INSTALL_DEPLOYMENT.md)
