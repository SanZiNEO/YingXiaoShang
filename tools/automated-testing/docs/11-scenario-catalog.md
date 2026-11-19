# 11 · P0/P1 场景用例目录

> 归属：自动化测试场景层（编排 `02`–`10` 各专题文档的事实 ID 为可执行用例）｜ 状态：部分（用例已设计，全部尚未运行）｜ 核对日期：2026-11-18
> 覆盖：`TC-P0-01`…`TC-P0-13`、`TC-P1-01`…`TC-P1-18` 两组用例；每条用例的前置、步骤、观测点、断言、依赖 ID、易碎点、失败取证
> 不覆盖：主进程/IPC/UI/打包/sidecar/领域服务/数据 fixture 的实现细节（一律引用 `02`–`10` 的 ID，不在本篇复述）；harness 四方案选型与 launch 草案（见 `10-harness-strategy.md`）；既有脚本盘点（见 `09-existing-verification-and-gaps.md`）
> 行号截至 2026-11-18。证据等级约定：「依赖 ID」所引实现事实沿用各主文档已标等级；本篇用例的前置可观测性、步骤信号、断言结果、取证方式均为 `[待验证]`（按工作契约未启动 GUI、未跑任何脚本），只有转引自主文档的源码/日志事实标 `[源码]`/`[日志]`/`[实测]`。

## 1. 结论摘要（TL;DR）

1. P0 共 13 条，构成一条可跑通的冒烟主干：隔离启动 → 首窗与 preload 桥 → 一轮完整对话（含流式与结束）→ 对话落库回查 → 一次答题/交卷 → 打开一个产物标签 → 产物导出 → 干净退出；另含 2 条打在打包产物（`win-unpacked`）路径上的用例 `[待验证]`。
2. P1 共 18 条，覆盖设置/降级/取消/离线/溯源/会话/档案/分栏/坏库/双开/标签全集/文件预览/记忆/账本/空库分叉/错误形态等回归面；确定性分级沿用 `07`：纯函数与 DB 读写可等值断言，LLM 与网络场景只断言结构、状态流转与引用可解析 `[源码, 口径见 07 第 1 节]`。
3. 每条用例只引用 `02`–`09` 已定义的非 TC ID（BOOT/WIN/CH/IPC/EVT/UI/FLOW/PKG/EXT/SVC/DATA/LEG），本篇不自创这些前缀的编号；`TC-P0-xx`/`TC-P1-xx` 编号由本篇定义 `[源码, 编号方案见 spec 第 4 节]`。
4. 等待策略全部「等信号」：IPC resolve、DOM 出现、端口 health、文件 mtime、日志行；禁止固定 `sleep` 作主等待条件（口径见 `10-harness-strategy.md#442-等待策略等信号禁止固定-sleep-主策略`）`[源码]`。
5. 渲染层无 `data-testid`（0 处），仅 2 处 `role`、13 处 `aria-label` 与一批业务 `data-*` 钩子；高频交互元素只能靠文本/role/业务钩子定位，是全篇用例共同的易碎源 `[源码, 见 04 第 4.1 节]`。
6. `settings.json` 走 Electron `userData`，不受 `LEARNING_AGENT_HOME` 重定向；并行用例之间共享配置是已知隔离缺口，P1 中涉及设置写入的用例不得并行 `[源码, 见 08 DATA-10]`。
7. 本轮未跑任何用例：下表所有「断言通过/观测到」的预期均为设计口径，不是已验证结论；每条用例的失败取证清单在落地 harness 后回填实测结果 `[待验证]`。
8. 真实 LLM 输出、真实联网抓取、无 test-id 的深层交互、损坏库重置对话框四类场景当前无法端到端自动化，第 2.5 节逐条给出原因与降级方案 `[待验证]`。

## 2. 结构与流程

### 2.1 P0 冒烟主干时序（哪条用例在什么时候跑）

```text
隔离 home 准备（DATA-14a 复制 seed 库 / 或留空首启）
  │
  ├─ TC-P0-01  启动 dev/out，learning:health resolve（BOOT-01 / CH-06 / DATA-01/02 / SVC-01）
  ├─ TC-P0-02  首窗出现；window.learning 桥可用；student.current 返回（WIN-01 / UI-01 / CH-01 / IPC-01）
  ├─ TC-P0-03  发送一轮对话：订阅 chat-event → session/text/tool 事件流 → chat Promise resolve（FLOW-01/02 / CH-03/09 / EVT-01/03 / SVC-21）
  ├─ TC-P0-04  落库回查：chat.sessions / chat.messages 可按 seq 读回（IPC-27/28 / DATA-04 / SVC-20）
  ├─ TC-P0-06  一次答题/交卷：answer-set 返回，questions.attempts 回读判分（FLOW-03 / UI-10 / CH-05 / IPC-13 / SVC-21）
  ├─ TC-P0-05  打开一个产物/文档标签：artifacts.list → artifacts.get → 工作区标签挂载（UI-07/08/09 / FLOW-08 / IPC-19/20 / DATA-13a）
  ├─ TC-P0-13  产物导出：artifacts.export 落盘文件可回读（IPC-21 / SVC-16 / DATA-13a/13b）
  ├─ TC-P0-07  干净退出：before-quit 清理定时器与 sidecar；库句柄释放；home 三件套可删（BOOT-07 / DATA-12b）
  │
  ├─ TC-P0-08  packaged 产物启动首窗 + health（PKG-03/06 / LEG-22）          ┐ packaged 路径
  └─ TC-P0-09  packaged 首启种子库自举落库，区分种子复制 vs 空库建表（PKG-03/04 / DATA-06/07） ┘
  │
  并行/旁路（不打断主干）：
  ├─ TC-P0-10  只读 invoke 契约往返快照（IPC-02/09 / SVC-02 / DATA-04）
  ├─ TC-P0-11  AUTOSTART=0 下启动不阻塞，本地新闻读取正常（EXT-06 / IPC-08/09 / SVC-18）
  └─ TC-P0-12  窗口状态持久化一轮：关闭重开回读 window-state.json（BOOT-05 / WIN-02 / DATA-11）
```

### 2.2 用例总表

> 「主维度」用于第 2.3 节覆盖矩阵；依赖 ID 逐条展开在各用例卡片内。确定性等级：高 = DB/纯函数；中 = 模板/文件排版；低 = LLM/网络（口径见 `07 第 2.2 节`）。

| 用例 | 标题 | 主维度 | 启动路径 | 外部依赖 | 确定性 |
|---|---|---|---|---|---|
| TC-P0-01 | 隔离 home 启动并通过 health 自检 | BOOT/CH/DATA | dev/out | 无（sidecar 关闭） | 高 |
| TC-P0-02 | 首窗出现、preload 桥与学生身份可用 | WIN/UI/IPC | dev/out | 无 | 高 |
| TC-P0-03 | 一轮完整对话：流式事件序列 + chat resolve | FLOW/CH/EVT | dev/out | LLM（或脚本化假 LLM） | 低 |
| TC-P0-04 | 对话落库：会话/消息/轮次可回查 | EVT/IPC/DATA | dev/out | 同 P0-03 | 高（回查面） |
| TC-P0-05 | 打开一个产物/文档标签 | UI/FLOW/IPC | dev/out | 同 P0-03 | 中 |
| TC-P0-06 | 一次答题/交卷并回读判分记录 | FLOW/UI/CH | dev/out | LLM 判分或规则判分 | 低 |
| TC-P0-07 | 干净退出：定时器/子进程清理、句柄释放 | BOOT/EXT/DATA | dev/out | sidecar 关闭 | 高 |
| TC-P0-08 | packaged 产物启动首窗 + health | PKG/BOOT/DATA | packaged | 无 | 高 |
| TC-P0-09 | packaged 首启种子库自举落库 | PKG/DATA | packaged | 无 | 高 |
| TC-P0-10 | 只读 invoke 方法契约往返快照 | IPC/SVC/DATA | dev/out | 无 | 高 |
| TC-P0-11 | 关闭 sidecar 下启动不阻塞、本地新闻可读 | EXT/IPC/SVC | dev/out | sidecar 关闭 | 高 |
| TC-P0-12 | 窗口尺寸/位置持久化一轮 | WIN/BOOT/DATA | dev/out | 无 | 高 |
| TC-P0-13 | 产物导出文件落盘可回读 | IPC/SVC/DATA | dev/out | 无 | 中 |
| TC-P1-01 | 设置读写、BOM/坏 JSON 自愈与公开视图 | CH/DATA/UI | dev/out | 无 | 高 |
| TC-P1-02 | 空题目集降级分支 | FLOW/UI/SVC | dev/out | 无 | 中 |
| TC-P1-03 | 流式取消链路：在途轮次中断 | FLOW/CH/EVT | dev/out | 慢速可中断 LLM/mock | 低 |
| TC-P1-04 | 离线新闻本地读取降级 | IPC/SVC/EXT | dev/out | sidecar 关闭 | 高 |
| TC-P1-05 | AUTOSTART=0 下 news.refresh 可识别 reject | IPC/EXT/SVC | dev/out | sidecar 关闭 | 低（网络面） |
| TC-P1-06 | sidecar 退出后不重建、后续网络调用失败 | EXT/SVC | dev/out | 先起 sidecar 再 kill | 低（网络面） |
| TC-P1-07 | 引用溯源开 news/source 标签 | FLOW/UI/IPC | dev/out | 同 P0-03 | 中 |
| TC-P1-08 | 会话新建与历史切换 | FLOW/IPC/SVC | dev/out | 无 | 高 |
| TC-P1-09 | 档案证据复核与前后测快照 | FLOW/UI/IPC/SVC | dev/out | 无 | 高 |
| TC-P1-10 | 分栏拖拽键盘步进与布局持久化 | FLOW/UI/WIN | dev/out | 无 | 中 |
| TC-P1-11 | 损坏 DB 启动失败分支（可重置/不可重置） | BOOT/DATA/LEG | dev/out | 无 | 高（决策面） |
| TC-P1-12 | 双实例行为观察（单例缺失） | BOOT/WIN/LEG | dev/out ×2 | 无 | `[待验证]` |
| TC-P1-13 | 九种 DocKind 标签逐一打开 | UI/FLOW/IPC | dev/out | 无 | 中 |
| TC-P1-14 | 本地文件预览与打开对话框 | UI/IPC/SVC | dev/out | 本地样本文件 | 高 |
| TC-P1-15 | 记忆事实 upsert/delete 往返 | IPC/SVC | dev/out | 无 | 高 |
| TC-P1-16 | 过程/账本视图与失败重试 | IPC/SVC | dev/out | 无 | 高 |
| TC-P1-17 | 无种子空库首启健康告警分叉 | PKG/BOOT/DATA | dev/out 或 packaged | 无 | 高 |
| TC-P1-18 | 跨 IPC 错误对象形态探针 | CH/SVC/LEG | dev/out | 无 | `[待验证]` |

