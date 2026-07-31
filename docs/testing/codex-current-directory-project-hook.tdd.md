# Codex 当前目录项目 ID 启动检查 TDD 证据

日期：2026-07-31

## 来源

- 设计：
  `docs/superpowers/specs/2026-07-31-codex-current-directory-project-hook-design.md`
- 计划：
  `docs/superpowers/plans/2026-07-31-codex-current-directory-project-hook.md`

## 用户旅程

作为 Codex 用户，我希望每次启动或恢复会话时只检查启动目录自身的项目
ID，从而立即知道当前目录是否已经绑定，又不会误用父目录或其他项目的 ID。

## RED 证据

在实现前扩展 `test/gbrain-client-installer.test.ts`，运行：

```text
bun test test/gbrain-client-installer.test.ts
```

结果：

```text
1 pass
3 fail
```

三个失败均由安装器没有创建
`$CODEX_HOME/hooks/gbrain-project-check.py` 和 `hooks.json` 目标条目导致。
RED 检查点提交为 `c486bb6`。

## GREEN 与硬化证据

实现最小安装与检查行为后，同一测试变为：

```text
4 pass
0 fail
```

GREEN 检查点提交为 `7f02c2b`。随后增加 shell 路径转义、文件权限和读取期间
防替换硬化，最终聚焦结果为：

```text
5 pass
0 fail
102 expect() calls
```

验证命令和结果：

```text
bun test test/gbrain-client-installer.test.ts   PASS
bun run verify                                  31/31 PASS
bun run check:all                               PASS
bun run build:llms                              PASS
bun run build                                   PASS
```

聚焦覆盖率：

```text
src/commands/gbrain-client-installer.ts  95.00% functions / 97.30% lines
```

## 测试规格

| # | 保证 | 测试类型 | 结果 |
|---|---|---|---|
| 1 | 重复安装只保留一个 GBrain `SessionStart` handler | 集成 | PASS |
| 2 | 既有 `SessionStart` 和 `PostToolUse` Hook 原样保留 | 集成 | PASS |
| 3 | 当前目录有效标记返回规范项目 ID | 进程 | PASS |
| 4 | 只有父目录存在标记时仍报告当前目录未绑定 | 进程 | PASS |
| 5 | 无效 ID、符号链接和全局可写标记被拒绝但不阻止会话 | 进程/安全 | PASS |
| 6 | `cwd` 文本不进入 shell，含 shell 字符的目录不会执行命令 | 进程/安全 | PASS |
| 7 | `CODEX_HOME` 含单引号时，Hook 路径仍作为一个字面参数执行 | 进程/安全 | PASS |
| 8 | Hook 脚本权限为 `0700`，`hooks.json` 权限为 `0600` | 集成/安全 | PASS |
| 9 | 安装结果明确报告 Hook 文件、配置和一次性信任要求 | 单元 | PASS |

## 真实 Codex 验收

在 Codex 0.146.0 中：

- 使用信任绕过测试开关从项目根目录启动，Hook 返回当前项目 ID；
- 从 `src/` 子目录启动，Hook 返回“当前目录未找到”，没有继承父目录 ID；
- 通过 `/hooks` 检查准确命令并完成一次性信任；
- 最后使用不带信任绕过参数的普通新会话，Hook 成功运行并注入项目 ID。

## 代码与安全审查

没有发现仍需修复的正确性或安全问题。实现不调用 Git、CLI、MCP、网络或目录
遍历；标记通过 `lstat`、所有权/权限检查、`O_NOFOLLOW`、打开后 inode 校验和
4 KiB 上限读取。Hook 输出不包含原始标记正文。

## 覆盖缺口

- Bun 覆盖率工具不统计嵌入字符串中的 Python 行；Python 逻辑由安装后真实
  进程场景覆盖。
- Codex 的交互式 `/hooks` 信任界面属于上游产品行为，没有在仓库测试中自动
  操作；本机已人工完成并由普通新会话验收。
- 最终 `bun run test` 的 4 个并行 shard 均在执行测试前以 Bun
  `rc=133`（`Trace/breakpoint trap`）退出，serial 阶段又有 55 个文件因同类
  Bun 崩溃或子进程启动超时被判失败，因此无法作为本次改动的仓库级通过
  证据。`.context/test-failures.log` 没有
  `gbrain-client-installer`、`gbrain-codex-project-hook` 或本次测试名；本次
  聚焦测试在同一环境中独立通过。GBrain 故障召回未找到可直接或部分适用的
  既有经验。
