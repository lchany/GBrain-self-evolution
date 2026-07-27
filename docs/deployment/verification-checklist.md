# 部署验证清单

本清单覆盖服务器、客户端、文档/隐私、no-hook 边界和发布五个维度。每条检查都给出通过命令或观察标准，未通过项必须在发布前修复或记录为已知风险。

## 使用说明

- 按顺序执行。服务器检查通过后，再执行客户端检查。
- 方括号 `[ ]` 表示待执行；执行后改为 `[x]` 并记录结果（pass / fail / skip / 备注）。
- 所有 `<server>` 均为占位符，替换为实际地址，不要写入仓库。

---

## 1. 服务器检查

由服务器管理员在生产或 staging 机器上执行。

### 1.1 补丁可应用且范围正确

```bash
cd /opt/gbrain
# 或 cd /path/to/gbrain-clone
git status --short
git apply --check /path/to/GBrain-self-evolution/patches/gbrain-self-evolution.patch
```

- [ ] `git status --short` 只显示预期内的未跟踪文件或当前任务改动。
- [ ] `git apply --check` 返回 0，无冲突。

### 1.2 依赖与构建通过

```bash
cd /opt/gbrain
bun install
bun test
```

- [ ] `bun install` 完成且无未解析依赖。
- [ ] `bun test` 通过（观察最终退出码为 0）。

### 1.3 服务已启用并处于 active 状态

```bash
systemctl is-active gbrain-serve-http.service
systemctl is-enabled gbrain-serve-http.service
systemctl status gbrain-serve-http.service --no-pager
```

- [ ] `is-active` 返回 `active`。
- [ ] `is-enabled` 返回 `enabled`。
- [ ] `status` 无最近失败或重启循环。

### 1.4 本地 client_credentials 文件存在且权限正确

```bash
ls -l /etc/gbrain/clients/local-read.env /etc/gbrain/clients/local-writer.env
stat -c '%a %n' /etc/gbrain/clients/local-read.env /etc/gbrain/clients/local-writer.env
```

- [ ] 两个文件均存在。
- [ ] 权限为 `600`，属主为 root 或运行 gbrain 的用户。
- [ ] 文件内容不含真实 IP、token 或 secret 的明文副本（检查是否已脱敏或占位）。

### 1.5 OAuth 客户端注册正确

```bash
/usr/local/bin/gbrain auth list-clients
```

- [ ] 每个 OpenCode 客户端有独立的 `client_id`。
- [ ] 只读客户端 scope 为 `read`；读写客户端 scope 为 `read write`。
- [ ] grant types 包含 `authorization_code,refresh_token`。
- [ ] redirect URI 精确为 `http://127.0.0.1:19876/mcp/oauth/callback`。
- [ ] public client 未签发 client secret。

### 1.6 MCP endpoint 可达

```bash
curl -sS -o /dev/null -w '%{http_code}' http://<server>:3131/mcp
```

- [ ] 返回 `405`（MCP 端点拒绝 GET，只允许 POST）或 `401`（未认证），不能是 `000`、`404` 或 `502`。

### 1.7 Scope 隔离有效

使用只读 client_credentials 换取 token 后尝试写入：

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

curl -sS -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"put_page","arguments":{"slug":"inbox/scope-isolation-probe","content":"---\ntype: knowledge\ndate: 2026-07-27\nstatus: draft\nsensitivity: internal\nverification: unverified\napplicability: []\nnon_applicable: []\nsource_refs:\n  - deployment-checklist-scope-test\nmigrated_from: null\n---\n\nprobe"}},"id":1}' \
  http://<server>:3131/mcp