### 2.3 P0/P1 覆盖矩阵

> 图例：`●` 主打维度（该用例主要断言落在此面）；`◐` 附带观测；`—` 不相关。维度：BOOT 启动/生命周期，WIN 窗口，IPC invoke 方法，CH 通道，EVT 流式事件，UI 页面/面板，FLOW 端到端流程，PKG 打包产物，EXT sidecar/网络，SVC 领域服务，DATA 数据库/fixture，LEG 既有资产复用。矩阵规模：**31 条 TC × 12 维度 = 372 格**。

| 用例 | BOOT | WIN | IPC | CH | EVT | UI | FLOW | PKG | EXT | SVC | DATA | LEG |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| TC-P0-01 | ● | ◐ | ◐ | ● | — | — | — | — | ◐ | ◐ | ● | ◐ |
| TC-P0-02 | — | ● | ● | ◐ | — | ● | — | — | — | — | — | — |
| TC-P0-03 | — | — | — | ● | ● | ◐ | ● | — | — | ◐ | — | — |
| TC-P0-04 | — | — | ● | — | ◐ | — | — | — | — | ◐ | ● | — |
| TC-P0-05 | — | — | ● | — | — | ● | ● | — | — | ◐ | ◐ | — |
| TC-P0-06 | — | — | ◐ | ● | — | ● | ● | — | — | ◐ | — | ◐ |
| TC-P0-07 | ● | — | — | — | — | — | — | — | ◐ | — | ● | — |
| TC-P0-08 | ◐ | ◐ | — | — | — | — | — | ● | — | — | ◐ | ◐ |
| TC-P0-09 | — | — | — | — | — | — | — | ● | — | — | ● | — |
| TC-P0-10 | — | — | ● | ◐ | — | — | — | — | — | ● | ◐ | — |
| TC-P0-11 | ◐ | — | ● | — | — | — | — | — | ● | ◐ | — | — |
| TC-P0-12 | ◐ | ● | — | — | — | — | — | — | — | — | ● | — |
| TC-P0-13 | — | — | ● | — | — | — | — | — | — | ● | ● | — |
| TC-P1-01 | — | — | — | ● | — | ◐ | — | — | — | — | ● | ◐ |
| TC-P1-02 | — | — | — | — | — | ◐ | ● | — | — | ● | — | ◐ |
| TC-P1-03 | — | — | — | ● | ◐ | — | ◐ | — | — | — | — | ◐ |
| TC-P1-04 | — | — | ● | — | — | — | — | — | ◐ | ● | — | — |
| TC-P1-05 | — | — | ◐ | — | — | — | — | — | ● | ● | — | — |
| TC-P1-06 | — | — | — | — | — | — | — | — | ● | ◐ | — | — |
| TC-P1-07 | — | — | ● | — | — | ● | ● | — | — | — | — | — |
| TC-P1-08 | — | — | ● | — | — | — | ● | — | — | ◐ | — | — |
| TC-P1-09 | — | — | ● | — | — | ● | ● | — | — | ● | — | — |
| TC-P1-10 | — | ◐ | — | — | — | ● | ● | — | — | — | — | — |
| TC-P1-11 | ● | — | — | — | — | — | — | — | — | — | ◐ | ◐ |
| TC-P1-12 | ● | ◐ | — | — | — | — | — | — | — | — | — | ◐ |
| TC-P1-13 | — | — | ◐ | — | — | ● | ◐ | — | — | — | — | ◐ |
| TC-P1-14 | — | — | ● | — | — | ● | — | — | — | ◐ | — | — |
| TC-P1-15 | — | — | ● | — | — | — | — | — | — | ● | — | — |
| TC-P1-16 | — | — | ● | — | — | — | — | — | — | ● | — | — |
| TC-P1-17 | ◐ | — | — | — | — | — | — | ● | — | — | ◐ | ◐ |
| TC-P1-18 | — | — | — | ● | — | — | — | — | — | ◐ | — | ◐ |

**空白面自查**：12 个维度均被至少一条用例触及；其中 WIN 仅由 P0-01/P0-02/P0-08/P0-12/P1-10/P1-12 附带覆盖，没有独立的窗口尺寸/最小尺寸/多窗口断言用例；EVT 真实增量序列仅 P0-03/P0-04/P1-03 三条；PKG 仅 P0-08/P0-09/P1-17 三条；LEG 复用面集中在脚本级参考，不作断言主体。

### 2.4 执行顺序建议（与 `10-harness-strategy.md` 方案一致）

> 方案基线：主方案 Playwright `_electron.launch`（见 `10 第 4.3.1 节`）；不另立方案。以下编排沿用 10 的 fixture/等待/截图/日志约定。

**必须串行（同一应用实例内的状态链）**：

- `TC-P0-01 → TC-P0-02 → TC-P0-03 → TC-P0-04 → TC-P0-06 → TC-P0-05 → TC-P0-13 → TC-P0-07`：主干在一个隔离 home、一个应用实例内顺序跑；前一条的 IPC resolve / DB 行 / 标签状态是后一条的前置。
- `TC-P0-08 → TC-P0-09`：packaged 两条在独立临时目录拷贝的 `win-unpacked` 上串行；P0-08 先验启动与 health，P0-09 再验首启自举落库。
- `TC-P1-09`（证据复核/快照写入）与 `TC-P1-15`（记忆写入）若共用同一 fixture home，须串行，避免写竞争污染回读断言。

**可并行（各自独立隔离 home，只读或自造自清）**：

- `TC-P0-10`、`TC-P0-11`、`TC-P1-04`、`TC-P1-14`、`TC-P1-15`、`TC-P1-16`：只读 DB 读取或在各自临时 home 内自造自清，互不依赖会话状态。
- `TC-P1-01`（设置写入）**不进入并行组**：`settings.json` 在 userData、不受 home 隔离（DATA-10 已知缺口），并行会互相覆盖配置；必须独占实例或串行。
- `TC-P1-05`/`TC-P1-06` 依赖 sidecar 端口状态，与其他 EXT 用例共用 8799 隔离端口时串行；各自 home 不同但端口同一，不得同时跑。

**共享 fixture（只读）**：

- seed 库副本（DATA-14a，`release/win-unpacked/resources/seed/learning.db`）作为只读基准被 P0-01/02/05/06/10/12/13、P1-07/08/09/13/14/15/16 复制进各自临时 home；源库只读打开，任何用例不得回写。
- `.scratch` 历史快照（DATA-08，v6）仅作升级/脏数据对照，不作运行 fixture；历史截图（LEG-32）仅人工旁证。

**fixture 回收**：每个用例结束先按 `10 第 4.4.4 节` 抓证据，再删隔离 home（db 三件套 + `artifacts/` + `exports/` + `window-state.json` 一并清理，DATA-12d）；Windows 句柄未释放时 `force + maxRetries`（沿用 LEG-08/11 写法）。

### 2.5 当前无法自动化的用例与降级方案

| 场景 | 受阻原因 | 降级方案 | 关联用例 |
|---|---|---|---|
| 依赖真实 LLM 的具体输出（回复文案、建议条数、出题措辞、匹配理由） | 低确定性，模型输出不可重复；本机凭证与外网可达性未纳入自动化 | 断言收敛到结构与状态流转：字段存在、`citations[].articleId/kpId` 可解析、长度区间、终态枚举；需要流式序列时用脚本化假 LLM（参照 LEG-02/04 的 `slowCtx`/假工具写法），真模型冒烟单独标记并允许失败（G11） | TC-P0-03/04/05/06、TC-P1-03/07 |
| 无 test-id 的深层交互（题目选项、产物卡片、会话条目、浮层菜单） | 渲染层 `data-testid` 0 处；选项/卡片/列表顺序随数据变化，文本与下标均易碎（04 R-2/R-5） | 主断言下沉到 IPC 层（`answer-set` 返回、`artifacts.list/get`、`questions.attempts`）；DOM 只验容器与短标签/业务 `data-*` 钩子；元素级稳定定位需源码补 test-id，属实现改动，待主代理批准（G7） | TC-P0-05/06、TC-P1-02/07/13 |
| 真实联网抓取 46 个启用源 | 依赖外网可达性、WAF/挑战页、3 秒查询预算；代理生效性未实测（06 R-7） | 离线断言本地 DB 读取面（`news.list/get/status`）；抓取/检索链路用本地 fixture 库 + 关闭 sidecar 跑 reject 与降级位；真实源可达性留人工联网轮次回填（06 U4） | TC-P1-04/05/06 |
| 损坏库 → 重置对话框 → `relaunch` 全链路 | 原生对话框按钮点击依赖平台实测；`app.relaunch()` 后环境变量/参数是否继承未验证（02 第 6 节 U3） | 先在主进程 evaluate 层断言 `startupFailure` 决策分类（复用 LEG-12 纯函数）；对话框分支标记为人工/半自动，`[待验证]` 待平台实测后补自动化 | TC-P1-11 |
| 双实例单例行为 | 源码未实现单例锁；第二实例窗口/进程/端口表现无运行证据（02 BOOT-04、G3） | 半自动：harness 拉起第一实例后再 spawn 第二实例，枚举窗口数/进程数/8788 端口；是否补单例锁属实现决策，需主代理拍板 | TC-P1-12 |
| NSIS 安装后路径与 userData 可写性 | 现有产物只验 `win-unpacked`；安装到 Program Files 后的 `resourcesPath`/userData 未实测（05 U4） |  packaged 冒烟先打 `win-unpacked` 拷贝目录；安装包路径列入待验证，不在本篇断言 | TC-P0-08/09 |

## 3. 关键代码位置

> 本篇只列与用例直接相关的锚点；实现细节归属各主文档。

