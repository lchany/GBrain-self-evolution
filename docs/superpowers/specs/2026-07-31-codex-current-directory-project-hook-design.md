# Codex 当前目录项目 ID 启动检查设计

日期：2026-07-31  
状态：已批准，待实现

## 目标

每次启动或恢复 Codex 会话时，只检查该会话 `cwd` 直接包含的
`.gbrain-project.yaml`。检查不得访问父目录、其他目录、Git 元数据或 GBrain
服务端，也不得创建或修改项目 ID。

## 边界

- 使用 Codex `SessionStart` Hook，匹配 `startup|resume`。
- Hook 从标准输入 JSON 读取 `cwd`，只构造
  `<cwd>/.gbrain-project.yaml`。
- 不调用 `gbrain project current`，因为该命令会向祖先目录查找。
- 不使用 `find`、`git rev-parse`、目录遍历、名称匹配或语义匹配。
- 缺失、格式错误、不可信或不可读时只给出中文警告，不阻止会话。
- 检查是只读操作，不自动调用 MCP，不自动创建项目登记页。
- 该 Hook 只检查项目身份，不参与经验采集、经验审核或自动写入。

## 有效标记

标记必须是当前目录中的普通文件，不得是符号链接或全局可写文件。正文必须
恰好包含以下两个非空字段：

```yaml
schema_version: 1
project_id: prj-0123456789abcdef
```

`project_id` 必须匹配：

```text
^prj-[0-9a-f]{16}$
```

## 安装与配置

`gbrain install-client` 新增两个 Codex 用户级资产：

- `$CODEX_HOME/hooks/gbrain-project-check.py`
- `$CODEX_HOME/hooks.json` 中的 `SessionStart` 条目

安装器只维护带有 GBrain 唯一标识的 Hook handler。已有 `hooks.json` 中的其他
事件、matcher 和 handler 原样保留。重复安装只更新自身文件和自身 handler，
不得产生重复条目。

Codex 对非托管命令 Hook 使用首次信任机制。安装结果明确报告 Hook 路径和
`trust_required: true`；用户首次通过 `/hooks` 信任后，后续正常启动和恢复
都会执行。

## 输出

有效标记向会话增加简短中文上下文，包含当前目录和规范 `project_id`。

以下情况输出中文警告并继续：

- Hook 输入缺少合法的绝对 `cwd`；
- 当前目录没有标记；
- 标记是符号链接、非普通文件、所有人可写或归属不可信；
- 标记不可读；
- schema 或 `project_id` 格式错误。

输出不得包含标记原始正文、其他文件内容、凭据或目录扫描结果。

## 验证

- 单元测试验证安装幂等、保留既有 Hook 和 JSON 摘要。
- 进程测试直接执行安装后的 Python Hook，覆盖有效、缺失、父目录仅有标记、
  无效 ID、符号链接和恶意 `cwd` 字符。
- 真实 Codex 新会话使用官方 Hook 信任绕过测试开关验证启动注入；正式使用仍
  保留 Codex 的一次性人工信任门禁。