```

- [ ] 响应包含 `insufficient_scope` 或 403，不能成功创建页面。

---

## 2. 客户端检查

由客户端用户/操作员在本地工作站上执行。

### 2.1 OpenCode 版本符合要求

```bash
opencode --version
```

- [ ] 版本为 1.18.4 或更高 1.18.x。

### 2.2 MCP 配置只合并了 `mcp.gbrain`

```bash
cat ~/.config/opencode/opencode.json | python3 -m json.tool
```

- [ ] 存在 `mcp.gbrain` 对象。
- [ ] `url` 以 `/mcp` 结尾。
- [ ] `oauth.clientId` 为服务端预注册值，`scope` 不超过注册范围。
- [ ] 没有 `clientSecret`、`headers.Authorization` 或长期 bearer token。
- [ ] 其他 provider、model、plugin、permission 或 MCP 配置未被覆盖。

### 2.3 OAuth 认证成功

```bash
opencode mcp auth gbrain
opencode mcp list
opencode mcp auth list
```

- [ ] `opencode mcp list` 显示 `gbrain` 已连接或可用。
- [ ] `opencode mcp auth list` 显示 `gbrain` OAuth 状态为已认证。

### 2.4 OpenCode 会话可调用 GBrain 工具

启动 `opencode`，在会话中要求：

- 调用 `get_brain_identity`。
- 调用 `search` 搜索一个已知主题并返回命中 slug。

- [ ] `get_brain_identity` 返回 brain 身份，无权限错误。
- [ ] `search` 返回非空结果，且 slug 来自 `knowledge/`、`runbooks/`、`projects/` 等已确认路径，不含 `inbox/`。

### 2.5 本地 env 文件存在且权限正确

```bash
ls -l ~/.config/gbrain/local-read.env ~/.config/gbrain/local-writer.env
stat -c '%a %n' ~/.config/gbrain/local-read.env ~/.config/gbrain/local-writer.env
```

- [ ] 两个文件均存在。
- [ ] 权限为 `600`。

### 2.6 gbrain CLI 可执行且只读操作正常

```bash
gbrain review list
gbrain query "MCP" --limit 5
```

- [ ] `gbrain review list` 返回空列表或草稿列表，不报错。
- [ ] `gbrain query` 返回已确认知识结果，不含 `inbox/` 草稿。

### 2.7 capture 流程端到端通过

```bash
gbrain capture \
  --title "部署验证探针" \
  --summary "仅用于验证 capture -> review -> verify 流程。" \
  --evidence "todo-2/deployment-checklist" \
  --type knowledge \
  --sensitivity internal \
  --json
```

- [ ] 输出 `ok: true`，slug 落在 `inbox/`，`status: draft`，`verification: unverified`。

随后执行 plan + keep + verify，最后 cleanup：

```bash
SLUG=inbox/deployment-checklist-...
gbrain review plan "$SLUG" --action keep --target projects/deployment-checklist-probe --type project
gbrain review keep "$SLUG" --target projects/deployment-checklist-probe --type project
gbrain review verify projects/deployment-checklist-probe
gbrain review cleanup "$SLUG"
```

- [ ] `plan` 预览通过。
- [ ] `keep` 成功，目标 slug 落入 `projects/`。
- [ ] `verify` 确认目标可检索。
- [ ] `cleanup` 删除原 `inbox/` 草稿。

### 2.8 技能已安装

```bash
ls -d ~/.config/opencode/skills/gbrain-capture ~/.config/opencode/skills/gbrain-review
# Codex 用户检查
ls -d ~/.codex/skills/gbrain-capture ~/.codex/skills/gbrain-review 2>/dev/null || true
```

- [ ] `gbrain-capture` 和 `gbrain-review` 技能存在于 OpenCode skill 目录。
- [ ] 如客户端需要手写规范页面，`gbrain-knowledge-writer` 也存在。

### 2.9 AGENTS 规则块已写入

```bash
grep -A 5 "GBrain" ~/.config/opencode/AGENTS.md
```

- [ ] OpenCode 用户级 AGENTS.md 包含 GBrain 规则块。
- [ ] Codex 用户级 AGENTS.md 也包含 GBrain 规则块（如使用 Codex）。

---

## 3. 文档与隐私检查

由发布负责人或审阅者在归档仓库上执行。

### 3.1 仓库不含 secret

```bash
cd /path/to/GBrain-self-evolution
grep -R -n -E '(AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|sk-[a-zA-Z0-9]{48}|bearer [a-zA-Z0-9\-_]+|client_secret|private_key)' \
  --include='*.md' --include='*.json' --include='*.env' --include='*.sh' . \
  || echo "no obvious secret pattern found"
```

- [ ] 没有高置信度的 secret 模式。允许存在占位符和示例形状说明。

### 3.2 仓库不含真实非回环 IP

```bash
grep -R -n -E '\b(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b' \
  --include='*.md' --include='*.json' --include='*.env' --include='*.sh' . \
  | grep -v '127\.0\.0\.1' | grep -v '0\.0\.0\.0' | grep -v '::1' \
  || echo "no non-loopback IP found"
```

- [ ] 没有非回环真实 IP。允许 `127.0.0.1`、`0.0.0.0`、`::1` 等占位或回环地址。

### 3.3 仓库不含原始 transcript 或密集日志

```bash
grep -R -n -E '(msg_[a-f0-9]+|ses_[a-f0-9]+|session_id|raw_transcript|dense_log|完整聊天记录)' \
  --include='*.md' . \
  || echo "no raw transcript markers found"
