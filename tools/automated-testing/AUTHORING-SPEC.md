# 调查文档编写规范（自动化测试）

> 本文件是 `tools/automated-testing/docs/` 下所有文档的写作契约。所有撰稿子代理必须先读本文件，再动笔。
> 基线文档：`tools/automated-testing/electron-automated-testing.md`（Electron 官方自动化测试指南摘录）。

## 1. 这套文档要解决什么

目标不是「介绍项目」，而是让一个没接触过本项目的人，能在 30 分钟内知道：

1. 这个 Electron 应用从哪里启动、启动时按什么顺序装配了什么；
2. 界面上有哪些页面/面板/流程，每一步对应哪个 IPC 方法、哪张表、哪个文件；
3. 哪些地方可以稳定断言，哪些地方天然不稳定（时序、网络、模型、Python 子进程）；
4. 怎么把测试环境与真实用户数据隔离，怎么造数据、怎么清理；
5. 用 Playwright / WebdriverIO / Selenium / 自定义 IPC 驱动，各自该怎么接、代价是什么。

**判断标准**：拿到文档的人可以不看源码就写出第一个可运行的冒烟测试；看源码时能按文档给出的 `文件:行` 直达关键代码。

## 2. 交付位置与文件清单

全部落在 `tools/automated-testing/docs/`，禁止写到别处；每份文档只有一个负责人，禁止并发改同一文件。

| 文件 | 主题 | 责任边界（写什么 / 不写什么） |
|---|---|---|
| `README.md` | 文档地图、阅读顺序、维护规则 | 只做索引与导航，不复述技术细节 |
| `01-execution-map.md` | 执行地图：分层 → 启动路径 → 页面 → 流程 → 用例 ID 总索引 | 只做「地图」和交叉索引，细节留给各专题文档 |
| `02-main-runtime-and-boot.md` | 主进程生命周期、服务装配、启动失败与重置、窗口与状态 | 不展开 IPC 方法逐个字段（见 03） |
| `03-ipc-and-preload-contract.md` | preload 暴露面、9 条通道、37 个 `learning:invoke` 方法契约 | 不写渲染层视觉与交互（见 04） |
| `04-renderer-ui-flows.md` | 页面/视图/面板结构、交互流程、可定位元素与状态机 | 不逐个复述后端返回字段（见 03/07） |
| `05-build-package-and-first-run.md` | electron-vite / electron-builder、asar、extraResources、首启自举、路径解析 | 不写 Python 采集服务内部（见 06） |
| `06-news-sidecar-and-network.md` | Python 采集服务拉起与契约、端口、健康检查、离线降级、网络依赖面 | 不写新闻领域逻辑细节（见 07） |
| `07-domain-services-and-determinism.md` | agent / matcher / questions / research / bp / profile / artifacts / news 的输入输出与确定性分级 | 不写 UI 呈现（见 04） |
| `08-data-fixtures-and-isolation.md` | SQLite 结构、种子库、`LEARNING_AGENT_HOME` 隔离、settings/window-state、造数与清理 | 不写打包流程（见 05） |
| `09-existing-verification-and-gaps.md` | `scripts/verify-*.ts`、`.scratch` 里的历史驱动脚本、覆盖矩阵与缺口 | 不设计新用例（见 11） |
| `10-harness-strategy.md` | 四种驱动在本项目的可行性、launch 配置草案、fixture/等待/截图/日志方案 | 不列具体业务场景（见 11） |
| `11-scenario-catalog.md` | P0/P1 场景目录：前置、步骤、断言、依赖 ID、易碎点 | 不重复实现细节，引用 02–10 的 ID |

约定：文件名用两位数字前缀排序；一篇文档只解决一个主题；跨主题内容用链接，不复制粘贴。

## 3. 文档模板（每篇必须有的七节）

