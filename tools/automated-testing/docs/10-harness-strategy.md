# 10 · Harness 策略：四种驱动可行性对比与草案

> 归属：自动化测试 harness 选型与骨架（不属应用任何一层）｜ 状态：部分（只读调查 + 草案，未实跑）｜ 核对日期：2026-11-18
> 覆盖：Playwright `_electron.launch`、WebdriverIO + `wdio-electron-service`、Selenium + 自建 Electron driver、自定义 IPC 驱动四路径在本仓的可行性；launch 配置草案；fixture / 等待 / 截图 / 日志约定
> 不覆盖：具体业务场景用例（见 `11-scenario-catalog.md`）；既有资产盘点（见 `09-existing-verification-and-gaps.md`）；Python sidecar 内部契约（见 `06-news-sidecar-and-network.md`）

> 行号截至 2026-11-18。证据等级：`[源码]` 直接读代码；`[日志]` 仓库内既有日志；`[待验证]` 未实跑或依赖外部版本兼容。本文不新增业务 ID，只引用 02–09 既有前缀（BOOT/WIN/IPC/CH/EVT/UI/FLOW/PKG/EXT/SVC/DATA/LEG）。

## 1. 结论摘要（TL;DR）

1. **推荐主方案：Playwright `_electron.launch`**。仓库根已装 `playwright@1.64.1`（devDep `^1.55.0`），既有 LEG-18 已用同一路径拉起 Electron；DOM 定位、截图、主进程 evaluate、渲染层事件订阅能力在四方案中最完整，Windows 原生支持。`[源码]`
2. **阻塞点首要项**：Electron 44.9.0 与 Playwright 1.64 的 CDP 兼容性本次未实跑 `[待验证]`；`@playwright/test` 未安装（当前只有 `playwright` 包）；渲染层无 `data-testid`，仅有一批结构性 `data-*` 钩子，定位仍需以文本/role 兜底。
3. **自定义 IPC 驱动**开销最低、隔离最直接，但当前主进程没有任何 `process.on('message')` / `APP_TEST_DRIVER` 钩子（grep 0 命中），必须先改应用源码加测试通道，属需主代理批准的实现变更；且它没有 DOM 与截图能力。
4. **WDIO** 与 **Selenium** 在本仓无既有依赖与脚本遗产；WDIO 受 `wdio-electron-service` 对 Electron 44 的版本契合制约，Selenium 需手工对齐 `electron-chromedriver` 与 Chromium 版本，两者编排成本都高于 Playwright。
5. 环境变量必须在 **launch 时全量注入**：`LEARNING_AGENT_HOME`（隔离数据目录）、`NEWS_CRAWLER_AUTOSTART=0`（默认不拉起 sidecar）、`NEWS_CRAWLER_PORT`、`ELECTRON_RENDERER_URL`（仅 dev server 模式）；主进程不读父进程之后的二次注入。`[源码]`
6. 打包产物（`release/win-unpacked/营小商.exe`）四方案均可作为 `executablePath`/`binary` 目标；asar 内代码只读，测试读写必须落在 `LEARNING_AGENT_HOME` / `app.getPath('userData')`。
7. sidecar 是主进程 spawn 的孙进程，外部 driver 拿不到它的句柄与独立 stdout；取证只能走主进程 console 转发、8788 `/health` 轮询、共享 SQLite 三条路。
8. 等待策略一律「等信号」（IPC resolve / DOM 出现 / 端口 health / 文件 mtime / 日志行），禁止把固定 `sleep` 当主策略；既有 LEG-18/21/23 的 1s 文本轮询只作反面参照。

## 2. 结构与流程

### 2.1 四方案在本仓的接入位置

```
                        ┌──────────────────────── harness runner（Node）────────────────────────┐
                        │                                                                        │
  Playwright            │  _electron.launch({ executablePath, args, env, cwd, timeout })         │
  (推荐)                │    └─ ElectronApp ── evaluate(主进程) / firstWindow() ── Page(DOM/事件) │
                        │                                                                        │
  WebdriverIO           │  wdio runner ── wdio-electron-service ── WebDriver ── Electron 进程       │
                        │    └─ browser.electron.execute(主进程) / browser.$(DOM)                  │
                        │                                                                        │
  Selenium              │  selenium-webdriver ── ChromeDriver(9515) ── Electron binary(CDP)      │
                        │    └─ renderer JS 执行；主进程侧能力弱                                  │
                        │                                                                        │
  自定义 IPC            │  child_process.spawn(electron/exe, args, { stdio:[...,'ipc'], env })   │
                        │    └─ process.send / process.on('message') RPC（需应用侧加钩子）         │
                        └────────────────────────────────────────────────────────────────────────┘
                                          │ spawn（孙进程，driver 不直接持有）
                                          ▼
                        Python sidecar（127.0.0.1:8788，共享 $LEARNING_AGENT_HOME/data/learning.db）
```

### 2.2 官方说法与本仓差异对照（基线：`../electron-automated-testing.md`）

