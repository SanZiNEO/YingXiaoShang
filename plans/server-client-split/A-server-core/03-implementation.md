# A · 服务端骨架 · 实现方案

> 轮次：A · 服务端骨架
> 文档角色：03-implementation
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1
> 一句话：一个 Node 22 进程，`node:http` 手写路由，复用 workspace 里的 `packages/*` 服务，把 IPC 那套原样变成 HTTP + SSE。

## 1 目录与模块

目录树见 [`01-scope.md`](01-scope.md) §5。这里只补「为什么这么分」：

| 层 | 模块 | 职责边界（谁不许干别人的活） |
|---|---|---|
| 传输 | `src/http/*` | 只处理 HTTP 语义：读体、限流、状态码、头。**不碰业务**，不 import `packages/db` |
| 鉴权 | `src/auth/*` | 只认 token 与 `auth.db`。**不碰** `learning.db` |
| 编排 | `src/rpc/registry.ts` + `handlers/*` | 唯一允许把「方法名」映射到「服务调用」的地方；每个 handler 只做参数取值 + 调服务 + 归属校验 |
| 领域 | `packages/db`、`packages/agent`、`packages/profile`、`packages/artifacts`、`packages/news` | 业务真相在这里；服务端**不复制**它们的逻辑（除了 `getBlock`/`getResource` 这类组装） |
| 通道 | `src/chat/*` | SSE、取消注册表、作答/交卷编排 |
| 观测 | `src/log.ts`、`src/metrics.ts` | 横切；所有 handler 通过注入拿 `log/metrics`，不直接 `console.log` |
| 生成 | `scripts/gen-openapi.mjs` | 从 `registry` 的元数据生成 `docs/contracts/openapi.yaml`，禁止手写第二份方法清单 |

**一条硬约束**：方法名只出现在 `registry.ts` 一处。任何 handler 里出现 `case 'news.list'` 这类字符串都是重复真相源，评审直接打回。分层方式（传输/鉴权/编排/领域分开）参考 [R4] 的依赖分层，但去掉了它的框架依赖。

## 2 依赖与构建

### 2.1 运行时依赖

```json
{
  "name": "@yxs/server",
  "type": "module",
  "private": true,
  "dependencies": {
    "@learning-agent/db": "workspace:*",
    "@learning-agent/agent": "workspace:*",
    "@learning-agent/matcher": "workspace:*",
    "@learning-agent/questions": "workspace:*",
    "@learning-agent/profile": "workspace:*",
    "@learning-agent/artifacts": "workspace:*",
    "@learning-agent/news": "workspace:*",
    "@learning-agent/shared": "workspace:*",
    "@deepseek-ai/cordis": "~4.0.5",
    "prom-client": "^15.1.3"
  },
  "devDependencies": { "@types/node": "^24.0.0", "tsx": "^4.20.0", "typescript": "^5.9.0" }
}
```

- **不用 Express/Fastify**：只有一个 RPC 端点 + 5 个通道，`node:http` 的路由表足够；少一层中间件，压测口径更干净 [R40]。
- **SQLite 用 `node:sqlite`**（Node 22 内置，`packages/db` 已经用它，见 `packages/db/src/index.ts:2`）：`auth.db` 复用同一个 `DatabaseSync`，不引原生库。
- **指标用 `prom-client`**：直方图桶与文本输出格式一次到位，避免自研格式错位导致 `histogram_quantile` 算错 [R44]。

### 2.2 脚本

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node lib/index.js",
    "build": "tsc -b",
    "typecheck": "tsc -b --noEmit",
    "test": "node --test test/*.test.ts",
    "smoke": "node scripts/smoke.mjs",
    "gen:openapi": "node scripts/gen-openapi.mjs",
    "check:openapi": "node scripts/openapi-check.mjs"
  }
}
```

### 2.3 Dockerfile（多阶段，非 root）

```dockerfile
# 阶段 1：装依赖 + 编译（context = 仓库根）
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.28.5 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
RUN pnpm install --frozen-lockfile
RUN pnpm --dir packages/db build && pnpm --dir packages/agent build && pnpm --dir packages/profile build \
 && pnpm --dir packages/artifacts build && pnpm --dir packages/news build && pnpm --dir packages/matcher build \
 && pnpm --dir packages/questions build
RUN pnpm --dir apps/server build

