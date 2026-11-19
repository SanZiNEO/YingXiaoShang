# 02 · 主进程生命周期、服务装配与窗口状态

> 归属：Electron 主进程（`apps/desktop/src/main/`）｜ 状态：已完成 ｜ 核对日期：2026-11-18
> 覆盖：`apps/desktop/src/main/index.ts`、`window-state.ts`、`health.ts`、`settings.ts`、`env.ts`、`news-backend.ts`、`turn-canceller.ts`；DB 打开/迁移侧涉及 `packages/db/src/index.ts`
> 不覆盖：IPC 方法逐个字段与 preload 暴露面（见 `03-ipc-and-preload-contract.md`）；Python 采集服务内部契约（见 `06-news-sidecar-and-network.md`）；领域服务输入输出与确定性（见 `07-domain-services-and-determinism.md`）；数据目录隔离与造数清理（见 `08-data-fixtures-and-isolation.md`）
> 行号截至 2026-11-18；主进程入口 `src/main/index.ts` 实测 555 行（`Get-Content` 计数；Read 编号至 556，末行无尾换行），preload `src/preload/index.ts` 实测 44 行。

## 1. 结论摘要（TL;DR）

1. 主进程所有装配都挂在 `app.whenReady()` 回调内；`whenReady` 之前只有模块级变量声明，没有任何 Electron API 副作用 `[源码]`。
2. `initServices()` 的真实顺序是：读 `.env` → 拼提示词根 → settings 旧配置迁移 → 构造 `SettingsStore`/`DeepSeekLlm` → 解析数据目录 → 种子库复制 → 注册 llm 到 Context → **打开 DB 并迁移** → 拉起/体检新闻后端 → 逐个构造领域服务；settings 与 llm 先于 DB，新闻后端先于领域服务 `[源码]`。
3. 应用**没有**调用 `requestSingleInstanceLock`，也没有 `second-instance` 处理器；第二实例会作为独立进程启动，源码里不存在「聚焦已有窗口」的分支 `[源码]`（行为未实测，见第 6 节）。
4. 启动失败时窗口尚未创建；`startupFailure()` 把错误分为「本地数据损坏/磁盘满（可备份后重置）」与「权限问题/未知错误（不可重置，直接退出）」两类 `[源码]`。
5. 可重置分支会把 `learning.db` 及 `-wal`/`-shm` 改名为 `.broken-<时间戳>`，然后 `app.relaunch()` + `app.exit(0)`；改名失败则弹错误框并 `exit(1)` `[源码]`。
6. 窗口状态持久化在 `$LEARNING_AGENT_HOME/window-state.json`（缺省 `~/.learning-agent/`），字段为 `{x,y,width,height,maximized}`；读取时做有限数、最小尺寸、显示器重叠三重校验，任一不合法即回退默认尺寸 `[源码]`。
7. `BrowserWindow` 最小尺寸 760×560；状态保存带 300ms 防抖，`resize`/`move`/`maximize`/`unmaximize`/`close` 均会落盘；最大化时额外保留还原后的 normal bounds `[源码]`。
8. 主进程**未注册** `uncaughtException`、`unhandledRejection`、`render-process-gone` 等崩溃处理器；现有「重置」路径只覆盖启动期 `initServices()` 抛错，不覆盖运行期渲染进程/主进程崩溃 `[源码]`。

## 2. 结构与流程

### 2.1 启动时序（谁在什么时候调谁）

