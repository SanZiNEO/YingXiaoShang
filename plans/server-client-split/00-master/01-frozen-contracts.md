# 01 · 冻结契约 v1（A–I 共同口径）

> 本文件是九轮并行开工的**唯一技术口径**。它先于任何一轮的实现存在，因此任何一轮都不必等另一轮。
> 修改规则见 §12：先改本文件、登记版本，再改各轮文档。
>
> 所有「真实依据」都指向仓库当前代码，行号以 2026-11-19 的 `main` 分支为准。

---

## 1. 生效范围与术语

| 术语 | 含义 | 依据 |
|---|---|---|
| **方法（method）** | `POST /api/v1/rpc` 的 `method` 字段值，共 30 个，见 §5 | `apps/desktop/src/main/index.ts:203-393` |
| **专用通道（channel）** | 不走 RPC 的 5 个端点，见 §7 | `apps/desktop/src/main/index.ts:445-536` |
| **服务端** | 本轮新建的 `apps/server` | `plans/server-client-split/A-server-core/README.md` |
| **客户端** | Electron 渲染层 / 小程序 mock / 测试工具，只通过 HTTP 说话 | `apps/desktop/src/preload/index.ts:3-38` |
| **appHome** | 数据根目录；容器内为 `/data` | `docs/requirements/R17-local-data.md` §4 |
| **learning.db** | 业务主库，schema 归 `packages/db` | `packages/db/src/index.ts:92-448` |

**不在本轮范围（绝对不写）**：`packages/*`、`apps/desktop/**`（H 轮的唯一例外见 §11 与 `02-ownership-and-parallel.md`）。
服务端**可以 import** `@learning-agent/db`、`@learning-agent/agent` 等 workspace 包（只读使用，不改一行）。

---

## 2. 传输层

| 项 | 冻结值 | 说明 |
|---|---|---|
| Base URL | `http://127.0.0.1:8080` | 容器内监听 `0.0.0.0:8080` |
| API 前缀 | `/api/v1` | 版本写进路径，不做 header 协商 |
| 编码 | JSON，`charset=utf-8`，`ensure_ascii=false` | 中文错误消息必须原样返回 |
| 请求体上限 | 1 MiB | 超出 → `413 PAYLOAD_TOO_LARGE` + 中文消息 |
| `message` 长度上限 | 8000 字符（码点） | 超出 → `BAD_REQUEST` |
| 超时 | RPC 默认 10s；`news.refresh` 30s；`artifacts.export` 20s；SSE 空闲 60s 断开 | 超时也必须返回结构化错误，不能裸断 |
| 连接 | `keep-alive` 开启；`Connection: close` 时正常关闭 | 便于压测复用 |
| CORS | 默认关闭；`YXS_CORS_ORIGINS` 为空表示不响应跨域 | 小程序 mock 不连服务端，不需要 |
| 压缩 | 不实现 gzip | 降低复杂度，压测口径更干净 |

**路径与方法冻结表**

| 路径 | 方法 | 用途 | 鉴权 |
|---|---|---|---|
| `/health`、`/api/v1/health` | GET | 存活 + 数据自检 | 否 |
| `/metrics` | GET | Prometheus 文本 | 否（可 `YXS_METRICS_TOKEN` 保护） |
| `/api/v1/auth/login` | POST | 学号+口令登录 | 否 |
| `/api/v1/auth/logout` | POST | 注销当前 token | 是 |
| `/api/v1/auth/cas/callback` | GET/POST | 预留，本阶段 `501` | 否 |
| `/api/v1/auth/oauth/callback` | GET/POST | 预留，本阶段 `501` | 否 |
| `/api/v1/rpc` | POST | 30 个业务方法 | 是 |
| `/api/v1/chat/stream` | POST | 对话 SSE | 是 |
| `/api/v1/chat/cancel` | POST | 取消在途轮次 | 是 |
| `/api/v1/answer` | POST | 单题作答 | 是 |
| `/api/v1/answer-set` | POST | 交卷 | 是 |
| `/api/v1/openapi.yaml` | GET | 返回 `docs/contracts/openapi.yaml` 原文 | 否 |