| 官方路径 | 官方要点 | 本仓实际差异 |
|---|---|---|
| WebdriverIO | `services: ['electron']`，`browserName: 'electron'`，`appBinaryPath`/`appArgs`；`browser.electron.execute` 在主进程执行 | 本仓无 WDIO 依赖；Electron 44.9.0；应用经 cordis Context 装配服务（`index.ts:82-100`），主进程 evaluate 可触达的模块面需实测 `[待验证]` |
| Selenium | 下载 `electron-chromedriver`，9515 端口；`goog:chromeOptions.binary` 指 Electron 二进制 | 本仓未装 ChromeDriver；打包产物 exe 名 `营小商.exe`；官方示例为 macOS 路径，Windows 路径与 `--remote-debugging-port` 编排需自建 `[源码]` |
| Playwright | `_electron.launch({ args: ['.'] })`；`electronApp.evaluate` 访问主进程；`firstWindow()` 取 Page 截图 | 本仓 LEG-18 已用 `_electron` 指 dev electron.exe；根装 `playwright` 而非 `@playwright/test`；主进程入口 `out/main/index.js`，renderer 走 `loadFile` 或 `ELECTRON_RENDERER_URL`（`index.ts:154-157`） |
| 自定义 IPC | `spawn(path, args, { stdio: [...,'ipc'], env })`；应用侧 `process.on('message')` / `process.send()`，`APP_TEST_DRIVER` 开关 | 本仓主进程无消息钩子（grep `process.send` / `process.on('message')` / `APP_TEST_DRIVER` 0 命中）；preload 已暴露 `window.learning`（`preload/index.ts:9-24`），渲染层通道可复用，但主进程 RPC 需新增 `[源码]` |

## 3. 关键代码位置

| 职责 | 文件:行 | 说明 |
|---|---|---|
| 主进程入口与装配 | `apps/desktop/src/main/index.ts:44`（`initServices`）、`:82-100`（cordis Context 挂服务）、`:398`（`whenReady`） | harness 启动后首个可观测点是服务装配完成、窗口创建 |
| 窗口创建与加载方式 | `apps/desktop/src/main/index.ts:129`（`createWindow`）、`:154-157`（`ELECTRON_RENDERER_URL` 存在则 `loadURL`，否则 `loadFile(out/renderer/index.html)`） | 决定 launch 时是否需要先起 vite dev server |
| IPC 面与事件推送 | `apps/desktop/src/main/index.ts:445`（`learning:invoke`）、`:453`（`learning:chat`）、`:480`（`learning:chat-event`）、`:529`（`learning:health`） | 渲染层断言优先走 `window.learning.*`；事件增量经 `learning:chat-event` |
| preload 暴露面 | `apps/desktop/src/preload/index.ts:9-24` | `invoke/chat/health/cancel/onChatEvent/answer/answerSet/settings`；harness 在 Page 内 `evaluate` 即可调用 |
| sidecar 拉起与转发 | `apps/desktop/src/main/news-backend.ts:97`（`AUTOSTART=0` 仅体检）、`:136-148`（`spawn`，stdio pipe）、`:149-156`（转发主进程 console）、`:162`（8s 健康等待） | driver 无 sidecar 句柄；默认隔离应关 autostart |
| 数据目录解析 | `apps/desktop/src/main/window-state.ts:24-26`（`resolveAppHome`）；`apps/desktop/src/main/index.ts:71-81`（首启种子库复制） | 测试 home 必须由 `LEARNING_AGENT_HOME` 注入；种子库复制行为是首启断言点 |
| 环境变量读取 | `apps/desktop/src/main/index.ts:104`（刷新周期）；`news-backend.ts:10-11,42,51,63,121-132`（端口/目录/解释器/venv/并发）；`main/settings.ts:50-61`（`DEEPSEEK_API_KEY/MODEL`）；`main/llm.ts:85`（`DEEPSEEK_BASE_URL`） | launch `env` 需覆盖的完整清单见 4.3 |
| 打包产物布局 | `apps/desktop/electron-builder.yml:13-20`（extraResources seed/prompts）、`:21`（`asar: true`）；`release/win-unpacked/营小商.exe`、`resources/app.asar`、`resources/seed/learning.db`（现存产物已核对） | packaged 模式 `executablePath` 目标 |
| 外部化与版本基线 | `apps/desktop/electron.vite.config.ts:32`（`EXTERNAL`）；`apps/desktop/package.json:35`（electron ^44.0.0，实测 44.9.0）；`package.json:48`（playwright ^1.55.0，实测 1.64.1；`@playwright/test` 未安装） | 兼容性判断与依赖决策基线 |
| 渲染层定位现状 | `apps/desktop/src/renderer/src/` grep `data-testid`/`test-id`/`data-test` 0 命中；结构性钩子：`App.tsx:1136,1220,1481,1493,1516`（`data-message-role`/`data-action="stop"`/`data-streaming`/`data-notice`）、`workspace.tsx:201,236,393`（`data-source-kind`/`data-tab-id`）、`renderers.tsx:130,465,472,606`（`data-submitted`/`data-match-review`/`data-review-badge`/`data-case-kp-name`）、`layout/DragHandle.tsx:99-100`（`data-side`/`data-dragging`） | 定位表应优先复用这些钩子，文本/role 兜底 |

