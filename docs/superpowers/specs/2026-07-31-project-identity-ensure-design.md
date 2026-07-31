# 项目身份严格匹配或创建设计

日期：2026-07-31  
状态：已批准并实现

## 结论

项目身份只由 `project_id` 决定。Git remote、仓库路径、目录名、项目名称和
别名都不参与项目身份匹配，也不能作为自动绑定依据。

客户端准备写入项目经验时执行：

- 本地 `.gbrain-project.yaml` 已包含 `project_id`：服务端只按该 ID 精确
  查找当前 source 的登记页；存在则复用，不存在则使用同一个 ID 创建登记页。
- 本地没有 `project_id`：服务端生成新的规范 ID，创建登记页并返回；客户端
  把返回值原子写入 `.gbrain-project.yaml`。
- 精确 ID 对应的 slug 已存在但不是合法登记页：返回冲突，禁止覆盖。

`put_page` 的项目硬绑定校验继续保留。自动创建先补齐项目 ID 和登记页，
不允许待绑定项目经验绕过门禁。

## 身份原则

`project_id` 是不可变的业务项目身份：

```text
prj-0123456789abcdef
```

它匹配：

```text
^prj-[0-9a-f]{16}$
```

以下内容只属于元数据或本地环境，不是身份：

- Git remote；
- Git 仓库；
- 工作目录；
- 项目名称；
- 项目别名；
- 客户名称；
- 环境名称；
- source 中的相似页面。

因此：

- 一个业务项目可以使用多个 Git 仓库；
- 一个 Git 仓库可以承载多个业务项目；
- 仓库迁移、改名或拆分不改变项目 ID；
- 同名项目不会因为名称相同而自动合并；
- 服务端不会执行仓库、名称、别名或语义模糊匹配。

Git 的唯一作用是帮助客户端确定把 `.gbrain-project.yaml` 写在哪个本地项目
根目录。Git 信息不会发送给严格项目身份 MCP 操作。

## 触发时机

进入目录、收到非平凡任务或执行只读 GBrain 召回时，只读取本地标记，不创建
项目。

只有准备持久化以下项目经验，且需要补齐项目身份时，才调用自动创建流程：

- 客户或项目规则；
- 项目任务或里程碑总结；
- 项目决策；
- 项目专属 runbook；
- 重复项目故障；
- 已验证的项目根因；
- 其他 `type: project`、`record_kind: project-experience` 的经验。

普通浏览、下载、诊断、召回和一次性操作不会创建项目 ID。

## MCP 操作

### `match_project`

`match_project` 保持只读，但改为只接受规范 `project_id`：

```json
{
  "project_id": "prj-0123456789abcdef"
}
```

它只读取当前 source 的精确路径：

```text
projects/prj-0123456789abcdef/index
```

合法时返回：

```json
{
  "ok": true,
  "status": "matched",
  "code": "ok",
  "project_id": "prj-0123456789abcdef",
  "registry_slug": "projects/prj-0123456789abcdef/index"
}
```

不存在时返回：

```json
{
  "ok": true,
  "status": "unmatched",
  "code": "project_match_not_found",
  "project_id": "prj-0123456789abcdef"
}
```

它不接受 `repository_ref` 或 `project_name`，也不返回候选列表。

### `ensure_project`

新增写权限 MCP 操作：

```text
ensure_project
```

属性：

- `scope: write`；
- `mutating: true`；
- 只查询和写入当前 source；
- 不读取客户端文件系统；
- 不接收仓库引用；
- 不执行名称、别名或语义匹配。

输入分为两种。

已有本地 ID：

```json
{
  "project_id": "prj-0123456789abcdef",
  "project_name": "可选显示名称"
}
```

没有本地 ID：

```json
{
  "creation_key": "当前创建请求的随机幂等键",
  "project_name": "可选显示名称"
}
```

`project_name` 只用于展示，不参与身份匹配。未提供时，登记页暂时使用
`project_id` 作为显示名称，后续管理员可以改名。

## 严格决策

### 客户端已有 `project_id`

服务端执行：

1. 校验 ID 格式；
2. 读取当前 source 的 `projects/<project_id>/index`；
3. 页面不存在时，使用同一个 ID 创建登记页；
4. 页面存在且是合法登记页时，返回 `matched`；
5. 页面存在但类型、路径或 frontmatter ID 不一致时，返回
   `project_registry_conflict`；
6. 不搜索其他 ID，不生成候选，不改用新 ID。

### 客户端没有 `project_id`

服务端执行：

1. 校验 `creation_key`；
2. 根据当前 source 和 `creation_key` 生成规范项目 ID；
3. 读取该 ID 的精确登记页路径；
4. 不存在时创建；
5. 已存在且合法时返回同一个 ID；
6. 已存在但不合法时返回冲突。

`creation_key` 只用于同一次创建动作的请求重试和并发去重，不是项目身份，
也不用于搜索其他项目。客户端在成功写入本地 YAML 前必须为重试复用同一个
`creation_key`。

### 不存在多候选

