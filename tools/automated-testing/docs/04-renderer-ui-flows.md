# 04 · 渲染层页面/视图/面板结构、交互流程、可定位元素与状态机

> 归属：Electron 应用渲染层（`apps/desktop/src/renderer/src/`，React 19 + electron-vite）｜ 状态：已完成 ｜ 核对日期：2026-11-18（行号以当前工作区为准）
> 覆盖：`main.tsx`、`App.tsx`、`pages.tsx`、`workspace.tsx`、`renderers.tsx`、`model.ts`、`stream-state.ts`、`question-set.ts`、`markdown.tsx`、`ui.tsx`、`icons.tsx`、`labels.ts`、`client-context.ts`、`layout/columns.ts`、`layout/DragHandle.tsx`、`layout/useViewportWidth.ts`、`styles.css`
> 不覆盖：主进程生命周期与窗口装配（见 `02-main-runtime-and-boot.md`）、IPC 通道与 37 个 `learning:invoke` 方法字段契约（见 `03-ipc-and-preload-contract.md`）、领域服务输入输出与确定性分级（见 `07-domain-services-and-determinism.md`）、数据库与隔离（见 `08-data-fixtures-and-isolation.md`）、harness 驱动选型（见 `10-harness-strategy.md`）。

## 1. 结论摘要（TL;DR）

1. 桌面端渲染层是单根 React 树：`main.tsx` 挂载 `App`，运行时只有两个主视图状态 `'chat' | 'profile'`（`App.tsx:454`），其余内容都是 chat 视图内的浮层、右侧工作区标签页或产物渲染分支。`[源码]`
2. 右侧工作区由 `DocTab[]` 驱动，`DocKind` 共 9 种字符串（`model.ts:139`），每种在 `workspace.tsx` 内容区有独立分支；产物类标签再进入 `ArtifactRenderer` 按 `artifact.type` 二次分派。`[源码]`
3. **实测结论：渲染层没有任何 `data-testid` / `data-test-*`；`role` 仅 2 处（`separator`、关闭标签内层 `button`）；`aria-label` 集中在头部与工作区图标按钮；稳定钩子只有一批业务语义 `data-*` 属性。** 需要在源码补 test-id 才能获得最稳的定位锚点——当前这是事实级缺口，不是既有能力。`[源码]`（grep 证据见第 4 节定位清单）
4. 拖拽分栏基于 Pointer Events：`pointerdown` 记录 `event.clientX`（页面视口 CSS px）为原点，`pointermove` 用 `requestAnimationFrame` 节流回调 `onDrag(dx)`，`pointerup/cancel/lostpointercapture` 收尾；宽度阈值与收敛规则在 `layout/columns.ts`，侧栏/工作区宽度持久化到 `window.localStorage`。`[源码]`
5. 流式状态机是纯函数 `applyStreamEvent`（`stream-state.ts:48`），按 `requestId` 隔离轮次；`text` 只在 `type==='text' && agent==='lead'` 时增量追加，`tool` 事件只更新阶段提示、不清空已出文字；取消按钮走 `learning:cancel` 通道（方法契约见 03）。`[源码]`
6. 题目集作答状态全在 `QuestionSetRenderer` 本地：`selected` 映射记录每题答案（多选逗号拼接），`locked` 由历史判分记录或整体已提交决定；交卷结果分 `completed / partial / failed`，`partial` 与 `failed` 保留未判题可重试。`[源码]`
7. **漂移风险已核实**：`apps/desktop/src/renderer/src/pages.tsx` 与 `packages/ui/src/client/pages.tsx` 内容仅差 import 后缀（`.js`），但 Electron 渲染层的 `App.tsx` 从未 import 前者；`packages/ui` 是 Cordis/DSH web 运行时的客户端贡献（`packages/ui/src/client/index.tsx:16`），不被 Electron 渲染树挂载。桌面端自动化改错 `packages/ui` 文件不会影响本应用界面。`[源码]`
8. 大量按钮只接受内联样式 + 中文文案，无表单 `label` 关联；输入框仅靠 `placeholder` 标识，列表项顺序随数据变化，结构路径与下标定位均不可靠。`[源码]`

## 2. 结构与流程

### 2.1 挂载与分层

```
index.html (#root)
  └─ main.tsx:6 createRoot → <StrictMode><App/></StrictMode>
       App.tsx:430  App()  ── 唯一顶层组件，持有全部会话/产物/标签/布局状态
        ├─ aside  左侧栏（UI-02）
        ├─ main   顶栏（UI-06）+ 对话主视图（UI-03）或 ProfileView（UI-04）
        ├─ DragHandle ×2（UI-14 / UI-15，条件渲染）
        ├─ Workspace（UI-07，tabs.length > 0 且 view==='chat' 时挂载）
        └─ 设置弹窗（UI-05，settingsOpen 时 fixed 覆盖层）
```

preload 暴露面为 `window.learning`（`apps/desktop/src/preload/index.ts:3`），渲染层全部跨层调用都经它转发；通道方向与方法字段见 `03-ipc-and-preload-contract.md`，本文不复述字段。`CH-xx`（通道）与 `EVT-xx`（主进程推流事件）编号由 03 统一分配，本文只引用通道/事件名字符串，不定义编号。

### 2.2 视图/面板/标签页总表（本篇定义的 UI-xx）

> 本节及 2.3、4.5 表内条目证据等级均为 `[源码]`（已逐条 Read 核实行号），下文不再逐行重复标注；另有推断或未跑过的项在第 6 节标 `[待验证]`。