## 4. 可测点与方案设计

### 4.1 四方案矩阵（含本项目阻塞点）

> 证据等级随格标注；`[待验证]` 项的验证方法见第 6 节。「阻塞点」列只写本仓特有的硬障碍，不写泛泛优劣。

| 维度 | Playwright `_electron.launch` | WebdriverIO + `wdio-electron-service` | Selenium + 自建 Electron driver | 自定义 IPC 驱动 |
|---|---|---|---|---|
| 能否连到已运行实例 | `_electron.launch` 只拉起子进程，不支持 attach；变通：`chromium.connectOverCDP('http://127.0.0.1:9224')` 连已开 CDP 端口的实例（LEG-22 已手动轮询 `/json`）`[源码][待验证]` | service 负责 launch/close，attach 非主路径；复用已运行实例需查该 service 版本能力 `[待验证]` | 可连：ChromeDriver 配 `debuggerAddress` 指向 Electron `--remote-debugging-port`；需自行编排端口发现 `[待验证]` | 不能；只能 `spawn` 新实例 `[源码]`（官方基线同此说法） |
| 进程树（主进程 + Python sidecar） | `ElectronApp` 持有主进程；sidecar 是主进程 spawn 的孙进程，不直接持有；可经 `electronApp.evaluate` 在主进程内枚举子进程句柄 `[待验证]` | service 持有 Electron 进程；sidecar 同属不可见孙进程 `[源码]` | driver 只管浏览器/CDP 层；主进程与 sidecar 进程树都需自建枚举 `[源码]` | `ChildProcess` 句柄持有主进程；sidecar 仍为孙进程，不可直接持有 `[源码]` |
| 端口（8788 与 dev server） | driver 不占 WebDriver 端口；renderer dev server 5173（`ELECTRON_RENDERER_URL`）；sidecar 8788；内部 CDP 端口由 Playwright 管理 `[源码]` | service 内部 WebDriver 端口（默认区间需查文档）；5173/8788 同本仓约定 `[待验证]` | ChromeDriver 9515（官方基线）；Electron 另开 `--remote-debugging-port`（LEG-22 用 9224）；8788 不变 `[源码]` | 无 WebDriver 端口；8788 由主进程拉起；可用文件/HTTP 做就绪信号 `[源码]` |
| 环境变量注入 | `launch({ env })` 全量覆盖/继承，最直接；`LEARNING_AGENT_HOME` 等必须在 spawn 前写入 `[源码]`（LEG-18 同款写法 `drive-electron.mjs:19`） | env 注入能力取决于 `wdio-electron-service` 版本；`appArgs` 只能传 CLI 参数，环境变量通道需实测 `[待验证]` | 需自行 spawn Electron 并带 env；ChromeDriver 启动 binary 时透传 env 的能力有限，多数情况要预设父进程环境 `[待验证]` | `spawn(path, args, { env })` 全量注入，最直接 `[源码]`（官方基线示例） |
| 能否启动打包产物 exe | 可以：`executablePath` 指 `release/win-unpacked/营小商.exe`；官方示例传主进程入口，exe 模式等价 `[待验证]` | 可以：`wdio:electronServiceOptions.appBinaryPath` 指 exe（官方基线示例）`[待验证]` | 可以：`goog:chromeOptions.binary` 指 exe（官方基线示例）`[源码]` | 可以：`spawn(exePath, args, { stdio, env })` `[源码]` |
| 事件流捕获（`learning:chat-event` 增量） | Page 内经 preload `onChatEvent` 包一层订阅（`preload/index.ts:20-24`）；或 `electronApp.evaluate` 挂主进程 `onEvent`；可保存增量序列做断言 `[源码][待验证]` | `browser.electron.execute` 触达主进程；渲染层事件订阅需经 WebDriver 协议桥接，官方示例未演示 `[待验证]` | 仅 renderer JS 执行：可在页面内挂 `onChatEvent` 收集；主进程侧无法直接订阅 `[源码]` | 主进程钩子内把 `onEvent` 转发 `process.send`，增量捕获最可控；前提是应用侧加钩子 `[源码][待验证]` |
| 截图 | 原生 `page.screenshot()`（LEG-18 已用）`[源码]` | WDIO 原生 screenshot 命令 `[源码]`（官方生态） | WebDriver 原生截图 `[源码]` | 无内建；需主进程钩子调 `capturePage()` 或另接 CDP `[源码]` |
| DOM 定位能力 | Playwright locator（getByText/getByRole/getByPlaceholder/CSS 属性），可优先复用现有 `data-*` 钩子，四方案中最强 `[源码]` | WebDriver selector + WDIO matchers；可用 `data-*` CSS 选择器；能力中上 `[源码]` | Selenium `By`（CSS/文本/role）；能力中上，等待 API 偏弱 `[源码]` | 无 DOM 能力；只能断言 IPC 返回/DB/文件，UI 覆盖弱 `[源码]` |
| Windows 平台支持 | 支持；LEG-18/22 均在 Windows 实操 `[源码]` | 支持；Electron 桌面测试官方目标平台之一 `[源码]` | 支持；需 Windows 版 electron-chromedriver `[源码]` | 支持；Node IPC 在 Windows 的稳定性需实测 `[待验证]` |
| 依赖体积与维护成本 | 仓库已装 `playwright@1.64.1`；缺 `@playwright/test`（可补 devDep，或先用 `playwright` 自带能力 + 自写 runner）；Electron 模式复用应用 Electron 运行时，不强制另下浏览器二进制 `[源码][待验证]` | 新增 WDIO runner、service、reporter 一整套依赖；版本跟随 WDIO 生态节奏 `[源码]` | 新增 `selenium-webdriver` + `electron-chromedriver`；ChromeDriver 与 Electron Chromium 版本需手工对齐 `[源码]` | 零第三方框架依赖；成本在应用侧钩子维护与自建断言封装 `[源码]` |
| **本项目阻塞点** | ① Electron 44.9.0 × Playwright 1.64 CDP 兼容未实测；② 无 `data-testid`，定位需复用现有 `data-*` 钩子 + 文本/role 兜底；③ `@playwright/test` 未安装；④ 应用把 `playwright`/`playwright-core` 标 external（`electron.vite.config.ts:32`），需确认打包后不会误 require 测试包 | ① `wdio-electron-service` 对 Electron 44 的版本契合未实测（社区对新 Electron 跟进节奏是主要风险）；② 整套 WDIO 工具链为新增；③ env 注入与主进程事件订阅能力需查该 service 版本文档；④ 无 `data-testid`，同受定位约束 | ① 需自建并维护 electron-chromedriver 与 Electron 44 Chromium 版本对齐；② 无主进程 evaluate 一等能力，服务装配/sidecar 状态难直接断言；③ 进程编排、健康等待、收尾清理全自建；④ 无 `data-testid`，同受定位约束 | ① **必须改主进程源码**加 `APP_TEST_DRIVER` 消息钩子（当前 0 命中），需主代理批准；② 无 DOM/截图，必须另配浏览器层才有 UI 覆盖；③ Windows Node IPC 行为未实测；④ 配套浏览器层同样受定位标识约束 |

