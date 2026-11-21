# A 轮偏差与环境缺口记录

> 记录 `apps/server` 实现与 `plans/server-client-split` 计划文档之间的取舍，以及本机做不到、需要在有条件的机器上补验的项。代码事实优先于文档（`.scratch/run/A/spec.md` §0）。

## 1. 与计划的偏差

| # | 计划口径 | 实际实现 | 原因 |
|---|---|---|---|
| D1 | 00-master §7.5 末条：`/health` 只返回 `{"ok":true}` 纯文本 | `/health` 与 `/api/v1/health` 都返回详细 JSON（`ok/warnings/notices/chapters/knowledgePoints/newsArticles/appHome/version/uptimeMs`） | 01-scope §1 与 04-acceptance AC-A-01/A-14 要求详细字段；spec.md §3 已确认这是主代理对计划冲突的取舍，Docker 探活只看 HTTP `ok` |
| D2 | 00-master §4.2 限流模板统一为「请求太频繁，请等几秒再试。」 | 登录限流用「尝试太频繁，请等一分钟再试。」，其它限流用「请求太频繁，请等几秒再试。」 | 02-contract §4.1 明确登录文案不同；spec.md §3 确认 |
| D3 | `profile.review` 查不到记录 | 查不到「当前学生名下」的 evidence 返回 403（不暴露存在与否）；artifact/session 查不到返回 404、非本人返回 403 | spec.md §3 取舍；与 `memory.delete` 的归属口径一致 |
| D4 | 00-master §6 一处写 legacy 为字符串数组，另一处写对象数组 | `x-legacy-methods` 用对象数组 `[{name, params, result, notes}]`；自检脚本兼容 `name` 字段 | spec.md §3 确认；对象数组能同时承载参数与返回说明 |
| D5 | 02-contract §5：`ProfileGrowthResult` 为 `{chapterId, summary, dimensions[]}` 对象 | 实际 `profile.growth` 返回 `GrowthSummaryItem[]` 数组（`packages/profile` 的 `growthSummary` 签名） | 代码事实优先；schema 按数组建模，字段 `competency/level/confidence/evidenceCount/status` |
| D6 | 03-implementation §3.8 / 04 AC-A-13：mock 题目 id 归一成 `q1`/`q2` | 题目 id 为 `q_<hash>`；smoke 与探针都从 `artifact.content_json.questions[].id` 读取，不硬编码 | spec.md §2 第 8 条：`registerArtifactQuestions(..., preferGlobalIds:true)` 改写 id |
| D7 | 03 §5 env 表未列提示词目录 | 代码需要 `LEARNING_AGENT_PROMPTS_DIR`（默认 `packages/agent`，容器内 `/app/packages/agent`），启动期校验 `agents/mentor.md` 存在；`buildContext` 会把解析后的目录写进 `process.env`，因为 `packages/agent/src/prompts.ts` 在调用时才读环境变量 | spec.md §2 第 12 条补齐；README env 表已登记。少了这一步 `chat.stream` 会以 `INTERNAL 找不到提示词 agents/mentor.md` 失败 |
| D8 | 01-scope §5 目录树把 SSE 写出放在 `src/http/sse.ts`；spec.md §4.3 写的是 `src/chat/sse.ts` | 并行落地结果：`SseWriter` 在 `src/http/sse.ts`；`test/sse.test.ts` 从 `../src/http/sse.js` 导入，与最终落位一致 | 两处计划位置不一致，以代码事实为准 |
| D9 | 03 §2.3 Dockerfile 只列 7 个 package 构建 | 构建阶段额外 build `shared`、`research`、`bp` | `services.ts` 的注入清单包含 ResearchService 与 BpService（spec.md §2 第 2 条），缺包会编译失败 |
| D10 | 01-scope §5 产物清单把 30 方法拆到 `student/news/questions/profile/artifacts/memory/chat/legacy.ts` 八个文件 | 实际落成 7 个：`student.ts`（`student.current` + 4 个 legacy）、`content.ts`（chapters/kps/news/questions.attempts）、`profile.ts`、`artifacts.ts`、`memory.ts`、`chat.ts`（chat.* + agent.*）、`index.ts` | 三个并行子代理的文件边界要不重叠；方法名仍然只出现在 `registry.ts` 一处，重复度为 0 |
| D11 | 03 §5 未定义 mock 的时间节奏 | `createMockLlm` 支持 `YXS_MOCK_DELAY_MS`（默认 0），逐 chunk 定时并在每个 chunk 前检查 `signal` | 真实模型每段耗时数百毫秒；不给节奏就无法验收「取消」「心跳」「断线」——按 0 延迟时一轮流在毫秒内结束，`chat/cancel` 永远抢不到在途请求（AC-A-12 曾因此卡在 `cancelled=false`） |
| D12 | 00-master §7.2 取消后发 `error(CANCELLED)` | `handleChatStream` 在 `catch` 里先判 `controller.signal.aborted`，命中则发 `CANCELLED` + 冻结文案「已停止这一轮（你点的停止）。这次没有保存结果，可以重新提问。」，不发 `done` | 不加这个分支，被中止的模型流会以「模型这次没有返回内容。」被 `friendlyError` 判成 `INTERNAL`，把用户主动取消当成服务端故障 |
| D13 | 00-master §3.4 `auth_tokens` 列为 `issued_at` | 表结构用 `issued_at TEXT NOT NULL`、`revoked_at TEXT`（可空），token 只存 `sha256` | 对齐冻结表；`revoked_at` 用 NULL 判断未吊销，避免空串与 NULL 两种"未吊销"语义 |