| ID | 名称 | 进入方式 / 触发 | 组件入口 | 主要跨层方法（字符串，编号见 03） | 切换/状态 |
|---|---|---|---|---|---|
| UI-01 | 应用根三栏布局 | 应用首帧即挂载 | `App`（`App.tsx:1240` 根 `div[ref=layoutRef]`，CSS grid 三列） | 无直接调用 | 列宽由 `computeColumns(viewport, effectiveSidebar, workspaceWidth)` 计算（`App.tsx:500`，`columns.ts:27`） |
| UI-02 | 左侧栏 | 首帧渲染；宽视图常显，窄视图按 `narrowExpanded` 开合 | `App.tsx:1252` `<aside>` | `chat.sessions`、`agent.sessions`、`chapters.list`、`agent.suggestions`（`App.tsx:579,601,586,1083`） | 侧栏宽度/收起态见 UI-14；会话高亮由 `sessionId === session.id` 判断（`App.tsx:1291`） |
| UI-03 | 对话主视图（chat） | `view === 'chat'`（默认）；从档案返回、新对话、点历史会话进入 | `App.tsx:1344-1581`（header + 消息流 + 输入区） | `student.current`、`learning:chat`（CH `learning:chat`）、`chat.messages`、`agent.snapshot`、`agent.turns`、`agent.suggestions` 等（见 `refreshAll` `App.tsx:564`） | 空态 / 消息列表 / 等待视图 / 流式视图互斥渲染（`App.tsx:1456,1478,1491`）；`busy`、`queue`、`stream`、`draft` 为本地状态 |
| UI-04 | 学习档案视图（profile） | 左栏「学习档案」按钮 `setView('profile')`（`App.tsx:1311`）；返回按钮 `setView('chat')`（`App.tsx:1339`） | `ProfileView`（`App.tsx:304`，挂载于 `App.tsx:1329`） | `profile.get`、`memory.facts`、`memory.episodes`、`memory.summary`、`agent.ledger`、`profile.review`、`profile.snapshot`（`App.tsx:582-585,1001,1017`） | 与 chat 互斥；证据认可/驳回、前/后测快照为本视图内动作 |
| UI-05 | 设置弹窗 | 左栏「设置」`setSettingsOpen(true)`（`App.tsx:1321`）；取消/保存关闭 | `App.tsx:1643-1697` fixed 遮罩 + 420px 卡片 | `learning:settings:get`、`learning:settings:set`（`App.tsx:741,1099,1114`） | 打开时拉取配置；`apiKey / model / hasApiKey / apiKeySource / configError / settingsSaved` 本地态 |
| UI-06 | 顶栏与两个浮层 | chat 视图头部常显；点击触发展开 | `App.tsx:1345-1451` | 章节浮层只改本地 `scopeOverride`；上下文浮层读本地 `lastTrace / snapshot` | `scopeMenuOpen`、`contextOpen` 两个布尔；点外部或 Esc 关闭（`App.tsx:681-701`）；二者互斥打开 |
| UI-07 | 右侧工作区面板 | `view==='chat' && tabs.length > 0` 挂载（`App.tsx:1607`）；`workspaceFullscreen` 时 `position: fixed; inset: 0` | `Workspace`（`workspace.tsx:279`） | 经 props 回调回到 `App` 再调 IPC（产物/依据/过程/文件/新闻/原文各类，见 2.3） | `activeId` 指向当前标签；空标签时显示占位文案（`workspace.tsx:479`） |
| UI-08 | 工作区标签页栏 | Workspace 头部横排；`+` 菜单新建；点标签切换；点内层 × 关闭 | `workspace.tsx:389-427`，`data-tab-id={tab.id}` | 切换/关闭纯本地 `tabs / activeTab` 状态（`App.tsx:458,461`） | 重复 id 不重复入列；关闭当前标签后 `activeTab` 回退到相邻标签（`App.tsx:1625-1628`） |
| UI-09 | 产物渲染器分派 | 打开任意 `kind==='artifact'` 标签时 | `ArtifactRenderer`（`renderers.tsx:770`，switch 按 `artifact.type`） | 题目集判分走 `learning:answer-set`；其余只读渲染 | 7 个具名分支 + 默认 Markdown/Empty（见 2.3 与第 3 节） |
| UI-10 | 题目集渲染器 | `artifact.type === 'question_set'` | `QuestionSetRenderer`（`renderers.tsx:76`） | 历史判分 `questions.attempts`（`App.tsx:758`）；交卷 `learning:answer-set`（`App.tsx:969`） | 本地 `selected / submitting / submittedLocally`；空集走降级分支（FLOW-04） |
| UI-11 | 新闻原文视图 | 引用来源为 `news` 时开 `kind==='news'` 标签 | `NewsView`（`workspace.tsx:149`） | `news.get`（`App.tsx:848`），匹配知识点名再补 `getKp`（`App.tsx:857`） | 只读；匹配项按钮回跳依据/原文 |
| UI-12 | 教材/资源原文视图 | 引用来源为 `textbook` / `resource` 时开 `kind==='source'` 标签 | `SourceView`（`workspace.tsx:192`，内部分 `data-source-kind="textbook"|"resource"`） | `getBlock` / `getResource`（`App.tsx:785,812`）；定位失败回落 `evidence` 标签 | `locateSpan` 校验引用片段，不一致则置 notice 并回落 |
| UI-13 | 本地文件预览视图 | `kind==='file'`，由文件对话框打开 | `FilePreviewView`（`workspace.tsx:134`） | `files.openDialog`（`App.tsx:885`）；`files.reveal` 打开所在文件夹（`App.tsx:1636`） | 按 `FilePreview.kind` 分 markdown/html/text/image/pdf/unsupported 六分支 |
| UI-14 | 侧栏拖拽手柄 | `!sidebarCollapsed && !workspaceFullscreen` 时渲染（`App.tsx:1585`） | `DragHandle side="sidebar"`（`DragHandle.tsx:33`） | 无；宽度写 localStorage | 拖拽中 `data-dragging="true"`；双击复位；方向键步进 16px |
| UI-15 | 工作区拖拽手柄 | `workspaceOpen && cols.workspace > 0` 时渲染（`App.tsx:1596`） | `DragHandle side="workspace"` | 无；宽度写 localStorage | 同上；合拢/展开阈值见 `columns.ts` |
| UI-16 | 休眠页面集合（Electron 未挂载） | 无入口；源码保留 | `KnowledgePage`/`QuestionPage`/`ResearchPage`/`BpPage`/`LearningSettings`（`pages.tsx:65,361,509,585,672`） | 经 `client-context.ts` 的 `callLearning` 调远程方法（`client-context.ts:76`） | **桌面渲染树不引用本文件**；详见第 5 节风险 R-1 |

### 2.3 DocKind 9 种逐一对照（`model.ts:139`）

`DocKind = 'artifact' | 'overview' | 'artifacts' | 'evidence' | 'process' | 'files' | 'file' | 'news' | 'source'`。