### 4.2 本项目特有约束对方案的影响

#### 4.2.1 asar 打包后的路径与读写边界

- 打包后 `app.getAppPath()` 指向 `app.asar` 内目录（`index.ts:48-55,75,94,143,157` 多处基于它拼路径）；asar 内代码与 `templates/` 只读，**测试不得向 asar 内路径写文件**。`[源码]`
- 可写位置只有两处：`LEARNING_AGENT_HOME`（DB、window-state、artifacts、exports，`window-state.ts:24-26`）与 `app.getPath('userData')`（settings.json，`index.ts:58`）。fixture 造数、截图外的落盘、DB 快照都必须落在这两个根之下。
- 种子库在 asar 外侧：`resources/seed/learning.db`，首启由主进程复制到 home（`index.ts:71-81`）；打包产物测试断言首启复制时，观测点是 home 下 `data/learning.db` 出现，而不是 asar 内文件。
- dev/out 模式下 `app.getAppPath()`、`process.resourcesPath`、`__dirname` 与打包模式各不相同（spec 第 6 节坑 7）；同一条断言在三种启动路径下要分别核对路径解析。

#### 4.2.2 渲染层定位标识现状

- 全目录 grep `data-testid`/`test-id`/`data-test` 0 命中 `[源码]`；但存在一批面向实现的结构性 `data-*` 钩子，可直接作为 locator 锚点：

| 钩子 | 位置 | 可定位对象 |
|---|---|---|
| `data-message-role="user\|assistant"` | `App.tsx:1136,1481,1493` | 消息气泡 |
| `data-action="stop"` | `App.tsx:1220` | 停止按钮 |
| `data-streaming="true"` | `App.tsx:1493` | 流式进行中的气泡 |
| `data-notice="startup"` | `App.tsx:1516` | 启动/错误提示条 |
| `data-tab-id` | `workspace.tsx:393` | 工作区标签页 |
| `data-source-kind="textbook"\|"resource"` | `workspace.tsx:201,236` | 教材/资源原文视图 |
| `data-submitted` | `renderers.tsx:130` | 题目集提交态 |
| `data-match-review` / `data-review-badge` | `renderers.tsx:465,472` | 新闻匹配复核态 |
| `data-case-kp-name` | `renderers.tsx:606` | 案例知识点条目 |
| `data-side` / `data-dragging` | `layout/DragHandle.tsx:99-100` | 分栏拖拽手柄 |

