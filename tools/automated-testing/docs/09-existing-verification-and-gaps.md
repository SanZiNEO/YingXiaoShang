# 09 · 既有验证资产调查、覆盖矩阵与缺口

> 归属：`scripts/`（仓库根）与 `.scratch/`（历史驱动/日志/截图）｜ 状态：部分（只读调查，未执行任何脚本）｜ 核对日期：2026-11-18
> 覆盖：`scripts/verify-*.ts`（14 个）、`scripts/dev-web.ts`、`scripts/install-profile.ts`、`scripts/package-desktop.mjs`；`.scratch/` 下既有 Electron/Web 驱动脚本、回归脚本、DB 快照/比对工具、既有日志与界面截图
> 不覆盖：新用例设计（见 `11-scenario-catalog.md`）、harness 选型与 launch 草案（见 `10-harness-strategy.md`）、Python 侧 pytest 用例细节（见 `06-news-sidecar-and-network.md`）

> 行号截至 2026-11-18；所有结论来自只读源码与仓库内既有日志，本次未运行任何 `pnpm` / `electron` / 脚本。证据等级：`[源码]` 直接读代码；`[日志]` 来自仓库内既有日志/截图；`[待验证]` 未读到运行证据或推断。

## 1. 结论摘要（TL;DR）

1. `scripts/` 下实测 `verify-*.ts` **共 14 个**（清单见 4.1）；AUTHORING-SPEC 第 6 节与交接材料声称 16 个，**与实测不符**，差异本身记入第 5 节。`[源码]`
2. 14 个 verify 脚本全部是 **Node 进程内断言**：纯函数调用、临时目录 SQLite、或对源码文本做正则/顺序断言；**没有一个启动 Electron 主进程或渲染窗口**。`[源码]`
3. 真正拉起 GUI / 打包产物的驱动脚本只存在于 `.scratch/`：`drive-electron.mjs`（Playwright `_electron.launch`）、`verify-package.mjs`（裸 spawn 打包 exe + CDP `/json` 探测）、`drive-web.mjs` / `verify-web.mjs` / `check-ui.mjs`（Playwright chromium 打 HTTP web 端）；断言方式以 `body.innerText()` 文本包含 + 定时轮询为主，未固化进测试 runner。`[源码]`
4. 打包产物运行证据几乎为空：`.scratch/packaged-out.log` 仅 2 字节、`packaged-err.log` 0 字节；`verify-package.mjs` 的启动烟测结果没有留下结构化日志文件。`[日志]`
5. 覆盖重心在 **SVC（领域纯函数）与 DATA（临时库/配置文件）**；BOOT 仅覆盖到失败文案与体检纯函数，WIN（窗口/分栏/单例）、IPC 真实往返、EVT 真实增量流、打包产物端到端交互基本是空白。
6. 渲染层**没有 `data-testid` / `test-id` / `data-test`**（全仓 grep 0 命中）；但存在一批结构性 `data-*` 属性（`data-message-role`、`data-action="stop"`、`data-tab-id`、`data-side`、`data-source-kind`、`data-submitted` 等，见第 3 节关键代码位置表）。既有脚本均未利用这些钩子，仍靠文本、`textarea`/`input` 与角色定位。`[源码]`
7. `.scratch/` 中两份 PowerShell 回归脚本与 `test-ui.mjs`/`drive-web.mjs`/`verify-web.mjs` 硬编码旧仓库路径 `E:\Documents\GitHub\learning-agent` 或已不存在的 `apps/web`，当前 checkout 下**不能直接复用**，只能作思路参考。`[源码]`
8. 判断题结论：既有体系是 **「源码静态断言 + 进程内纯函数/临时库行为断言为主，真实 GUI 运行断言为辅且未固化」**；粗估进程内断言占既有断言面约 80%，真实 Electron/Web 端到端运行断言不足 20%（依据见 4.7）。

## 2. 结构与流程

### 2.1 既有验证资产分层

```
┌─ scripts/（仓库根，纳入 pnpm 脚本可触达）────────────────────────────┐
│ verify-*.ts ×14 ── tsx 直接运行，Node 进程内：纯函数 / 临时 DB / 源码文本 │
│ dev-web.ts ────── spawn dsh CLI（Web profile 启动器，非断言）          │
│ install-profile.ts 写 dsh profile package.json + pnpm install（装配）  │
│ package-desktop.mjs 构建 → 种子库 VACUUM INTO → electron-builder NSIS │
└──────────────────────────────────────────────────────────────────────┘
┌─ .scratch/（历史临时区，不纳入任何 runner）───────────────────────────┐
│ 驱动：drive-electron.mjs / verify-package.mjs / drive-web.mjs /         │
│       verify-web.mjs / check-ui.mjs / test-ui.mjs                       │
│ 编排：run-regression.ps1 / run-regression-full.ps1                      │
│ 数据：snapshot-db.mjs / compare-upgrade.mjs / mvp-snapshot.mjs …       │
│ 证据：*.log、*.png、issue/pr JSON、probe JSON                           │
│ 其他：agent 直调探针、DB 只读探针、爬虫网络探针（见 LEG-33）            │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 既有脚本的验证方式分类（四档）

| 档位 | 含义 | 本仓代表资产 |
|---|---|---|
| A. 源码级文本断言 | 读源码文件，用正则 / `indexOf` 顺序判断接线是否存在，不执行被测链路 | LEG-01（部分）、LEG-10 |
| B. 真实调用（进程内） | 在 Node 里直接 import 纯函数 / 服务类，喂构造输入或临时目录 SQLite，断言返回值与副作用 | LEG-02～LEG-09、LEG-11～LEG-14 |
| C. 只读解析 | 打开既有 DB / JSON 做计数、悬空引用、比对，不写被测链路 | LEG-26、LEG-27，及 LEG-33 中 DB 探针 |
| D. 起子进程 / GUI 驱动 | spawn Electron 或 web server，经 DOM / CDP / HTTP 观测运行态 | LEG-18、LEG-19、LEG-21、LEG-22、LEG-23 |

### 2.3 一次既有桌面驱动的时序（以 LEG-18 为准）

```
test runner（人工 node .scratch/drive-electron.mjs）
  └─ electron.launch({ executablePath: electron.exe, args: ['.'], cwd: apps/desktop, env: LEARNING_AGENT_HOME })
       └─ Electron 主进程 out/main/index.js → initServices() → createWindow()
            ├─ preload 暴露 window.learning（CH 面）
            └─ renderer loadFile(out/renderer/index.html)
  └─ app.firstWindow() → waitForLoadState('domcontentloaded')
  └─ locator('textarea, input[type="text"]').first() → waitFor visible
  └─ fill(question) + Enter → 1s 间隔轮询 body.innerText()，直到「问题出现 ≥2 次且不在 busy 文案」
  └─ 点击「新闻分析」卡片 → 再读 body 文本 → Escape → screenshot
  └─ app.close()
