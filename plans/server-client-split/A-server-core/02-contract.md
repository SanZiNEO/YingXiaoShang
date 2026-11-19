# A · 服务端骨架 · 契约

> 轮次：A · 服务端骨架
> 文档角色：02-contract
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1（本文件只细化，不新增错误码、不改端口）
> 一句话：客户端照这份文档发请求，服务端照这份文档回响应；两边都不用猜。

## 1 契约总览

| 层 | 冻结 | 本轮细化 |
|---|---|---|
| 传输 / 端口 / 前缀 | §2、§10 | — |
| 鉴权与归属 | §3 | token 表结构、`ignoredStudentId` 日志位（§4.4） |
| RPC 信封与错误码 | §4 | 每个方法的入参校验规则与中文消息（§3） |
| 30 方法清单 | §5 | 返回结构的 JSON Schema 名与关键字段（§5） |
| 5 通道 | §7 | SSE 帧样例、取消时序、交卷回读（§6） |
| OpenAPI | §8 | 文件结构、`x-legacy-methods` 写法（§8） |

**契约稳定性**：本文件里出现的字段名、错误码、事件名，视为 v1 冻结。新增字段允许（客户端必须容忍未知字段），删改字段需要升到 v2。这种「接口放 paths、结构放 components」的分法遵循 [R2] 的组织方式，便于生成器与覆盖检查复用同一份文件。

## 2 RPC 信封（逐字）

### 2.1 请求

```http
POST /api/v1/rpc HTTP/1.1
Host: 127.0.0.1:8080
Authorization: Bearer 7fK...（43 字符）
Content-Type: application/json; charset=utf-8

{"method":"news.list","params":{"source":"36kr","limit":10},"requestId":"req_9f2a1b"}
```

| 字段 | 类型 | 必填 | 校验与消息 |
|---|---|---|---|
| `method` | string | 是 | 非空；不在注册表 → `404 UNKNOWN_METHOD` + `没有这个方法：<method>` |
| `params` | object | 否 | 非对象（数组/字符串/null）→ `400 BAD_REQUEST` + `params 必须是对象。` |
| `requestId` | string | 否 | 若给：`^req_[a-z0-9]{1,24}$`；不合规则忽略并重新生成（不报错，避免客户端卡死） |

信封字段命名沿用 JSON-RPC 的 `method`/`params` 习惯，但把 `id` 换成 `requestId` 并用 HTTP 状态码承载成败 [R3]。

### 2.2 成功

```json
{ "ok": true, "result": [ … ], "requestId": "req_9f2a1b", "elapsedMs": 7 }
```

### 2.3 失败

```json
{ "ok": false,
  "error": { "code": "BAD_REQUEST", "message": "limit 必须是 1 到 200 的整数。", "field": "limit" },
  "requestId": "req_9f2a1b", "elapsedMs": 2 }
```

- `detail` 仅在服务端内部错误时出现，且只放分类（如 `{"stage":"db"}`），**不放堆栈、不放 SQL、不放文件路径** [R7]。
- `field` 仅 `BAD_REQUEST` 时出现，值为出错的参数名。

### 2.4 响应头

| 头 | 值 | 说明 |
|---|---|---|
| `Content-Type` | `application/json; charset=utf-8` | 中文不转义 |
| `X-Request-Id` | 同 `requestId` | 便于用日志对账 |
| `Cache-Control` | `no-store` | 业务响应不缓存 |

## 3 数据结构与入参校验（30 个方法）

> 方法名、必填项、返回顶层、写/归属标记见冻结表 §5。本节只补「校验规则 + 失败消息 + Schema 名」。
> 通用规则：**字符串一律 trim 后判空**；`limit` 一律整数，非整数 → `400`；`limit` 越界按表内夹取（不报错，因为客户端常传大值）。
> 校验器写法参考 [R4] 的「声明式参数 → 自动校验 + 文档」思路，但我们只保留中文消息与 `field`，不引入它的反射框架。

