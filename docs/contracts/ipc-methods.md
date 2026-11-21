# 接口契约（IPC 方法清单 → HTTP）

> 用途：把现有 `window.learning.*` 能力映射成 HTTP 服务端要提供的接口。
> 现状：业务实现已抽到 `packages/dispatch/src/index.ts` 的 `dispatchMethod(deps, method, input, ctx)`
> （不是 `createDispatch`；桌面端与服务端都调它，服务端另有一层 `rpc/handlers` 做校验与 schema）。
> 这是 `apps/server` 的输入，也是 Web 前端的依据、契约测试的基准。
> 基线：`packages/dispatch`（业务分发，桌面与服务端共用）+ `apps/desktop/src/main/index.ts`（8 个独立通道）+ `apps/desktop/src/preload/index.ts`（暴露面）。
> 版本：v1 · 2026-11-19

---

## 一、总则

### 1.1 三类通道

| 类别 | 桌面实现 | Web 实现建议 |
|---|---|---|
| 请求/响应 | `learning:invoke`（37 个 method） | `POST /rpc/{method}`，body 即入参对象 |
| 独立通道 | `learning:chat` / `answer` / `answer-set` / `health` / `cancel` / `settings:*` | `POST /chat`、`POST /answer`、`POST /answer-set`、`GET /health`、`POST /cancel`、`/settings` |
| 事件流 | `learning:chat-event`（主进程 → 渲染层） | **SSE**（`GET /chat/{requestId}/events`）或 WebSocket |

> 为什么用「一个 RPC 端点 + method 名」而不是 37 个 REST 路径：现有业务是命令式的，
> 一一映射 REST 会发明一堆语义不清的动词路径。RPC 风格能保证桌面与 Web 行为一致。
> 若学校要求 REST 风格，可在 RPC 之上再加一层薄薄的路由映射，不影响内部实现。

### 1.2 鉴权（**与桌面端最大的不同**）

桌面端：`invoke()` 仍允许入参覆盖学生（演示切学生用），内部把它作为 `ctx.studentId` 传给 `dispatchMethod`；
**`dispatchMethod` 自己只认 `ctx.studentId`，从不读入参**（`verify-dispatch.ts` 有越权断言守着）。
**Web 端必须改**：

```
请求头 Cookie/Authorization → 服务端解析出 session → 得到 studentId
→ 忽略客户端传入的 studentId（如传入，只允许本人）
```

理由：桌面是单机单人，传谁都无所谓；Web 多人共用一台服务器，信客户端传的 studentId
等于让任何学生读别人的学情。现有 `assertSessionOwner` / `assertQuestionSetOwner`
必须保留并在服务端强制执行。

### 1.3 错误契约

- 所有面向学生的错误必须是**中文 + 可执行**（现有 `apps/desktop/src/main/errors.ts` 的 `friendlyError` 是唯一来源，服务端复用同一函数）。
- 响应格式：`{ ok: false, error: { code, message } }`，HTTP 状态码与 `code` 对应：
  `401 未登录/过期`、`403 越权`、`400 参数错`、`429 太频繁`、`500 服务端问题`。
- **不要把上游英文栈返回给学生**（`friendlyError` 已处理，服务端别绕过它）。

### 1.4 事件流（SSE）

`POST /chat` 立刻返回 `{ requestId, sessionId }`，随后事件通过
`GET /chat/{requestId}/events`（`text/event-stream`）推送，事件类型与现有 `TeamEvent` 一致：

```
session   { sessionId }                       ← 建会话后立刻发（首轮失败也有 id）
round     { round }
text      { agent:'lead', text }              ← 增量文字，前端累加，不清屏
tool      { tool }                            ← 只更新阶段文案，不撤已出文字
tool-end  { tool, chars, cached }
```

**约束（都有断言在守）**：
- 已出文字不能因后续事件消失（`R21:11/48/80`）
- 事件必须绑 `requestId`，晚到的上一轮事件要丢弃（`verify-stream.ts`）
- 停止：`POST /cancel { requestId }` 必须真的中断在途模型请求（`verify-cancel-wiring.ts` 是源码级断言，服务端要给出等价证据）

---

## 二、请求/响应方法（37 个）

> 「参数」列只列入参键；`studentId` 一律由会话派生，不在下表重复。