```markdown
# NN · 标题

> 归属：<哪一层/哪个包> ｜ 状态：已完成/部分 ｜ 核对日期：2026-11-18
> 覆盖：<列出的文件/目录> ｜ 不覆盖：<明确排除项，指向其他文档>

## 1. 结论摘要（TL;DR）
5–8 条，每条一句话，直接给结论，不铺垫。

## 2. 结构与流程
分层图 / 时序图 / 步骤表（用 Markdown 表格或 ASCII 图）。必须能回答「谁在什么时候调谁」。

## 3. 关键代码位置
| 职责 | 文件:行 | 说明 |
（相对仓库根的路径，行号写成 `apps/desktop/src/main/index.ts:445`）

## 4. 可测点
| ID | 触发方式 | 观测点（DOM/IPC 返回/文件/日志） | 前置条件 |
（ID 见第 4 节编号方案）

## 5. 风险与坑
时序、异步、单例、缓存、平台差异、外部依赖、容易误判的断言。

## 6. 未覆盖与待验证
明确写「没读到 / 没跑过 / 推断」的项，给出验证方法。

## 7. 交叉引用
指向相关文档的锚点（`03-ipc-and-preload-contract.md#ipc-12` 这种）。
```

## 4. ID 编号方案（全文档统一，不得自创前缀）

| 前缀 | 含义 | 示例 |
|---|---|---|
| `BOOT-xx` | 应用启动、生命周期、单例、退出、崩溃重置 | `BOOT-03` |
| `WIN-xx` | 窗口创建、尺寸、最小尺寸、窗口状态持久化 | `WIN-02` |
| `IPC-xx` | `learning:invoke` 方法（按 `main/index.ts` 的 switch 顺序编号，01 起） | `IPC-12` |
| `CH-xx` | IPC 通道本身（invoke/handle/on/send 的方向与语义） | `CH-05` |
| `EVT-xx` | 主进程推给渲染层的流式事件 | `EVT-02` |
| `UI-xx` | 页面、视图、面板、标签页 | `UI-07` |
| `FLOW-xx` | 端到端交互流程（跨组件） | `FLOW-04` |
| `PKG-xx` | 构建、打包、安装包、首启资源 | `PKG-06` |
| `EXT-xx` | Python 服务、LLM、网络、文件对话框等外部面 | `EXT-03` |
| `SVC-xx` | 领域服务（agent/matcher/questions/...） | `SVC-09` |
| `DATA-xx` | 数据库、种子、配置、隔离与清理 | `DATA-04` |
| `LEG-xx` | 既有验证脚本与历史驱动 | `LEG-07` |
| `TC-P0-xx` / `TC-P1-xx` | 场景用例（P0 冒烟必过，P1 回归） | `TC-P0-03` |

规则：

- ID 一旦写入就别改号；新增只在末尾追加。
- 同一 ID 只在「主文档」定义一次，其他文档只引用，不重复定义。
- `11-scenario-catalog.md` 的每个 TC 必须至少引用 1 个非 TC 的 ID（说明它依赖哪条实现事实）。
- 执行地图必须能反查：`TC → 页面/流程 → IPC → 代码位置`。

## 5. 证据等级（必须标注，不许含糊）

| 标记 | 含义 | 使用要求 |
|---|---|---|
| `[源码]` | 直接读代码得到，附 `文件:行` | 默认等级，绝大多数结论用它 |
| `[日志]` | 来自仓库内已有日志/截图/构建产物 | 附路径，如 `.scratch/dev-desktop.log` |
| `[实测]` | 本次真的跑过并观察到 | 只有真跑过才能用，写清命令与结果 |
| `[待验证]` | 推断、未跑、未读到运行证据 | 必须给出验证步骤；不许伪装成结论 |

**禁止**把「推测」写成陈述句。任何「应该 / 大概 / 可能」都要落到 `[待验证]` 并给出验证方法。
行号以当前工作区为准，文首写明「行号截至 2026-11-18」；引用函数名时同时给函数名，防止行号漂移后失效。

## 6. 已知事实基线（已核对，可直接引用，但需自行复核行号）

### 仓库与入口

- 仓库根：`E:\Documents\GitHub\YingXiaoShang`，pnpm workspace（`packages/*`、`profiles/*`、`apps/*`）。
- 唯一 Electron 应用：`apps/desktop`，包名 `@learning-agent/desktop`，productName `营小商`，`main` 指向 `out/main/index.js`。
- 主进程入口：`apps/desktop/src/main/index.ts`（约 556 行）。
- preload：`apps/desktop/src/preload/index.ts`（44 行），`contextBridge.exposeInMainWorld('learning', ...)`。
- 渲染层：`apps/desktop/src/renderer/src/`，入口 `main.tsx` → `App.tsx`（约 80KB），另有 `pages.tsx`、`workspace.tsx`、`renderers.tsx`、`model.ts`、`stream-state.ts`、`markdown.tsx`、`layout/`。
- 构建：`apps/desktop/electron.vite.config.ts`（electron-vite 4，main/preload/renderer 三段，`EXTERNAL = ['electron','playwright','playwright-core']`）。
- 打包：`apps/desktop/electron-builder.yml`（NSIS，`asar: true`，输出 `../../release`，`extraResources` 含 `seed/learning.db`、`../../packages/agent/agents`、`../../packages/agent/references`）。
- 已有产物：`apps/desktop/out/`（main 2.5MB / preload / renderer）、`release/win-unpacked/`、`release/营小商 Setup 0.1.0.exe`。
- 运行环境：Node v22.23.2、pnpm 11.22.0（注意根 `package.json` 声明 `packageManager: pnpm@11.28.5`，存在版本不一致）。

### IPC 面（需逐条核实并补全参数/返回/副作用）

`ipcMain.handle` 通道共 9 条：

`learning:invoke`、`learning:cancel`、`learning:chat`、`learning:answer`、`learning:answer-set`、`learning:health`、`learning:settings:get`、`learning:settings:set`，以及主进程 → 渲染层的 `learning:chat-event`（`event.sender.send`）。

`learning:invoke` 的 switch 分支（按出现顺序，01 起编号，共 37 个）：

`student.current`、`chapters.list`、`kps.list`、`getKp`、`getBlock`、`getResource`、`listIdeology`、`news.list`、`news.status`、`news.refresh`、`news.get`、`news.match`、`questions.attempts`、`profile.get`、`profile.growth`、`profile.evidence`、`profile.snapshot`、`profile.review`、`artifacts.list`、`artifacts.get`、`artifacts.export`、`memory.facts`、`memory.episodes`、`memory.summary`、`memory.upsert`、`memory.delete`、`chat.sessions`、`chat.messages`、`agent.snapshot`、`agent.suggestions`、`agent.turns`、`agent.ledger`、`agent.retry`、`agent.sessions`、`files.reveal`、`files.preview`、`files.openDialog`。

### 环境变量（主进程读取的真实入口，测试隔离的关键）

| 变量 | 作用 | 默认/约束 |
|---|---|---|
| `LEARNING_AGENT_HOME` | 数据目录根（db、window-state、artifacts、exports） | 缺省 `~/.learning-agent`；dev 下 `electron.vite.config.ts` 注入 `resolve('../../.learning-agent')` |
| `LEARNING_AGENT_PROMPT_ROOTS` | 提示词根（`;` 分隔） | 主进程拼 `process.resourcesPath/prompts` + `packages/agent` |
| `LEARNING_AGENT_NEWS_REFRESH_MINUTES` | 新闻刷新周期 | 默认 30，最小 1 |
| `NEWS_CRAWLER_PORT` / `NEWS_CRAWLER_URL` | 采集服务端口/地址 | 默认 `8788` / `http://127.0.0.1:8788` |
| `NEWS_CRAWLER_AUTOSTART` | 设为 `0` 则只健康检查、不拉起子进程 | 未设置则 autostart |
| `NEWS_CRAWLER_DIR` / `NEWS_CRAWLER_PYTHON` / `NEWS_CRAWLER_VENV` / `NEWS_CRAWLER_WORKERS` | 服务目录、解释器、虚拟环境、并发 | venv 默认 `<repo>/.venv` |
| `ELECTRON_RENDERER_URL` | dev 服务器地址，存在则 `loadURL`，否则 `loadFile(out/renderer/index.html)` | electron-vite dev 注入 |

### 已核对的坑（写文档时必须展开，别漏）

1. **`apps/desktop/seed/` 在仓库里不存在**，但 `electron-builder.yml` 的 `extraResources` 引用 `seed/learning.db`；已打出的 `release/win-unpacked/resources/seed/learning.db` 存在。=> 重新打包可能产出「无种子库」的安装包，首启会出现空库/建库路径分叉 `[源码]`。必须写清验证方法与影响面。
2. `initServices()` 中 settings 迁移路径依赖 `app.getPath('appData')/@learning-agent/desktop`，productName 变更会丢配置 `[源码]`。
3. 新闻子进程与主进程共用一个 SQLite 文件（`$appHome/data/learning.db`），且 8788 端口可能被旧进程占用 `[源码]`。
4. `startNewsAutomation()` 里 `await matcher.backfill(20)` 未包在 try 内，异常会冒泡到未捕获 Promise `[源码，需复核]`。
5. `learning:chat` 的 `signal` 由 `TurnCanceller` 提供，取消是否真正中断模型请求需要单独验证；`scripts/verify-cancel-wiring.ts` 做的是源码级断言 `[源码]`。
6. 渲染层 `pages.tsx` 与 `packages/ui/src/client/pages.tsx` 是两份近似实现（31155 vs 31161 字节），存在漂移风险 `[源码]`。
7. `apps/desktop/out/` 是已构建产物；`electron-vite dev` 与 `electron-vite preview` 与安装包三条启动路径的 `app.getAppPath()`、`process.resourcesPath`、`__dirname` 各不相同 `[源码]`。

### 既有测试资产（必须调查并在 09 里成表）

- `scripts/` 下 **14 个** `verify-*.ts`（cancel-wiring、cancel、empty-question-set、empty-return、errors、history-budget、news-search、question-submit、retry-answers、session-id、settings-bom、startup-failure、startup-health、stream）。注：本规范初稿曾写「16 个」，2026-11-19 经子代理逐文件复核更正为 14 个，以 `09-existing-verification-and-gaps.md` 的清单为准。
- `.scratch/` 下有历史驱动脚本与日志：`drive-electron.mjs`、`check-ui.mjs`、`run-regression.ps1`、`run-regression-full.ps1`、`verify-package.mjs`、`verify-web.mjs`、`packaged-out.log`、`packaged-err.log`、`dev-desktop.log`、多张界面截图（`desktop.png`、`ui-flow-final.png` 等）。
- `services/news-crawler-py/tests/` 有 pytest 用例（query/service/registry/html/normalize/adhoc）。
- 根 `devDependencies` 有 `playwright@^1.55.0`，且被主进程构建标为 external（应用内懒加载，缺浏览器时要能优雅降级）。

## 7. 测试设计原则（写「可测点」和「场景」时按这个来）

1. **先隔离再谈用例**：任何 TC 必须写清用哪个 `LEARNING_AGENT_HOME`、哪个端口、是否禁用 autostart、是否需要 API Key。禁止指向真实用户目录 `~/.learning-agent`。
2. **可观测优先**：优先断言 IPC 返回值、SQLite 行、文件落盘、进程状态；DOM 断言次之；截图只作证据，不作唯一断言。
3. **等待策略显式化**：禁止 `sleep(固定秒)` 作为主策略；写清「等哪个信号」（IPC resolve、DOM 出现、端口 health、文件 mtime、日志行）。
4. **区分确定性等级**：纯函数/DB 读写（高）→ 模板渲染（中）→ LLM 生成（低）。低确定性场景只断言结构与约束（字段存在、引用可解析、长度、状态流转），不断言具体文案。
5. **失败可诊断**：每个 TC 规定失败时要留的证据（截图、IPC payload、日志片段、DB 查询）。
6. **不制造脏数据**：用例结束要能回滚；共享 fixture 要标只读。

## 8. 硬性禁止

- 不修改仓库任何源码、配置、锁文件；`tools/automated-testing/` 之外只读。
- 不启动 GUI 应用、不跑 `pnpm dev` / `electron` / 安装包安装；调查以源码 + 仓库内既有日志/产物为准（确需运行必须由主代理批准）。
- 不写「未来应该重构」类建议清单；只写事实、可测点、缺口与验证方法。
- 不复制粘贴大段源码；引用 `文件:行` + 一句话说明即可。
- 不编造行号、不编造未读过的文件内容、不把猜测写成结论。

## 9. 验收清单（每篇文档自查）

- [ ] 七节齐全，TL;DR 不超过 8 条。
- [ ] 至少 1 张结构/流程表或图，能说清调用顺序。
- [ ] 关键代码位置表覆盖本篇所有核心结论，路径相对仓库根、带行号。
- [ ] 可测点表 ID 符合第 4 节，且与执行地图能对上。
- [ ] 风险与坑至少 3 条，且是具体的（不是「注意兼容性」这种空话）。
- [ ] 「未覆盖与待验证」不为空，且每条有验证方法。
- [ ] 交叉引用链接可达（相对路径 + 锚点）。
- [ ] 全文中文，术语保留英文原词（IPC、preload、asar 等）。
