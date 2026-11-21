# A · 服务端骨架 · 范围与边界

> 轮次：A · 服务端骨架
> 文档角色：01-scope
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1
> 一句话：把桌面端主进程里那套「30 个方法 + 5 个通道」原样搬到 `apps/server`，桌面端一行不用改就能继续跑。

## 1 目标

1. **新增 `apps/server`，一个进程同时提供 HTTP RPC 与 SSE**，监听 `0.0.0.0:8080`，`/health` 供容器探活、`/metrics` 供 Prometheus 抓取。
   判断标准：`curl -s localhost:8080/health` 返回 §7.5 的 JSON；`curl -s localhost:8080/metrics | findstr yxs_` 至少命中 10 个指标名。
2. **30 个业务方法全部可用**，走 `POST /api/v1/rpc` 单端点分发，方法名与冻结表（`01-frozen-contracts.md` §5）逐字一致。
   判断标准：`scripts/smoke.mjs` 五步全绿；`GET /api/v1/openapi.yaml` 里 30 个方法枚举一个不多一个不少。
3. **登录与鉴权成立**：学号 + 口令 → scrypt 校验 → 32 字节随机 token；`studentId` 只从 token 解析。
   判断标准：请求体里伪造 `studentId` 不生效（日志出现 `ignoredStudentId=true`，返回仍是 token 里的学号）；登出后同一 token 立刻 401。
4. **5 个专用通道成立**：`chat` SSE、`cancel`、`answer`、`answer-set`、`health`。
   判断标准：SSE 事件顺序为 `session → (round/text/tool/tool-end)* → done`；取消后 1 秒内不再出现 `text`；`answer-set` 能回读到成绩。
5. **契约文档可交付**：`docs/contracts/openapi.yaml`（3.0.3）覆盖 30 方法 + 5 通道 + 4 个 legacy 只读方法（`x-legacy-methods`）。
   判断标准：E 轮 `coverage` 命令读这份文件时不报缺项（缺失时它只能标 `pending`，那是 E 的问题不是 A 的免责）。
6. **可运维**：单行 JSON 日志 + 10 个指标 + `SQLITE_BUSY` 计数 + 非 root 镜像。
   判断标准：并发压 60 路时 `/metrics` 的 `yxs_http_request_duration_seconds_count` 与日志行数对得上；镜像 `docker image inspect` 的 `Config.User` 不是空/root。
7. **无模型也能跑**：`YXS_LLM=mock` 时五步 smoke 不依赖外网、不依赖 API Key。
   判断标准：断网执行 smoke 仍全绿；`YXS_LLM=deepseek` 且无 Key 时返回 `UPSTREAM_FAILED` 而不是 500 裸栈。

目标的排序是「先定调用面、再定流式面、最后谈部署」：单端点分发先立住 [R3]，事件帧再对齐 [R10]，运维项放最后，避免一开始就被 Docker 与指标牵着走。

## 2 非目标

| 不做 | 为什么 |
|---|---|
| 不改 `packages/db` 的 schema（不加 `auth_*` 表） | 一旦往共享包加表，D 轮的迁移基线与 G 轮的备份范围全部要重算；登录表放 `auth.db` 自持 [R7] |
| 不做多租户 / 教师端 / 角色权限 | 本轮只证明「一个学生一个 token」这条链路；角色会污染 30 方法的鉴权语义 |
| 不实现 CAS / OAuth2 授权码流 | 只留 `501` 路由占位（`01-frozen-contracts.md` §3.5）；接了也没有上游 IdP 可测 |
| 不做文件预览 / 打开对话框 / 显示所在文件夹 | 那是客户端本地能力（`apps/desktop/src/main/index.ts:370-389`），HTTP 化没有意义且会变成任意文件读取漏洞 [R7] |
| 不做 gzip、HTTP/2、TLS、CORS 白名单 | 生产由反代承担；压测口径要干净，多一层压缩会让 P95 不可比 |
| 不做 SSE 断线重放（Last-Event-ID） | 事件里没有可重放的持久化游标；假装支持会让客户端拿到重复文本 |
| 不做 SQLite → PG 的运行期切换 | D 轮只做迁移工具（`D-pg-migration/README.md` 原文：「不改 `packages/db` 的运行时 SQL 方言」） |
| 不做小程序、不做 Electron 改造 | I 轮是纯静态 mock；H 轮只做 mutation 验证 |