---

## 3. 鉴权

### 3.1 登录

```json
POST /api/v1/auth/login
{ "studentId": "20230001", "password": "••••••" }

200 { "ok": true, "result": { "token": "…43 字符 base64url…", "expiresAt": "2026-11-26T02:00:00.000Z", "student": { "studentId": "20230001", "name": "张三", "cohort": "2023" } }, "requestId": "req_…" }
```

- 口令校验：**scrypt**，`N=16384, r=8, p=1, keylen=64`，存储列 `password_hash` 为 `scrypt$N$r$p$saltB64$hashB64`；比较用 `timingSafeEqual`。
  依据：`packages/db` 的 `student_profiles` 只有 `name/cohort`，没有口令列（`packages/db/src/index.ts:214-217`），因此口令表由服务端自建，见 §3.4。
- token：`crypto.randomBytes(32)` → base64url（43 字符），存**哈希**（`sha256`）而非原文；有效期 7 天。
- 失败：口令错与学号不存在**返回同一句话**（防枚举）：「学号或口令不对，请检查后再试。」→ `AUTH_FAILED` / HTTP 401。
- 频率限制：同一 IP 每分钟 5 次登录尝试，超出 `429` +「尝试太频繁，请等一分钟再试。」

### 3.2 携带与解析

```http
Authorization: Bearer <token>
```
- 缺失 → `401 AUTH_REQUIRED`，「请先登录。」
- 失效/过期 → `401 AUTH_INVALID`，「登录已失效，请重新登录。」
- **`studentId` 只从 token 解析**；请求体里若带 `studentId`，一律忽略（不报错，但记 `ignoredStudentId=true` 到日志）。
  依据：桌面端是每个调用显式传 `studentId`（`apps/desktop/src/main/index.ts:204-207`），拆到服务端后这条必须反转。

### 3.3 资源归属

- 会话类（`chat.messages`、`agent.turns`）：`chat_sessions.student_id` 必须等于当前学生，否则 `403 FORBIDDEN`「这条会话不属于当前学号。」
- 产物类（`artifacts.get`、`artifacts.export`）：`artifacts.student_id` 必须匹配，否则 `403`。
  依据：`artifacts` 表有 `student_id`（`packages/db/src/index.ts:308-314`）。
- 证据类（`profile.review`）：`evidence.student_id` 必须匹配（`packages/db/src/index.ts:245-258`）。
- 事实类（`memory.delete`）：按 `student_id` 查不到该 `factId` → `403`（不暴露「存在但不属于你」）。

### 3.4 服务端自有存储（避免改 `packages/db`）

`apps/server` 在 `<appHome>/data/auth.db` 建两张表，**不进 `packages/db` schema、不进 D 轮迁移范围**：

```sql
CREATE TABLE auth_students (
  student_id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  cohort TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE auth_tokens (
  token_hash TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
```

理由：`packages/db` 是别的轮次不碰的共享包，A 若往里加表会破坏 D 的迁移基线；独立 `auth.db` 还能让「业务库只读挂载」成为可能（G 轮备份只备 `learning.db`）。

### 3.5 CAS / OAuth2 预留

`GET/POST /api/v1/auth/cas/callback`、`/api/v1/auth/oauth/callback` 固定返回：

```json
501 { "ok": false, "error": { "code": "NOT_IMPLEMENTED", "message": "统一身份认证还没接，请先用学号口令登录。" }, "requestId": "req_…" }
```
不得 404、不得空实现 200——客户端要能区分「没这个功能」和「路径写错」。

---

## 4. RPC 信封与错误码

### 4.1 请求 / 响应

```json
POST /api/v1/rpc
{ "method": "news.list", "params": { "source": "36kr", "limit": 10 }, "requestId": "req_abc123" }

200 { "ok": true, "result": [ … ], "requestId": "req_abc123", "elapsedMs": 12 }

200/4xx/5xx { "ok": false,
  "error": { "code": "BAD_REQUEST", "message": "limit 必须是 1 到 200 的整数。", "field": "limit", "detail": {} },
  "requestId": "req_abc123", "elapsedMs": 3 }
```

