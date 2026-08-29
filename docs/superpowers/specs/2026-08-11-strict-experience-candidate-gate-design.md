# 严格经验候选门禁设计

日期：2026-08-11
状态：用户已确认，待实现

## 决策

GBrain 客户端默认将收尾结果判定为 `no_candidate`。Closeout Worker 只有在候选满足一条
资格路径，并通过全部质量门禁后，才能写入 `inbox/`。任务复杂、工具调用多、代码修改完成、
测试通过或产生了一段总结，都不能单独构成经验。

本设计收紧经验写入，不取消非平凡任务开始时的只读召回。Recall Worker 继续帮助当前任务
复用既有知识；Closeout Worker 负责判断本次任务是否产生了值得长期保留的新内容。

## 问题

当前客户端规则把“任务或里程碑总结”和“新增或实质更新的知识”直接列入同步写入范围。
这些类别没有最低证据要求，普通排查、一次性回答和常规交付都可以被改写成经验。

当前 Hook 还会在以下任一条件成立时要求收尾：

- 用户提示匹配宽泛的 `NONTRIVIAL_RE`；
- 当前回合累计至少三个工具事件；
- 出现写操作、关键命令、子 Agent 或意外失败。

因此，多个只读命令也会触发 Closeout Worker。Hook 只要求 Worker 完成召回、去重和回执，
没有要求 Worker 证明候选的新颖性、持久性和复用价值。写入流程完整，不代表内容值得保存。

## 目标

- 普通问答、一次性排查和常规交付默认不产生经验草稿。
- 每个 `captured` 结果都能说明保存依据、验证证据、适用条件和新增价值。
- 相同内容已经存在时不创建新草稿；只有实质增量才允许更新既有草稿。
- 减少无意义的 Closeout Worker 调用，同时保留关键失败和持久变更的收尾检查。
- 保持 Hook 的隐私边界：不调用 MCP、不读取 transcript、不保存原始提示或工具输出。

## 非目标

- 不改变 GBrain 服务端的页面 schema、审核分类或管理员晋升流程。
- 不取消非平凡任务开始时的只读经验召回。
- 不让 Hook 判断经验正文质量。正文判断仍由隔离的 Closeout Worker 完成。
- 不自动清理历史低质量页面。历史清理需要单独的审核和删除方案。

## 方案选择

### 方案 A：只修改 Closeout Worker 提示

在现有提示中增加“谨慎写入”。改动小，但宽泛 Hook 仍频繁启动 Worker，客户端规则中的
同步写入清单也继续暗示普通总结具有保存资格。提示容易在后续安装器更新中漂移。

### 方案 B：资格路径、质量门禁与 Hook 降噪一起修改（采用）

客户端规则和 `gbrain-capture` 定义同一套资格路径。Hook 移除工具数量门槛，并把只读召回
意图与收尾意图分开。`captured` 回执必须携带合法的候选依据。该方案同时减少无效检查和
低质量写入，并能用单元测试固定行为。

### 方案 C：只有用户明确要求保存时才采集

误写率最低，但会漏掉重复故障、验证完备的通用修复和关键项目里程碑。用户已选择保留
严格的自动采集，因此不采用。

## 候选资格路径

Closeout Worker 必须选择且只能选择以下一条路径。无法选择时返回 `no_candidate`。

### `explicit_retention_request`

用户明确使用“记住”“保存为经验”“记录这条规则”等持久化指令。普通意见、抱怨、方案讨论
和项目要求不等于持久化请求。该路径允许保存用户权威指令，但仍需通过去重、脱敏、模板和
项目绑定校验。

### `repeated_verified_incident`

同一故障在不同任务、不同运行，或经过有效干预后再次出现，累计至少两次。候选必须包含：

- 可区分的故障指纹；
- 已验证根因；
- 已执行并验证的修复；
- 明确的适用与不适用条件。

未改变条件的连续重试只算一次。首次故障、瞬时故障和未验证分析不能使用该路径。

### `verified_reusable_knowledge`

任务产生了代码或文档之外仍需保留的通用结论、决策或 runbook。候选必须经过实际验证，
能够指导至少一个未来任务，并说明代码或现有文档为何不足以承载该信息。常规代码修改、
测试通过和已有实现的复述不满足该路径。