- 影响排序：Playwright 的链式 locator 与这些 CSS 属性选择器结合最顺；WDIO/Selenium 次之；自定义 IPC 完全绕开 DOM，不受定位标识影响但也覆盖不了 UI。
- 既有脚本的教训（LEG-18/19/21/23）：`body.innerText().includes(...)` 与 `textarea, input[type="text"]` 首元素在文案微调、多输入框场景下易碎；新 harness 定位表应优先上表 `data-*` 钩子，其次 role + 可见文本 + 占位符；补 `data-testid` 属渲染层实现改动，需主代理批准（缺口 G7）。

#### 4.2.3 sidecar 取证盲区

- sidecar 由主进程 `spawn`，`stdio: ['ignore','pipe','pipe']`，stdout/stderr 被转发成主进程 `console.info/console.warn`（`news-backend.ts:146-156`）；外部 driver 既没有 sidecar `ChildProcess` 句柄，也拿不到它的独立日志文件。`[源码]`
- 可用取证路径按优先级：
  1. **主进程 console 捕获**：Playwright `electronApp.on('console')` / Page console 事件；WDIO/Selenium 读浏览器 console 与主进程 stdout；过滤 `[news]` 前缀行（`news-backend.ts:151,155`）。
  2. **HTTP 健康探测**：轮询 `http://127.0.0.1:8788/health`（`news-backend.ts:19-29`），读 `ok` 与 `db_path`；`db_path` 与被测 home 不一致时主进程会 `console.warn` 端口串库（`:103-106`）。
  3. **共享 SQLite**：直接读 `$LEARNING_AGENT_HOME/data/learning.db` 的新闻表与匹配表（复用 LEG-26 只读快照思路）。
  4. **进程树枚举**：必要时在主进程 evaluate 内枚举子进程；sidecar 退出码非 0 仅 `console.warn`（`:157-160`），无重启逻辑，崩溃恢复断言见缺口 G4。
- 若需 sidecar 独立日志文件，要改其启动参数/重定向策略，属实现改动，待主代理批准。

#### 4.2.4 依赖现状对选型的约束

- 根 `devDependencies` 有 `playwright@^1.55.0`（实测 1.64.1），`@playwright/test` **未安装**；`apps/desktop` 的 devDependencies 不含测试框架。`[源码]`
- `electron.vite.config.ts:32` 把 `playwright`/`playwright-core` 标 external，注释说明是应用内懒加载、缺浏览器时优雅降级预留；当前 `apps/desktop/src` 内 grep 不到 `playwright` import（0 命中），即该预留尚未落地。测试 harness 应使用仓库 devDependency 的 playwright，**不要**复用打包进 asar 的任何副本。
- 根 `package.json` 无 `test:*` 脚本（见 LEG-24/25 失效事实）；新 runner 的启动命令需新增到根 scripts 或 harness 自带入口。

### 4.3 Launch 配置草案

> 以下代码为骨架草案；凡未在本仓实跑过的点逐条标 `[待验证]`。草案默认**离线隔离**：`NEWS_CRAWLER_AUTOSTART=0`、不注入真实 `DEEPSEEK_API_KEY`；需要对话流的用例再按 fixture 分层开启。路径以仓库根为基准。

#### 4.3.1 Playwright `_electron.launch`（主体方案）

```js
// tools/automated-testing/harness/launch.desktop.mjs（草案，未落地）
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '../..') // 按 harness 实际位置调整 [待验证]

// 三种 executablePath 取法，按目标模式二选一：
const ELECTRON_PATHS = {
  // ① dev/out：仓库内 Electron 运行时，跑 out/ 已构建产物
  dev: join(repoRoot, 'apps/desktop/node_modules/electron/dist/electron.exe'),
  // ② 与①同一二进制，显式把主进程入口作为第一个 arg（官方基线示例写法）
  outMain: join(repoRoot, 'apps/desktop/out/main/index.js'),
  // ③ 打包产物：win-unpacked 里的 exe
  packaged: join(repoRoot, 'release/win-unpacked/营小商.exe'),
}

export async function launchDesktop({ mode = 'dev', home } = {}) {
  // 隔离数据目录：每个用例/会话一个临时 home，绝不回退 ~/.learning-agent
  const appHome = home ?? mkdtempSync(join(tmpdir(), 'yx-harness-'))

  const env = {
    ...process.env,
    // 必须在 launch 时注入；主进程启动后不再二次读取
    LEARNING_AGENT_HOME: appHome,
    // 默认不拉起 Python sidecar；EXT 面用例再放开
    NEWS_CRAWLER_AUTOSTART: '0',
    // 隔离端口，避免与本机旧实例抢 8788
    NEWS_CRAWLER_PORT: process.env.NEWS_CRAWLER_PORT ?? '8791',
    // 离线/无 key 场景不继承真实凭证；需要真模型的冒烟用例显式传入
    DEEPSEEK_API_KEY: '',
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    // 仅当先手动起了 electron-vite dev（renderer 5173）时才设置；
    // 不设则主进程走 loadFile(out/renderer/index.html)（index.ts:154-157）
    // ELECTRON_RENDERER_URL: 'http://127.0.0.1:5173/',
  }

  const base = {
    cwd: join(repoRoot, 'apps/desktop'),
    env,
    timeout: 60_000, // 首启装配 + 窗口创建上限 [待验证：冷启动实测耗时]
    // 接管主进程 stdout/stderr 落盘，替代 LEG-22 的 stdio:'ignore'
    // Playwright ElectronApp 的输出捕获接口以实际版本 API 为准 [待验证]
  }

  const app = await electron.launch(
    mode === 'packaged'
      ? { ...base, executablePath: ELECTRON_PATHS.packaged, args: [] }
      : {
          ...base,
          executablePath: ELECTRON_PATHS.dev,
          // ② outMain 作为 arg；args: ['.'] 为 LEG-18 历史写法，两种取法等价性待验证
          args: [ELECTRON_PATHS.outMain],
        },
  )

  // 等待策略：先取首个窗口，再等 IPC health 就绪，不做固定 sleep
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')

  // 等信号①：preload 暴露的 learning:health IPC resolve（index.ts:529-536）
  const health = await window.evaluate(async () => {
    return await window.learning.health()
  })
  // 等信号②（兜底）：关键 DOM 出现；定位表见 04-renderer-ui-flows.md
  // await window.locator('textarea, input[type="text"]').waitFor({ state: 'visible', timeout: 30_000 })

  return { app, window, appHome, health }
}

// 收尾：先关应用，再清理临时 home（Windows 上 SQLite 句柄可能延迟释放，rmSync force + retry）
export async function closeDesktop({ app, appHome }) {
  await app.close()
  rmSync(appHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
```