- `requestId` 客户端可省；服务端必回。格式 `req_` + 12 位 base36。同一 `requestId` 10 分钟内重复提交**不幂等重放**，只保证日志可串（写操作重放会重复写，见 §5 `profile.snapshot`）。
- 成功一律 HTTP 200（含业务空结果）；失败按 §4.2 映射 HTTP 状态。
  理由：客户端只需看 `ok`，压测和契约测试也只断言一处。

### 4.2 错误码表（冻结，不得新增同义码）

| code | HTTP | 中文消息模板（必须逐字匹配） | 触发 |
|---|---|---|---|
| `AUTH_REQUIRED` | 401 | `请先登录。` | 无 Authorization |
| `AUTH_INVALID` | 401 | `登录已失效，请重新登录。` | token 不存在/过期/已注销 |
| `AUTH_FAILED` | 401 | `学号或口令不对，请检查后再试。` | 登录失败（不区分原因） |
| `FORBIDDEN` | 403 | `这个资源不属于当前学号，换回自己的账号再试。` | 归属校验失败 |
| `NOT_FOUND` | 404 | `没有找到这条记录，可能已被删除。` | 资源不存在 |
| `UNKNOWN_METHOD` | 404 | `没有这个方法：<method>` | 方法不在 §5/§6 |
| `BAD_REQUEST` | 400 | 见各方法逐条消息（§5 表内） | 缺字段/类型错/越界 |
| `PAYLOAD_TOO_LARGE` | 413 | `这次提交的内容太大了（上限 1 MB），分几次发。` | 请求体超限 |
| `RATE_LIMITED` | 429 | `请求太频繁，请等几秒再试。` | 限流 |
| `NOT_IMPLEMENTED` | 501 | `这个功能还没做，先别用。` | CAS/OAuth 预留 |
| `UPSTREAM_FAILED` | 502 | `上游服务没响应（新闻服务 / 模型），稍后重试。` | 依赖失败 |
| `CANCELLED` | 499 | `已停止这一轮（你点的停止）。这次没有保存结果，可以重新提问。` | 取消后仍在途 |
| `TIMEOUT` | 504 | `这一步等太久了，已经停下，可以直接重试。` | 超时 |
| `INTERNAL` | 500 | `服务端出了点问题，已经记下来了，请稍后重试。` | 兜底 |

**中文消息是产品契约**，不是日志文案。E 轮的非法输入用例要逐字比对（`tools/contract-tests/src/cases/methods.ts`）。
服务端内部英文堆栈只进日志，不进响应体。

### 4.3 参数校验口径（与桌面端现行为的差异）

桌面端 `invoke()` 对参数是**宽容**的：`String(args.x ?? '')`、`typeof args.limit === 'number' ? … : 默认`（`apps/desktop/src/main/index.ts:204-393`）。
HTTP 服务端必须**严格**：

| 情况 | 桌面端现状 | HTTP 契约 |
|---|---|---|
| 缺必填字段 | 退化成空串，继续走 | `400 BAD_REQUEST` + 该字段的中文消息 |
| 类型错（如 `limit: "10"`） | 当没传，用默认 | `400 BAD_REQUEST` +「`limit` 必须是整数。」 |
| `limit` 越界 | 直接用 | 夹到 `1..N` 或 `400`，逐方法在 §5 写明 |
| 未知方法 | 抛英文 `unknown learning method`（`index.ts:390-392`） | `404 UNKNOWN_METHOD` + 中文 |

这条差异是**有意收紧**：HTTP 对外暴露，宽容解析会把拼写错误变成静默空结果，学生看到的是「什么都没有」。

---

## 5. 30 个业务方法（冻结表）

字段含义：`必填` 只列必填；`写` 表示会改库；`归属` 表示要做 §3.3 校验；`证据` 是当前实现位置。

