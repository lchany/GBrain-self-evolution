# GBrain WebUI 源码与部署对账报告

> **状态**: 文档就绪，等待部署授权。本文档不重启、不修改任何远程服务；所有部署侧的事实凡是没有在仓库内可验证的，一律标记 `blocked-user-input-required`，由用户显式提供后再继续。

## 0. 任务与范围

- 对账对象：仓库内置的审核 WebUI（`gbrain serve --http` 暴露的 `/admin/review*` 与 `/admin/api/review*`） vs. 已部署的独立 WebUI。
- 计划勾选框: `10. Produce a source-vs-deployed WebUI reconciliation report`（仅产出报告，不勾选）。
- 后续 Todo 11（实际切换）必须等用户在会话内显式授权后才能执行，本报告不开启。
- 仓库分支与基线（`git rev-parse HEAD`）: `1fabbb9849f23703ee2898699868ce8101e7b61d`。

## 1. 已确认的事实（来自仓库内证据）

下面每条都给出可重复执行的命令与命中位置；没有命中的项会单独列在第 2 节。

### 1.1 仓库只存在一条 WebUI 服务路径：内置 `gbrain serve --http`

- `docs/mcp/DEPLOY.md` 第 12-14 行明确说明 GBrain 提供两种传输方式：`gbrain serve`（stdio，本地）和 `gbrain serve --http`（远程 OAuth 2.1）。文档内没有再描述第二条 WebUI 服务路径。
- `docs/mcp/DEPLOY.md` 第 30-32 行的 `gbrain serve --http --port 3131` 是该文档给出的唯一对外服务示例。
- `docs/mcp/DEPLOY.md` 第 287-291 行特别说明 `gbrain serve --http` 在 v0.26.0 起将 OAuth 2.1 与 admin 仪表盘内置到二进制中；之前的「custom HTTP wrapper pattern」是可选替代，不是并行 WebUI。

### 1.2 审核 UI 走的是仓库内 TypeScript 服务端渲染路由

- `src/commands/serve-http-review.ts` 第 218-360 行：JSON API（`/admin/api/review/{inbox,targets,inbox/<slug>,plan,confirm,history}`）。
- `src/commands/serve-http-review.ts` 第 364-509 行：HTML 页面（`/admin/review`、`/admin/review/detail/:slug`、`/admin/review/plan/:slug`、`/admin/review/history`）。
- `src/commands/serve-http.ts` 第 1592 行导入并挂载 `mountReviewRoutes(app, ...)`：所有审核路由都注册在同一个 Express 应用内，使用 `requireAdmin` cookie 鉴权与 `expectedAdminOrigin` 同源校验。
- `docs/mcp/WEB_UI_REVIEW.md` 是该服务端渲染审核 UI 的当前设计文档（中文流程、端点契约、Origin/CSRF、确认短语）。

### 1.3 仓库内置了一个 React admin SPA，但仅供仪表盘/客户端/活动流，不承担审核流

- `admin/` 目录为 React 19 + Vite + TypeScript 的 admin SPA；构建产物在 `admin/dist/`。
- `src/admin-embedded.ts` 第 1-30 行把 `admin/dist/` 三个资源（`index.html` + 一个 JS + 一个 CSS）通过 Bun 的 `import ... with { type: 'file' }` 嵌入二进制。
- 该 SPA 没有 review 路由（`docs/architecture/KEY_FILES.md` 第 276 行描述 7 个屏幕：Login / Dashboard / Agents / Register / Credentials / Request Log / Agent Detail，未列 review）。
- 关键回归测试 `test/serve-http-admin-review-fallback.test.ts` 存在（Todo 9 期间新增，见 `task-9-visual-qa/verdict.md` 第 16 行），它证明未登录的 `/admin/review` 与 `/admin/api/review/targets` 必须命中 `requireAdmin` 返回 401，而不是落到 SPA 的 `index.html` fallback。

### 1.4 仓库里没有任何 `gbrain-webui` 服务/单元/部署工件

- `rg -n "gbrain-webui|serve-http|WEBUI|webui" docs src .omo/drafts` 的命中如下：
  - `docs/mcp/WEB_UI_REVIEW.md`（计划文件约定的文档名）。
  - `src/commands/serve-http*.ts` 内的服务名与历史注释。
  - `src/commands/serve.ts:77-138` 中 `--http` 转发到 `serve-http.ts` 的代码路径与注释。
  - 其余命中位于 `docs/architecture/KEY_FILES.md` 等内部参考文档。
  - **没有任何** `gbrain-webui`、`/opt/gbrain-webui/webui.py`、独立 WebUI systemd 单元文件匹配。