| 职责 | 文件:行 | 函数/锚点 | 关联用例 |
|---|---|---|---|
| 启动装配与失败兜底 | `apps/desktop/src/main/index.ts:44` | `initServices()` | TC-P0-01、TC-P1-11/17 |
| 窗口创建与加载分支 | `apps/desktop/src/main/index.ts:129` | `createWindow()`；`loadURL/loadFile` 判定 `:154-158` | TC-P0-02、TC-P0-08 |
| health 通道注册 | `apps/desktop/src/main/index.ts:529` | `learning:health` handler | TC-P0-01、TC-P0-08、TC-P1-17 |
| chat 通道与事件推送 | `apps/desktop/src/main/index.ts:453,480` | `learning:chat`；`event.sender.send('learning:chat-event')` | TC-P0-03、TC-P1-03 |
| answer-set 通道 | `apps/desktop/src/main/index.ts:509` | `learning:answer-set` handler | TC-P0-06 |
| 退出清理 | `apps/desktop/src/main/index.ts:547,553` | `before-quit`；`window-all-closed` | TC-P0-07 |
| preload 暴露面 | `apps/desktop/src/preload/index.ts:3,9-24` | `exposeInMainWorld('learning', …)`；`invoke/chat/health/onChatEvent` | TC-P0-02、TC-P0-10 |
| 流式状态机纯函数 | `apps/desktop/src/renderer/src/stream-state.ts:48` | `applyStreamEvent` | TC-P0-03/04、TC-P1-03 |
| 发送主流程 | `apps/desktop/src/renderer/src/App.tsx:897` | `send(prompt?)` | TC-P0-03 |
| 交卷流程 | `apps/desktop/src/renderer/src/App.tsx:966` | `handleAnswerSet` | TC-P0-06 |
| 工作区标签与产物分派 | `apps/desktop/src/renderer/src/workspace.tsx:389`；`renderers.tsx:770` | 标签栏；`ArtifactRenderer` switch | TC-P0-05、TC-P1-13 |
| 首启种子复制 | `apps/desktop/src/main/index.ts:71` | 种子候选 `resourcesPath/seed`、`getAppPath/seed` | TC-P0-09、TC-P1-17 |
| DB 打开/迁移/PRAGMA | `packages/db/src/index.ts:819,832,849` | 构造；`foreign_keys/WAL/busy_timeout`；`migrate()` | TC-P0-01/04/10、TC-P1-11 |
| sidecar 拉起与关闭 | `apps/desktop/src/main/news-backend.ts:97,170` | `startNewsBackend()`；`stopNewsBackend()` | TC-P0-07/11、TC-P1-05/06 |
| 窗口状态读写 | `apps/desktop/src/main/window-state.ts:58,98` | `readWindowState()`；`trackWindowState()` | TC-P0-12 |
| 产物落盘与导出 | `packages/artifacts/src/index.ts:106,171` | `create()`；`export()` | TC-P0-05/13 |
| 打包产物布局 | `apps/desktop/electron-builder.yml:12-21` | extraResources；`asar: true` | TC-P0-08/09、TC-P1-17 |

## 4. 可测点（用例卡片）

> 统一字段格式：前置 / 步骤 / 观测点 / 断言 / 依赖 ID / 易碎点 / 失败取证。步骤内「等信号」标明等待对象；断言只收敛到结构、状态、字段存在性与引用可解析。除依赖 ID 转引事实外，全部 `[待验证]`。

### 4.1 P0 冒烟主干

#### TC-P0-01 隔离 home 启动并通过 health 自检

| 字段 | 内容 |
|---|---|
| 前置 | 临时 `LEARNING_AGENT_HOME`（如 `%TEMP%/yxs-test-<stamp>`，目录含 `data/`）；`NEWS_CRAWLER_AUTOSTART=0`、`NEWS_CRAWLER_PORT=8799`、`NEWS_CRAWLER_URL=http://127.0.0.1:8799`；`LEARNING_AGENT_NEWS_REFRESH_MINUTES=60`；不注入 `DEEPSEEK_API_KEY`；dev/out 路径启动；不指向真实用户目录 `[源码, 08 第 5 节]` |
| 步骤 | 1. harness 按 `10 第 4.3.1 节` 草案 launch，env 一次性注入；2. 等 `electronApp.firstWindow()` + `domcontentloaded`；3. 在 Page 内 `await window.learning.health()`，等该 Promise resolve；4. 记录返回体后不发业务请求  [待验证] |
| 观测点 | `learning:health` 返回 `{ ok, warnings[], notices[], appHome }`；`$appHome/data/learning.db` 落盘（文件存在 + mtime）；主进程 console 无未捕获异常行 `[待验证]` |
| 断言 | `ok` 为布尔；`appHome` 等于注入的隔离路径；返回体含 `warnings`/`notices` 数组字段；DB 文件存在且 `user_version=7`、`application_id=1280201284`（只读连接核对）；不断言 warnings 具体文案 `[待验证]` |
| 依赖 ID | BOOT-01（02，启动就绪信号）、CH-06（03，health 通道）、DATA-01、DATA-02（08，库路径与 PRAGMA 基线）、SVC-01（07，DB 构造与版本断言）、LEG-13（09，体检规则纯函数可复用）  [源码] |
| 易碎点 | 冷启动耗时未实测，60s 上限可能不足；health 数据源是 DB 读取，空库/种子库分叉会改变 warnings（05 第 5 节 R-2）；`appHome` 字符串在 dev 与 packaged 解析不同；settings 损坏会带 `configError` 但不阻断启动（02 R-1）  [源码] |
| 失败取证 | 首屏截图；health 入参与返回 payload 落盘；主进程 stdout/stderr 尾部 200 行；隔离 home 三件套只读快照（表计数、`user_version`/`application_id`）；窗口 URL 与 title  [待验证] |

#### TC-P0-02 首窗出现、preload 桥与学生身份可用

| 字段 | 内容 |
|---|---|
| 前置 | 承接 TC-P0-01 同一实例；sidecar 关闭；seed 库已复制（DATA-14a）或首启自举完成  [待验证] |
| 步骤 | 1. 等首窗 DOM 就绪；2. Page `evaluate` 读 `Object.keys(window.learning)` 与 `window.learning.capabilities`；3. 调 `window.learning.invoke('student.current')`，等 resolve；4. 断言根布局三栏挂载  [待验证] |
| 观测点 | `window.learning` 键集（`invoke/chat/health/cancel/onChatEvent/answer/answerSet/settings/capabilities`）；`student.current` 返回对象；根 `div` 下 `aside`/`main` 结构；最小尺寸经主进程 evaluate 读取 `BrowserWindow.getMinimumSize()` `[待验证]` |
| 断言 | 桥对象顶层 9 个键齐全（7 个直接方法 + `settings`/`capabilities` 子对象，口径见 03 第 1 节）；`student.current` 返回含 `studentId/name/cohort` 三字段；最小宽 760、高 560；不依赖任何中文文案命中；`capabilities.localFiles/revealFiles` 为布尔、`downloadArtifacts` 为 `'desktop'` `[待验证]` |
| 依赖 ID | WIN-01（02，最小尺寸常量）、UI-01（04，根三栏布局）、CH-01（03，invoke 通用通道）、IPC-01（03，`student.current` 契约）、DATA-14a（08，seed 库只读 fixture）  [源码] |
| 易碎点 | 无 test-id，根布局只能靠结构与 `aside/main` 标签；`env.d.ts` 声明的 `downloadArtifact` 未暴露（03 R-6），不要误断言该键；窄屏折叠会改变栏数  [源码] |
| 失败取证 | 桥键集 JSON 快照；`student.current` payload；根 DOM 摘录（`body.innerText()` 前 800 字）；首屏截图；主进程 evaluate 的窗口尺寸结果  [待验证] |

#### TC-P0-03 一轮完整对话：流式事件序列 + chat resolve

| 字段 | 内容 |
|---|---|
| 前置 | 承接 TC-P0-02；需要对话流。优先脚本化假 LLM/慢速可中断模型；真模型冒烟单独标记；sidecar 关闭；隔离 home  [待验证] |
| 步骤 | 1. Page 内先 `onChatEvent(handler)` 订阅，收集增量序列（事件 type/agent/tool/text/requestId）；2. 在输入框填入一条固定提示，触发发送（经 `window.learning.chat` 或 UI 发送按钮）；3. 等 `chat` Promise resolve（结束信号是 Promise，不存在 done 事件）；4. 期间记录是否收到 `session` → `round`/`tool`/`text` 序列  [待验证] |
| 观测点 | `learning:chat-event` 增量序列（按 `requestId` 归属）；`chat` resolve 的 `HandleTurnOutput`；`data-streaming="true"` 气泡出现与消失；停止按钮 `data-action="stop"` 出现过 `[待验证]` |
| 断言 | 事件序列含 `EVT-01 session`（带 `sessionId`）；至少一条 `EVT-03 text`（假 LLM 场景可空文本，则断言状态流转正常）；resolve 对象含 `sessionId/turnId/text/artifacts/citations/plan/asks/evidence/ledger/snapshot/warnings` 键；`citations[].articleId/kpId` 可解析（存在时）；不断言回复文案、建议条数、工具数量 `[待验证]` |
| 依赖 ID | FLOW-01（04，发送一轮对话）、FLOW-02（04，流式渲染与取消）、CH-03（03，chat 通道）、CH-09（03，事件推送通道）、EVT-01（03，session 事件）、EVT-03（03，text 事件）、SVC-21（07，对话输出结构与低确定性口径）  [源码] |
| 易碎点 | 流式时序：`text` 分片到达、rAF 渲染；晚到事件按 `requestId` 隔离（04 R-4）；LLM 不确定性；无 test-id，输入框只能靠 `placeholder`/`textarea` 首元素；事件未订阅时消息丢弃；`sessionId` 晚到可能重复建会话（03 R-5）  [源码] |
| 失败取证 | 完整事件序列 JSON（type/agent/tool/text/requestId 逐条）；chat 入参与 resolve/reject payload；流式气泡截图（进行中 + 结束后）；主进程/页面 console error 列表；DB 会话与消息行快照  [待验证] |

#### TC-P0-04 对话落库：会话/消息/轮次可回查