| # | method | 必填 params | 其他 params | 返回（顶层） | 写 | 归属 | 证据 |
|---|---|---|---|---|---|---|---|
| 1 | `student.current` | — | — | `{studentId,name,cohort}` | 否 | — | `apps/desktop/src/main/index.ts:209-212` |
| 2 | `chapters.list` | — | — | `Chapter[]` | 否 | — | `index.ts:213-214` |
| 3 | `kps.list` | — | `chapter?`, `query?`, `limit?=80`（1..500） | `KnowledgePoint[]` | 否 | — | `index.ts:215-224` |
| 4 | `news.list` | — | `source?`, `since?`(ISO), `limit?=20`（1..200） | `NewsArticle[]` | 否 | — | `index.ts:251-256` |
| 5 | `news.status` | — | — | `{count,newestFetchedAt}` | 否 | — | `index.ts:257-261` |
| 6 | `news.refresh` | — | `sources?: string[]` | `{results,queued,accepted,count,newestFetchedAt}` | 是（经侧车） | — | `index.ts:262-273` |
| 7 | `news.get` | `articleId` | — | `{article,matches,ideology}` | 否 | — | `index.ts:274-282` |
| 8 | `news.match` | `articleId` | `topK?=3`（1..10） | `{matches}` | 是（写 `case_matches`） | — | `index.ts:283-289` |
| 9 | `questions.attempts` | — | `questionIds?: string[]`, `limit?=200` | `attempts[]` | 否 | — | `index.ts:290-295` |
| 10 | `profile.get` | — | — | `Profile` | 否 | — | `index.ts:296-297` |
| 11 | `profile.growth` | — | `chapterId?` | `growth summary` | 否 | — | `index.ts:298-299` |
| 12 | `profile.evidence` | — | `competencyId?`, `chapterId?`, `limit?=100` | `Evidence[]` | 否 | — | `index.ts:300-305` |
| 13 | `profile.snapshot` | `chapterId`, `checkpoint`(`pre`/`post`) | — | `snapshot` | **是** | — | `index.ts:306-311` |
| 14 | `profile.review` | `evidenceId`, `status`(`draft`/`reviewed`/`rejected`) | `note?` | `{ok:true}` | **是** | ✅ | `index.ts:312-318` |
| 15 | `artifacts.list` | — | `limit?=50` | `Artifact[]` | 否 | — | `index.ts:319-320` |
| 16 | `artifacts.get` | `artifactId` | — | `Artifact` | 否 | ✅ | `index.ts:321-322` |
| 17 | `artifacts.export` | `artifactId` | `format`(`md`/`docx`/`html`，默认 `docx`) | `{path}` | **是（落盘）** | ✅ | `index.ts:323-324`、`199-201` |
| 18 | `memory.facts` | — | — | `MemoryFact[]` | 否 | — | `index.ts:325-326` |
| 19 | `memory.episodes` | — | `limit?=50` | `MemoryEpisode[]` | 否 | — | `index.ts:327-328` |
| 20 | `memory.summary` | — | — | `MemorySummary` | 否 | — | `index.ts:329-330` |
| 21 | `memory.upsert` | `key`, `value` | `kind`（6 值，非法→`goal`） | `MemoryFact` | **是** | — | `index.ts:331-340` |
| 22 | `memory.delete` | `factId` | — | `{ok:true}` | **是** | ✅ | `index.ts:341-343` |
| 23 | `chat.sessions` | — | — | `ChatSession[]` | 否 | — | `index.ts:344-345` |
| 24 | `chat.messages` | `sessionId` | — | `ChatMessage[]` | 否 | ✅ | `index.ts:346-347` |
| 25 | `agent.snapshot` | — | `sessionId?`, `chapterId?` | `LearningStateSnapshot` | 否 | — | `index.ts:348-353` |
| 26 | `agent.suggestions` | — | `sessionId?` | `LearningSuggestions` | 否 | — | `index.ts:354-358` |
| 27 | `agent.turns` | `sessionId` | `limit?=50` | `TurnRow[]` | 否 | ✅ | `index.ts:359-360` |
| 28 | `agent.ledger` | — | — | `{items,counts}` | 否 | — | `index.ts:361-362` |
| 29 | `agent.retry` | `sourceId` | — | `ledger` | **是** | — | `index.ts:363-365` |
| 30 | `agent.sessions` | — | — | `ChatSessionSummary[]` | 否 | — | `index.ts:366-369` |