### `verified_project_milestone`

项目发生了会影响后续工作的状态变化，例如正式发布、迁移完成、关键能力启用或外部验收
通过。候选必须包含可核验的完成状态、验证证据和剩余风险。中间进度、设计获批、普通提交、
“任务完成”以及尚未实施的方案不算里程碑。

## 强制质量门禁

选择资格路径后，Closeout Worker 必须逐项检查以下条件。任一条件失败即返回
`no_candidate`：

1. **新颖性**：搜索和 `get_page` 没有发现相同经验，或本次提供了可明确指出的实质增量。
2. **持久性**：内容在当前会话结束后仍会影响未来执行，而不是过程日志或当前状态播报。
3. **证据**：执行类经验具有完整、非占位的验证环境、方法、预期结果、实际结果和时间。
4. **可操作性**：执行类正文包含识别信号、适用条件、不适用条件、处理步骤和退出条件。
5. **信息密度**：固定模板各章节包含具体内容，不使用空章节、泛化句或为了填模板而补造的信息。
6. **载体必要性**：代码、测试或现有权威文档已经完整表达的行为不再复制到经验库，除非候选
   解释了跨文件、跨系统或操作环境中的额外约束。

用户明确的持久化指令不需要伪造执行验证或处理步骤。该路径以明确的指令正文、适用范围和
不适用范围满足证据与可操作性门禁，并且必须使用
`authority: user_explicit_instruction`、正确的 `instruction_scope` 和脱敏
`user_instruction:*` 来源指针。

## 默认拒绝清单

以下内容直接返回 `no_candidate`，除非用户明确要求持久化：

- 普通问答、概念解释和报错含义说明；
- 首次出现的一次性故障；
- 未实施建议、待确认设计和未验证推测；
- 常规代码修改、测试通过、代码审查无发现或普通提交；
- 工具调用记录、命令输出、任务过程和“已完成”式总结；
- 已由代码、测试或权威文档完整表达且没有新增约束的事实；
- Hook 提示、Worker token、receipt、经验采集过程及其元讨论；
- 空章节、占位符或只改写任务描述的模板正文。

本次 `additionalContextLimit` 警告解释属于固定负例：只解释一次非阻塞配置警告，未实施修复，
仓库代码已经表达正确行为，因此必须返回 `no_candidate`。

## Hook 触发策略

### Recall 与 Closeout 分离

保留宽泛的非平凡任务检测用于 Recall Worker。新增独立的持久化意图标志，不再用
`intent_nontrivial` 自动要求 Closeout Worker。

Closeout 只在以下条件之一成立时启动：

- 用户提示明确包含持久化请求；
- 当前回合发生代码、配置或数据写入；
- 执行了关键外部变更命令；
- 出现非预期失败；
- 存在尚未完成的 Closeout 状态。

子 Agent 调用本身不再触发 Closeout。只读工具事件数量也不参与判断。

### 最小状态

Hook 只增加布尔状态，例如 `explicit_persist_intent`。工具事件继续只保存哈希、布尔分类、
时间戳和合法 `inbox/` slug。Hook 不保存匹配到的提示文本，也不记录经验正文。

### Closeout Worker 提示

Closeout Worker 收到按顺序执行的决策表：

1. 搜索并读取候选重复项；
2. 选择一条资格路径；
3. 检查六项质量门禁；
4. 任一门禁失败则提交 `no_candidate`；
5. 全部通过后才整理模板、写入和回读验证。

提示明确声明“默认 `no_candidate`”以及“任务复杂度、工具数量和完成状态不是候选依据”。

## 回执契约

`no_candidate` 和 `blocked` 的现有 envelope 保持不变。`captured` 回执新增必填字段
`candidate_basis`，取值为：

- `explicit_retention_request`
- `repeated_verified_incident`
- `verified_reusable_knowledge`
- `verified_project_milestone`

守卫只验证枚举、`inbox/` slug、`verified` 和 envelope 大小。候选内容和质量门禁仍由
Closeout Worker 与 GBrain 服务端校验，避免 Hook 接触正文。

