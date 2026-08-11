# GBrain 客户端安装协议清单与自动修复设计

日期：2026-08-11
状态：方案已获用户确认，等待书面规格复核

## 决策

GBrain 为 Codex 和 OpenCode 的托管客户端文件增加协议版本、构建指纹和只读一致性检查。
`gbrain post-upgrade` 只修复已经安装过 GBrain 客户端的用户目录，不为未安装用户创建配置。

该机制区分三层状态：

1. 仓库模板定义预期协议和文件内容。
2. 发布构建携带模板与预期构建指纹。
3. 用户目录保存实际生成物和安装清单。

应用版本只能标识二进制发行版，不能证明用户目录已经物化当前模板。客户端同步判断以协议清单和
实际文件检查为准。

## 问题

双阶段 Recall/Closeout Worker 代码已经进入仓库，但本地 Codex 和 OpenCode 仍运行旧的单阶段
Hook。旧 Hook 明确要求主 Agent 调用 `search`、`get_page` 和 `put_page`，所以经验正文和搜索结果
进入主上下文。

`gbrain install-client` 可以覆盖旧生成物，但模板提交、GitHub 推送和服务端部署不会自动运行该
命令。新旧构建又使用相同的应用版本号，运维人员无法通过 `gbrain --version` 识别漂移。

## 安装清单

安装器在两个客户端根目录分别写入 `.gbrain-client-install.json`：

```json
{
  "schema_version": 1,
  "protocol_version": 2,
  "asset_digest": "sha256-hex",
  "experience_hook": true
}
```

- `schema_version` 描述清单 JSON 结构。
- `protocol_version` 描述客户端与 Agent 的行为协议。本次双 Worker 协议使用版本 2。
- `asset_digest` 由当前构建的托管规则、skills、Hook、plugin 和 Codex 托管 handler 结构计算。
- `experience_hook` 保存用户最后一次安装时的启用选择，自动修复不得把显式禁用改回启用。

清单不保存凭据、Token、项目 ID、用户输入、绝对路径或时间戳。文件权限为 `0600`，写入使用同
目录临时文件和原子替换。

## 只读检查

新增命令：

```text
gbrain install-client --check [--json]
```

检查不写文件。它分别验证 Codex 和 OpenCode：

- AGENTS 文件中的 GBrain managed block 与当前模板一致；
- `gbrain-capture` 和 `gbrain-review` skill 字节一致；
- 项目 Hook 与经验 Hook 的内容、存在状态和权限符合安装选择；
- OpenCode plugin 等于当前启用或禁用模板；
- Codex `hooks.json` 恰好包含一组当前托管 handler，同时保留并忽略非 GBrain handler；
- 安装清单的协议版本、构建指纹和体验 Hook 选择与实际文件一致。

JSON 输出包含顶层 `ok`、当前协议版本、当前构建指纹，以及两个 surface 的
`current|stale|not_installed` 状态和稳定问题码。检查发现漂移时返回非零退出码，不输出文件正文或
敏感配置。

普通 `gbrain install-client` 在完成写入后调用同一检查器。只有两个 surface 都是 `current` 时才
返回成功。

## 旧安装迁移

旧版没有清单。安装器通过既有 managed block、托管 Hook 文件名、OpenCode plugin 文件名或
Codex 托管 handler 判断该客户端是否安装过 GBrain。

运行普通安装命令时，安装器覆盖全部托管内容并创建清单。它保留 AGENTS managed block 之外的
正文和 `hooks.json` 中的非 GBrain handler。

旧安装的 `experience_hook` 选择按以下顺序恢复：

1. 有清单时读取清单。
2. 存在经验 Python Hook、启用态 OpenCode plugin 或 Codex 经验 handler 时视为启用。
3. 只有禁用态 plugin 或项目 Hook 时视为禁用。

无法可靠判断时不自动修改，`--check` 返回稳定问题码，提示用户运行明确带选择的安装命令。