**`memory.upsert` 的 `kind` 枚举**（依据 `index.ts:334-336`）：`goal` `preference` `constraint` `background` `self_assessment` `open_question`。

**必填字段缺失时的中文消息**（E 轮逐条断言）：
`articleId 不能为空。` / `sessionId 不能为空。` / `artifactId 不能为空。` / `factId 不能为空。` / `evidenceId 不能为空。` / `sourceId 不能为空。` / `chapterId 不能为空。` / `checkpoint 必须是 pre 或 post。` / `status 必须是 draft、reviewed 或 rejected。`

---

## 6. 契约缺口：4 个 legacy 只读方法（必须实现，但不计入 30）

渲染层今天仍在调这 4 个方法，但它们既不在 30 方法清单、也不在「不放进服务端」清单：

| method | 谁在调 | 证据 | 冻结口径 |
|---|---|---|---|
| `getKp` | 引用溯源、匹配展开 | `apps/desktop/src/renderer/src/App.tsx:627`、`:857` | 服务端**必须实现**（只读） |
| `getBlock` | 引用溯源、源文跳转 | `App.tsx:635`、`:785` | 同上 |
| `getResource` | 资源引用溯源 | `App.tsx:643`、`:812` | 同上 |
| `listIdeology` | 思政点列表页 | `apps/desktop/src/renderer/src/pages.tsx:124` | 同上 |

口径：写入 OpenAPI 的 `tags: [legacy]` 并标 `deprecated: true`，**不计入「30 方法覆盖」统计**，但 E 轮必须给每个 legacy 方法至少 1 条合法输入用例（否则桌面端切服务端会断引用）。
依据：`apps/desktop/src/main/index.ts:225-250` 是这 4 个方法的现有实现。

**明确排除、HTTP 不实现**：`files.reveal`、`files.preview`、`files.openDialog`（本地文件能力，`index.ts:370-389`）、`settings.get`、`settings.set`（本机密钥，`index.ts:537-538`）。客户端自己保留，服务端返回 `UNKNOWN_METHOD`。
小程序 mock 一律不碰这 5 个。

---

## 7. 5 个专用通道

### 7.1 `POST /api/v1/chat/stream`（SSE）

请求：

```json
{ "sessionId": "可选；不传则新建", "message": "必填，≤8000 字符",
  "chapterId": "可选", "scopeOverride": "可选，透传", "requestId": "建议传，用于取消" }
```

