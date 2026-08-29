# Codex 隔离收尾与项目启动设计

日期：2026-08-10
状态：已批准并实现

## 决策

- 非平凡任务、待处理经验或首个满足条件的工具事件会在 `Stop` 前预发一次性收尾 token。
- 主 Agent 在最终答复前把脱敏后的任务结果和 token 交给独立子 Agent。
- 子 Agent 完成 GBrain 召回、去重、草稿写入、读取验证和 receipt；首次 `Stop` 只校验并放行。
- 旧的 `Stop` block/续跑流程保留为最多两次的 fail-open 兜底。
- 每次 `startup|resume` 缺少本地项目 marker 时都注入项目 bootstrap 子任务。仓库已有规范 ID 时精确复用；没有时由同一 checkout 的并发会话原子复用一个一小时 creation-key lease，再调用 `ensure_project` 创建；成功后运行 `complete-bootstrap` 清理 lease。

## 隔离与递归边界

- 收尾子 Agent prompt 必须包含 `GBRAIN_EXPERIENCE_CLOSEOUT_WORKER_TOKEN=<token>`。
- bootstrap 子 Agent prompt 必须包含 `GBRAIN_PROJECT_BOOTSTRAP_WORKER`。
- 无仓库 ID 时还必须原样使用 `GBRAIN_PROJECT_BOOTSTRAP_CREATION_KEY`，不得自行生成新键。
- 两类 worker 收到对应标记后直接执行，不得继续派生同类 worker。
- Hook 只维护哈希、布尔值、时间戳和合法 inbox slug，不保存原始 prompt、命令、输出或 transcript。
- Hook 不调用 MCP；MCP 操作由隔离子 Agent 执行。

## 验证契约

- worker 的 `captured` receipt 必须关联相同 token，并存在相同 slug 的成功 `put_page` 与 `get_page` Hook 事件。
- 有效 worker receipt 使 parent 的第一次 `Stop` 直接放行。
- 无效或缺失 receipt 仍进入原有 bounded fail-open 路径。
- 未绑定 SessionStart 必须输出 `GBRAIN_PROJECT_BOOTSTRAP_REQUIRED`；worker 标记防止递归派发。
- 同一未绑定 cwd 的并发 SessionStart 必须返回相同 creation key。