```text
Electron 进程启动
  │  模块加载：import 各服务/工具模块；模块级 let window/db/matcher/... 声明（index.ts:29-42）
  │  （无 app.* 调用）
  ▼
app.whenReady() 回调（index.ts:398）
  ├─ Menu.setApplicationMenu(null)                              (index.ts:399)
  ├─ await initServices()                                        (index.ts:401)
  │     ├─ loadDotEnv([cwd, getAppPath/../../, getAppPath])       (index.ts:46-50; env.ts:7)
  │     ├─ 拼 LEARNING_AGENT_PROMPT_ROOTS                        (index.ts:52-55)
  │     ├─ settings 旧配置迁移：userData/settings.json ← appData/@learning-agent/desktop/settings.json
  │     │                                                        (index.ts:58-65)
  │     ├─ settings = new SettingsStore(settingsPath)            (index.ts:66; settings.ts:25)
  │     ├─ llm = new DeepSeekLlm(() => settings.read())          (index.ts:67)
  │     ├─ appHome = resolveAppHome()                            (index.ts:68; window-state.ts:24-26)
  │     ├─ 种子库自举：appHome/data/learning.db 不存在时，从
  │     │   resourcesPath/seed/learning.db 或 getAppPath/seed/learning.db 复制 (index.ts:71-81)
  │     ├─ ctx = new Context(); ctx.provide('llm', llm)           (index.ts:82-83)
  │     ├─ await ctx.plugin(LearningDb, { appHome }) → 打开 DB、PRAGMA、application_id、migrate()
  │     │                                                        (index.ts:84; packages/db/src/index.ts:831-836)
  │     ├─ newsBaseUrl = await startNewsBackend({ appPath, appHome })
  │     │                                                        (index.ts:86; news-backend.ts:92)
  │     └─ 构造 Matcher / QuestionSmith / ResearchService / BpService /
  │         ProfileService / ArtifactService / NewsService / AgentService
  │                                                              (index.ts:87-100)
  │
  ├─ 失败分支（initServices 抛错，index.ts:402-442）
  │     ├─ failure = startupFailure(error)                       (index.ts:404; health.ts:49)
  │     ├─ canResetLocalData=false → showErrorBox → app.exit(1)  (index.ts:407-410)
  │     ├─ canResetLocalData=true  → showMessageBoxSync 二选一   (index.ts:412-420)
  │     │     ├─ 选「退出」→ app.exit(1)                          (index.ts:421-424)
  │     │     └─ 选「备份旧数据并重置」→ 改名 db/-wal/-shm 为 .broken-<stamp>
  │     │           （改名失败 → showErrorBox → exit(1)）        (index.ts:426-439)
  │     │         → app.relaunch(); app.exit(0)                  (index.ts:440-441)
  │
  ├─ 成功后注册 IPC 处理器（index.ts:445-538；通道清单见 03 文档）
  │     ├─ turnCanceller = new TurnCanceller()                    (index.ts:447; turn-canceller.ts:11)
  │     └─ 8 个 ipcMain.handle：invoke / cancel / chat / answer /
  │         answer-set / health / settings:get / settings:set
  ├─ createWindow()                                              (index.ts:540)
  ├─ startNewsAutomation()                                       (index.ts:541; index.ts:103)
  └─ app.on('activate', …) 无窗口时 createWindow()              (index.ts:542-544)

进程生命周期事件（模块级注册，不依赖 whenReady）
  ├─ before-quit：clearInterval(newsTimer) / clearTimeout(newsStartupTimer) / stopNewsBackend()
  │                                                              (index.ts:547-551)
  └─ window-all-closed：process.platform !== 'darwin' → app.quit() (index.ts:553-555)
```

### 2.2 `initServices()` 装配顺序表（实测顺序，非推断）

| 序号 | 步骤 | 代码位置 | 说明 |
|---|---|---|---|
| 1 | 读 `.env` 补进 `process.env`（已有变量优先） | `index.ts:46-50`、`env.ts:7-29` | 依次搜 `process.cwd()`、`getAppPath/../../`、`getAppPath` 下的 `.env` |
| 2 | 拼 `LEARNING_AGENT_PROMPT_ROOTS` | `index.ts:52-55` | `resourcesPath/prompts` 与 `getAppPath/../../packages/agent` 以 `;` 拼接 |
| 3 | settings 旧配置一次性迁移 | `index.ts:58-65` | 新位置 `userData/settings.json`；旧位置 `appData/@learning-agent/desktop/settings.json`，仅在新文件不存在时复制 |
| 4 | 构造 `SettingsStore`、`DeepSeekLlm` | `index.ts:66-67`、`settings.ts:25` | llm 每次读取实时取 `settings.read()` |
| 5 | 解析 `appHome` | `index.ts:68`、`window-state.ts:24-26` | `LEARNING_AGENT_HOME` 优先，否则 `~/.learning-agent` |
| 6 | 种子库自举复制 | `index.ts:71-81` | 目标 `appHome/data/learning.db` 不存在时才找种子候选复制 |
| 7 | Context 注册 llm | `index.ts:82-83` | `ctx.provide('llm', llm)` |
| 8 | 打开 DB + 迁移 | `index.ts:84`、`packages/db/src/index.ts:819-837` | 建空文件 → `DatabaseSync` → `foreign_keys`/`journal_mode=WAL`/`busy_timeout` → `application_id` 校验 → `migrate()`（`SCHEMA_VERSION = 7`） |
| 9 | 新闻后端体检/拉起 | `index.ts:86`、`news-backend.ts:92-168` | `NEWS_CRAWLER_URL` 或 `NEWS_CRAWLER_AUTOSTART=0` 时只体检；否则找服务目录与可执行文件后 spawn，8 秒等健康 |
| 10 | 构造领域服务 | `index.ts:87-100` | 顺序：Matcher → QuestionSmith → ResearchService → BpService → ProfileService → ArtifactService（templatesDir=`getAppPath/templates`）→ NewsService → AgentService |

