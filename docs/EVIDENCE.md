# GBrain 自进化归档证据摘要

本文件汇总 `/home/l30002999/source_code/oh-my-openagent/.omo/evidence/20260726-gbrain-no-hook-capture/` 中 Todo 12 INDEX 和 final-wave F1-F5 的审阅结论。这里不收录原始 transcript、密集日志、token、真实 IP 或环境 dump。

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
- F5 E2E/live transcript：REJECT，原因是 live endpoint 仍表现出部署滞后，默认 list/read 边界没有在远端服务生效。

## F5 部署边界

F5 的结论不是“本地代码未修好”，而是“本地源代码和探针已经支持修正，但远端 HTTP MCP/token 服务是另一个部署面”。本机没有该远端服务监听端口，因此不能用重启本机进程解释或修复 live failure。

上线后必须在生产 `/opt/gbrain` 重启 `gbrain-serve-http.service`，再复跑 F5 live gate。预期通过条件是：默认读取不暴露 `inbox/`，显式 review/capture 路径仍可用，MCP annotation 与权限边界一致。

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