```
`[源码]` `.scratch/drive-electron.mjs:15-68`；轮询信号是 **body 文本包含关系**，不是 IPC resolve 或 DOM 结构化断言。

## 3. 关键代码位置

| 职责 | 文件:行 | 说明 |
|---|---|---|
| 主进程装配与失败兜底 | `apps/desktop/src/main/index.ts:44`（`initServices`）、`:398`（`app.whenReady`）、`:401-443`（失败对话框/重置/`relaunch`） | LEG-12/13 测的是其调用的纯函数，未走真实启动 |
| 聊天 IPC 与事件转发 | `apps/desktop/src/main/index.ts:453`（`learning:chat`）、`:480`（`learning:chat-event` 推送）、`:485`（`signal: turn.signal`） | LEG-01 用源码正则守护 :485 这一行 |
| 取消控制器 | `apps/desktop/src/main/turn-canceller.ts` | LEG-01 行为层直接 `new TurnCanceller()` |
| preload 暴露面 | `apps/desktop/src/preload/index.ts:9-24` | 既有 GUI 驱动只能经 `window.learning.*` 触达 IPC |
| sidecar 拉起与转发 | `apps/desktop/src/main/news-backend.ts:136`（`spawn`）、`:146`（`stdio: ['ignore','pipe','pipe']`）、`:149-156`（stdout/stderr 转发主进程 console）、`:162`（`waitHealthy` 8s） | 外部 driver 拿不到 sidecar 句柄，只能经主进程日志或 HTTP `/health` 取证 |
| 端口与开关 | `apps/desktop/src/main/news-backend.ts:5`（8788）、`:97`（`NEWS_CRAWLER_AUTOSTART=0` 仅体检） | 见 `06-news-sidecar-and-network.md` |
| 渲染层标签页类型 | `apps/desktop/src/renderer/src/model.ts:139`（`DocKind` 9 种：artifact/overview/artifacts/evidence/process/files/file/news/source） | 既有 UI 脚本未逐页固化断言 |
| 渲染层定位现状 | `apps/desktop/src/renderer/src/` 全目录 grep `data-testid`/`test-id`/`data-test` 0 命中；结构性钩子见 `App.tsx:1136,1220,1481,1493,1516`（`data-message-role`/`data-action`/`data-streaming`/`data-notice`）、`workspace.tsx:201,236,393`（`data-source-kind`/`data-tab-id`）、`renderers.tsx:130,465,472,606`（`data-submitted`/`data-match-review`/`data-review-badge`/`data-case-kp-name`）、`layout/DragHandle.tsx:99-100`（`data-side`/`data-dragging`） | 既有 UI 脚本未使用这些钩子 |
| 打包与种子库 | `apps/desktop/electron-builder.yml:13`（`extraResources` seed）、`:21`（`asar: true`）；`scripts/package-desktop.mjs:32-61`（`buildSeedDatabase`，`VACUUM INTO`） | LEG-17、LEG-22 对应 |
| 外部化声明 | `apps/desktop/electron.vite.config.ts:32`（`EXTERNAL = ['electron','playwright','playwright-core']`） | 应用内懒加载预留；测试 harness 走仓库 devDependency，不依赖该 external |
| Electron 版本 | `apps/desktop/package.json:35`（`electron: ^44.0.0`，实测安装 44.9.0） | 四方案兼容性判断的基线，见 `10-harness-strategy.md` |
| 根 playwright 依赖 | `package.json:48`（`playwright: ^1.55.0`，实测安装 1.64.1；`@playwright/test` 未安装） | LEG-18/19/21/23 直接 `import { chromium / _electron } from 'playwright'` |

## 4. 可测点（既有资产清单、覆盖矩阵与缺口）

### 4.1 `scripts/verify-*.ts`（实测 14 个，逐个）

> 注：`AUTHORING-SPEC.md` 第 6 节「既有测试资产」与交接材料声称 **16 个** `verify-*.ts`；本次只读列目录实测为 **14 个**（清单如下），差异以实测为准，未在 `scripts/` 下找到另外 2 个对应文件。`[源码]`

> 断言方式分四档：**源码级文本断言** / **真实调用（进程内函数或临时 DB）** / **只读解析** / **起子进程**。覆盖 ID 只引用 02–08 既有前缀（BOOT/WIN/IPC/CH/EVT/UI/FLOW/PKG/EXT/SVC/DATA）。

| LEG | 脚本 | 断言方式 | 覆盖到的 ID（依据） | 能否复用为自动化断言 | 局限 |
|---|---|---|---|---|---|
| LEG-01 | `scripts/verify-cancel-wiring.ts` | **混合**：行为层真实 `new TurnCanceller()` 调 begin/cancel/done（`:26-73`）；源码层 `readFileSync` 读 `main/index.ts` 做正则与 `indexOf` 顺序断言（`:77-90`） | SVC（TurnCanceller 信号语义）；CH/IPC（`learning:cancel` 接线、`signal: turn.signal` 传入执行链） | 行为层可直接作为单元断言复用；源码正则断言只能防「删行」类回归，抓不住信号未真正中断模型请求的行为问题 | 未连真实 LLM/HTTP；未验证取消后主进程不留半截状态；源码断言对重构（改名/拆文件）脆弱 `[源码]` |
| LEG-02 | `scripts/verify-cancel.ts` | **真实调用（进程内）**：import `runAgentLoop`，喂脚本化假模型 `slowCtx`（20ms 吐一字），`AbortController` 60ms 后 abort，断言抛错、<900ms 退出、文案匹配（`:22-101`） | SVC（agent tool-loop 的 AbortSignal 透传与 AbortError 收口） | 可复用为 tool-loop 单元/集成断言；假模型在信号点主动抛 `AbortError`，不等于真实 HTTP 请求被中断 | 不覆盖 IPC 层 `learning:cancel` → canceller 的接线（那是 LEG-01 的源码断言面）；无 sidecar/DB 交互 `[源码]` |
| LEG-03 | `scripts/verify-empty-question-set.ts` | **真实调用（进程内）**：zod `safeParse` 校验 `QuestionSetContentSchema`；渲染层纯函数 `emptyQuestionSetAction` 返回 markdown/retry（`:24-39`） | SVC（题目集 schema 校验）；UI（空题集兜底分支的纯函数判定，非真实 React 渲染） | 可复用；schema 与兜底函数拆成纯函数正是为可测设计 | 未验证空集在真实界面上两个入口可点、可跳转；不覆盖交卷链路 `[源码]` |
| LEG-04 | `scripts/verify-empty-return.ts` | **真实调用（进程内）**：`fakeCtx` 按轮次脚本化吐 chunk，假工具 `read_kp`，驱动 `runAgentLoop` 走两轮/收口轮空返回分支（`:25-113`） | SVC（tool-loop 空返回：保留上一轮正文、首轮空返回报错、收口轮兜底） | 可复用；分支覆盖设计显式（注释要求真的走到空返回路径） | 假模型/假工具，无真实 LLM 与工具落库；未验证界面在空返回时的呈现 `[源码]` |
| LEG-05 | `scripts/verify-errors.ts` | **真实调用（进程内）**：`friendlyError(error, context)` 12+ 构造错误，断言文案正则且不含裸英文技术词（`:26-78`） | SVC/main（错误文案归一：key 缺失/401/402/429/断网/超时/SQLITE_FULL/400 家族分流） | 可复用为文案护栏；错误分类表集中在一个纯函数 | 不覆盖错误在界面上的变红/落库/重试路径；真实网络错误形态未抽样 `[源码]` |
| LEG-06 | `scripts/verify-history-budget.ts` | **真实调用（进程内）**：`buildHistoryView` 喂 200 轮长消息/超长单条/30k 粘贴/12 条摘要等构造输入，断言字符/条数/摘要上限、保留最近 3 轮、先丢旧摘要、可复现（`:27-171`） | SVC（history 压缩预算与确定性） | 可复用；用绝对阈值而非常量名，改常量仍报警 | 纯函数，不验证真实会话历史经 IPC 落库后再读出的一致性；摘要质量不评估 `[源码]` |
| LEG-07 | `scripts/verify-news-search.ts` | **真实调用（进程内）**：`rankNews` 排序、`shouldSearchOnline` 联网决策、`withTimeout` 超时兜底，构造文章数组与慢 Promise（`:23-91`） | SVC（read-tools 新闻排序/新鲜度权重/空查询/不相关不硬凑）；EXT（联网超时上限约定，未连真实网络） | 排序与超时可复用；联网决策函数可复用 | 未触达 sidecar HTTP 接口；真实抓取时长/验证码/降级不在覆盖内 `[源码]` |
| LEG-08 | `scripts/verify-question-submit.ts` | **真实调用（进程内 + 临时 DB）**：`mkdtempSync` 临时 home，cordis `Context` 挂 `LearningDb`，建档案→插 artifact→`registerArtifactQuestions` 落 questions 表→`recordAttempt` 写外键；另测 `normalizeQuestionType`、`scoreAnswer` 集合比对与部分分（`:57-125`） | DATA（questions / question_attempts 表与外键、幂等登记）；SVC（题型归一、多选判分、登记注册） | 可复用为 DB 层集成断言；临时目录隔离思路可直接搬进 fixture | Windows 上 SQLite 句柄未释放时目录删不掉（脚本已 `force` 忽略）；不覆盖界面交卷交互与多选 UI `[源码]` |
| LEG-09 | `scripts/verify-retry-answers.ts` | **真实调用（进程内）**：`mergeRetryAnswers` 新旧答案数组合并，断言取新答案、沿用旧顺序、首次交卷、空提交保留旧题、新题追加（`:17-57`） | SVC（answer-merge 重试合并规则） | 可复用；纯函数无外部依赖 | 不覆盖 `learning:answer-set` IPC 往返与成绩落库；顺序复用按下标，真实题序漂移未测 `[源码]` |
| LEG-10 | `scripts/verify-session-id.ts` | **源码级文本断言**：读 `packages/agent/src/index.ts`、`team.ts`、渲染层 `App.tsx`、`stream-state.ts`、主进程 `index.ts`，正则 + `indexOf` 断言 session 事件存在、发送顺序在「建会话后、跑模型前」、渲染层 `setSessionId`、主进程转发不吞事件（`:21-59`） | EVT（`session` 事件与 sessionId 前置下发）；CH（`learning:chat-event` 转发带 requestId）；IPC（失败后 sessionId 不丢的链路） | 可作为接线护栏复用；顺序断言思路有价值 | 全为文本断言：事件真的先于模型失败发出、渲染层真的记住 id，均无运行证据；文件改名/重构即误报 `[源码]` |
| LEG-11 | `scripts/verify-settings-bom.ts` | **真实调用（进程内 + 临时文件）**：`mkdtempSync` 造带 BOM JSON / 纯 JSON / 缺失 / 坏 JSON / 写回修复 / 先坏后修六组场景，驱动 `SettingsStore.read/readPublic/write`（`:29-70`） | DATA（settings.json 读写、BOM 剥离、configError 状态与自愈）；BOOT（配置迁移读取面，间接） | 可复用为配置 store 集成断言；BOM 场景由真实 issue #18 转化而来 | 未验证产品名变更导致的 userData 迁移（`index.ts:58-65`）在真实安装下的复制行为；不覆盖 settings UI `[源码]` |
| LEG-12 | `scripts/verify-startup-failure.ts` | **真实调用（进程内）**：`startupFailure(error)` 四类错误（库损坏/磁盘满/权限/未知），断言 `canResetLocalData`、标题正文文案（`:17-33`） | BOOT（启动失败分支：可否重置、文案分流、保留原始信息） | 文案与决策分支可复用为纯函数断言 | 未跑真实损坏库启动：对话框、备份改名 `.broken-<stamp>`、`app.relaunch()` 全链路无运行证据 `[源码]` |
| LEG-13 | `scripts/verify-startup-health.ts` | **真实调用（进程内）**：`startupHealth({chapters,knowledgePoints,newsArticles})` 四组统计输入，断言 ok/warnings/notices 分流（`:14-25`） | BOOT（启动体检规则：空库/缺 KP 致命、缺新闻仅提示）；IPC（`learning:health` 数据源规则，见 `index.ts:529-536`） | 体检规则可复用；与 `learning:health` IPC 的实际返回未做往返断言 | 统计数字来自真实 DB 的采集过程未测；打包首启空库/种子库分叉未覆盖 `[源码]` |
| LEG-14 | `scripts/verify-stream.ts` | **真实调用（进程内）**：渲染层纯函数 `applyStreamEvent` 喂 tool/text/session/未知工具/跨 requestId 事件，断言正文不清空、文字累加、晚到事件忽略、空状态不炸（`:18-63`） | EVT（流式事件归约：工具事件不清字、text 累加、requestId 隔离）；UI（stream-state 状态机纯函数） | 可复用为渲染状态机单元断言；对应 R21:11/48/80 回归护栏 | 不订阅真实 `learning:chat-event` 增量序列；React 组件挂载后的实际渲染未测 `[源码]` |

### 4.2 `scripts/` 下非 verify 但与测试相关的脚本

| LEG | 脚本 | 断言方式 | 覆盖到的 ID（依据） | 能否复用为自动化断言 | 局限 |
|---|---|---|---|---|---|
| LEG-15 | `scripts/dev-web.ts` | **起子进程**：`spawn('npx', ['@deepseek-ai/dsh@0.2.1-rc.2', '--profile', 'learning-agent'])`，继承 stdio，注入 `LEARNING_AGENT_HOME`（`:6-16`） | EXT（Web 部署 profile 启动器，非桌面链路） | 不作断言；可作为 Web 端 harness 的启动参考 | 当前 `apps/web` 不在本 checkout；dsh CLI 版本与网络可达性未复核 `[源码]` |
| LEG-16 | `scripts/install-profile.ts` | **起子进程**：拷贝 `cordis.patch.yml`、拼 profile `package.json`（workspace link 依赖），`spawnSync('pnpm', ['install', ...])`（`:13-48`） | DATA/EXT（开发环境装配，非运行时断言） | 不作断言；profile 结构生成逻辑可供 fixture 参考 | 会改 `~/.dsh` 下文件并联网装包，不能进自动化回归；严格依赖 pnpm 与 dsh registry `[源码]` |
| LEG-17 | `scripts/package-desktop.mjs` | **起子进程（构建脚本）**：`pnpm build` → `buildSeedDatabase()`（优先录制示例库，否则 `db:seed`/`db:seed:student`，`VACUUM INTO` 复制种子库）→ `electron-builder --win nsis` → 清理 `desktop/seed`（`:32-85`） | PKG（electron-vite/electron-builder 打包、种子库注入、electronDist 复用）；DATA（种子库构造与隔离 home） | 打包流程可被 CI 调用；但其「成功」只看 exit code，无产物内容断言（产物内容由 LEG-22 补） | 脚本自身不验证安装包可启动；录制示例库缺失时种子库不含示例对话（`:47` 有 warn）；`desktop/seed/` 打完即删，与 spec 第 6 节坑 1 相关 `[源码]` |

### 4.3 `.scratch/` 既有驱动脚本、编排脚本与数据工具

| LEG | 资产 | 驱动方式 / 取证面 | 连接对象 | 留下的证据 | 可复用什么 | 局限与状态 |
|---|---|---|---|---|---|---|
| LEG-18 | `.scratch/drive-electron.mjs` | Playwright `_electron.launch`（`:1`、`:15-21`）：`executablePath` 指 `apps/desktop/node_modules/electron/dist/electron.exe`，`args: ['.']`，`cwd: apps/desktop`，env 继承并注入 `LEARNING_AGENT_HOME`，timeout 60s；`firstWindow()` → `domcontentloaded`；定位 `textarea, input[type="text"]`；fill+Enter；**1s 间隔轮询 `body.innerText()`** 判断 busy/answered；点「新闻分析」卡片；截图 `desktop-ui.png` | dev/out 产物（未设 `ELECTRON_RENDERER_URL`，按 `index.ts:157` 走 `loadFile(out/renderer/index.html)`）；sidecar 由主进程自动拉起 8788 | 控制台文本摘录、`desktop-ui.png`（210KB） | launch 参数组合、`firstWindow()` 等待、卡片点击 + Escape 的思路可直接迁入 Playwright harness（见 `10-harness-strategy.md`） | 轮询靠文本包含与出现次数，无结构化等待信号；`waitForTimeout(1000)` 作主循环；未断言 IPC 返回/DB；questions 列表硬编码；是否仍可在当前 checkout 跑通 `[待验证]` |
| LEG-19 | `.scratch/check-ui.mjs` | Playwright `chromium.launch({ channel: 'msedge' })` headless；直接 `goto` 写死的 `http://127.0.0.1:3080/?token=...`；采集 console error / pageerror；断言 body 含「知识库/出题/调研教练/商业计划书/设置」；截图 `ui.png` | 已运行的 Web 端（3080，token 写死在脚本里） | 控制台错误数组、标题、文案命中、截图 | 「收集 console/pageerror」的失败取证模式可复用 | 目标服务与 token 写死；3080 端口在本仓无对应启动脚本；`apps/web` 不在当前 checkout；截图文件名 `ui.png` 与现存截图对不上 `[源码][待验证]` |
| LEG-20 | `.scratch/test-ui.mjs` | **非浏览器**：伪造 `globalThis.window.__ModuleLoader__.load`，直接 import 旧路径 `E:/Documents/GitHub/learning-agent/packages/ui/lib/client.js`（`:14`），调 `factory(require)` + `mod.apply(fakeCtx)`，统计 sidebar/main/settings 注册数 4/4/1 | 打包后的 `packages/ui` lib bundle（脱离 Electron/浏览器） | `test-ui.log`：sidebar/main 各 4 项、settings 1 项，"UI bundle registration check passed" `[日志]` | 模块注册计数思路可用于 bundle 冒烟 | 硬编码旧绝对路径，当前仓路径已漂移；fakeCtx 桩极简，不验证真实布局；脚本能否在本仓重跑 `[待验证]` |
| LEG-21 | `.scratch/drive-web.mjs` | Playwright chromium headless；先 `fetch /api/health`（Bearer token）再 `goto /?token=`；`textarea` 定位；fill+Enter；轮询 body 文本直到出现「新闻分析」；截图 `apps/web/.scratch-web.png` | 外部 Web server（端口 3081，token 默认 `smoke-token`，需先手动起服务） | 健康 JSON、标题、文本摘录、截图 | health 轮询 + 页面等待的两段式思路可复用 | `apps/web` 不在当前 checkout；断言全靠文本；无 IPC/DB 取证 `[源码][待验证]` |
| LEG-22 | `.scratch/verify-package.mjs` | **裸 spawn 打包产物**：复制 `release/win-unpacked` 到临时目录，spawn `营小商.exe`，参数 `--remote-debugging-port=9224 --user-data-dir=...`，env 注入 `LEARNING_AGENT_HOME`；轮询 CDP `http://127.0.0.1:9224/json` 找 `type=page` target；校验 renderer URL 位于复制目录内、`title === '营小商'`、进程未早退；再轮询等待首启种子库复制到 fresh-home（`:31-71`） | **打包产物**（win-unpacked exe），CDP 端口 9224 | 控制台 JSON：installer、renderer URL、title、bootstrapped 标记；无独立日志文件 | 打包产物离仓启动、renderer 来源校验、首启种子复制等待——这三点是现有最接近 PKG 端到端的资产，可被新 harness 沿用 | 只验启动与首启落库，未发任何 IPC、未点界面、未看渲染内容；CDP 手动编排（无 Playwright attach 封装）；`packaged-out.log` 2B / `packaged-err.log` 0B 说明运行 stdout/stderr 基本未留存 `[源码][日志]` |
| LEG-23 | `.scratch/verify-web.mjs` | **起子进程 + Playwright**：`spawn pnpm start`（`apps/web`，端口 3081，token，env 注入 HOME/token/PORT）；`waitForHealth` 轮询 `/api/health` 90s；未带 token 请求 health 记状态码；msedge headless 打开页面；fill+Enter；轮询到「新闻分析」；截图 `web-ui.png`；finally 关浏览器并 kill server | Web server 子进程 + 其浏览器页面 | server stdout/stderr 转发到控制台、健康响应、文本摘录、`web-ui.png`（108KB） | 「起服务→health 等待→浏览器驱动→收尾 kill」的 fixture 骨架最完整，可改造为 Web 端 harness 参考 | 目标 `apps/web` 缺失；依赖真实 LLM 产出「新闻分析」文案才算通过；token/端口写死；server 退出只 `kill()` 未等退出码 `[源码][待验证]` |
| LEG-24 | `.scratch/run-regression.ps1` | PowerShell 循环：`Set-Location` 旧路径 → 依次 `pnpm test:router/context/offline/profile/skills/plugins/smoke/artifacts/web`，输出重定向到 `.scratch/regression/*.log`，汇总 exit code 写 `summary.json`（`:2-19`） | 历史 monorepo 的 pnpm test 脚本族 | 当时各脚本日志（`.scratch/regression/`，当前目录未见留存） | 批量编排 + 退出码汇总 + 尾段日志打印的模式可参考 | 硬编码 `E:\Documents\GitHub\learning-agent`；根 `package.json` 已无任何 `test:*` 脚本（实测根 scripts 仅 build/typecheck/pipeline/db:seed/profile:install/dev:web/dev:desktop/build:desktop/package:desktop/db:seed:student）；**当前不可运行** `[源码]` |
| LEG-25 | `.scratch/run-regression-full.ps1` | 同 LEG-24，脚本族扩到 14 个（加 agent/case/news/data-quality/bootstrap），日志目录 `.scratch/regression2`（`:5`） | 同上 | 同上 | 同上 | 同 LEG-24，路径与脚本名均已失效 `[源码]` |
| LEG-26 | `.scratch/snapshot-db.mjs` | **只读解析**：`DatabaseSync(path, { readOnly: true })`，导出表计数、`user_version`、档案、计划状态、会话、产物、evidence 样本、同名 KP、`_2` 残留、canonical map、三类悬空引用、bad span（`:3-43`） | 任意既有 SQLite 文件（参数传入） | 快照 JSON（如 `mvp-upgrade-before-snapshot.json` 等） | 快照结构可直接复用作 DB 取证工具；只读打开不污染被测 home | 只统计不判断；阈值与升级规则在 LEG-27；不覆盖 WAL 未 checkpoint 场景 `[源码]` |
| LEG-27 | `.scratch/compare-upgrade.mjs` | **只读解析 + 比对**：读两份 snapshot JSON，断言 12 张进度表不缩水、KP 去重、9 个同义 `_2` 已合并、三类悬空引用为 0、span 可本地化、档案与计划状态逐字保留、会话/产物数量一致（`:11-53`） | 升级前后两份 DB 快照 | 控制台 ok/FAIL 行，退出码 1 表示失败 | 升级回归的断言清单可直接搬进 DATA 层 fixture 断言 | 输入依赖先生成两份快照；`student_demo`、`ch04` 等硬编码样例数据；不连运行中的应用 `[源码]` |