| # | kind 字符串 | 标签标题/副标题 | 打开入口（交互） | 渲染分支（组件/位置） | 内容来源方法（字符串，编号见 03） |
|---|---|---|---|---|---|
| 1 | `artifact` | 产物卡片标题（`artifactTabTitle` `App.tsx:201`）；题目集显示「题目集 · N 题」 | 消息流产物卡片点击（`App.tsx:1173`）；概览/产物列表点击（`workspace.tsx:531,541`）；`openArtifact`（`App.tsx:774`） | `Workspace` 内容区 `active.kind === 'artifact'`（`workspace.tsx:484`）→ `ArtifactRenderer`（`renderers.tsx:770`） | `artifacts.list` 取卡片；`questions.attempts` 取判分；`learning:answer-set` 交卷 |
| 2 | `overview` | 任务概览 / 「当前任务的状态、产物与记录」（`App.tsx:219`，`workspace.tsx:86`） | 顶栏「任务概览」chip（`App.tsx:1445`）；工作区 `+` 菜单（`workspace.tsx:433`）；`openTab('overview')`（`App.tsx:765`） | `workspace.tsx:494-537` | `agent.snapshot`、`agent.ledger`、`news.status`、`artifacts.list`（均在 `refreshAll` 已加载）；刷新按钮 `news.refresh`（`App.tsx:1045`） |
| 3 | `artifacts` | 产物列表 / 「本次对话产生的产物」 | 工作区 `+` 菜单「产物列表」（`workspace.tsx:434`） | `workspace.tsx:538-546` | `artifacts.list` |
| 4 | `evidence` | 依据 / 「本轮引用的知识点与新闻」 | 消息流「依据 N 条」按钮（`App.tsx:1158`）；一轮无产物但有引用时自动打开（`App.tsx:946`）；`+` 菜单；溯源失败回落（`App.tsx:839,843,852,880`） | `workspace.tsx:547-584` | 本轮 `citations`（`lastPayload` `App.tsx:175`）；展示前按需补 `getKp`/`news.get`/`getBlock`/`getResource` 解析名称（`App.tsx:624-647`） |
| 5 | `process` | 过程 / 记录 / 「记录 Agent 的整理水位与轮次」 | 工作区 `+` 菜单「过程 / 记录」（`workspace.tsx:436`） | `workspace.tsx:585-644` | `agent.turns`、`agent.ledger`；失败项「重试」`agent.retry`（`App.tsx:1063`） |
| 6 | `files` | 文件 / 「本地文件与导出」 | 工作区 `+` 菜单「文件」（`workspace.tsx:437`） | `workspace.tsx:645-668` | `artifacts.list`；导出 `artifacts.export`（或浏览器下载 `downloadArtifact`）；`files.reveal` |
| 7 | `file` | 本地文件名；副标题为路径 | `+` 菜单「打开本地文件…」（`workspace.tsx:449`）→ `openLocalFile`（`App.tsx:883`） | `workspace.tsx:669-670` → `FilePreviewView` | `files.openDialog` 返回 `FilePreview`；预览类型见 `model.ts:87` |
| 8 | `news` | 新闻原文 / 「新闻原文与知识点匹配」 | 引用溯源 `sourceType==='news'`（`App.tsx:846-873`） | `workspace.tsx:671-672` → `NewsView` | `news.get`；`getKp` 补知识点名 |
| 9 | `source` | 教材/资源标题（`sourceTabTitle` `App.tsx:240`）；副标题区分教材块/教学指南 | 引用溯源 `textbook`/`resource`（`App.tsx:783,810`） | `workspace.tsx:673-674` → `SourceView` | `getBlock` / `getResource`；`locateSpan` 片段校验 |

补充：`ArtifactRenderer` 内部按 `artifact.type` 的二次分派（`renderers.tsx:772-791`）：`page`→`PageRenderer`（沙箱 `HtmlFrame`）、`question_set`→`QuestionSetRenderer`、`research_design`→`ResearchDesignRenderer`、`bp_outline`→`BpOutlineRenderer`、`case_analysis`→`NewsAnalysisRenderer`、`case_study`→`CaseStudyRenderer`、`growth_card`→`GrowthCardRenderer`，其余默认 `MarkdownView` 或 `Empty`。

### 2.4 关键端到端流程（本篇定义的 FLOW-xx）

| ID | 流程 | 步骤链（组件 → 跨层方法/事件） | 结束/失败分支 |
|---|---|---|---|
| FLOW-01 | 发送一轮对话 | 输入框 `textarea` 或建议词/QuickAsk → `send(prompt?)`（`App.tsx:897`）：置 `busy`、本地先插入 user 消息 → `learning:chat`（CH `learning:chat`）→ 返回 `TurnResponse` → `refreshAll(sessionId)` 重载会话/产物/账本/档案 → 按类型自动开标签（题目集 > 案例精讲 > 页面；否则有引用开 `evidence`）→ `setOverviewUnread(true)` | 异常置 `notice` 并 `refreshAll`；`finally` 清 `busy/stream` 并消费队列（`App.tsx:949-962`） |
| FLOW-02 | 流式进度渲染与取消 | `onChatEvent` 订阅（`App.tsx:726`，CH `learning:chat-event`）→ `session` 事件记 `sessionId`；其余事件交 `applyStreamEvent`（`stream-state.ts:48`）→ 等待视图/流式视图按 `stream.text` 是否为空切换（`App.tsx:1491-1512`）→ 停止按钮 `data-action="stop"` 调 `learning:cancel`（`App.tsx:1221-1226`，CH `learning:cancel`） | 取消后置 notice「这次回答没有保存」；取消是否真正中断模型请求需主进程侧验证（见第 6 节） |
| FLOW-03 | 题目集作答、交卷与重试 | 选项按钮/简答 textarea 写 `selected`（`renderers.tsx:93-101,195-202`）→ 交卷按钮校验 `answeredCount === pendingQuestions.length` → `onSubmitSet` → `handleAnswerSet`（`App.tsx:966`）调 `learning:answer-set` → `refreshAll` + 重载判分记录 | `completed`：本地标记已交卷、展开答案解析；`partial`：提示部分判分、保留未判题可重试；`failed`：notice 提示未计错、可重试；按钮文案随状态切换（`renderers.tsx:250-254`） |
| FLOW-04 | 空题目集降级 | `questions.length === 0` 时 `emptyQuestionSetAction(artifact)`（`question-set.ts:11`）：`content` 非空 → `MarkdownView`；为空 → 两个下一步按钮「重新出这一章的 5 道题」「先讲重点再出题」，均经 `onAsk` 回到 `send`（`renderers.tsx:103-126`） | 无死胡同：空集必须给出可点入口（`question-set.ts:1-7` 注释） |
| FLOW-05 | 引用溯源开标签 | 消息流/依据列表/产物内「查看依据/原文」→ `openCitation`（`App.tsx:837`）：textbook→`openTextbook`，resource→`openResource`，news→`news.get` + 知识点名补全；片段 `locateSpan` 校验通过开对应标签，不通过置 notice 并回落 `evidence` | 接口异常同样回落 `evidence` 标签（`App.tsx:804,831,876`） |
| FLOW-06 | 会话新建 / 切换 | 「新对话」`newChat`（`App.tsx:1071`）清会话/事件/标签/草稿并回到 chat；点历史会话 `loadSession`（`App.tsx:1089`）置 `sessionId` 后 `refreshAll` | 会话摘要接口缺失时 `sessionSummaries` 置空，左栏仍按标题渲染（`App.tsx:603-605`） |
| FLOW-07 | 档案证据复核与快照 | UI-04 内：证据条目「认可/驳回」→ `reviewEvidence` → `profile.review`；「前测快照/后测快照」→ `recordCheckpoint` → `profile.snapshot`；之后 `refreshAll` | 异常进 `notice`（`App.tsx:1009,1024`） |
| FLOW-08 | 工作区标签操作 | 打开（`openTab`/`openArtifact`/溯源）→ 切换 `onActivate`（`workspace.tsx:395`）→ 关闭内层 ×（`workspace.tsx:415-418`，`role="button"`）→ 头部导出菜单/打开文件夹/引用选中文本/全屏切换（`workspace.tsx:302-372`） | 关闭当前标签后激活相邻标签；全屏态退出条件见 `App.tsx:509` |
| FLOW-09 | 分栏拖拽与复位 | `pointerdown` 记原点 → `pointermove` rAF 节流回调 `onDrag(dx)` → `pointerup/cancel/lostpointercapture` 收尾写 localStorage；双击 `onReset`；方向键 ±16px；侧栏窄屏走 `narrowExpanded` 开合 | 宽度被 `clampWidth` 收敛；空间不足工作区轨道归零（`columns.ts:31`） |

