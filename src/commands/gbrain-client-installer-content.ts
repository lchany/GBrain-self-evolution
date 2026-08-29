export const GBRAIN_RULES_BLOCK_START = '<!-- GBRAIN_CLIENT_RULES_START -->';
export const GBRAIN_RULES_BLOCK_END = '<!-- GBRAIN_CLIENT_RULES_END -->';

export const GBRAIN_CLIENT_RULES = `${GBRAIN_RULES_BLOCK_START}
# GBrain 客户端规则

- 面向用户的规则、说明、标题、总结和审核提示默认使用中文。命令、代码、路径、协议字段、错误原文和必要的专有名词可以保留英文。
- 收到非平凡任务时，主 Agent 不得直接调用 GBrain MCP 执行经验召回；必须派发独立 Recall Worker，由 Worker 完成只读召回并把结果分为“直接适用”“部分适用”或“不适用”。非平凡任务包括多步骤工作、代码或配置修改、部署迁移、故障诊断、安全隐私决策，以及影响后续工作的客户或项目规则。
- 关键执行失败先触发只读故障召回，并在首次非预期失败后触发一次 Closeout 评估，但不等于自动写入。预期失败测试、正常否定探测、无匹配、立即修正的命令错误，以及一次重试即恢复且无复用价值的瞬时故障，不计入需要总结的失败。
- 相同或高度相似的失败场景第 2 次独立出现时，停止盲目重试并整理错误总结。未改变条件的连续重试只算一次；跨任务、跨运行，或经过有效干预后再次发生，才增加发生次数。
- 经验收尾默认返回 \`no_candidate\`。只有用户明确要求持久化、同类故障第 2 次独立出现且根因与修复已验证、代码和权威文档无法完整承载的已验证通用知识，或已验证且影响后续工作的项目里程碑，才能成为候选。任务复杂度、工具数量、代码修改、测试通过或普通总结都不能单独构成经验。
- Closeout Worker 必须先搜索去重，再检查新颖性、持久性、证据、可操作性、信息密度和载体必要性；任一门禁失败即返回 \`no_candidate\`。普通问答、首次故障、未实施设计、常规交付、过程记录、元流程和已有权威事实默认禁止写入。
- Closeout Worker 直接调用 \`put_page\`，再用 \`get_page\` 验证。遇到模板、字段、项目绑定或去重等可修复服务端拒绝时，Worker 必须在自己的上下文内修正并重试；主 Agent 继续等待，不接收中间错误和修改过程。
- 每个新草稿必须由大模型写入 \`review_recommendation\`，包含建议分类、中文使用场景、中文理由和 \`generated_by: model\`；不得要求用户预先选择分类。人工审核只确认或修改分类，“拒绝并删除”也是分类之一。
- 写入后的正文视为锁定。后续人工审核只调整分类、标签、目标目录、slug 和审核状态；正文、证据、适用条件、不适用条件或验证结果有问题时，拒绝或退回草稿，重新生成。
- 只通过连接的 GBrain MCP 写入 \`inbox/\` 草稿。写入前搜索已有页面，优先更新相同经验，避免重复创建。不得把原始会话、密集日志、令牌、密码、私钥、个人标识符或未脱敏的非回环 IP 地址写入 GBrain。
- 使用 GBrain MCP 的 \`list_pages\` 和 \`get_page\` 检查草稿。晋升只能在认证的管理员审核界面完成，匿名 MCP 客户端不得晋升。
- OpenCode 与 Codex 默认安装双阶段经验守卫：非平凡任务开始时要求 Recall Worker；只有明确持久化请求、首次非预期失败或未完成的既有收尾状态才要求 Closeout Worker。普通写入、关键外部变更、只读工具数量和子 Agent 调用本身不触发收尾。守卫不调用 MCP、不写 GBrain、不读取 transcript、不创建本地经验队列；Worker 通过不可混用的一次性 token 和显式 receipt 跨 session/turn 完成阶段。服务端 inbox 草稿使用 \`status: draft\` + \`verification: unverified\`；写入仍要求脱敏 \`source_refs\` 和完整、非占位的验证环境/方法/预期结果/实际结果/时间。**例外：用户明确给出的全局或项目指令本身是权威事实，可以作为经验候选。** 该候选必须标记 \`authority: user_explicit_instruction\`、\`instruction_scope: global|project\`，并以匹配范围的脱敏 \`source_refs: [user_instruction:global:<摘要>|user_instruction:project:<摘要>]\` 指向该明确指令；它不需要伪造测试验证证据。
- 客户端网络访问由云防火墙白名单控制；安装器不创建或分发凭据。
- OpenCode 首消息守卫与 Codex \`SessionStart\` Hook 只检查会话 \`cwd\` 直接目录中的 \`.gbrain-project.yaml\` 或显式提交的 \`.gbrain/project.yaml\`，不直接调用 MCP。缺少两种标记时会注入 \`GBRAIN_PROJECT_BOOTSTRAP_REQUIRED\` 和本机原子复用的一小时 \`GBRAIN_PROJECT_BOOTSTRAP_CREATION_KEY\` lease；主 Agent 必须立即派发一个 prompt 含 \`GBRAIN_PROJECT_BOOTSTRAP_WORKER\` 的独立子 Agent，由子 Agent 使用该协调键调用 \`ensure_project\`，禁止自行生成新键，再执行 \`bind --resolved\`、读取登记页验证并运行 Hook 提供的 \`complete-bootstrap\` 清理命令。bootstrap 子 Agent 不得继续派生 bootstrap 子 Agent。
- 收到 \`GBRAIN_EXPERIENCE_RECALL_REQUIRED\` 时，主 Agent 必须立即派发独立 Recall Worker，并把 \`GBRAIN_EXPERIENCE_RECALL_WORKER_TOKEN\` 原样放入 Worker prompt。主 Agent 等待只含分类、最多三条脱敏约束和 receipt 状态的最小 envelope 后再继续任务；不得接收正文、搜索列表、模板或日志。
- 收到 \`GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED\` 时，主 Agent 必须在最终答复前派发独立 Closeout Worker，并把 \`GBRAIN_EXPERIENCE_CLOSEOUT_WORKER_TOKEN\` 原样放入 Worker prompt。主 Agent 只传递脱敏后的任务目标、变更、失败和验证证据；Worker 默认提交 \`no_candidate\`，只有四条资格路径之一成立并通过六项门禁时才写入，且 \`captured\` 回执必须包含对应 \`candidate_basis\`。Worker 完成完整经验事务和 receipt 后，主 Agent 才输出最终答复。带有任一 worker token 的 Worker 不得再次派生同类 Worker。
- 进入项目目录或开始项目任务时，只读检查祖先目录中的 \`.gbrain-project.yaml\` 和仓库根目录的 \`.gbrain/project.yaml\`，并运行 \`gbrain project current --json\` 与 \`gbrain project match --json\`。项目身份只认规范 \`project_id\`，不使用 Git、仓库路径、目录名、项目名称、别名或语义相似度匹配；只读取仓库中明确提交的规范 ID 记录。
- 准备写入项目经验时：先运行 \`gbrain project match --json\`。如果返回仓库记录中的 \`project_id\`，就调用 MCP \`match_project({project_id})\` 精确验证，成功后运行 \`gbrain project bind <project_id> --resolved --json\`。如果登记页不存在，调用 \`ensure_project({project_id})\` 使用同一 ID 创建。只有本地和仓库都没有 ID 时，才为本次创建生成随机 \`creation_key\`，调用 \`ensure_project({creation_key})\`，再绑定本地标记。项目身份记录只保存规范 ID，不保存密码、Token 或私钥；不得通过远程 \`put_page\` 创建或修改项目登记页。
- 写入项目经验前必须取得规范 ID，并确认当前 source 存在 \`projects/<project_id>/index\`；草稿写入 \`project_binding: bound\` 和相同 \`project_id\`。本地标记写入失败时，报告 \`project_marker_write_failed\`，保留内存中的 \`project_id\` 并继续当前任务，不创建离线队列；下一次会话不得根据 Git 或名称猜测恢复。

建议技能：\`gbrain-capture\`、\`gbrain-review\`。
${GBRAIN_RULES_BLOCK_END}
`;