响应头：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache`、`X-Accel-Buffering: no`。

事件序列（**顺序是契约**）：

| 序 | `event:` | `data:` | 说明 |
|---|---|---|---|
| 1 | `session` | `{requestId,sessionId}` | 必须最先发；对应 `TeamEvent.type='session'`（`packages/agent/src/team.ts:17-35`） |
| 2..n | `round` | `{requestId,round}` | 模型第几轮 |
| 2..n | `text` | `{requestId,agent:"lead",text}` | 增量文本，客户端拼接 |
| 2..n | `tool` | `{requestId,tool}` | 工具开始 |
| 2..n | `tool-end` | `{requestId,tool,chars,preview?,cached?}` | 工具结束 |
| n+1 | `done` | `{requestId,turnId,sessionId,text,artifacts,citations,warnings,trace?}` | **终态，必须发**；对应 `HandleTurnOutput`（`packages/agent/src/index.ts:52-67`) |
| 异常 | `error` | `{requestId,code,message}` | 终止；发完即断，不再发 `done` |
| 心跳 | `: keep-alive` | （注释行） | 每 15s 一次；60s 无任何事件则服务端主动断开 |

硬规则：

- `session` 必须在任何可能失败的调用之前发出（会话已建立是运行时事实，不是结果）。
  依据：`packages/agent/src/team.ts:19-35` 的注释解释了失败后 sessionId 丢失会导致重复建会话（F18）。
- `done` 只能出现一次；出现后连接关闭。
- 取消后：最多再发 1 个 `error(code=CANCELLED)`，然后关闭；**不得继续产生 `text`**。
- 事件 id 用递增整数 `id: 1..n`，便于客户端断线重连时判断缺口（不实现重放，只做诊断）。
- 中文不转义（`ensure_ascii=false`），`text` 里保留换行时必须写成多行 `data:`。

### 7.2 `POST /api/v1/chat/cancel`

```json
{ "requestId": "req_abc123" }  →  200 { "ok": true, "result": { "cancelled": true }, "requestId": "req_abc123" }
```

- `requestId` 不存在或已结束 → `cancelled: false`，仍返回 200（不是错误）。
- 取消必须真的把 `AbortSignal` 交到执行链，而不只是断 HTTP 连接。
  依据：`apps/desktop/src/main/index.ts:482-486` 的注释明确「只测 runAgentLoop 测不到这条接线」。

### 7.3 `POST /api/v1/answer`（单题作答）

```json
{ "sessionId": "必填", "questionId": "必填", "answer": "必填", "artifactId": "可选", "chapterId": "可选" }
→ 200 { "ok": true, "result": { "turnId","text","feedback","evidence","ledger","warnings","status" } }
```
依据：`packages/agent/src/index.ts:69-86`。

### 7.4 `POST /api/v1/answer-set`（交卷）

```json
{ "sessionId": "必填", "artifactId": "必填",
  "answers": [{ "questionId": "q1", "answer": "…" }], "chapterId": "可选" }
→ 200 { "ok": true, "result": { "turnId","text","results","ledger","warnings","status" } }
```
- `answers` 为空数组 → `400`「这一卷还没有作答，先答一题再交。」
- 失败消息必须说明「这次没记成成绩」：`apps/desktop/src/main/index.ts:524-527` 用 `friendlyError(error,{context:'answer'})` 产出「这次作答没有记成成绩，可以直接重试。」

### 7.5 `GET /api/v1/health`（无鉴权）

```json
200 { "ok": true, "result": {
  "ok": true, "warnings": [], "notices": ["本地新闻库还是空的（不影响聊天）…"],
  "chapters": 13, "knowledgePoints": 0, "newsArticles": 0, "appHome": "/data", "version": "0.1.0", "uptimeMs": 12345 } }
```

- 判断逻辑必须复用 `startupHealth`：章节 0 → warning；有章节但知识点 0 → warning；有章节且新闻 0 → notice。
  依据：`apps/desktop/src/main/health.ts:11-33`。
- `/health`（无前缀）返回 `{"ok":true}` 纯文本/JSON，供 Docker `HEALTHCHECK` 用，不做业务判断。
- 健康检查失败（DB 打不开）→ HTTP 503 + `ok:false`，容器据此判定不健康。

---

## 8. OpenAPI 3 归属与覆盖判据

- 唯一 owner：**A 轮**。产物 `docs/contracts/openapi.yaml`，版本 `3.0.3`（不用 3.1，避免工具链差异）。
- 覆盖判据（E 轮 `coverage` 命令按此判定）：
  - `paths./api/v1/rpc` 的请求体 `method` 枚举必须**恰好**包含 §5 的 30 个名字；
  - §7 的 5 个通道每个都要有独立 `path` 条目；
  - §6 的 4 个 legacy 方法要出现在 `x-legacy-methods` 扩展里（不是枚举里）；
  - `components.schemas` 至少覆盖 30 方法返回结构，命名 `<Method>Result`（点转驼峰，如 `news.list` → `NewsListResult`）。
- **E 轮不得修改 `openapi.yaml`**：发现缺漏只在报告里列，由 A 修。
- OpenAPI 缺失时 E 仍须能跑：`coverage` 输出 `openapi: missing` 并只核对冻结表，退出码 0 但报告标 `pending`。

---

## 9. 可观测性

### 9.1 结构化日志（每请求一行 JSON，stdout）

```json
{"ts":"2026-11-19T02:00:00.123Z","level":"info","requestId":"req_abc123",
 "studentId":"20230001","method":"news.list","route":"/api/v1/rpc","status":200,
 "code":"OK","durationMs":12,"bytes":2048,"ua":"curl/8.5.0","ignoredStudentId":false}