- 本机 `/opt/gbrain-webui` 目录不存在；`/opt` 下可见的目录有 `codex-mobile` 等，但与 gbrain 审核 WebUI 无关。
- `GBrain-self-evolution` 目录在仓库内不存在。`.omo/drafts/gbrain-review-ui-chinese-redesign.md` 第 43 行提到的 `GBrain-self-evolution/deploy/systemd/gbrain-webui.service.example` 与 `GBrain-self-evolution/deploy/env/webui.env.example` 是用户在另一处维护的工件，仓库内不可见，因此无法核对。

### 1.5 仓库基线与改动范围

- `git rev-parse HEAD` = `1fabbb9849f23703ee2898699868ce8101e7b61d`。
- Todo 1 的 `task-1-baseline.txt` 是进入这个用户指定脏工作树时的**状态清单**，不是 Todo 1-9 的文件所有权清单。它已记录多项已修改的 tracked 文件，以及一批已经存在的未跟踪审核/捕获源码与证据路径。
- 因此不能从当前 `git status` 推出「所有未提交修改都属于 Todo 1-9」。最终范围证据 `final-wave-scope.txt` 将当前路径分成三类：基线既有路径、与基线重叠的计划增量、以及未出现在基线中的新增计划文件。对于基线未保存内容快照的重叠路径，只声明已验证的计划增量，不声称拥有整个文件差异。
- 本报告及 Todo 10 没有修改任何部署侧的 systemd 单元、环境模板、代理配置或远程服务。仓库没有 git tag 或发布说明指向某个独立 `gbrain-webui` 制品；`docs/RELEASING.md` 描述的发布通道只覆盖 `bun build` / `bun build --compile` 的 GBrain 二进制（`docs/mcp/DEPLOY.md` 第 287-291 行印证）。

## 2. 未知项（blocked-user-input-required）

下面这些事实本任务在仓库内查不到，也无法在不联系远程主机的前提下推断；任何后续的 Todo 11 在用户补齐这些输入之前都不得开始。

| # | 未知项 | 为什么必须由用户告知 | 影响哪一步 |
| --- | --- | --- | --- |
| U1 | 已部署 WebUI 的真实访问入口（URL、TLS 终止方式、是否反代） | 决定 OAuth issuer URL 与 `expectedAdminOrigin` | 切换、回滚、烟雾测试 |
| U2 | 部署主机标识（host alias 或匿名化 ID） | 决定 ssh/服务管理命令与权限边界 | 切换、回滚 |
| U3 | 已部署 WebUI 的服务单元名（systemd unit、运行用户、WorkingDirectory） | 决定如何无副作用地重启/停止 | 切换 |
| U4 | `/opt/gbrain-webui/webui.py` 是否仍然存在，以及其当前 SHA 或最近一次 commit | 决定是否能做精确对账（是镜像还是分支） | 对账、回滚 |
| U5 | 已部署 WebUI 使用的鉴权方式（cookie/OAuth/自定义 bearer）、token 来源与存储位置 | 决定迁移路径是否需要重新生成客户端凭据 | 切换 |
| U6 | 已部署 WebUI 的回滚方式（保留旧服务、停服务、版本回退、git 还原） | 决定失败时的恢复路径 | 回滚 |
| U7 | 用户对 cutover 的授权窗口（计划停机时长、可接受中断） | 决定能否在同一会话内完成重启与验证 | 切换 |
| U8 | 是否需要保留 `/opt/gbrain-webui/webui.py` 作为可回滚的旧服务 | 决定切换是「重定向」还是「替换」 | 切换、回滚 |
| U9 | 已部署 WebUI 的 `mcp.publish_skills`、`mcp.publish_skills_url` 等脑侧配置是否启用 | 决定 SPA fallback 行为 | 切换 |
| U10 | 任何部署侧的环境变量模板、systemd unit、nginx/caddy 配置的现行版本 | 决定部署文档差异化的对象 | 文档更新 |

> 这些项里 **不存在** 任何 secret、token、IP 凭据，本任务也 **不** 收集。