## 3 真实依据（现状代码）

| # | 位置 | 现在是什么 | 为什么必须动 |
|---|---|---|---|
| 1 | `apps/desktop/src/main/index.ts:203-393` | 一个 `switch (method)` 承载全部业务方法，直接调 `db` / `profileService` / `agentRuntime` | 这是「30 个方法」的唯一事实来源；HTTP 化必须先把它变成注册表，否则方法集合会漂移 |
| 2 | `apps/desktop/src/main/index.ts:204-207` | `studentId` 取自 `input`，缺省 `student_demo` | 服务端若沿用这条，任何客户端都能冒充别人；必须反转成「只信 token」 |
| 3 | `apps/desktop/src/main/index.ts:390-392` | 未知方法抛 `unknown learning method: ${method}`（英文） | 对外接口的英文栈不可上屏，也不可被契约测试断言；需中文 + `404 UNKNOWN_METHOD` |
| 4 | `apps/desktop/src/main/index.ts:445-536` | 5 个通道以 `ipcMain.handle` 注册：`learning:invoke|chat|cancel|answer|answer-set|health` | 这 6 个通道就是 HTTP 端点清单与请求体形状的来源 |
| 5 | `apps/desktop/src/main/index.ts:467-487` | `onEvent` 把步骤推给渲染层，`signal` 交给执行链 | SSE 的事件名/字段必须对齐这里的事件对象，否则客户端要改两套解析 |
| 6 | `apps/desktop/src/main/index.ts:482-486` | 注释写明「只测 `runAgentLoop` 测不到这条接线」 | 取消必须验到「真的把 `AbortSignal` 传进执行链」，只看连接断开是假绿 |
| 7 | `apps/desktop/src/preload/index.ts:3-38` | `window.learning` 的 8 个成员定义了客户端契约面 | HTTP 端点形状要与之一一对应，桌面端将来只换 transport 不改调用点 |
| 8 | `packages/agent/src/index.ts:44-116` | `HandleTurnInput/Output`、`AnswerQuestion*`、`AgentRuntime` 接口 | `done` 事件的字段只能从这里取，不许自造 `stats` 之类 |
| 9 | `packages/agent/src/team.ts:17-35` | `TeamEvent.type` 只有 `round|text|tool|tool-end|session` 五种 | 所以 SSE 事件名只能是这 5 个 + 传输层 `done`/`error`；多一个就是新契约 |
| 10 | `apps/desktop/src/main/errors.ts:9-67` | `friendlyError` 把上游错误翻成中文目录 | 中文错误是产品契约（E 轮逐字断言）；服务端应复用同一套文案而不是另写一套 |
| 11 | `apps/desktop/src/main/health.ts:11-33` | `startupHealth` 判章节 0 / 知识点 0 / 新闻 0 | `/health` 的 `warnings/notices` 必须复用这套判定，否则容器健康与界面自检两套口径 |
| 12 | `packages/db/src/index.ts:92-448` | 35 张表的 `CREATE TABLE`，全部 STRICT | 服务端读写的字段名/类型必须与这里一致；迁移与备份也以它为准 |
| 13 | `packages/db/src/index.ts:214-217` | `student_profiles` 只有 `name/cohort`，没有口令列 | 所以口令必须另存；这是 `auth.db` 决策的直接证据 |
| 14 | `pnpm-workspace.yaml:1-4` | workspace 只含 `packages/*`、`profiles/*`、`apps/*` | `apps/server` 会进 workspace，依赖 `workspace:*`；因此 Docker 构建 context 必须是仓库根 |
| 15 | `apps/desktop/src/main/llm.ts:89-202` | `stream()` 产出 `block-start/text-delta/tool-call-delta/block-end/finish/usage` | mock LLM 必须产出同样的 chunk 类型，否则 agent 循环认不出来 |