```
禁止记录：token、口令、消息正文、工具结果正文、模型 prompt。`detail` 只放错误分类与字段名。

### 9.2 指标（Prometheus 文本，`/metrics`）

| 指标 | 类型 | 标签 | 用途 |
|---|---|---|---|
| `yxs_http_requests_total` | counter | `method`,`route`,`status` | 请求量、5xx 率 |
| `yxs_http_request_duration_seconds` | histogram | `method`,`route` | P50/P95/P99 |
| `yxs_rpc_requests_total` | counter | `method`,`code` | 按方法错误率 |
| `yxs_tokens_total` | counter | `student_id`,`kind`(`prompt`/`completion`) | 学生 token 账 |
| `yxs_errors_total` | counter | `code` | 错误分类 |
| `yxs_sqlite_busy_total` | counter | `db` | `SQLITE_BUSY` 次数 |
| `yxs_sse_active_connections` | gauge | — | SSE 并发连接数 |
| `yxs_sse_first_token_seconds` | histogram | — | 首 token 延迟 |
| `yxs_login_total` | counter | `result`(`ok`/`fail`) | 登录 |
| `yxs_process_start_time_seconds` | gauge | — | 重启检测 |

桶（histogram buckets，秒）：`0.05 0.1 0.25 0.5 1 2 3 5 8 13 20 30`。

### 9.3 告警阈值（F 轮 `alerts.yml`，Prometheus 规则格式）

| 告警 | 表达式（要点） | `for` | 级别 |
|---|---|---|---|
| 5xx 率 | `sum(rate(yxs_http_requests_total{status=~"5.."}[5m])) / sum(rate(yxs_http_requests_total[5m])) > 0.01` | 5m | page |
| P95 延迟 | `histogram_quantile(0.95, sum by (le)(rate(yxs_http_request_duration_seconds_bucket[10m]))) > 3` | 10m | warn |
| token 用量 80% | `yxs_tokens_total{kind="prompt"} / yxs_token_quota > 0.8` | 15m | warn |
| `SQLITE_BUSY` 增速 | `increase(yxs_sqlite_busy_total[5m]) > 5` | 5m | warn |
| 服务不健康 | `up{job="yxs-server"} == 0` | 1m | page |

---

## 10. 运行环境

### 10.1 端口

| 服务 | 端口 | 环境变量 | 说明 |
|---|---|---|---|
| 服务端 | 8080 | `YXS_SERVER_PORT` | 容器内 `0.0.0.0:8080` |
| 新闻侧车 | 8787 | `NEWS_CRAWLER_PORT` | 现有默认（`services/news-crawler-py/src/news_crawler/http_api.py:38-39`） |
| PostgreSQL | 5432（宿主机映射 55432） | — | D/G 轮用宿主机 55432，避免与本机 PG 冲突 |
| 容器内服务端调侧车 | `http://crawler:8787` | `NEWS_CRAWLER_BASE_URL` | compose 网络内别名 |

### 10.2 环境变量（冻结名）

