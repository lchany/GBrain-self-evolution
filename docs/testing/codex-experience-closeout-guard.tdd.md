# Codex 经验收尾守卫 TDD 证据

## 用户路径

1. 默认 `enforce` 对非平凡回合要求结构化经验回执。
2. `previewed` 和 `captured` 不能仅凭声明放行，必须匹配可观察证据。
3. `unattended` 对整个当前回合锁存，不产生 Stop 续跑。
4. 安装器幂等保留既有 Hook，并可只移除受管经验 handler。
5. 本地状态不保存原始 prompt、命令或工具输出，并使用私有权限。

## RED

新增测试首次执行为 7 fail / 5 pass。失败原因均为经验 Hook 脚本、安装参数和事件行为尚未
实现。RED 检查点提交为 `3120ed2`。

## GREEN

实现和安全补测后相同目标执行为 16 pass / 0 fail。`tsc --noEmit`、生成 Hook 的
`python3 -m py_compile`、Bash 语法、diff whitespace 检查，以及项目 `verify` 的
31 项检查均通过。

`bun run test` 的四个并行 shard 在 Bun 1.3.12 / Linux arm64 上全部发生 Bun runtime
segmentation fault（`rc=133`），未报告本功能断言失败。该结果不能视为全量回归通过；由于
四个 shard 同时崩溃且专项测试稳定通过，保留为测试运行器覆盖缺口，不在相同条件下盲目
重试。直接相关的 16 项集成/安全行为是本次 GREEN 证据。
