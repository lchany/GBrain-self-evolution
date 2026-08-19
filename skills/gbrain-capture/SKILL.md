---
name: gbrain-capture
description: "Capture durable GBrain candidates into inbox drafts. Use when a task produces reusable success knowledge, a verified wrong-answer incident, durable user/project rules, project facts, decisions, milestones, or when the user asks to record something; never store raw transcripts or secrets."
---

# gbrain-capture

把当前任务的结论提炼成 GBrain `inbox/` 草稿。它只负责 capture，不负责审核、promote 或批准通用经验。

## 触发规则

### MUST：必须考虑 capture

- 用户给出长期规则或偏好，例如“以后”“后续”“永远”“必须”“不要”“默认”“remember”“always”“must”“never”。
- 做出明确架构、流程、配置、部署、工具选择决策。
- 已确认 root cause，且 fix 已经真实验证。
- 某个方案被硬证据证明无效，构成错题集。
- 完成项目里程碑或项目关闭。
- 用户明确要求“这条有价值，记录下来”。
- 出错、验证失败、方案无效后，下一轮尝试前必须先查询相关 incident/错题集。

### SHOULD：应考虑 capture

- 首次打通一个可复用流程。
- 形成可复用 runbook。
- 发现环境、机器、网络、部署、数据集事实。
- 成功替代旧方案的新正确路径。
- 避免重大风险的决策。

### NEVER：不得 capture

- 闲聊、无证据猜测、一次性过程噪音。
- raw transcript、raw tool output、密集日志、原始 JSON、认证响应。
- password、API key、token、私钥、认证文件。
- 真实人名、员工号、个人账号名。
- 未匿名化的非 loopback IP、hostname、机器别名。

## 写入边界

- 所有新沉淀先进入 `inbox/<slug>`。
- 新草稿必须是 `status: draft`、`verification: unverified`。
- `type` 只是建议：成功案例可建议 `knowledge`、`runbook`、`decision`、`project`；错题集默认建议 `incident`。
- 只写提炼后的结论和证据指针，不写完整聊天记录或完整工具输出。
- GBrain 服务地址只写占位符 `<server>`；不要把真实 URL、IP、token、secret 写入 AGENTS、skill 或草稿正文。

## 推荐工作流

1. 判断是否命中 MUST/SHOULD/NEVER。
2. 用双路查询确认不是重复主题：
   - 可复用成功经验：`knowledge/`、`runbooks/`、相关 `decisions/`、`projects/`。
   - 禁止重犯事项：相关 `incidents/`、失败错题、已验证无效方案。
3. 选择模板：
   - 成功案例使用本文件“内容结构”中的成功案例模板。
   - 失败错题使用本文件“内容结构”中的失败错题模板。
4. 需要直接通过 MCP 写页面时，先加载 `gbrain-knowledge-writer`，执行 search-before-create，再用 MCP `put_page`。
5. 优先使用已实现的结构化 CLI 写 `inbox/` 草稿：

```bash
gbrain capture --title "<标题>" --summary "<场景-做法-结果-结论-下次规则>" --evidence "<证据指针>" --type <knowledge|runbook|decision|project|incident|environment>
```

离线或 writer 凭证不可用时，只允许结构化候选进入本地队列：

```bash
gbrain capture retry
```

## 内容结构

成功案例使用：

```markdown
## 场景
## 正确做法
## 结果
## 结论
## 下次规则
```

失败错题使用：

```markdown
# 不要再用 <错误方案> 解决 <问题>

## 场景
## 错误做法
## 失败结果
## 结论
## 下次规则
```

## 完成前自检

- `source_refs` 只有证据指针，没有 raw log。
- 没有 secret、token、私钥、真实个人信息、未匿名化内网地址。
- 没有自动 promote 指令；草稿仍在 `inbox/`。
- 输出记录写入结果和 slug，方便后续 `gbrain-review` 人工审核。
