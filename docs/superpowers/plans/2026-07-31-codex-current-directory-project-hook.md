# Codex 当前目录项目 ID 启动检查：实施计划

来源设计：
`docs/superpowers/specs/2026-07-31-codex-current-directory-project-hook-design.md`

## 用户旅程

作为 Codex 用户，我希望每次启动或恢复会话时只检查启动目录自身的项目
ID，从而立即知道当前目录是否已经绑定，又不会误用父目录或其他项目的 ID。

## 任务与 TDD 证据

### 1. RED：安装器与 Hook 契约

先扩展 `test/gbrain-client-installer.test.ts`，保证：

- 安装器创建 Hook 脚本和 `hooks.json`；
- 重复安装不产生重复 handler；
- 已有 Hook 原样保留；
- Hook 只接受当前 `cwd` 的直接标记；
- 父目录有标记但当前目录没有时仍报告未绑定；
- 有效、无效、符号链接和不可信文件得到对应结果；
- 路径内容不会进入 shell 命令执行。

运行聚焦测试，确认因实现尚不存在而失败，并记录 RED 证据。

### 2. GREEN：实现安装和严格检查

修改：

- `src/commands/gbrain-client-installer.ts`
- `src/commands/gbrain-client-installer-content.ts`

实现：

- 安装只读 Python Hook；
- 保留并幂等合并现有 `hooks.json`；
- 输出 Hook 路径和首次信任提示；
- 不调用 CLI、MCP、Git 或目录遍历。

运行与 RED 相同的测试并确认 GREEN。

### 3. 文档和本机同步

更新客户端部署说明和 `KEY_FILES.md` 当前状态。运行：

```bash
bun test test/gbrain-client-installer.test.ts
bun run verify
```

随后运行 `gbrain install-client --json` 同步本机，检查生成文件权限和 Hook
配置。通过真实 Codex 启动测试验证：

- 当前目录有效标记会注入已绑定状态；
- 仅父目录存在标记时不会被读取；
- 普通启动仍保留 Codex 的 Hook 信任门禁。

### 4. 复核

- 对新增 Python Hook 做代码审查；
- 检查输入验证、符号链接、文件权限、shell 转义和信息泄露；
- 记录覆盖率与仍需人工完成的一次性 `/hooks` 信任步骤。