| 字段 | 内容 |
|---|---|
| 前置 | 承接 TC-P0-03 同一实例；隔离 home；不另起会话  [待验证] |
| 步骤 | 1. 从 TC-P0-03 记录的 `sessionId` 调 `chat.sessions`；2. 调 `chat.messages(sessionId)`；3. 必要时调 `agent.turns(sessionId)`；4. 只读核对库表  [待验证] |
| 观测点 | `chat.sessions` 返回数组；`chat.messages` 按 `seq` 有序；`chat_messages` 行 `kind/payload_json`；`turns` 行状态 `[待验证]` |
| 断言 | 目标 `sessionId` 出现在会话列表；消息数组按 `seq` 升序；至少一条 `role=user` 与对应 assistant 消息；消息 `kind` 取值域合法；回查条数与 IPC 返回一致；不断言消息正文 `[待验证]` |
| 依赖 ID | IPC-27（03，`chat.sessions`）、IPC-28（03，`chat.messages`）、DATA-04（08，表清单与字段）、SVC-20（07，快照/轮次/账本投影为高确定性）  [源码] |
| 易碎点 | WAL 未 checkpoint 时另一进程直读可能脏读（DATA-12c）；历史压缩会影响消息可见集；会话 id 归属错误（07 R-5，`student_demo` vs `student_default`）  [源码] |
| 失败取证 | 三个 IPC 返回 JSON；DB 只读导出 `chat_sessions/chat_messages/turns` 目标行；WAL/SHM 文件体积；事件序列与落库消息对照表  [待验证] |

#### TC-P0-05 打开一个产物/文档标签

| 字段 | 内容 |
|---|---|
| 前置 | 承接 TC-P0-03/04；库内已有 artifact（seed 自带 4 条，或本轮生成）；隔离 home  [待验证] |
| 步骤 | 1. 调 `artifacts.list` 取一条产物 id；2. 经 UI 产物卡片点击（或 `openArtifact` 等价入口）打开标签；3. 等工作区标签挂载，`data-tab-id` 出现；4. 调 `artifacts.get(artifactId)` 回读  [待验证] |
| 观测点 | 工作区 `aside` 挂载；标签 `data-tab-id={artifact.id}`；`ArtifactRenderer` 分派分支；`artifacts.get` 返回结构 `[待验证]` |
| 断言 | 标签列表含目标 id；`artifacts.get` 返回含 `id/type/title/format/status/version/schema_version` 字段；产物路径落在 `appHome/artifacts` 内；题目集读取侧已脱敏（不含答案段，07 R-6）；不断言产物标题与正文排版 `[待验证]` |
| 依赖 ID | UI-07、UI-08、UI-09（04，工作区/标签栏/产物分派）、FLOW-08（04，标签开/关/切）、IPC-19、IPC-20（03，`artifacts.list/get`）、DATA-13a（08，产物目录与命名）、SVC-16（07，产物创建/读取与路径校验）  [源码] |
| 易碎点 | 产物卡片无稳定属性，只能靠短标题/结构定位；`page` 类产物在沙箱 iframe 内，主 DOM 选不到（04 R-6）；题目集 `content` 列表读取时重算（IPC-19）；列表顺序随数据变化  [源码] |
| 失败取证 | 标签栏 DOM 摘录（`data-tab-id` 列表）；`artifacts.list/get` payload；工作区截图；iframe 内单独截图；产物目录文件清单与 mtime  [待验证] |

#### TC-P0-06 一次答题/交卷并回读判分记录

| 字段 | 内容 |
|---|---|
| 前置 | 承接 TC-P0-04；库内题目集 artifact 有未判题（seed 自带或本轮生成，必要时用 fixture 构造）；LLM 判分可降级为规则判分；隔离 home  [待验证] |
| 步骤 | 1. 读题目集渲染态（`data-submitted`）；2. 按题目 id 选择答案（选项按钮/简答 textarea）；3. 交卷按钮触发 `answerSet`；4. 等 `learning:answer-set` resolve；5. 调 `questions.attempts` 回读  [待验证] |
| 观测点 | 交卷按钮 disabled 态切换；`data-submitted` 切换；`answer-set` 返回 `AnswerSetOutput`；`question_attempts` 新行 `[待验证]` |
| 断言 | 返回含 `turnId/text/results/ledger/warnings/status`；`results[]` 每题一条；终态 `status∈completed/partial/failed` 合法枚举；`attempts` 回读含目标 `questionId`；`partial/failed` 保留未判题可重试；不断言反馈文案与分数具体值 `[待验证]` |
| 依赖 ID | FLOW-03（04，题目集作答/交卷/重试）、UI-10（04，题目集渲染器）、CH-05（03，answer-set 通道）、IPC-13（03，`questions.attempts`）、SVC-21（07，答题输出结构）、LEG-08（09，attempts 落库与外键可复用断言）  [源码] |
| 易碎点 | 选项顺序来自后端，下标定位易碎（04 R-5）；多选逗号拼接；无 key 时判分降级路径；交卷前未答全的校验；题目集空集走 FLOW-04 分支而非本用例  [源码] |
| 失败取证 | 答题前/后 DOM 摘录；`answerSet` 入参与返回 payload；`questions.attempts` 目标行；判分反馈截图；DB 只读快照  [待验证] |

#### TC-P0-07 干净退出：定时器/子进程清理、句柄释放

| 字段 | 内容 |
|---|---|
| 前置 | 承接主干任一实例；本轮默认 sidecar 关闭（`AUTOSTART=0`）；隔离 home  [待验证] |
| 步骤 | 1. 记录退出前进程/端口状态；2. 触发应用退出（关闭最后窗口或 `app.close()`）；3. 等主进程退出码；4. 检查定时器清理、sidecar kill、home 三件套可删除  [待验证] |
| 观测点 | 主进程退出码；`before-quit` 后无残留 news-crawler 进程；8799 端口释放；`window-state.json` 落盘；home 目录可被 `rmSync(force,maxRetries)` 删除 `[待验证]` |
| 断言 | 主进程正常退出（非未捕获崩溃）；无残留子进程；退出后 DB 三件套句柄释放、目录可删；窗口状态文件含合法 `{x,y,width,height,maximized}`；sidecar 未拉起时无 8788/8799 监听 `[待验证]` |
| 依赖 ID | BOOT-07（02，退出清理与子进程 kill）、DATA-12b、DATA-12d（08，三件套快照与清理）、SVC-01（07，DB 连接关闭基线）  [源码] |
| 易碎点 | Windows 句柄释放有延迟；`stopNewsBackend()` 仅 `child.kill()`，进程组是否完整回收未实测（02 第 6 节 U6）；无崩溃处理器，运行期异常不走进重置分支（02 R-4）  [源码] |
| 失败取证 | 退出码与主进程 stdout/stderr 尾部；端口监听表（`netstat` 快照）；残留进程清单；退出前后 home 目录树；`window-state.json` 内容  [待验证] |

#### TC-P0-08 packaged 产物启动首窗 + health（packaged 路径 ①）

| 字段 | 内容 |
|---|---|
| 前置 | 拷贝 `release/win-unpacked` 到临时目录（参照 LEG-22）；独立隔离 `LEARNING_AGENT_HOME`；`AUTOSTART=0`、端口 8799；executablePath 指拷贝目录内 `营小商.exe`；不安装 NSIS 包  [待验证] |
| 步骤 | 1. harness 以 packaged 模式 launch；2. 等首窗 target（CDP `/json` 找 `type=page` 或 `firstWindow()`）；3. 调 `learning:health()`；4. 主进程 evaluate 读取 `app.getAppPath()`、`process.resourcesPath()`  [待验证] |
| 观测点 | 窗口 URL 位于拷贝目录内 file://；title `营小商`；health 返回；`getAppPath()` 指向 `app.asar`；进程未早退 `[待验证]` |
| 断言 | 窗口出现且未在装配阶段退出；health 返回结构同 P0-01；`getAppPath()` 含 `app.asar`；renderer URL 位于拷贝目录内；asar 内外边界符合 PKG-02；不断言章节计数（空库分叉可能为 0，见 P0-09/P1-17） `[待验证]` |
| 依赖 ID | PKG-03（05，packaged 首启自举观测）、PKG-06（05，运行时路径字符串回填）、BOOT-01（02，启动就绪）、DATA-06（08，种子复制条件）、LEG-22（09，`verify-package.mjs` 离仓启动/CDP 探测可复用）  [源码] |
| 易碎点 | Playwright 对 packaged exe 的主进程 evaluate 能力未实测（10 第 6 节 U2）；asar 内路径磁盘不可直接读；cwd 随启动器变化影响 `.env` 查找（05 R-4）；Electron 44 × Playwright 1.64 兼容未基线验证（10 R-1）  [源码] |
| 失败取证 | CDP target JSON；窗口 URL/title；health payload；主进程 evaluate 的路径四元组；packaged 主进程 stdout/stderr（须接管落盘，替代 LEG-22 的 `stdio:'ignore'`）；截图  [待验证] |

#### TC-P0-09 packaged 首启种子库自举落库（packaged 路径 ②）

| 字段 | 内容 |
|---|---|
| 前置 | 承接 TC-P0-08 同一拷贝；空隔离 home（`data/` 下无 `learning.db`）；现存 `release/win-unpacked/resources/seed/learning.db` 存在（实测 3,448,832 B，v7）  [待验证] |
| 步骤 | 1. 启动前确认 home 无库；2. 启动应用等 health resolve；3. 轮询 `$home/data/learning.db` 出现（文件 mtime 信号，非固定 sleep）；4. 只读打开核对表清单与基线行数；5. 比对种子库与自举库  [待验证] |
| 观测点 | home 下 `data/learning.db` 落盘；`user_version=7`；章节/KP 计数；种子库与自举库大小/行数对照；`resources/seed/learning.db` 在 asar 外侧 `[待验证]` |
| 断言 | 库由种子复制而来（章节 13、KP 228 基线，DATA-07）；`application_id`/`user_version` 正确；首启未覆盖已有数据（本用例 home 为空）；若种子缺失则落入空库建表分叉，health 告警可识别（与 P1-17 区分）；行数口径以只读快照为准 `[待验证]` |
| 依赖 ID | PKG-03、PKG-04（05，首启自举与种子/自举库比对）、DATA-06、DATA-07（08，复制条件与 seed 基线）、DATA-12b（08，三件套快照）  [源码] |
| 易碎点 | 绕过 `package-desktop.mjs` 重新打包可能无种子（05 R-1）；WAL 未 checkpoint 影响复制完整性；种子库版本与 SCHEMA_VERSION 兼容性未核对（05 U5）；空库与种子库分叉 UI 不可区分，只能靠 health/DB 计数  [源码] |
| 失败取证 | 种子库与自举库只读快照（表计数、`user_version`、`application_id`）；两份文件大小/mtime；health 返回 warnings/notices；`resources/` 目录清单；asar 内外边界 `asar list` 结果  [待验证] |