## 3. 仓库源码 vs. 部署侧已知信息的对账

下面只在仓库内可验证的范围内做对比；任何依赖第 2 节输入的项都标 `未知`。

| 维度 | 仓库现状（已验证） | 部署侧已知信息 | 差异 / 风险 |
| --- | --- | --- | --- |
| 服务入口 | `gbrain serve --http --port 3131`，单进程 Express 应用，OAuth 2.1 走 `mcpAuthRouter`（`docs/mcp/DEPLOY.md:30-32`, `src/commands/serve-http.ts:442-942`） | 部署侧有独立 WebUI 服务的传闻（来自 `.omo/drafts/gbrain-review-ui-chinese-redesign.md:43,66,84,103`） | 服务形态不同：单进程 vs. 独立 WebUI；如并存则可能造成 `expectedAdminOrigin` 与 `issuerUrl` 不一致 |
| 鉴权 | admin 走 cookie magic-link + `requireAdmin`（`src/commands/serve-http.ts:1112-1120`、`/admin/auth/:token`）；`/admin/api/review/*` POST 走同源 `Origin` 校验（`src/commands/serve-http-review.ts:208-214`） | 未知（U5） | 如独立 WebUI 用不同鉴权，切换要重新走一遍客户端注册与 token 签发 |
| 路由覆盖 | `/admin/review`、`/admin/review/detail/:slug`、`/admin/review/plan/:slug`、`/admin/review/history` + 6 个 API（`src/commands/serve-http-review.ts:218-509`） | 未知；传闻是 `/opt/gbrain-webui/webui.py`（U4） | 路由集是否完全覆盖未知；如有差异则属于 Todo 11 的回滚风险 |
| 静态资产 | admin SPA（`admin/dist/`）经 `src/admin-embedded.ts` 嵌入；审核 HTML 在 `serve-http-review.ts` 的 `renderShell` 函数里直接写字符串 | 未知 | 部署侧的静态托管方式未知（U1、U10） |
| 配置文件 | `gbrain.yml`、`.env.testing.example`、OAuth env 变量在 `DEPLOY.md` 第 159-181 行与 `serve-http.ts:222-265` | 未知 | 是否存在部署专用的 env 模板未知（U10） |
| systemd / 服务管理 | 仓库没有自带 unit 文件；`docs/mcp/DEPLOY.md` 假设由操作者自行管理 `gbrain serve --http` 进程 | `.omo/drafts/gbrain-review-ui-chinese-redesign.md:43` 提到 `GBrain-self-evolution/deploy/systemd/gbrain-webui.service.example`，但该文件不在本仓库 | 服务单元形态与命名空间未知（U3） |
| 回滚 | 仓库内 `bun build` / `bun build --compile` 可重出旧二进制；`docs/RELEASING.md` 描述的发布通道 | 未知（U6、U8） | 回滚路径要由用户决定是「停独立服务 + 启用内置」还是「反向 git 还原」 |

### 3.1 缺失的源工件（核心结论）

- **本仓库找不到 `/opt/gbrain-webui/webui.py` 的任何副本或引用**：
  - 仓库目录里没有 `GBrain-self-evolution`；
  - `docs/`、`src/`、`.omo/drafts/` 内 `rg "gbrain-webui"` 全部无命中；
  - 本机 `/opt/gbrain-webui` 不存在。
- 因此「已部署的独立 WebUI」是 **仓库外** 的工件，对它的源码审核必须由用户提供该 `.py` 文件或其打包产物（如 tarball、git 仓库、容器镜像）。在用户提供之前，本任务不臆测它的实现语言、鉴权方式、模板与路由集合。

## 4. 决策标准（决定走哪条路径）

按以下顺序逐条比对；任何一条不通过都走「先收容再回滚」路径。