### 4.4 `.scratch/` 既有日志与截图（证据资产）

| LEG | 资产 | 内容与证据等级 | 可复用什么 | 局限 |
|---|---|---|---|---|
| LEG-28 | `.scratch/packaged-out.log`（2B）、`packaged-err.log`（0B） | 打包产物运行期 stdout/stderr **几乎无留存** `[日志]` | 反证：现有打包烟测没有保留运行日志，新 harness 必须补日志落盘约定 | 无法据此判断产物启动是否正常；与 LEG-22 配合看：当时只靠 CDP `/json` 与文件存在性判断 |
| LEG-29 | `.scratch/dev-desktop.log`（4123B）、`dev-desktop.err.log`（1568B） | dev 启动记录：pnpm install 告警、zod 注释警告、main/preload 构建成功、renderer dev server `http://localhost:5173/`、HMR 多次更新记录；err 尾行为 `^C` 中断，含旧路径 `learning-agent` 警告 `[日志]` | 证明 dev 链路三段（main/preload/renderer）能构建起；5173 端口与 HMR 日志形态可作启动成功信号参考 | 无运行期业务输出；HMR 记录是开发态噪音；路径混杂新旧两版仓库 |
| LEG-30 | `.scratch/ui-flow.log` | 已缺失脚本 `scripts/test-ui-flow.mjs` 的输出 JSON：`asks:5`、plan/explain(3 citations)/context/practice(3 options, submitted)/research/bp/growth/newsLab(3 candidates)/process/news(129 篇)/files(question/docx/markdown/image/pdf) 各标记 true，结尾 "Desktop UI flow passed." `[日志]` | 一份覆盖面清单：flow 级历史上断言过哪些面板与产物类型，可作为 FLOW 用例拆解参考 | 驱动脚本本体已不在 `scripts/`（`git-scripts.txt:12` 列名佐证）；日志无失败现场、无截图配对索引；通过结论不可在当前仓复跑 `[待验证]` |
| LEG-31 | `.scratch/ui-case.log` | 已缺失脚本 `scripts/test-ui-case.mjs` 的输出：demoDialogue、结构「定义/案例对应/示例对话/教学示例」、教材来源 block+page、新闻复核 autoHidden/reviewedTeaching、followUpContext，结尾 "Case UI behavior passed." `[日志]` | 案例教学场景的断言点清单（结构文案、来源定位、复核态、追问上下文） | 同 LEG-30：脚本缺失，日志为孤证；`ui-case.png`（204KB）为配套截图 |
| LEG-32 | 界面截图组：`desktop.png`（3.02MB）、`desktop2.png`（2.67MB）、`desktop-ui.png`、`ui-flow-final.png`、`ui-questions.png`、`ui-initial.png`、`ui-case.png`、`app-layout.png`、`app-layout2.png`、`debug-growth.png`、`web-ui.png`、`mvp-web-case.png`、`mvp-web-failure.png`、`mvp-web-initial.png`、`mvp-web-submitted.png`，另有爬虫 blocked/captcha/unsafe 截图十余张 | 历史人工/脚本跑批的视觉证据 `[日志]` | 基线界面长什么样、失败页长什么样（`mvp-web-failure.png`）可作人工比对参照 | 截图无元数据（用例名/账号/home/时间）与断言绑定；不能作为机器断言；爬虫截图与桌面 UI 无关 |
| LEG-33 | 其他 `.scratch` 探针与日志组：agent 直调脚本（`smoke-acceptance.ts` 无 LLM、`mvp-live.ts` 真 LLM、`check-no-model.ts`、`check-team.ts`、`dump-knowledge.ts`、`dump-payload.ts`、`smoke-local-news.ts`、`verify-kp-merge.ts`、`mvp-baseline.ts`）、DB 只读探针（`inspect-dups.mjs`、`inspect-kps.mjs`、`news-coverage.mjs`、`mvp-snapshot.mjs`）、网络探针（`probe-*.mts`、`debug-sources.mts`、`debug-latepost.mts`、`deep-probe.mts` 用 chromium 抓外网）、聊天与构建日志（`c1..cg.log`、`q*.log`、`build-*.log`、`final-*.log`、`case-rerun.log`、`ctx-rerun.log`、`ui-web*.log`、`ui-queue.log`、`test-llm.log`）、issue/PR JSON | 开发期一次性排查产物 `[源码][日志]` | 无 LLM 桩 `{ async *stream(){ throw new Error('no llm') } }` 的隔离写法、DB 备份/快照思路、外网选择器探测方法，可被新 fixture 吸收 | 绝大多数无断言退出码约定；真 LLM 脚本依赖本机 key，不可重复；日志与脚本命名漂移严重（`ui-web.log` 记录的是已缺失的 `test-ui-web.mjs` 超时失败：等「教学示例」120s 超时）`[日志]` |

