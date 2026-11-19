# 01 · 执行地图与反查总索引

> 归属：调查文档集收口层（地图 + 交叉索引，不定义新事实 ID）｜ 状态：部分（索引依据 02–11 已定稿事实；用例运行态待验证）｜ 核对日期：2026-11-18
> 覆盖：进程/通道/服务/数据/界面五层地图；启动路径与页面流程对应；31 条 TC（`TC-P0-01`…`TC-P0-13`、`TC-P1-01`…`TC-P1-18`）反查总表；按 IPC 方法 / 页面 / 风险三张分维度索引；83 个未被任何 TC 引用 ID 的缺口归类
> 不覆盖：各专题实现细节（一律链接回 02–10 主文档）；本篇不新定义任何 BOOT/WIN/CH/IPC/EVT/UI/FLOW/PKG/EXT/SVC/DATA/LEG/TC 编号
> 行号截至 2026-11-18。证据等级：本篇为索引层，所转引事实沿用主文档等级；IPC 方法行号取自 `03` §4.3 可测点表并已回读源码核对（`apps/desktop/src/main/index.ts` 共 555 行）；TC 前置/步骤/断言口径均为 `[待验证]`（`11` §4，调查阶段未运行任何用例）。

## 1. 结论摘要（TL;DR）

1. 本篇是整套调查文档集的入口与反查层：给一个 TC 编号，可在 §4.1 总表内 30 秒内查到它落到哪个页面/流程、哪个 IPC 方法（方法名 + `文件:行`）、哪张表/文件、哪个外部面，以及事实出自哪一篇 `[源码/实测/待验证]` 口径见各主文档。
2. 五层结构：界面层（04）→ 通道层（03）→ 服务层（07）与 sidecar/网络（06）→ 数据层（08）→ 进程层（02）与打包分叉（05）；09 提供既有资产参考，10 提供 harness 方案，11 是 TC 编排层。
3. 31 条 TC 中，23 条至少触及一个 invoke 方法或专用通道；8 条（`TC-P0-07`、`TC-P0-09`、`TC-P0-12`、`TC-P1-02`、`TC-P1-06`、`TC-P1-10`、`TC-P1-11`、`TC-P1-12`）以进程/文件/纯函数/进程枚举观测为主，不打 invoke 主断言。
4. 缺口：193 个已定义 ID 中 83 个未被任何 TC 卡片的依赖 ID 引用（§6）；缺口补编责任归属各主文档，新用例编排归 `11`。
5. 本篇只做地图与交叉索引，不复述专题细节；任何展开均给出他篇链接。

## 2. 结构与流程

### 2.1 分层总览（进程层 → 通道层 → 服务层 → 数据层 → 界面层）

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ 界面层 Renderer        04  UI-01..16 / FLOW-01..09                          │
├──────────────────────────────────────────────────────────────────────────┤
│ 通道层 preload/IPC     03  CH-01..09 / IPC-01..37 / EVT-01..05             │
├──────────────────────────────────────────────────────────────────────────┤
│ 服务层 Services       07  SVC-01..32（确定性分级：高/中/低）               │
│            sidecar/网  06  EXT-01..12（news-crawler，默认 8788，测试隔离 8799） │
├──────────────────────────────────────────────────────────────────────────┤
│ 数据层 SQLite/fixture  08  DATA-01..15（learning.db / 隔离 home / 清理）   │
├──────────────────────────────────────────────────────────────────────────┤
│ 进程层 Main 进程       02  BOOT-01..08 / WIN-01..02（装配/生命周期/兜底）   │
│            打包分叉    05  PKG-01..08（asar / extraResources / 首启自举）   │
└──────────────────────────────────────────────────────────────────────────┘
横向支撑：09 LEG-01..33 / G1..G12（既有脚本与缺口参考）
          10 harness 选型与 launch/等待/取证约定
          11 TC-P0-01..13 / TC-P1-01..18（用例编排层）
```

| 层 | 主文档 | 承载 ID 前缀 | 本篇索引位置 |
|---|---|---|---|
| 界面层 | `04-renderer-ui-flows.md` | UI-01..16、FLOW-01..09 | §2.3、§4.3 |
| 通道层 | `03-ipc-and-preload-contract.md` | CH-01..09、IPC-01..37、EVT-01..05 | §4.1、§4.2 |
| 服务层 | `07-domain-services-and-determinism.md` | SVC-01..32 | §4.1 外部/服务列、§6 缺口 |
| sidecar/网络 | `06-news-sidecar-and-network.md` | EXT-01..12 | §4.1 外部面列、§6 缺口 |
| 数据层 | `08-data-fixtures-and-isolation.md` | DATA-01..15 | §4.1 数据表列、§6 缺口 |
| 进程层 | `02-main-runtime-and-boot.md` | BOOT-01..08、WIN-01..02 | §2.2、§4.1 |
| 打包分叉 | `05-build-package-and-first-run.md` | PKG-01..08 | §2.2、§4.1 外部面列 |
| 既有资产 | `09-existing-verification-and-gaps.md` | LEG-01..33、G1..G12 | §4.1 证据来源列、§6 缺口 |
| harness 方案 | `10-harness-strategy.md` | （方案层，无新事实 ID） | §4.4 风险方案列 |
| 用例编排 | `11-scenario-catalog.md` | TC-P0-01..13、TC-P1-01..18 | §4.1 总表 |

### 2.2 启动路径地图（冷启动 → 首窗 → 服务就绪 → 首轮数据）

```text
冷启动 BOOT-01（initServices 就绪信号，02 §2）
  │
  ├─ 分叉点 ① 启动路径：dev（electron . / tsx watch）｜ preview（out 产物）｜ packaged（win-unpacked / exe）
  │         三路径的产物、加载分支、资源解析矩阵见 05 §2.6，本篇不复述
  │
  ├─ 首窗 WIN-01（createWindow，最小 760×560）→ preload 桥 CH-01 → UI-01 根三栏
  │
  ├─ 服务就绪：DB 构造/迁移 SVC-01 → DATA-01/02；health CH-06 返回 { ok, warnings, notices, appHome }
  │         sidecar 按 EXT-06（NEWS_CRAWLER_AUTOSTART）决定是否拉起（默认 8788，测试隔离 8799）
  │
  └─ 首轮数据：seed 复制 DATA-06/07 或空库建表分叉 → UI-02/03 会话与章节 → FLOW-01 首轮 CH-03 对话
            打包首启分叉 PKG-03/04（种子复制 vs 空库建表）在首启步观测，见 05 §5