#### TC-P0-10 只读 invoke 方法契约往返快照

| 字段 | 内容 |
|---|---|
| 前置 | 隔离 home + seed 库；sidecar 关闭；无 LLM 依赖；dev/out  [待验证] |
| 步骤 | 1. 经 `window.learning.invoke` 逐个调只读方法：`chapters.list`、`kps.list`（空 query）、`news.status`、`student.current`；2. 记录返回 JSON；3. 与 03 契约表字段比对；4. 未知方法名探针放 P1-18  [待验证] |
| 观测点 | 各 invoke resolve/reject；返回数组/对象形状；DB 表行数与返回条数一致 `[待验证]` |
| 断言 | 返回字段名与 `shared` schema 一致；空库返回 `[]` 而非 reject；`news.status` 的 `count` 为非负整数、空库 `newestFetchedAt=''`；列表顺序与 DB 查询顺序一致；不断言标题文案 `[待验证]` |
| 依赖 ID | IPC-01、IPC-02、IPC-03、IPC-09（03，`student.current`/`chapters.list`/`kps.list`/`news.status`）、SVC-02（07，只读 DB 投影高确定性）、DATA-04（08，表清单基线）、CH-01（03，invoke 通道）  [源码] |
| 易碎点 | 入参类型宽松、静默回退默认值（03 R-4）；空 fixture 与 seed fixture 返回口径不同；部分方法在空库走兜底分支  [源码] |
| 失败取证 | 每个方法的入参/返回 JSON 落盘；对应表只读计数快照；console error；契约字段比对差异清单  [待验证] |

#### TC-P0-11 关闭 sidecar 下启动不阻塞、本地新闻可读

| 字段 | 内容 |
|---|---|
| 前置 | `NEWS_CRAWLER_AUTOSTART=0` 且 `NEWS_CRAWLER_URL=http://127.0.0.1:8799`（无监听）；隔离 home；seed 库含 134 条新闻  [待验证] |
| 步骤 | 1. launch 后等 health resolve；2. 观察主进程日志 `[news]` 前缀告警；3. 调 `news.list`、`news.status` 本地读取；4. 确认无 news-crawler 子进程拉起  [待验证] |
| 观测点 | 应用窗口正常出现；`[news]` 健康检查失败告警行；`news.list/status` 返回库内数据；进程列表无 sidecar `[待验证]` |
| 断言 | 启动不被 sidecar 不可达阻塞；本地读取类方法正常返回库内条目；`news.list` 条数与 `news.status.count` 口径一致；不调用 `news.refresh`（网络面归 P1-05） `[待验证]` |
| 依赖 ID | EXT-06（06，AUTOSTART=0 行为）、IPC-08、IPC-09（03，`news.list/status` 纯本地）、SVC-18（07，新闻本地读取高确定性）、BOOT-01（02，启动不阻塞）  [源码] |
| 易碎点 | `AUTOSTART=0` 不隔离请求，后续 refresh 仍会发 HTTP（06 R-4）；端口 8799 若被旧实例占用会误判健康；定时巡检 60s 首跑可能产生后台告警噪音  [源码] |
| 失败取证 | 主进程 `[news]` 日志行；`news.list/status` payload；端口监听表；进程清单；窗口截图  [待验证] |

#### TC-P0-12 窗口尺寸/位置持久化一轮

| 字段 | 内容 |
|---|---|
| 前置 | 隔离 home；显示器数量与分辨率固定；dev/out  [待验证] |
| 步骤 | 1. 启动后读取当前 bounds；2. 经主进程 evaluate 调整/最大化（或拖拽归 P1-10）；3. 关闭应用触发状态保存；4. 重新启动同一 home，回读 `window-state.json` 与实际 bounds  [待验证] |
| 观测点 | `$appHome/window-state.json` 存在且字段合法；重启后 bounds/最大化态与关闭前一致；损坏/屏外坐标回退默认 `[待验证]` |
| 断言 | 文件字段为有限数且宽高 ≥760×560；重启恢复的位置/尺寸与关闭前一致；最大化时保留还原 normal bounds；不依赖像素级一致（允许窗口管理器偏差） `[待验证]` |
| 依赖 ID | BOOT-05（02，状态持久化回读）、WIN-02（02，最大化/还原 bounds）、DATA-11（08，window-state.json 结构与校验）  [源码] |
| 易碎点 | 300ms 防抖，关闭前立即读文件可能未落盘；显示器热插拔会让旧坐标被判越界丢弃（02 R-5）；窄屏折叠态不存宽度；Electron 窗口管理器偏差  [源码] |
| 失败取证 | 两次启动的 bounds 快照；`window-state.json` 原文；最大化/还原截图；显示器工作区信息  [待验证] |

#### TC-P0-13 产物导出文件落盘可回读

| 字段 | 内容 |
|---|---|
| 前置 | 承接 TC-P0-05；库内已有 artifact；隔离 home；无 LLM 依赖  [待验证] |
| 步骤 | 1. 取一条 artifact id；2. 调 `artifacts.export(artifactId, format)`（`md`/`docx`/`html` 分别覆盖）；3. 等返回 `{ path }`；4. 回读文件存在性、大小与格式  [待验证] |
| 观测点 | 返回绝对路径；`$appHome/artifacts/<studentId>/<YYYY-MM>/` 或 `exports/` 下文件落盘；mtime 更新；md 可文本读、docx 为有效 zip、html 为原件 `[待验证]` |
| 断言 | 文件存在且大小 >0；路径落在 `appHome` 内（越界应抛 `PATH_OUTSIDE_APP`）；format 归一：非法值回退 `docx`；HTML 原件不二次转换；JSON 可解析/CSV 列头固定（如涉题目导出）；不比对排版像素 `[待验证]` |
| 依赖 ID | IPC-21（03，`artifacts.export`）、SVC-16（07，产物落库与 containment 校验）、DATA-13a、DATA-13b（08，产物/导出目录隔离与命名）、IPC-20（03，`artifacts.get` 回读）  [源码] |
| 易碎点 | docx 字节布局受库版本影响，不做等值比对；文件名含时间戳不覆盖；路径 realpath 遍历在符号链接/大小写盘符下未实测（07 R-7）；脱敏口径在读取侧  [源码] |
| 失败取证 | 导出返回 path；目录文件清单与大小；文件头/解压校验结果；artifact 库行快照；截图（如经 UI 导出菜单）  [待验证] |

### 4.2 P1 回归用例

#### TC-P1-01 设置读写、BOM/坏 JSON 自愈与公开视图

| 字段 | 内容 |
|---|---|
| 前置 | 独占实例（settings 不受 home 隔离，不并行）；隔离 home；dev/out  [待验证] |
| 步骤 | 1. `settings.get` 读初始公开视图；2. `settings.set` 写入 `model`（不写真 key 或用测试占位）；3. 回读核对 `hasApiKey/apiKeySource/configError`；4. （可选）外部构造带 BOM/坏 JSON 文件后重启读取，核对自愈口径  [待验证] |
| 观测点 | `settings.get/set` 返回 `PublicSettingsView`；userData 下 `settings.json` 落盘；`configError` 字段；BOM 剥离后读取 `[待验证]` |
| 断言 | 返回含 `hasApiKey/model/apiKeySource/configError?`；写回后无 BOM；坏 JSON 不崩且带 `configError`、`hasApiKey=false`；环境变量 key 不受 `clearApiKey` 影响；不回传密钥本体 `[待验证]` |
| 依赖 ID | CH-07、CH-08（03，settings get/set 通道）、DATA-10（08，settings.json 结构/BOM/编码）、UI-05（04，设置弹窗）、LEG-11（09，`verify-settings-bom.ts` 六组场景可复用）  [源码] |
| 易碎点 | settings 走 userData，并行用例共享同一份配置（08 R-1）；productName 变更会丢配置；`apiKeySource` 判定受环境变量影响；BOM 口径与题目 CSV 相反（08 R-6）  [源码] |
| 失败取证 | 两次 settings 返回 JSON；`settings.json` 原始字节（首字符码点）；console error；设置弹窗截图  [待验证] |

#### TC-P1-02 空题目集降级分支

| 字段 | 内容 |
|---|---|
| 前置 | 构造 questions 为空的题目集 artifact（DATA-14b 直接 SQL 或服务层空结果）；隔离 home；无需 LLM  [待验证] |
| 步骤 | 1. 打开该题目集标签；2. 观察降级分支：`content` 非空走 MarkdownView；为空走两个下一步入口；3. 触发任一 `onAsk` 回到发送链（可选，接 P0-03）  [待验证] |
| 观测点 | 渲染分支；空集两个按钮可见；`emptyQuestionSetAction` 判定结果 `[待验证]` |
| 断言 | 空集不出现死胡同：有可点入口（Markdown 内容或两个下一步按钮）；`data-submitted` 态不误置；schema 校验通过的空集结构合法；不断言按钮文案逐字命中 `[待验证]` |
| 依赖 ID | FLOW-04（04，空题目集降级）、UI-10（04，题目集渲染器）、SVC-07（07，题目校验/归一化高确定性）、LEG-03（09，`verify-empty-question-set.ts` 纯函数可复用）、DATA-14b（08，空集 fixture 造数口径）  [源码] |
| 易碎点 | 空集/部分判分/已交卷三态切换；按钮文案随状态变化；离线兜底题库可能返回非空，需 fixture 固定空集  [源码] |
| 失败取证 | 标签 DOM 摘录；artifact `content`/`content_json` 快照；纯函数判定输出；截图  [待验证] |

#### TC-P1-03 流式取消链路：在途轮次中断