### 4.5 覆盖矩阵

**图例**：`●` 已被覆盖（有对应断言行为）｜ `◐` 部分覆盖（仅纯函数/源码/间接证据）｜ `○` 空白 ｜ `—` 资产与该维度不相关。维度前缀含义见 `AUTHORING-SPEC.md` 第 4 节；本仓 02–08 文档成稿后，子编号以各主文档为准。

| LEG | BOOT | WIN | CH | IPC | EVT | UI | FLOW | PKG | EXT | SVC | DATA |
|---|---|---|---|---|---|---|---|---|---|---|---|
| LEG-01 cancel-wiring | ○ | — | ◐ | ◐ | ○ | ○ | ○ | — | — | ● | — |
| LEG-02 cancel | ○ | — | ○ | ○ | ○ | ○ | ○ | — | ○ | ● | — |
| LEG-03 empty-question-set | — | — | — | — | — | ◐ | ○ | — | — | ● | ○ |
| LEG-04 empty-return | — | — | — | — | ○ | ○ | ○ | — | — | ● | — |
| LEG-05 errors | ◐ | — | — | — | — | ○ | ○ | — | ◐ | ● | — |
| LEG-06 history-budget | — | — | — | — | — | — | ○ | — | — | ● | — |
| LEG-07 news-search | — | — | — | — | — | — | — | — | ◐ | ● | — |
| LEG-08 question-submit | — | — | — | — | — | ○ | ○ | — | — | ● | ● |
| LEG-09 retry-answers | — | — | — | — | — | ○ | ○ | — | — | ● | ○ |
| LEG-10 session-id | ○ | — | ◐ | ◐ | ◐ | ◐ | ○ | — | — | — | — |
| LEG-11 settings-bom | ◐ | — | — | — | — | ○ | — | — | — | ◐ | ● |
| LEG-12 startup-failure | ◐ | — | — | — | — | ○ | ○ | — | — | ● | ○ |
| LEG-13 startup-health | ◐ | — | — | ◐ | — | — | — | — | — | ● | ◐ |
| LEG-14 stream | — | — | — | — | ◐ | ◐ | ○ | — | — | ● | — |
| LEG-15 dev-web | — | — | — | — | — | — | — | — | ◐ | — | — |
| LEG-16 install-profile | — | — | — | — | — | — | — | — | ◐ | — | ◐ |
| LEG-17 package-desktop | — | — | — | — | — | — | — | ◐ | — | — | ◐ |
| LEG-18 drive-electron | ◐ | ○ | — | ◐ | ○ | ◐ | ◐ | ○ | ◐ | — | ○ |
| LEG-19 check-ui | — | — | — | — | — | ◐ | ◐ | — | ◐ | — | — |
| LEG-20 test-ui | — | — | — | — | — | ◐ | ○ | — | — | — | — |
| LEG-21 drive-web | — | — | — | — | — | ◐ | ◐ | — | ◐ | — | — |
| LEG-22 verify-package | ● | ◐ | — | ○ | — | ○ | ○ | ● | ○ | — | ● |
| LEG-23 verify-web | ◐ | — | — | — | — | ◐ | ◐ | — | ● | — | ○ |
| LEG-24 run-regression.ps1 | — | — | — | — | — | — | ◐ | — | ◐ | ◐ | ◐ |
| LEG-25 run-regression-full.ps1 | — | — | — | — | — | — | ◐ | — | ◐ | ◐ | ◐ |
| LEG-26 snapshot-db | — | — | — | — | — | — | — | — | — | — | ● |
| LEG-27 compare-upgrade | — | — | — | — | — | — | — | — | — | — | ● |