严格 ID 模型不会返回“多个候选”，因为每次只检查一个规范 ID 对应的精确
slug。只有两种异常需要人工处理：

- 本地已经绑定另一个不同 ID；
- 精确 ID 的登记页路径已被不合法页面占用。

## ID 生成和幂等

有本地 ID 时，服务端必须原样使用该 ID，不得重新生成。

没有本地 ID 时，服务端根据：

```text
当前 source + creation_key
```

生成稳定的 16 位小写十六进制值，并加上 `prj-` 前缀。相同 source 和
`creation_key` 得到相同 ID；不同创建请求使用不同 key。

`creation_key`：

- 由客户端为一次创建动作随机生成；
- 不包含仓库、目录、项目名、客户名或其他业务信息；
- 最长 200 字符；
- 只允许安全的 UUID 或随机标识符字符；
- 不写入登记页；
- 不写入日志正文；
- 成功写入 `.gbrain-project.yaml` 后即可丢弃。

服务端在数据库事务中：

1. 对 `当前 source + project_id` 获取 transaction advisory lock；
2. 获得锁后重新读取精确登记页；
3. 合法页面存在时返回 `matched`；
4. 不存在时创建登记页；
5. 冲突页面存在时拒绝覆盖。

Postgres 使用 `pg_advisory_xact_lock`。PGLite 使用单连接事务串行执行。

本次不增加数据库表或数据库迁移。

## 登记页

规范路径：