```

- [ ] 没有完整会话 ID、原始 transcript 或密集日志内容。`source_refs` 中的路径引用除外。

### 3.4 不包含应排除的目录

```bash
ls -la /path/to/GBrain-self-evolution/.omo 2>/dev/null || echo ".omo absent"
ls -la /path/to/GBrain-self-evolution/node_modules 2>/dev/null || echo "node_modules absent"
ls -la /path/to/GBrain-self-evolution/dist 2>/dev/null || echo "dist absent"
```

- [ ] 不存在 `.omo/`、`node_modules/`、`dist/` 或原始 evidence dump。

### 3.5 所有文档链接可解析

```bash
cd /path/to/GBrain-self-evolution
# 检查 docs/deployment/*.md 中的相对链接
# 最终链接门禁在 todo 6 执行，本项只要求不存在明显 broken link
```

- [ ] 本文档与 [docs/deployment/README.md](README.md) 中的相对链接目标存在，或由并行 worker 负责（标记为 pending-parallel）。

---

## 4. No-hook 检查

确认 v1 不依赖 lifecycle hook，且知识升级受人工门禁控制。

### 4.1 没有 lifecycle hook 文档或配置

```bash
cd /path/to/GBrain-self-evolution
grep -R -n -iE '(SessionStart|PreToolUse|PostToolUse|PostCompact|Stop).*[Hh]ook' --include='*.md' .
```

- [ ] 没有描述 SessionStart、PreToolUse、PostToolUse、PostCompact、Stop lifecycle hook 的文档。

### 4.2 默认查询排除 inbox

在 OpenCode 会话或 gbrain CLI 中执行：

```bash
gbrain search "deployment" --limit 20
```

- [ ] 结果不含 `inbox/` 路径。

### 4.3 显式包含才能读取 inbox

```bash
gbrain review list
curl -sS -H "Authorization: Bearer <TOKEN-local-read>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_pages","arguments":{"include_prefixes":["inbox/"],"limit":20}},"id":1}' \
  http://<server>:3131/mcp
```

- [ ] `gbrain review list` 可列出 `inbox/` 草稿。
- [ ] `list_pages` 传入 `include_prefixes: ["inbox/"]` 可列出草稿。

### 4.4 promote 需要人工确认短语

尝试不带 `--confirm` 或使用错误短语 promote 一条草稿：

```bash
gbrain review promote inbox/some-draft \
  --target knowledge/some-target \
  --type knowledge
```

- [ ] CLI 返回 `promote_confirmation_required`，不执行升级。

使用正确短语重试：

```bash
gbrain review promote inbox/some-draft \
  --target knowledge/some-target \
  --type knowledge \
  --confirm "PROMOTE knowledge/some-target"
```

- [ ] 仅当草稿满足 `verification: verified` 等门禁时才成功。

### 4.5 不存在自动 promote 机制

```bash
grep -R -n -iE 'auto.promote|自动升级|自动 promote|auto keep' --include='*.md' --include='*.json' /path/to/GBrain-self-evolution
```

- [ ] 没有文档或配置描述自动 promote/keep/merge。

---

## 5. 发布检查

由发布负责人在归档仓库最终提交前执行。

### 5.1 补丁文件存在且非空

```bash
ls -lh /path/to/GBrain-self-evolution/patches/
file /path/to/GBrain-self-evolution/patches/*.patch
```

- [ ] `patches/gbrain-self-evolution.patch` 存在且大小非零。
- [ ] `patches/oh-my-openagent-gbrain.patch` 存在且大小非零。

### 5.2 部署文档齐全

```bash
ls -la /path/to/GBrain-self-evolution/docs/deployment/
```

- [ ] 存在 `README.md`。
- [ ] 存在 `verification-checklist.md`。
- [ ] `new-machine-bootstrap.md`、`client-onboarding.md`、`agent-rules.md` 已由并行 worker 创建或标记为 pending-parallel。

### 5.3 服务端部署产物目录已创建

```bash
ls -la /path/to/GBrain-self-evolution/deploy/ 2>/dev/null || echo "deploy dir pending-parallel"
```

- [ ] `deploy/systemd/`、`deploy/env/`、`deploy/scripts/` 已由并行 worker 创建或标记为 pending-parallel。

### 5.4 证据文件已记录链接清单

执行环境生成的 `deployment-doc-links.md`（保存在执行环境的 evidence 目录，不纳入本仓库）：

```bash
ls -la <EVIDENCE_DIR>/deployment-doc-links.md
```

- [ ] 文件存在，列出 [docs/deployment/README.md](README.md) 和 [docs/deployment/verification-checklist.md](verification-checklist.md) 中所有相对链接及其目标状态。

### 5.5 Git 工作树状态符合发布预期

```bash
cd /path/to/GBrain-self-evolution
git status --short
```

- [ ] 只有预期文件处于新增或修改状态。
- [ ] 没有未跟踪的 secret、env 或 evidence dump。

---

## 最终发布签字

- [ ] 服务器检查全部通过。
- [ ] 客户端检查全部通过。
- [ ] 文档/隐私检查全部通过。
- [ ] No-hook 检查全部通过。
- [ ] 发布检查全部通过。

签字人：__________ 日期：__________
