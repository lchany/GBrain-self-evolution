# GBrain 业务项目身份与项目经验命名空间设计

## 状态

- 日期：2026-07-30
- 状态：待用户书面规范审核
- 设计结论：项目登记页与项目命名空间

## 结论

GBrain 使用不可变的 `project_id` 标识业务项目，使用可修改的
`project_name` 和别名帮助人类识别项目。项目登记页是项目身份的唯一真源；
每条项目专属经验同时保存 `project_id`，并存放在对应的项目命名空间。

项目规则负责触发检测，客户端 Skill 负责编排匹配和确认流程，GBrain
服务端负责最终的强制校验。任何一层失效时，未绑定的项目经验都不能进入
正式 `projects/` 目录。

## 问题

当前 `type: project` 只能说明页面属于项目经验，不能稳定回答它属于哪个
业务项目。现有实现还存在一条契约断裂：

- 结构化捕获接受 `--project-id`；
- 草稿构建器把项目 ID 转换为 `applicability: project:<id>`；
- 审核列表和筛选读取 `frontmatter.project_id`；
- 固定九字段 schema 没有正式定义 `project_id`。

因此，项目 ID 可能只存在于旧 slug、正文或临时捕获对象中。项目改名、
仓库迁移、跨仓库协作或工作目录变化后，系统无法可靠聚合同一业务项目的
历史经验。

## 目标

- 用不可变 ID 唯一标识一个业务项目。
- 支持一个业务项目关联多个仓库、工作目录、机器、容器和环境。
- 让项目名称和别名可修改，而不破坏历史关联。
- 让项目专属经验按项目命名空间存储和检索。
- 让跨项目经验保留来源项目，但不受单一项目适用范围约束。
- 让已有但未绑定的本机项目安全接入。
- 让规则、Skill、审核界面和服务端校验使用同一份项目身份契约。
- 保持旧 `legacy-migration/` 数据可读，不执行无证据的自动归属。

## 非目标

- 不把 Git 仓库等同于业务项目。
- 不根据目录名、项目名称或关键词静默创建项目。
- 不在本次变更中自动重写全部遗留经验。
- 不把机器地址、私有绝对路径、凭据或原始日志写入项目登记页。
- 不引入通用图实体系统；项目与资源的关系先使用登记页和显式引用表达。
- 不改变 Brain 和 Source 两条既有路由轴。`project_id` 是 Source 内部的业务
  归属维度，不替代 `brain_id` 或 `source_id`。

## 身份模型

### 不可变项目 ID

项目 ID 使用以下格式：

```text
prj-<16 lowercase hex characters>
```

ID 由密码学安全随机数生成。创建前必须在当前 Brain 和 Source 中检查冲突。
ID 不从项目名称、仓库 URL、工作目录或用户名派生，避免改名、迁移和隐私
信息导致身份变化。

### 可变显示信息

项目登记页保存：

- `project_name`：当前显示名称；
- `project_aliases`：历史名称、仓库简称和人工确认的常用别名；
- `repository_refs`：用于精确匹配的规范化仓库引用；
- `environment_refs`：关联的 GBrain 环境页 slug。

项目改名只更新 `project_name`，并把旧名称加入 `project_aliases`。
`project_id` 永不修改。

### 两层关系

业务项目是第一层。仓库、工作目录、机器、容器和环境是第二层关联对象。
一个业务项目可以关联多个第二层对象；一个工作目录在同一时刻只能通过本地
标记绑定一个业务项目。

## 存储模型

### 项目登记页

每个业务项目只有一张登记页：

```text
projects/<project_id>/index
```

示例：

```yaml
---
type: project
record_kind: project-registry
project_id: prj-a81f0c4263d94217
project_name: acme-example agent platform
project_aliases:
  - acme-agent
repository_refs:
  - https://github.com/acme-example/agent-platform.git
environment_refs: []
date: 2026-07-30
status: reviewed
sensitivity: internal
verification: unverified
applicability:
  - project:prj-a81f0c4263d94217
non_applicable: []
source_refs:
  - user-confirmed:2026-07-30
migrated_from: null
---
```