草案中 `[待验证]` 清单：

- `electron.launch` 在 Electron 44.9.0 / Playwright 1.64.1 下能否正常拉起并 `firstWindow()`（兼容性基线实验，对应 U5）。
- `args: [out/main/index.js]` 与 `args: ['.']` 两种入口解析在 out 产物下是否等价；`cwd` 对 `loadFile` 相对路径的影响。
- packaged 模式 `executablePath` 指 `营小商.exe` 后，Playwright 能否拿到主进程 evaluate 与窗口列表。
- `ElectronApp` stdout/stderr 捕获的具体 API 名称与落盘方式。
- `window.learning.health()` 在 Page `evaluate` 内是否按 Promise 正确返回（preload 为 `ipcRenderer.invoke` 封装，`preload/index.ts:18`）。
- 隔离 home 下首启种子库复制是否发生（无种子库时 `learning:health` 报空库警告，对接 LEG-13 规则）。

#### 4.3.2 自定义 IPC 驱动（对照草案，需应用侧改码）

> 官方基线：`child_process.spawn(electronPath, args, { stdio: ['inherit','inherit','inherit','ipc'], env })`，应用侧 `process.on('message')` + `process.send` 回包。本仓当前**没有**这对钩子，下列应用侧代码属待批准的新增。

```js
// 测试侧（草案）：spawn 主进程，按 msgId 做简单 RPC
import { spawn } from 'node:child_process'

export function spawnApp({ electronPath, args, env, cwd }) {
  const child = spawn(electronPath, args, {
    cwd,
    env: { ...env, APP_TEST_DRIVER: '1' }, // 应用侧据此开启消息钩子
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  })
  const pending = new Map()
  child.on('message', (msg) => {
    const call = pending.get(msg.msgId)
    if (!call) return
    pending.delete(msg.msgId)
    msg.reject ? call.reject(msg.reject) : call.resolve(msg.resolve)
  })
  return {
    rpc(cmd, ...args) {
      const msgId = pending.size
      return new Promise((resolve, reject) => {
        pending.set(msgId, { resolve, reject })
        child.send({ msgId, cmd, args })
      })
    },
    stop() { child.kill() },
  }
}
```

```ts
// 应用侧（待新增，[待验证] 且需主代理批准）：main/index.ts 末尾按开关挂载
// if (process.env.APP_TEST_DRIVER) {
//   process.on('message', async ({ msgId, cmd, args }) => {
//     try {
//       const METHODS = {
//         isReady: () => Boolean(window),
//         health: () => startupHealth(...), // 复用 index.ts:529 同源逻辑
//         // 转发 onEvent 序列：把 chat-event 增量 process.send 给测试侧
//       }
//       const resolve = await (METHODS[cmd] ?? (() => new Error('Invalid method')))(...args)
//       process.send({ msgId, resolve })
//     } catch (error) {
//       process.send({ msgId, reject: { message: error.message, stack: error.stack } })
//     }
//   })
// }
```

对照结论：该方案进程内 RPC 最轻、不依赖 CDP/WebDriver，但 UI 断言与截图为零，且必须改主进程；建议仅作为 Playwright 方案之外的**主进程状态/钩子补充通道**，不单独承担 GUI 覆盖。

### 4.4 Fixture / 等待 / 截图 / 日志约定

#### 4.4.1 Fixture 与隔离