### 2.3 窗口创建与状态恢复流程

```text
createWindow() (index.ts:129)
  ├─ saved = readWindowState()                       (index.ts:131; window-state.ts:58)
  │     ├─ 读 $appHome/window-state.json
  │     ├─ JSON 解析失败/字段非有限数 → undefined
  │     ├─ 宽高 clamp 到 ≥760×560
  │     └─ 矩形与任一显示器 workArea 不重叠 → undefined（防止窗口开到屏外）
  ├─ bounds = saved ?? defaultBounds()              (index.ts:132; window-state.ts:29-39)
  │     默认：主显示器工作区 90%，上限 1600×1000，居中
  ├─ new BrowserWindow({ x,y,width,height, minWidth:760, minHeight:560,
  │     title:'营小商', backgroundColor:'#f7f7f5',
  │     webPreferences:{ preload: getAppPath/out/preload/index.mjs,
  │                       contextIsolation:true, nodeIntegration:false, sandbox:false } })
  │                                                  (index.ts:133-148)
  ├─ trackWindowState(window)                         (index.ts:149; window-state.ts:98)
  ├─ saved?.maximized → window.maximize()             (index.ts:150)
  ├─ window.on('closed') → window = undefined        (index.ts:151-153)
  └─ 加载渲染层：
        ELECTRON_RENDERER_URL 存在 → loadURL(url)
        否则 → loadFile(getAppPath/out/renderer/index.html)
                                                    (index.ts:154-158)
```

## 3. 关键代码位置

| 职责 | 文件:行 | 说明 |
|---|---|---|
| whenReady 入口 | `apps/desktop/src/main/index.ts:398` | 回调内先建菜单、再 `initServices()`、再注册 IPC 与窗口 |
| 装配主流程 `initServices()` | `apps/desktop/src/main/index.ts:44` | 函数体 `44-101`，顺序见 2.2 表 |
| 提示词根拼接 | `apps/desktop/src/main/index.ts:52` | 两个候选根以 `;` 写入 `LEARNING_AGENT_PROMPT_ROOTS` |
| settings 旧配置迁移 | `apps/desktop/src/main/index.ts:58` | `userData` 与 `appData/@learning-agent/desktop` 两处路径 |
| 种子库自举 | `apps/desktop/src/main/index.ts:71` | 两个种子候选：`resourcesPath/seed`、`getAppPath/seed` |
| DB 插件挂载 | `apps/desktop/src/main/index.ts:84` | `ctx.plugin(LearningDb, { appHome })` |
| 新闻后端拉起 | `apps/desktop/src/main/index.ts:86` | `startNewsBackend({ appPath: app.getAppPath(), appHome })` |
| 启动失败分类 | `apps/desktop/src/main/health.ts:49` | `startupFailure()`，正则匹配损坏/磁盘满/权限/未知 |
| 空库自检 | `apps/desktop/src/main/health.ts:23` | `startupHealth()`：章节 0 / 知识点 0 告警，新闻 0 仅提示 |
| 失败重置改名 | `apps/desktop/src/main/index.ts:426` | `learning.db`、`-wal`、`-shm` 改名 `.broken-<ISO 时间戳>` |
| 重启生效 | `apps/desktop/src/main/index.ts:440` | `app.relaunch()` 后 `app.exit(0)` |
| IPC 注册总入口 | `apps/desktop/src/main/index.ts:445` | `learning:invoke` 起，处理器明细归 03 文档 |
| TurnCanceller 挂载 | `apps/desktop/src/main/index.ts:447` | 主进程侧构造；`cancel` 处理器 `448-451`；`chat` 接线 `466/485/491` |
| 窗口创建 `createWindow()` | `apps/desktop/src/main/index.ts:129` | 函数体 `129-159` |
| 最小尺寸常量 | `apps/desktop/src/main/window-state.ts:7` | `MIN_WINDOW_WIDTH=760`、`MIN_WINDOW_HEIGHT=560` |
| 状态文件路径 | `apps/desktop/src/main/window-state.ts:60` | 读 `resolveAppHome()/window-state.json`；写路径 `86` |
| 状态读取校验 | `apps/desktop/src/main/window-state.ts:58` | 有限数、最小尺寸、显示器重叠校验 |
| 状态持续追踪 | `apps/desktop/src/main/window-state.ts:98` | `trackWindowState()`，300ms 防抖，五类事件落盘 |
| 退出清理 | `apps/desktop/src/main/index.ts:547` | `before-quit` 清两个定时器并停新闻后端 |
| 跨平台退出 | `apps/desktop/src/main/index.ts:553` | `window-all-closed`：非 darwin 才 `app.quit()` |
| DB 构造与迁移 | `packages/db/src/index.ts:819` | 打开 `831`；PRAGMA `832-834`；`migrate()` `836`；新版本库抛错 `852-854` |
| 数据目录解析 | `apps/desktop/src/main/window-state.ts:24` | `resolveAppHome()`：env 优先，缺省 `~/.learning-agent` |