| method | 校验规则 | 失败消息（逐字） | 结果 Schema |
|---|---|---|---|
| `student.current` | 无参 | — | `StudentCurrentResult` |
| `chapters.list` | 无参 | — | `ChaptersListResult`（数组） |
| `kps.list` | `chapter` 可空串（当未传）；`query` ≤200 字符；`limit` 1..500，默认 80 | `query 最多 200 个字符。` / `limit 必须是 1 到 500 的整数。` | `KpsListResult` |
| `news.list` | `source` ≤64；`since` ISO-8601（`YYYY-MM-DD` 或完整时间）；`limit` 1..200，默认 20 | `since 必须是 ISO 日期，例如 2026-11-01。` / `limit 必须是 1 到 200 的整数。` | `NewsListResult` |
| `news.status` | 无参 | — | `NewsStatusResult` |
| `news.refresh` | `sources` 字符串数组，每项 ≤64，≤32 项 | `sources 必须是非空字符串数组。` | `NewsRefreshResult` |
| `news.get` | `articleId` 必填 | `articleId 不能为空。` / 不存在 → `NOT_FOUND` | `NewsGetResult` |
| `news.match` | `articleId` 必填；`topK` 1..10，默认 3 | `topK 必须是 1 到 10 的整数。` | `NewsMatchResult` |
| `questions.attempts` | `questionIds` 字符串数组 ≤500；`limit` 1..1000，默认 200 | `questionIds 必须是非空字符串数组。` | `QuestionsAttemptsResult` |
| `profile.get` | 无参 | — | `ProfileGetResult` |
| `profile.growth` | `chapterId` 可空 | — | `ProfileGrowthResult` |
| `profile.evidence` | `competencyId` ≤64；`chapterId` ≤64；`limit` 1..500，默认 100 | `limit 必须是 1 到 500 的整数。` | `ProfileEvidenceResult` |
| `profile.snapshot` | `chapterId` 必填；`checkpoint` ∈ `pre|post` | `chapterId 不能为空。` / `checkpoint 必须是 pre 或 post。` | `ProfileSnapshotResult` |
| `profile.review` | `evidenceId` 必填；`status` ∈ `draft|reviewed|rejected`；`note` ≤2000 | `status 必须是 draft、reviewed 或 rejected。` | `ProfileReviewResult` |
| `artifacts.list` | `limit` 1..200，默认 50 | `limit 必须是 1 到 200 的整数。` | `ArtifactsListResult` |
| `artifacts.get` | `artifactId` 必填；归属校验 | `artifactId 不能为空。` / `403` / `404` | `ArtifactsGetResult` |
| `artifacts.export` | `artifactId` 必填；`format` ∈ `md|docx|html`，缺省 `docx` | `format 必须是 md、docx 或 html。` | `ArtifactsExportResult`（`{path}`） |
| `memory.facts` | 无参 | — | `MemoryFactsResult` |
| `memory.episodes` | `limit` 1..200，默认 50 | `limit 必须是 1 到 200 的整数。` | `MemoryEpisodesResult` |
| `memory.summary` | 无参 | — | `MemorySummaryResult` |
| `memory.upsert` | `key` 必填 ≤120；`value` 任意 JSON（≤64KB）；`kind` 6 值，**非法值归一为 `goal`**（保留现状） | `key 不能为空。` / `value 不能为空。` | `MemoryUpsertResult` |
| `memory.delete` | `factId` 必填；归属校验 | `factId 不能为空。` / `403` | `MemoryDeleteResult` |
| `chat.sessions` | 无参 | — | `ChatSessionsResult` |
| `chat.messages` | `sessionId` 必填；归属校验 | `sessionId 不能为空。` / `403` | `ChatMessagesResult` |
| `agent.snapshot` | `sessionId?`、`chapterId?` | — | `AgentSnapshotResult` |
| `agent.suggestions` | `sessionId?` | — | `AgentSuggestionsResult` |
| `agent.turns` | `sessionId` 必填；`limit` 1..500，默认 50；归属校验 | `sessionId 不能为空。` | `AgentTurnsResult` |
| `agent.ledger` | 无参 | — | `AgentLedgerResult` |
| `agent.retry` | `sourceId` 必填 | `sourceId 不能为空。` | `AgentRetryResult`（同 `AgentLedgerResult`） |
| `agent.sessions` | 无参 | — | `AgentSessionsResult` |

**`memory.upsert` 的 `value`**：允许对象/数组/字符串/数字/布尔；`null` → `value 不能为空。`；序列化后 >64KB → `400` + `value 太大了（上限 64 KB）。`

