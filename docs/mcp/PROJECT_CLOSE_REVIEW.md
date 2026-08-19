# 项目关闭评审 — GBrain 远程 MCP 知识库

状态：human-reviewed

人工审查日期：2026-07-25

- 项目结果与验证：通过
- 现有残余风险：接受
- 通用经验候选：第 1、2、3 条全部批准提炼
- 分享状态：尚未共享，仍需通过独立 `approve-share` 门禁

## 项目结果

在专用 x86_64 服务器上完成了 GBrain 知识库服务的搭建、能力扩展、安全加固与收尾验证：

- GBrain HTTP MCP 服务（端口 3131，Postgres 引擎）长期运行，systemd 管理
- 94 个 MCP tools、2 prompts、2 resources 部署并经实测
- MCP instructions、工具 annotations、OAuth scope 过滤、stdio/remote `localOnly` 信任边界全部就位
- 只读人类 Web UI 已实现并部署
- 知识摄入工作流（MCP `put_page` 写入 → 规范 Markdown 源回写）已验证
- 旧 agent-evolutionism 内容已一次性迁移，旧流程已废弃
- 备份、重建与运维 runbook 已完成
- 客户端安装/部署文档与 MCP 使用指南已完成：
  - `docs/mcp/CLIENT_INSTALL_DEPLOYMENT.md`
  - `docs/mcp/MCP_USAGE_GUIDE.md`

## 安全加固（两轮 Oracle 复审）

第一轮复审发现并已修复：

- OAuth RFC 8707 resource 绑定缺失（authorization-code 与 refresh 轮换）
- `/mcp` 未显式拒绝错误 audience 的 OAuth token
- 非法 Origin 在 OAuth/MCP handler 前未被硬 403 拦截
- stdio `localOnly` 工具在远程 dispatch 未被阻断
- GET/DELETE `/mcp` 未返回真实 405 + `Allow: POST`

第二轮复审（最终）确认两个 follow-up 修复无阻塞缺陷：

- `client_credentials` 显式 `resource` 已持久化并在 `/mcp` 校验（错误 resource 401，省略 resource 的旧 token 保持兼容）
- refresh 过 scope 请求不再消耗 refresh token；并发轮换仍保持单次使用语义

## 验证证据

- OAuth 单元测试：102/102 通过（含 resource 绑定、refresh 非消费、TOCTOU 并发回归）
- HTTP OAuth E2E：39/39 通过
- typecheck、build 通过
- `bun run verify`：30/31（唯一失败为既有 `test/autopilot-install.test.ts` real-name 夹具检查，与本次变更无关，该文件无 diff）
- 生产实测矩阵：
  - legacy CC token → `/mcp` 200
  - 正确 resource CC token → `/mcp` 200
  - 错误 resource CC token → `/mcp` 401
  - refresh 过 scope → 400，同一 refresh token 合法 scope 重试 → 200
  - 非法 Origin → 五个入口均 403
  - GET/DELETE `/mcp` → 405 + `Allow: POST`
- 本地与生产四个变更文件 SHA-256 一致，服务重启后 active + 监听 3131

## 项目特定经验（留在项目层，不升级）

- ARM64 Bun 1.3.14 上 PGLite 测试会段错误；x86_64 是本项目唯一可信测试车道
- 服务重启后 systemd 先报 active、端口就绪有延迟，健康检查需要就绪探测而非瞬时请求
- 部署通道依赖密码式 SSH（sshpass），公钥登录不可用
- GBrain 源码与知识目录均无 `.experience-vault-project-id` 标记，不写入项目级 Experience Vault 记录

## 已批准提炼的通用经验候选（尚未共享）

1. OAuth resource binding 必须覆盖全部三种 token 签发入口（authorization-code、refresh、client_credentials），且所有校验失败路径不得消耗凭据
2. 单测 + E2E + 生产 live 矩阵三层验证足以关闭 token-audience 类缺陷
3. systemd 服务 active 不等于监听就绪，重启验证必须带就绪探测

（用户已批准提炼以上三条；在独立 `approve-share` 审批通过前，不进入共享 `knowledge/` 或 `runbooks/`。）

## 排除项

- 未创建共享知识或 runbook 记录
- 未写入任何密钥、token、密码、真实 IP 或敏感日志
- 客户端机器未被直接修改（只交付文档）
- 云端/动态 IP agent 的 OAuth 接入被明确排除在范围外

## 残余风险

- 浏览器 OAuth 公开访问仍需用户提供公开 HTTPS URL/domain/反向代理；当前 metadata 指向 loopback issuer，浏览器公开 OAuth 流不可达（基础设施限制，非代码缺陷）
- `verify` 的 1 个既有失败（real-name 夹具检查）未处理，属上游历史遗留
- 外部固定 IP agent 的后续接入为按需操作，不属于未完成项目工作

## 人工审查结果

1. 项目结果与验证证据已确认通过
2. 现有残余风险已接受
3. 通用经验第 1、2、3 条已批准提炼，但尚未批准共享