登记页是名称、别名和关联对象的唯一真源。其他经验页面不复制这些可变
字段。

### 项目专属经验

项目专属经验存放在：

```text
projects/<project_id>/<date>-<experience-slug>
```

示例：

```yaml
---
type: project
record_kind: project-experience
project_id: prj-a81f0c4263d94217
date: 2026-07-30
status: reviewed
sensitivity: internal
verification: verified
applicability:
  - project:prj-a81f0c4263d94217
non_applicable: []
source_refs:
  - commit:0123456789abcdef
migrated_from: null
---
```

服务端必须同时校验：

- slug 中的项目 ID 与 frontmatter `project_id` 一致；
- `projects/<project_id>/index` 存在；
- 登记页的 `record_kind` 是 `project-registry`；
- 经验页的 `record_kind` 是 `project-experience`。

### 跨项目经验

项目经验只有经过人工审核确认可复用后，才能晋升到全局目录：

```text
knowledge/
incidents/
runbooks/
decisions/
```

晋升后的页面使用 `source_project_ids` 保留来源：

```yaml
source_project_ids:
  - prj-a81f0c4263d94217
```

`source_project_ids` 表示证据来源，不等同于 `applicability`。全局经验仍须
独立声明适用条件和不适用条件。

### 未绑定草稿

项目上下文尚未确认时，候选经验只能进入 `inbox/`：

```yaml
project_binding: pending
project_id: null
```

审核界面必须显示“项目待绑定”。`project_binding: pending` 的草稿可以被
退回、拒绝或补充证据，但不能晋升到 `projects/`。

绑定后，草稿使用：

```yaml
project_binding: bound
project_id: prj-a81f0c4263d94217
```

## 本地工作目录标记

每个已绑定工作目录保存轻量标记：

```yaml
# .gbrain-project.yaml
schema_version: 1
project_id: prj-a81f0c4263d94217
```

标记文件不保存项目名称、仓库 URL 或环境信息。读取时从当前目录向上查找，
直到文件系统根目录或 Git 工作区边界。发现标记后，系统必须到当前 Brain
和 Source 验证对应登记页。

本地标记指向不存在的登记页时，状态是 `broken-binding`，不能自动创建同 ID
登记页，也不能写入项目经验。

## 已有项目接入

### 匹配顺序

没有本地标记时，系统按以下顺序只读匹配：

1. 用户显式提供的 `project_id`；
2. 已登记的规范化 Git remote URL；
3. 人工确认的项目别名；
4. 项目名称和其他弱匹配信号。

只有第一项可以直接定位项目。第二项产生“唯一候选”时仍需要人工确认。
别名、名称和关键词只能生成候选，不能自动绑定。

### 匹配结果

- 唯一候选：展示项目 ID、名称和匹配依据，确认后写本地标记；
- 多个候选：禁止自动选择，要求用户选择；
- 没有候选：生成新项目登记建议；
- 登记页失效：报告 `broken-binding`，要求修复或重新选择。

### 新项目创建

新项目创建必须按以下顺序执行：

1. 生成候选 `project_id`；
2. 展示项目名称、规范化仓库引用和建议项目根目录；
3. 获得用户明确确认；
4. 创建项目登记页；
5. 重新读取登记页，验证可检索；
6. 原子写入 `.gbrain-project.yaml`；
7. 再次解析当前项目上下文。

登记页创建或检索验证失败时，不写本地标记。标记写入失败时，保留登记页并
返回可重试的本地绑定错误。

非 Git 项目由用户明确指定项目根目录，其他流程相同。

## 触发模型

### 第一阶段：只读检测

以下事件触发只读项目上下文检测：

- 新会话进入工作目录；
- 当前目录切换到另一个仓库；
- 开始非平凡项目任务；
- 执行项目级 GBrain 召回；
- Git remote 或项目根目录发生变化。