```text
projects/<project_id>/index
```

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
project_name: <显示名称或 project_id>
project_aliases: []
repository_refs: []
environment_refs: []
---
```

`repository_refs` 固定为空。服务端不从 Git remote 推导或保存任何仓库关系。

登记页正文只包含通用登记说明，不保存本地路径、凭据、原始会话或环境信息。

## 远程写入边界

远程客户端不能通过普通 `put_page` 创建或修改项目登记页。远程请求写入
`record_kind: project-registry` 时返回：

```text
project_registry_managed
```

并提示调用 `ensure_project`。

可信本地管理员流程 `gbrain project init` 保持兼容。自动 MCP 流程由服务端
构造登记页，不接受客户端提交登记页正文。

项目经验的服务端门禁保持不变：

```yaml
type: project
record_kind: project-experience
project_binding: bound
project_id: prj-0123456789abcdef
```

服务端仍验证当前 source 中存在相同 ID 的合法登记页。

## 客户端流程

### 已有本地标记

1. 运行 `gbrain project current --json`；
2. 取得本地 `project_id`；
3. 调用 `match_project({project_id})`；
4. 已存在时继续；
5. 不存在时调用 `ensure_project({project_id})`，使用同一个 ID 创建；
6. 重新用 `get_page` 验证登记页；
7. 继续经验正文审核和 `put_page`。

### 没有本地标记

1. 运行 `gbrain project current --json`；
2. 客户端为当前创建动作生成随机 `creation_key`；
3. 调用 `ensure_project({creation_key, project_name?})`；
4. 服务端返回 `project_id`；
5. 客户端运行：

   ```bash
   gbrain project bind <project_id> --resolved --json
   ```

6. 重新运行 `gbrain project current --json`；
7. 通过 MCP `get_page` 验证精确登记页；
8. 继续完整经验预览、预分类和 5 分钟写入前审核；
9. 审核通过后调用 `put_page`。

客户端不运行 Git remote 匹配，不调用名称候选搜索，也不要求用户选择相似
项目。

## 本地 `.gbrain-project.yaml`

内容：

```yaml
schema_version: 1
project_id: prj-0123456789abcdef
```

要求：

- 写入当前项目根目录；
- 权限为 `0600`；
- 使用现有临时文件和原子链接逻辑；
- 相同 ID 保持幂等；
- 不同 ID 不自动覆盖；
- 无效标记不静默替换；
- 加入项目 `.gitignore`；
- 不推送 GitHub。

`gbrain project bind` 增加：

```bash
gbrain project bind <project_id> --resolved --json
```

`--resolved` 表示 ID 已经由服务端精确匹配或创建。已有 `--confirmed` 保持兼容，
用于人工修复冲突。

### 本地标记写入失败

如果服务端登记页已创建，但本地目录不可写：

- 展示 `project_marker_write_failed`；
- 展示并保留服务端返回的 `project_id`；
- 当前任务继续使用该 ID，不阻塞经验审核和写入；
- 不创建本地离线队列；
- 提示用户修复权限后执行 `bind --resolved`。

如果下次会话既没有 YAML，也没有保存上次返回的 ID，严格模型不会根据仓库
或名称找回它。客户端必须明确展示这一限制，不能通过猜测恢复。

### 已有冲突标记

本地已经绑定不同 ID 时：

- 不自动覆盖；
- 不生成另一个 ID；
- 展示当前 ID；
- 等待人工决定是否修复本地标记。

## CLI 变化

`gbrain project match --json` 不再读取 Git remote 或目录名。它只处理已有
本地 ID：

- 已绑定：输出调用 `match_project` 所需的精确 `project_id`；
- 未绑定：输出 `project_id: null` 和需要调用 `ensure_project` 的状态；
- 不输出 `repository_ref` 或 `project_name` 匹配参数。

`gbrain project init --name --repo` 作为可信本地管理员兼容入口保留，但
`--repo` 只写元数据，不参与身份判断。

## 客户端规则和技能

安装器生成的 `AGENTS.md` 与 `gbrain-capture` 改为：

- 面向用户默认使用中文；
- 非平凡任务开始只读取本地项目 ID；
- 不使用 Git、目录名、项目名称或别名匹配 ID；
- 有本地 ID 时严格验证；服务端缺失则使用同一 ID 创建；
- 无本地 ID 时调用 `ensure_project` 生成新 ID；
- 自动执行 `bind --resolved`；
- 标记写入失败时使用内存 ID 继续当前任务；
- 不安装本地 GBrain CLI；
- 不索取 writer 凭据；
- 不创建本地离线队列；
- 保留脱敏、固定经验模板、写入前审核和 5 分钟规则。

同步修改：

- MCP discovery 和页面 schema；
- 项目身份设计；
- MCP 项目匹配设计；
- 项目写入硬绑定设计；
- `KEY_FILES.md`；
- CLI 帮助；
- 客户端安装器测试。

## 安全边界

- `match_project` 只需要 read scope；
- `ensure_project` 必须具有 write scope；
- 所有 ID 进行规范格式校验；
- 只访问当前 source 的精确 slug；
- 不读取或记录 Git remote；
- 不执行名称、别名或语义匹配；
- 不覆盖冲突页面；
- 事务锁防止同一 ID 并发重复创建；
- `creation_key` 只做创建请求幂等，不成为业务身份；
- 远程 `put_page` 不能直接维护登记页；
- 继续使用现有 HTTP 限流和云防火墙；
- 不新增凭据，不改变管理员审核权限。

## 测试策略

实现遵循 TDD。

### 严格匹配测试

- `match_project` 只接受规范 ID；
- 精确登记页存在时返回 matched；
- 精确登记页不存在时返回 unmatched；
- 错误 record kind、路径 ID 或 frontmatter ID 返回冲突；
- 不读取其他项目页面；
- 不接受 repository/name 参数；
- 查询只发生在当前 source。

### 自动创建测试

- 有 ID且登记页存在时复用；
- 有 ID且登记页不存在时使用同一 ID 创建；
- 无 ID时通过 `creation_key` 生成规范 ID；
- 相同 `creation_key` 重试返回同一 ID；
- 并发相同请求只创建一个登记页；
- 不同 `creation_key` 生成不同 ID；
- 不把 `creation_key` 写入登记页；
- 冲突页面不被覆盖；
- dry-run 不创建；
- read scope 不能调用 `ensure_project`。

### 写入门禁测试

- 远程 `put_page` 拒绝直接维护登记页；
- 可信本地 `project init` 保持兼容；
- 待绑定项目经验仍被拒绝；
- 自动创建后，绑定项目经验通过登记页校验；
- 其他 source 的同 ID 登记页不能满足当前 source 校验。

### CLI 和安装器测试

- `project match` 不读取或输出 Git remote；
- 未绑定时输出 ensure 状态；
- `bind --resolved` 原子创建 YAML；
- `bind --confirmed` 保持兼容；
- YAML 权限为 `0600`；
- 不同 ID 不覆盖；
- 客户端规则不包含仓库、名称或别名匹配；
- Codex 与 OpenCode 规则均使用 `ensure_project`；
- 不引入凭据或离线队列。

## 发布和验收顺序

1. 修改本地代码、测试和文档；
2. 运行定向测试、`bun run verify`、`bun run check:all` 和构建；
3. 同步本机 Codex 与 OpenCode 配置；
4. 提交全部改动；
5. 确认 GitHub 没有远端冲突；
6. 推送 `gbrain-review-ui`；
7. 确认本地和 GitHub 提交一致；
8. 最后备份并更新服务器；
9. 在独立服务器 worktree 中测试和构建；
10. 保留服务器已有定制文件、`.omo/`、stash 和旧二进制；
11. 重启并验证健康状态；
12. 从外部网络调用严格 `match_project` 和 `ensure_project`；
13. 为当前本地目录生成项目 ID 和 `.gbrain-project.yaml`；
14. 第二次调用确认返回同一 ID；
15. 验证待绑定项目经验仍被拒绝。

已有待绑定经验不删除、不迁移、不自动修改。

## 完成标准

- 项目身份只按 `project_id` 严格匹配；
- Git、目录、项目名称和别名不参与匹配；
- 本地有 ID、服务端无登记页时使用同一 ID 创建；
- 本地无 ID 时由服务端生成新 ID；
- 同一创建请求重试不产生重复项目；
- 客户端自动写本地 YAML；
- YAML 写入失败不阻塞当前任务；
- 冲突 ID 不自动覆盖；
- `put_page` 项目门禁不放宽；
- GitHub 和服务器运行同一已验证提交。
