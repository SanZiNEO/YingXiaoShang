# 03 · IPC 与 preload 契约

> 归属：Electron 主进程 / preload 桥（`apps/desktop`）｜ 状态：已完成 ｜ 核对日期：2026-11-18
> 覆盖：`apps/desktop/src/preload/index.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/main/{errors,health,settings,llm,turn-canceller,news-backend}.ts`、`apps/desktop/src/renderer/src/env.d.ts`、`packages/agent/src/{index,team}.ts`、`packages/shared/src/index.ts`
> 不覆盖：渲染层视觉与交互流程（见 `04-renderer-ui-flows.md`）；领域服务内部确定性分级（见 `07-domain-services-and-determinism.md`）；Python 采集服务契约（见 `06-news-sidecar-and-network.md`）；SQLite 表结构与隔离（见 `08-data-fixtures-and-isolation.md`）。
> 行号截至 2026-11-18，以当前工作区源码为准；引用函数名防止行号漂移。

## 1. 结论摘要（TL;DR）

1. 渲染层只能通过 `window.learning` 这一个桥对象访问主进程；顶层共 9 个键：7 个直接方法（`invoke/chat/health/cancel/onChatEvent/answer/answerSet`）、`settings` 子对象（`get/set` 两方法）、只读 `capabilities` 子对象；可调用方法合计 9 个；没有第二个 `contextBridge.exposeInMainWorld` 调用点 `[源码]`。
2. 窗口 `webPreferences` 为 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`；渲染层拿不到 Node 能力，只能走 IPC `[源码]`。
3. IPC 通道共 9 条：8 条 `ipcMain.handle`（renderer→main，Promise 往返）+ 1 条主→渲染 `event.sender.send` 流式推送 `[源码]`。
4. `learning:invoke` 的 switch 分支实测恰好 37 个，编号 `IPC-01`..`IPC-37`，顺序与 `main/index.ts` 源码出现顺序一致；与 spec 第 6 节基线清单逐条核对，名称与顺序均一致，无差异 `[源码]`。
5. 跨 IPC 错误：`handle` 抛错后 renderer 侧 `invoke` 返回 rejected Promise；本项目仅 `learning:chat`、`learning:answer-set` 经 `friendlyError` 重建 Error（只保留 message），其余通道异常原样抛出；renderer 侧能否读到 stack / 自定义字段需实测确认 `[待验证]`。
6. 流式事件通道 `learning:chat-event` 上只有 5 类事件（`session / round / text / tool / tool-end`）；通道本身**没有**独立的结束事件或错误事件，一轮结束以 `learning:chat` 的 Promise resolve 为准，错误以 reject 为准 `[源码]`。
7. 37 个 invoke 方法中，直接或间接依赖 LLM / 网络的共 3 个（`news.refresh`、`news.match`、`agent.retry`），确定性分级见第 4.4 节；其余为纯本地 DB / 文件 / 对话框操作 `[源码]`。
8. TS 类型 `env.d.ts` 声明了 `window.learning.downloadArtifact`，但 preload 实际未暴露该方法；渲染层调用会得到 `undefined`，属类型与实现漂移 `[源码]`。

## 2. 结构与流程

### 2.1 分层与调用方向

```text
渲染层 (renderer, Chromium)
  │  window.learning.invoke / chat / answer / answerSet / cancel / health / settings / onChatEvent
  ▼  ipcRenderer.invoke / ipcRenderer.on  (结构化克隆序列化)
preload (contextBridge, contextIsolation=true)
  │  ipcMain.handle('learning:invoke' | 'learning:chat' | ...)
  ▼