export const GBRAIN_CAPTURE_SKILL = `---
name: gbrain-capture
description: 将通过严格候选资格与质量门禁的持久经验同步写入 GBrain inbox 草稿。仅适用于明确持久化请求、重复且已验证的故障、载体外的已验证通用知识或已验证项目里程碑；普通问答、首次故障和常规任务总结不适用。
---

# GBrain 经验采集

默认使用中文向用户说明召回结果、候选经验、预分类建议和审核状态。命令、代码、
路径、协议字段、错误原文和必要的专有名词可以保留英文。

只使用已连接的 GBrain MCP 操作。不要安装本地 GBrain CLI，不要创建本地
离线队列，也不要索取客户端凭据作为降级方案。

## 零、隔离执行契约

主 Agent 不得直接执行经验召回、去重、模板整理、写入或回读验证。收到
\`GBRAIN_EXPERIENCE_RECALL_REQUIRED\` 或 \`GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED\`
时，必须把对应 token 原样交给独立 Worker 并等待最小结构化 envelope。

带有 Recall Worker token 的 Worker 只执行只读召回。带有 Closeout Worker token
的 Worker 拥有完整经验事务：召回、去重、模板整理、写入、可修复拒绝的修正与重试、
回读验证和 receipt。Worker 不得再派生同类 Worker。

主 Agent 只能接收固定 envelope。不得把页面正文、搜索结果列表、模板、工具输出、
服务端原始错误或重试轨迹返回主会话。

## 一、区分召回与写入

Recall Worker 在非平凡任务开始时调用 \`search\` 或 \`query\`，再对相关候选调用
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

## 三、候选资格与质量门禁

Closeout Worker 默认返回 \`no_candidate\`。只有下列一条资格路径成立时才继续：

- \`explicit_retention_request\`：用户明确要求“记住”“保存为经验”或“记录这条规则”；
- \`repeated_verified_incident\`：同类故障第 2 次独立出现，且根因、修复和验证均完整；
- \`verified_reusable_knowledge\`：经过实际验证、可指导未来任务，并说明代码或现有权威文档为何不足；
- \`verified_project_milestone\`：正式发布、迁移完成、关键能力启用或外部验收等已验证状态变化。

选择资格路径后，必须依次通过六项门禁：新颖性、持久性、证据、可操作性、
信息密度和载体必要性。任一项不满足即返回 \`no_candidate\`，不得为了填模板补造信息。

以下内容默认拒绝：普通问答、概念解释、首次故障、未实施建议、待确认设计、常规代码修改、
测试通过、工具记录、任务过程、普通完成总结、已有权威事实，以及 Hook、token、receipt 等元流程。
任务复杂度、工具数量和完成状态不是候选依据。

## 四、搜索去重和预分类

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

## 五、固定经验模板

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

## 六、脱敏与证据

只保存提炼后的结论和脱敏证据指针。不得保存原始会话、密集日志、令牌、
客户端密钥、密码、私钥、原始认证文件、个人标识符或未脱敏的非回环 IP
地址。新根因分析在测试确认前必须保持 \`verification: unverified\`。

## 七、同步写入

Closeout Worker 只对已经选择一条资格路径并通过全部六项门禁的候选执行同步写入。

写入规则：

- Worker 立即调用 \`put_page\` 写入完整正文，再调用 \`get_page\` 验证；
- 可修复服务端拒绝由 Worker 在自身上下文中修正后重试，直到写入和回读验证成功；
- Worker 只向主 Agent 返回 outcome、合法 \`inbox/\` slug、verified、receipt 状态、
  \`captured\` 必填的 \`candidate_basis\` 和可选脱敏阻塞码；
- 用户随后提出拒绝或修改时，按反馈更新或删除草稿，不创建本地离线队列；
- 正文发生变化时，重新完成脱敏、去重和写入；
- 不得绕过固定模板、\`inbox/\` 限制、项目身份校验和后续晋升审核。

## 八、写入后内容锁定

写入后正文视为锁定。
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