| # | method | 参数 | 返回（概要） | 备注 |
|---|---|---|---|---|
| 1 | `student.current` | — | `{ studentId, name, cohort }` | Web 端返回当前登录学生 |
| 2 | `chapters.list` | — | `Chapter[]` | |
| 3 | `kps.list` | `chapter?, query?, limit?` | `KnowledgePoint[]` | 有 query 走 `searchKps` |
| 4 | `getKp` | `kpId` | `KnowledgePoint \| undefined` | |
| 5 | `getBlock` | `blockId` | `{ block, chapter?, section? }` | 教材原文块 |
| 6 | `getResource` | `resourceId \| sourceId` | `{ guide, chapter? }` | 资源导读 |
| 7 | `listIdeology` | — | `IdeologyPoint[]` | 思政元素 |
| 8 | `news.list` | `source?, since?, limit?` | `NewsArticle[]` | |
| 9 | `news.status` | — | `{ count, newestFetchedAt }` | |
| 10 | `news.refresh` | `sources?` | `{ results, queued, accepted, count, newestFetchedAt }` | 触发采集 + `matcher.backfill(20)` |
| 11 | `news.get` | `articleId` | `{ article, matches, ideology }` | |
| 12 | `news.match` | `articleId, topK?` | `{ matches }` | 调模型，慢 |
| 13 | `questions.attempts` | `questionIds?, limit?` | `QuestionAttempt[]` | |
| 14 | `profile.get` | — | `ProfileData` | |
| 15 | `profile.growth` | `chapterId?` | 成长摘要 | |
| 16 | `profile.evidence` | `competencyId?, chapterId?, limit?` | `Evidence[]` | |
| 17 | `profile.snapshot` | `chapterId, checkpoint:'pre'\|'post'` | 快照 | 写入 |
| 18 | `profile.review` | `evidenceId, status:'draft'\|'reviewed'\|'rejected', note` | `{ ok:true }` | 写入，**老师用** |
| 19 | `artifacts.list` | `limit?` | `Artifact[]` | |
| 20 | `artifacts.get` | `artifactId` | `Artifact \| undefined` | |
| 21 | `artifacts.export` | `artifactId, format` | 导出内容 | 桌面写文件；Web 返回内容或下载 URL |
| 22 | `memory.facts` | — | `MemoryFact[]` | |
| 23 | `memory.episodes` | `limit?` | `MemoryEpisode[]` | |
| 24 | `memory.summary` | — | `MemorySummary` | |
| 25 | `memory.upsert` | `kind, key, value` | 事实 | `kind` 六选一 |
| 26 | `memory.delete` | `factId` | `{ ok:true }` | 写入 |
| 27 | `chat.sessions` | — | `ChatSession[]` | |
| 28 | `chat.messages` | `sessionId` | `ChatMessage[]` | **已加归属校验**：不属于本人抛错、会话不存在返回 `[]`（`dispatch` 内实现，`verify-dispatch.ts` 覆盖） |
| 29 | `agent.snapshot` | `sessionId?, chapterId?` | `LearningStateSnapshot` | |
| 30 | `agent.suggestions` | `sessionId?` | `LearningSuggestions` | |
| 31 | `agent.turns` | `sessionId, limit?` | `TurnRow[]` | |
| 32 | `agent.ledger` | — | `LedgerStatus` | 记录器状态 |
| 33 | `agent.retry` | `sourceId` | `LedgerStatus` | 重试整理 |
| 34 | `agent.sessions` | — | 会话摘要 | 运行时可选方法 |
| 35 | `files.reveal` | `path` | `{ ok:true }` | **桌面专属** |
| 36 | `files.preview` | `path` | 预览数据 | **桌面专属**（Web 改上传） |
| 37 | `files.openDialog` | — | 预览数据 \| undefined | **桌面专属**（Web 用 `<input type=file>`） |

---

## 三、独立通道（8 个：invoke / chat / answer / answer-set / cancel / health / settings:get / settings:set）

| 通道 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `learning:invoke` | `method, input` | 见上表 | Web: `POST /rpc/{method}` |
| `learning:chat` | `sessionId?, message, scopeOverride?, chapterId?, requestId?` | `TurnResponse`（含 `sessionId`、`artifacts`、`citations`、`plan`、`trace`） | 长任务；Web 用 SSE 推事件 |
| `learning:answer` | `sessionId, questionId, answer, artifactId?, chapterId?` | 单题判分结果 | |
| `learning:answer-set` | `sessionId, artifactId, answers[], chapterId?` | `{ status:'completed'\|'partial'\|'failed', results[], text }` | 交卷；失败要标明「没记成成绩」 |
| `learning:cancel` | `requestId` | `{ cancelled:boolean }` | |
| `learning:health` | — | `{ ok, warnings[], notices[], appHome }` | Web: 去掉 `appHome`，改 `version`/`db` |
| `learning:settings:get` | — | `{ hasApiKey, apiKeySource, model, configError }` | **Web 不应把 key 给前端** |
| `learning:settings:set` | `apiKey?, model?, clearApiKey?` | 同上 | Web 端禁用（服务端统一配置） |