```

| 路径段 | 关键 ID | 主文档锚点 |
|---|---|---|
| 冷启动就绪 | BOOT-01、SVC-01、DATA-01/02、CH-06 | 02 §2 BOOT-01；07 SVC-01；08 DATA-01/02；03 CH-06 |
| 启动路径分叉 | PKG-01/02/03/06 | 05 §2.6 三路径矩阵 |
| 首窗与桥 | WIN-01、CH-01、UI-01、IPC-01 | 02 WIN-01；03 CH-01/IPC-01；04 UI-01 |
| 服务就绪 | SVC-01、EXT-06、CH-06 | 07 SVC-01；06 EXT-06；03 CH-06 |
| 首轮数据 | DATA-06/07、FLOW-01、CH-03、EVT-01 | 08 DATA-06/07；04 FLOW-01；03 CH-03/EVT-01 |
| 打包首启分叉 | PKG-03/04/05、DATA-06/07 | 05 §5；08 DATA-06/07 |

### 2.3 页面 / 流程地图（UI ↔ FLOW 对应关系）

> 一个 FLOW 跨哪些 UI、一个 UI 参与哪些 FLOW；TC 归属见 §4.1 与 §4.3。

| FLOW | 名称 | 参与 UI | 主文档锚点 |
|---|---|---|---|
| FLOW-01 | 发送一轮对话 | UI-01、UI-03 | 04 §2.2 FLOW-01 |
| FLOW-02 | 流式进度渲染与取消 | UI-03 | 04 §2.2 FLOW-02 |
| FLOW-03 | 题目集作答、交卷与重试 | UI-09、UI-10 | 04 §2.2 FLOW-03 |
| FLOW-04 | 空题目集降级 | UI-10 | 04 §2.2 FLOW-04 |
| FLOW-05 | 引用溯源开标签 | UI-11、UI-12 | 04 §2.2 FLOW-05 |
| FLOW-06 | 会话新建 / 切换 | UI-02 | 04 §2.2 FLOW-06 |
| FLOW-07 | 档案证据复核与快照 | UI-04 | 04 §2.2 FLOW-07 |
| FLOW-08 | 工作区标签操作（开/关/切/全屏/导出） | UI-07、UI-08、UI-09 | 04 §2.2 FLOW-08 |
| FLOW-09 | 分栏拖拽与复位 | UI-14、UI-15 | 04 §2.2 FLOW-09 |

| UI | 名称 | 参与 FLOW | 覆盖 TC（11 卡片依赖 ID） |
|---|---|---|---|
| UI-01 | 应用根三栏布局 | FLOW-01（承载） | TC-P0-02 |
| UI-02 | 左侧栏（会话/章节列表） | FLOW-06 | （无直接 TC，经 FLOW-06 由 TC-P1-08 间接承载） |
| UI-03 | 对话主视图（chat） | FLOW-01、FLOW-02 | （无直接 TC 依赖 ID，经 FLOW-01/02 由 TC-P0-03 间接承载） |
| UI-04 | 学习档案视图（profile） | FLOW-07 | TC-P1-09 |
| UI-05 | 设置弹窗 | — | TC-P1-01 |
| UI-06 | 顶栏与两个浮层 | — | （无 TC） |
| UI-07 | 右侧工作区面板 | FLOW-08 | TC-P0-05、TC-P1-13 |
| UI-08 | 工作区标签页栏 | FLOW-08 | TC-P0-05、TC-P1-13 |
| UI-09 | 产物渲染器分派 | FLOW-03、FLOW-08 | TC-P0-05 |
| UI-10 | 题目集渲染器 | FLOW-03、FLOW-04 | TC-P0-06、TC-P1-02 |
| UI-11 | 新闻原文视图 | FLOW-05 | TC-P1-07 |
| UI-12 | 教材/资源原文视图 | FLOW-05 | TC-P1-07 |
| UI-13 | 本地文件预览视图 | — | TC-P1-14 |
| UI-14 | 侧栏拖拽手柄 | FLOW-09 | TC-P1-10 |
| UI-15 | 工作区拖拽手柄 | FLOW-09 | TC-P1-10 |
| UI-16 | 休眠页面集合（Electron 未挂载） | — | （无 TC；04 §5 R-1） |

## 3. 关键代码位置与外部依据

| 职责 | 文件:行 | 说明 | 等级 |
|---|---|---|---|
| 主进程入口与启动装配 | `apps/desktop/src/main/index.ts:44` | `initServices()`；本篇核对的主进程文件共 555 行（Read 编号至 556、末行无尾换行） | `[源码]` |
| invoke 分发与 37 分支 | `apps/desktop/src/main/index.ts:445`（switch 分支 `:209-389`） | `learning:invoke`；逐方法行号见 §4.2.1 | `[源码]` |
| 9 条通道注册 | `apps/desktop/src/main/index.ts:445,448,453,480,494,509,529,537,538` | 8 处 `ipcMain.handle` + 1 条主→渲染 `learning:chat-event`；逐通道行号见 §4.2.2 | `[源码]` |
| 退出清理钩子 | `apps/desktop/src/main/index.ts:547,553` | `before-quit` / `window-all-closed` | `[源码]` |
| preload 暴露面 | `apps/desktop/src/preload/index.ts:3,9-24` | `exposeInMainWorld('learning', …)` | `[源码, 03 §1]` |
| seed 库基线 | `release/win-unpacked/resources/seed/learning.db` | 38 表、`user_version=7`、3,448,832 B；`apps/desktop/seed/` 不存在 | `[实测, 08/09]` |

1. 本篇全部事实转引自 `02`–`11` 已定稿文档；未在本篇新跑脚本、未启动 GUI、未改源码/配置/锁文件。`[源码]`/`[实测]` 等级沿用各主文档标注；TC 设计口径为 `[待验证]`（11 §1.7）。
2. 外部依据：Electron 官方自动化测试四路径原文见 `../electron-automated-testing.md`；写作契约与 ID 方案见 `../AUTHORING-SPEC.md`。
3. 实测基线（转引 08/09）：渲染层 `data-testid` 为 0；其余 DB 表计数与 PRAGMA 口径见 08 §4。

## 4. 可测点（反查索引）

### 4.1 TC 反查总索引（31 行）

> 列说明：页面/流程 = UI/FLOW；关键 IPC = 方法名 + `apps/desktop/src/main/index.ts:<行>`（invoke 分支行号，03 §4.3；专用通道行号，03 §4.2）；关键表/文件 = DATA 归属；关键外部面 = EXT/PKG/LLM/本地文件；证据来源 = 他篇编号。IPC 列写方法名而非只写 `IPC-xx`，便于 30 秒内定位到 `文件:行`。

| TC | 名称 | 页面/流程（UI/FLOW） | 关键 IPC（方法名 + 文件:行） | 关键表/文件（DATA） | 关键外部面（EXT/PKG） | 证据来源（他篇编号） |
|---|---|---|---|---|---|---|
| TC-P0-01 | 隔离 home 启动并通过 health 自检 | — | `learning:health`（CH-06）`index.ts:529` | `data/learning.db`（DATA-01/02，PRAGMA/版本基线） | 无（sidecar 关闭；BOOT-01） | 11 §4.1；02 BOOT-01；03 CH-06；08 DATA-01/02；07 SVC-01；09 LEG-13 |
| TC-P0-02 | 首窗出现、preload 桥与学生身份可用 | UI-01 | `student.current`（IPC-01）`index.ts:209`；invoke 通道 CH-01 `:445` | seed 库只读 fixture（DATA-14a） | 无 | 11 §4.1；02 WIN-01；04 UI-01；03 IPC-01/CH-01；08 DATA-14a |
| TC-P0-03 | 一轮完整对话：流式事件序列 + chat resolve | FLOW-01、FLOW-02；UI-03 间接 | `learning:chat`（CH-03）`index.ts:453`；`learning:chat-event`（CH-09）`:480`；EVT-01 session、EVT-03 text | 会话/消息/轮次落库回查面（DATA-04） | LLM（或脚本化假 LLM） | 11 §4.1；04 FLOW-01/02；03 CH-03/09、EVT-01/03；07 SVC-21 |
| TC-P0-04 | 对话落库：会话/消息/轮次可回查 | — | `chat.sessions`（IPC-27）`index.ts:344`；`chat.messages`（IPC-28）`:346` | `chat_sessions`、`chat_messages`、`turns`（DATA-04） | 同 P0-03 | 11 §4.1；03 IPC-27/28；08 DATA-04；07 SVC-20 |
| TC-P0-05 | 打开一个产物/文档标签 | UI-07、UI-08、UI-09；FLOW-08 | `artifacts.list`（IPC-19）`index.ts:319`；`artifacts.get`（IPC-20）`:321` | artifacts 表；`artifacts/<studentId>/<YYYY-MM>/`（DATA-13a） | 无 | 11 §4.1；04 UI-07/08/09、FLOW-08；03 IPC-19/20；08 DATA-13a；07 SVC-16 |
| TC-P0-06 | 一次答题/交卷并回读判分记录 | UI-10；FLOW-03 | `learning:answer-set`（CH-05）`index.ts:509`；`questions.attempts`（IPC-13）`:290` | `question_attempts`、`questions` | LLM 判分（可降级规则判分） | 11 §4.1；04 FLOW-03、UI-10；03 CH-05/IPC-13；07 SVC-21；09 LEG-08 |
| TC-P0-07 | 干净退出：定时器/子进程清理、句柄释放 | — | 无 invoke 主断言；退出钩子 `before-quit` `index.ts:547`、`window-all-closed` `:553`（BOOT-07） | DB 三件套 + `window-state.json` 快照与清理（DATA-12b/12d） | sidecar 关闭；子进程 kill（BOOT-07） | 11 §4.1；02 BOOT-07；08 DATA-12b/12d；07 SVC-01 |
| TC-P0-08 | packaged 产物启动首窗 + health | — | `learning:health`（CH-06）`index.ts:529` | 种子复制条件核对（DATA-06）；`resources/app.asar`、`resources/seed/` | PKG-03/06 packaged 路径 | 11 §4.1；05 PKG-03/06；02 BOOT-01；08 DATA-06；09 LEG-22 |
| TC-P0-09 | packaged 首启种子库自举落库 | — | 无 invoke 主断言；首启种子复制 `index.ts:71`（PKG-03/04） | seed/自举库对照（DATA-06/07/12b） | PKG-03/04 packaged 路径 | 11 §4.1；05 PKG-03/04；08 DATA-06/07/12b |
| TC-P0-10 | 只读 invoke 方法契约往返快照 | — | `student.current`（IPC-01）`:209`；`chapters.list`（IPC-02）`:213`；`kps.list`（IPC-03）`:215`；`news.status`（IPC-09）`:257`；CH-01 `:445` | `chapters`、`knowledge_points`、`news_articles`（DATA-04） | 无 | 11 §4.1；03 IPC-01/02/03/09/CH-01；07 SVC-02；08 DATA-04 |
| TC-P0-11 | 关闭 sidecar 下启动不阻塞、本地新闻可读 | — | `news.list`（IPC-08）`index.ts:251`；`news.status`（IPC-09）`:257` | `news_articles`、`case_matches` | EXT-06（AUTOSTART=0）；8799 无监听 | 11 §4.1；06 EXT-06；03 IPC-08/09；07 SVC-18；02 BOOT-01 |
| TC-P0-12 | 窗口尺寸/位置持久化一轮 | — | 无 invoke；`window-state.ts:58` `readWindowState()`、`:98` `trackWindowState()`（WIN-02） | `window-state.json`（DATA-11） | 无 | 11 §4.1；02 BOOT-05/WIN-02；08 DATA-11 |
| TC-P0-13 | 产物导出文件落盘可回读 | — | `artifacts.export`（IPC-21）`index.ts:323`；`artifacts.get`（IPC-20）`:321` | artifacts 表；`artifacts/`、`exports/`（DATA-13a/13b） | 无 | 11 §4.1；03 IPC-21/20；07 SVC-16；08 DATA-13a/13b |
| TC-P1-01 | 设置读写、BOM/坏 JSON 自愈与公开视图 | UI-05 附带 | `learning:settings:get`（CH-07）`index.ts:537`；`learning:settings:set`（CH-08）`:538` | userData `settings.json`（DATA-10，不随 home 重定向） | 无 | 11 §4.2；03 CH-07/08；08 DATA-10；04 UI-05；09 LEG-11 |
| TC-P1-02 | 空题目集降级分支 | UI-10；FLOW-04 | 无 invoke 主断言（服务层空结果判定） | `questions`；空集 fixture 造数（DATA-14b） | 无 | 11 §4.2；04 FLOW-04/UI-10；07 SVC-07；09 LEG-03；08 DATA-14b |
| TC-P1-03 | 流式取消链路：在途轮次中断 | FLOW-02 | `learning:cancel`（CH-02）`index.ts:448`；EVT-01 session 记 id | `chat_sessions`/`chat_messages`/artifacts 无残缺行 | 慢速可中断 LLM/mock | 11 §4.2；04 FLOW-02；03 CH-02/EVT-01；09 LEG-01/02 |
| TC-P1-04 | 离线新闻本地读取降级 | — | `news.list`（IPC-08）`:251`；`news.status`（IPC-09）`:257`；`news.get`（IPC-11）`:274` | `news_articles`、`case_matches`、`ideology_tags` | EXT-10 离线降级；sidecar 关闭 | 11 §4.2；03 IPC-08/09/11；07 SVC-18；06 EXT-10 |
| TC-P1-05 | AUTOSTART=0 下 news.refresh 可识别 reject | — | `news.refresh`（IPC-10）`index.ts:262` | `source_runs`、`news_articles` 未被污染 | EXT-06/10；8799 无监听；网络面 | 11 §4.2；03 IPC-10；06 EXT-06/10；07 SVC-19 |
| TC-P1-06 | sidecar 退出后不重建、后续网络调用失败 | — | 无 invoke 主断言（HTTP 失败冒泡观测） | 共享 `learning.db`（EXT-12 并发观测） | EXT-07 崩溃/退出重建；先起 sidecar 再 kill | 11 §4.2；06 EXT-07/12；07 SVC-19 |
| TC-P1-07 | 引用溯源开 news/source 标签 | UI-11、UI-12；FLOW-05 | `news.get`（IPC-11）`:274`；`getBlock`（IPC-05）`:227`；`getResource`（IPC-06）`:236` | `news_articles`、`case_matches`、`knowledge_points`、`content_blocks`、`plugin_state` | 同 P0-03 对话引用 | 11 §4.2；04 FLOW-05/UI-11/12；03 IPC-11/05/06 |
| TC-P1-08 | 会话新建与历史切换 | FLOW-06 | `chat.sessions`（IPC-27）`:344`；`agent.sessions`（IPC-34）`:366` | `chat_sessions`、`chat_messages` | 无 | 11 §4.2；04 FLOW-06；03 IPC-27/34；07 SVC-20 |
| TC-P1-09 | 档案证据复核与前后测快照 | UI-04；FLOW-07 | `profile.get`（IPC-14）`:296`；`profile.evidence`（IPC-16）`:300`；`profile.snapshot`（IPC-17）`:306`；`profile.review`（IPC-18）`:312` | `evidence`、`growth_snapshots`、`student_profiles` | 无 | 11 §4.2；04 FLOW-07/UI-04；03 IPC-14/16/17/18；07 SVC-14 |
| TC-P1-10 | 分栏拖拽键盘步进与布局持久化 | UI-14、UI-15；FLOW-09 | 无 invoke；localStorage 两布局键 | localStorage（浏览器 profile，非 DB；04 §6 U5） | 无 | 11 §4.2；04 FLOW-09/UI-14/15；02 WIN-01 |
| TC-P1-11 | 损坏 DB 启动失败分支（可重置/不可重置） | — | 无 invoke 主断言；`startupFailure` 纯函数决策（LEG-12） | 损坏 DB 样本；`.broken-*` 三件改名（DATA-03） | 无 | 11 §4.2；02 BOOT-02/03；08 DATA-03；09 LEG-12 |
| TC-P1-12 | 双实例行为观察（单例缺失） | — | 无 invoke；进程/窗口/端口枚举观测 | 两套隔离 home 库 | BOOT-04 双开；dev/out ×2 | 11 §4.2；02 BOOT-04/WIN-01；09 LEG-18 |
| TC-P1-13 | 九种 DocKind 标签逐一打开 | UI-07、UI-08；FLOW-08 | `artifacts.list`（IPC-19）`index.ts:319` | artifacts、`news_articles`、`content_blocks` 等九类标签 fixture | 无 | 11 §4.2；04 UI-07/08/FLOW-08；03 IPC-19；09 LEG-30 |
| TC-P1-14 | 本地文件预览与打开对话框 | UI-13 | `files.preview`（IPC-36）`:373`；`files.openDialog`（IPC-37）`:375` | 本地样本文件；`FilePreview` 返回 | 本地样本文件 | 11 §4.2；04 UI-13；03 IPC-36/37；07 SVC-27 |
| TC-P1-15 | 记忆事实 upsert/delete 往返 | — | `memory.facts`（IPC-22）`:325`；`memory.upsert`（IPC-25）`:331`；`memory.delete`（IPC-26）`:341` | `memory_facts` | 无 | 11 §4.2；03 IPC-22/25/26；07 SVC-14 |
| TC-P1-16 | 过程/账本视图与失败重试 | — | `agent.turns`（IPC-31）`:359`；`agent.ledger`（IPC-32）`:361`；`agent.retry`（IPC-33）`:363` | `turns`、`summary_ledger` | IPC-33 间接 LLM 后台链路（不在此断言） | 11 §4.2；03 IPC-31/32/33；07 SVC-20 |
| TC-P1-17 | 无种子空库首启健康告警分叉 | — | `learning:health`（CH-06）`index.ts:529` | 空库 `learning.db`；seed 基线对照（DATA-07） | PKG-05 无种子打包分叉；dev/out 或 packaged | 11 §4.2；05 PKG-05；08 DATA-07；09 LEG-13；02 BOOT-01 |
| TC-P1-18 | 跨 IPC 错误对象形态探针 | — | invoke CH-01 `:445`；chat CH-03 `:453`；未知方法名探针 | 无落库 | 无；一次性诊断代码不入仓 | 11 §4.2；03 CH-01/03；09 LEG-05；07 SVC-02 |

### 4.2 分维度索引 A：按 IPC 方法（37 个 invoke + 9 条通道）

> 覆盖状态：`全量` = 有 TC 主断言打在该方法；`部分` = 仅附带观测/间接承载；`未覆盖` = 无任何 TC 引用。契约字段与入参/返回形状见 03 §4.3（invoke）与 §4.2（通道），本篇不复述。

#### 4.2.1 invoke 方法（IPC-01 … IPC-37）

| IPC | 方法名 | `index.ts` 行 | 覆盖状态 | 覆盖 TC | 契约出处 |
|---|---|---|---|---|---|
| IPC-01 | `student.current` | `:209` | 全量 | TC-P0-02、TC-P0-10 | 03 §4.3 |
| IPC-02 | `chapters.list` | `:213` | 全量 | TC-P0-10 | 03 §4.3 |
| IPC-03 | `kps.list` | `:215` | 全量 | TC-P0-10 | 03 §4.3 |
| IPC-04 | `getKp` | `:225` | 未覆盖 | — | 03 §4.3 |
| IPC-05 | `getBlock` | `:227` | 全量 | TC-P1-07 | 03 §4.3 |
| IPC-06 | `getResource` | `:236` | 全量 | TC-P1-07 | 03 §4.3 |
| IPC-07 | `listIdeology` | `:249` | 未覆盖 | — | 03 §4.3 |
| IPC-08 | `news.list` | `:251` | 全量 | TC-P0-11、TC-P1-04 | 03 §4.3 |
| IPC-09 | `news.status` | `:257` | 全量 | TC-P0-10、TC-P0-11、TC-P1-04 | 03 §4.3 |
| IPC-10 | `news.refresh` | `:262` | 全量 | TC-P1-05 | 03 §4.3 |
| IPC-11 | `news.get` | `:274` | 全量 | TC-P1-04、TC-P1-07 | 03 §4.3 |
| IPC-12 | `news.match` | `:283` | 未覆盖 | — | 03 §4.3 |
| IPC-13 | `questions.attempts` | `:290` | 全量 | TC-P0-06 | 03 §4.3 |
| IPC-14 | `profile.get` | `:296` | 全量 | TC-P1-09 | 03 §4.3 |
| IPC-15 | `profile.growth` | `:298` | 未覆盖 | — | 03 §4.3 |
| IPC-16 | `profile.evidence` | `:300` | 全量 | TC-P1-09 | 03 §4.3 |
| IPC-17 | `profile.snapshot` | `:306` | 全量 | TC-P1-09 | 03 §4.3 |
| IPC-18 | `profile.review` | `:312` | 全量 | TC-P1-09 | 03 §4.3 |
| IPC-19 | `artifacts.list` | `:319` | 全量 | TC-P0-05、TC-P1-13 | 03 §4.3 |
| IPC-20 | `artifacts.get` | `:321` | 全量 | TC-P0-05、TC-P0-13 | 03 §4.3 |
| IPC-21 | `artifacts.export` | `:323` | 全量 | TC-P0-13 | 03 §4.3 |
| IPC-22 | `memory.facts` | `:325` | 全量 | TC-P1-15 | 03 §4.3 |
| IPC-23 | `memory.episodes` | `:327` | 未覆盖 | — | 03 §4.3 |
| IPC-24 | `memory.summary` | `:329` | 未覆盖 | — | 03 §4.3 |
| IPC-25 | `memory.upsert` | `:331` | 全量 | TC-P1-15 | 03 §4.3 |
| IPC-26 | `memory.delete` | `:341` | 全量 | TC-P1-15 | 03 §4.3 |
| IPC-27 | `chat.sessions` | `:344` | 全量 | TC-P0-04、TC-P1-08 | 03 §4.3 |
| IPC-28 | `chat.messages` | `:346` | 全量 | TC-P0-04 | 03 §4.3 |
| IPC-29 | `agent.snapshot` | `:348` | 未覆盖 | — | 03 §4.3 |
| IPC-30 | `agent.suggestions` | `:354` | 未覆盖 | — | 03 §4.3 |
| IPC-31 | `agent.turns` | `:359` | 全量 | TC-P1-16 | 03 §4.3 |
| IPC-32 | `agent.ledger` | `:361` | 全量 | TC-P1-16 | 03 §4.3 |
| IPC-33 | `agent.retry` | `:363` | 全量 | TC-P1-16 | 03 §4.3 |
| IPC-34 | `agent.sessions` | `:366` | 全量 | TC-P1-08 | 03 §4.3 |
| IPC-35 | `files.reveal` | `:370` | 未覆盖 | — | 03 §4.3 |
| IPC-36 | `files.preview` | `:373` | 全量 | TC-P1-14 | 03 §4.3 |
| IPC-37 | `files.openDialog` | `:375` | 全量 | TC-P1-14 | 03 §4.3 |

#### 4.2.2 专用通道（CH-01 … CH-09）

| CH | 通道名 | `index.ts` 行 | 覆盖状态 | 覆盖 TC | 契约出处 |
|---|---|---|---|---|---|
| CH-01 | `learning:invoke` | `:445` | 全量 | TC-P0-02、TC-P0-10、TC-P1-18 | 03 §4.2 |
| CH-02 | `learning:cancel` | `:448` | 全量 | TC-P1-03 | 03 §4.2 |
| CH-03 | `learning:chat` | `:453` | 全量 | TC-P0-03、TC-P1-18 | 03 §4.2 |
| CH-04 | `learning:answer`（单题作答） | `:494` | 未覆盖 | — | 03 §4.2 |
| CH-05 | `learning:answer-set` | `:509` | 全量 | TC-P0-06 | 03 §4.2 |
| CH-06 | `learning:health` | `:529` | 全量 | TC-P0-01、TC-P0-08、TC-P1-17 | 03 §4.2 |
| CH-07 | `learning:settings:get` | `:537` | 全量 | TC-P1-01 | 03 §4.2 |
| CH-08 | `learning:settings:set` | `:538` | 全量 | TC-P1-01 | 03 §4.2 |
| CH-09 | `learning:chat-event`（主→渲染单向） | `:480` | 全量 | TC-P0-03 | 03 §4.2 |

### 4.3 分维度索引 B：按页面（UI → 相关 FLOW → 相关 TC）

> 与 §2.3 互查；`部分` 表示该页面仅被附带观测，`未覆盖` 表示无 TC 卡片直接引用。

| UI | 名称 | 相关 FLOW | 相关 TC | 覆盖状态 | 出处 |
|---|---|---|---|---|---|
| UI-01 | 应用根三栏布局 | FLOW-01 | TC-P0-02 | 全量 | 04 §2.1 |
| UI-02 | 左侧栏 | FLOW-06 | TC-P1-08（间接，经 FLOW-06） | 部分 | 04 §2.1 |
| UI-03 | 对话主视图（chat） | FLOW-01、FLOW-02 | TC-P0-03（间接，经 FLOW-01/02） | 部分 | 04 §2.1 |
| UI-04 | 学习档案视图 | FLOW-07 | TC-P1-09 | 全量 | 04 §2.1 |
| UI-05 | 设置弹窗 | — | TC-P1-01 | 全量 | 04 §2.1 |
| UI-06 | 顶栏与两个浮层 | — | — | 未覆盖 | 04 §2.1 |
| UI-07 | 右侧工作区面板 | FLOW-08 | TC-P0-05、TC-P1-13 | 全量 | 04 §2.1 |
| UI-08 | 工作区标签页栏 | FLOW-08 | TC-P0-05、TC-P1-13 | 全量 | 04 §2.1 |
| UI-09 | 产物渲染器分派 | FLOW-03、FLOW-08 | TC-P0-05 | 全量 | 04 §2.1 |
| UI-10 | 题目集渲染器 | FLOW-03、FLOW-04 | TC-P0-06、TC-P1-02 | 全量 | 04 §2.1 |
| UI-11 | 新闻原文视图 | FLOW-05 | TC-P1-07 | 全量 | 04 §2.1 |
| UI-12 | 教材/资源原文视图 | FLOW-05 | TC-P1-07 | 全量 | 04 §2.1 |
| UI-13 | 本地文件预览视图 | — | TC-P1-14 | 全量 | 04 §2.1 |
| UI-14 | 侧栏拖拽手柄 | FLOW-09 | TC-P1-10 | 全量 | 04 §2.1 |
| UI-15 | 工作区拖拽手柄 | FLOW-09 | TC-P1-10 | 全量 | 04 §2.1 |
| UI-16 | 休眠页面集合（未挂载） | — | — | 未覆盖 | 04 §5 R-1 |

### 4.4 分维度索引 C：按风险 / 易碎点（易碎点 → 涉及 TC → 10 号文档方案）

| # | 易碎点 / 风险 | 出处主文档 | 涉及 TC | 10 号文档对应方案 |
|---|---|---|---|---|
| R-1 | 渲染层无 `data-testid`（0 处），选项/卡片/列表只能靠文本/role/业务 `data-*` 定位 | 04 R-2/R-5；11 §5.1 | TC-P0-05、TC-P0-06、TC-P1-02、TC-P1-07、TC-P1-13 | 10 §4.2.2 定位标识现状：优先 `data-*` 钩子，主断言下沉 IPC/DB，DOM 只验容器与短标签；元素级稳定定位需源码补 test-id（G7，待主代理批准） |
| R-2 | LLM/网络低确定性内容误入断言会造成偶发失败 | 07 §2.2；11 §5.2 | TC-P0-03、TC-P0-04、TC-P0-05、TC-P0-06、TC-P1-03、TC-P1-07 | 10 §5 风险 7 低确定性断言口径：只断言结构/状态流转/引用可解析；可重复流用脚本化假模型，真模型冒烟单独标记（G11）；分级口径见 07 §2.2 |
| R-3 | `settings.json` 在 userData，不随 `LEARNING_AGENT_HOME` 重定向，并行用例共享配置 | 08 §7 风险 1（DATA-10）；11 §5.3 | TC-P1-01 | 10 §4.4.1 Fixture 与隔离：设置写入类用例独占实例或串行，不进并行组 |
| R-4 | sidecar 取证盲区与假就绪：外部 driver 拿不到句柄/独立日志；`/health` 进程存活即 `ok:true`；端口复用不校验身份 | 06 R-1/R-8；10 §4.2.3；11 §5.4 | TC-P0-11、TC-P1-04、TC-P1-05、TC-P1-06 | 10 §4.2.3：按 PID + 命令行 + `db_path` 三重核对进程身份；sidecar 日志/句柄取证单列 |
| R-5 | 打包产物路径与 dev 不可混用：asar 内磁盘不可读；`getAppPath()/resourcesPath/cwd/__dirname` 各异；种子库在 asar 外侧 | 05 §2.6；11 §5.5 | TC-P0-08、TC-P0-09、TC-P1-17 | 10 §4.2.1 路径与 fixture：packaged 取证区分 asar 内/外，不照搬 dev 的 `out/` 磁盘路径 |
| R-6 | WAL 三件套与脏读：快照/清理必须带齐 `-wal`/`-shm`；活库写入中不要直拷主库比行数 | 08 §7 风险 4（DATA-12b/12c/12d）；11 §5.6 | TC-P0-04、TC-P0-07、TC-P0-09 | 10 §4.4.1/§4.4.4：只读 `mode=ro` 快照；先关应用 checkpoint 再复制；清理三件套一并删 |
| R-7 | 等待信号未固化：既有脚本以 1s 文本轮询为主循环，模型慢响应/HMR/sidecar 未就绪都会误判 | 09 LEG-18/21/23；11 §5.7 | 全部 TC（统一约束） | 10 §4.4.2 等待策略：等 IPC resolve / DOM 出现 / 端口 health / 文件 mtime / 日志行；固定 sleep 仅作兜底 |
| R-8 | 既有脚本路径漂移与「存在 ≠ 通过」：14 个 verify 脚本本轮未执行；`.scratch` 多硬编码旧路径；历史 passed 日志不作当前通过证据 | 09 §5；11 §5.8 | 参考类：TC-P0-06、TC-P0-08、TC-P1-01、TC-P1-11、TC-P1-12、TC-P1-13、TC-P1-15 等复用 LEG 纯函数/脚本思路 | 10 §4.2.2 既有脚本教训 + 09 §4 覆盖矩阵：只复用纯函数/临时 DB 隔离思路，不复用旧路径与文本轮询；运行结果回填前标 `[待验证]` |
| R-9 | 取消是否真正中断在途模型请求未实测；`signal` 透传只做过源码级断言 | 03 R-7/G2；11 §4.2 P1-03 易碎点 | TC-P1-03 | 10 §4.3.1 事件订阅与断言口径：中断链路断言收敛到 cancel 结构与晚到事件归属；模型 HTTP 中断行为列入待验证，不在当前断言 |
| R-10 | localStorage 布局偏好归属浏览器 profile，不在隔离 home 内；窄屏/全屏/无标签时手柄不渲染 | 04 §6 U5；11 §4.2 P1-10 易碎点 | TC-P1-10 | 10 §4.4.1 隔离边界：布局键归属 profile 记入隔离边界；并行时核对 localStorage 与默认学生 id 互不污染（08 §8 U5） |

## 5. 风险与坑

1. **本篇索引可能滞后于主文档改动**：任一主文档新增/删除 ID、调整行号后，必须同步更新本篇 §4.1 总表与 §4.2/4.3 分维度索引（联动约束见 `docs/README.md` 维护规则）。
2. **覆盖状态口径**：§4.2/4.3 的「全量/部分/未覆盖」以 11 号各 TC 卡片「依赖 ID」列为判定依据；仅出现在易碎点/叙述段落的 ID 不计入主断言覆盖。间接承载（经 FLOW 落到某 UI）已在表内标注「间接」。
3. **行号漂移兜底**：源码改动后分支行号会移动；定位先以方法名（`case '<method>'`）为准，行号作为辅助锚点；与 03 §4.3 表不一致时以源码当前函数名为准并回填 03 与本篇。
4. **低确定性勿上浮到索引结论**：本篇不把 LLM/网络场景的预期结果写成已验证结论；所有 TC 运行态均为 `[待验证]`，回填前不得当作通过证据。

## 6. 未覆盖与待验证（覆盖缺口：83 个未被 TC 引用的 ID）

> 统计口径：11 号 31 条 TC 卡片「依赖 ID」列未引用的已定义 ID；总数 83 / 193（转引 11 §1 与 09 覆盖矩阵口径）。下表按前缀归类，列出未引用 ID 与负责补编的主文档；新用例编排统一归 `11`。本篇不新增编号，缺口 ID 编号沿用各主文档既有定义。

| 前缀 | 主文档（定义归属） | 未引用数 | 未引用 ID | 负责补编 / 接续篇 |
|---|---|---|---|---|
| LEG | 09-existing-verification-and-gaps.md | 22 | LEG-04、LEG-06、LEG-07、LEG-09、LEG-10、LEG-14、LEG-15、LEG-16、LEG-17、LEG-19、LEG-20、LEG-21、LEG-23、LEG-24、LEG-25、LEG-26、LEG-27、LEG-28、LEG-29、LEG-31、LEG-32、LEG-33 | 09（资产盘点与可复用性判定）；需要落断言时由 11 编排新 TC |
| SVC | 07-domain-services-and-determinism.md | 22 | SVC-03、SVC-04、SVC-05、SVC-06、SVC-08、SVC-09、SVC-10、SVC-11、SVC-12、SVC-13、SVC-15、SVC-17、SVC-22、SVC-23、SVC-24、SVC-25、SVC-26、SVC-28、SVC-29、SVC-30、SVC-31、SVC-32 | 07（服务契约与确定性分级）；新断言由 11 编排 |
| IPC | 03-ipc-and-preload-contract.md | 9 | IPC-04 `getKp`、IPC-07 `listIdeology`、IPC-12 `news.match`、IPC-15 `profile.growth`、IPC-23 `memory.episodes`、IPC-24 `memory.summary`、IPC-29 `agent.snapshot`、IPC-30 `agent.suggestions`、IPC-35 `files.reveal` | 03（契约核对）；往返断言由 11 编排 |
| EXT | 06-news-sidecar-and-network.md | 8 | EXT-01、EXT-02、EXT-03、EXT-04、EXT-05、EXT-08、EXT-09、EXT-11 | 06（sidecar/网络面事实）；降级与网络用例由 11 编排 |
| DATA | 08-data-fixtures-and-isolation.md | 8 | DATA-05、DATA-08、DATA-09、DATA-12a、DATA-12c、DATA-14c、DATA-14d、DATA-15 | 08（fixture/隔离/清理口径）；造数与取证用例由 11 编排 |
| PKG | 05-build-package-and-first-run.md | 4 | PKG-01、PKG-02、PKG-07、PKG-08 | 05（产物/工具链核对项）；打包冒烟由 11 编排 |
| UI | 04-renderer-ui-flows.md | 4 | UI-02、UI-03、UI-06、UI-16 | 04（视图与定位现状）；页面用例由 11 编排 |
| EVT | 03-ipc-and-preload-contract.md | 3 | EVT-02 `round`、EVT-04 `tool`、EVT-05 `tool-end` | 03（流式事件契约）；真实序列捕获由 11 编排（见 11 §6.3） |
| BOOT | 02-main-runtime-and-boot.md | 2 | BOOT-06、BOOT-08 | 02（生命周期/兜底事实）；启动用例由 11 编排 |
| CH | 03-ipc-and-preload-contract.md | 1 | CH-04 `learning:answer`（单题作答） | 03（通道契约）；答题往返用例由 11 编排 |
| **合计** | — | **83** | — | — |

待验证项（转引 11 §6，本篇不重复展开）：全部用例尚未运行；WIN 维度覆盖薄弱；EVT 真实增量序列未捕获；打包两条用例依赖现存 `win-unpacked`；LLM 不可达时对话主循环降级行为；P1-11 对话框与 relaunch 链路；九种 DocKind fixture 完备度；并行隔离边界。

## 7. 交叉引用

- 启动装配、生命周期、失败兜底与窗口状态：`02-main-runtime-and-boot.md`（BOOT-01..08、WIN-01/02）
- preload 面、9 条通道、37 个 invoke 契约与流式事件：`03-ipc-and-preload-contract.md`（CH-01..09、IPC-01..37、EVT-01..05）
- 页面/面板/标签、定位现状与端到端流程：`04-renderer-ui-flows.md`（UI-01..16、FLOW-01..09）
- 构建、asar、extraResources 与首启自举：`05-build-package-and-first-run.md`（PKG-01..08）
- Python sidecar、端口、健康检查与离线降级：`06-news-sidecar-and-network.md`（EXT-01..12）
- 领域服务确定性分级与输入输出：`07-domain-services-and-determinism.md`（SVC-01..32）
- SQLite 结构、隔离 home、fixture 造数与清理：`08-data-fixtures-and-isolation.md`（DATA-01..15）
- 既有 verify 脚本、`.scratch` 驱动与覆盖缺口：`09-existing-verification-and-gaps.md`（LEG-01..33、G1..G12）
- harness 选型、launch 草案、等待/截图/日志约定：`10-harness-strategy.md`
- P0/P1 场景用例目录：`11-scenario-catalog.md`（TC-P0-01..13、TC-P1-01..18）
- 文档地图、阅读顺序与维护规则：`README.md`
- 官方自动化测试四路径原文：`../electron-automated-testing.md`
- 写作契约与 ID 方案：`../AUTHORING-SPEC.md`