## 4 错误、鉴权与归属

### 4.0 错误映射落地位置

码表以冻结文件 §4.2 为唯一真相源；本节只约定三件事：**在哪抛、抛什么、客户端怎么收**。

| 层 | 抛什么 | 谁转成信封 |
|---|---|---|
| `src/rpc/validate.ts` | `BadRequest(field, message)` | `respond.ts` → `400 BAD_REQUEST` |
| `src/auth/bearer.ts` | `AuthRequired` / `AuthInvalid` | `respond.ts` → `401` |
| `src/ownership.ts` | `Forbidden` | `respond.ts` → `403` |
| handler 查不到记录 | `NotFound` | `respond.ts` → `404 NOT_FOUND` |
| `packages/*` 抛原生错误 | `ApiError('INTERNAL', …)` | `friendlyError` 兜底成中文（`apps/desktop/src/main/errors.ts:9-67`） |

**分类原则**：错误码只由「失败语义」决定，不由「哪个模块抛的」决定。同一个 `NOT_FOUND` 不许在新闻与产物两处用不同 code [R7]。

### 4.1 登录时序

```text
POST /auth/login {studentId,password}
  → 若 studentId 格式非法（非 4..20 位字母数字）: 400 + "学号格式不对。"
  → 查 auth_students；无记录或口令不匹配: 401 AUTH_FAILED + "学号或口令不对，请检查后再试。"
  → 签发 token（32B 随机 → base64url）; 存 sha256(token)
  → 200 {token,expiresAt,student}
```

- `expiresAt` = 签发 + 7 天（`YXS_TOKEN_TTL_DAYS`）。
- 不做「记住我」；不做 refresh token。

### 4.2 token 校验

```text
Authorization: Bearer <token>
  → 无头/非 Bearer: 401 AUTH_REQUIRED "请先登录。"
  → sha256 查 auth_tokens: 无记录/ revoked_at 非空 / expires_at < now: 401 AUTH_INVALID "登录已失效，请重新登录。"
  → 命中: ctx.studentId = student_id
```

### 4.3 归属校验（4 类）

| 方法 | 校验依据 | 失败 |
|---|---|---|
| `chat.messages`、`agent.turns` | `chat_sessions.student_id` | `403 FORBIDDEN` |
| `artifacts.get`、`artifacts.export` | `artifacts.student_id` | `403` |
| `profile.review` | `evidence.student_id` | `403` |
| `memory.delete` | `memory_facts.student_id` | `403` |

`403` 统一消息：`这个资源不属于当前学号，换回自己的账号再试。`

### 4.4 请求体里的 `studentId`

收到也不报错，但**必须忽略**并记 `ignoredStudentId: true`。这条让「客户端无感迁移」成立：桌面端现有调用都带 `studentId`（`apps/desktop/src/main/index.ts:204-207`），切 HTTP 时不用逐个删参数。

## 5 返回结构（关键对象字段）

> 完整 JSON Schema 写在 `docs/contracts/openapi.yaml`；此处给**不可缺的字段**，实现时少一个就算违约。
> 字段命名与 `packages/db` 的列名保持同构（如 `published_at` 不改成 `publishedAt`），这样 OpenAPI 能直接复用表结构，不用维护第二套命名 [R2]。