## 3. 关键代码位置

| 职责 | 文件:行 | 说明 |
|---|---|---|
| 渲染入口 | `apps/desktop/src/renderer/src/main.tsx:6` | `createRoot(#root)` 挂 `App`，`StrictMode` |
| 顶层组件与全部本地状态 | `apps/desktop/src/renderer/src/App.tsx:430` | `App()`；视图/标签/布局/流式/队列状态集中于此 |
| 视图状态枚举 | `apps/desktop/src/renderer/src/App.tsx:454` | `view: 'chat' \| 'profile'` |
| 标签状态 | `apps/desktop/src/renderer/src/App.tsx:458,461` | `tabs: DocTab[]`、`activeTab` |
| 布局状态与列宽计算 | `apps/desktop/src/renderer/src/App.tsx:464-501` | localStorage 读数、`workspaceOpen`、`computeColumns` |
| 批量刷新（一轮数据装配） | `apps/desktop/src/renderer/src/App.tsx:564` | `refreshAll(sid?)`，10 个并行 invoke + 会话级 3 个 invoke + 引用名补全 |
| 学生身份加载 | `apps/desktop/src/renderer/src/App.tsx:670` | `student.current` |
| 启动自检 | `apps/desktop/src/renderer/src/App.tsx:707` | `learning:health`，结果进 `startupWarning`（独立于 `notice`） |
| 流式事件接线 | `apps/desktop/src/renderer/src/App.tsx:725` | `onChatEvent` 订阅；`session` 事件记 `sessionId`，其余交纯函数 |
| 打开标准标签 | `apps/desktop/src/renderer/src/App.tsx:765` | `openTab(kind)`；开 `overview` 清未读圆点 |
| 打开产物标签 | `apps/desktop/src/renderer/src/App.tsx:774` | `openArtifact`；题目集顺带 `loadAttempts` |
| 教材/资源溯源 | `apps/desktop/src/renderer/src/App.tsx:783,810` | `openTextbook` / `openResource`，片段校验 |
| 引用溯源分派 | `apps/desktop/src/renderer/src/App.tsx:837` | `openCitation`，失败回落 `evidence` |
| 本地文件对话框 | `apps/desktop/src/renderer/src/App.tsx:883` | `files.openDialog` |
| 发送主流程 | `apps/desktop/src/renderer/src/App.tsx:897` | `send`；队列、busy、requestId、自动开标签 |
| 交卷流程 | `apps/desktop/src/renderer/src/App.tsx:966` | `handleAnswerSet`，`completed/partial/failed` 分支 |
| 证据复核 | `apps/desktop/src/renderer/src/App.tsx:998` | `reviewEvidence` → `profile.review` |
| 快照记录 | `apps/desktop/src/renderer/src/App.tsx:1014` | `recordCheckpoint` → `profile.snapshot` |
| 产物导出 | `apps/desktop/src/renderer/src/App.tsx:1029` | 浏览器下载或 `artifacts.export` |
| 新闻刷新 | `apps/desktop/src/renderer/src/App.tsx:1043` | `news.refresh` |
| 账本重试 | `apps/desktop/src/renderer/src/App.tsx:1060` | `agent.retry` |
| 新对话 / 加载会话 | `apps/desktop/src/renderer/src/App.tsx:1071,1089` | `newChat` / `loadSession` |
| 助理消息渲染 | `apps/desktop/src/renderer/src/App.tsx:1127` | `renderAssistant`：Markdown、反馈、引用、产物卡片、QuickAsk、思考题 |
| 停止按钮与耗时 | `apps/desktop/src/renderer/src/App.tsx:1216` | `stopControls`；`data-action="stop"`；elapsed 计时 |
| 左侧栏 JSX | `apps/desktop/src/renderer/src/App.tsx:1252` | 品牌、新对话、会话列表、档案入口、设置入口 |
| 档案视图 | `apps/desktop/src/renderer/src/App.tsx:304` | `ProfileView`；挂载点 `:1329` |
| 顶栏与浮层 | `apps/desktop/src/renderer/src/App.tsx:1345` | 侧栏开关、章节菜单、上下文浮层、概览 chip |
| 空态建议 | `apps/desktop/src/renderer/src/App.tsx:1456` | 建议词优先 `suggestions.items`，否则 `SUGGESTIONS` 兜底（`:159`） |
| 消息流渲染 | `apps/desktop/src/renderer/src/App.tsx:1478` | user/assistant 分支；`data-message-role` |
| 等待/流式视图 | `apps/desktop/src/renderer/src/App.tsx:1491` | 有正文走流式气泡，无正文走步骤提示 |
| 输入区 | `apps/desktop/src/renderer/src/App.tsx:1526` | 队列条、`textarea`、Enter 发送 / Shift+Enter 换行、发送按钮 |
| 两个手柄挂载 | `apps/desktop/src/renderer/src/App.tsx:1585,1596` | sidebar / workspace `DragHandle`，条件渲染 |
| Workspace 挂载 | `apps/desktop/src/renderer/src/App.tsx:1607` | 全部 props 回调接线 |
| 设置弹窗 | `apps/desktop/src/renderer/src/App.tsx:1643` | Key/模型/清除本机 Key |
| 工作区组件 | `apps/desktop/src/renderer/src/workspace.tsx:279` | `Workspace`；标签栏 `:389`；内容分支 `:484-677` |
| 文件预览 | `apps/desktop/src/renderer/src/workspace.tsx:134` | `FilePreviewView` 六类分支 |
| 新闻视图 | `apps/desktop/src/renderer/src/workspace.tsx:149` | `NewsView` |
| 原文视图 | `apps/desktop/src/renderer/src/workspace.tsx:192` | `SourceView`，textbook/resource 两分支 |
| 产物分派 | `apps/desktop/src/renderer/src/renderers.tsx:770` | `ArtifactRenderer` switch |
| 题目集渲染 | `apps/desktop/src/renderer/src/renderers.tsx:76` | `QuestionSetRenderer`；空集 `:103`；提交 `:227` |
| 流式状态机 | `apps/desktop/src/renderer/src/stream-state.ts:48` | `applyStreamEvent`；事件类型 `:16`；工具文案 `:30` |
| 空集判定纯函数 | `apps/desktop/src/renderer/src/question-set.ts:11` | `emptyQuestionSetAction`：`markdown \| retry` |
| 列宽阈值与收敛 | `apps/desktop/src/renderer/src/layout/columns.ts:7-36` | 常量 + `clampWidth` + `computeColumns` |
| 手柄事件序列 | `apps/desktop/src/renderer/src/layout/DragHandle.tsx:50,61,72,88` | down/move/finish/keydown；元素 `:97-114` |
| 视口宽度观察 | `apps/desktop/src/renderer/src/layout/useViewportWidth.ts:8` | `ResizeObserver` + rAF 节流，首帧直读 `getBoundingClientRect` |
| 客户端上下文（休眠路径） | `apps/desktop/src/renderer/src/client-context.ts:76,99,107` | `callLearning` / `startPreset` / `panel`，仅被 `pages.tsx` 引用 |
| 共享 UI 原语 | `apps/desktop/src/renderer/src/ui.tsx:14,55,188` | `Page` / `Button` / `HtmlFrame`（sandbox + CSP） |
| Markdown 渲染 | `apps/desktop/src/renderer/src/markdown.tsx:35` | 自研轻量解析（标题/列表/表格/代码块/引用/加粗/行内码/链接） |
| 受控枚举中文标签 | `apps/desktop/src/renderer/src/labels.ts:3,28,36` | 章节/阶段/意图/决策/状态/标签角色映射，禁止渲染裸枚举 |
| DocKind / DocTab 类型 | `apps/desktop/src/renderer/src/model.ts:139,141` | 9 种 kind；标签携带 artifactId/file/news/source |

