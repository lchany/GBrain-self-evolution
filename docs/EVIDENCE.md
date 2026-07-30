# GBrain 自进化归档证据摘要

本文件汇总归档生成阶段 Todo 12 INDEX 和 final-wave F1-F5 的审阅结论；原始内部 evidence 路径不是部署输入，也不写入可移植交付物。这里不收录原始 transcript、密集日志、token、真实 IP 或环境 dump。

## 功能地图

- Capture：所有候选沉淀先进入 `inbox/`，状态为 draft/unverified。
- Review：人工 review 决定 keep、promote、merge、reject、needs-evidence、repair、cleanup。
- Writer：写入知识页时执行 schema/frontmatter、source_refs、禁止内容和 merge policy 检查。
- MCP：只提供显式读写能力和验证反馈；默认读取排除 `inbox/`，不自动 capture/review/promote。
- CLI/Web：CLI 和 Web review 共用同一 review core，Web 只做适配层。
- OpenCode/Codex：只分发规则和技能，不使用生命周期 hook 自动沉淀。

## Gate 和测试结论

- Todo 12 总门禁：GBrain targeted + neighbor tests `148 pass / 0 fail`；typecheck 退出码 0；build 退出码 0；OpenCode fake-provider run 退出码 0；serve smoke 退出码 0；Codex `test:codex` 退出码 0；真实存储隔离保持不变。
- F1 plan compliance：APPROVE，未发现方案偏离。
- F2 MCP/security/privacy：初审 REJECT，修正后 re-review APPROVE。
- F3 CLI/Web parity：APPROVE，`36 pass / 0 fail`，typecheck 退出码 0。
- F4 client QA：APPROVE，Codex full gate `511 pass / 0 fail`；OpenCode/Codex 隔离保持不变。
- F5 E2E/live transcript：最终结论 APPROVE。生产部署完成后，默认 `list_pages {limit:50}` 返回 47 页、0 条 `inbox/` slug；显式 `include_prefixes ["inbox/"]` 返回 4 条草稿；默认 search 返回 0 条 inbox；formal `get_page` 成功；read-token 执行 `put_page` 被 `insufficient_scope` 拒绝。

## F5 部署边界与最终 verdict

F5 的最终结论为 APPROVE。

2026-07-27 生产 `/opt/gbrain` 完成部署并重启 `gbrain-serve-http.service` 后，live endpoint 已加载本地工作树中已验证的默认 `inbox/` 排除、显式 prefix 读取和权限边界修正。实测结果：

- 默认 `list_pages {limit:50}`：返回 47 页，0 条 `inbox/` slug。
- 显式 `include_prefixes ["inbox/"]`：返回 4 条草稿。
- 默认 search：返回 0 条 inbox。
- formal `get_page`：正常返回。
- read-token 执行 `put_page`：返回 `insufficient_scope`，写入权限边界生效。

历史状态（已覆盖）：生产部署前，live endpoint 曾出现部署滞后，远端服务尚未加载本地工作树中已验证的默认 `inbox/` 排除等修正。该状态随 2026-07-27 生产部署和服务重启被终结。

## 已知风险

- 默认读取如果回退到包含 `inbox/`，会破坏 no-hook 流程的人工 review 边界。
- MCP 注解、分页、过滤、错误信息和隐私门禁必须保持一致，否则会出现“文档正确、实现不一致”。
- 不能把 raw transcript、raw JSON、密集日志或 secrets 带回证据面。
- OpenCode/Codex 安装和 QA 必须保持真实配置/DB 隔离。
- 429 backoff、verify 索引滞后、72h soft-delete 等限制是真实约束，不是测试噪声。

## 归档验证结果

- `patches/gbrain-self-evolution.patch`：在 `1fabbb9849f23703ee2898699868ce8101e7b61d` 临时 worktree 上 `git apply --check` 通过；apply 后 49 个变更路径与 live 工作树逐字节一致。
- `patches/oh-my-openagent-gbrain.patch`：在 `e3556c35d2c3879aeec1d7043ecc52e37bf1d3d3` 临时 worktree 上 `git apply --check` 通过；apply 后 9 个变更路径与 live 工作树逐字节一致。
- 隐私扫描和结构扫描结果以最终 DoneClaim 为准。

## 证据指针

- Todo 12 总索引：`.omo/evidence/20260726-gbrain-no-hook-capture/todo-12/INDEX.md`
- Gate summary：`.omo/evidence/20260726-gbrain-no-hook-capture/todo-12/gate-summary.md`
- Failure paths：`.omo/evidence/20260726-gbrain-no-hook-capture/todo-12/failure-paths/coverage.md`
- Final wave：`.omo/evidence/20260726-gbrain-no-hook-capture/final-wave/F1-F5*.md`