只读检测查找本地标记、验证登记页并搜索候选。它不创建 ID，不写文件。
单纯克隆、下载、浏览或只读检查仓库不会创建业务项目。

### 第二阶段：绑定硬门禁

以下事件要求项目身份进入 `bound` 状态：

- 写入 `type: project` 的经验；
- 记录项目规则、项目决策或项目里程碑；
- 同类项目故障第二次独立出现并形成故障总结；
- 项目任务结束并生成归档；
- 把草稿晋升到 `projects/`；
- 用户显式执行项目初始化或绑定。

用户未确认时，候选经验只能留在 `inbox/`。

### 不触发创建

- 普通问答和闲聊；
- 单纯下载或查看第三方仓库；
- 临时测试目录和依赖源码目录；
- 纯只读 GBrain 搜索；
- 与当前项目无关的通用知识整理。

## 三层治理机制

### 项目规则

客户端 `AGENTS.md` 管理块定义“什么时候必须检测或绑定”：

- 非平凡项目任务开始时执行只读检测；
- 项目经验写入前必须获得有效 `project_id`；
- 多候选时不得自动选择；
- 未经用户确认不得创建项目登记页或本地标记。

### 客户端 Skill

`gbrain-capture` 复用统一的项目上下文解析流程：

```text
resolve-project-context
├── 查找本地标记
├── 验证登记页
├── 规范化仓库引用
├── 搜索已有项目
├── 展示匹配证据
└── 生成绑定或创建建议
```

项目捕获、项目归档和人工审核不得各自实现不一致的匹配规则。

### 服务端门禁

服务端不信任客户端已经正确执行 Skill。`put_page` 和审核晋升必须独立检查
项目路径、`project_id`、登记页和绑定状态。匿名 MCP 写入仍只能创建
`inbox/` 草稿；正式晋升继续由认证管理员界面执行。

## CLI 与审核界面

新增本机 CLI：

```text
gbrain project current [--json]
gbrain project match [--json]
gbrain project init --name <name> [--repo <url>]
gbrain project bind <project_id> --confirmed
```

- `current` 只读解析当前绑定；
- `match` 只读生成脱敏后的 MCP 交接参数；
- `init` 展示创建计划并要求确认；
- `bind` 展示绑定计划并要求确认。

客户端把 `match` 返回的参数传给已连接 MCP 的 `match_project`，由服务端
在调用方 Source 范围内返回候选。即使只有一个候选也必须人工确认。
`bind` 缺少 `--confirmed` 时必须失败关闭。远程 MCP 不读取服务端工作目录，
也不解析客户端 `.gbrain-project.yaml`。完整契约见
`2026-07-30-mcp-project-matching-design.md`。

审核界面增加：

- 项目 ID 和项目名称列；
- `pending`、`bound`、`broken-binding` 状态；
- 按 `project_id` 筛选；
- 项目登记页精确验证；
- 晋升目标 `projects/<project_id>/<slug>` 预览；
- 多候选时的人工选择门禁。

## Schema 和兼容性

严格 schema 增加以下受控字段：

- `record_kind`；
- `project_id`；
- `project_name`；
- `project_aliases`；
- `repository_refs`；
- `environment_refs`；
- `project_binding`；
- `source_project_ids`。

字段按页面类型和路径条件化要求，不把全部字段变成所有页面的通用必填项。

兼容规则：

- 新建的正式 `projects/` 页面必须使用新命名空间；
- `legacy-migration/` 页面保持原样，不强制补充项目 ID；
- 旧 slug 中的 `prj-*` 只能作为迁移候选证据；
- 历史页面只有在证据唯一且人工确认后才能回填；
- 无法确认归属的历史页面继续保留为未绑定遗留经验；
- 当前 `--project-id` 到 `applicability` 的映射改为同时写入正式
  `project_id`，`applicability` 继续表达适用范围；
- 审核列表、API、CLI 和持久化统一读取同一 `project_id` 字段。

## 错误处理

稳定错误类别：