## 4. 可测点与定位策略（硬要求）

### 4.1 定位属性实测清单（grep 全渲染层，截至 2026-11-18）

检索范围：`apps/desktop/src/renderer/src/`（含 `layout/`）；另核对 `index.html`。

| 类别 | 实测结论 | 位置与取值 |
|---|---|---|
| `data-testid` | **0 处**。全层未出现 `data-testid`。 | grep 无命中 `[源码]` |
| `data-test-*` | **0 处**。无 `data-test-` 前缀属性。 | grep 无命中 `[源码]` |
| `role` | **仅 2 处**：① 两个拖拽手柄 `role="separator"`（`DragHandle.tsx:101`）；② 标签关闭按钮内层 `<span role="button">`（`workspace.tsx:413`）。 | 其余元素无显式 `role` `[源码]` |
| `aria-label` | 有，集中在图标按钮：侧栏开关（`App.tsx:1349`，文案随态切换「展开侧栏/收起侧栏」）、上下文（`:1397`）、浮层关闭（`:1410`）、任务概览（`:1443`）、未读圆点（`:1449`）、发送（`:1570`，随态「排队/发送」）、导出（`workspace.tsx:310`）、打开所在文件夹（`:348,353`）、引用选中文本（`:360`）、全屏/还原（`:369`）、`+` 菜单（`:429`，值为 `"+"`）、难度仪表（`renderers.tsx:59`，值随难度变化）。 | `[源码]` |
| 语义 `name` / 表单 label | 无 `<label htmlFor>` 关联；`TextInput/TextArea/Select`（`ui.tsx:107,124,141`）只靠包裹 `<label>` 文本或 `placeholder`；对话输入框仅 `placeholder="说说你现在想解决什么…"`（`App.tsx:1559`）。 | `[源码]` |
| 业务语义 `data-*` 钩子（非 test-id，但可作次级锚点） | `data-message-role="user|assistant"`（`App.tsx:1136,1481`）、`data-streaming="true"`（`:1493`）、`data-action="stop"`（`:1220`）、`data-quick-ask="true"`（`:259`）、`data-notice="startup"`（`:1516`）、`data-tab-id={tab.id}`（`workspace.tsx:393`）、`data-submitted="true|false"`（`renderers.tsx:130`）、`data-match-review="reviewed|auto"`（`:465`）、`data-review-badge`（`:472`）、`data-case-kp-name`（`:606`）、`data-source-kind="textbook|resource"`（`workspace.tsx:201,236`）、`data-side="sidebar|workspace"` + `data-dragging`（`DragHandle.tsx:99,100`）。 | `[源码]` |
| CSS class | 极少：仅 `entry-chip`、`entry-chip__dot`、`resize-handle`、`menuStyle` 等内联对象外的少量 class（`styles.css:79,111,139`；`App.tsx:1442,1449`）；绝大多数样式是内联 `style={{...}}`，无稳定 class 可钩。 | `[源码]` |

