# Codex 经验收尾守卫 TDD 证据

> **历史记录（已废止）**：本文记录的是写入前 5 分钟静默审核方案。该方案已由同步采集替代：Agent 在当前回合完成去重和脱敏后直接写入 `inbox/`，以匹配的 `put_page` / `get_page` 事件和 `captured` 回执收尾；不再创建倒计时、后台任务或恢复会话。现行行为见 `docs/deployment/client-onboarding.md` 与 `test/gbrain-experience-hook.test.ts`。

## 用户路径

1. 非平凡回合要求结构化经验回执。
2. `previewed` 和 `captured` 不能仅凭声明放行，必须匹配可观察证据。
3. 完整预览后等待 5 分钟；无用户消息则默认同意，有任意消息则取消自动同意。
4. 安装器幂等保留既有 Hook，并可只移除受管经验 handler。
5. 本地状态不保存原始 prompt、命令、工具输出或审核 token 明文，并使用私有权限。

## RED

新增测试首次执行为 7 fail / 5 pass。失败原因均为经验 Hook 脚本、安装参数和事件行为尚未
实现。RED 检查点提交为 `3120ed2`。

删除模式并引入统一倒计时的增量测试首次执行为 5 fail / 11 pass。失败准确覆盖预览后未进入
倒计时、缺少等待与打断能力、旧模式命令仍可用，以及安装摘要仍暴露模式。增量 RED 检查点
提交为 `4fc9e86`。

## GREEN

实现和安全补测后相同目标执行为 16 pass / 0 fail。`tsc --noEmit`、生成 Hook 的
`python3 -m py_compile`、Bash 语法、diff whitespace 检查，以及项目 `verify` 的
31 项检查均通过。

`bun run test` 的四个并行 shard 在 Bun 1.3.12 / Linux arm64 上全部发生 Bun runtime
segmentation fault（`rc=133`），未报告本功能断言失败。该结果不能视为全量回归通过；由于
四个 shard 同时崩溃且专项测试稳定通过，保留为测试运行器覆盖缺口，不在相同条件下盲目
重试。直接相关的 16 项集成/安全行为是本次 GREEN 证据。

统一倒计时实现的 GREEN 检查点为 `7140de7`。专项测试验证 5 分钟生产配置、测试隔离的短
期限、无响应自动同意、用户消息打断、超时后必须匹配 `put_page`/`get_page` 才能释放，以及
本地状态不保存审核 token 明文。重复运行还发现随机 token 可能以 `-` 开头并被参数解析器
误判为选项；现统一使用 `gb_` 前缀并由测试锁定。旧环境变量、公共模式命令和遗留模式状态
均已删除。
