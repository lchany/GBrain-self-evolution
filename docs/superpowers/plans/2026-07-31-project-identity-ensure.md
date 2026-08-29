# 项目身份严格匹配或创建：实施计划

来源设计：
`docs/superpowers/specs/2026-07-31-project-identity-ensure-design.md`

## 目标

项目身份只按规范 `project_id` 精确匹配。有本地 ID 时，服务端复用或按同一
ID 创建登记页；没有本地 ID 时，服务端根据一次性 `creation_key` 幂等生成
新 ID。Git、目录、名称和别名不参与身份匹配。

## 任务与验证

### 1. RED：严格项目 MCP 契约

修改或新增测试：

- `test/project-match-operation.test.ts`
- `test/project-ensure-operation.test.ts`
- `test/mcp-tool-defs.test.ts`

保证：

- `match_project` 只接受 `project_id`；
- `ensure_project` 是 write、mutating 操作；
- 有 ID 时精确复用或按同一 ID 创建；
- 无 ID 时按 `creation_key` 幂等创建；
- 当前 source 隔离；
- 冲突页不覆盖；
- 不读取 Git、名称或别名候选。

先运行测试并确认因缺少新行为而失败，提交 RED 检查点。

### 2. GREEN：服务端严格匹配和原子创建

修改：

- `src/core/operations.ts`
- 必要时新增聚焦的项目登记页辅助模块；
- `src/core/project-context.ts` 中复用 ID 校验和生成规则。

实现：

- 精确 `match_project`；
- `ensure_project`；
- `creation_key` 到规范 ID 的稳定推导；
- 当前 source 事务和 advisory lock；
- 规范登记页构造；
- 冲突检测；
- write-through 警告。

运行与 RED 相同的测试并确认 GREEN，提交实现检查点。

### 3. RED→GREEN：CLI 和本地标记

测试：

- `test/gbrain-project.test.ts`
- `test/project-context.test.ts`

修改：

- `src/commands/gbrain-project.ts`
- `.gitignore`

保证：

- `project match` 不读取 Git remote 或目录名；
- 未绑定时输出 `ensure_project` 交接状态；
- `bind --resolved` 原子写入标记；
- `bind --confirmed` 兼容；
- 相同 ID 幂等，不同 ID 冲突；
- 标记权限 `0600`；
- `.gbrain-project.yaml` 不进入 Git。

### 4. RED→GREEN：远程登记页写入边界

测试：

- `test/put-page-validation.test.ts`
- 相关 trust-boundary 测试。

修改：

- `src/core/put-page-validation.ts`
- `src/core/operations.ts`

保证：

- 远程 `put_page` 返回 `project_registry_managed`；
- 可信本地 `project init` 继续工作；
- 项目经验硬绑定和当前 source 登记页校验不放宽。

### 5. RED→GREEN：客户端规则和技能

测试：

- `test/gbrain-client-installer.test.ts`
- `test/mcp-discovery.test.ts`

修改：

- `src/commands/gbrain-client-installer-content.ts`
- `src/mcp/discovery.ts`
- `src/commands/capture.ts`

保证：

- 规则与技能只按 ID 匹配；
- 未绑定时调用 `ensure_project`；
- 自动 `bind --resolved`；
- 本地标记失败时保留内存 ID继续；
- 不安装 CLI、不索取凭据、不创建离线队列。

### 6. 文档与证据

更新：

- `docs/architecture/KEY_FILES.md`
- `docs/superpowers/specs/2026-07-30-gbrain-project-identity-design.md`
- `docs/superpowers/specs/2026-07-30-mcp-project-matching-design.md`
- `docs/superpowers/specs/2026-07-31-project-experience-write-binding-design.md`
- `docs/testing/project-identity-ensure.tdd.md`

删除把 Git、名称或别名作为项目身份匹配依据的现行描述。

### 7. 本地验证与发布

依次运行：

```bash
bun test <相关测试文件>
bun run verify
bun run check:all
bun run build
```

随后：

1. 运行项目安装器同步 Codex/OpenCode 配置；
2. 检查本地工作区和提交；
3. fetch GitHub 并确认无远端冲突；
4. 推送 `gbrain-review-ui`；
5. 验证 GitHub 与本地提交一致。

### 8. 最后更新服务器

1. 只读盘点服务、源码和定制文件；
2. 备份旧二进制、状态和服务器补丁；
3. 在独立 worktree 叠加定制补丁；
4. 运行目标测试、`verify` 和编译；
5. 快进 `/opt/gbrain` 并恢复定制文件；
6. 切换二进制、重启、检查健康；
7. 外部调用 `ensure_project` 创建当前项目 ID；
8. 本地运行 `bind --resolved` 写 `.gbrain-project.yaml`；
9. 再次调用 `match_project` 和 `ensure_project`，确认返回同一 ID；
10. 验证待绑定项目经验仍被拒绝。