**事实级结论（非重构建议）**：当前源码没有 test-id；要获得「元素级、文案无关」的稳定定位，需要在源码补充 test-id。在补齐之前，自动化只能在下列档位里取舍。

### 4.2 定位手段优先级与本项目可得性

| 优先级 | 手段 | 本项目可得性 | 可用对象举例（源码位置） |
|---|---|---|---|
| 1 | test-id（`data-testid`） | **不可用**：源码未添加，无任何锚点。 | —（缺口，见第 6 节） |
| 2 | role + 可访问名 | **部分可用**。`separator` 有 2 个且共享同一 `aria-label="拖动调整宽度"`，必须再用 `data-side` 区分；`role="button"` 的关闭 span 无名称，需结合 `data-tab-id` 父级；普通按钮默认 `role=button`，名称取中文文案或 `aria-label`。 | 手柄 `[role=separator][data-side=workspace]`；发送按钮 `aria-label`；概览 chip `aria-label="任务概览"` |
| 3 | 稳定可见文本（精确/正则） | **部分可用**。短按钮文案相对稳定：「新对话」「发送/排队」「停止」「交卷/已交卷/判题中…/重试未判题目」「全屏/还原」「导出」「打开所在文件夹」；长标题、产物名、新闻标题、模型生成正文不可靠。 | 左栏「新对话」`App.tsx:1265`；交卷按钮 `renderers.tsx:250-254` |
| 4 | 业务 `data-*` 钩子 | **可用但语义有限**：能定位消息角色、流式态、标签、提交态、审核态、来源类型、手柄侧别；不能定位具体某条产物/某道题（值多为枚举，不含业务 id）。 | `data-tab-id`、`data-message-role`、`data-submitted`、`data-source-kind` |
| 5 | 结构路径 / 列表下标 | **脆弱，不建议作为主断言**。消息流、产物列表、知识点列表都随数据增减；卡片内 `section/div/span` 嵌套深且内联样式无 class。 | 仅在 1–4 均不可得时兜底，并显式等待目标文本出现 |
| 6 | 绝对坐标 / 视口像素 | **最末档，不推荐**。窗口尺寸、侧栏/工作区宽度、窄屏重排都会改变坐标；拖拽场景除外（见 4.4）。 | — |

### 4.3 不应依赖的选择器（及原因）

- **CSS class 选择器**：大部分元素无 class，已有 class 是样式钩子（`entry-chip` 等），改名/换肤即失效；内联样式不产生可复用类名。`[源码]`
- **绝对坐标点击/拖拽**：坐标随窗口宽高、三栏宽度、窄屏自动折叠变化；本项目窗口最小尺寸与持久化布局见 `02-main-runtime-and-boot.md` / `08-data-fixtures-and-isolation.md`。`[源码]`
- **列表下标（第 N 个按钮 / `nth-child`）**：会话列表、产物列表、引用列表、题目列表都按后端数据动态渲染，空态/部分态会改变下标；题目卡片 `key` 优先用 `question.id`，缺省才回退下标（`renderers.tsx:147`）。`[源码]`
- **易变中文长文案**：产物标题、新闻标题、案例讲解、解析、`notice` 提示由模型或后端拼接，低确定性；只应断言短标签或结构化枚举。`[源码]`
- **`nth-of-type` / 深层结构路径**：JSX 嵌套层级随迭代调整；Markdown 表格/列表由 `markdown.tsx` 动态生成，节点顺序依赖正文结构。`[源码]`
- **iframe 内部选择器穿透主页面**：`HtmlFrame`（`ui.tsx:188`）与 PDF `<iframe>`（`workspace.tsx:144`）是独立文档，主页面 locator 选不到内部元素；需按 frame 上下文进入。`[源码]`

### 4.4 拖拽分栏自动化要点（FLOW-09）

指针事件序列与坐标基准（`DragHandle.tsx`）：

1. `pointerdown`（`:50`）：仅响应左键 `event.button === 0`；`preventDefault()`；`originRef = event.clientX`、`latestRef = event.clientX`；`setPointerCapture(pointerId)`；回调 `onStart()`。
2. `pointermove`（`:61`）：未激活直接返回；`latestRef = event.clientX`；用 `requestAnimationFrame` 合并帧，回调 `onDrag(latestRef - originRef)`，**`dx` 是两个 `clientX` 之差（页面视口 CSS px），不是相对手柄的归一化比例**。
3. `finish`（`:72`，绑 `pointerup / pointercancel / lostpointercapture`）：取消未执行的 rAF，补一次 `onDrag`，回调 `onEnd()`，释放 pointer capture。
4. 键盘路径（`:88`）：聚焦后 `ArrowLeft/Right` 触发一次 `onStart → onDrag(∓16) → onEnd`；双击触发 `onReset`。

坐标基准换算：手柄 `style.left` 是相对根容器的 px（`App.tsx:1588` 传 `cols.sidebar`；`:1599` 传 `viewport - cols.workspace`），而事件读数是 `clientX`（相对浏览器视口）。harness 若只持有归一化（0–1）相对坐标，必须先 `boundingBox()` 取手柄与根容器位置再换算；直接用相对比例派发 Pointer Event 会因 `clientX` 基准不符而漂移。

阈值与持久化（`columns.ts`、`App.tsx`）：

- 侧栏：`SIDEBAR_MIN 200 / MAX 320 / DEFAULT 240`，`SIDEBAR_AUTO_COLLAPSE 900`（视口 < 900 走窄屏 `narrowExpanded` 开合，不存宽度）；拖拽结果写 localStorage 键 `yingxiaoshang.layout.sidebar`（`App.tsx:107,524`）。
- 工作区：`WORKSPACE_MIN 360`、`WORKSPACE_MAX_RATIO 0.62`、`DEFAULT_RATIO 0.42`；空间不足（`available < WORKSPACE_MIN`）轨道归零（`columns.ts:31`）；偏好可存 `{ratio}` 或 `{px}`，键 `yingxiaoshang.layout.workspace`（`App.tsx:108,130-157,556`）；双击复位为默认比例。
- `CENTER_MIN 480`：空间不足时先压缩工作区，中心列才允许跌破最小值（`columns.ts:27-35`）。