**矩阵规模与空白粗估**：27 个脚本/工具 × 11 个维度 = 297 格；剔除 `—` 不相关格后有效判断格约 200 格。`●` 集中在 SVC（14 格上下）与 DATA（6 格上下）；BOOT/PKG/FLOW/EXT 的运行态 `●` 仅 LEG-22、LEG-23 两处。**有效格中 `○` 约 65%–70%**；按维度：WIN 几乎全空、IPC 真实往返全空、EVT 真实增量流全空、FLOW 无固化断言、PKG 仅启动烟测、UI 仅纯函数与文本探测。日志/截图组（LEG-28～32）是证据不是断言，不进矩阵计数。

### 4.6 缺口清单（为什么空白 + 最低成本补法）

| # | 缺口面 | 现状为什么是空白 | 最低成本补法 | 关联 ID |
|---|---|---|---|---|
| G1 | 打包产物端到端交互 | LEG-22 只验「exe 能起、target 出现、标题对、种子库复制」，未发一次 IPC、未读界面内容；`packaged-out/err.log` 近乎空，运行态无留存 | 以 Playwright `_electron.launch`（或 CDP attach 9224）指 `release/win-unpacked/营小商.exe`，跑最小闭环：`learning:health` 返回 ok → 打开一个已有知识点的视图 → 截图；日志落盘到 harness 产物目录。草案见 `10-harness-strategy.md` | PKG、BOOT、IPC、UI |
| G2 | 流式取消的真实中断 | LEG-02 用假模型在信号点主动抛 `AbortError`；LEG-01 只正则守护 `signal: turn.signal` 一行；真实 DeepSeek 请求被 abort 后是否断流、是否留半截 artifact/消息，无运行证据 | harness 发起一轮 chat，捕获首个 `text-delta` 后调 `learning:cancel`，断言：后续无增量事件、DB 无半截 artifact、进程内无在途 Promise 泄漏；离线场景可用可慢速响应的 mock LLM 替代真模型 | EVT、IPC、SVC、DATA |
| G3 | 多窗口 / 单例行为 | 主进程未调用 `requestSingleInstanceLock`（grep 全 main 0 命中）；`app.on('activate')` 仅 macOS 重建窗口（`index.ts:542-544`）；第二次双击启动、窗口关闭/重建行为无任何脚本覆盖 | 先源码层确认产品是否要求单例；harness 起两个实例观察第二个实例是开新窗、聚焦旧窗还是冲突；断言窗口数量与 `window-all-closed` 退出行为。是否加单例锁属实现决策，需主代理拍板 | BOOT、WIN |
| G4 | sidecar 崩溃恢复与降级 | `news-backend.ts:157-160` sidecar 非零退出仅 `console.warn` 置空引用；无重启、无 UI 降级提示；外部 driver 拿不到 sidecar 句柄（stdio 被主进程转发） | 用 `NEWS_CRAWLER_URL` 指向一个随后被 kill 的本地端口（或 `NEWS_CRAWLER_AUTOSTART=0` 后手动杀进程），经 `learning:health`/新闻面板断言降级文案；主进程 console 日志捕获 `[news]` 行；必要时补 sidecar 日志文件重定向（属实现改动，待批准） | EXT、BOOT、IPC |
| G5 | 拖拽分栏与窗口状态持久化 | 渲染层 `layout/DragHandle.tsx`、`layout/columns.ts`、`useViewportWidth.ts` 在 dev HMR 日志出现，但无脚本操作过分栏；`window-state.ts` 的读写只在源码层存在 | Playwright 定位 DragHandle 句柄拖拽，断言两栏宽度变化；关闭重开后读 `window-state.json`（在隔离 home 下）校验持久化；最小先做「拖动后宽度比初始大」 | WIN、UI、DATA |
| G6 | DocKind 9 种标签页逐页覆盖 | `model.ts:139` 共 9 种 kind；LEG-30 历史日志覆盖过 overview/artifacts/evidence/process/files/news 等计数，但驱动脚本已缺失；artifact/file/source/news 标签页无当前可跑断言 | harness 按标签页标题文本逐个打开，断言每页关键区块存在；先列 9 页的标题文案与区块清单（见 `04-renderer-ui-flows.md`），再补定位 | UI、FLOW |
| G7 | 渲染层定位标识不足 | 无 `data-testid`/`test-id`（grep 0 命中）；现有结构性 `data-*` 钩子（消息角色、停止按钮、标签页、分栏手柄、来源类型、提交态）分散且语义面向实现；既有脚本靠 `body.innerText()` 包含、`textarea`/`input` 首元素定位，文案微调即碎 | 短期：harness 定位表优先复用现有 `data-*` 钩子，其次 role + 可见文本 + 占位符；中期：评估在关键控件补 `data-testid`（属渲染层实现改动，需主代理批准，四方案均受益，见 `10-harness-strategy.md` 第 2 节） | UI |
| G8 | 37 个 `learning:invoke` 方法的 IPC 契约往返 | verify 脚本直接 import service 函数，绕过 preload 与 `ipcMain.handle`；无脚本经 `window.learning.invoke` 做方法级契约快照；CH 面 9 条通道未逐条验证方向与错误传播 | harness fixture 封装 `window.learning.invoke(method, input)`，对只读方法（`student.current`、`chapters.list`、`news.status` 等）做返回结构快照；写方法在隔离 home 下成对造数/清理 | IPC、CH、DATA |
| G9 | 种子库缺失与首启分叉的打包校验 | `electron-builder.yml:13` 引用 `seed/learning.db`，但 `apps/desktop/seed/` 不在仓库；LEG-17 打完即删 `desktop/seed`；重新打包是否产出无种子库安装包，无自动校验 | 打包后断言 `win-unpacked/resources/seed/learning.db` 存在且非空（LEG-22 已有此检查点可保留）；另在隔离 home 首启后断言章节/KP 计数非零（对接 LEG-13 规则） | PKG、DATA、BOOT |
| G10 | 真实损坏库 → 重置 → relaunch 全链路 | LEG-12 只测 `startupFailure` 纯函数文案；对话框、`.broken-<stamp>` 改名、`app.relaunch()` 真实路径无人跑过 | harness 造一个损坏 SQLite 文件放进隔离 home，启动应用，观察错误对话框/重置分支；可脚本化部分用主进程 evaluate 触发，对话框按钮点击按平台实测 | BOOT、DATA |
| G11 | 低确定性 LLM 场景的可重复隔离 | `mvp-live.ts` 等真调 DeepSeek，依赖本机已存 key；既有脚本无统一 mock 开关；联网/模型结果不可重复 | fixture 分层：纯函数/DB 用例不加载 LLM；需要对话流的用例默认注入抛错或脚本化假 LLM，真模型冒烟单独标记并允许失败 | SVC、EXT、DATA |
| G12 | Web 部署路径在当前仓的可运行性 | LEG-19/21/23 指向 `apps/web` 与 3080/3081 端口，当前 `apps/` 下仅 `desktop`；相关脚本与日志均为旧仓库（`learning-agent`）遗存 | 先确认 Web 端是否仍在交付范围；若保留，需先恢复/定位 Web 服务启动方式，再迁移 LEG-23 的 health→浏览器骨架；若废弃，在文档地图标注归档 | EXT、FLOW |

