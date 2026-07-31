# 项目身份自动匹配或创建设计

日期：2026-07-31  
状态：待书面复核

## 结论

项目经验写入前仍须具备有效 `project_id` 和规范项目登记页，但缺少项目身份
不再阻塞正常流程。客户端在真正准备写入项目经验时，通过新的写权限 MCP
操作 `ensure_project` 请求服务端原子“匹配或创建”：

- 精确仓库匹配时自动复用；
- 没有精确仓库匹配，但名称或别名只有一个候选时自动复用；
- 完全无匹配时自动创建项目登记页和规范 ID；
- 多个候选冲突且无法唯一判断时，返回候选并等待人工选择。

服务端返回唯一项目 ID 后，客户端自动在当前 Git 项目根目录原子写入
`.gbrain-project.yaml`，然后继续经验审核和 `put_page`。本地标记写入失败
只影响后续会话复用，不阻塞当前任务使用服务端已经确认的 ID。

## 问题

当前客户端和服务端共同执行硬绑定门禁：

1. 客户端发现本地没有 `.gbrain-project.yaml`；
2. 客户端通过只读 MCP `match_project` 搜索登记页；
3. 没有候选时只能停止；
4. 服务端 `put_page` 拒绝未绑定项目经验。

硬绑定保护了项目归属，但“无候选即停止”要求用户额外执行管理员初始化。
这与“缺少项目 ID 时自动创建且不阻塞”的操作规则冲突。

不能通过放宽 `put_page` 解决这个问题。允许待绑定项目经验进入 inbox 会重新
引入归属不明确的页面。正确做法是在写入项目经验前自动补齐项目登记页和
项目 ID。

## 已考虑方案

### 方案一：新增写权限 MCP `ensure_project`

`match_project` 保持只读。`ensure_project` 使用相同的输入规范化和匹配逻辑，
但在无候选时执行受控创建。

优点：

- 读写权限清晰；
- 可以独立审计、限流和测试自动创建；
- 服务端能在同一事务中完成查重和创建；
- 客户端不需要生成或猜测项目 ID。

采用此方案。

### 方案二：给 `match_project` 增加 `create_if_missing`

该方案少一个工具，但同一个 MCP 操作会根据参数在 read 和 write 之间切换。
工具声明、OAuth scope、审计语义和调用方预期都会变得不明确，不采用。

### 方案三：客户端生成 ID 并调用 `put_page`

多个客户端可能同时生成不同 ID 并创建重复项目。客户端也可能绕过统一匹配、
source 限定和服务端审计，不采用。

## 触发时机

项目上下文检测和项目创建保持分离。

以下只读场景不会创建项目：

- 进入项目目录；
- 开始非平凡任务；
- 执行项目级召回；
- 单纯查看、下载或诊断仓库；
- 尚未形成需要持久化的项目经验。

只有准备写入以下内容，且本地项目仍未绑定时，客户端才调用
`ensure_project`：

- 客户或项目规则；
- 项目任务或里程碑总结；
- 项目决策；
- 项目专属 runbook；
- 重复项目故障或已验证根因；
- 其他 `type: project`、`record_kind: project-experience` 的经验。

因此，自动创建不会因普通浏览或只读召回产生无用项目。

## MCP 契约

### 操作声明

新增操作：

```text
ensure_project
```

属性：

- `scope: write`；
- `mutating: true`；
- 允许远程 MCP 客户端调用；
- 使用现有 HTTP MCP 身份、source 限定、云防火墙和速率限制；
- 不读取客户端文件系统；
- 不接收客户端指定的 `project_id`。

输入：

```json
{
  "repository_ref": "github.com/example/project",
  "project_name": "project"
}
```

至少提供一个字段。限制与 `match_project` 一致：

- `repository_ref` 最长 2048 字符；
- `project_name` 最长 200 字符；
- 拒绝控制字符；
- 仓库引用必须经过 `normalizeRepositoryRef`；
- 拒绝密码、查询参数、URL fragment 和无效路径。