- **数据目录**：每个测试会话 `mkdtempSync` 一个 `LEARNING_AGENT_HOME`；禁止回退 `~/.learning-agent`（对照 LEG-18/23 的默认回退风险，风险第 7 条）。需要种子数据时，从现存 `release/win-unpacked/resources/seed/learning.db` 或录制示例库复制 `data/learning.db`，复制前记录源路径与 `user_version`。
- **外部依赖**：默认 `NEWS_CRAWLER_AUTOSTART=0`，不拉起 sidecar；EXT 面用例单独放开并指定隔离端口；真 LLM 用例单独标记，默认注入抛错/脚本化假 LLM（缺口 G11）。
- **造数与清理**：写操作成对造数/清理；共享 fixture 标只读；Windows 下 SQLite 句柄未释放时目录删除 `force + maxRetries`（沿用 LEG-08/11 写法）。
- **凭证**：不在 harness 代码内写死 key；离线用例显式置空 `DEEPSEEK_API_KEY`。

#### 4.4.2 等待策略（等信号，禁止固定 sleep 主策略）

| 优先级 | 信号类型 | 本仓观测点 | 适用场景 |
|---|---|---|---|
| 1 | IPC resolve | `window.learning.health()`、`learning:invoke`/`learning:chat`/`answerSet` 返回、`onChatEvent` 收到目标事件类型 | 装配完成、一轮对话收口、交卷返回 |
| 2 | DOM 出现/消失 | 定位表内的控件可见/隐藏；文本作为末级兜底 | 面板打开、标签页切换、错误文案上屏 |
| 3 | 端口 health | `http://127.0.0.1:<port>/health` 轮询（sidecar 8788 / web 3081 思路见 LEG-23） | 外部服务就绪 |
| 4 | 文件 mtime / 存在性 | home 下 `data/learning.db`、`window-state.json`、产物文件出现 | 首启复制、落盘产物、窗口状态持久化 |
| 5 | 日志行 | 主进程 stdout/stderr 出现目标前缀（如 `[news]`）或错误行 | sidecar 就绪/退出、未捕获异常 |

- `waitForTimeout(固定秒)` 只允许作为信号未就绪时的兜底间隔，不得作为主等待条件；既有 LEG-18/21/23 的 1s 文本轮询模式不沿用。
- 每类等待必须写清超时上限与失败动作（抓证据见 4.4.4）。

#### 4.4.3 截图命名与存放

- 目录：`tools/automated-testing/artifacts/<suite>/<case-id>/`（目录新建属 harness 产物区，不在本次两个文档文件范围内）。
- 文件名：`<step>-<YYYYMMDD-HHMMSS>.png`，如 `health-20261118-211406.png`；失败截图追加 `-failed`。
- 约定：关键步骤各存一张（首屏、操作后、失败现场）；失败现场默认 `fullPage`；截图只作证据，不作唯一断言（原则见 spec 第 7 节）。
- 既有 `.scratch/*.png`（LEG-32）无元数据绑定，不纳入新命名体系。

#### 4.4.4 失败时必抓证据

1. **IPC payload**：本轮 `learning:chat`/`invoke` 入参、`learning:chat-event` 增量序列（事件类型/工具名/文本片段/requestId）、错误返回与 `friendlyError` 文案。
2. **DB 快照**：复用 LEG-26 思路只读导出相关表计数与目标行（会话、消息、attempts、artifacts、evidence、news）。
3. **日志片段**：主进程 stdout/stderr 尾部 200 行、`[news]` 前缀行、console error / pageerror 列表（LEG-19 的收集模式）。
4. **sidecar 状态**：`/health` 返回体、监听端口、共享 DB 路径是否与 home 一致。
5. **进程与窗口**：Electron 主进程退出码、窗口 URL/title、窗口数量；必要时进程树枚举。
6. **DOM 摘录**：`body.innerText()` 前 800 字、失败控件的 role/文本/可见性。

## 5. 风险与坑

1. **Electron 44 × 驱动版本兼容未实测**：本仓 Electron 44.9.0 很新；Playwright 1.64、wdio-electron-service、electron-chromedriver 三者对该版本的兼容矩阵本次均无运行证据。最小基线实验（`launch` + `firstWindow()` + 一次 `health` IPC）必须先于用例编写完成，否则方案选型结论可能被兼容性推翻 `[待验证]`。
2. **定位标识不足导致选择器脆弱**：本仓无 `data-testid`，现有 `data-*` 钩子覆盖消息流、停止按钮、标签页、分栏、提交态等关键控件，但侧栏入口、浮层菜单、产物卡片等仍只能靠文本/role；界面文本来自 React 渲染，空格/换行/样式分隔都可能影响 `getByText` 命中。定位表必须先于用例固化，避免把文案当选择器到处散落。
3. **端口与单实例冲突**：8788 可能被旧实例占用（spec 第 6 节坑 3）；dev server 5173、CDP 9224/9515 也要隔离。主进程未注册单例锁（grep `requestSingleInstanceLock` 0 命中），重复启动行为本身是待测缺口（G3），harness 必须保证上一实例已退出再拉起新实例。
4. **env 注入时机**：`LEARNING_AGENT_HOME`、sidecar 端口/开关、模型凭证都在主进程启动时读取（`index.ts:68,104`、`news-backend.ts`、`settings.ts:50-61`）；应用启动后再改环境变量不生效。launch 配置必须一次性给全，漏注入会静默回退到 `~/.learning-agent` 默认值。
5. **sidecar 假就绪**：`waitHealthy` 只有 8s 上限（`news-backend.ts:162`），超时后主进程仍继续启动并返回 URL；harness 不能把「主进程窗口出现」等同于「sidecar 健康」，必须单独轮询 `/health`。
6. **打包产物路径与资源分叉**：asar 内只读、种子库/prompts 在 asar 外侧 extraResources；`apps/desktop/seed/` 不在仓库，重新打包可能产出无种子库安装包（spec 坑 1、缺口 G9）。packaged 模式断言要区分「asar 内代码」与「resources 外侧资源」两类观测点。
7. **低确定性内容误入断言**：LLM 生成文案、新闻匹配结果不可重复；harness 对低确定性场景只断言结构（字段存在、引用可解析、长度、状态流转），不断言具体文案（原则见 spec 第 7 节）。
8. **历史脚本路径漂移**：LEG-18 可作 launch 参数参考，但其 questions 硬编码、文本轮询与 home 回退写法不能照搬；WDIO/Selenium/IPC 在本仓无任何可跑遗产，草案不假设既有配置可复用。