| 编号 | 条件 | 数据来源 |
| --- | --- | --- |
| C1 | 部署侧的鉴权（cookie magic-link + admin bootstrap）能在内置 `gbrain serve --http` 中复现 | `docs/mcp/DEPLOY.md:71-117`，`src/commands/serve-http.ts:979-1108` |
| C2 | 路由集（list / detail / plan / history + 6 个 API）与行为对得上 | `docs/mcp/WEB_UI_REVIEW.md:33-67`，`src/commands/serve-http-review.ts:218-509` |
| C3 | 部署主机上的 systemd / 运行用户 / WorkingDirectory 可以托管 `gbrain serve --http` | 用户提供（U2、U3、U10） |
| C4 | 回滚路径明确：旧服务可以停掉或保留为只读，且能在 10 分钟内恢复到切换前状态 | 用户提供（U6、U8） |
| C5 | OAuth issuer URL 与 `expectedAdminOrigin` 一致（同源 `Origin` 校验依赖它） | `src/commands/serve-http-review.ts:84,208-214`；用户提供（U1） |
| C6 | 部署侧没有独立的 `webui.py` 维护渠道（否则会出现「两套真相」） | `.omo/drafts/gbrain-review-ui-chinese-redesign.md:84,103`；用户提供（U4） |

满足 C1-C5 → 走「路径 A：优先使用仓库 TypeScript 服务」（第 5.1 节）。
任一条不满足 → 走「路径 B：先把独立实现收进仓库」（第 5.2 节）。
C6 任何时候都是前置硬条件：若独立 `webui.py` 仍在外部维护，禁止直接切换。

## 5. 推荐的两种对账机制

### 5.1 路径 A：直接采用仓库内置 TypeScript 服务（首选）

- **执行前提**：C1-C5 全部通过；C6 已确认（即独立 `webui.py` 已被废弃或并入仓库）。
- **执行步骤**（不包含本任务；留给 Todo 11 实施）：
  1. 在部署主机上保留旧 WebUI 单元/进程不动，作为回滚兜底。
  2. 安装最新 GBrain 二进制（仓库 `bun build --compile` 产物）。
  3. 用 `docs/mcp/DEPLOY.md` 第 159-181 行的方式启动 `gbrain serve --http --bind 0.0.0.0 --public-url <U1>`，并设置 `GBRAIN_ADMIN_BOOTSTRAP_TOKEN`（≥ 32 字符 `[A-Za-z0-9_-]+`）。
  4. 在同一主机或反代上把流量从旧 WebUI 切到内置服务。
  5. 用浏览器与 Todo 9 的 fixture-server 类似的脚本做最小烟雾测试（登录、列 inbox、进 preflight、输入 `PROMOTE` 短语，**不** 真实提交）。
  6. 观察 24 小时无异常后，停掉旧 WebUI。
- **回滚**：把反代切回旧服务，停止 `gbrain serve --http`；旧客户端 cookie 仍由旧服务校验（U5 提供的鉴权上下文）。
- **预期收益**：所有已被基线与对账表确认的本次仓库增量都进仓库；凡是可归因于 Todo 1-9 的审核 UI 增量会立即生效，不再有「仓库外代码」漂移。

### 5.2 路径 B：先把独立实现收进仓库

- **执行前提**：C1-C5 中至少一条不通过；或 C6 仍要求独立 `webui.py` 必须被仓库吸收。
- **执行步骤**（不包含本任务；留给 Todo 11 实施）：
  1. 由用户把 `/opt/gbrain-webui/webui.py` 与其依赖（requirements、模板、配置、systemd 单元、env 模板）一次性提交到一个新目录，例如 `extras/gbrain-webui/`（**不** 与 `src/` 混放）。
  2. 在仓库 CI 中加 lint / typecheck（按 `.py` 的工具链）。
  3. 复刻第 1 节列出的 7 个关键端点（list / detail / plan / history + 6 API），确保 `webui.py` 与仓库实现能并跑，便于灰度。
  4. 路径 A 的切换步骤重新走一遍。
- **回滚**：先 revert 引入 `extras/gbrain-webui/` 的提交，再回退到旧 WebUI。
- **代价**：必须等用户上传源码；可能引入新的 Python 依赖与构建步骤。

## 6. 待应用的 systemd / env / docs 草稿（**本任务不应用**）

下面只列草稿；任何 systemctl 写入、env 文件落地、文档覆盖都留给 Todo 11 在用户显式授权后再做。

### 6.1 路径 A 的 systemd 单元草稿（仅示例，未应用）

