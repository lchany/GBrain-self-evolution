export const GBRAIN_RULES_BLOCK_START = '<!-- GBRAIN_CLIENT_RULES_START -->';
export const GBRAIN_RULES_BLOCK_END = '<!-- GBRAIN_CLIENT_RULES_END -->';

export const GBRAIN_CLIENT_RULES = `${GBRAIN_RULES_BLOCK_START}
# GBrain 客户端规则

- 面向用户的规则、说明、标题、总结和审核提示默认使用中文。命令、代码、路径、协议字段、错误原文和必要的专有名词可以保留英文。
- 收到非平凡任务时，先通过 GBrain MCP 执行只读召回，并把结果分为“直接适用”“部分适用”或“不适用”。非平凡任务包括多步骤工作、代码或配置修改、部署迁移、故障诊断、安全隐私决策，以及影响后续工作的客户或项目规则。
- 关键执行失败只触发只读故障召回，不等于自动写入。预期失败测试、正常否定探测、无匹配、立即修正的命令错误，以及一次重试即恢复且无复用价值的瞬时故障，不计入需要总结的失败。
- 相同或高度相似的失败场景第 2 次独立出现时，停止盲目重试并整理错误总结。未改变条件的连续重试只算一次；跨任务、跨运行，或经过有效干预后再次发生，才增加发生次数。
- 客户或项目规则、任务或里程碑总结、失败或根因总结，以及新增或实质更新的知识、runbook 和决策记录，完成搜索去重、脱敏和固定模板整理后，直接通过 MCP 写入 \`inbox/\` 草稿；不需要写入前人工审核。
- 写入前向用户简要说明预分类和目标 slug，但不要等待用户确认、创建倒计时或恢复会话。随后立即调用 \`put_page\`，再用 \`get_page\` 验证写入结果。
- 每个新草稿必须由大模型写入 \`review_recommendation\`，包含建议分类、中文使用场景、中文理由和 \`generated_by: model\`；不得要求用户预先选择分类。人工审核只确认或修改分类，“拒绝并删除”也是分类之一。
- 写入后的正文视为锁定。后续人工审核只调整分类、标签、目标目录、slug 和审核状态；正文、证据、适用条件、不适用条件或验证结果有问题时，拒绝或退回草稿，重新生成。
- 只通过连接的 GBrain MCP 写入 \`inbox/\` 草稿。写入前搜索已有页面，优先更新相同经验，避免重复创建。不得把原始会话、密集日志、令牌、密码、私钥、个人标识符或未脱敏的非回环 IP 地址写入 GBrain。
- 使用 GBrain MCP 的 \`list_pages\` 和 \`get_page\` 检查草稿。晋升只能在认证的管理员审核界面完成，匿名 MCP 客户端不得晋升。
- Codex 默认安装独立的经验收尾守卫，在任务结束前要求 Agent 完成经验收尾。守卫不调用 MCP、不写 GBrain、不读取 transcript、不创建本地经验队列；实际召回、去重、直接写入和验证仍由 Agent 按本规则执行。服务端 inbox 草稿使用 \`status: draft\` + \`verification: unverified\`；写入仍要求脱敏 \`source_refs\` 和完整、非占位的验证环境/方法/预期结果/实际结果/时间。**例外：用户明确给出的全局或项目指令本身是权威事实，可以作为经验候选。** 该候选必须标记 \`authority: user_explicit_instruction\`、\`instruction_scope: global|project\`，并以匹配范围的脱敏 \`source_refs: [user_instruction:global:<摘要>|user_instruction:project:<摘要>]\` 指向该明确指令；它不需要伪造测试验证证据。
- 客户端网络访问由云防火墙白名单控制；安装器不创建或分发凭据。
- Codex \`SessionStart\` Hook 只检查会话 \`cwd\` 直接目录中的 \`.gbrain-project.yaml\` 或显式提交的 \`.gbrain/project.yaml\`，不调用 MCP，也不创建项目 ID。本地标记缺失但发现仓库身份记录时，提示先通过 MCP 精确校验并绑定；否则只警告并继续会话。该 Hook 只检查项目身份，不参与经验采集或审核。
- 进入项目目录或开始项目任务时，只读检查祖先目录中的 \`.gbrain-project.yaml\` 和仓库根目录的 \`.gbrain/project.yaml\`，并运行 \`gbrain project current --json\` 与 \`gbrain project match --json\`；普通召回和一次性任务不得因此创建项目 ID。项目身份只认规范 \`project_id\`，不使用 Git、仓库路径、目录名、项目名称、别名或语义相似度匹配；只读取仓库中明确提交的规范 ID 记录。
- 准备写入项目经验时：先运行 \`gbrain project match --json\`。如果返回仓库记录中的 \`project_id\`，就调用 MCP \`match_project({project_id})\` 精确验证，成功后运行 \`gbrain project bind <project_id> --resolved --json\`。如果登记页不存在，调用 \`ensure_project({project_id})\` 使用同一 ID 创建。只有本地和仓库都没有 ID 时，才为本次创建生成随机 \`creation_key\`，调用 \`ensure_project({creation_key})\`，再绑定本地标记。项目身份记录只保存规范 ID，不保存密码、Token 或私钥；不得通过远程 \`put_page\` 创建或修改项目登记页。
- 写入项目经验前必须取得规范 ID，并确认当前 source 存在 \`projects/<project_id>/index\`；草稿写入 \`project_binding: bound\` 和相同 \`project_id\`。本地标记写入失败时，报告 \`project_marker_write_failed\`，保留内存中的 \`project_id\` 并继续当前任务，不创建离线队列；下一次会话不得根据 Git 或名称猜测恢复。

建议技能：\`gbrain-capture\`、\`gbrain-review\`。
${GBRAIN_RULES_BLOCK_END}
`;