主进程 (main, Node)
  ├─ invoke(method, input)  switch 分发 → packages/* 领域服务 → LearningDb(SQLite)
  ├─ learning:chat          AgentService.handleConversation(..., hooks.onEvent)
  └─ event.sender.send('learning:chat-event', payload)  ──► 渲染层 onChatEvent 回调
```

### 2.2 消息序列化口径 `[源码]`

- preload 每个方法都是薄封装：把入参原样传给对应的 `ipcRenderer.invoke` / `ipcRenderer.on`，未做字段裁剪或校验（`apps/desktop/src/preload/index.ts:9,17,18,19,22,32,39,41,42`）。
- Electron IPC 走结构化克隆（structured clone）：`string / number / boolean / null / plain object / array / Date` 可过；**函数、Symbol、原型链上的方法、类实例不保留**。返回值同源。
- 主进程侧入参基本用 `typeof args.x === 'string'` / `Array.isArray` / `Number(...)` 做宽松归一，非法类型多数回退默认值，不抛 schema 校验错误。

### 2.3 一轮对话的时序（流式）

```text
renderer            preload                 main                         agent/LLM
  │ chat(input) ──► invoke('learning:chat') ──► TurnCanceller.begin(requestId)
  │                                            │  AgentService.handleConversation(input, {onEvent, signal})
  │                                            │    ├─ 建会话 → onEvent(session) ──send──► onChatEvent
  │                                            │    ├─ 团队轮次 → onEvent(round/tool/tool-end) ──send──►
  │                                            │    └─ 文本增量 → onEvent(text) ──send──►
  │ ◄────── Promise resolve(HandleTurnOutput) ──┘  （结束信号：Promise resolve，无 done 事件）
  │ ◄────── Promise reject(friendlyError) ──────┘  （错误信号：Promise reject，无 error 事件）
  │ cancel(requestId) ──► invoke('learning:cancel') ──► TurnCanceller.cancel(id) → abort signal
```

## 3. 关键代码位置

| 职责 | 文件:行 | 说明 |
|---|---|---|
| preload 唯一暴露点 | `apps/desktop/src/preload/index.ts:3` | `contextBridge.exposeInMainWorld('learning', …)` |
| 能力标志位 | `apps/desktop/src/preload/index.ts:4-8` | `capabilities.localFiles / revealFiles / downloadArtifacts` |
| 通用 invoke 封装 | `apps/desktop/src/preload/index.ts:9` | `invoke(method, input)` → `learning:invoke` |
| 对话封装 | `apps/desktop/src/preload/index.ts:10-17` | `chat(input)` → `learning:chat` |
| 订阅流式事件 | `apps/desktop/src/preload/index.ts:20-24` | `onChatEvent(handler)`，返回取消订阅函数 |
| 窗口隔离配置 | `apps/desktop/src/main/index.ts:142-147` | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: false` |
| invoke 分发函数 | `apps/desktop/src/main/index.ts:203-393` | `invoke(method, input)`，switch 在 `:208`，default 在 `:390-391` |
| 学生 ID 兜底 | `apps/desktop/src/main/index.ts:205-207` | 缺省回退 `DEMO_STUDENT_ID = 'student_demo'`（`:27`） |
| 通道注册：invoke | `apps/desktop/src/main/index.ts:445` | `ipcMain.handle('learning:invoke', …)` |
| 通道注册：cancel | `apps/desktop/src/main/index.ts:448-451` | `learning:cancel` |
| 通道注册：chat | `apps/desktop/src/main/index.ts:453-493` | `learning:chat`，`onEvent` 推送在 `:478-481` |
| 通道注册：answer | `apps/desktop/src/main/index.ts:494-508` | `learning:answer` |
| 通道注册：answer-set | `apps/desktop/src/main/index.ts:509-528` | `learning:answer-set`，错误包装在 `:526` |
| 通道注册：health | `apps/desktop/src/main/index.ts:529-536` | `learning:health` |
| 通道注册：settings | `apps/desktop/src/main/index.ts:537-538` | `learning:settings:get` / `learning:settings:set` |
| 错误翻译 | `apps/desktop/src/main/errors.ts:13-67` | `friendlyError(error, {context})`，新建 Error，只保留 message |
| 取消控制器 | `apps/desktop/src/main/turn-canceller.ts` | `TurnCanceller`：`begin / cancel / done`，持有 `AbortController` |
| 渲染层事件类型 | `apps/desktop/src/renderer/src/stream-state.ts:13-21` | `ChatStreamEvent`：5 类 type |
| 团队事件契约 | `packages/agent/src/team.ts:17-35` | `TeamEvent` 字段；`forward()` 在 `:146-169` |
| 会话事件首推 | `packages/agent/src/index.ts:413` | `onEvent({ agent:'lead', type:'session', sessionId })` |
| 类型声明漂移 | `apps/desktop/src/renderer/src/env.d.ts:16` | 声明 `downloadArtifact`，preload 未暴露 |

## 4. 可测点

### 4.1 preload 暴露面（Playwright `page.evaluate` 可达到什么）

`window.learning` 实际形状 `[源码]`（依据 `preload/index.ts:3-44`）：

| 键 | 类型签名 | 说明 |
|---|---|---|
| `capabilities.localFiles` | `boolean`（常量 `true`） | 本地文件能力标志，非函数 `[源码]` |
| `capabilities.revealFiles` | `boolean`（常量 `true`） | 文件夹反查能力标志 `[源码]` |
| `capabilities.downloadArtifacts` | `'desktop'` | 固定字符串，标识产物下载走桌面侧 `[源码]` |
| `invoke` | `(method: string, input?: unknown) => Promise<unknown>` | 通用 RPC，分发到 37 个方法（4.3 节） |
| `chat` | `(input: { studentId?: string; sessionId?: string; message: string; scopeOverride?: unknown; chapterId?: string; requestId?: string }) => Promise<unknown>` | 一轮对话，流式进度走 `onChatEvent` |
| `health` | `() => Promise<{ ok: boolean; warnings: string[]; notices: string[]; appHome: string }>` | 启动自检 |
| `cancel` | `(requestId: string) => Promise<{ cancelled: boolean }>` | 中断在途轮次 |
| `onChatEvent` | `(handler: (event: unknown) => void) => () => void` | 订阅 `learning:chat-event`，返回取消订阅函数 |
| `answer` | `(input: { studentId?: string; sessionId: string; questionId: string; answer: string; artifactId?: string; chapterId?: string }) => Promise<unknown>` | 单题作答反馈 |
| `answerSet` | `(input: { studentId?: string; sessionId: string; artifactId: string; answers: Array<{ questionId: string; answer: string }>; chapterId?: string }) => Promise<unknown>` | 整卷提交 |
| `settings.get` | `() => Promise<PublicSettingsView>` | 读公开配置（不回传密钥本体） |
| `settings.set` | `(value: { apiKey?: string; model?: string; clearApiKey?: boolean }) => Promise<PublicSettingsView>` | 写配置 |

**未暴露但类型声明存在**：`env.d.ts:16` 的 `downloadArtifact(artifactId, format)` 在 preload 中没有对应键，`window.learning.downloadArtifact === undefined` `[源码]`。渲染层若按类型直接调用会抛 `undefined is not a function`；测试中不要把它当作可用通道。

**窗口隔离配置** `[源码]`（`main/index.ts:142-147`）：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`。注意 `sandbox: false`，但渲染层仍无 Node 全局对象（`nodeIntegration: false`）；preload 以隔离桥方式暴露白名单 API。

### 4.2 通道清单（CH-01 .. CH-09）

| ID | 通道名 | 方向 | 语义 | 可否取消 | 错误跨 IPC 传播 |
|---|---|---|---|---|---|
| `CH-01` | `learning:invoke` | renderer→main，`ipcMain.handle`（`main/index.ts:445`） | 通用方法分发；第二参 `method: string`，第三参 `input: unknown`；switch 见 4.3 | 不可取消（同步/短任务派发） | 未知方法 reject：`Error("unknown learning method: <method>")`（`:391`）；方法内部异常原样 reject，未做文案包装 `[源码]` |
| `CH-02` | `learning:cancel` | renderer→main，`ipcMain.handle`（`:448-451`） | 按 `requestId` 取消在途对话；返回 `{ cancelled: boolean }` | 自身不可取消；被取消的是 CH-03 的执行链 | 无显式错误路径；`requestId` 非字符串按空串处理（`:449`），返回 `cancelled: false` `[源码]` |
| `CH-03` | `learning:chat` | renderer→main，`ipcMain.handle`（`:453-493`） | 一轮团队对话；流式进度经 `CH-09` 推送；返回 `HandleTurnOutput` | 可取消：`TurnCanceller.begin(requestId)` 生成 `AbortSignal` 传给执行链（`:466,485`），`CH-02` 触发 abort | `message` 为空串 reject `Error('消息不能为空')`（`:462-463`）；其余异常经 `friendlyError` 包装后 reject（`:488-489`）；`finally` 中 `turn.done()`（`:491`） |
| `CH-04` | `learning:answer` | renderer→main，`ipcMain.handle`（`:494-508`） | 单题作答 + 反馈；返回 `AnswerQuestionOutput` | 不可取消 | 异常原样 reject，**未**经 `friendlyError` 包装；会话/题目归属校验失败由 agent 层抛中文 Error `[源码]` |
| `CH-05` | `learning:answer-set` | renderer→main，`ipcMain.handle`（`:509-528`） | 整卷提交；返回 `AnswerSetOutput` | 不可取消 | 异常经 `friendlyError(error, { context: 'answer' })` 包装后 reject（`:526`），文案附带「这次作答没有记成成绩」 |
| `CH-06` | `learning:health` | renderer→main，`ipcMain.handle`（`:529-536`） | 启动自检：章节/知识点/新闻计数 + `appHome` | 不可取消 | DB 读取异常会 reject；正常返回 `{ ok, warnings, notices, appHome }` `[源码]` |
| `CH-07` | `learning:settings:get` | renderer→main，`ipcMain.handle`（`:537`） | 读公开配置 | 不可取消 | 配置文件损坏时不抛，`configError` 字段标注（`settings.ts:41-43,63`） |
| `CH-08` | `learning:settings:set` | renderer→main，`ipcMain.handle`（`:538`） | 写 `settings.json`；返回最新公开配置 | 不可取消 | 写文件异常 reject；`clearApiKey: true` 清空本地 key，环境变量中的 key 不受影响（`settings.ts:67-84`） |
| `CH-09` | `learning:chat-event` | main→renderer，`event.sender.send`（`:480`） | 单向流式推送，无应答、无反向错误通道 | 不适用 | 无错误回传；`event.sender.isDestroyed()` 时跳过发送（`:479`）；渲染层未订阅时消息丢弃 |

**错误对象跨 IPC 的字段保留情况** `[待验证]`：`handle` 内抛出的 Error 经 Electron IPC 序列化后，renderer 侧收到 rejected Promise。本项目 `friendlyError`（`errors.ts:13-67`）内部 `new Error(...)` 重建对象，**原始 `stack`、`cause`、挂载在原 Error 上的自定义字段不会进入新对象**。Electron 结构化克隆对 `Error` 自身字段（`message/name/stack`）的复制范围、以及自有可枚举属性是否保留，需实测确认。验证步骤：主进程临时抛 `const e = new Error('probe'); (e as any).foo = 1; throw e;`，渲染层 `invoke(...).catch(err => console.log(err.message, err.stack, (err as any).foo))`，观察三值；本调查按工作契约未启动 GUI，未执行该探针。

### 4.3 `learning:invoke` 方法契约表（IPC-01 .. IPC-37）

> 编号顺序等于 `apps/desktop/src/main/index.ts` switch 分支出现顺序（`:209` 起）。入参中的 `studentId`：字符串非空则采用，否则回退 `'student_demo'`（`:205-207`），下表不再重复列出。返回字段名沿用 `packages/shared/src/index.ts` 的 zod schema。「副作用」列：无则显式写「无」。

| ID | 方法名（位置） | 入参字段（类型 / 必填可选 / 边界） | 返回结构（字段级） | 副作用 | 异常语义 | 可测点 |
|---|---|---|---|---|---|---|
| `IPC-01` | `student.current`（`index.ts:209-212`） | `studentId?: string`，可选；空串回退 demo | `{ studentId: string; name: string; cohort: string }`；profile 缺省时 `name='学生'`、`cohort=''` | DB 读（`getStudentProfile`）；无写、无网络 | profile 不存在不抛，走兜底默认值；DB 异常上抛 | 断言三字段存在；无 profile 时 `name` 兜底值 |
| `IPC-02` | `chapters.list`（`:213-214`） | 无业务入参 | `Chapter[]`：`{ id: string; number: int; title: string; source_path: string }` | DB 读；无 | 空库返回 `[]`；DB 异常上抛 | 断言数组元素 schema；空库为 `[]` 而非 reject |
| `IPC-03` | `kps.list`（`:215-224`） | `chapter?: string` 可选；`query?: string` 可选；`limit?: number` 可选，默认 80；`searchKps` 分支 DB 层夹紧 1–200（`db/index.ts:1787`），`listKpsByChapter` 分支在主进程 `slice(0, limit)`（`index.ts:222`） | `KnowledgePoint[]`：`{ id, chapter_id, section_id, name, name_en, definition, keywords[], examples[], non_examples[], aliases[], difficulty(1–4), competencies[], decisions[], source, status, parent_id? }` | DB 读；无 | 分支优先级：`query` 非空走 `searchKps`；否则 `chapter` 非空走 `listKpsByChapter`；否则全量 `searchKps('')`；DB 异常上抛 | 三分支分别造数断言；`limit` 夹紧边界 |
| `IPC-04` | `getKp`（`:225-226`） | `kpId: string`，必填缺失时按 `''` 处理（`String(?? '')`） | `KnowledgePoint \| undefined` | DB 读；无 | 找不到返回 `undefined`，不抛；DB 异常上抛 | 存在 / 不存在两态断言 |
| `IPC-05` | `getBlock`（`:227-235`） | `blockId: string`，必填缺失按 `''` | `{ block: ContentBlock; chapter: Chapter \| undefined; section: Section \| undefined } \| undefined`；`ContentBlock`：`{ id, chapter_id, section_id, block_type(paragraph/table/figure/exercise/case_fragment), text, page?, source, rights }` | DB 读（`getBlock` + 全量 `listChapters`/`listSections` 反查）；无写 | block 找不到返回 `undefined`；DB 异常上抛 | 断言嵌套 `chapter/section` 可解析到对应章节 |
| `IPC-06` | `getResource`（`:236-248`） | `resourceId?: string`（兼容别名 `sourceId`）；空串返回 `undefined` | `{ guide: object; chapter: Chapter \| undefined } \| undefined`；`guide` 为 `plugin_state` 中 `plugin_id='resource', key='guide/<id>'` 的 JSON 对象 | DB 读（`getState`）；无写 | 状态不存在、非对象或为数组时返回 `undefined`；DB 异常上抛 | 状态键存在 / 缺失两态；非对象兜底 |
| `IPC-07` | `listIdeology`（`:249-250`） | 无业务入参 | `IdeologyPoint[]`：`{ id, name, definition, examples[], non_examples[], related_kp_ids[], source }` | DB 读；无 | DB 异常上抛；空库 `[]` | 断言数组与字段 |
| `IPC-08` | `news.list`（`:251-256`） | `source?: string` 可选；`since?: string` 可选；`limit?: number` 可选默认 20（DB 层夹紧 1–500，`db/index.ts:2909`） | `NewsArticle[]`：`{ id, source, source_id, title, url, author, published_at, summary, content, content_status(full/partial/unavailable), rights, fetched_at }` | DB 读；**不访问 sidecar / 网络** | DB 异常上抛；空库 `[]` | 离线状态下仍可返回库内条目；`source/since/limit` 过滤生效 |
| `IPC-09` | `news.status`（`:257-261`） | 无业务入参 | `{ count: number; newestFetchedAt: string }`；库空时 `newestFetchedAt=''` | DB 读；无网络 | DB 异常上抛 | 断言 `count` 为非负整数；空库 `newestFetchedAt` 为空串 |
| `IPC-10` | `news.refresh`（`:262-273`） | `sources?: string[]`，可选；非数组忽略，元素 `map(String)` | `{ results: SourceRunResult[]; queued: boolean; accepted: string[]; count: number; newestFetchedAt: string }`；`SourceRunResult`：`{ source, status, fetched, inserted, updated, skipped, errors, failures[], startedAt, durationMs }` | **网络**：`POST /run` 到 Python sidecar（`wait:false`，`news/index.ts:258-281`）；**DB 读** count；**DB 写 + 可能 LLM**：`matcher.backfill(20)` 标注回灌 | sidecar 返回 `ok:false` 抛 `Error(message/error)`；backfill 异常未被局部 try 包裹，会冒泡（见第 5 节 R-2）；DB 异常上抛 | sidecar 不可达时 Promise reject；返回结构字段存在性；`queued` 为 `true`（wait=false） |
| `IPC-11` | `news.get`（`:274-282`） | `articleId: string`，必填缺失按 `''` | `{ article: NewsArticle; matches: CaseMatch[]; ideology: IdeologyMatch[] } \| undefined`；`CaseMatch`：`{ article_id, kp_id, score, confidence, tag_role, evidence_span, evidence_start?, evidence_end?, rationale, method, review_status, evidence_level, version, reviewer_id, reviewed_at, created_at }`；`IdeologyMatch`：`{ article_id, ideology_id, confidence, evidence_span, rationale, review_status, evidence_level, version, reviewer_id, reviewed_at }` | DB 读；无网络 | 文章找不到返回 `undefined`；DB 异常上抛 | 断言 matches/ideology 为数组；不存在文章返回 `undefined` |
| `IPC-12` | `news.match`（`:283-289`） | `articleId: string` 必填；`topK?: number` 可选默认 3 | `{ matches: CaseMatch[] }`（`matcher.match` 返回的 `ideology`、`diagnostics` 在 IPC 层被丢弃） | **DB 写**：`upsertMatches` + 缓存 `setState`；**可能 LLM**：`useLlm` 未禁且配置了模型时调用标注模型（`matcher/index.ts:462-493`） | LLM 报错中匹配 `LLM_FALLBACK` 的被吞掉并回退确定性召回；其余错误上抛；文章/候选缺失由 matcher 内部处理 | 断言 `matches` 为数组；缓存命中路径 `diagnostics.degraded=true`（本通道不透出 diagnostics）；LLM 关闭时确定性结果 |
| `IPC-13` | `questions.attempts`（`:290-295`） | `questionIds?: string[]` 可选；`limit?: number` 可选默认 200（DB 层夹紧 1–500，`db/index.ts:3456`） | `QuestionAttempt[]`：`{ id, question_id, student_id, answer, feedback_json(unknown), score, created_at }` | DB 读；无 | DB 异常上抛；无记录 `[]` | 按 `questionIds` 过滤；`feedback_json` 可空对象 |
| `IPC-14` | `profile.get`（`:296-297`） | 无额外业务入参（`studentId` 兜底） | `{ profile: StudentProfile \| undefined; competencies: Competency[]; plan: LearningPlanItem[]; evidence: Evidence[]; growth: GrowthSummaryItem[] }`；`StudentProfile`：`{ id, name, cohort, background{}, goals[], preferences{}, constraints[], self_assessment{}, created_at, updated_at }` | DB 读；无写、无 LLM（`profile/index.ts:104-123`） | DB 异常上抛 | 断言五个键存在；合成证据被过滤（`isSyntheticEvidence`） |
| `IPC-15` | `profile.growth`（`:298-299`） | `chapterId?: string` 可选 | `GrowthSummaryItem[]`：`{ competency: Competency; level(L1–L4/unknown); confidence: number; evidenceCount: int; status(进步/停滞/证据不足/待验证); preLevel?; postLevel?; latestEvidence? }` | DB 读；规则加权计算，无 LLM（`profile/index.ts:382-390`） | DB 异常上抛 | 同一证据集上 `level/confidence` 可复现；`status` 枚举取值 |
| `IPC-16` | `profile.evidence`（`:300-305`） | `competencyId?: string` 可选；`chapterId?: string` 可选；`limit?: number` 可选默认 100 | `Evidence[]`：`{ id, student_id, competency_id, level, strength(A–D), evidence_type, source_type, source_id, chapter_id, session_id, excerpt, rationale, confidence, method, review_status, review_note, occurred_at, created_at, metadata{} }` | DB 读；合成证据被过滤（`profile/index.ts:168-172`） | DB 异常上抛 | 过滤条件生效；不含 `ev_demo_` 前缀记录 |
| `IPC-17` | `profile.snapshot`（`:306-311`） | `chapterId: string`（`String(?? '')`）；`checkpoint?: 'pre'`，非 `'pre'` 归一为 `'post'` | `GrowthSnapshot[]`：`{ id, student_id, chapter_id, checkpoint, competency_id, level, confidence, evidence_count, summary, created_at }` | **DB 写**：`recordSnapshot` 落 `growth_snapshots`（`profile/index.ts:331` 起）；规则计算，无 LLM | DB 异常上抛；重复 checkpoint 走覆盖/比较逻辑 | 调用后 DB 出现对应 snapshot 行；`checkpoint` 归一为 pre/post |
| `IPC-18` | `profile.review`（`:312-318`） | `evidenceId: string`；`status?: 'reviewed' \| 'rejected'`，其他值归一 `'draft'`；`note?: string` | `{ ok: true }` | **DB 写**：`updateEvidenceReview` | 无显式存在性校验：`evidenceId` 为空串或不存在时仍执行 UPDATE（0 行），返回 `{ ok: true }`；DB 异常上抛 | 复核状态/备注落库；不存在 ID 也返回 ok（行为约束） |
| `IPC-19` | `artifacts.list`（`:319-320`） | `limit?: number` 可选默认 50 | `Artifact[]`；`Artifact`：`{ id, student_id, session_id, skill_id, template_id, type, title, format(md/docx/csv/json/html), path, content, content_json, schema_version, version, status, source_refs[], evidence_ids[], created_at }`；`question_set` 类型会重算文档正文（`artifacts/index.ts:157-162`） | DB 读；本地模板/文档拼接，无网络 | DB 异常上抛 | 按学生过滤；题目集 `content` 为渲染后文档 |
| `IPC-20` | `artifacts.get`（`:321-322`） | `artifactId: string` | `Artifact \| undefined`（题目集同上重算） | DB 读；无 | 找不到返回 `undefined`；DB 异常上抛 | 存在 / 不存在两态 |
| `IPC-21` | `artifacts.export`（`:323-324`） | `artifactId: string`；`format?: 'md' \| 'docx' \| 'html'`，其他值归一 `'docx'`（`index.ts:199-201`） | `{ path: string }`（导出文件绝对路径） | **文件写**：在 `appHome/artifacts/<student>/<month>/` 下生成 md/docx；HTML 原件直接返回原路径不转换（`artifacts/index.ts:171-187`） | artifact 不存在抛 `Error('artifact not found: <id>')`；路径越界抛 `PATH_OUTSIDE_APP`；写文件异常上抛 | 导出文件落盘可查；format 归一；HTML 不二次转换 |
| `IPC-22` | `memory.facts`（`:325-326`） | 无额外入参（`studentId` 兜底） | `MemoryFact[]`：`{ id, student_id, kind(goal/preference/constraint/background/self_assessment/open_question), key, value(unknown), confidence, source, updated_at }` | DB 读；无 | DB 异常上抛 | 按学生隔离；`value` 为反序列化后的 JSON |
| `IPC-23` | `memory.episodes`（`:327-328`） | `limit?: number` 可选默认 50 | `MemoryEpisode[]`：`{ id, student_id, session_id, summary, decisions[], open_questions[], created_at }`；两条 demo 合成 episode 被排除（`db/index.ts:1606-1629`） | DB 读；无 | DB 异常上抛；limit DB 层夹紧 1–100 | 不含 `demo_pre/demo_post` 合成会话记录 |
| `IPC-24` | `memory.summary`（`:329-330`） | 无额外入参 | `{ headline: string; facts: MemoryFact[]; episodes: MemoryEpisode[] }`（`profile/index.ts:126-130`） | DB 读；无 LLM | DB 异常上抛 | 三字段存在；episodes 上限 8（服务内固定） |
| `IPC-25` | `memory.upsert`（`:331-340`） | `kind?:` 六枚举之一，非法归一 `'goal'`；`key: string`（空串允许）；`value: unknown`（任意可克隆 JSON） | `MemoryFact`（落库后的完整记录，含 `id/updated_at/confidence`） | **DB 写**：`upsertMemoryFact` | DB 异常上抛；`value` 结构化克隆失败属 IPC 层错误 | 重复 key 走 upsert 不新增行；`kind` 非法归一 goal |
| `IPC-26` | `memory.delete`（`:341-343`） | `factId: string` | `{ ok: true }` | **DB 写**：`deleteMemoryFact` | ID 空 / 不存在不抛（DELETE 0 行）；DB 异常上抛 | 删除后 `memory.facts` 不再含该 ID |
| `IPC-27` | `chat.sessions`（`:344-345`） | 无额外入参 | `ChatSession[]`：`{ id, student_id, chapter_id, title, created_at, updated_at }` | DB 读；无 | DB 异常上抛 | 按学生隔离；`updated_at` 倒序 |
| `IPC-28` | `chat.messages`（`:346-347`） | `sessionId: string` | `ChatMessage[]`：`{ id, session_id, role(system/user/assistant), content, evidence_count, created_at, seq, turn_id, kind(message/user_message/assistant_message/tool_call/artifact_created/evidence_added/answer_submitted), payload_json(unknown) }` | DB 读；无 | `sessionId` 空串返回空匹配集；DB 异常上抛 | 按 `seq` 有序；`kind/payload_json` 可分辨工具调用与产物事件 |
| `IPC-29` | `agent.snapshot`（`:348-353`） | `sessionId?: string` 可选；`chapterId?: string` 可选 | `LearningStateSnapshot`（schema 见 `shared/index.ts:977`，聚合能力状态/特征） | DB 读聚合；无写 | DB 异常上抛 | 快照字段存在；同输入可复现 |
| `IPC-30` | `agent.suggestions`（`:354-358`） | `sessionId?: string` 可选 | `LearningSuggestions`（schema 见 `shared/index.ts:987`） | DB 读；规则推导，无 LLM（`agent/index.ts:242-253`） | DB 异常上抛 | 建议条目与当前 snapshot/turns 一致；无 LLM 文案漂移 |
| `IPC-31` | `agent.turns`（`:359-360`） | `sessionId: string`；`limit?: number` 可选默认 50 | `TurnRow[]`：`{ id, session_id, turn_id, status, plan_json{}, record_json{}, seq_start, seq_end, started_at, finished_at }` | DB 读；无 | DB 异常上抛 | 按会话隔离；`record_json` 含产物/证据引用 |
| `IPC-32` | `agent.ledger`（`:361-362`） | 无额外入参 | `RecorderStatus`：`{ items: SummaryLedger[]; counts: { summarized: number; pending: number; stale: number; failed: number } }`；`SummaryLedger`：`{ source_type, source_id, source_seq, summarized_seq, source_hash, status, summary_id, attempts, last_error, updated_at }` | DB 读；无 | DB 异常上抛 | `counts` 四类计数与 `items` 状态一致 |
| `IPC-33` | `agent.retry`（`:363-365`） | `sourceId: string`（定位待重试 ledger 行） | `RecorderStatus`（重试后重新 `listLedger`） | **DB 写**：`recorder.retry` 重置 ledger 状态；**间接 LLM**：后台 recorder 重试链路后续可能再调模型（`recorder.ts:256`） | `retry` 异常上抛；本通道本身不等待后台重试完成 | 调用后对应 ledger 状态从 `failed/pending` 变化；返回最新 `counts` |
| `IPC-34` | `agent.sessions`（`:366-369`） | 无额外入参 | `ChatSessionSummary[]`：`{ id, title, chapterId, chapterTitle, status(active/awaiting_confirmation/new_artifact/organized), lastTurnAt, pendingAsks, hasNewArtifact, ledgerStatus }`；运行时无 `sessionSummaries` 方法时返回 `[]` | DB 读聚合；无 | DB 异常上抛 | 摘要字段与会话/ledger 一致 |
| `IPC-35` | `files.reveal`（`:370-372`） | `path: string`（系统绝对路径） | `{ ok: true }` | **外部 Shell**：`shell.showItemInFolder` 在文件管理器中定位 | 路径无效/不存在由 Shell 侧报错，经 IPC 传播；不校验路径是否在 appHome 内 | 调用后系统文件管理器打开（GUI 观测，自动化中以不报错为准） |
| `IPC-36` | `files.preview`（`:373-374`） | `path: string`（系统绝对路径） | `FilePreview`：`{ path, name, kind(markdown/html/text/image/pdf/unsupported), content, mime }`；图片/PDF 的 `content` 为 base64 data URL；不支持类型 `content=''` | **文件读**：`readFile`；`.docx` 经 mammoth 转 HTML（`index.ts:169-196`） | 文件不存在/不可读上抛；未知扩展名返回 `kind='unsupported'` 而非抛错 | 各扩展名映射到正确 `kind/mime`；大文件以 base64 回传 |
| `IPC-37` | `files.openDialog`（`:375-389`） | 无入参；原生对话框过滤 `md/docx/pdf/png/jpg/jpeg/webp/txt/csv` | `FilePreview \| undefined`；用户取消返回 `undefined` | **原生 dialog**（`dialog.showOpenDialog`）；选定后走 `previewFile` 文件读 | 对话框异常上抛；取消不抛，返回 `undefined` | 取消路径断言 `undefined`；选定路径返回预览结构 |

### 4.4 LLM / 网络依赖分级（供 07、11 引用）

| 依赖等级 | 方法 / 通道 | 说明 |
|---|---|---|
| 直接依赖 LLM（低确定性） | `CH-03` `learning:chat`、`CH-04` `learning:answer`、`CH-05` `learning:answer-set` | 主链路经 `DeepSeekLlm.stream/chat` 调 `DEEPSEEK_BASE_URL`（默认 `https://api.deepseek.com`，`llm.ts:85`）；断言只验结构与约束，不断言文案 |
| 可能依赖 LLM | `IPC-12` `news.match` | 配置模型且 `useLlm !== false` 时走 LLM 标注；LLM 不可用且错误属 fallback 类时回退确定性召回（`matcher/index.ts:462-493`） |
| 依赖网络（sidecar） | `IPC-10` `news.refresh` | `POST /run` 到本地 Python sidecar；另触发 `backfill` 可能连带 LLM |
| 间接依赖 LLM（后台） | `IPC-33` `agent.retry` | 通道本身只重置 ledger；后台 recorder 重试在后续链路中可能调模型 |
| 纯本地（高确定性） | `IPC-01`..`IPC-09`、`IPC-11`、`IPC-13`..`IPC-29`（除 `IPC-17` 为本地 DB 写）、`IPC-30`..`IPC-32`、`IPC-34`..`IPC-37` | DB 读 / 本地 DB 写 / 文件读写 / 原生对话框；无模型与外网调用 |

### 4.5 流式事件契约（EVT-01 .. EVT-05）

通道 `CH-09` `learning:chat-event`，payload 形状：`{ requestId: string, ...TeamEvent }`（`main/index.ts:480` 展开 step 对象）。`requestId` 来自 `CH-03` 入参，缺省时为空串；渲染层按 `requestId` 归属轮次（`stream-state.ts:52`）。

| ID | `type` | 字段 | 触发时机 | 频率 / 结束信号 |
|---|---|---|---|---|
| `EVT-01` | `session` | `{ requestId, agent: 'lead', type: 'session', sessionId: string }` | 会话创建后、任何可能失败的调用之前首推（`agent/index.ts:413`） | 每轮对话至多一条；用于首轮失败后重发认领会话 |
| `EVT-02` | `round` | `{ requestId, agent: string, type: 'round', round: number }` | 团队进入新一轮（`team.ts:150`） | 按轮次递增，无固定节流 |
| `EVT-03` | `text` | `{ requestId, agent: string, type: 'text', text: string }` | 文本增量片段（`team.ts:154`） | 跟随模型流，分片到达；渲染层拼接（`stream-state.ts:58-60`） |
| `EVT-04` | `tool` | `{ requestId, agent: string, type: 'tool', tool: string }` | 工具开始执行（`team.ts:157-158`）；`tool` 为内部工具名，渲染层映射中文文案 | 每个工具调用一条 |
| `EVT-05` | `tool-end` | `{ requestId, agent: string, type: 'tool-end', tool: string, chars?: number, preview?: string, cached?: boolean }` | 工具结束（`team.ts:161-169`） | 每个工具调用一条；渲染层当前状态机忽略该类型（`stream-state.ts:64` 落回原状态） |

**结束与错误信号** `[源码]`：通道上**不存在** `finish` / `done` / `error` 事件。一轮正常结束以 `CH-03` Promise `resolve(HandleTurnOutput)` 为准；异常以 Promise `reject` 为准。LLM 流内部 chunk 类型（`block-start / text-delta / tool-call-delta / block-end / finish / usage`，见 `llm.ts:134-201`）只在 agent 循环内部消费，**不上推**渲染层。

**消费方式**（03 侧契约，UI 呈现见 04）：preload `onChatEvent(handler)` 注册 `ipcRenderer.on` 监听，返回 `removeListener` 取消订阅函数（`preload/index.ts:20-24`）；handler 入参即 payload，无第二参数包装。

## 5. 风险与坑

- **R-1 错误字段在跨 IPC 后丢失** `[源码]` + `[待验证]`：`friendlyError` 用 `new Error(中文文案)` 重建对象（`errors.ts:13-67`），原始 `stack`、`cause`、自定义属性不进入新对象；`CH-01` 等未包装通道虽原样抛出，但 Electron 结构化克隆对 Error 自有属性的保留范围未实测。自动化断言建议只匹配 `err.message` 文案/前缀，不要断言 `err.stack` 存在或自定义字段透传。验证方法见 4.2 节探针。
- **R-2 `news.refresh` 内 backfill 异常未局部捕获** `[源码]`：`index.ts:264-265` 先 `await newsService.refresh(...)`，再 `await matcher.backfill(20)`，两层都在同一 try 之外；backfill 抛错会使 `IPC-10` reject，即使 refresh 已成功排队。定时 tick 的 try/catch 只包住 `ensureFresh`（`index.ts:106-112`），其后的 `matcher.backfill(20)`（`:115`）同样在 catch 之外；手动 IPC 路径更没有任何包裹。测试时不要把 backfill 失败误判为 sidecar 不可达。
- **R-3 `news.match` 只回传 `matches`** `[源码]`：`matcher.match` 返回 `{ matches, ideology, diagnostics }`，IPC 层仅 `{ matches: result.matches }`（`index.ts:288`）。需要 `diagnostics.degraded / llm`、意识形态匹配结果的用例无法从本通道拿到，须走 DB 或服务层直连；不要在断言里期待 `ideology/diagnostics` 字段。
- **R-4 入参类型宽松、缺校验** `[源码]`：多数方法用 `String(args.x ?? '')` / `typeof === 'number'` 归一，非法类型不抛 schema 错误而是静默回退默认值（如 `IPC-18` 不存在 ID 也返回 `{ ok: true }`）。用例不能靠「传错参必 reject」来校验前端；负例要显式断言返回兜底结构。
- **R-5 `sessionId` 晚到导致重复建会话** `[源码]`：会话 ID 原本只在整轮成功返回时给出，现通过 `EVT-01` 提前推送（`team.ts:26-34` 注释、`agent/index.ts:413`）。自动化重发前必须先记录收到的 `sessionId`；断言「会话只建一条」要以 `chat_sessions` 表为准，不要只看界面。
- **R-6 类型声明与 preload 实现漂移** `[源码]`：`env.d.ts:16` 声明 `downloadArtifact`，preload 未暴露；反过来 `capabilities.downloadArtifacts` 等键在类型中有标注。渲染层按类型调用未暴露方法会得到 `undefined`，测试基建封装方法前应先 `page.evaluate(() => Object.keys(window.learning))` 核实真实键集。
- **R-7 取消链路的有效性未在本机实测** `[源码]` + `[待验证]`：`signal` 已从 `TurnCanceller` 交到执行链（`index.ts:485`），`scripts/verify-cancel-wiring.ts` 只做源码级接线断言；abort 是否真正中断在途模型请求、被中断后落库状态如何，需在批准运行环境下实测。

## 6. 未覆盖与待验证

1. **跨 IPC Error 的字段保留范围** `[待验证]`：Electron 版本对结构化克隆 Error 的 `stack` 与自有枚举属性的复制行为未实测。验证方法：按 4.2 节探针在主进程抛带自定义字段的 Error，渲染层 catch 后打印 `message/stack/foo`；记录 Electron 主版本号后回填本表。
2. **`learning:invoke` 未列出的方法名行为** `[源码]`：`default` 分支 reject `unknown learning method: <method>`（`index.ts:391`），但未实测未知方法在 renderer 侧 reject 对象的具体形态。验证方法：调 `invoke('no.such.method')` 观察 rejected promise 的 `message`。
3. **各 DB 方法的空库 / 边界返回** `[待验证]`：表中返回结构依据 schema 与 mapper 推断，未在空库 fixture 上逐条跑通。验证方法：用隔离的 `LEARNING_AGENT_HOME` 起应用，对 37 个方法逐一记录空库返回 JSON，与本表字段比对。
4. **`scopeOverride` 类型透传** `[源码]`：`CH-03` 入参 `scopeOverride?: unknown` 在主进程 `as never` 强转（`index.ts:473`），其内部结构与校验归属 agent 服务，本文未展开；验证方法见 `07-domain-services-and-determinism.md` 的 agent 输入契约。
5. **`onChatEvent` 监听器泄漏** `[待验证]`：preload 返回取消订阅函数，但渲染层在会话切换/组件卸载时是否全部调用，本文未核对；验证方法：在 DevTools 事件监听面板或 `ipcRenderer.on` 包装处统计监听器增减。
6. **settings 文件 BOM / 损坏路径** `[源码]`：`settings.ts:19,38,41` 处理 BOM 与 JSON 损坏，损坏时 `configError` 回传；具体 UI 提示见 04，本文未覆盖。

## 7. 交叉引用

- 启动装配顺序、`initServices` 与窗口创建：`02-main-runtime-and-boot.md#2-结构与流程`
- 渲染层页面、交互流程与事件状态机呈现：`04-renderer-ui-flows.md#2-结构与流程`
- Python sidecar 拉起、端口与离线降级：`06-news-sidecar-and-network.md#4-可测点`（`news.refresh` 依赖的 `/run` 契约）
- 各领域服务输入输出与确定性分级、LLM 调用点：`07-domain-services-and-determinism.md#4-可测点`
- SQLite 表结构、种子库与 `LEARNING_AGENT_HOME` 隔离：`08-data-fixtures-and-isolation.md#4-可测点data-xx`
- Playwright / WDIO / 自定义驱动如何挂载 `window.learning`：`10-harness-strategy.md#4-可测点与方案设计`
- 场景目录对本文件 ID 的引用：`11-scenario-catalog.md`（待建）
- 既有 `verify-*.ts` 脚本对 cancel / stream / settings 的源码级断言：`09-existing-verification-and-gaps.md#4-可测点既有资产清单覆盖矩阵与缺口`