为什么天然不稳：①  move 回调经 rAF 节流，合成事件若不按帧等待可能丢中间点；② pointer capture 把手柄外的移动也捕获到手柄，坐标仍以 `clientX` 计；③ 宽度被 `clampWidth` 收敛，拖到边界外不会报错也不会越界；④ `useViewportWidth` 经 `ResizeObserver` 异步回调，首帧后布局可能二次重排；⑤ 窄屏/全屏/无标签等条件会让手柄整体不渲染（`App.tsx:1585,1596`）。自动化优先走键盘方向键（步进确定）或直接断言 `data-side` + 宽度文本；指针拖拽仅作补充并需等待 `data-dragging` 状态变化。

### 4.5 可测点表

| ID | 触发方式 | 观测点（DOM / IPC 返回 / 本地状态） | 前置条件 |
|---|---|---|---|
| UI-01 | 首帧加载 | 根 grid 三列；`aside` / `main` / 工作区 aside 数量随标签数变化 | 应用启动，学生身份加载完成 |
| UI-02 | 进入 chat 视图 | 会话列表按钮（文本 `session.title || '未命名对话'`）；「学习档案」「设置」入口 | `chat.sessions` 返回非空更易断言 |
| UI-03 | 发送消息 | 输入框 `textarea`；消息气泡 `data-message-role="user|assistant"`；发送按钮 `aria-label` | 非 busy；草稿非空 |
| UI-04 | 点「学习档案」 | 视图切换为 `ProfileView`；「← 回到对话」按钮；能力维度/证据账本区块标题文本 | `profile.get` 等已返回 |
| UI-05 | 点「设置」 | fixed 遮罩 + 卡片；Key 密码框、模型输入、保存/取消 | `settingsOpen` |
| UI-06 | 点章节按钮 / 上下文按钮 | 两个浮层菜单；Esc 或点外部关闭；互斥展开 | chat 视图 |
| UI-07 | 打开任一标签 | Workspace aside 挂载；头部标题/副标题；空态占位文案 | `tabs.length > 0` |
| UI-08 | 点标签 / × / `+` 菜单 | `data-tab-id` 列表；激活标签描边；关闭后 `activeTab` 回退 | 至少 1 个标签 |
| UI-09 | 打开产物卡片 | `ArtifactRenderer` 分支与产物类型标签；空产物回落 Markdown/Empty | 产物数据已加载 |
| UI-10 | 打开题目集 | `data-submitted`；选项按钮/简答 textarea；交卷按钮文案与 disabled 态 | 题目集 artifact |
| UI-11 | 打开新闻标签 | 标题/来源/日期/正文；匹配知识点条目按钮 | `news.get` 返回 detail |
| UI-12 | 打开原文标签 | `data-source-kind`；引用 blockquote；教材块/指南分区 | 溯源校验通过 |
| UI-13 | 打开本地文件 | 按 kind 渲染 markdown/pre/img/iframe/Empty | 对话框返回文件 |
| UI-14 | 拖侧栏手柄 | `[role=separator][data-side=sidebar]`；宽度写 localStorage | 宽视图、侧栏未折叠 |
| UI-15 | 拖工作区手柄 | `[role=separator][data-side=workspace]` | 工作区轨道 > 0 |
| FLOW-01 | 输入并发送 | 本地 user 消息先上屏；`learning:chat` 返回后 `refreshAll`；自动打开产物/依据标签；`overviewUnread` 圆点 | 学生身份存在，非 busy |
| FLOW-02 | 一轮进行中 | 流式气泡 `data-streaming="true"`；步骤提示文案；`data-action="stop"` 出现；elapsed ≥3 秒显示耗时 | busy |
| FLOW-03 | 选择答案并交卷 | `selected` 变化；提交后 `data-submitted` 切换；参考答案/解析展开；notice 正确/部分/失败文案 | 题目集有未判题 |
| FLOW-04 | 空题目集 | 内容非空走 Markdown；为空走两个 `onAsk` 按钮；无死胡同文案 | 题目集 questions 为空 |
| FLOW-05 | 点引用条目 | 开 `news/source` 标签；失败回落 `evidence`；notice 出现无法定位提示 | 存在 citations |
| FLOW-06 | 新建/切换会话 | `sessionId` 变化；事件/标签清空；历史会话高亮态 | 已有会话列表 |
| FLOW-07 | 档案内认可/驳回/快照 | `profile.review` / `profile.snapshot` 调用；列表状态标签刷新 | UI-04 内 |
| FLOW-08 | 标签开/关/切/全屏/导出/引用 | `tabs`/`activeTab` 变化；全屏 fixed 覆盖层；导出菜单三项；引用写入草稿 | 工作区已打开 |
| FLOW-09 | 拖拽/双击/键盘调宽 | `data-dragging`；localStorage 两键；双击复位默认；方向键 ±16px | 手柄可见 |

## 5. 风险与坑