### 1.1 契约对齐修复（第二轮：真实 HTTP 契约测试 54/80 → 71/80）

| # | 缺陷 | 修复落点 | 说明 |
|---|---|---|---|
| F1 | `error.field` 给的是 `params.limit`，冻结 §4.1 样例是 `"field": "limit"` | `src/rpc/validate.ts` 的 `requiredNumber` / `optionalNumber` | 改成裸 key。`field` 语义是「出错的参数名」，`params` 是信封容器不是参数 |
| F2 | 类型错与越界复用同一条消息，冻结 §4.3 要求类型错用「`limit` 必须是整数。」 | 同上 | 拆两条：非 number / 非有限数 / 非整数 → `${key} 必须是整数。`；整数越界 → 各 handler 传入的范围消息。`optionalNumber` 的 `undefined`/`null` 默认行为不变 |
| F3 | 完全没有 RPC 级超时 | 新增 `src/rpc/timeout.ts`，`app.ts` 的 `handleRpc` 包装调用 | 默认 10s、`news.refresh` 30s、`artifacts.export` 20s（冻结 §2）。到点 `AbortController.abort()` 并把 signal 交进 handler：`news.refresh` → `fetch`、`news.match` → matcher 的模型调用，不是只让 HTTP 返回。超时抛 `504 TIMEOUT` + 冻结文案 |
| F4 | `chat/stream` 不校验 sessionId 归属，学生 B 能往 A 的会话写 | `src/chat/stream.ts`，在 `writer.start()` 之前 | 复用 `requireSession`，与 `chat.messages` / `agent.turns` 同一 403 文案。必须在 `start()` 之前：SSE 头一旦写出状态码就冻结在 200 |
| F5 | `newRequestId()` 用 base64url 切片，长度 0..12 位随机，还会产生空后缀 | 新增 `src/http/request-id.ts`，`app.ts` / `chat/stream.ts` 共用 | 逐位生成 12 位 base36（`randomBytes` 丢弃 ≥252 的字节消除取模偏差）。恒 16 字符、恒匹配 `^req_[a-z0-9]{1,24}$`。正则原本在 `app.ts` 与 `stream.ts` 各抄一份，一并收敛到这个模块 |
| F6 | `yxs_sqlite_busy_total` 渲染出 `db="sqlite"` 与 `db="learning"` 两条序列 | `src/metrics.ts` | 统一成 `SQLITE_BUSY_DB_LABEL = 'learning'`，递增与预热同标签 |
| F7 | `chat/cancel` 对未知 `requestId` 返回 400 | `src/app.ts` 的 cancel 分支 | 冻结 §7.2：未知或已结束 → 200 + `cancelled:false`。只有缺失 / 非字符串才是 400（重新生成 id 会让查找失去意义） |

**`limit` 越界裁决**：冻结 §4.3 把「夹取 or 400」下放到「逐方法在 §5 写明」，三份文档原本冲突。裁决为**一律 400 + 范围消息**，理由与落点写在 `plans/server-client-split/A-server-core/02-contract.md` §3.1。

## 2. 环境缺口（本机做不到，未伪造结果）