## 4. 可测点

| ID | 触发方式 | 观测点（DOM/IPC 返回/文件/日志） | 前置条件 |
|---|---|---|---|
| BOOT-01 | 以隔离 `LEARNING_AGENT_HOME` 启动应用，等待主进程 ready | `learning:health` IPC 返回 `appHome` 与章节/知识点/新闻计数；`$appHome/data/learning.db` 落盘 | 禁 `NEWS_CRAWLER_AUTOSTART` 或允许拉起；不指向真实用户目录 |
| BOOT-02 | 注入损坏 DB（`file is not a database`）后启动 | 弹框标题含「本地数据损坏」；选择重置后旧文件改名 `.broken-*`，重启后新库建立 | 需可交互/自动化弹框；DB 侧先备份 |
| BOOT-03 | 注入权限类错误（EACCES）后启动 | `startupFailure()` 判定 `canResetLocalData=false`；弹框不出现「备份旧数据并重置」按钮 | 可直接对 `scripts/verify-startup-failure.ts` 做源码级断言，无需启动 GUI |
| BOOT-04 | 连续启动两个实例（不经过单例锁） | 观察是否出现两个窗口、两个进程；第二实例是否被聚焦/拦截 | 本仓库未实现单例；观测结果用于回填第 6 节待验证项 |
| BOOT-05 | 移动/缩放窗口后关闭，再次启动 | `window-state.json` 存在且字段合法；恢复后位置/尺寸与关闭前一致；最大化状态被记住 | 显示器数量与分辨率固定 |
| BOOT-06 | 把 `window-state.json` 改成屏外坐标或损坏 JSON 后启动 | 窗口回退默认居中尺寸，不出现不可见窗口 | — |
| BOOT-07 | 退出应用（关闭最后窗口） | `before-quit` 后新闻子进程被 kill；`newsTimer`/`newsStartupTimer` 已清除 | 观察子进程是否残留、8788 端口是否释放 |
| BOOT-08 | 启动后等待 60 秒 | 新闻首轮 stale-check 触发；后续按 `LEARNING_AGENT_NEWS_REFRESH_MINUTES`（默认 30 分钟）周期执行 | 不把首轮 60 秒等待误判为卡死 |
| WIN-01 | 新建窗口后读 `BrowserWindow.getMinimumSize()` | 最小宽 760、高 560 | — |
| WIN-02 | 最大化 → 还原 → 关闭 → 重启 | 还原后 normal bounds 被记录；重启不会把最大化矩形当默认尺寸 | — |

## 5. 风险与坑

