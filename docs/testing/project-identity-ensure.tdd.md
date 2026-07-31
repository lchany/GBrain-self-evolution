# 项目身份严格匹配与创建 TDD 记录

日期：2026-07-31

## 契约

- 项目身份只由规范 `project_id` 决定。
- `match_project` 只读取当前 source 的精确登记页。
- `ensure_project` 使用事务和项目级 advisory lock 复用或创建登记页。
- 无本地 ID 时，随机 `creation_key` 只负责请求幂等，不写入登记页。
- Git、目录、项目名和别名不参与身份匹配。
- 远程 `put_page` 不能创建或修改项目登记页。
- 本地标记使用原子写入、`0600` 权限，并加入 `.gitignore`。

## RED

首次定向运行共 65 个用例，其中 20 个按预期失败。失败覆盖：

- 旧 `match_project` 仍按仓库和名称扫描；
- 缺少 `ensure_project`；
- 远程 `put_page` 仍能维护登记页；
- CLI 缺少 `bind --resolved`；
- 客户端规则仍要求候选确认；
- discovery 和工具 schema 未声明新契约。

没有测试语法或环境故障。

## GREEN

实现后定向测试覆盖：

- 精确 ID 命中、不命中、格式错误和冲突；
- 当前 source 隔离；
- 调用方指定 ID 的原样创建；
- `creation_key` 的稳定生成、跨 source 隔离和不落盘；
- 并发重试只创建一个登记页；
- 软删除登记页按占用冲突处理；
- dry-run 不写入；
- 远程登记页直写被拒绝、可信本地入口保持兼容；
- `bind --resolved`、`bind --confirmed`、YAML 权限和 Git 忽略；
- Codex/OpenCode 规则、采集技能、MCP discovery 和工具定义同步。

定向结果：68 个用例全部通过。类型检查通过。

仓库校验 `bun run verify` 为 31/31，`bun run check:all` 和编译通过。
本机 Bun 1.3.12 在直接全量测试及四分片测试中均发生运行时
segmentation fault（退出码 133，多个无关测试文件随机成为崩溃点）；这是
Bun 进程崩溃而非测试断言失败，因此没有重复同一路径。服务器发布阶段使用
目标机 Bun 1.3.14 重新运行定向测试和构建。

## 尚需发布阶段验证

- 构建和仓库级校验；
- 本机安装器同步；
- GitHub 提交一致性；
- 服务器目标数据库上的真实并发与 MCP 权限；
- 真实创建后本地 YAML 写入、二次精确匹配和待绑定经验拒绝。