### 返回结果

复用已有项目：

```json
{
  "ok": true,
  "status": "matched",
  "code": "ok",
  "project_id": "prj-0123456789abcdef",
  "project_name": "project",
  "registry_slug": "projects/prj-0123456789abcdef/index",
  "match_reason": "repository_ref"
}
```

创建新项目：

```json
{
  "ok": true,
  "status": "created",
  "code": "ok",
  "project_id": "prj-0123456789abcdef",
  "project_name": "project",
  "registry_slug": "projects/prj-0123456789abcdef/index"
}
```

多个冲突候选：

```json
{
  "ok": false,
  "status": "ambiguous",
  "code": "project_match_ambiguous",
  "candidates": [
    {
      "project_id": "prj-0123456789abcdef",
      "project_name": "project",
      "registry_slug": "projects/prj-0123456789abcdef/index",
      "match_reason": "name_or_alias"
    }
  ]
}
```

歧义结果不创建页面。

## 匹配决策

`ensure_project` 只读取当前写入 source。它不跨 source 猜测，也不从
`allowedSources` 中选择其他 source 的登记页。

决策顺序：

1. 规范化仓库引用和项目名称；
2. 查找当前 source 的合法 `project-registry` 页面；
3. 精确仓库候选为一个时自动复用；
4. 精确仓库候选超过一个时返回歧义；
5. 没有仓库候选时，名称或别名候选为一个则自动复用；
6. 名称或别名候选超过一个时返回歧义；
7. 没有任何候选时创建新项目。

候选合法性保持现有要求：

- slug 精确为 `projects/<project_id>/index`；
- `record_kind: project-registry`；
- slug ID 与 frontmatter `project_id` 一致；
- `project_name` 非空；
- `project_id` 匹配 `^prj-[0-9a-f]{16}$`。

## 原子创建与幂等

服务端以“当前 source + 规范化仓库引用；没有仓库时使用规范化项目名称”
作为创建身份键。

创建流程：

1. 在数据库事务中获取该身份键的 transaction advisory lock；
2. 获得锁后重新读取当前 source 的项目登记页；
3. 再次执行完整匹配决策；
4. 如果另一请求已经创建登记页，返回 `matched`；
5. 仍无候选时使用 `generateProjectId()` 生成规范随机 ID；
6. 检查 `projects/<project_id>/index` 不存在；发生极小概率碰撞时重新生成；
7. 在同一事务中写入规范登记页；
8. 提交事务后执行现有 Markdown write-through；文件写穿失败不回滚数据库
   登记页，但会进入结构化警告。

Postgres 使用 `pg_advisory_xact_lock`。PGLite 通过单连接事务串行执行同一
进程内的匹配和创建。相同输入的重复调用必须返回同一个项目 ID，不得创建
重复登记页。

本次不增加数据库表或迁移。

## 登记页内容

服务端生成：

```yaml
---
type: project
date: <服务端当前日期>
status: reviewed
sensitivity: internal
verification: verified
applicability:
  - project:<project_id>
non_applicable: []
source_refs:
  - mcp:ensure_project
migrated_from: null
record_kind: project-registry
project_id: <project_id>
project_name: <project_name>
project_aliases: []
repository_refs:
  - <规范化 repository_ref>
environment_refs: []
---
```

正文只包含通用登记说明，不保存本地绝对路径、凭据、原始 remote URL 或
其他未脱敏环境信息。

`project_name` 缺失但提供了仓库引用时，服务端使用仓库最后一个路径段作为
名称。名称经过 trim、长度和控制字符校验。

## 远程登记页写入边界

远程客户端不得直接通过 `put_page` 创建或更新
`projects/<project_id>/index`。远程请求遇到
`record_kind: project-registry` 时返回：

```text
project_registry_managed
```

提示调用 `ensure_project`。

可信本地管理员流程 `gbrain project init` 继续可用。`ensure_project`
由服务端构造登记页并直接走受控内部写入路径，不依赖远程客户端提交登记页
正文。