# 阶段 2：只带运行时产物
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd -g 10001 yxs && useradd -u 10001 -g 10001 -m yxs
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/lib ./apps/server/lib
COPY apps/desktop/templates ./templates
ENV YXS_TEMPLATES_DIR=/app/templates
RUN mkdir -p /data && chown -R 10001:10001 /data
USER 10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/lib/index.js"]
```

- **为什么 context 是仓库根**：`apps/server` 通过 `workspace:*` 依赖 `packages/*`（`pnpm-workspace.yaml:1-4`），只给 `apps/server` 上下文装不出依赖。
- `templates` 来自 `apps/desktop/templates`（`ArtifactService` 构造需要 `templatesDir`，`apps/desktop/src/main/index.ts:92-95`）。**只拷贝、不修改**，这是唯一一处跨 app 读取。
- 镜像目标体积 < 500 MB；`node:22-slim` 基线约 80 MB + 依赖，实测写进 `04-acceptance.md`。

## 3 关键实现

下面每一节都是「照抄就能跑」的最小版本；涉及安全的部分（口令、token、错误披露）以 [R7][R9] 为准，不做「看起来差不多」的自创实现。

### 3.1 上下文装配（复刻 `initServices`）

```ts
// src/context.ts —— 与 apps/desktop/src/main/index.ts:82-101 一一对应
export async function buildContext(env: Env) {
  const ctx = new Context()
  const llm = env.llm === 'mock' ? new MockLlm(env) : new DeepSeekLlm(() => ({ apiKey: env.deepseekKey, model: env.model }))
  ctx.provide('llm', llm)
  await ctx.plugin(LearningDb, { appHome: env.appHome })
  const matcher = new Matcher(ctx)
  const questionSmith = new QuestionSmith(ctx)
  const profile = new ProfileService(ctx)
  const artifacts = new ArtifactService(ctx, { appHome: env.appHome, templatesDir: env.templatesDir })
  const news = new NewsService(ctx, { baseUrl: env.newsBaseUrl, apiKey: () => env.deepseekKey })
  const agent = new AgentService(ctx)
  return { ctx, db: ctx.learningDb, matcher, questionSmith, profile, artifacts, news, agent }
}
```

顺序不能乱：`LearningDb` 必须先 `plugin`，其余服务都在构造期取 `ctx.learningDb`（与桌面端同因）。

### 3.2 方法注册表

```ts
type Handler<S> = (c: HandlerCtx<S>, params: Record<string, unknown>) => Promise<unknown>
interface MethodSpec<S = any> {
  name: string                      // 唯一真相源
  schema: string                    // OpenAPI 结果 Schema 名
  legacy?: boolean                  // 4 个 legacy 只读
  auth: boolean                     // health 之外恒 true
  validate: (p: Record<string, unknown>) => void   // 抛 BadRequest(field, message)
  handler: Handler<S>
}

export const METHODS: MethodSpec[] = [...studentMethods, ...newsMethods, ...]
```

`registry.ts` 导出的 `METHODS` 同时被三处消费：

1. 路由分发（`rpc/handler.ts`）：`Map<name, spec>`，未命中 → `UNKNOWN_METHOD`。
2. OpenAPI 生成（`scripts/gen-openapi.mjs`）：读 `name/schema/legacy`。
3. 自检（`scripts/openapi-check.mjs`）：比对 yaml enum 与 `METHODS.filter(m=>!m.legacy).length === 30`。

**禁止**在别处写第二份方法名单——包括测试里。E 轮的 30 条用例应从 `METHODS` 派生（E 通过 HTTP 拿不到注册表，则由 A 在 `openapi.yaml` 暴露 enum，E 读 enum；这条已在冻结文件 §8 约定）。

### 3.3 参数校验器（100 行内，不引 zod）

```ts
// src/rpc/validate.ts
export function str(p: Rec, key: string, opts: { required?: boolean; max?: number } = {}): string
export function num(p: Rec, key: string, opts: { def?: number; min: number; max: number; integer?: true }): number
export function oneOf<T extends string>(p: Rec, key: string, values: readonly T[], def?: T): T
export function arr<T>(p: Rec, key: string, opts: { required?: boolean; max?: number }): T[]
```

校验失败统一 `throw new BadRequest(field, message)`，由 `respond.ts` 转成 §2.3 的信封。
**为什么不用 zod**：错误消息要逐字中文且带 `field`，zod 的默认消息是英文，包一层反而更绕；30 个方法的校验规则在 §3.1 表里已经写死，手写更可控。

### 3.4 鉴权

```ts
// src/auth/passwords.ts
hash(password) → `scrypt$16384$8$1$${saltB64}$${hashB64}`
verify(password, stored) → timingSafeEqual(scrypt(...), hash)

// src/auth/store.ts —— DatabaseSync(authDbPath)
CREATE TABLE auth_students(...) STRICT;
CREATE TABLE auth_tokens(...) STRICT;
CREATE INDEX IF NOT EXISTS auth_tokens_by_student ON auth_tokens(student_id);
issue(studentId) → base64url(randomBytes(32)); store sha256(token)
verify(token) → 查表 + 过期/撤销判断 → studentId
revoke(token) → UPDATE revoked_at
```

`auth.db` 与 `learning.db` 同目录（`<home>/data/`），但**独立连接**、独立 `PRAGMA journal_mode=WAL`、`busy_timeout=5000`（与 `packages/db` 的配置保持一致，避免两库并发时互相拖死）。

### 3.5 SSE 写出

```ts
// src/http/sse.ts
class SseWriter {
  constructor(private res: ServerResponse, private requestId: string) {}
  private seq = 0
  start() { this.res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' }) ; this.heartbeat() }
  send(event: string, data: unknown) {
    this.res.write(`id: ${++this.seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  done(payload: unknown) { if (this.closed) return; this.send('done', payload); this.close() }
  error(code: string, message: string) { if (this.closed) return; this.send('error', { requestId: this.requestId, code, message }); this.close() }
  heartbeat() { this.timer = setInterval(() => this.res.write(': keep-alive\n\n'), 15_000) }
  close() { this.closed = true; clearInterval(this.timer); this.res.end() }
}
```

三条易错的点：

1. `done` 只能发一次（用 `closed` 哨兵）；`AbortError` 与正常结束可能同时到达。
2. 心跳要在 `res.writeHead` 之后立刻起，否则长工具调用期间会被中间层判超时。
3. `res.on('close')` 里必须 `abort` 该轮次并清 `turns` 表，否则客户端断线后模型仍在跑（`index.ts:482-486` 的教训）。

### 3.6 取消注册表

```ts
// src/chat/turns.ts
const turns = new Map<string, { controller: AbortController; startedAt: number }>()
begin(requestId) { const c = new AbortController(); turns.set(requestId, { controller: c, startedAt: Date.now() }); return c }
cancel(requestId) { const t = turns.get(requestId); if (!t) return false; t.controller.abort(new Error('已停止')); return true }
done(requestId) { turns.delete(requestId) }
```

- `cancel` 返回 `true` 只代表「发出去了」；真正的停止由执行链抛出 `AbortError` 验证（E 轮 `CT-SSE-02`）。
- `requestId` 为空时服务端生成一个（`req_` + 12 base36），并在 `session` 事件里带出去，客户端后续用它对 `done` 做匹配。

### 3.7 作答 / 交卷

```ts
// src/chat/answers.ts
try {
  const out = await agent.answerQuestionSet({ studentId, sessionId, artifactId, answers, chapterId })
  return respond.ok(out)
} catch (e) {
  const friendly = friendlyError(e, { context: 'answer' })   // 复用 apps/desktop/src/main/errors.ts 的文案
  throw new ApiError('BAD_REQUEST', friendly.message, { stage: 'answer' })
}
```

`friendlyError` 是纯函数（`apps/desktop/src/main/errors.ts:9`），**原样复制到 `apps/server/src/errors.ts`** 并保留注释来源；不要 import `apps/desktop`（跨 app 依赖会在镜像里埋雷）。

### 3.8 mock LLM（确定性，供 smoke / E / F 用）

实现 `stream(options)` 与 `chat(messages)`，产出与 `apps/desktop/src/main/llm.ts:134-201` 相同的 chunk 类型：

| 条件 | 行为 |
|---|---|
| `options.signal.aborted` | 立刻结束迭代（<50ms），不产出任何 chunk |
| messages 里已有 `tool-result` 块 | 产出 `block-start(text)` + `text-delta`（`题目已经准备好了，先从第一题开始。`）+ `finish` |
| `YXS_MOCK_SCRIPT=tools` 且 message 含「出题/题目/练习」且无 `tool-result` | 产出 `block-start(tool-call)` + `tool-call-delta`（`name:"emit_question_set"`，args 见下）+ `block-end` + `finish` |
| 其他 | 产出 5 段固定文本（每段 20–30 字）+ `usage{prompt_tokens:100,completion_tokens:50}` + `finish` |

mock 题目集（固定 2 题，题干固定，便于 smoke 断言）：

```json
{ "title":"mock 题目集", "content": { "intro":"这是 mock 模式生成的两道题。",
  "questions":[
    {"type":"single","stem":"mock 第一题：消费者行为的核心是？","options":["需求识别","价格歧视","渠道压货"],"answer":"需求识别","explanation":"mock 解析","kpIds":[],"difficulty":1},
    {"type":"short","stem":"mock 第二题：用一个例子说明参考群体影响。","options":[],"answer":"示例答案","explanation":"mock 解析","kpIds":[],"difficulty":2}
  ]}}
```

写入后系统会把 id 归一成 `q1`、`q2`（`packages/agent/src/tools/write-tools.ts:82-92` 的合并逻辑），smoke 用这两个 id 交卷。

### 3.9 日志与指标

```ts
// src/log.ts —— 一函数一事件，禁止拼字符串
log.info({ requestId, studentId, method, route, status, code, durationMs, bytes, ignoredStudentId })

// src/metrics.ts —— 名字与标签严格按 01-frozen-contracts §9.2
const httpTotal = new Counter({ name: 'yxs_http_requests_total', labelNames: ['method','route','status'] })
const httpDur = new Histogram({ name: 'yxs_http_request_duration_seconds', labelNames: ['method','route'], buckets: [0.05,0.1,0.25,0.5,1,2,3,5,8,13,20,30] })
```

`SQLITE_BUSY` 计数：包一层 `db.exec` 包装器捕获 `SQLITE_BUSY`（`node:sqlite` 抛的 message 含 `database is locked`），`yxs_sqlite_busy_total.inc()` 后**原样抛**，不吞。

### 3.10 OpenAPI 生成

`scripts/gen-openapi.mjs`：从 `src/rpc/registry.ts` 编译产物里读 `METHODS`（或直接 `tsx` 导入），拼 yaml 文本写 `docs/contracts/openapi.yaml`。

- 生成器只负责「方法 enum、security、5 通道、legacy 列表、错误码枚举」；
- 各方法的 `*Result` schema 用**手写片段**存在 `src/rpc/schemas.ts`，生成器合并（避免自动反射类型带来的噪音）；
- `pnpm check:openapi` 重新生成到临时文件并 `diff`，不一致即失败 —— 防止「改了方法忘了改文档」。

## 4 数据读写

`memory.upsert` 的「同 key 覆盖、不同 key 新增」语义与 PG 的 `ON CONFLICT` 是同一类需求，这里沿用 SQLite 侧的现有实现，不另写判断逻辑 [R18]。

| 操作 | 表 | 说明 |
|---|---|---|
| 登录 | `auth_students`、`auth_tokens`（`auth.db`） | 事务：签发时只写一行；登出写 `revoked_at` |
| 读课程 | `chapters`、`sections`、`knowledge_points`、`content_blocks`、`ideology_points` | 只读，走 `db.list*` / `searchKps` |
| 新闻 | `news_articles`、`news_tags`、`case_matches` | 读走 `db`；刷新走侧车；匹配写 `case_matches` |
| 题目 | `questions`、`question_kps`、`question_attempts` | 读 `listAttempts`；作答写由 `agentRuntime` 负责 |
| 学情 | `student_profiles`、`competencies`、`evidence`、`growth_snapshots` | 写只经 `profileService`，服务端不直接 INSERT |
| 产物 | `artifacts` | 读 `artifacts.list/get`；导出只落盘不改库 |
| 记忆 | `memory_facts`、`memory_episodes` | `memory.upsert/delete` 经 `profileService` |
| 会话 | `chat_sessions`、`chat_messages`、`turns` | 读只读；写由 `agentRuntime` |
| 账本 | `summary_ledger` | `agent.retry` 经 `agentRuntime.retryLedger` |

**事务与并发**：

- `packages/db` 已设 `journal_mode=WAL`、`busy_timeout=5000`（`docs/requirements/R17-local-data.md` §3 第 4 步）；服务端**不重复设置**，也不得另开第二个 `LearningDb` 实例。
- `node:sqlite` 是同步 API，单进程内所有查询串行；因此**禁止**在 handler 里做长循环（如对 500 条新闻逐条 `match`），必须下沉到服务层或分批。
- 写操作（`profile.snapshot`、`memory.upsert`、`artifacts.export`）尽量单条语句 + 短事务；导出写文件在事务外。

## 5 配置

配置全部从环境变量来、启动期一次读完，符合 12-Factor 的「配置在环境里」这一条 [R6]；容器里由 compose 注入，本地由 `.env` 注入，代码里不出现第二份默认值表。

| 变量 | 默认 | 校验 |
|---|---|---|
| `LEARNING_AGENT_HOME` | `<repo>/.learning-agent`（开发）/`/data`（容器） | 启动时 `mkdir -p` 并 `access(W_OK)`，不可写 → 退出码 2 + 中文一行 |
| `YXS_SERVER_PORT` | `8080` | 1..65535 |
| `YXS_DB_PATH` | `<home>/data/learning.db` | 文件不存在 → 从 `YXS_SEED_DB`（可选）复制；都没有则空库启动 + `warnings` |
| `YXS_AUTH_DB_PATH` | `<home>/data/auth.db` | 不存在则建表 |
| `YXS_TEMPLATES_DIR` | 开发 `apps/desktop/templates`；容器 `/app/templates` | 目录不存在 → 启动失败（产物导出会全挂，早失败早发现） |
| `YXS_LLM` | `mock` | `mock|deepseek` |
| `DEEPSEEK_API_KEY` | — | `YXS_LLM=deepseek` 且为空 → 启动 warning，不阻塞（首个 chat 返回 `UPSTREAM_FAILED`） |
| `NEWS_CRAWLER_BASE_URL` | `http://127.0.0.1:8787` | 侧车不可达不影响启动，只影响 `news.refresh` |
| `YXS_MOCK_SCRIPT` | 空 | `tools` 时启用脚本化出题 |

`src/env.ts` 在启动期一次性读完并冻结，运行期不再读 `process.env`（避免测试改环境污染）。

## 6 失败处理

失败路径的判定原则是「说清发生了什么、学生能不能自己救」，与 `apps/desktop/src/main/errors.ts:9-67` 的产品口径一致；对外只暴露中文一句话，内部只留分类，不放堆栈 [R7]。

| 失败 | 错误码 | 用户看到 | 是否自动重试 |
|---|---|---|---|
| 请求体非 JSON | `BAD_REQUEST` | `请求体不是合法 JSON。` | 否 |
| 请求体 > 1 MiB | `PAYLOAD_TOO_LARGE` | `这次提交的内容太大了（上限 1 MB），分几次发。` | 否 |
| 未登录 | `AUTH_REQUIRED` | `请先登录。` | 否 |
| token 失效 | `AUTH_INVALID` | `登录已失效，请重新登录。` | 否 |
| 越权 | `FORBIDDEN` | `这个资源不属于当前学号，换回自己的账号再试。` | 否 |
| 记录不存在 | `NOT_FOUND` | `没有找到这条记录，可能已被删除。` | 否 |
| 侧车挂了（`news.refresh`） | `UPSTREAM_FAILED` | `上游服务没响应（新闻服务 / 模型），稍后重试。` | 否（客户端手动刷） |
| 模型无 Key | `UPSTREAM_FAILED` | `还没配置模型密钥：点左下角「设置」填入 DeepSeek Key 后再发一次。` | 否 |
| 模型超时 | `TIMEOUT` | `这一步等太久了，已经停下，可以直接重试。` | 否 |
| 取消 | `CANCELLED` | `已停止这一轮（你点的停止）。这次没有保存结果，可以重新提问。` | 否 |
| `SQLITE_BUSY` | `INTERNAL`（重试 3 次后） | `服务端出了点问题，已经记下来了，请稍后重试。` | 是：内部退避 3 次（10/50/200ms） |
| 端口被占 | 启动失败 | 控制台一行 `端口 8080 已被占用，换 YXS_SERVER_PORT 再试。`，退出码 3 | — |

**`SQLITE_BUSY` 的边界**：只对「读」做重试；写重试要保证幂等（`memory.upsert` 可重试，`profile.snapshot` 不可——会插两条快照）。这条写进 handler 的 `retryable` 元数据，压测时能对上账。

## 7 性能与资源

分位数一律由 histogram 计算，不用平均值代替 P95（平均值会把长尾抹平，掩盖 SSE 卡顿）[R44]；并发场景与阈值口径参照 [R39] 的 VU 模型，跑法由 F 轮统一。

| 指标 | 目标 | 怎么量 |
|---|---|---|
| RPC 只读 P95（60 并发） | < 300 ms | F 轮 `tools/loadtest`，`--concurrency 60 --duration 60` |
| RPC 写 P95 | < 800 ms | 同上，场景 `profile.snapshot` |
| SSE 首 token（mock） | < 100 ms | `yxs_sse_first_token_seconds` 的 P95 |
| SSE 首 token（deepseek） | < 3 s | 同上，真 Key 一次手工跑 |
| 进程内存（60 并发 SSE） | < 300 MB | `process_resident_memory_bytes`（prom-client 自带） |
| 启动到可服务 | < 2 s | `/health` 从 `docker start` 到 200 的时间 |
| 镜像体积 | < 500 MB | `docker image inspect yxs-server:local --format '{{.Size}}'` |

压测注意：`node:sqlite` 同步查询在 60 并发下会排队，P95 主要由「最长单查询」决定；若 P95 超标，优先查 `news.list` 的 `LIKE` 全表扫描，而不是加缓存。

## 8 实施顺序（每步都能验证）

顺序按「先能跑、再能读、再能写、再能流」排，每一步都有可执行的验证点——这是把大改拆成可回退小步的通用做法 [R24]。

1. **空壳可跑**：`src/index.ts` 起 `node:http`，`/health` 返回硬编码 JSON。验证：`curl` 200。
2. **上下文装配**：`buildContext` + `LearningDb`。验证：`/health` 里 `chapters` 数量真实（用种子库应为 13）。
3. **登录闭环**：`auth.db` + 建一个测试学生 + `login`。验证：`curl login` 拿 token；带 token 调 `/rpc student.current` 返回该学号。
4. **注册表 + 10 个只读方法**：`student.current`、`chapters.list`、`kps.list`、`getKp`、`news.list`、`news.status`、`profile.get`、`profile.evidence`、`artifacts.list`、`chat.sessions`。验证：每个方法 `curl` 一次，字段齐全。
5. **剩余 20 个方法 + 4 legacy**：按 handler 文件分批，每批加 5 条 `node:test` 校验用例。
6. **SSE + cancel**：先 mock 文本流，再脚本化出题。验证：`curl -N` 看到 `session → text → done`；`cancel` 后 1s 静默。
7. **answer / answer-set**：接 `agentRuntime`。验证：出题产物 → 交卷 → `questions.attempts` 回读。
8. **OpenAPI 生成 + 自检**：`gen:openapi` → `check:openapi` 绿；手工 `curl /api/v1/openapi.yaml` 能拿到全文。
9. **日志 + 指标**：全部 handler 走统一响应函数。验证：`/metrics` 有 10 个指标名；日志每请求一行。
10. **Docker**：`docker build -f apps/server/Dockerfile .` → 起容器 → `/health` 200；`docker image inspect` 的 `User=10001`。

## 参考

- [R4] fastapi — https://github.com/fastapi/fastapi — 支撑 §1 分层与 §3.10「契约由代码生成」 — 借鉴「类型/元数据驱动 schema」；不引入 Python 栈。
- [R6] 12-Factor Logs — https://12factor.net/logs — 支撑 §3.9 单行 JSON 到 stdout — 直接采用；不引入日志聚合。
- [R9] Node.js crypto — https://nodejs.org/api/crypto.html — 支撑 §3.4 scrypt 与 sha256 — 采用内置实现，不引第三方哈希库。
- [R24] Dockerfile 参考 — https://docs.docker.com/reference/dockerfile/ — 支撑 §2.3 的 `USER`/`HEALTHCHECK`/多阶段 — 采用非 root + node 探活。
- [R25] Docker 多阶段构建 — https://docs.docker.com/build/building/multi-stage/ — 支撑 §2.3 两阶段拆分 — 采用 build/runtime 分离，不保留源码层。
- [R44] Prometheus 直方图 — https://prometheus.io/docs/practices/histograms/ — 支撑 §7 的 P95 口径 — 采用 `histogram_quantile`，禁止用平均值。
- [R40] Gatling — https://github.com/gatling/gatling — 支撑 §7 指标表（P50/P95/P99 的报告口径） — 借鉴报告字段；不引入其运行时。