- **R-1 双实现漂移 + 休眠拷贝，改错文件不生效（实测已核实）**。`apps/desktop/src/renderer/src/pages.tsx`（31155 字节）与 `packages/ui/src/client/pages.tsx`（31161 字节）逐行对比，差异仅 import 后缀（`.js` 有无），业务代码一致；`client-context.ts` 两份零差异；`ui.tsx` 两份差 30 行（desktop 版含 `HtmlFrame` 沙箱 CSP 实现，`packages/ui` 版缺失该段）。**桌面 Electron 渲染树只挂 `App.tsx`**：grep 全渲染层，`pages.tsx` 的 5 个页面组件、`client-context.ts` 的 `callLearning/startPreset/panel` 仅被彼此引用，`App.tsx` 未 import；`electron.vite.config.ts:51-53` renderer 段无 alias，`index.html` 入口仅 `/src/main.tsx`。`packages/ui` 是 Cordis/DSH web 运行时贡献（`packages/ui/src/client/index.tsx:16` 的 `apply(ctx)`，经 `packages/bundle/cordis.patch.yml:56` 装载），桌面端不挂载。结论：为 Electron UI 写自动化或改定位锚点，只能改 `apps/desktop/src/renderer/src/`；改 `packages/ui` 不影响桌面界面。`[源码]`
- **R-2 无 test-id，最稳档位空缺；现有锚点语义覆盖不全**。第 4.1 节已实测：0 个 `data-testid`/`data-test-*`，`role` 仅 2 处，`aria-label` 只覆盖图标按钮。题目选项、消息正文、会话条目、产物卡片等高频交互元素没有任何稳定属性，只能靠中文文本或结构；模型生成文案变化时断言易碎。事实缺口：需要在源码补 test-id 才能做元素级稳定定位（本文只陈述缺口，不展开重构方案）。`[源码]`
- **R-3 拖拽坐标基准与异步节流导致模拟不稳**。事件读数是 `clientX`（视口 px），手柄定位是相对根容器 px；rAF 节流 + pointer capture + 阈值 clamp + ResizeObserver 重排叠加，合成 pointer 序列若直接给归一化相对坐标，落点与宽度都可能偏。两个 `separator` 还共用同一 `aria-label`，必须用 `data-side` 区分。详见 4.4。`[源码]`
- **R-4 流式时序与晚到事件**。`applyStreamEvent` 按 `requestId` 隔离（`stream-state.ts:52`）；不属于当前轮的事件保持原状态。UI 层 `busy`、`stream`、`queue`、`activeRequestRef` 多态并存，断言「回答结束」应等 IPC resolve 或 `busy===false`，不能只看正文停止增长；取消后界面提示「没有保存」，但是否真正中断后端模型请求属于主进程/LLM 层，UI 层无法自证（见第 6 节）。`[源码]`
- **R-5 空态/部分态分支多，列表下标易失效**。题目集有空集 / 部分判分 / 已交卷三态（`renderers.tsx:89-90,219-225`）；证据、产物、新闻、轮次列表在空数据时渲染 `Empty` 文案；选项按钮顺序、题目顺序来自后端内容。自动化断言应绑定 `data-submitted`、文案短标签或 IPC 返回，不要绑第 N 个节点。`[源码]`
- **R-6 沙箱 iframe 与主 DOM 隔离**。`page` 类产物经 `HtmlFrame` 以 `sandbox=""` + CSP `default-src 'none'` 渲染（`ui.tsx:186-210`），PDF 也是独立 iframe；主页面 locator 选不到其内部元素，截图/断言需进入 frame 上下文。`[源码]`
- **R-7 休眠远程方法与渲染层能力不对齐**。preload 暴露了 `learning.answer`（单题）与 `files.preview`，但桌面渲染层未调用二者（grep 无命中）；`client-context.ts` 里的 `generateQuestions/exportQuestions/...` 那套 `LearningClient` 方法集属于 `packages/ui` 远程契约，不要在桌面 DOM 路径上寻找对应入口。方法是否被其他运行时使用，归 03/09 核实。`[源码]`

## 6. 未覆盖与待验证

1. **未启动 GUI，DOM 结论均为源码级**。本次调查按契约未运行 `pnpm dev` / Electron / 安装包，第 4 节的元素存在性、属性取值、文案均来自静态读取，未在真实窗口观测渲染结果。验证方法：harness 首启后导出 DOM 快照（`page.content()`）与 `getByRole`/`locator` 计数，逐条比对 4.1 清单；历史截图见 `.scratch/desktop.png`、`.scratch/ui-flow-final.png`（仅作旁证，未在本次复核）。`[待验证]`
2. **取消是否真正中断模型请求**。UI 侧停止按钮调 `learning:cancel`（`App.tsx:1224`），但信号是否透传到在途 LLM 请求、后端是否中止，属主进程/LLM 层；既有 `scripts/verify-cancel-wiring.ts` 为源码级断言。验证方法：在隔离 `LEARNING_AGENT_HOME` 下发起一轮长请求，点停止后观察后端会话/日志与模型调用是否终止（归 02/06/09 编排）。`[待验证]`
3. **`packages/ui` 客户端在 DSH web 运行时的实际渲染**。本文仅核实其源码结构与注册方式（`index.tsx` 四个 panel + settings section），未在 web 运行时启动验证；其 `pages.tsx` 与桌面休眠拷贝的运行时行为差异不在 Electron 自动化范围内。验证方法：按 `packages/ui/build-client.mjs` 产物在对应 web profile 内挂载后检查 panel 注册数（历史脚本 `.scratch/test-ui.mjs` 做过注册计数）。`[待验证]`
4. **未被渲染层调用的 preload 方法**。`learning.answer`、`files.preview` 在桌面渲染层无调用点；是否由预留入口、未来界面或其他运行时使用，需 03（preload 契约）与 09（既有脚本）交叉核实。验证方法：grep 主进程 handler 与 `.scratch`/`scripts` 驱动脚本的调用记录。`[待验证]`
5. **localStorage 布局键与测试隔离的关系**。侧栏/工作区宽度存 `window.localStorage`（`App.tsx:107-108`），归属 Electron 浏览器 profile，不属于 `LEARNING_AGENT_HOME` 文件目录；隔离 HOME 是否会连带清空这些布局偏好，未在本次验证。验证方法：08/10 设计 fixture 时检查隔离 profile 的 localStorage 初始态与重置手段。`[待验证]`
6. **`suggestions`（标题/描述/建议词）的后端确定性**。空态文案优先取 `agent.suggestions` 返回，缺失才用本地 `SUGGESTIONS` 兜底（`App.tsx:1466`）；建议词文案属低确定性输出，断言只宜检查「存在建议按钮」而非具体文案。验证方法：对比空库与有数据两种 HOME 下的空态渲染。`[待验证]`

## 7. 交叉引用

- IPC 通道方向、`learning:invoke` 37 方法清单与入参/返回字段：`03-ipc-and-preload-contract.md`（本文只引用方法名字符串，不重复字段）。
- 主进程装配、窗口尺寸/最小尺寸、`window-state` 持久化：`02-main-runtime-and-boot.md`。
- agent / matcher / questions / news 等领域服务的输入输出与确定性分级：`07-domain-services-and-determinism.md`。
- 数据库结构、种子库、`LEARNING_AGENT_HOME` 隔离与清理：`08-data-fixtures-and-isolation.md`。
- 既有 `.scratch` 驱动脚本与 `scripts/verify-*.ts` 覆盖矩阵：`09-existing-verification-and-gaps.md`。
- 四种驱动接入方式、launch 配置、等待策略与截图/日志方案：`10-harness-strategy.md`。
- P0/P1 场景目录及其依赖的 UI/FLOW 编号：`11-scenario-catalog.md`。
- 构建产物、asar 与首启资源：`05-build-package-and-first-run.md`；Python 采集服务与网络降级：`06-news-sidecar-and-network.md`。