| Schema | 必含字段 | 来源 |
|---|---|---|
| `StudentCurrentResult` | `studentId`,`name`,`cohort` | `db.getStudentProfile`（`index.ts:210-212`） |
| `Chapter` | `id`,`number`,`title` | `db.listChapters` |
| `KnowledgePoint` | `id`,`chapter_id`,`name`,`summary?` | `db.searchKps` / `listKpsByChapter` |
| `NewsArticle` | `id`,`source`,`title`,`url`,`published_at`,`summary`,`content`,`content_status` | `db.listNews`；与侧车 `news_articles` 列同名（`services/news-crawler-py/src/news_crawler/db.py:24-44`） |
| `NewsStatusResult` | `count`,`newestFetchedAt` | `db.countNews` / `db.newestNewsFetchedAt` |
| `NewsRefreshResult` | `results`,`queued`,`accepted`,`count`,`newestFetchedAt` | `index.ts:266-272` |
| `NewsGetResult` | `article`,`matches`,`ideology` | `index.ts:274-282` |
| `NewsMatchResult` | `matches[]`（每项含 `kp_id`,`score`,`evidence`,`review_status`） | `matcher.match` |
| `ProfileGetResult` | `profile`,`competencies`,`recentEvidence?` | `profileService.getProfile` |
| `ProfileGrowthResult` | `chapterId`,`summary`,`dimensions[]` | `profileService.growthSummary` |
| `Evidence` | `id`,`student_id`,`competency_id`,`chapter_id`,`status`,`note`,`occurred_at` | `packages/db/src/index.ts:245-258` |
| `Artifact` | `id`,`student_id`,`kind`(`page|question_set`),`title`,`path`,`created_at`,`content?` | `packages/db/src/index.ts:308-314` |
| `ArtifactsExportResult` | `path`（绝对路径，服务端可见） | `artifacts.export`（`index.ts:323-324`） |
| `MemoryFact` | `id`,`kind`,`key`,`value`,`updated_at` | `memory_facts` 表 |
| `ChatSession` | `id`,`title`,`created_at`,`updated_at` | `chat_sessions` 表 |
| `ChatMessage` | `id`,`session_id`,`role`,`content`,`seq`,`created_at` | `chat_messages` 表（含 `seq` 唯一索引 `index.ts:338`） |
| `TurnRow` | `id`,`session_id`,`status`,`started_at`,`finished_at?` | `turns` 表（`index.ts:340-353`） |
| `AgentLedgerResult` | `items[]`、`counts{pending,posted,failed}` | `agentRuntime.listLedger` |
| `HealthResult` | `ok`,`warnings[]`,`notices[]`,`chapters`,`knowledgePoints`,`newsArticles`,`appHome`,`version`,`uptimeMs` | `startupHealth`（`health.ts:11-33`） |

**`artifacts.export` 的 `path` 语义**：HTTP 客户端拿不到服务端文件系统，返回值只用于日志/排查。真正下载走 `GET /api/v1/artifacts/{id}/file`（**v2 候选，本轮不做**）。这一点必须写进客户端文档，否则小程序会以为能直接打开 `path`。

## 6 事件与通道（SSE / answer / health）

### 6.1 `POST /api/v1/chat/stream` 帧样例（逐字节可对照）

```text
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
X-Accel-Buffering: no
Connection: keep-alive

id: 1
event: session
data: {"requestId":"req_9f2a1b","sessionId":"s_7c1e"}

id: 2
event: round
data: {"requestId":"req_9f2a1b","round":1}

id: 3
event: text
data: {"requestId":"req_9f2a1b","agent":"lead","text":"先看这章的"}

id: 4
event: tool
data: {"requestId":"req_9f2a1b","tool":"read_kp"}

id: 5
event: tool-end
data: {"requestId":"req_9f2a1b","tool":"read_kp","chars":812,"cached":false}

id: 6
event: done
data: {"requestId":"req_9f2a1b","turnId":"t_31","sessionId":"s_7c1e","text":"先看这章的定义…","artifacts":[],"citations":[],"warnings":[]}

```

规则：

1. `id` 从 1 递增，不复用；`done` 之后不再有事件。
2. 每帧之间空一行（SSE 规范）。
3. `text` 是**增量**，客户端拼接；`done.text` 是**全量**，客户端可用它兜底纠正。
4. `agent` 恒为 `"lead"`（本轮只有一个说话人）；保留字段是为了不破坏 `TeamEvent` 形状 [R10]。
5. 异常时只发 `event: error` + `data:{requestId,code,message}`，然后关闭；**不补发 `done`**。
6. 心跳用注释行 `: keep-alive`，每 15s 一次，不带 `id`。
7. 客户端断开（`req.aborted`）→ 服务端立即 `abort` 该 `requestId`，并清理 `Map`。

### 6.2 `POST /api/v1/chat/cancel`

```json
{"requestId":"req_9f2a1b"}
→ 200 {"ok":true,"result":{"cancelled":true},"requestId":"req_9f2a1b","elapsedMs":1}
```

时序契约：

```text
t0  客户端发 cancel
t0+ε 服务端 abort(requestId) → 执行链抛 AbortError → stream 发 error(CANCELLED) → close
t0+1s 断言：该 requestId 不再出现 text 事件（E 轮用例 AC-E-13）
```