| 字段 | 内容 |
|---|---|
| 前置 | 慢速可中断 LLM/mock（参照 LEG-02 `slowCtx`）；隔离 home；先订阅事件序列  [待验证] |
| 步骤 | 1. 发起一轮 chat，记录 `requestId`；2. 收到首个 `text` 增量后触发 `cancel(requestId)`（停止按钮或 `learning:cancel`）；3. 观察后续事件与 Promise 收口；4. 回查 DB 无半截 artifact/消息  [待验证] |
| 观测点 | `cancel` 返回 `{ cancelled: boolean }`；后续无新增 `text` 增量；chat Promise reject/收口；DB 无半截产物行 `[待验证]` |
| 断言 | cancel 返回结构含 `cancelled`；中断后不再有归属该 `requestId` 的事件；会话/产物表无残缺记录；主进程无在途 Promise 泄漏（可观测范围内）；取消是否真正中断模型 HTTP 请求属待验证项，不在本用例断言 `[待验证]` |
| 依赖 ID | FLOW-02（04，停止按钮与取消）、CH-02（03，cancel 通道）、EVT-01（03，session 事件记 id）、LEG-01、LEG-02（09，canceller 接线与 AbortSignal 进程内断言可复用）  [源码] |
| 易碎点 | 取消是否真正中断在途模型请求未实测（03 R-7、G2）；`signal` 透传只做过源码级断言；UI 提示「没有保存」不等于后端已中止；晚到事件归属判定  [源码] |
| 失败取证 | 取消前后事件序列对照；cancel 与 chat 的 resolve/reject payload；DB 会话/产物/消息快照；主进程日志；停止按钮截图  [待验证] |

#### TC-P1-04 离线新闻本地读取降级

| 字段 | 内容 |
|---|---|
| 前置 | sidecar 关闭；seed 库含新闻与匹配；隔离 home  [待验证] |
| 步骤 | 1. `news.list`（带 `source/since/limit` 过滤）；2. `news.status`；3. 取一篇 `news.get`；4. 核对 matches/ideology 数组  [待验证] |
| 观测点 | 三个方法返回库内结构；文章不存在返 `undefined`；匹配数组可解析 `[待验证]` |
| 断言 | `news.get` 返回 `article/matches/ideology` 三键；`matches[].kp_id` 可在知识点表解析；过滤参数生效；离线状态下不发起 HTTP；不存在文章返 `undefined` 不抛 `[待验证]` |
| 依赖 ID | IPC-08、IPC-09、IPC-11（03，新闻本地三方法）、SVC-18（07，本地读取高确定性）、EXT-10（06，离线降级清单）  [源码] |
| 易碎点 | `news.match` 不经 sidecar 但可能叠加可选 LLM（03 R-3，本用例不调）；匹配缓存内容哈希影响结果；`content_status` 取值域  [源码] |
| 失败取证 | 三方法 payload；新闻/匹配表只读快照；DB 悬空引用检查；console error  [待验证] |

#### TC-P1-05 AUTOSTART=0 下 news.refresh 可识别 reject

| 字段 | 内容 |
|---|---|
| 前置 | `AUTOSTART=0`、URL 指向无监听端口 8799；隔离 home；不真联网  [待验证] |
| 步骤 | 1. 调 `news.refresh`；2. 等待 reject 或降级返回；3. 记录错误对象 message；4. 核对本地 DB 未被刷新链路污染  [待验证] |
| 观测点 | refresh Promise reject（或可识别的失败结构）；错误文案含超时/连接拒绝；`source_runs` 无新增本地产出 `[待验证]` |
| 断言 | 不可达时错误可识别（不崩主进程）；`results/queued/accepted` 字段在降级结构中存在或 reject 被捕获；不断言抓到条数与标题；`backfill` 异常未局部捕获的冒泡行为单独记录（03 R-2） `[待验证]` |
| 依赖 ID | IPC-10（03，`news.refresh`）、EXT-06、EXT-10（06，autostart=0 与离线降级）、SVC-19（07，新闻网络面低确定性）  [源码] |
| 易碎点 | wait=false 入队即返，返回时刻库内不一定有新行（07 R-4）；端口残留旧实例串库（06 R-1）；错误字段跨 IPC 保留范围未实测（接 P1-18）  [源码] |
| 失败取证 | refresh 入参与 reject payload/错误 message；端口 health 探测结果；`source_runs/news_articles` 计数前后对照；主进程 `[news]` 日志行  [待验证] |

#### TC-P1-06 sidecar 退出后不重建、后续网络调用失败

| 字段 | 内容 |
|---|---|
| 前置 | 先允许 autostart 拉起 sidecar（或手动起一个监听 8799 的服务），确认 `/health` 后再 kill 子进程；隔离 home  [待验证] |
| 步骤 | 1. 启动并探活 `/health` 记录 `db_path`；2. 终止 sidecar 进程；3. 观察主进程不退出、仅告警置空引用；4. 再次触发新闻网络调用，观察失败冒泡；5. 不重启应用  [待验证] |
| 观测点 | sidecar 退出后主进程存活；主进程 console 告警行；后续 HTTP 调用 reject；应用重启后才重新拉起 `[待验证]` |
| 断言 | sidecar 非零退出后无自动重建；主进程不因此崩溃；后续网络面调用失败可识别；本地读取仍正常；`/health` 不可达被正确观测 `[待验证]` |
| 依赖 ID | EXT-07（06，崩溃/退出重建策略）、SVC-19（07，新闻服务网络面）、EXT-12（06，共用 SQLite 并发观测）  [源码] |
| 易碎点 | 外部 driver 拿不到 sidecar 句柄与独立日志（10 4.2.3）；需按 PID + 命令行 + `db_path` 三重确认进程身份，避免误杀；Windows 进程组回收行为未实测  [源码] |
| 失败取证 | 退出前后 `/health` 载荷（含 `db_path`）；进程 PID/映像/命令行；主进程告警日志行；失败调用 payload；共享 DB 只读快照  [待验证] |

#### TC-P1-07 引用溯源开 news/source 标签

| 字段 | 内容 |
|---|---|
| 前置 | 承接一轮含 citations 的对话（或 seed 库构造引用）；隔离 home  [待验证] |
| 步骤 | 1. 从消息流/依据列表取一条 citation；2. 触发 `openCitation`；3. 按来源类型分派：news → `news.get` + KP 名补全；textbook/resource → `getBlock`/`getResource` + 片段校验；4. 观察标签打开或失败回落 evidence  [待验证] |
| 观测点 | 标签 `kind=news/source`；`data-source-kind`；片段 `locateSpan` 校验通过/回落 notice；对应 IPC 返回 `[待验证]` |
| 断言 | 可解析引用打开对应标签；`news.get` 的 matches/ideology 齐全；`getBlock` 嵌套 chapter/section 可解析；定位失败回落 evidence 标签并置 notice；不打开 iframe 内元素断言 `[待验证]` |
| 依赖 ID | FLOW-05（04，引用溯源分派与回落）、UI-11、UI-12（04，新闻/原文视图）、IPC-11、IPC-05、IPC-06（03，`news.get`/`getBlock`/`getResource`）  [源码] |
| 易碎点 | 片段校验不一致回落；溯源接口异常同样回落 evidence；iframe 隔离；引用标题来自后端内容  [源码] |
| 失败取证 | citation 入参；分派后标签 DOM 摘录；三个溯源 IPC 返回；回落 notice 截图；DB 引用行快照  [待验证] |

#### TC-P1-08 会话新建与历史切换

| 字段 | 内容 |
|---|---|
| 前置 | 库内已有 ≥2 条会话（seed 自带 2 条或前轮生成）；隔离 home  [待验证] |
| 步骤 | 1. 读 `chat.sessions` / `agent.sessions`；2. 点「新对话」清会话/事件/标签/草稿；3. 点历史会话条目切回；4. 回读当前 sessionId 与消息  [待验证] |
| 观测点 | 会话列表；`sessionId` 变化；标签/事件清空；历史会话高亮态；`chat.messages` 按会话隔离 `[待验证]` |
| 断言 | 新对话后当前 `sessionId` 为空/新建；切换后消息按目标会话加载；会话摘要字段与库一致；事件归属按 `requestId`/会话隔离；不依赖会话标题文案 `[待验证]` |
| 依赖 ID | FLOW-06（04，新建/切换）、IPC-27、IPC-34（03，`chat.sessions`/`agent.sessions`）、SVC-20（07，会话投影高确定性）  [源码] |
| 易碎点 | 会话摘要接口缺失时回退空列表（04 R-1 旁路）；列表顺序随 `updated_at`；会话条目无稳定属性只能靠文本/结构  [源码] |
| 失败取证 | 切换前后会话列表与消息 payload；DOM 高亮态摘录；事件序列归属记录；DB 会话/消息快照  [待验证] |

#### TC-P1-09 档案证据复核与前后测快照

| 字段 | 内容 |
|---|---|
| 前置 | 隔离 home + seed 证据（9 条）；无 LLM 依赖；可与 P1-15 串行  [待验证] |
| 步骤 | 1. 打开档案视图；2. `profile.get`/`profile.evidence` 读证据列表；3. 对一条证据调 `profile.review`（`reviewed/rejected`）；4. `profile.snapshot` 记录前测/后测；5. 回读复核态与快照行  [待验证] |
| 观测点 | 证据条目复核状态标签；`review` 返回 `{ ok: true }`；`growth_snapshots` 新行；快照 `checkpoint∈pre|post` `[待验证]` |
| 断言 | 复核状态/备注落库；不存在 ID 也返回 ok（行为约束，03 IPC-18）；快照行 `checkpoint` 归一合法；证据 `competency_id/student_id` 可解析；合成证据被过滤；不断言成长等级文案 `[待验证]` |
| 依赖 ID | FLOW-07（04，档案复核/快照流程）、UI-04（04，档案视图）、IPC-14、IPC-16、IPC-17、IPC-18（03，`profile.get`/evidence/snapshot/review）、SVC-14（07，画像/快照/记忆高确定性）  [源码] |
| 易碎点 | 证据列表空态分支；复核态标签 `data-match-review` 仅新闻侧；快照重复 checkpoint 走覆盖/比较；外键级联  [源码] |
| 失败取证 | 复核/快照前后 IPC payload；证据与快照表只读快照；档案视图截图；状态标签 DOM 摘录  [待验证] |

#### TC-P1-10 分栏拖拽键盘步进与布局持久化