这 15 条的共同判据是「客户端能不能只换 transport、不改解析器」——这也是 SSE 规范强调帧稳定性的原因 [R10]。

## 4 与现行为的差异（有意变更）

| 项 | 现状（IPC） | 服务端契约 | 影响谁 |
|---|---|---|---|
| 参数校验 | 宽容：`String(args.x ?? '')`、类型错当没传（`index.ts:204-393`） | 严格：缺必填/类型错 → `400 BAD_REQUEST` + 中文消息 | E 轮用例、桌面端切 HTTP 时的入参 |
| 身份来源 | 请求体 `studentId`，缺省 `student_demo` | 只从 token；请求体字段忽略 | 所有调用方；桌面端需先登录再调用 |
| 查询不到 | 多个 getter 返回 `undefined`（如 `news.get`、`artifacts.get`） | `404 NOT_FOUND` + 中文消息 | 客户端错误处理；`undefined` 不再出现 |
| 未知方法 | 抛英文 Error | `404 UNKNOWN_METHOD` + `没有这个方法：<method>` | 契约测试、调试体验 |
| 归属校验 | 无（单机单学生，靠约定） | 会话/产物/证据/事实四类强制校验，失败 `403` | 越权用例；`artifacts.get` 必须带 `studentId` 过滤 |
| 模型密钥 | 存本机 `settings.json`（`main/settings.ts`） | 服务端读 `DEEPSEEK_API_KEY` 环境变量 | 部署方式；桌面端设置页在服务端模式下不再生效 |

> 这 6 条差异不是「顺手改改」，而是拆分后**必须**成立的语义。写进 A 的 `02-contract.md` §4，并由 E 轮逐条断言。

其中「身份只从 token 来、资源必须校验归属」两条属于对外暴露后的底线要求，OWASP 的 REST 安全清单把它们列为必做项 [R7]；我们不做角色体系，但必须做这两条。

## 5 产物清单