`cancelled:false` 的两种情况：`requestId` 不存在、或该轮已 `done`。

### 6.3 `POST /api/v1/answer` / `POST /api/v1/answer-set`

```json
POST /api/v1/answer
{"sessionId":"s_7c1e","questionId":"q1","answer":"因为…","artifactId":"a_9","chapterId":"ch04"}
→ 200 {"ok":true,"result":{"turnId":"t_32","text":"这题你抓住了…","feedback":{…},"evidence":[…],"ledger":{…},"warnings":[],"status":"completed"}}
```

```json
POST /api/v1/answer-set
{"sessionId":"s_7c1e","artifactId":"a_9","answers":[{"questionId":"q1","answer":"…"},{"questionId":"q2","answer":"…"}]}
→ 200 {"ok":true,"result":{"turnId":"t_33","text":"这一卷…","results":[…],"ledger":{…},"warnings":[],"status":"completed"}}
```

- `answers: []` → `400` + `这一卷还没有作答，先答一题再交。`
- 任一 `questionId` 不在该 `artifactId` 的题目集里 → `400` + `题目 q7 不在这一卷里，先刷新题目集再交。`
- 失败消息必须带「没记成成绩」语义（`errors.ts:13-15` 的 `retryHint`）：`这次作答没有记成成绩，可以直接重试。`

### 6.4 `GET /api/v1/health`

```json
{"ok":true,"result":{
  "ok":true,"warnings":[],"notices":["本地新闻库还是空的（不影响聊天）…"],
  "chapters":13,"knowledgePoints":412,"newsArticles":0,
  "appHome":"/data","version":"0.1.0","uptimeMs":3210}}
```

- 章节 0 → `warnings[0]` = `没有读到课程章节（0 个）。安装包可能不完整：请重新解压一次安装包；若仍不行，联系老师重新要一份。`
- 有章节但知识点 0 → `读到了章节，但知识点是 0 个。安装包可能不完整，请重新解压一次安装包。`
- 有章节且新闻 0 → `notices[0]` = `本地新闻库还是空的（不影响聊天）。问新闻时会提示「本地没有」，需要联网补抓。`
  （三条文案逐字来自 `apps/desktop/src/main/health.ts:18-30`，不得改写）

## 7 4 个 legacy 只读方法（不计入 30）

这 4 个方法不在主清单里但必须可用——渲染层的引用溯源与思政页还在调它们。「主清单之外仍允许一批白名单方法」这种处理方式，参考 [R12] 对未知方法与已注册方法的区分。

| method | params | 返回 | 证据 |
|---|---|---|---|
| `getKp` | `{kpId}` | `KnowledgePoint` | `apps/desktop/src/main/index.ts:225-226` |
| `getBlock` | `{blockId}` | `{block, chapter?, section?}` | `index.ts:227-235` |
| `getResource` | `{resourceId}`（兼容 `sourceId`） | `{guide, chapter?}` | `index.ts:236-248` |
| `listIdeology` | `{}` | `IdeologyPoint[]` | `index.ts:249-250` |

- 命名空间：写进 OpenAPI 的 `paths./api/v1/rpc` 之外的 `x-legacy-methods` 数组，元素为 `{name, params, result}`。
- 调用方式与 30 方法相同（同一个 `/rpc`），因此 `method` 白名单要包含这 4 个。
- 为什么必须实现：`App.tsx:627/635/643`、`pages.tsx:124` 仍在调；不实现则桌面端切 HTTP 后引用溯源直接断。

## 8 OpenAPI 结构与兼容策略

```yaml
openapi: 3.0.3
info: { title: 营小商服务端, version: 0.1.0 }
servers: [{ url: http://127.0.0.1:8080 }]
security: [{ bearerAuth: [] }]
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer, bearerFormat: opaque }
  schemas: { … 30 个 *Result + 实体 … }
paths:
  /health: { get: … security: [] }
  /metrics: { get: … security: [] }
  /api/v1/auth/login: { post: … security: [] }
  /api/v1/auth/logout: { post: … }
  /api/v1/auth/cas/callback: { get: …, post: … }      # 501
  /api/v1/auth/oauth/callback: { get: …, post: … }    # 501
  /api/v1/rpc: { post: { requestBody: { method: enum[30] } } }
  /api/v1/chat/stream: { post: { responses: { 200: text/event-stream } } }
  /api/v1/chat/cancel: { post: … }
  /api/v1/answer: { post: … }
  /api/v1/answer-set: { post: … }
  /api/v1/openapi.yaml: { get: … }
x-legacy-methods: [ getKp, getBlock, getResource, listIdeology ]
```