| 字段 | 内容 |
|---|---|
| 前置 | 宽视图（视口 ≥900）；侧栏/工作区手柄可见；隔离 home  [待验证] |
| 步骤 | 1. 记录初始列宽；2. 聚焦手柄后方向键步进 ±16px（键盘路径优先于指针拖拽）；3. 观察 `data-dragging` 与 localStorage 两键；4. 双击复位；5. （可选）指针拖拽补充，等 `data-dragging` 状态变化  [待验证] |
| 观测点 | 手柄 `[role=separator][data-side=...]`；宽度变化；localStorage `yingxiaoshang.layout.sidebar` / `yingxiaoshang.layout.workspace`；复位后默认比例 `[待验证]` |
| 断言 | 键盘步进后宽度按 16px 量级变化（被 `clampWidth` 收敛后不越界）；两 `separator` 以 `data-side` 区分；双击回到默认；localStorage 键写入；不做像素级等值断言 `[待验证]` |
| 依赖 ID | FLOW-09（04，拖拽/复位/键盘序列）、UI-14、UI-15（04，两个手柄）、WIN-01（02，最小尺寸约束联动）  [源码] |
| 易碎点 | 指针事件 `clientX` 基准是视口 px，手柄定位是根容器 px（04 4.4）；rAF 节流可能丢中间点；窄屏/全屏/无标签时手柄不渲染；ResizeObserver 异步重排；localStorage 归属浏览器 profile，不在 home 内（04 第 6 节 U5）  [源码] |
| 失败取证 | 步进前后宽度与 localStorage 快照；手柄 DOM 属性；拖拽过程截图；布局计算相关日志（如有）  [待验证] |

#### TC-P1-11 损坏 DB 启动失败分支（可重置/不可重置）

| 字段 | 内容 |
|---|---|
| 前置 | 隔离 home；分别准备「损坏 SQLite 文件」与「权限类错误」样本；不指向真实库  [待验证] |
| 步骤 | 1. 放入损坏 DB 启动，观察失败对话框分类；2. （半自动）选择重置分支，核对旧文件改名 `.broken-<stamp>` 与 `relaunch`；3. 权限类样本核对不出现重置按钮；4. 纯函数层复用 LEG-12 断言决策分类  [待验证] |
| 观测点 | 对话框标题/按钮集合；`.broken-*` 改名文件；重启后新库建立；`startupFailure` 返回 `canResetLocalData` `[待验证]` |
| 断言 | 损坏/磁盘满 → 可重置分支；权限/未知 → 不可重置直接退出；改名覆盖主库 + `-wal`/`-shm` 三件；不可重置分支不出现「备份旧数据并重置」；对话框点击部分标记半自动 `[待验证]` |
| 依赖 ID | BOOT-02、BOOT-03（02，损坏库重置/权限错误分支）、DATA-03（08，迁移与版本错误基线）、LEG-12（09，`startupFailure` 纯函数文案与决策可复用）  [源码] |
| 易碎点 | 原生对话框自动化点击依赖平台实测；`relaunch` 后 env/参数是否继承未验证（02 U3）；改名失败弹错误框 exit(1) 分支；运行期崩溃不走进此兜底（02 R-4）  [源码] |
| 失败取证 | 启动失败截图；`startupFailure` 输入/输出；`.broken-*` 文件清单；重启后 DB 快照；主进程退出码与日志  [待验证] |

#### TC-P1-12 双实例行为观察（单例缺失）

| 字段 | 内容 |
|---|---|
| 前置 | 两个独立隔离 home；同一 dev/out 产物；先确认第一实例已就绪  [待验证] |
| 步骤 | 1. 拉起第一实例，记录窗口数/进程数/端口；2. 不经过单例锁直接拉起第二实例；3. 枚举两实例窗口、进程、8788/8799 端口占用；4. 观察第二实例是否被聚焦/拦截  [待验证] |
| 观测点 | 两个 Electron 主进程；窗口数量；端口监听；共享库锁等待/报错；两实例 health `appHome` 各自隔离 `[待验证]` |
| 断言 | 源码层确认无 `requestSingleInstanceLock`（已知事实）；运行态记录实际表现：是否双窗、是否串库、是否锁冲突；本用例不断言「应当单例」，行为结论回填 02 BOOT-04 `[待验证]` |
| 依赖 ID | BOOT-04（02，双开表现待回填）、WIN-01（02，窗口枚举基线）、LEG-18（09，dev/out 启动参数参考）  [源码] |
| 易碎点 | 双实例写同一 SQLite 的 WAL 竞争；端口复用不校验身份（06 R-1）；是否补单例锁属产品决策，需主代理拍板（G3）  [源码] |
| 失败取证 | 两实例进程/窗口清单；端口表；两份 DB 快照；主进程日志；截图  [待验证] |

#### TC-P1-13 九种 DocKind 标签逐一打开

| 字段 | 内容 |
|---|---|
| 前置 | 隔离 home + seed 库；各类标签所需 fixture：artifact 多条、evidence、news、source、本地样本文件；无 LLM 依赖  [待验证] |
| 步骤 | 1. 按 `model.ts:139` 九种 kind 逐一经 `+` 菜单/消息卡片/溯源入口打开；2. 每种等标签挂载 `data-tab-id`；3. 记录渲染分支与关键区块；4. 关闭后激活相邻标签  [待验证] |
| 观测点 | 九种 kind：`artifact/overview/artifacts/evidence/process/files/file/news/source`；标签切换/关闭；各分支区块存在性 `[待验证]` |
| 断言 | 每种 kind 都能打开对应分支（无死胡同）；关闭当前标签后 `activeTab` 回退相邻；overview/artifacts/evidence/process/files 可由列表数据驱动；缺数据的 kind 走 Empty 占位而非崩溃；不断言区块文案 `[待验证]` |
| 依赖 ID | UI-07、UI-08（04，工作区与标签栏）、FLOW-08（04，标签操作）、IPC-19（03，产物列表）、LEG-30（09，历史日志覆盖过的面板计数可作清单参考）  [源码] |
| 易碎点 | 部分 kind 入口依赖上一轮对话产物；iframe 内部不可穿透；列表下标易碎；历史日志脚本已缺失，计数口径仅供参考  [源码] |
| 失败取证 | 每种标签的 DOM 摘录与截图；打开入口 IPC payload；标签状态 JSON；console error/pageerror 列表  [待验证] |

#### TC-P1-14 本地文件预览与打开对话框

| 字段 | 内容 |
|---|---|
| 前置 | 准备样本文件：md/html/text/image/pdf 各一份（置于隔离 home 可访问位置）；隔离 home  [待验证] |
| 步骤 | 1. 经 `files.openDialog` 选定样本文件（对话框取消路径单独断言）；2. 等 `files.preview`/对话框返回 `FilePreview`；3. 按 `kind` 六分支核对；4. 取消对话框返 `undefined`  [待验证] |
| 观测点 | 返回 `{ path, name, kind, content, mime }`；图片/PDF content 为 base64 data URL；未知扩展名 `kind='unsupported'` 且 `content=''`；预览视图挂载 `[待验证]` |
| 断言 | 各扩展名映射到正确 `kind/mime`；不存在/不可读上抛；取消返 `undefined` 不抛；`.docx` 经 mammoth 转 HTML；文件路径可解析；不预览文件内容文本 `[待验证]` |
| 依赖 ID | UI-13（04，本地文件预览视图）、IPC-36、IPC-37（03，`files.preview`/`files.openDialog`）、SVC-27（07，沙箱 FS containment 基线）  [源码] |
| 易碎点 | 原生对话框自动化选择文件的坐标/路径依赖平台；大文件 base64 回传体积；PDF/iframe 隔离；`files.preview` 在桌面渲染层无调用点（04 R-7），需经 harness 直接调 IPC  [源码] |
| 失败取证 | 预览返回 payload（截断 base64 留存元信息）；样本文件清单；预览视图截图；对话框取消路径记录  [待验证] |

#### TC-P1-15 记忆事实 upsert/delete 往返

| 字段 | 内容 |
|---|---|
| 前置 | 隔离 home；无 LLM 依赖；与 P1-09 串行（同 fixture 时）  [待验证] |
| 步骤 | 1. `memory.facts` 读初始；2. `memory.upsert` 写入一条 `{kind,key,value}`；3. 回读确认落库；4. 重复 key 再 upsert 验证不新增行；5. `memory.delete` 后回读不含该 id  [待验证] |
| 观测点 | upsert 返回完整记录（含 `id/updated_at/confidence`）；`memory_facts` 行；delete 后列表不含目标 id `[待验证]` |
| 断言 | `kind` 非法归一 `goal`；重复 key 走 upsert 不新增；delete 对空/不存在 ID 不抛；`value` 为反序列化 JSON；按学生隔离；`value` 结构化克隆失败属 IPC 层错误 `[待验证]` |
| 依赖 ID | IPC-22、IPC-25、IPC-26（03，`memory.facts/upsert/delete`）、SVC-14（07，记忆增删高确定性）  [源码] |
| 易碎点 | 学生 id 两条装配路径不同（07 R-5）；JSON 字段按字符串读再解析；合成 episode 被排除（IPC-23 口径，本用例不涉）  [源码] |
| 失败取证 | 三步 IPC payload；`memory_facts` 表只读快照；console error  [待验证] |

#### TC-P1-16 过程/账本视图与失败重试

| 字段 | 内容 |
|---|---|
| 前置 | 隔离 home；库内有 ledger 行（seed 3 条）；无 LLM 依赖  [待验证] |
| 步骤 | 1. `agent.turns(sessionId)` 读轮次；2. `agent.ledger` 读账本与四类计数；3. 对 `failed/pending` 行调 `agent.retry(sourceId)`；4. 回读 ledger 状态变化与最新 counts  [待验证] |
| 观测点 | turns 行 `status/plan_json/record_json`；ledger `items/counts{summarized,pending,stale,failed}`；retry 后状态迁移 `[待验证]` |
| 断言 | 轮次按会话隔离；`record_json` 含产物/证据引用；ledger counts 与 items 状态一致；retry 后目标行状态从 `failed/pending` 变化；本通道不等待后台重试完成（间接 LLM 链路不在此断言） `[待验证]` |
| 依赖 ID | IPC-31、IPC-32、IPC-33（03，`agent.turns/ledger/retry`）、SVC-20（07，账本/轮次投影高确定性）  [源码] |
| 易碎点 | 后台 recorder 重试后续可能再调模型（IPC-33 间接 LLM）；retry 不等后台完成；ledger 状态枚举取值域；轮次 seq 区间  [源码] |
| 失败取证 | retry 前后 ledger/turns payload；DB `summary_ledger/turns` 快照；过程视图截图；主进程日志  [待验证] |