## 升级自动修复

`gbrain post-upgrade` 在迁移前执行一次客户端安装检查：

1. 两个客户端都没有清单、managed block 或托管文件时跳过，不创建任何客户端文件。
2. 任一客户端存在托管安装痕迹时执行只读检查。
3. 检查为 `current` 时保持静默。
4. 检查为 `stale` 且能恢复 `experience_hook` 选择时，运行同进程安装函数并再次检查。
5. 修复失败时输出脱敏警告和手工命令，继续 post-upgrade，不阻塞数据库迁移。

自动修复只操作安装器已经声明所有权的 managed block、skills、Hook、plugin、Codex handler 和
清单。它不删除或重写用户的其他规则、skills、plugins 和 hooks。

## 组件边界

`src/commands/gbrain-client-installer.ts` 负责：

- 解析 `--check`；
- 生成协议清单和构建指纹；
- 检测安装状态与漂移；
- 安装后验证；
- 向 post-upgrade 提供无 CLI 输出耦合的检查和修复函数。

现有内容模板文件继续只定义托管资产。`src/commands/upgrade.ts` 只调用公开的检查/修复入口，不
复制路径、摘要或迁移判断。

## 错误处理与安全

- JSON、managed block 和 hooks 配置全部按明确结构解析；损坏文件返回问题码，不猜测用户意图。
- 检查结果不包含文件正文、Token、密码、环境变量值或任意用户内容。
- 清单使用固定字段并拒绝未知结构版本。
- 原子清单写入避免中断后留下半个 JSON 文件。
- post-upgrade 保持 best-effort；客户端修复失败不能阻止 schema migration。
- 不跟随清单路径或用户提供的资产路径。所有目标路径由 HOME、CODEX_HOME 和 XDG_CONFIG_HOME
  加固定相对路径构造。

## 测试

### 安装器

- 全新安装写入两份清单，协议版本、摘要、权限和启用选择正确。
- 第二次安装保持幂等，`--check --json` 返回两个 `current`。
- 修改任一托管 skill 或 Hook 后，检查返回 `stale` 和稳定问题码；重装恢复为 `current`。
- 用户自定义 AGENTS 正文和非 GBrain hook 不参与摘要，也不会被覆盖。
- `--no-experience-hook` 写入禁用选择；检查不要求经验 Python Hook 存在。

### 旧安装升级

- 测试 fixture 同时预置旧规则、旧 capture skill、旧单阶段 Python Hook、旧 OpenCode plugin 和旧
  Codex handler。
- 安装后断言旧 Stop 文案、`gb_` token 和 `defer|rejected` outcomes 全部消失。
- 新安装包含 `gbr_`、`gbc_`、两个 REQUIRED prompt 和 `--verified` receipt 要求。
- Codex 与 OpenCode 的 Python Hook 字节一致并匹配当前模板。

### post-upgrade

- 没有托管安装痕迹时不创建文件。
- current 安装不重写文件。
- stale 安装自动修复并保留体验 Hook 选择。
- 损坏且无法恢复选择时只警告，不阻塞后续迁移。

## 交付

实现提交只包含协议清单、检查/修复逻辑、测试和必要文档。发布时从不含工作区私有改动的干净
提交树推送 GitHub。随后从该提交：

1. 重跑本机 `install-client` 并执行 `--check --json`。
2. 重启 OpenCode 以加载新 plugin；Codex 新 Hook 调用直接读取新脚本。
3. 在独立服务端发布目录运行测试、类型检查和编译，备份旧二进制后原子替换。
4. 验证服务健康和客户端检查结果。服务端部署不作为客户端同步证据。

## 非目标

- 不修改经验正文、审核分类或服务端 MCP 协议。
- 不创建后台自动更新守护进程。
- 不读取或迁移客户端凭据。
- 不把清单上传到 GBrain 服务端。