```text
apps/server/
  package.json                  @yxs/server，type=module，scripts: dev/start/typecheck/test/smoke
  tsconfig.json                 继承 ../../tsconfig.base.json，composite=false
  Dockerfile                    node:22-slim 多阶段；非 root(10001)；HEALTHCHECK /health
  README.md                     怎么跑、env 表、smoke 怎么用
  src/index.ts                  进程入口：loadEnv → buildContext → createApp → listen → 优雅退出
  src/context.ts                复刻 initServices：Context + llm + LearningDb + 6 个 Service
  src/app.ts                    路由表装配（health/metrics/auth/rpc/chat/answer/answer-set/openapi）
  src/http/read-json.ts         读体（1 MiB 上限）、JSON 解析、`PAYLOAD_TOO_LARGE`
  src/http/respond.ts           统一 respond(ok/err)、状态码映射、requestId、elapsedMs
  src/http/sse.ts               SSEWriter：id 递增、15s 心跳、done 一次性、close 清理
  src/auth/passwords.ts         scrypt 哈希/校验（timingSafeEqual）
  src/auth/store.ts             auth.db 建表、签发/校验/撤销 token（存 sha256）
  src/auth/bearer.ts            Authorization 解析 → { studentId } 或抛 AUTH_*
  src/rpc/registry.ts           方法注册表：名称/输入校验/归属策略/handler
  src/rpc/validate.ts           轻量校验器（string/number/enum/array，中文消息）
  src/rpc/handlers/student.ts   student.current、chapters.list、kps.list、getKp（legacy）
  src/rpc/handlers/news.ts      news.list/status/refresh/get/match、getResource（legacy）
  src/rpc/handlers/questions.ts questions.attempts
  src/rpc/handlers/profile.ts   profile.get/growth/evidence/snapshot/review
  src/rpc/handlers/artifacts.ts artifacts.list/get/export
  src/rpc/handlers/memory.ts    memory.facts/episodes/summary/upsert/delete
  src/rpc/handlers/chat.ts      chat.sessions/messages、agent.snapshot/suggestions/turns/ledger/retry/sessions、listIdeology（legacy）
  src/rpc/handlers/legacy.ts    getBlock 的组装逻辑（chapter/section 上下文）
  src/ownership.ts              ensureSessionOwner / ensureArtifactOwner / ensureEvidenceOwner
  src/chat/turns.ts             Map<requestId, AbortController>：begin/cancel/done
  src/chat/stream.ts            /chat/stream：把 TeamEvent 映射为 SSE 帧 + done
  src/chat/answers.ts           /answer、/answer-set：校验 + 调 runtime + friendlyError(context:'answer')
  src/llm/mock.ts               确定性 mock：text 流 / 脚本化 emit_question_set
  src/llm/deepseek.ts           从 main/llm.ts 移植的 stream/chat（不 import desktop）
  src/metrics.ts                prom-client 或自研计数器（见 03 §4）
  src/log.ts                    单行 JSON，字段见 01-frozen-contracts §9.1
  src/env.ts                    env 读取与默认值、启动期校验（端口/目录可写）
  scripts/smoke.mjs             五步 smoke（登录→提问→出题→交卷→查档案）
  scripts/openapi-check.mjs     自检：openapi.yaml 的 30+5 是否齐全（防手滑）
  test/*.test.ts                node:test：校验器、鉴权、SSE 顺序、归属
docs/contracts/openapi.yaml     OpenAPI 3.0.3（唯一 owner：A）
.dockerignore                   仓库根；只为服务端构建排除大目录（仅新建）
```

**同时新增（不改动）**：无。`apps/server` 之外不碰任何文件，除了 `pnpm-lock.yaml` 的一次 `pnpm install`（`apps/server` 进 workspace 的必然结果）。

目录划分方式（入口 / 传输 / 鉴权 / 编排 / 领域 / 观测分开）与容器分层（构建阶段与运行阶段分开）参照 [R4] 与 [R25]，目的是让每个文件只有一种职责，评审时能一眼看出边界。

## 6 并行边界

| 项 | 值 |
|---|---|
| 只读依赖 | `packages/*`（db/agent/profile/artifacts/questions/matcher/news）、`apps/desktop/templates`（产物模板，只读 COPY 进镜像） |
| 写权 | `apps/server/**`、`docs/contracts/openapi.yaml`、根 `.dockerignore`（仅新建）、`pnpm-lock.yaml`（仅 install 产物） |
| 端口 | `8080`（`YXS_SERVER_PORT`）；被占则 `8180/8280` 退避 |
| 临时数据 | `.scratch/run/A/home/`（内含 `data/learning.db` 副本 + `auth.db`）；**不碰** `.learning-agent` |
| 容器/镜像 | 镜像名 `yxs-server:local`；**不启动** compose（那是 C 轮），单测用本地进程 |
| 与 C 的接口 | 只通过冻结镜像名 + `8080` 端口 + `/health` 契约交互；C 不读 A 的 Dockerfile 内容 |
| 与 E 的接口 | E 读 `docs/contracts/openapi.yaml`；缺失时按冻结表核对并标 `pending`，A 不必等 E |
| 与 F 的接口 | F 抓 `/metrics`，指标名以 `01-frozen-contracts.md` §9.2 为准；A 不得改名 |
| 与 D 的接口 | 两者都读 `learning.db`；A 不迁移、不改方言；D 不改服务端 |
| 互斥 | 无（A 不与 H 的 Electron 锁冲突） |