```ini
# /etc/systemd/system/gbrain-serve-http.service (DRAFT, NOT APPLIED)
[Unit]
Description=GBrain serve --http (built-in OAuth 2.1 + admin + review)
After=network.target

[Service]
Type=simple
User=<run-user>     # 由 U2/U3 提供
WorkingDirectory=<brain-home>  # 由 U3 提供
EnvironmentFile=/etc/gbrain/serve-http.env
ExecStart=/usr/local/bin/gbrain serve --http --bind 0.0.0.0 --public-url <U1>
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

### 6.2 路径 A 的 env 模板草稿（仅示例，未应用）

```bash
# /etc/gbrain/serve-http.env (DRAFT, NOT APPLIED)
GBRAIN_HOME=<brain-home>
GBRAIN_ADMIN_BOOTSTRAP_TOKEN=<operator-controlled, >= 32 chars, [A-Za-z0-9_-]+>
GBRAIN_HTTP_TRUST_PROXY=1   # 1 hop, 适用于反代/Cloudflare 隧道
GBRAIN_HTTP_CORS_ORIGIN=https://<U1-host>
```

### 6.3 文档更新草稿（合并入 `docs/mcp/DEPLOY.md`，未应用）

- 在「OAuth 2.1 Setup」段后增加「Path A 切换：替代独立 WebUI」小节，复用第 5.1 节的步骤。
- 在「Troubleshooting」段后增加「已知替代品对比」小节，列出独立 WebUI 切换的注意事项与回滚预期。
- 在 `docs/mcp/WEB_UI_REVIEW.md` 增加「部署形态」一节，明确该 UI 来自 `gbrain serve --http`，不再有独立 Python 服务。

## 7. 在用户给出输入之前不要做的事

- 不要启动 `gbrain serve --http`。
- 不要 touch 任何远端主机上的 systemd 单元、env 文件、反代配置。
- 不要把 `.omo/drafts/gbrain-review-ui-chinese-redesign.md` 中提到的 `GBrain-self-evolution/deploy/systemd/gbrain-webui.service.example` 当作已存在的工件；该工件不在本仓库。
- 不要在 Todo 11 之前勾选计划里的 Todo 11 复选框；本任务也不勾选 Todo 10 的复选框。
- 不要把任何 env 值、token、凭据、auth 响应写进仓库或证据文件。

## 8. 切前需要用户提供的输入清单

逐条对应第 2 节：

1. U1：访问入口（URL、TLS、反代），字符串即可。
2. U2：主机标识（host alias 或匿名化 ID），不要原始 IP。
3. U3：systemd 单元名、运行用户、WorkingDirectory。
4. U4：`/opt/gbrain-webui/webui.py` 是否存在；如存在，给出文件路径或打包方式。
5. U5：鉴权方式、token 来源、是否需要重新签发。
6. U6：回滚方式。
7. U7：cutover 授权窗口。
8. U8：是否保留旧服务。
9. U9：脑侧 `mcp.publish_skills` 配置。
10. U10：部署侧 env/单元/反代配置文件的现行版本（只列文件名与位置，不上传内容）。

> 给齐 1-10 后才能进入 Todo 11；任一缺失都要回信问用户，禁止猜测。

## 9. 与计划「Must NOT do」的对照

- 计划禁止把独立 `/opt/gbrain-webui/webui.py` 当作真相（`.omo/drafts/gbrain-review-ui-chinese-redesign.md:103`）。本报告把它标记为「仓库外工件」，由用户提供，未把任何猜测写进仓库或证据。
- 计划禁止在无授权下切换（`gbrain-review-ui-chinese-redesign.md:67`）。本任务不接触任何远程服务；切前清单见第 8 节。
- 计划禁止把凭据写进证据（`gbrain-review-ui-chinese-redesign.md:62`，`.omo/drafts/...:99`）。本报告与对应证据文件均不包含 env 值、token、auth 响应。

## 10. 证据与产物

- 本报告: `docs/mcp/WEB_UI_RECONCILIATION.md`（本文件）。
- 证据: `.omo/evidence/gbrain-review-ui-chinese-redesign/todo-10-reconciliation.txt`（命令与结论摘要，不含敏感值）。
- 范围归因: `task-1-baseline.txt`、`todo-10-reconciliation.txt` 与 `final-wave-scope.txt` 共同记录基线既有路径、重叠计划增量与新增计划文件；不把整个脏工作树笼统归属给 Todo 1-9。
- 未做: 不勾选计划中的 Todo 10 / Todo 11 复选框；不创建提交；不动 `docs/mcp/DEPLOY.md` 既有内容；不写入任何部署侧 env / unit 模板。
