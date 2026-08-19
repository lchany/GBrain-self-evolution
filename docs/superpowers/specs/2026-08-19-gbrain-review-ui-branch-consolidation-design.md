# GBrain Review UI 分支集中合入设计

日期：2026-08-19

## 目标

把仓库当前所有分支中仍有效的已提交代码和提交历史集中到既有 `gbrain-review-ui` 分支。最终分支必须同时保留定制客户端优化、最新版审核服务、官方 `v0.46.21.0` 更新和 `main` 中的归档资产。不得强推、重写历史、修改其他远端分支，或带入根工作区尚未提交的文件。

## 已确认的分支拓扑

仓库包含三条没有共同祖先的历史：

1. `origin/gbrain-review-ui`，当前为 `da7814e6`。该历史包含 81 个定制提交，包括项目身份、经验捕获、客户端安装、关闭自动 Closeout、重大决策与故障 Recall 门禁等优化。
2. `origin/deploy-review-v0.46.21.0`，当前为 `653b1465`。该提交同时也是 `origin/feature/batch-review-decisions` 的头，并包含旧的 `deploy-review-v0.46.18.0`、`deploy-review-v0.46.19.0`、单分类审核、批量审核、匿名 MCP 和 writer Bearer 身份修复。
3. `origin/main`，当前为 `91873a9f`。该历史包含四个归档提交和 32 个另外两条历史没有的部署模板、操作文档、规则、技能及已脱敏补丁文件。

本地 `fix/disable-auto-closeout` 和 `fix/major-decision-recall-gate` 已经是 `origin/gbrain-review-ui` 的祖先。本地 `gbrain-review-ui` 的额外提交 `6943ede3` 与远端目标及部署线的防火墙匿名 MCP 设计提交具有相同 stable patch-id，因此不重复应用。

## 合并结构

从 `origin/gbrain-review-ui` 创建隔离集成分支，按顺序生成两个非快进合并提交：

1. 合入 `origin/deploy-review-v0.46.21.0`，允许无关历史。
2. 合入 `origin/main`，允许无关历史。

最终提交图必须满足以下祖先断言：

- `origin/gbrain-review-ui` 是最终头的祖先；
- `origin/deploy-review-v0.46.21.0` 是最终头的祖先；
- `origin/main` 是最终头的祖先；
- 所有其他当前远端分支也是最终头的祖先。

推送只能使用普通 fast-forward 更新：

```text
integrated-head -> refs/heads/gbrain-review-ui
```

禁止 `--force`、删除远端分支或推送到新的版本分支。

## 文件合并规则

### 部署线合入

两条完整源码快照会产生约 961 个 add/add 冲突。使用确定性规则解决：

- 同时存在的路径以已部署并验证的 `v0.46.21.0` 内容为基线；
- `gbrain-review-ui` 独有的 82 个路径全部保留；
- 不以旧 `v0.42.64.0` 文件覆盖新版同名文件；
- 不接受仅连接历史但丢弃定制代码的 `ours` 空壳合并。

采用新版同名文件后，必须把旧分支中尚未移植的行为按最新版接口重新接入。已确认的兼容闭包包括：

- `review`、`project`、`install-client` 以及 GBrain 结构化 `capture` 的 CLI 分派与帮助；
- `match_project`、`ensure_project` MCP 操作及其读写/来源边界；
- 规范项目登记页和项目绑定草稿的 `put_page` 校验；
- 显式 `put_page` 对软删除页面的受控恢复，普通导入不得绕过 tombstone；
- 无 `origin` 的合法本地 Git source 健康判断；
- 仓库 `.gbrain/project.yaml` 规范 ID 读取和 `gbrain project` 命令兼容；
- 目标分支现有客户端安装、Recall Worker、关闭自动 Closeout 和故障 Recall 逻辑；
- 部署线现有单分类、批量审核、Basic Auth、same-origin、writer `whoami` 来源证明、匿名或 Bearer 认证分流和脱敏错误日志。

七个 review core 文件在两条分支头已经字节相同，保持部署线版本。`serve-http-review.ts` 保持部署线版本，因为其中包含后续批量审核和 writer 修复。

### main 合入

对 `main` 的重叠路径保留已经完成兼容修复的集成版本；保留 `main` 独有的 32 个路径。归档补丁只作为历史资产，不在构建或部署中自动应用。

## 安全约束

- 根工作区 `/home/l30002999/project/gbrain` 的未提交修改属于用户，不参与本次合并。
- 认证、source attestation、CSRF/same-origin、项目登记页远程写入限制和脱敏日志不得放宽。
- 不提交密码、Token、私钥、真实身份信息或未脱敏的非回环 IP。
- `main` 中的补丁归档必须保持其已脱敏版本。
- MCP `ParamDef` 兼容不得通过无边界的类型断言绕过运行时校验；应采用当前 schema 类型或局部兼容适配。

## 验证门禁

至少执行以下验证：

1. 目标分支独有契约：项目 identity/ensure/match、put-page 校验、tombstone、local-only source、客户端安装、Codex/OpenCode Recall/Closeout、capture 和 review CLI。
2. 部署线契约：review core、单分类、批量审核、Basic Auth、匿名 MCP、OAuth writer 身份证明。
3. 仓库门禁：TypeScript typecheck、module-size、privacy、build、版本输出。
4. Git 门禁：无未解决冲突；最终头包含三条历史及所有远端分支；`git diff --check` 通过；提交中不包含 `.planning/`。
5. 推送后通过 `git ls-remote` 验证 `gbrain-review-ui` 指向最终提交。

若测试发现旧优化与最新版存在语义冲突，优先保留安全边界和用户已经确认的产品行为；不得通过删除旧测试来获得绿色结果。

## 发布结果

完成后只更新 `gbrain-review-ui`。已有 `feature/*` 和 `deploy-*` 分支保留原状，后续不再作为日常修改目标。