项目经验的现有服务端门禁不放宽：

- `type: project`；
- `record_kind: project-experience`；
- `project_binding: bound`；
- 规范 `project_id`；
- 当前写入 source 存在一致登记页。

## 客户端与本地标记

客户端写项目经验前执行：

1. `gbrain project current --json`；
2. 已绑定时，通过 MCP `get_page` 验证登记页；
3. 未绑定时，运行 `gbrain project match --json` 取得脱敏参数；
4. 使用这些参数调用 `ensure_project`；
5. 返回 `matched` 或 `created` 时，运行：

   ```bash
   gbrain project bind <project_id> --resolved --json
   ```

6. 重新运行 `gbrain project current --json`；
7. 使用 MCP `get_page` 验证登记页；
8. 继续展示完整经验正文、预分类建议和 5 分钟写入前审核；
9. 审核通过后调用 `put_page`。

`bind` 增加 `--resolved`，表示项目 ID 来自服务端唯一匹配或原子创建结果。
已有 `--confirmed` 保留，用于用户从歧义候选中明确选择的场景。

两种参数都只授权本地写标记，不改变服务端权限。CLI 仍校验 ID 格式和已有
标记冲突。

本地标记内容：

```yaml
schema_version: 1
project_id: prj-0123456789abcdef
```

写入继续复用现有临时文件、`0600` 权限和原子链接逻辑。

`.gbrain-project.yaml` 是本机绑定状态，加入项目 `.gitignore`，不推送
GitHub。

### 本地标记写入失败

服务端登记页成功后，如果本地目录不可写：

- 返回并展示 `project_marker_write_failed`；
- 当前任务把服务端返回的 `project_id` 保留在内存中；
- 当前项目经验继续使用该 ID，不阻塞审核和写入；
- 不创建本地离线队列；
- 下一次任务重新调用 `ensure_project`，服务端会复用已有登记页。

### 已有冲突标记

本地已经绑定不同项目 ID 时，不自动覆盖。这属于身份冲突，不是缺少 ID：

- 停止自动绑定；
- 展示当前 ID 和服务端候选；
- 等待人工决定保留或修复本地标记。

## 客户端规则和技能

安装器生成的 `AGENTS.md` 与 `gbrain-capture` 同步改为：

- 非平凡任务开始仍只读检测，不自动创建；
- 准备写项目经验且未绑定时调用 `ensure_project`；
- 唯一匹配或新建结果不再要求逐次人工确认；
- 多个冲突候选才要求人工选择；
- 自动执行本地 `bind --resolved`；
- 标记写入失败时使用内存 ID 继续；
- 不安装本地 GBrain CLI；
- 不索取 writer 凭据；
- 不创建本地离线队列；
- 项目经验仍执行脱敏、固定模板和 5 分钟写入前审核。

MCP 页面 schema、工作流资源、项目身份设计、匹配设计和 `KEY_FILES.md`
同步更新，删除“完全无匹配时保持 pending 并停止”的旧描述。

## 错误与审计

稳定错误或状态代码：

- `project_match_input_required`；
- `project_match_input_invalid`；
- `repository_ref_invalid`；
- `project_match_ambiguous`；
- `project_registry_collision`；
- `project_registry_write_failed`；
- `project_registry_managed`；
- `project_marker_write_failed`；
- `project_binding_conflict`。

`ensure_project` 记录服务端审计信息：

- 操作名；
- 当前 source；
- 结果为 `matched`、`created` 或 `ambiguous`；
- 返回的项目 ID；
- 匹配依据。

日志不得保存凭据、原始带认证 remote URL、本地路径或客户端提交的未脱敏
环境信息。

## 安全边界

