# Codex 经验收尾守卫设计

## 目标

用 Codex 生命周期 Hook 机械提醒 Agent 完成经验收尾检查，降低仅依赖 `AGENTS.md`
时漏执行总结的概率，同时确保长时间无人值守任务不会被守卫续跑或阻断。

## 边界

- `Stop` 只在 Agent 准备结束当前回合时触发，不打断命令、测试、训练、轮询或后台进程。
- Hook 不调用 MCP、不写 GBrain、不读取 transcript，也不代替用户完成写入前审核。
- 用户审核仅发生在 Agent 判断存在候选并展示完整固定模板之后。
- 支持 Linux/Unix 和 Codex 0.146.0；Windows、OpenCode、`SessionEnd` 与
  `SubagentStop` 不在本次范围内。

## 架构

安装器写入独立的 `gbrain-experience-guard.py`，并为 `UserPromptSubmit`、
`PostToolUse` 和 `Stop` 幂等合并三个 handler。项目身份 `SessionStart` Hook 保持独立。

`UserPromptSubmit` 只计算非平凡意图标志并锁存本回合模式。`PostToolUse` 为每个 tool use
原子写一个事件文件，只保存哈希、布尔值、时间戳和合法的 `inbox/` slug。`Stop` 汇总事件，
在 `enforce` 模式要求 `defer`、`no_candidate`、`previewed`、`captured` 或 `rejected`
结构化回执。缺少或无效回执最多自动续跑两次，随后 fail-open。

`previewed` 必须能在最后一条 Agent 消息中找到完整模板关键章节、预分类和 5 分钟提示。
`captured` 必须有相同 slug 的成功 `mcp__gbrain__put_page` 与 `get_page` 事件。

## 模式

默认模式是 `enforce`。单进程无人值守通过
`GBRAIN_EXPERIENCE_HOOK_MODE=unattended` 设置；持久模式必须有 `--for` 或 `--until`
期限。优先级为环境变量、有效定时模式、默认值。模式在回合开始时锁存，中途到期不会改变
该回合。`unattended` 不续跑、不要求回执，并优先保证任务正常结束。

## 安全与恢复

状态目录和子目录为 `0700`，文件为 `0600`，写入采用同目录临时文件加原子替换。
拒绝符号链接、不可信 owner 和组/全局可写状态对象；状态保留 7 天。Hook 发生任何异常时
立即 fail-open。`gbrain install-client --no-experience-hook` 只移除受管经验 handler；
重新运行默认安装器即可恢复。