与 E、F 的接口都落在「文件 + 指标名」这两个稳定面上，而不是进程调用——契约文件与指标名是唯一需要双方共同遵守的薄接口，这与 OpenAPI 作为跨团队边界的定位一致 [R2]。

## 7 未知与风险

| # | 风险 | 验证方法 |
|---|---|---|
| 1 | `packages/agent` 的 `AgentService` 依赖 Electron 环境（`app.getPath` 等） | 在 `apps/server` 里 `new AgentService(new Context())` 并跑一次 `handleConversation`（mock LLM）；若抛 Electron 相关错误，记录在 `03-implementation.md` §6 并给出注入替身方案 |
| 2 | `ArtifactService` 需要 `templatesDir` 与 `appHome`，容器内路径与开发路径不同 | 镜像内 `ls /app/templates` 与 `ls /data/artifacts`；`artifacts.export` 跑一次 md/html/docx 三种格式 |
| 3 | `NewsService` 依赖侧车在线；侧车未起时 `news.refresh` 会挂 | `YXS_NEWS_OFFLINE=1` 时 `news.refresh` 返回 `UPSTREAM_FAILED`；`news.list` 仍可用（只读库） |
| 4 | `SQLITE_BUSY` 在高并发下真实发生，指标可能为 0（假绿） | 用 F 轮 60 并发 + 同时 `profile.snapshot` 写库，观察 `yxs_sqlite_busy_total` 是否 > 0；为 0 则说明 WAL 配置生效，记录实测值 |
| 5 | `auth.db` 与 `learning.db` 双库事务不一致（登录成功但学生不存在） | 登录时若 `auth_students` 有记录但 `student_profiles` 无该学号：允许登录，`student.current` 返回 `name:'学生'`（与 `index.ts:210-212` 的兜底一致）；写进 §3 测试 |
| 6 | SSE 在 Windows 本机被缓冲，客户端收不到增量 | `curl -N` 逐帧观察；若缓冲，检查 `X-Accel-Buffering` 与响应头 `Content-Encoding` |
| 7 | 严格校验会让旧的宽容调用方（含渲染层）报错 | 用 E 的 `--target electron` 对比同一批调用；差异列成表交人裁决，不自行放宽 |

风险 4 与 6 的验证都依赖「能被量到」：`SQLITE_BUSY` 必须有独立计数器，SSE 必须有首 token 直方图——没有指标的风险只能靠猜，这与直方图实践的要求一致 [R44]。

## 参考

- [R7] OWASP REST Security Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html — 支撑 §2「不做本地文件能力」与 §4 越权收紧 — 采用「不暴露文件系统、错误信息不泄漏内部结构」。
- [R8] OWASP Session Management Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html — 支撑 §1 目标 3 与 §3 第 13 条 — 采用「服务端可撤销、短期过期、存哈希不存原文」。
- [R3] JSON-RPC 2.0 规范 — https://www.jsonrpc.org/specification — 支撑 §5 `src/rpc/registry.ts` 的单端点分发 — 借鉴 method/params/error 结构，不引入 batch。
- [R10] WHATWG Server-Sent Events — https://html.spec.whatwg.org/multipage/server-sent-events.html — 支撑 §1 目标 4 的事件帧 — 采用 event/data/id，不做重放。
- [R12] paritytech/jsonrpc — https://github.com/paritytech/jsonrpc — 支撑 §3 第 3 条「未知方法要结构化错误」 — 借鉴注册表 + 未知方法分支，不引入其传输层。
- [R19] trafilatura — https://github.com/adbar/trafilatura — 仅作反例参照：它把「正文抽取质量」做成可量化指标，提醒我们不要用「能跑通」当质量 — 不适用于 A，列此说明为何 A 用「契约 + 指标」而非人工感觉。