### 4.7 判断题：源码静态断言为主，还是真实运行断言为主？

**结论：以源码静态断言 + 进程内行为断言为主，真实运行（GUI/打包产物）断言为辅且未固化。** `[源码]`

依据：

- 14 个 verify 脚本中，**纯源码文本断言 1 个半**（LEG-01 后半、LEG-10 全部）；其余 12 个是 Node 进程内真实函数/临时 DB 调用，但被测对象是纯函数、服务类或 store，**不启动 Electron 运行时、不经过 preload/IPC/渲染层**。
- 真正起子进程驱动 GUI/HTTP 的资产共 6 个：LEG-18、LEG-19、LEG-21、LEG-22、LEG-23、LEG-20（bundle 加载，非 GUI）；其中连真实 Electron 桌面进程的只有 LEG-18（dev/out）与 LEG-22（打包产物）两个，且都是一次性脚本、文本轮询断言、无 runner 收纳。
- 粗估比例：既有断言面中进程内（纯函数/服务/临时库）约 **80%**，真实 Electron/Web 运行态约 **20%**；运行态断言里又只有 LEG-22 触及打包产物，其余连的是 dev/out 或外部 web 服务。
- 旁证：`.scratch` 日志中明确 "passed" 的两条（LEG-30/31）来自已删除的驱动脚本；现存驱动脚本没有一条在仓库内留下「最近一次通过」的结构化记录。