- `project_unbound`：项目经验缺少绑定；
- `project_match_ambiguous`：存在多个候选；
- `project_registry_missing`：登记页不存在；
- `project_id_path_mismatch`：路径与字段不一致；
- `project_binding_broken`：本地标记无法解析；
- `project_confirmation_required`：缺少人工确认；
- `project_marker_write_failed`：登记完成但本地标记写入失败。

所有错误默认使用中文用户说明和稳定英文错误码。错误响应不返回未经脱敏的
绝对路径、环境变量或仓库凭据。

## 测试策略

实现遵循 TDD，先让行为测试在旧实现上失败。

### 单元测试

- 项目 ID 格式、随机生成和冲突重试；
- Git remote 规范化；
- `.gbrain-project.yaml` 向上查找和 Git 边界；
- `unbound`、`bound`、`ambiguous`、`broken-binding` 状态机；
- 项目登记页和经验页 frontmatter 校验；
- 路径 ID 与字段 ID 一致性；
- 捕获构建器持久化 `project_id`；
- 未绑定草稿保持 `pending`。

### 集成测试

- 创建登记页后才能写入项目经验；
- 唯一仓库候选仍要求确认；
- 多候选不能自动绑定；
- `put_page` 拒绝无项目 ID 的正式项目页；
- 审核晋升生成项目命名空间目标；
- 全局晋升保留 `source_project_ids`；
- 匿名 MCP 不能绕过管理员晋升；
- PGLite 和 Postgres 使用相同校验结果。

### 客户端安装器测试

- Codex 和 OpenCode 安装相同项目触发规则；
- `gbrain-capture` 包含项目上下文解析和确认门禁；
- 安装器重复运行保持幂等；
- 本地非 GBrain 规则不被覆盖。

### 回归测试

- 遗留页面仍可读取和检索；
- 通用知识捕获不要求创建项目；
- 单纯下载或只读检查不创建项目；
- Source 和 Brain 路由不受 `project_id` 影响；
- 现有审核安全、Origin、确认短语和正文锁定门禁保持有效。

## 本机配置同步

代码和测试通过后，使用仓库内安装器同步本机规则与 Skills：

```bash
bun src/cli.ts install-client --json
```

同步范围仅包括安装器管理的 Codex/OpenCode GBrain 规则以及
`gbrain-capture`、`gbrain-review` Skills。安装器必须保留本机文件中的非
GBrain 管理内容，不创建凭据，不执行写入探针。

同步后检查：

- 本机管理块与 `GBRAIN_CLIENT_RULES` 一致；
- 两个平台安装的 Skill 与项目常量一致；
- 项目检测是只读操作；
- 创建和绑定仍需要人工确认；
- 未绑定项目经验无法进入正式目录。

## 实施与交付顺序

1. 为项目身份状态机、schema、捕获和审核门禁添加失败测试；
2. 实现项目上下文核心模块和 CLI；
3. 接入结构化捕获、`put_page` 校验和审核界面；
4. 更新客户端规则、Skills 和接入文档；
5. 运行目标测试、类型检查和项目规定的交付门禁；
6. 使用 `install-client` 同步本机配置并验证生成文件；
7. 执行代码复审，重点检查正确性、边界、错误处理和缺失测试；
8. 按仓库发布流程提交并推送到 GitHub。

## 验收标准

- 每条新项目经验都能确定唯一业务项目；
- 项目改名、仓库迁移和多仓库协作不会改变 `project_id`；
- 项目登记页与项目经验路径可以直接聚合同一项目历史；
- 无本地 ID 的已有项目可以匹配、确认并安全登记；
- 进入目录只做只读检测，首次项目经验写入前强制绑定；
- 规则、Skill 和服务端三层使用同一项目身份契约；
- 结构化捕获和审核界面不再读取两套不同的项目字段；
- 未绑定、多候选和失效绑定全部失败关闭；
- 历史遗留经验不被无证据自动归属；
- 本机 Codex/OpenCode 配置与项目生成源一致；
- 测试、代码复审和仓库交付门禁全部通过后才推送。