- `ensure_project` 要求 write scope，不通过 read token 创建项目；
- 输入经过长度、控制字符和仓库引用规范化校验；
- 创建仅发生在当前写入 source；
- 客户端不能指定 ID；
- 事务锁与锁内二次匹配防止并发重复；
- ID 碰撞检查防止覆盖已有登记页；
- 多候选时失败关闭，不自动选择；
- 远程 `put_page` 不能绕过受控创建路径；
- 现有 HTTP MCP 限流和云防火墙策略继续生效；
- 不新增凭据，不改变管理员审核权限。

## 测试策略

实现遵循 TDD。

### MCP 操作测试

- `ensure_project` 声明为 write scope、mutating；
- read scope 客户端不能调用；
- 精确仓库唯一候选自动复用；
- 唯一名称或别名候选自动复用；
- 多个仓库候选返回歧义且不写入；
- 多个名称候选返回歧义且不写入；
- 无候选时创建规范登记页和随机 ID；
- 缺少名称时从仓库路径推导名称；
- 重复相同请求返回同一 ID；
- 并发相同请求只创建一个登记页；
- ID 碰撞时重试；
- 创建只查询和写入当前 source；
- 控制字符、凭据 URL、超长输入被拒绝；
- dry-run 不创建登记页。

### 写入门禁测试

- 远程 `put_page` 拒绝直接创建登记页；
- 可信本地 `put_page` 或 `project init` 保持兼容；
- 待绑定项目经验仍被拒绝；
- `ensure_project` 创建后，绑定项目经验通过登记页检查；
- 多 source 中只接受当前写入 source 的登记页。

### CLI 测试

- `bind --resolved` 原子创建 `.gbrain-project.yaml`；
- `bind --confirmed` 保持兼容；
- 两个标志都缺少时拒绝；
- 已绑定相同 ID 保持幂等；
- 已绑定不同 ID 时拒绝覆盖；
- 标记权限为 `0600`；
- `.gbrain-project.yaml` 被 Git 忽略。

### 安装器和技能测试

- Codex 与 OpenCode 规则包含 `ensure_project`；
- 只有多候选才要求人工选择；
- 唯一匹配和创建结果执行 `bind --resolved`；
- 标记失败时继续使用内存 ID；
- 不再包含“无候选不得调用 `put_page`”的阻塞规则；
- 不引入本地 writer、凭据或离线队列。

### 回归和验收

- 项目身份、项目匹配、捕获、审核、MCP discovery 和 tool schema 测试；
- `bun run verify`；
- `bun run check:all`；
- 编译 Linux 服务端二进制；
- 服务器真实 HTTP MCP 验证首次调用创建、第二次调用复用；
- 验证登记页位于当前 source；
- 在当前本地仓库生成可读取的 `.gbrain-project.yaml`；
- 验证多候选路径不创建新项目；
- 验证待绑定项目经验仍被服务端拒绝。

## 发布顺序

严格按以下顺序执行：

1. 更新本地项目代码、测试和文档；
2. 运行完整相关验证；
3. 使用项目安装器同步本机 Codex 和 OpenCode 配置；
4. 提交全部项目改动；
5. 拉取 GitHub 远端状态，确认可快进；
6. 推送 `gbrain-review-ui`；
7. 确认 GitHub 提交与本地一致；
8. 最后备份并更新服务器；
9. 在服务器构建、测试、切换二进制和重启服务；
10. 从服务器本机与外部网络执行真实 MCP 验收；
11. 为当前仓库创建或复用项目 ID，并原子写入本地标记。

服务器现有定制文件、`.omo/`、旧二进制备份和 stash 必须保留。已有待绑定
经验页面不删除、不迁移、不自动修改。

## 完成标准

- 缺少项目 ID 不再阻塞项目经验流程；
- 服务端是项目 ID 和登记页创建的唯一自动化入口；
- 唯一候选自动复用；
- 完全无匹配自动创建；
- 多候选才要求人工选择；
- 重复或并发请求不产生重复项目；
- 客户端本地标记自动创建；
- 本地标记失败不阻塞当前任务；
- `put_page` 项目硬绑定门禁没有放宽；
- GitHub 和服务器运行同一已验证提交。