约束：

- `method` 的 `enum` **恰好 30 项**，顺序与冻结表一致；`x-legacy-methods` 单独列 4 个，不进 enum。
- 每个 `*Result` 至少声明 `type` 与 `required`；对象用 `additionalProperties: true`（允许新增字段）。
- 5 个通道必须在 `paths` 里各有条目；`chat/stream` 的 200 响应 `content` 只能是 `text/event-stream`。
- 文件必须能被 `python -c "import yaml,sys;yaml.safe_load(open(...))"` 解析（CI 自检用它，不引第三方 OpenAPI 校验器 [R37]）。

## 9 契约测试映射（给 E 轮的对照表）

| 契约点 | 建议用例编号 | 断言 |
|---|---|---|
| 信封成功/失败形状 | `CT-RPC-01/02` | `ok` 布尔、`requestId` 回显、`error.code` 在码表内 |
| 30 方法合法输入 | `CT-M-01..30` | 每个方法返回 `ok:true` 且顶层字段齐全（§5 表） |
| 30 方法非法输入 | `CT-BAD-01..30` | 缺必填 → 该方法的逐字消息；类型错 → `400` |
| 未知方法 | `CT-RPC-03` | `404` + `没有这个方法：foo` |
| 未鉴权 | `CT-AUTH-01` | `401` + `请先登录。` |
| 越权 | `CT-AUTH-02` | 用学生 B 的 token 读学生 A 的会话 → `403` |
| SSE 顺序 | `CT-SSE-01` | 第一条是 `session`，含 `sessionId`；最后一条是 `done` |
| SSE 取消 | `CT-SSE-02` | `cancel` 后 1s 内无新 `text`；收到 `error.CANCELLED` |
| 交卷回读 | `CT-ANS-01` | `answer-set` 后 `questions.attempts` 能查到这些题 |
| 健康无鉴权 | `CT-H-01` | 不带 token 也 200，且 `warnings` 为数组 |
| legacy 4 方法 | `CT-L-01..04` | 合法输入 200，字段齐全 |
| OpenAPI 覆盖 | `CT-OAS-01` | 读 `docs/contracts/openapi.yaml`，enum 恰好 30 |

用例编号的写法（一个编号一条断言、失败原因写在断言文本里）参考 [R36] 的测试组织建议；这样 E 轮的报告能直接指到「哪一条契约点挂了」。

## 参考

- [R3] JSON-RPC 2.0 规范 — https://www.jsonrpc.org/specification — 支撑 §2 信封与 §3 的 `code/message` 分工 — 借鉴 `error` 对象，去掉 batch/notification，改为 HTTP 状态码承载。
- [R10] WHATWG SSE — https://html.spec.whatwg.org/multipage/server-sent-events.html — 支撑 §6.1 帧格式（`id`/`event`/`data`/空行） — 采用规范帧，不做 Last-Event-ID 重放。
- [R11] MDN SSE 指南 — https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events — 支撑 §6.1 心跳注释行与 `X-Accel-Buffering` — 采用 15s keep-alive；不用 polyfill。
- [R2] OpenAPI 3.0.3 规范 — https://spec.openapis.org/oas/v3.0.3 — 支撑 §8 的 `securitySchemes`/`requestBody.enum`/`text/event-stream` 写法 — 采用 3.0.3；不用 3.1 的 `jsonSchema` 方言。
- [R7] OWASP REST Security — https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html — 支撑 §2.3「`detail` 不放堆栈」与 §4 归属校验 — 采用最小信息披露。
- [R9] Node.js crypto — https://nodejs.org/api/crypto.html — 支撑 §4.1 的 token 随机与 `timingSafeEqual` — 采用 32 字节随机 + sha256 存储。
- [R37] Redocly CLI 文档 — https://redocly.com/docs/cli — 支撑 §8 的「先 lint 再比对覆盖」思路 — 借鉴校验顺序；不引入其云服务（本轮用 PyYAML 自检）。