export const GBRAIN_CAPTURE_SKILL = `---
name: gbrain-capture
description: 将经过验证和脱敏的持久经验同步写入 GBrain inbox 草稿；写入后可由人工审核分类。遇到客户或项目规则、任务总结、重复故障、已验证根因、可复用流程、项目里程碑，或用户要求记录知识时使用。
---

# GBrain 经验采集

默认使用中文向用户说明召回结果、候选经验、预分类建议和审核状态。命令、代码、
路径、协议字段、错误原文和必要的专有名词可以保留英文。

只使用已连接的 GBrain MCP 操作。不要安装本地 GBrain CLI，不要创建本地
离线队列，也不要索取客户端凭据作为降级方案。

## 一、区分召回与写入

非平凡任务开始时，先调用 \`search\` 或 \`query\`，再对相关候选调用
\`get_page\`。把结果明确分为“直接适用”“部分适用”或“不适用”。

非平凡任务包括：

- 多个有依赖关系的执行步骤；
- 修改代码、配置、数据、服务器或外部系统；
- 部署、迁移、调试、架构、安全或隐私判断；
- 会影响后续工作的客户要求、项目规则、偏好或约束；
- 具有明显成本、风险或难以撤销影响的工作。

只读召回不需要人工确认，也不授权调用 \`put_page\`。

## 二、处理执行失败

只有意外失败影响任务目标，并且发生阻塞、重复出现、改变策略或可能形成
可复用故障经验时，才进行故障召回。

以下情况不计入需要总结的执行失败：

- 预期失败测试；
- 用于探测状态的正常否定结果；
- 搜索没有匹配；
- 立即修正的命令拼写或引号错误；
- 一次重试即恢复且没有复用价值的瞬时故障。

相同或高度相似的失败场景第 2 次独立出现时，停止盲目重试并强制整理错误
总结。使用任务阶段、工具或命令、错误码或关键报错、环境条件和已知根因
构造故障指纹。未改变任何条件的连续重试只算一次；跨任务、跨运行，或
经过有效干预后再次发生，才增加发生次数。

根因未验证时，只能整理当前任务中的未验证分析。只有修复已经测试并确认
后，才能把根因和解决办法作为可复用经验候选。

## 三、搜索去重和预分类

写入前再次搜索 GBrain。对候选经验给出：

- 建议 \`type\`；
- 建议目标目录和 slug；
- 适用范围：当前项目、指定仓库、指定环境或跨项目；
- 建议标签和召回关键词；
- 验证状态和置信度；
- 与已有记录的关系：新增、合并、替代或冲突。

发现相同经验时，读取现有页面并提出更新方案，不要创建重复页面。所有写入
都只能使用 \`inbox/<slug>\`；不得直接写入最终 \`knowledge/\`、
\`runbooks/\`、\`incidents/\` 或其他晋升目录。

项目经验写入前先运行 \`gbrain project current --json\` 和
\`gbrain project match --json\`。项目身份只认规范 \`project_id\`，不使用 Git、
仓库路径、目录名、项目名称、别名或语义相似度匹配；只读取仓库中明确提交的
\`.gbrain/project.yaml\` 规范 ID 记录。

- 仓库记录或本地标记已有 ID：调用 MCP \`match_project({project_id})\`，只检查当前
  source 的 \`projects/<project_id>/index\`。不存在时调用
  \`ensure_project({project_id})\`，必须使用同一个 ID 创建；校验成功后运行
  \`gbrain project bind <project_id> --resolved --json\`。
- 本地和仓库都没有 ID：为本次创建动作生成不含业务信息的随机 \`creation_key\`，调用
  MCP \`ensure_project({creation_key})\`。服务端返回 ID 后运行
  \`gbrain project bind <project_id> --resolved --json\`。
- 最后重新运行 \`gbrain project current --json\`，并通过 MCP \`get_page\`
  验证精确登记页。不得通过远程 \`put_page\` 创建或修改项目登记页。

本地标记写入失败时，报告 \`project_marker_write_failed\`，保留内存中的
\`project_id\` 并继续当前任务的经验审核和写入；提示修复权限后执行
\`bind --resolved\`。不得创建本地离线队列，也不得在下次会话中根据 Git 或
名称猜测恢复。取得规范 ID 和登记页之前，不得调用 \`put_page\` 写入项目经验。

## 四、固定经验模板

必须使用下面的 frontmatter 字段和正文顺序。不得删除章节。

\`\`\`markdown
---
type: <incident|knowledge|runbook|project>
date: <YYYY-MM-DD>
status: draft
sensitivity: <internal|private|public>
verification: <unverified|verified>
authority: <verified_execution|user_explicit_instruction>
instruction_scope: <null|global|project>
applicability:
  - <必须满足的适用条件>
non_applicable:
  - <明确不适用的条件>
source_refs:
  - <脱敏后的证据指针>
migrated_from: null
project_binding: <非项目草稿填 pending；项目经验填 bound>
project_id: <非项目草稿填 null；项目经验填 prj-0123456789abcdef>
review_recommendation:
  category: <project|knowledge|runbook|incident|reject>
  scenario: <用中文清晰描述这条经验适用的实际场景，最多 500 字>
  reason: <用中文说明推荐该分类的原因，最多 500 字>
  generated_by: model
---

# <中文经验标题>

## 场景与目标

- 任务目标：
- 所处阶段：
- 相关工具或组件：
- 环境与版本条件：
- 前置条件：

## 现象与识别信号

- 可观察现象：
- 错误码或故障指纹：
- 重复发生次数：
- 与相似场景的区别：

## 适用条件

- 必须同时满足：
- 可选辅助信号：

## 不适用条件

- 不适用于：
- 必须先排除：
- 容易混淆但根因不同的场景：

## 结论与根因

- 核心结论：
- 已确认根因：
- 根因与表面现象的区别：

## 处理步骤

1. 判断：
2. 处理：
3. 验证：
4. 退出或回退条件：

## 无效尝试

- 尝试：
- 无效原因：
- 该方法可能有效的条件：

## 验证证据

- 验证环境：
- 验证方法：
- 预期结果：
- 实际结果：
- 验证时间：

## 召回提示

- 推荐关键词：
- 推荐匹配条件：
- 禁止仅凭哪些信号套用：

## 脱敏说明

- 已移除或替换的信息类别：
\`\`\`

项目经验必须把模板中的项目字段具体填写为：

\`\`\`yaml
project_binding: bound
project_id: prj-0123456789abcdef
\`\`\`

服务端还会校验当前 source 中的
\`projects/<project_id>/index\`。任一条件不满足时停止写入。

\`applicability\`、\`non_applicable\`、“适用条件”“不适用条件”和“召回提示”
都是必填项。缺少任何一项时不得写入。
review_recommendation 也必须由当前大模型在采集时给出，不能要求用户先选分类，
也不能用确定性规则冒充模型建议。project 仅适用于已绑定规范 project_id 的草稿；
审核者不同意建议时，只需在审核页修改分类下拉框。

项目规则类经验没有故障信息时，可以把“现象与识别信号”“结论与根因”和
“无效尝试”填写为“不适用”，但不能删除章节。用户明确给出的全局指令或
当前项目指令可作为经验：填写 \`authority: user_explicit_instruction\` 与
\`instruction_scope: global\` 或 \`project\`，并将 \`source_refs\` 写为相同范围的
脱敏 \`user_instruction:global:<摘要>\` 或 \`user_instruction:project:<摘要>\`；它是
指令事实，不应伪造为已测试的因果结论或补造验证结果。

## 五、脱敏与证据

只保存提炼后的结论和脱敏证据指针。不得保存原始会话、密集日志、令牌、
客户端密钥、密码、私钥、原始认证文件、个人标识符或未脱敏的非回环 IP
地址。新根因分析在测试确认前必须保持 \`verification: unverified\`。

## 六、同步写入

以下内容完成搜索去重、自动脱敏和固定模板整理后，直接同步写入：

- 客户要求、项目规则、偏好和约束；
- 任务总结和项目里程碑；
- 重复故障、失败总结、根因和解决办法；
- 新增或实质更新的知识、runbook 和决策记录。

写入规则：

- 向用户简要说明预分类和目标 \`inbox/\` slug，但不等待确认或审核；
- 立即调用 \`put_page\` 写入完整正文，再调用 \`get_page\` 验证；
- 用户随后提出拒绝或修改时，按反馈更新或删除草稿，不创建本地离线队列；
- 正文发生变化时，重新完成脱敏、去重和写入；
- 不得绕过固定模板、\`inbox/\` 限制、项目身份校验和后续晋升审核。

## 七、写入后内容锁定

写入前确认或静默超时只授权写入刚刚展示的完整版本。写入后正文视为锁定。
后续审核可以修改分类、标签、目标目录、slug 和审核状态，但不得修改正文、
证据、适用条件、不适用条件或验证结果。
`;