| 变量 | 默认 | 谁用 |
|---|---|---|
| `LEARNING_AGENT_HOME` | 开发 `<repo>/.learning-agent`；容器 `/data` | A/B/C/D/F/G |
| `YXS_SERVER_PORT` | `8080` | A |
| `YXS_DB_PATH` | `<home>/data/learning.db` | A/D/G |
| `YXS_AUTH_DB_PATH` | `<home>/data/auth.db` | A |
| `YXS_LLM` | `mock`（生产 `deepseek`） | A/F |
| `DEEPSEEK_API_KEY` | — | A |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | A |
| `YXS_TOKEN_TTL_DAYS` | `7` | A |
| `YXS_METRICS_TOKEN` | 空（不校验） | A/F |
| `YXS_CORS_ORIGINS` | 空 | A |
| `NEWS_CRAWLER_BASE_URL` | `http://127.0.0.1:8787` | A |
| `NEWS_CRAWLER_DB` | `<home>/data/learning.db` | B/C |
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | `127.0.0.1:55432` / `yxs` | D/G |

### 10.3 数据目录（容器内）

```text
/data/                      # LEARNING_AGENT_HOME
  data/learning.db          # 业务库（含 -wal / -shm）
  data/auth.db              # 登录与 token
  artifacts/<studentId>/<YYYY-MM>/
  exports/
```
注意 `data/data/learning.db` 这一层是**故意的**：与桌面端 `resolveAppHome()` 的既有布局一致（`docs/requirements/R17-local-data.md` §4），服务端不做特殊路径分支。

### 10.4 镜像与 compose 冻结名

| 项 | 冻结值 |
|---|---|
| 服务镜像 | `yxs-server:local`；**build context = 仓库根**，`dockerfile: apps/server/Dockerfile` |
| 采集镜像 | `yxs-crawler:local`；build context = `services/news-crawler-py`（Python 自包含，不依赖 workspace） |
| compose project | `yxs` |
| 网络 | `yxs-net` |
| 数据卷 | `yxs-data` → `/data` |
| compose 文件 | `services/deploy/compose.yml`（C 轮唯一 owner） |
| compose profiles | `crawler`（只起采集，可独立验收）、`full`（采集 + 服务端） |

**为什么服务端 context 是仓库根**：`apps/server` 属于 pnpm workspace（`pnpm-workspace.yaml` 的 `apps/*`），业务代码通过 `workspace:*` 引用 `@learning-agent/db` 等包。context 只给 `apps/server` 时这些包拷不进去，镜像必然构建失败。
因此 A 轮额外拥有仓库根的 `.dockerignore`（仅新建、只针对服务端构建排除 `node_modules/.git/release/.scratch/data`）。
C 轮写 `services/news-crawler-py/.dockerignore`（自己的 context 用自己的 ignore），两者互不覆盖。

### 10.5 PostgreSQL

- 版本 `postgres:16-alpine`；数据库 `yxs`；用户 `yxs`；密码来自 env（示例值 `yxs_local_pw`）。
- `jsonb` 用于 JSON 列；`bigint` 对应 SQLite `INTEGER`；`double precision` 对应 `REAL`；`text` 对应 `TEXT`。
- 迁移只针对 `learning.db`；`auth.db` 不在 D 范围。

---

## 11. 与桌面端的兼容约束（H 轮相关）

- 桌面端**继续可运行**：所有改动只在新增文件，`apps/desktop` 除 H 轮临时 patch 外零改动。
- H 轮的 mutation patch 只允许存在于 `tools/automated-testing/mutations/*.patch`，应用后**必须还原**；验收要求 `git status --porcelain apps/desktop packages` 为空。
- 31 条现有用例是回归基线：`tools/automated-testing/src/scenarios/`（13 条 p0 + 18 条 p1），清单见 `tools/automated-testing/src/scenarios/dependencies.ts:1-40`。

---

## 12. 变更规则

1. 改本文件 → 升版本号（v1 → v2）→ 在 `README.md` §7 登记 → 通知受影响轮次。
2. 任何一轮的 `02-contract.md` 只能**细化**本文件，不能新增错误码、不能改端口、不能改方法名。
3. 若发现本文件与代码冲突：以「代码现状 + 本文件写明的有意差异」为准，并把差异写进该轮 `01-scope.md` 的「与现行为的差异」一节。
4. 契约类改动（字段、错误码、事件顺序）视为**破坏性**，必须同时更新 `docs/contracts/openapi.yaml`（A）与 E 的用例。