## 5. 风险与坑

1. **把「脚本存在」误读成「验证通过」**：`scripts/verify-*.ts` 全部没有配套的最近运行日志；本调查未执行它们，其断言是否当前全绿属 `[待验证]`。`.scratch` 中 "passed" 结论来自旧仓库路径下的历史运行（LEG-30/31），不能作为当前代码的通过证据。
2. **旧路径漂移导致脚本静默失效**：LEG-20/24/25 与 `ui-web.log`、`dev-api.log` 都写死 `E:\Documents\GitHub\learning-agent`；根 `package.json` 已无 `test:*` 脚本；`apps/web` 缺失。迁移任何旧脚本前必须先改路径与启动命令，不能直接 `node`/`pnpm` 复用。
3. **文本断言脆弱且 test-id 缺失**：LEG-18/19/21/23 的核心判断都是 `body.innerText().includes(...)`；现有 `data-*` 结构钩子未被利用，界面文案、空格、顺序微调都会误判；新 harness 必须先建定位表（G7）。
4. **轮询信号不是「等信号」**：既有驱动用 `waitForTimeout(1000)` 主循环 + 文本出现次数判定忙/闲；模型慢响应、HMR 重载、sidecar 未就绪都会造成假阴性或假阳性。新等待策略须以 IPC resolve / DOM 出现 / 端口 health / 文件 mtime / 日志行为准（见 `10-harness-strategy.md` 第 4 节）。
5. **sidecar 取证盲区**：Python 采集服务由主进程 spawn，stdout/stderr 转发进主进程 console（`news-backend.ts:149-156`），外部 driver 既无 sidecar 句柄也读不到它的独立日志文件；崩溃/慢启动只能经 8788 `/health`、主进程日志行与共享 DB 侧证。
6. **打包产物证据链断裂**：`packaged-out.log` 2B、`packaged-err.log` 0B；LEG-22 把 `stdio: 'ignore'`（`:34`），产物运行期输出被丢弃；新 harness 必须在 launch 配置里接管主进程 stdout/stderr 并落盘。
7. **隔离不彻底的历史写法**：LEG-18/23 默认 `LEARNING_AGENT_HOME` 回退到 `homedir()/.learning-agent`，LEG-26/27 直接读真实库；复用时必须先强制指向临时 home，避免污染真实用户数据（原则见 `08-data-fixtures-and-isolation.md`）。