## 6. 未覆盖与待验证

| 序号 | 未覆盖/未验证项 | 验证方法 |
|---|---|---|
| 1 | Playwright 1.64.1 拉起 Electron 44.9.0 dev/out 产物：`firstWindow()`、主进程 `evaluate`、Page 事件订阅是否全部可用 | 主代理批准后跑最小草案（4.3.1）：launch → `firstWindow()` → `health()` → 截图 → close；记录报错与耗时 |
| 2 | packaged 模式：`executablePath` 指 `release/win-unpacked/营小商.exe` 时 Playwright/WDIO/Selenium 各自能否取得窗口与主进程 evaluate | 三方案分别用现存 win-unpacked 产物做启动对照；先 `AUTOSTART=0`，隔离 home |
| 3 | `wdio-electron-service` 当前版本对 Electron 44 的支持矩阵、env 注入 API、主进程事件订阅方式 | 查该 service 官方文档与 release 说明；必要时装到独立 harness 目录做最小 spike（依赖新增需主代理批准） |
| 4 | electron-chromedriver 与 Electron 44 内置 Chromium 的版本对应关系，Windows 二进制获取方式 | 核对 Electron 44.9.0 的 Chromium 版本号，对照 ChromeDriver 发行说明；未对齐前 Selenium 方案不落地 |
| 5 | 自定义 IPC 钩子在 Windows 上 `stdio: ['inherit','inherit','inherit','ipc']` 的消息收发稳定性，以及 `process.send` 在 ESM 主进程下可用 | 应用侧加最小 `isReady` 钩子后做 spike；属实现改动，先取得批准 |
| 6 | `@playwright/test` 是否补为 devDep（测试 runner、fixture、报告器开箱即用），还是先用 `playwright` + 自写 runner | 对比两者依赖体积与现有 LEG-18 写法；决策记入 harness 落地文档 |
| 7 | 应用构建 external 的 `playwright` 在打包后是否被任何运行路径懒加载 require（当前 src grep 0 命中，预留未落地） | 打包后检查 asar 内是否出现 playwright 引用；运行离线机器观察降级路径 |
| 8 | 渲染层可固化的 role/文本定位表（无 `data-testid` 前提下） | 通读 `04-renderer-ui-flows.md` 对应源码，逐控件记录 selector；未完成前 UI 用例不写死文本断言 |

## 7. 交叉引用

- 既有资产与缺口清单：`09-existing-verification-and-gaps.md#45-覆盖矩阵`（LEG-01～LEG-33、G1～G12）
- 启动生命周期、单例与退出行为：`02-main-runtime-and-boot.md#21-启动时序谁在什么时候调谁`（BOOT/WIN）
- preload 面、通道与方法契约：`03-ipc-and-preload-contract.md#41-preload-暴露面playwright-pageevaluate-可达到什么`（IPC/CH/EVT）
- 页面、标签页与定位现状：`04-renderer-ui-flows.md#41-定位属性实测清单grep-全渲染层截至-2026-11-18`（UI/FLOW）
- 打包、asar、extraResources 与首启自举：`05-build-package-and-first-run.md#26-asar-内外与测试取证差异`（PKG）
- sidecar 拉起、8788 健康检查与离线降级：`06-news-sidecar-and-network.md#21-进程拓扑`（EXT）
- 领域服务确定性分级与 mock 边界：`07-domain-services-and-determinism.md#22-依赖面与确定性总表`（SVC）
- 隔离 home、种子库与造数清理：`08-data-fixtures-and-isolation.md#5-最小隔离运行组合powershell可直接照抄`（DATA）
- 场景目录与用例编号：`11-scenario-catalog.md`（TC-P0/TC-P1，文档尚未成稿）
- 官方四路径原始示例：`../electron-automated-testing.md`