CLI receipt 命令为 `captured` 增加 `--candidate-basis <value>`。其他 outcome 携带该参数时
返回错误，防止调用方把模糊依据附在 `no_candidate` 上。

## 客户端规则与技能

`GBRAIN_CLIENT_RULES` 删除“任务或里程碑总结”“新增知识”自动进入同步写入范围的表述，改为：

- 默认 `no_candidate`；
- 只允许四条资格路径；
- 六项质量门禁全部通过后才能写入；
- 普通问答、首次故障、常规交付和元流程禁止写入。

`GBRAIN_CAPTURE_SKILL` 增加独立的“候选资格门禁”阶段，位于故障处理之后、搜索预分类之前。
同步写入章节只描述已经通过门禁的候选，不再列出宽泛内容类别。技能 description 同步缩窄，
避免普通“任务总结”直接触发采集。

Codex 与 OpenCode 使用相同的生成内容和 Python 守卫，因此两端必须保持行为一致。

## 测试设计

### Hook 单元测试

在 `test/gbrain-experience-hook.test.ts` 固定以下行为：

- 三个及以上只读工具事件不启动 Closeout；
- 普通“诊断”“总结”提示只启动 Recall，不自动启动 Closeout；
- 明确的“保存为经验”提示启动 Closeout；
- 写操作、关键外部变更和非预期失败仍启动 Closeout；
- 子 Agent 调用本身不启动 Closeout；
- `captured` 缺少或携带非法 `candidate_basis` 时拒绝回执；
- `no_candidate` 或 `blocked` 携带 `candidate_basis` 时拒绝回执；
- Hook 状态文件不包含原始提示、命令或工具输出。

### 安装器与技能测试

在 `test/gbrain-client-installer.test.ts` 固定生成内容：

- 客户端规则和 capture skill 都包含“默认 `no_candidate`”；
- 两处都列出四条资格路径和默认拒绝清单；
- 不再把普通任务总结、新增知识或首次故障列为自动写入对象；
- Closeout Worker 提示包含六项门禁和 `candidate_basis` 回执要求；
- Codex 与 OpenCode 安装结果保持一致；
- 安装器重复运行保持幂等。

### 负例语料

测试至少覆盖以下负例：

- “这个 `additionalContextLimit` 警告是什么意思？”
- “项目代码修改了吗？”且实际没有修改；
- 一次失败后立即恢复的命令；
- 普通代码修改并通过测试，但没有新约束或复用结论；
- 仅获批准、尚未实施的设计；
- 已存在于权威文档或代码中的行为说明。

### 正例语料

测试至少覆盖以下正例：

- 用户明确要求保存一条全局规则；
- 第二次独立出现且完成修复验证的同类故障；
- 代码无法单独表达的、经过验证的跨系统 runbook；
- 已验证完成并影响后续执行的发布或迁移里程碑。

## 影响文件

实现阶段预计修改：

- `src/commands/gbrain-codex-experience-hook-content.ts`
- `src/commands/gbrain-opencode-experience-plugin-content.ts`，仅在适配器断言需要同步时修改
- `src/commands/gbrain-client-installer-content.ts`
- `test/gbrain-experience-hook.test.ts`
- `test/gbrain-opencode-experience-plugin.serial.test.ts`
- `test/gbrain-client-installer.test.ts`
- `docs/architecture/KEY_FILES.md`
- `docs/deployment/client-onboarding.md`

实现后使用安装器重新生成本机 Codex 与 OpenCode 的 GBrain 规则、技能和 Hook。重新安装只
更新受管内容，保留用户的其他配置。

## 验收标准

- 三个或更多只读工具调用不再触发 Closeout Worker。
- 普通问答、首次故障、未实施设计和常规交付不会写入 `inbox/`。
- 每个 `captured` 回执都携带一条合法 `candidate_basis`。
- Closeout Worker 在写入前完成去重和六项质量门禁，任一失败返回 `no_candidate`。
- 用户明确持久化请求、重复验证故障、通用验证知识和验证里程碑仍可写入。
- Codex 与 OpenCode 使用相同门禁，Hook 继续满足现有隐私和 fail-open 约束。
- 目标单元测试、类型检查和文档校验通过。