## 6. 未覆盖与待验证

| # | 未覆盖/未验证项 | 验证方法 |
|---|---|---|
| U1 | 14 个 verify 脚本在当前代码基上是否全部退出码 0（本次按禁令未执行） | 由主代理批准后逐个 `pnpm exec tsx scripts/<name>.ts`，记录退出码与输出；先在隔离 `LEARNING_AGENT_HOME` 下跑 LEG-08/11 类临时库脚本 |
| U2 | LEG-18 在当前 checkout 能否拉起 out 产物（`out/renderer/index.html` 存在性、electron.exe 路径、`args: ['.']` 解析） | 只读核对 `apps/desktop/out/renderer/index.html` 与 `apps/desktop/node_modules/electron/dist/electron.exe`；实跑需主代理批准，首次先不开 autostart（`NEWS_CRAWLER_AUTOSTART=0`） |
| U3 | LEG-20 的旧 import 路径 `E:/Documents/GitHub/learning-agent/packages/ui/lib/client.js` 是否在本仓有等价物 | 检查 `packages/ui/lib/client.js` 是否存在、bundle 注册机制是否仍为 `__ModuleLoader__`；不存在则该资产归档 |
| U4 | `services/news-crawler-py/tests/` 6 个 pytest 文件（query/service/registry/html/normalize/adhoc）的最近通过状态 | 由主代理批准后在 `.venv` 内跑 pytest；结果归入 `06-news-sidecar-and-network.md` |
| U5 | 根 `playwright@1.64.1` 与 Electron 44.9.0 的 CDP 兼容性；`@playwright/test` 未安装 | 见 `10-harness-strategy.md` 待验证项；最小实验：`_electron.launch` 拉起 dev 产物并 `firstWindow()` 成功即基线 |
| U6 | `.scratch` 中 `c1..cg.log`、`q*.log`、`final-*.log` 等未逐个归类的日志对应哪次运行 | 抽样读取头部时间戳与命令行回显，归入 LEG-33；不影响本次矩阵结论 |
| U7 | `apps/desktop/seed/` 缺失对下一次打包的实际影响（spec 坑 1） | 只读核对 `apps/desktop/seed/` 是否存在；下次打包后检查 `win-unpacked/resources/seed/learning.db`（当前现存产物中该文件存在，属历史打包结果） |

## 7. 交叉引用

- 启动生命周期、失败兜底与窗口：`02-main-runtime-and-boot.md#23-窗口创建与状态恢复流程`（BOOT/WIN）
- preload 面、9 条通道、37 个 `learning:invoke` 契约：`03-ipc-and-preload-contract.md#43-learninginvoke-方法契约表ipc-01--ipc-37`（IPC/CH）
- 页面/面板/标签页与定位：`04-renderer-ui-flows.md#22-视图面板标签页总表本篇定义的-ui-xx`（UI/FLOW/EVT）
- 构建、asar、extraResources、首启自举：`05-build-package-and-first-run.md#23-electron-builder--nsis-产物布局`（PKG）
- Python sidecar、8788 端口、健康检查与离线降级：`06-news-sidecar-and-network.md#42-端口健康检查与重建策略ext-04--ext-07`（EXT）
- 领域服务确定性分级：`07-domain-services-and-determinism.md#22-依赖面与确定性总表`（SVC）
- SQLite 结构、隔离 home、造数与清理：`08-data-fixtures-and-isolation.md#41-sqlite-结构基线`（DATA）
- 四方案可行性、launch 草案、fixture/等待/截图/日志约定：`10-harness-strategy.md#41-四方案矩阵含本项目阻塞点`
- 场景目录与用例编号：`11-scenario-catalog.md`（TC-P0/TC-P1，文档尚未成稿）
- 官方四路径原始说法：`../electron-automated-testing.md`