| # | 缺口 | 影响 | 补验方式 |
|---|---|---|---|
| E1 | 本机没有 `docker` 命令 | `Dockerfile` 未实跑；AC-A-19（镜像构建、`User=10001`、容器 `/health` 200、镜像 <500 MB）未采集证据 | 在有 Docker 的机器上：`docker build -f apps/server/Dockerfile -t yxs-server:local .` 后 `docker run --rm -p 8080:8080 yxs-server:local`，核对 `docker image inspect` 的 `Config.User` 与 `/health` |
| E2 | 本机没有 PyYAML（Python `yaml` 模块） | OpenAPI 自检不用 Python 解析，改用已安装的 npm `yaml` 包（`openapi-check.mjs`） | CI 若保留 Python 检查，需 `pip install pyyaml`；当前 `yaml.safe_load` 口径由 npm `yaml` 的 `parse` 等价覆盖 |
| E3 | `pnpm install` 退出码为 1 | 原因是仓库既有的 `ERR_PNPM_IGNORED_BUILDS`（`electron-winstaller`/`esbuild`/`node-pty` 等 8 个包的 postinstall 未批准），依赖树本身 "Already up to date"；本轮只新增 `apps/server` importer 与 `prom-client`/`bintrees`/`tdigest` 条目 | 需要干净退出码时在有交互的终端跑 `pnpm approve-builds`，与本轮代码无关 |
| E4 | 断网状态需人工切换 | AC-A-21（断网 smoke）标 `skipped`；mock LLM 本身不访问外网 | 人工断网（或黑洞 `api.deepseek.com`）后重跑 `smoke` |

## 3. 本轮实际跑过的验证（证据留档）

- `pnpm --filter @yxs/server typecheck` → exit 0。
- `node --import tsx --test apps/server/test/*.test.ts` → 28 tests / 28 pass（第二轮起；首轮 17）。
- `node apps/server/scripts/openapi-check.mjs` → 8 项 PASS。
- `node apps/server/scripts/gen-openapi.mjs` → 写出 `docs/contracts/openapi.yaml`（39 316 B）。
- 真实进程（`YXS_LLM=mock`，端口 18099，隔离 home）：
  - `tools/contract-tests/run.mjs --target http` → **71 passed / 4 failed / 5 skipped**（首轮基线 54/80）。
  - 逐项 curl：`field` 裸名 + 类型错文案、越界范围消息、`chat/stream` 跨学生 403、未知 `requestId` cancel 200、`requestId` 长度恒 16（`req_` + 12）、`yxs_sqlite_busy_total` 单序列、慢方法 504 TIMEOUT 结构化错误。
  - `scripts/smoke.mjs` → 5/5 PASS（login / chat-greeting / question-set / answer-set / readback）。
  - `scripts/probe-methods.mjs` → 34/34 通过（30 + 4 legacy）。
- `/metrics` 实测含 10 个 `yxs_*` 指标；`yxs_rpc_duration_seconds` 声明 12 个桶，prom-client 额外导出 `+Inf`，故文本里是 13 行 `le`。

### 3.1 契约测试剩余 4 条失败的原因（非本轮 6 项范围）

| 用例 | 现象 | 根因 | 归属 |
|---|---|---|---|
| `E-006` `news.refresh` | 502 `UPSTREAM_FAILED` | 本机没有起 Python 新闻侧车（`NEWS_CRAWLER_BASE_URL` 默认 `127.0.0.1:8787`），`newsOffline` 分支直接 502。契约要求侧车在线才 200 | 环境缺口，需 C 轮侧车 |
| `E-011` `profile.growth` | 返回数组，用例期望对象 | `frozen.mjs` 里该行写的是 `kind: 'object'`，而 `packages/profile` 的 `growthSummary` 返回 `GrowthSummaryItem[]`，`schemas.ts` 与 OpenAPI 也都按数组建模（见 D5） | E 轮冻结表笔误 |
| `E-013` `profile.snapshot` | 返回数组，用例期望对象 | 同上：`recordSnapshot` 返回 `GrowthSnapshot[]`，`ProfileSnapshotResult` 是 `$ref: GrowthSnapshot`（数组元素） | E 轮冻结表笔误 |
| `E-017` `artifacts.export` | 500 `PATH_OUTSIDE_APP` | 种子库里的 `artifacts.path` 是另一台机器上的绝对路径（`E:\Documents\GitHub\learning-agent\...`），`isPathUnder` 正确拒绝写到当前 app home 之外。契约本身要求这个守卫 | 种子数据缺口，需在当前机器重建种子产物 |



## 4. 本轮未执行的验收项

- 镜像构建与容器探活（E1）。
- 断网 smoke（E4）。
- mutation 反向验证（M1..M5）：见 `docs/mutation-notes.md`，由用户统一验收时执行。