---

## 四、Web 版必须新增的接口（现有 IPC 没有）

### 4.1 认证

| 接口 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `auth.login` | `studentNo, password` | `{ studentId, name, cohort }` + 会话 Cookie | 学号+口令兜底（密码用 scrypt/argon2） |
| `auth.logout` | — | `{ ok:true }` | |
| `auth.me` | — | 当前学生或 `null` | 前端启动时判断是否已登录 |
| `auth.sso.start` / `auth.sso.callback` | — / `code, state` | 同上 | 学校统一认证（拿到接口后再实现） |

### 4.2 老师端（M1 的验收判据要用）

| 接口 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `teacher.classes` | — | `Class[]` | 老师带的班 |
| `teacher.class.students` | `classId` | `StudentSummary[]` | 含最近活动时间、进度水位 |
| `teacher.student.timeline` | `studentId, limit?` | 事件时间线 | 问了什么、出什么题、答得怎样 |
| `teacher.class.mistakes` | `classId, chapterId?` | `{ questionId, stem, wrongRate, sampleAnswers[] }[]` | **错题分布**（老师最想看） |
| `teacher.class.export` | `classId, format` | 文件或下载 URL | Excel/CSV |

> 权限：老师只能看自己带的班；`studentId` 是否属于该班必须服务端校验。

### 4.3 桌面专属能力在 Web 的替代

| 桌面 | Web 替代 |
|---|---|
| `files.openDialog` | `<input type="file">` + `POST /upload` |
| `files.reveal` | 下载链接 |
| `files.preview` | 服务端解析后返回结构化内容（docx/pdf 解析在服务端做） |
| `settings.set(apiKey)` | 学生端**不允许**设置 key；模型由服务端配置 |

---

## 五、迁移注意（容易踩的三处）

1. **`studentId` 不再由客户端决定**。`dispatchMethod` 只认 `ctx.studentId`（已实现），
   服务端必须从会话派生 `ctx`。**这是安全关键**；桌面端保留入参覆盖只是为了演示切学生。
2. **`DEMO_STUDENT_ID`**：桌面端兜底用。Web 端绝不能有兜底——没有会话就是 401。
3. **长任务与超时**：`news.match`、`chat`、`answer-set` 都会调模型（10–60 秒）。
   Web 端要设 120 秒超时并对前端显示「正在处理」，不能像普通请求那样 30 秒断掉。

---

## 六、OpenAPI 骨架（建议）

```yaml
openapi: 3.0.3
info: { title: 营小商 API, version: 1.0.0 }
servers: [{ url: https://<校内域名>/api }]
components:
  securitySchemes:
    cookieAuth: { type: apiKey, in: cookie, name: yxs_session }
security: [{ cookieAuth: [] }]
paths:
  /health: { get: { ... } }
  /auth/login: { post: { ... } }
  /rpc/{method}:
    post:
      parameters: [{ name: method, in: path, required: true, schema: { type: string } }]
      requestBody: { content: { application/json: { schema: { type: object } } } }
      responses:
        '200': { description: OK }
        '401': { description: 未登录 }
        '403': { description: 越权 }
  /chat: { post: { ... } }
  /chat/{requestId}/events: { get: { ... } }   # text/event-stream
  /cancel: { post: { ... } }
  /teacher/classes: { get: { ... } }
  /teacher/classes/{classId}/mistakes: { get: { ... } }
```

`/rpc/{method}` 的每个 method 用 `oneOf` 或单独的 `requestBody` schema 描述；
契约测试（任务 E）按 method 逐个断言。

---

## 七、我会提供的配套

- ✅ `packages/dispatch`：已把 `invoke` 的 250 行 switch 抽成
  `dispatchMethod(deps, method, input, ctx)`。桌面端只留 40 行适配（`main` 从 560 → 408 行）。
  服务端若愿意也可以复用它（现有 `rpc/handlers` 走同一批 `services.*`，两者不冲突）。
- ✅ 种子库：`pipeline/seed-db.ts` 可离线生成（实测 13 章 / 244 知识点 / 108 条新闻 / 456 题），
  契约测试与压测都用它。
- ✅ 现有 16 个断言脚本（`scripts/verify-*.ts`），服务端接入后可复用其中的纯函数部分。