1. **装配顺序里 settings/llm 先于 DB**：`SettingsStore` 与 `DeepSeekLlm` 在打开 DB 之前构造（`index.ts:66-67`）；若 settings 文件损坏，`SettingsStore` 是忽略坏文件回退环境变量（`settings.ts:37-44`），不会阻断启动，但 `readPublic()` 会带 `configError`。测试不要假设「DB 打开后才读配置」 `[源码]`。
2. **`startNewsAutomation()` 的 `matcher.backfill(20)` 未包 try**：`ensureFresh()` 有 try/catch 告警，但紧随其后的 `await matcher.backfill(20)`（`index.ts:115`）在 `tick()` 内未单独捕获；异常会进入未捕获 Promise，定时器下一轮继续。测试观察新闻标签回填时要区分「抓取失败」与「标签回填失败」 `[源码]`。
3. **单例缺失带来的并发写库风险**：未加 `requestSingleInstanceLock`，若用户双击启动两个实例，两个进程会打开同一个 SQLite 文件（WAL 模式，`busy_timeout=5000`）；`errors.ts:60` 的文案「软件还开着另一个窗口」对应的就是这类锁冲突，但源码层面没有拦截第二实例 `[源码]`。
4. **失败重置只覆盖启动期抛错**：运行期的渲染进程崩溃、主进程未捕获异常、GPU 进程退出均无处理器（全 `src` 检索无 `render-process-gone`/`uncaughtException`/`unhandledRejection`）；不要把「重置数据后恢复」当成运行期崩溃的兜底手段 `[源码]`。
5. **窗口状态文件与数据目录绑定**：`window-state.json` 走 `resolveAppHome()`，切换 `LEARNING_AGENT_HOME` 后窗口位置不沿用；显示器被拔掉后旧坐标会被校验丢弃，属预期行为而非 bug `[源码]`。
6. **菜单被全局置空**：`Menu.setApplicationMenu(null)`（`index.ts:399`），没有原生菜单项可作为定位锚点；自动化不能依赖 `Menu` 查找条目 `[源码]`。
7. **环境变量注入点在 electron-vite 配置侧**：`LEARNING_AGENT_HOME` 的 dev 缺省值由 `apps/desktop/electron.vite.config.ts:7` 在配置加载时写入；主进程自身只认 `resolveAppHome()` 的 env/`~/.learning-agent` 两级回退。dev 与 packaged 的 home 缺省值不同，详见 `05-build-package-and-first-run.md` `[源码]`。

## 6. 未覆盖与待验证

1. **第二实例的真实行为**：源码未实现单例锁（全 `apps/desktop/src` 检索 `requestSingleInstanceLock`/`second-instance` 无命中），但本次按契约未启动 GUI，未实测双开表现。验证方法：在隔离 `LEARNING_AGENT_HOME` 下先后两次启动 `electron-vite dev`（或 packaged exe），用任务管理器/`--remote-debugging-port` 观察进程数、窗口数与端口占用，回填 BOOT-04。
2. **`whenReady` 回调内异步异常的去向**：`initServices()` 之后注册的 IPC 处理器回调内抛错由各自 try/catch 或 `friendlyError` 处理；`startNewsAutomation()` 启动的定时器回调异常是否被 Electron 当作未捕获 Promise 上报，未实测。验证方法：人为让 `matcher.backfill` 抛错，观察主进程 stderr 与进程是否退出。
3. **`app.relaunch()` 后环境变量/参数是否保留**：重置分支未显式传参，依赖 Electron 默认行为；重启后 `LEARNING_AGENT_HOME`、调试端口等是否继承未实测。验证方法：在隔离 home 下触发重置流程，检查重启后 `learning:health` 返回的 `appHome`。
4. **DB 迁移在旧版本库上的实际表现**：`packages/db/src/index.ts:852-854` 规定高于 `SCHEMA_VERSION=7` 抛错；本地无更高版本样本库，未实测报错文案与上层弹框衔接。验证方法：构造 `user_version=8` 的同结构库，放入隔离 home 启动，观察是否落入「未知错误」不可重置分支。
5. **preload 与窗口的加载时序**：`createWindow()` 先注册 `trackWindowState` 再 `loadURL/loadFile`，preload 脚本路径基于 `getAppPath()`；dev 下 HMR 与 packaged 下 file:// 的就绪信号差异未在本篇实测，留给 `10-harness-strategy.md` 的等待策略设计。
6. **新闻后端退出信号**：`stopNewsBackend()` 仅 `child.kill()`（`news-backend.ts:170-174`），Windows 下子进程组是否完整回收、8788 端口是否立即释放，未实测。验证方法：启动后正常退出，检查端口监听表与残留 Python 进程。

## 7. 交叉引用

- IPC 通道方向、9 条通道与 37 个 `learning:invoke` 方法契约：`03-ipc-and-preload-contract.md`
- Python 采集服务拉起、端口、健康检查、离线降级：`06-news-sidecar-and-network.md`
- 领域服务确定性分级与 `AgentService`/`Matcher` 等内部行为：`07-domain-services-and-determinism.md`
- `LEARNING_AGENT_HOME` 隔离、种子库、settings/window-state 文件结构与造数清理：`08-data-fixtures-and-isolation.md`
- 既有 `verify-*.ts` 启动失败/健康断言脚本：`09-existing-verification-and-gaps.md`
- 驱动选型、launch 配置与等待信号设计：`10-harness-strategy.md`
- 三启动路径（dev/preview/packaged）的路径解析与首启自举：`05-build-package-and-first-run.md`