#### TC-P1-17 无种子空库首启健康告警分叉

| 字段 | 内容 |
|---|---|
| 前置 | 构造两个种子候选都缺失的环境（空隔离 home + 指向无 seed 的 resources 路径，或模拟无种子打包产物）；不覆盖真实用户库  [待验证] |
| 步骤 | 1. 启动应用；2. 等 health resolve；3. 核对空库建表结果：表清单、章节/KP/新闻计数；4. 观察 warnings/notices 分流；5. 对照有种子分叉（P0-09）  [待验证] |
| 观测点 | `data/learning.db` 由构造器建空文件并跑空 SCHEMA；health 章节 0 / KP 0 告警、新闻 0 仅提示；界面仍开窗 `[待验证]` |
| 断言 | 空库迁移成功、`user_version=7`；health 返回告警可识别；不把「章节数 >0」作为本分叉硬断言；空库与种子库分叉可通过计数/health 区分 `[待验证]` |
| 依赖 ID | PKG-05（05，缺失 extraResources 源的打包行为待验证）、DATA-07（08，seed 基线对照）、LEG-13（09，体检规则）、BOOT-01（02，启动就绪）  [源码] |
| 易碎点 | electron-builder 对缺失源是报错还是静默省略未实测（05 R-1）；空库应用照样开窗，只看窗口会漏判；旧 v6 快照不能当空库 fixture（08 R-5）  [源码] |
| 失败取证 | health 返回 warnings/notices 原文；空库表清单与计数；启动日志；与种子库快照对照表；截图  [待验证] |

#### TC-P1-18 跨 IPC 错误对象形态探针

| 字段 | 内容 |
|---|---|
| 前置 | 隔离 home；dev/out；无需真实 LLM  [待验证] |
| 步骤 | 1. 调未知 invoke 方法名，观察 reject message；2. （探针，需主进程侧临时抛带自定义字段的 Error，属一次性诊断不入仓）捕获 renderer 侧 `message/stack/自定义字段`；3. 对照 `friendlyError` 重建口径；4. 记录结构化克隆对 Error 字段的保留范围  [待验证] |
| 观测点 | rejected Promise；`err.message`；`err.stack` 是否存在；自有枚举属性是否保留；各通道（包装/未包装）差异 `[待验证]` |
| 断言 | 未知方法 reject message 含 `unknown learning method:`；断言口径只匹配 message 前缀，不断言 stack/自定义字段透传；`friendlyError` 通道只保留 message；结论回填 03 第 4.2 节探针项 `[待验证]` |
| 依赖 ID | CH-01、CH-03（03，invoke 与 chat 错误传播）、LEG-05（09，`friendlyError` 文案分流可复用）、SVC-02（07，错误收口基线）  [源码] |
| 易碎点 | Error 结构化克隆保留范围随 Electron 版本变化（03 4.2 探针）；探针需要主进程临时抛错代码，调查阶段不落仓；错误文案归一属纯函数，行为形态未实测  [源码] |
| 失败取证 | 各通道 reject 对象字段快照；主进程错误日志；Electron 版本号；探针代码片段（诊断记录，不进仓库源码）  [待验证] |

## 5. 风险与坑

1. **定位标识缺口是全局易碎源**：渲染层 `data-testid` 0 处，高频交互（题目选项、产物卡片、会话条目、浮层）只能靠中文文本/role/业务 `data-*` 钩子；模型或后端内容微调即可能误判。任何 DOM 断言都应下沉到 IPC 返回/DB 行做主断言，DOM 只验容器与短标签（04 R-2/R-5、G7）。`[源码]`
2. **低确定性内容误入断言会造成偶发失败**：chat/answer/出题/匹配/检索链路依赖 LLM 或网络；本目录对这些用例只断言结构、状态流转与引用可解析，不断言文案、条数、分数；需要可重复流时优先脚本化假模型（LEG-02/04 写法），真模型冒烟单独标记（07 第 1 节、G11）。`[源码]`
3. **隔离缺口：settings 不随 home 重定向**：`settings.json` 在 userData，`LEARNING_AGENT_HOME` 只重定向 db/artifacts/exports/window-state；并行用例共享配置，设置写入类用例必须独占实例（DATA-10、08 R-1）。`[源码]`
4. **sidecar 取证盲区与假就绪**：外部 driver 拿不到 sidecar 句柄和独立日志；`/health` 进程存活即 `ok:true`，不代表采集链路健康；端口复用不校验身份，可能串到旧实例的库。新闻面用例必须核对 PID、命令行与 `db_path`，不能只看端口可达（06 R-1/R-8、10 4.2.3）。`[源码]`
5. **打包产物路径与 dev 不可混用**：asar 内文件磁盘不可直接读；`getAppPath()/resourcesPath/cwd/__dirname` 三路径各异；种子库在 asar 外侧。packaged 用例取证必须区分 asar 内/外，不能照搬 dev 的 `out/` 磁盘路径（05 2.6、10 4.2.1）。`[源码]`
6. **WAL 三件套与脏读**：DB 快照/清理必须带齐 `-wal`/`-shm`；活库写入中不要直拷主库比对行数；清理遗漏旁车文件会被旧帧复活（DATA-12b/12d、08 R-4）。`[源码]`
7. **等待信号未固化前的假阴性/假阳性**：既有 `.scratch` 脚本以 1s 文本轮询为主循环（LEG-18/21/23），模型慢响应、HMR 重载、sidecar 未就绪都会误判；本目录步骤一律标明等哪个信号，固定 sleep 仅作兜底（10 4.4.2）。`[源码]`
8. **既有脚本路径漂移与「存在 ≠ 通过」**：14 个 verify 脚本本轮未执行，是否当前全绿属 `[待验证]`；`.scratch` 多数脚本硬编码旧仓库路径，不能直接复用；历史 "passed" 日志是旧仓库运行结果，不作当前通过证据（09 第 5 节）。`[源码]`

## 6. 未覆盖与待验证

1. **全部用例尚未运行**：本篇前置、观测点、断言均为设计口径；启动耗时、IPC 往返形状、DOM 实际可见性、packaged 主进程 evaluate 能力均无运行证据。验证方法：按 `10 第 4.3.1 节` 先跑最小基线实验（launch → `firstWindow()` → `health()` → 截图 → close），通过后再逐条回填 P0 主干结果。`[待验证]`
2. **WIN 维度覆盖薄弱**：仅有最小尺寸、状态持久化、分栏附带观测；无独立的窗口多开/最小化/全屏/跨显示器断言用例。验证方法：基线 harness 稳定后，枚举 `BrowserWindow` 数量与 bounds，补窗口状态矩阵；双开行为见 TC-P1-12。`[待验证]`
3. **EVT 真实增量序列未捕获过**：现有断言只在进程内喂事件纯函数（LEG-14）；真实 `learning:chat-event` 序列顺序、分片大小、晚到事件归属未观测。验证方法：TC-P0-03/P1-03 在 Page 内挂 `onChatEvent` 落盘完整序列，与 `stream-state.ts` 归约结果对照。`[待验证]`
4. **打包产物两条用例依赖现存 `win-unpacked`**：该产物是历史打包结果；干净检出重新打包可能缺种子库（05 2.4 分叉 B）。验证方法：批准打包流程后核对 `resources/seed/learning.db` 存在性与 `user_version=7`；无种子产物走 TC-P1-17 分叉。`[待验证]`
5. **LLM 不可达时对话主循环的完整降级行为**：questions 有离线兜底，research/bp/证据抽取没有；无 Key 下 chat 的事件序列与错误形态未实测。验证方法：隔离 home 不设 Key 启动，捕获 chat-event 与 reject 对象，回填 07 第 6 节 U6 与 TC-P0-03 口径。`[待验证]`
6. **P1-11 对话框与 relaunch 链路**：原生按钮点击、`.broken-*` 改名、`relaunch` 环境继承均未实测；当前只断言到纯函数决策层。验证方法：平台实测后把对话框操作脚本化，或保留为人工验收项。`[待验证]`
7. **九个 DocKind 的 fixture 完备度**：`file`/`source`/`news` 依赖样本文件与溯源数据；seed 库未必覆盖每种分支。验证方法：跑 TC-P1-13 前先按 04 第 2.3 节清单核对各类 fixture 来源，缺数据分支以 Empty 占位断言为准。`[待验证]`
8. **并行隔离边界**：settings 共享之外，localStorage 布局偏好归属浏览器 profile、`student_demo` 默认身份跨路径差异，并行时是否互相影响未验证。验证方法：双临时 home 并行启动，分别回读 settings、localStorage 键与默认学生 id（08 第 8 节 U5）。`[待验证]`

## 7. 交叉引用

- 启动装配、生命周期、失败兜底与窗口状态：`02-main-runtime-and-boot.md#2-结构与流程`（BOOT-01…08、WIN-01/02）
- preload 面、9 条通道、37 个 invoke 契约与流式事件：`03-ipc-and-preload-contract.md#4-可测点`（CH-01…09、IPC-01…37、EVT-01…05）
- 页面/面板/标签、定位现状与端到端流程：`04-renderer-ui-flows.md#22-视图面板标签页总表本篇定义的-ui-xx`（UI-01…16、FLOW-01…09）
- 构建、asar、extraResources 与首启自举：`05-build-package-and-first-run.md#23-electron-builder--nsis-产物布局`（PKG-01…08）
- Python sidecar、端口、健康检查与离线降级：`06-news-sidecar-and-network.md#42-端口健康检查与重建策略ext-04--ext-07`（EXT-01…12）
- 领域服务确定性分级与输入输出：`07-domain-services-and-determinism.md#22-依赖面与确定性总表`（SVC-01…32）
- SQLite 结构、隔离 home、fixture 造数与清理：`08-data-fixtures-and-isolation.md#41-sqlite-结构基线`（DATA-01…15）
- 既有 verify 脚本、`.scratch` 驱动与覆盖缺口：`09-existing-verification-and-gaps.md#45-覆盖矩阵`（LEG-01…33、G1…G12）
- harness 选型、launch 草案、等待/截图/日志约定：`10-harness-strategy.md#43-launch-配置草案`
- 官方自动化测试四路径原文：`../electron-automated-testing.md`