export const GBRAIN_REVIEW_SKILL = `---
name: gbrain-review
description: 审核 GBrain inbox 草稿，并在明确人工决策下保留、合并、退回、拒绝或晋升；分类审核不得修改已经确认的正文。
---

# GBrain 经验审核

默认使用中文说明审核结论和理由。命令、路径、协议字段和必要的专有名词
可以保留英文。

使用已连接的 GBrain MCP \`list_pages\` 和 \`get_page\` 检查 \`inbox/\`
草稿。晋升只能在认证的管理员审核界面完成。

## 审核内容

- 检查固定模板是否完整；
- 检查适用条件、不适用条件和召回提示能否避免错误套用；
- 检查证据指针、验证状态和脱敏说明；
- 检查建议类型、范围、标签、目标目录和 slug；
- 检查与已有记录的关系是新增、合并、替代还是冲突。
- 项目经验只允许晋升到 \`projects/<project_id>/\`，且目录 ID 必须与
  frontmatter 的 \`project_id\` 一致。
- 跨项目通用经验晋升到 \`knowledge/\` 或 \`runbooks/\` 时保留
  \`source_project_ids\`，不得丢失来源项目。

## 内容锁定

写入前已经确认的正文视为锁定。分类审核只调整分类、标签、目标目录、slug
和审核状态，不得修改已确认正文、证据、适用条件、不适用条件或验证结果。

如果正文错误、模板不完整或证据不足，拒绝或退回草稿并说明原因。由采集
流程重新生成修订版、重新展示全文并重新完成写入前审核。审核阶段不得
静默修复正文。

## 晋升边界

- 审核从 \`inbox/\` 草稿开始；
- 不自动晋升；
- 匿名 MCP 客户端不得晋升；
- 需要补充证据或拒绝时必须给出原因；
- 只保留脱敏证据指针，不保留原始日志或秘密信息。
`;
