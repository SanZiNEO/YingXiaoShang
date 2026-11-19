# F · 压测 + 可观测性 · 实现方案

> 轮次：F · 压测 + 可观测性
> 文档角色：03-implementation
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1（§4 信封、§7 SSE 序列、§9.2 指标与桶、§9.3 告警阈值）
> 契约细化：[`02-contract.md`](02-contract.md) §2 CLI、§3.2 报告 schema、§3.3 计算口径、§3.4 规则、§4.2 退出码
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1、§3
> 一句话：一个不进根 workspace 的 Node 22 独立包，用内置 `fetch` 跑 40/60 两路并发学生场景，从客户端采样与 `/metrics` 两侧出分位数、首 token、错误率、busy 计数与每学生汇总，同源生成 md + json 报告，并交付 5 条可被 `promtool` 校验的告警规则。

## 1 目录与模块

目录树与 [`01-scope.md`](01-scope.md) §5 产物清单、[`02-contract.md`](02-contract.md) §2.1 入口约定逐条对齐；本节只补每个文件的职责边界与「谁不许干别人的活」。

```text
tools/loadtest/
  package.json                  # 独立包声明；type=module；不在 pnpm-workspace 三条 glob 内
  scenario.mjs                  # CLI 入口：解析参数 → 预检 /health → 编排场景 → 汇总 → 落报告
  src/
    client.mjs                  # HTTP/SSE 客户端：登录、RPC、chat/stream、answer、answer-set、cancel；计时与采样
    scenario.mjs                # 虚拟学生编排：登录→提问→出题→交卷→回读；VU 池、ramp-up、硬截止
    stub.mjs                    # 内置内存 stub：冻结信封 /health /metrics /rpc /chat/stream /answer /answer-set
    metrics.mjs                 # 抓取并解析 /metrics 文本；10 指标核对、busy 增量、token 按学生汇总
    summarize.mjs               # 样本最近秩法算 P50/P95/P99、错误率、每学生聚合；产出报告数据对象
    report.mjs                  # 由同一份报告数据对象生成 loadtest-report.md 与 loadtest-report.json
  config/
    loadtest.example.json       # 示例配置：并发档位、场景开关、固定配额、stub 开关；不含真实 Key
  prometheus/
    alerts.yml                 # 5 条告警规则（冻结 §9.3），promtool 可校验
  scripts/
    check-alerts.mjs            # 本机自检：规则可解析、5 条齐全、指标名在 §9.2 清单内（promtool 缺失时兜底）
  README.md                     # 怎么跑、参数表、报告字段、mock/real 区别、已知失真
```

| 层 | 模块 | 职责边界 |
|---|---|---|
| 入口 | `scenario.mjs` | 只做参数解析、预检、目标选择、流程编排与退出码；不写 HTTP 细节、不算分位数 |
| 传输 | `src/client.mjs` | 唯一发请求的地方：fetch、Bearer、SSE 帧读取、起止计时、样本落内存数组；不做业务断言、不算汇总 |
| 编排 | `src/scenario.mjs` | 唯一持有 VU 生命周期与并发调度的地方；决定一个学生走哪几步、顺序与复用哪条会话 |
| 替身 | `src/stub.mjs` | 内存实现冻结信封与 SSE 序列，供并行期自检；不访问网络、不写盘 |
| 观测 | `src/metrics.mjs` | 只解析 `/metrics` 文本；不重算、不新增、不改名任何服务端指标 |
| 汇总 | `src/summarize.mjs` | 纯函数：输入样本数组 + 指标快照，输出报告数据对象；不发请求、不落盘 |
| 生成 | `src/report.mjs` | 纯渲染：报告数据对象 → md / json；两份数字同源，禁止在渲染层二次改数 |
| 规则 | `prometheus/alerts.yml`、`scripts/check-alerts.mjs` | 规则文本与本机自检；F 侧不部署 Prometheus 服务 |

分层与单职责切分参照轻量 Node 压测工具的组织方式 [R3]；报告维度（分位数 + 每用户明细）参照 Gatling 的汇总结构，但不引入其 Scala 运行时 [R2]。VU 模型（一个虚拟用户跑完完整场景脚本，再回收复用）参照 k6 的场景组织思路，不引入 k6 运行时 [R1]。

## 2 依赖与构建

### 2.1 独立包，不进根 workspace

`pnpm-workspace.yaml:1-4` 的 glob 只有 `packages/*`、`profiles/*`、`apps/*`，`tools/*` 不在其内；因此 F 包在自己目录下独立安装、各自 lockfile，根 `pnpm-lock.yaml` 只归 A 轮碰（归属矩阵 §1 与 §2「各工具包都改根 lockfile」一节）。

```powershell
cd E:\Documents\GitHub\YingXiaoShang\tools\loadtest
pnpm install --ignore-workspace
```

- **不新增根依赖**：不在仓库根 `package.json` 加任何条目，不跑根 `pnpm install`；F 的 lockfile 只落在 `tools/loadtest/` 内。
- **HTTP 与 SSE 只用 Node 内置**：Node 22 全局 `fetch`、`ReadableStream`、`node:fs`、`node:path`、`node:process`、`node:util`，不引 axios / got / eventsource 第三方包，减少独立包安装面。
- **运行时依赖为空**：`package.json` 的 `dependencies` 留空；`devDependencies` 只放类型与运行辅助（`@types/node`、`tsx` 可选）。场景脚本按 E 轮同款纯 `.mjs` 编写，`node scenario.mjs` 直接执行，不做编译步骤。不引 HTTP 框架与 SSE 客户端库的取舍，与轻量 Node 压测工具保持同一思路：只保留并发调度与采样这层自有逻辑 [R3]。
- **YAML 不引解析库**：`alerts.yml` 是 Prometheus 规则文本，`scripts/check-alerts.mjs` 只做轻量结构核对（规则名、`expr`/`for`/`labels`/`annotations` 字段存在性、指标名是否在 §9.2 清单内）；真正的规则语法校验交给 `promtool`（见 §3.9 与 §6）。

独立包口径与既有 `tools/automated-testing/package.json:16` 的依赖声明方式一致：工具目录自带 `devDependencies`，不反向依赖根 `node_modules`。

### 2.2 运行环境

| 项 | 口径 |
|---|---|
| Node | 本机 `node v22.23.2`（已核实）；`fetch` 与 Web Streams 全局可用，不需要 polyfill |
| 包管理器 | `pnpm 11.28.5`（已核实）；`--ignore-workspace` 后安装到 `tools/loadtest/node_modules` |
| 构建 | 无编译步骤；类型检查（若配 `tsc`）只针对可选 `.ts` 辅助文件，`.mjs` 不参与 |
| 被测目标 | 本机 `apps/server` 实例（端口 18080）或内置 stub；F 自己不启动服务端进程 |

## 3 关键实现

### 3.1 VU 生命周期：一个学生 = 一个虚拟用户 + 一条会话

每个虚拟学生（VU）在内存里持有一份独立上下文，生命周期与既有桌面端「一个当前学生一条会话」的单机口径对应，但被 F 复制成并发 N 份。学生编号从 `2023F001` 起顺序生成（契约 §2.3）。

```text
StudentContext {
  studentId        // 2023F001 .. 2023F00N，顺序生成
  password         // 取自配置，不写进报告正文
  token            // 登录成功后缓存；整轮复用，不每步重登
  sessionId        // 首条 SSE 的 session 事件带回；后续提问复用同一条会话
  turns            // 该学生收到的 done 事件计数
  tokensPrompt     // 汇总自 /metrics 的 prompt tokens（usage 事件仅作交叉核对）
  tokensCompletion // 汇总自 /metrics 的 completion tokens
  samples: Sample[] // 该学生产生的逐请求样本
}
```

VU 步骤顺序（`src/scenario.mjs`，时序见契约 §2.3 与 §5.1）：

1. **登录**：`POST /api/v1/auth/login`，从信封 `result.token` 取 43 字符 base64url token（冻结 §3.1）；失败按 §6 归类。
2. **提问**：`POST /api/v1/chat/stream`，首步不带 `sessionId`；从首帧 `session` 事件取 `sessionId` 存入上下文，后续提问复用。
3. **出题**：第二条 SSE 消息携带出题意图；等待 `done` 帧拿到 `artifactId` 与题目产物。
4. **作答 / 交卷**：`POST /answer` 逐题作答，`POST /answer-set` 交卷；题目 ID 从出题 `done` 载荷的 `artifacts`/`citations` 提取，不硬编码题号。
5. **回读**：`POST /rpc` 调 `agent.turns`、`chat.sessions` 回读成绩与轮次，作为该学生 turns 计数的旁证。

身份口径严格按冻结 §3.2：后续请求只带 `Authorization: Bearer <token>`，请求体里不主动塞 `studentId`；RPC 信封形态（`method/params/requestId`、`ok/result/error`）取自 JSON-RPC 2.0 单端点约定，但不做 batch 与 notification [R13]。

事件形状对照现有代码：SSE 事件名集合与 `packages/agent/src/team.ts:17-19` 的 `round|text|tool|tool-end|session` 一致，外加传输层 `done`/`error`；终态载荷结构对应 `HandleTurnOutput`（`packages/agent/src/index.ts:52-67`）。

### 3.2 并发调度与限速

并发模型不引入外部运行时，用「VU 池 + 异步 worker + 限速启动」自研，口径参照 Node 侧轻量 loadtest 的并发数 + 逐请求统计做法 [R3]，并发档位与 ramp-up 概念参照 k6 [R1]。参数名与边界以契约 §2.1 为准。

```text
调度器（src/scenario.mjs）
  输入：students N、iterations K、rampUpSec R、硬截止 deadline
  1. 预检：/health 200 后才放开 VU；预检未过的学生标 blocked，不计入请求分母
  2. 起始快照：抓一次 /metrics（busy、token、启动时间对比基线）
  3. 启动 N 个 worker 协程；第 i 个 worker 延迟 (R/N)*i 后开始（ramp-up，避免瞬时打满）
  4. 每个 worker 重复 K 轮完整场景；两轮之间不做固定 think-time（需要时由配置留口子）
  5. 到达硬截止 deadline 后停止派发；在途请求给宽限期收尾，超时未结束记 timeout
  6. 结束快照：再抓一次 /metrics；全部 worker 退出后汇总、生成报告
```

- **并发上限校验**：`--students` 必须是 1..200 的整数；越界在参数解析阶段拒绝（§6）。
- **限速口径**：F 侧不做令牌桶限流（那是服务端 `RATE_LIMITED` 的域）；客户端只控制同时在途的 VU 数 = `students`，单 VU 串行走完自己的场景步骤。若服务端返回 429，样本归入 `http4xx` 旁注，不自动退避重试。
- **连接复用**：`fetch` 走全局 keep-alive（冻结 §2）；同一 VU 的多次请求复用底层连接，避免压测机自身端口耗尽干扰服务端口径。学生间不共享 HTTP 连接池状态（契约 §5.3）。
- **取消路径抽样**：场景中可选地对少量在途轮次调 `POST /api/v1/chat/cancel`（按 `requestId`），归类为 `cancelled`，不计入失败分子；取消透传 `AbortSignal` 的既有语义见 `packages/agent/src/tool-loop.ts:234`、`:382` 两处 `signal.aborted` 检查。

### 3.3 SSE 读取循环与首 token 计时

`src/client.mjs` 的 SSE 读取按 WHATWG 帧格式切流：空行分隔帧，每帧解析 `id:`、`event:`、`data:`（多行 `data:` 按换行拼接）、`: ` 注释行（心跳，跳过）[R8]；心跳注释行与代理缓冲注意点参照 MDN 的 SSE 使用说明 [R9]。

```text
openStream(input) -> CollectedStream
  t0 = 即将写出请求头的时刻（fetch 派发前一刻；不含本地排队与脚本调度等待）
  res = fetch('/api/v1/chat/stream', { method:'POST', body, signal })
  读 res.body reader，按 \n\n 切帧，累积 buffer
  对每帧：
    注释行（: 开头）→ 跳过
    event: session   → 记录 sessionId；不计首 token
    event: round     → 记录轮次；不计首 token
    event: tool/tool-end → 记录工具事件；不计首 token
    event: text      → 若首条非空 text 到达且 firstTokenMs 未记：
                        t1 = Date.now()；firstTokenMs = t1 - t0
                        此后只累积文本，不再覆盖首 token
    event: done      → 终态；记录 turnId/sessionId/text/artifacts，关闭读取
    event: error     → 标记 failed，code/message 落样本，首 token 记 null，终止收集
  空闲超过 YXS_SSE_TIMEOUT_MS（默认 60000，对齐冻结 §2 的 60s 空闲断开）→ 记 timeout
```

计时口径三条硬规则（契约 §3.3.2）：

1. **起点**：`fetch` 派发前一刻，不含本地排队与脚本调度等待。
2. **终点**：第一个携带非空正文的 `text` 帧到达；`session`/`round`/`tool`/`tool-end` 帧不算首字。
3. **终态判据**：`done` 只认一次；收到 `error` 帧即终止，此后不再期待 `done`；流在没有 `done` 的情况下结束，按 §6 的「SSE 中途断开」归类；失败轮次首 token 记 `null`，不补 0、不用上一次样本顶替。

事件形状对照 `apps/desktop/src/main/llm.ts:89-94` 的 chunk 类型集合，避免把元数据帧误判成首字。

### 3.4 错误分类统计

样本结构（`src/client.mjs` 产出，`src/summarize.mjs` 消费）：

```ts
interface Sample {
  studentId: string
  scenario: 'login' | 'ask' | 'questions' | 'answer' | 'answer-set' | 'readback'
  method?: string            // RPC method 名或路由
  at: number                 // epoch ms
  durationMs: number
  firstTokenMs?: number | null
  status: number | null      // HTTP 状态码；传输层失败为 null
  code?: string               // 信封 error.code 或 SSE error.code
  ok: boolean
  errorClass: 'http5xx' | 'http4xx' | 'businessError' | 'sseError' | 'cancelled' | 'timeout' | 'networkAbort'
  requestId: string
}
```

分类规则（契约 §4.1，分母 = 全部已派发请求；blocked 学生不计入分母）：

| 分类 | 判据 | 进失败分子 |
|---|---|---|
| `http5xx` | HTTP 500/501/502/503/504；或信封 `INTERNAL/UPSTREAM_FAILED/TIMEOUT` | 是 |
| `businessError` | HTTP 200 但信封 `ok:false`（4xx 业务校验失败同时单列 `http4xx`） | 是 |
| `sseError` | 收到 `error` 帧，或流未到 `done` 即断开 | 是 |
| `timeout` | 超过路径空闲阈值未得终态 | 是 |
| `networkAbort` | 连接重置 / DNS 失败 / 中断 | 是 |
| `cancelled` | `error(code=CANCELLED)` 或主动调 cancel 后在途轮次终止 | 否，单列 |
| `http4xx` | 400/401/403/404/413/429 | 否，单列 |

- **错误率** `errorRate = requestsFailed / requestsTotal`；另有独立的 5xx 率口径 `http5xx / (http2xx + http4xx + http5xx)`，与 `errorRate` 分列，不混用（契约 §3.3.3）。
- 报告 `statusBreakdown` 字段：`http2xx/http4xx/http5xx/businessError/sseError/cancelled/timeout/networkAbort`。
- 错误对象只记分类码与 `requestId`，内部堆栈不进报告正文（对照 `apps/desktop/src/main/errors.ts:13-18` 的产品口径：对外一句话、细节进日志）。

### 3.5 从 `/metrics` 抓 `yxs_sqlite_busy_total` 与直方图

`src/metrics.mjs` 在场景启动后做一次起始快照，场景结束后再抓一次结束快照，差值即本轮增量；运行中不轮询，避免干扰基线（契约 §2.2、§5.3）。`/metrics` 文本按 Prometheus exposition 格式逐行解析：`# HELP`/`# TYPE` 跳过，样本行形如 `name{label="v",...} value [timestamp]`。

核对与抽取清单（指标名逐字取自冻结 §9.2，共 10 个；标签逐字见契约 §3.1）：

| 指标 | 类型 | F 侧用途 |
|---|---|---|
| `yxs_http_requests_total` | counter | 复核请求总量与 5xx 率 |
| `yxs_http_request_duration_seconds` | histogram | 服务端侧 P50/P95/P99 复核；取 `_bucket`/`_sum`/`_count` |
| `yxs_rpc_requests_total` | counter | 按方法错误率旁证 |
| `yxs_tokens_total` | counter | 按 `student_id`、`kind=prompt/completion` 汇总每学生 token |
| `yxs_errors_total` | counter | 按错误码分类计数旁证 |
| `yxs_sqlite_busy_total` | counter | 本轮增量 = 结束值 − 起始值，按 `db` 标签求和 |
| `yxs_sse_active_connections` | gauge | 抓取时点在途 SSE 数；峰值进 `sseActivePeak` |
| `yxs_sse_first_token_seconds` | histogram | 服务端侧首 token 分位数复核 |
| `yxs_login_total` | counter | 登录成功/失败计数 |
| `yxs_process_start_time_seconds` | gauge | 对比前后值，检测跑测期间服务端是否重启 |

- **busy 计数**：`yxs_sqlite_busy_total` 按 `db` 标签汇总求和；增量为负（counter 重置，对应进程重启）时报告标 `counter-reset` 并以结束值为准，不做负增长汇总。
- **直方图核对**：对 `yxs_http_request_duration_seconds_bucket` 与 `yxs_sse_first_token_seconds_bucket` 收集 `le` 标签集合，与冻结 §9.2 的 12 个桶（`0.05 0.1 0.25 0.5 1 2 3 5 8 13 20 30`）逐一比对；缺失桶在 `metricsScrape.missingBuckets` 列出。
- **缺失指标处理**：抓取后 10 个名字任一未出现，写入 `metricsScrape.missing`，该轮 verdict 标 `incomplete`，不把空样本算成 0 分位数（避免假绿，见 01 §7 R5）。
- **鉴权**：`/metrics` 可被 `YXS_METRICS_TOKEN` 保护（冻结 §2）；配置了该变量（或 `--metrics-token`）时抓取请求带 `Authorization: Bearer <token>`，401 按 §6 降级处理。

服务端直方图由 Prometheus `histogram_quantile` 口径计算，不用平均值代替分位数 [R6]；F 侧客户端采样分位数与服务端直方图并列，不互相覆盖。

### 3.6 每学生 tokens / turns 汇总

`src/summarize.mjs` 按 `studentId` 聚合，字段与契约 §3.2.4 对齐：

| 字段 | 来源 | 口径 |
|---|---|---|
| `turns` | 客户端样本：每完成一条 SSE `done` 记 1 轮；与 `agent.turns` 回读条数交叉核对 | 回读不一致时记 warning，不串号 |
| `asks` / `answers` / `submissions` | 客户端样本：`chat/stream` 次数、`answer` 成功次数、`answer-set` 成功次数 | 按步骤计数 |
| `tokensPrompt` | `/metrics` 的 `yxs_tokens_total{student_id,kind="prompt"}` 增量 | 按学生汇总；usage 事件仅作交叉核对 |
| `tokensCompletion` | `/metrics` 的 `yxs_tokens_total{student_id,kind="completion"}` 增量 | 同上 |
| `tokensTotal` | `tokensPrompt + tokensCompletion` | 对账恒等式 |
| `rpcCalls` / `rpcErrors` | 该学生全部调用与失败调用 | 口径同 §3.4 |
| `cancelled` / `timeouts` | 主动取消轮次 / 超时轮次 | 单列 |
| `firstTokenMs` / `latencyMs` | 该学生各次 SSE 首 token 与 HTTP/RPC 延迟样本数组 | 供明细复核 |

口径边界：`packages/agent/src/tool-loop.ts:136-145` 的 `AgentLoopResult` 只有 `text/rounds/called/calls/context`，**没有 token 字段**；`LoopContextStats`（`packages/agent/src/tool-loop.ts:147-154`）只统计字符数。因此 tokens 不能从 loop 结果或字符数折算，必须回 `/metrics`；字符量只作辅助字段，禁止用字符数冒充 token 数。流末 `usage` 事件（对照 `apps/desktop/src/main/llm.ts:146-147` 的 `yield { type:'usage', usage }`）用于与指标增量对账，不一致时以服务端指标为准，偏差过大时在报告 `warnings` 里登记。

### 3.7 分位数算法

客户端采样的延迟序列（RPC 耗时、SSE 首 token、整轮耗时）在 `src/summarize.mjs` 内按**最近秩法**（契约 §3.3.1 写死，不做线性插值）计算：

```text
quantile(sortedAsc, p):
  n = sorted.length
  if n === 0: return null
  rank = ceil(p * n)          # 最近秩；rank 夹到 [1, n]
  return sortedAsc[rank - 1]
```

- 每个分位数对象附 `sampleCount`、`avg`、`min`、`max`、`unit="ms"`；空数组时分位数 `null`、`sampleCount=0`。
- 样本数低于 30 时分位数照常计算，但 `verdicts` 对应项标 `low-sample`，不参与红绿判定（契约 §3.3.1 第 4 条）。
- 报告字段：`summary.latency.{p50,p95,p99,avg,min,max,sampleCount,unit}`、`summary.firstToken` 同构；`avg` 仅作参考列，判定一律看分位数 [R6]。
- 服务端侧分位数从 `/metrics` 直方图复算时走 `histogram_quantile` + `rate`，单位秒，报告展示换算并标注来源；分位精度受桶边界限制，在 `caveats` 注明。
- 延迟直方图与高动态范围分位数的经典做法可参考 HdrHistogram 的计数桶思路，但 F 样本量上限为 `students × 场景步数`（百量级），直接保留全量样本数组排序即可，不实现对数桶编码 [R11]。

### 3.8 报告生成

`src/report.mjs` 只渲染不改数：先由 `summarize.mjs` 产出一份 `ReportData`，再分别渲染 Markdown 与 JSON，两者数字同源。字段名与契约 §3.2 逐节对齐：

```text
ReportData {
  meta: { runId, startedAt, endedAt, durationMs, toolVersion,
          target: {type, baseUrl, port}, llmMode,
          config: {students, rampUpSec, iterations, scenario, tokenQuota},
          caveats: string[], serverRestarted? }
  summary: {
    requestsTotal, requestsOk, requestsFailed, errorRate,
    statusBreakdown: {http2xx, http4xx, http5xx, businessError, sseError, cancelled, timeout, networkAbort},
    latency: Quantile, firstToken: Quantile,
    sseActivePeak, sqliteBusyTotal,
    tokens: {prompt, completion, total, mode},
    turnsTotal
  }
  perStudent: PerStudent[]
  errors: Sample[]          // 仅失败样本，含 requestId 与分类
  metricsScrape: { scrapedAt, endpoint, present, missing, counters, rawSnapshotPath }
  alerts: { rules: AlertRule[] }
  verdicts: { overall, items }
  warnings: string[]
}
```

- **JSON**：全量字段落盘，供脚本与 E 轮二次消费；时间用 ISO-8601 UTC，延迟单位 ms，token 为整数计数；允许新增可选字段，消费方必须容忍未知字段。
- **Markdown**：骨架按契约 §3.5 八节（概览 / 结论 / 延迟分位数 / 错误率 / 每学生明细 / 指标快照 / 规则演练 / 口径失真）；md 中出现的 P95、错误率、busy 次数必须与 json 同名字段相等，不允许 md 手写估算值。
- **落盘路径**：默认 `.scratch/run/F/report/<时间戳>/`，含 `loadtest-report.md`、`loadtest-report.json`、`metrics-before.txt`、`metrics-after.txt`（两次 `/metrics` 原始快照）、`sse/<requestId>.txt`（失败样本原始帧）、`run.log`。
- 结构化事件落盘、每请求一行可追溯的思路与 12-Factor 日志观一致 [R7]；报告不记录 token、口令与消息正文。

### 3.9 `alerts.yml` 五条规则逐条口径

规则文件 `prometheus/alerts.yml` 用 Prometheus 原生规则格式，顶层 `groups:` 一条组 `name: yxs-server`；字段只用 `expr`/`for`/`labels`/`annotations`，不自创字段名 [R5]；告警只报症状、用 `for` 抑制抖动，不做因果推断 [R4]。规则名、表达式要点、`for`、级别逐字对齐契约 §3.4.1 与冻结 §9.3。

**规则 1：`YxsHttp5xxRate`（5xx 率，page）**

- `expr`：`sum(rate(yxs_http_requests_total{status=~"5.."}[5m])) / sum(rate(yxs_http_requests_total[5m])) > 0.01`
- `for`：`5m`
- `labels`：`severity: page`、`job: yxs-server`
- `annotations`：`summary: "5xx 错误率超过 1%（持续 5 分钟）。"`；`description: "分子按 status=~\"5..\" 筛 5xx 再 rate[5m]，分母为全量 rate[5m]；当前 5xx 计数见 yxs_http_requests_total。"`

**规则 2：`YxsHttpP95Latency`（P95 延迟，warn）**

- `expr`：`histogram_quantile(0.95, sum by (le)(rate(yxs_http_request_duration_seconds_bucket[10m]))) > 3`
- `for`：`10m`
- `labels`：`severity: warn`、`job: yxs-server`
- `annotations`：`summary: "HTTP P95 延迟超过 3 秒（持续 10 分钟）。"`；`description: "P95 来自 yxs_http_request_duration_seconds 直方图，按 method/route 标签拆分定位慢路由；不用 avg 代替分位数。"`

**规则 3：`YxsTokenUsageHigh`（token 用量 80%，warn）—— 含冻结缺口处理**

> 缺口事实：冻结 §9.3 第 3 条原表达式 `yxs_tokens_total{kind="prompt"} / yxs_token_quota > 0.8` 用到 `yxs_token_quota`，但 §9.2 的 10 个指标清单里没有这个指标；它不是既有指标，不能当作已存在来断言（契约 §4.3）。

- `expr`（F 侧替代口径）：`sum by (student_id)(yxs_tokens_total{kind="prompt"}) > 160000`
- `for`：`15m`
- `labels`：`severity: warn`、`job: yxs-server`、`quota: "200000"`、`pending: "token-quota-gauge"`
- `annotations`：`summary: "学生 {{ $labels.student_id }} 的 prompt token 用量达到配额阈值。"`；`description: "替代 yxs_token_quota 口径：与固定常量配额比较（80% × 200000 = 160000）；待服务端补齐 quota gauge 后恢复冻结原表达式。"`
- 规则文件顶部注释保留冻结原表达式与缺口说明；`200000` 这一固定配额来自 `--token-quota`（契约 §2.1，默认 200000），是 F 侧替代常量，不是服务端既有口径；补齐 gauge 后按冻结 §12 变更规则恢复。

**规则 4：`YxsSqliteBusySpike`（`SQLITE_BUSY` 增速，warn）**

- `expr`：`increase(yxs_sqlite_busy_total[5m]) > 5`
- `for`：`5m`
- `labels`：`severity: warn`、`job: yxs-server`
- `annotations`：`summary: "5 分钟内 SQLITE_BUSY 超过 5 次。"`；`description: "5 分钟增量 {{ $value }}，涉及 db 标签见 yxs_sqlite_busy_total；检查 WAL 模式、busy_timeout 与并发写路径。"`

**规则 5：`YxsServerDown`（服务不健康，page）**

- `expr`：`up{job="yxs-server"} == 0`
- `for`：`1m`
- `labels`：`severity: page`、`job: yxs-server`
- `annotations`：`summary: "服务端目标失联超过 1 分钟。"`；`description: "up 指标为 0：服务端进程退出或抓取链路中断，先查进程与端口 18080 及最后一次 /health 状态。"`

`up` 是 Prometheus 抓取层标准指标，不属于 §9.2 的 10 个 `yxs_*` 清单；规则自检只核对 `yxs_*` 名字是否在清单内。规则引擎对 `rate`/`increase`/`histogram_quantile`/`sum by` 的支持范围参照 Prometheus 主仓库口径 [R12]。

## 4 数据读写

F 是压测与观测工具，**不直连、不写业务库**；对被测系统只发 HTTP 请求，对本机只写自己的临时报告目录。

| 读（经 HTTP / 文本） | 写（本机临时目录） | 说明 |
|---|---|---|
| `GET /health`、`GET /api/v1/health` | — | 开跑前预检；章节为 0 时报告带 warning（对照 `apps/desktop/src/main/health.ts:23-35` 的自检口径） |
| `GET /metrics`（可选 Bearer） | `.scratch/run/F/report/<ts>/metrics-before.txt`、`metrics-after.txt` | 原始快照落盘供复盘；F 不修改任何指标 |
| `/api/v1/auth/login`、`/rpc`、`/chat/stream`、`/answer`、`/answer-set`、`/chat/cancel` | 样本与失败帧落 `.scratch/run/F/report/<ts>/` | 业务库由服务端自己写；F 不打开 `learning.db` / `auth.db` 文件句柄 |
| 冻结 §5 方法表、§9.2 指标清单 | — | 作为核对基线，不读 A 的源码产物 |
| — | `.scratch/run/F/run.log` | 每请求一行 JSON（时间、VU、场景、分类、耗时、requestId），不含 token / 口令 / 消息正文 |

隔离口径：临时 home 为 `.scratch/run/F/home/`（被测实例的 `LEARNING_AGENT_HOME`，由启动服务端的一方使用，F 只在报告 `meta.config.home` 记录该路径）；**禁止**读写真实数据目录（`%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent`）。F 自己不落任何 SQLite 文件；stub 目标全内存，退出即清空。落盘的报告与运行日志按事件流组织、每行可追溯，不引入集中日志服务 [R7]。

WAL 与 `busy_timeout` 是服务端/数据层配置（`packages/db/src/index.ts:833-834` 现有 `journal_mode=WAL`、`busy_timeout=5000`），F 只观察 `yxs_sqlite_busy_total` 现象，不替服务端调参数。

## 5 配置

配置分 CLI 参数与环境变量两类；启动期一次读完冻结，运行期不再重读 `process.env`。命令行参数优先于 `config/loadtest.example.json` 同名配置（契约 §2.1）。配置从环境与命令行进入、不在代码里写第二份默认值表，符合 12-Factor 配置观 [R7]。

### 5.1 CLI 参数（`scenario.mjs`）

| 参数 | 默认 | 作用 | 取值 / 校验 |
|---|---|---|---|
| `--target <stub\|http>` | `stub` | `stub` 内置内存桩；`http` 连 `--base-url` 指向的实例 | 仅两值；非法值 → 基础设施失败退出码 1 |
| `--base-url <url>` | `http://127.0.0.1:18080` | 被测服务端根地址；路径前缀固定 `/api/v1` | 必须带 `http://` 或 `https://`；尾斜杠归一；端口被占按 +100 退避并写进报告 |
| `--students <n>`（并发数口径） | `40` | 并发 VU 数；验收跑 40 与 60 两档 | 1..200 整数；越界 → 退出码 1 |
| `--ramp-up <seconds>` | `5` | 从 0 到 `--students` 的爬坡时长；0 表示一次性拉起 | 0..300 数字 |
| `--iterations <n>` | `1` | 每个学生重复完整场景的轮次 | 1..20 整数 |
| `--scenario <full\|login\|ask\|answer\|submit>` | `full` | 场景裁剪；`full` = 登录→提问→出题→交卷→回读 | 五值之一 |
| `--llm <mock\|real>` | `mock` | 仅记录到报告 `meta.llmMode`；真实模型调用由被测服务端按 `YXS_LLM` 决定，F 不直接调模型 | 两值之一 |
| `--home <dir>` | `.scratch/run/F/home` | stub/被测实例的 `LEARNING_AGENT_HOME` | 必须在仓库 `.scratch/run/F/` 下；指向真实数据目录 → 退出码 1 |
| `--out <dir>`（报告目录口径） | `.scratch/run/F/report` | md/json 报告与原始 `/metrics` 快照落点 | 自动创建；禁止指向真实数据目录 |
| `--token-quota <n>` | `200000` | 替代 `yxs_token_quota` 的固定常量配额，仅用于第 3 条告警 F 侧口径 | 1..10_000_000 整数 |
| `--metrics-token <token>` | 空 | 对应 `YXS_METRICS_TOKEN`；为空则不带鉴权头抓 `/metrics` | — |
| `--config <file>` | `config/loadtest.example.json` | 补充配置文件路径；CLI 覆盖文件 | 解析失败 → 退出码 1 |

### 5.2 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `YXS_LLM` | `mock` | 被测实例的 LLM 模式；F 读取后写入报告 `meta.llmMode` 做分栏，不替服务端改模式 |
| `YXS_METRICS_TOKEN` | 空（不校验） | 非空时 `/metrics` 请求带 `Authorization: Bearer <token>`；与 `--metrics-token` 一致，须和被测实例相同 |
| `DEEPSEEK_API_KEY` | — | `--llm real` 时必填；mock 模式忽略 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | real 模式旁证；对照 `apps/desktop/src/main/llm.ts:84-87` 的端点拼接口径 |
| `YXS_SSE_TIMEOUT_MS` | `60000` | SSE 等待终态超时，对齐冻结 §2 的 60s 空闲断开 |

## 6 失败处理

失败分「基础设施失败」（进程退出码 1，给可操作中文提示，不写 verdict）与「样本级失败」（记入报告错误分类，汇总后按 verdict 对应退出码 2 / 3）。退出码与 `verdicts.overall` 对应：`green→0`、`red→2`、`incomplete→3`、基础设施失败→1（契约 §4.2）。所有对外信息只放中文一句话与分类码，内部堆栈进 `run.log`，不进报告正文 [R7]。

| 失败场景 | 判定 | 退出码 | 中文信息（用户看到） | 是否重试 |
|---|---|---|---|---|
| 服务端没起 | 预检 `/health` 抛 `ECONNREFUSED` / `ETIMEDOUT` / 连接重置 | 1（基础设施失败） | `被测服务不可达（<base-url>）：请先启动 apps/server（YXS_LLM=mock，端口 18080），或用 --target stub 跑自洽演练。` | 否；F 不自动起服务端 |
| real 模式缺 Key | `--llm real` 且 `DEEPSEEK_API_KEY` 为空 | 1（基础设施失败，前置拦截） | `real 模式缺少 DEEPSEEK_API_KEY：请配置环境变量后再加跑，或改回 --llm mock。` | 否 |
| 登录批量失败 | 登录响应 401 / 信封 `AUTH_FAILED`；失败学生超阈值 | 该学生样本记 `http4xx`；批量失败按基础设施失败退出 1 | `登录失败（<studentId>）：学号或口令不对，请检查隔离 home 中的测试学生是否已建好。` | 单 VU 不重登；前置批量失败后其余 VU 标 `blocked`，不计入请求分母 |
| SSE 中途断开 | reader 结束未收到 `done`；或收到 `error` 帧 | 样本级：记 `sseError` / `timeout`；整轮 SSE 全断 → 报告 `red` 或 `incomplete`，退出 2 / 3 | `SSE 连接中途断开（requestId=<…>）：未收到 done；原始帧见 <report>/sse/<…>.txt。` | 否；不补帧、不自动重连 |
| `/metrics` 401 | 指标抓取返回 401 | 1（基础设施失败；指标节标 `unauthorized`） | `/metrics 返回 401：请设置 YXS_METRICS_TOKEN（或 --metrics-token）与被测服务一致；指标快照缺失，报告 metrics 节标 incomplete。` | 否 |
| `/metrics` 缺指标 / 缺桶 | 10 指标名或 12 桶比对不全 | 3（verdict=`incomplete`） | `/metrics 未暴露全部冻结指标：缺失 <清单>；本轮延迟与 busy 结论待指标齐备后重跑。` | 否 |
| CLI 参数非法 | 枚举 / 路径 / 数值校验不过；`--home` 指向真实数据目录 | 1（基础设施失败） | `参数 <name> 非法：<取值说明>。` | 否 |
| 被测实例 5xx / 上游失败 | 信封 `INTERNAL/UPSTREAM_FAILED/TIMEOUT` | 样本级失败；汇总后至少一条规则 `red` → 退出 2 | 透传冻结 §4.2 中文消息；报告记录 `code` 与 `requestId` | 否；压测不做业务重试，避免把重试压力叠加进基线 |
| 取消路径 | 主动 cancel 后收到 `CANCELLED` | 样本记 `cancelled`，不计失败分子 | — | 否 |
| 报告写盘失败 | `--out` 目录不可写 / 磁盘满 | 1（基础设施失败） | `报告写入失败（<out>）：请检查 .scratch/run/F 目录权限与磁盘空间。` | 否 |

错误码与中文消息口径对照冻结 §4.2，F 不自创同义码。

## 7 性能与资源

本轮不预设 QPS / P95 / token 总量的实测目标值；阈值只引用冻结 §9.3（5xx 率 >1%、P95 >3s、busy 5 分钟增量 >5、token 80%、`up==0` 持续 1m），实测数字一律「待实测 + 测量方法」，不在文档里编造基线。

### 7.1 压测机自身资源占用

| 项 | 采集方式 | 口径 |
|---|---|---|
| 进程 RSS | 起止两次 `process.memoryUsage().rss` 差值与峰值，记入 `meta.client.rssMb`（可选字段） | 60 路 SSE 在途时不应持续增长；样本与帧只保留当前轮次，失败帧才落盘 |
| CPU | `process.cpuUsage()` 用户/系统时间差值，记入 `meta.client.cpuSec`（可选字段） | 与 wall-clock 对比，判断压测机是否成为瓶颈 |
| 在途连接 | 客户端自管的 VU / SSE 计数，周期记录峰值，对照 `yxs_sse_active_connections` | 峰值进 `summary.sseActivePeak` |
| 磁盘 | 报告目录大小 | 原始帧只对失败样本落盘；成功流不保留全量文本 |

### 7.2 不把压测机瓶颈算进服务端 P95 的判别方法

延迟样本分两段计时，避免客户端排队、连接建立或本机调度被记成服务端处理耗时：

1. **客户端排队时间**：VU 从被调度到真正调用 `fetch` 的等待；worker 池空闲即派发，排队过长说明并发额度打满客户端自身。
2. **网络 + 服务端处理**：`fetch` 派发到响应首字节 / `done` 的耗时（客户端观测口径）。
3. **服务端内部口径**：`/metrics` 的 `yxs_http_request_duration_seconds` 直方图复算 P95/P99。

判别规则（写入报告 `meta.caveats` 与排查表）：

- 客户端观测 P95 与服务端直方图 P95 差距在回环调度误差内（量级为几十毫秒）→ 延迟归服务端口径。
- 客户端 P95 显著高于服务端 P95，且压测机 CPU 接近饱和、RSS 持续上涨、排队时间变长 → 判定为**压测机瓶颈**，该轮服务端 P95 结论标 `client-bound`，不得作为服务端性能依据。
- 本机回环无网络往返，首 token 延迟只用于回归对比，不代表局域网 / 公网首字节时间（01 §7 R3）。

轻量压测工具记录 QPS 与延迟直方图的做法可参照 fortio 的统计维度 [R10]；分位数不被平均值抹平这一原则来自直方图实践 [R6]。

## 8 实施顺序

每步都有可独立验证的产出，顺序按「先自洽替身、再接真目标、最后补规则与报告」排；小步可回退、每步带验证点的拆分方式参照测试代码分层实践 [R14]。

1. **包骨架**：`package.json`、`scenario.mjs` 空壳、`config/loadtest.example.json`。验证：`pnpm install --ignore-workspace` 完成且根 `pnpm-lock.yaml` 无变更；`node scenario.mjs --help` 打印参数表。
2. **HTTP 客户端与信封解包**：`src/client.mjs` 实现 health / login / RPC，带起止计时与 §3.4 分类。验证：对 stub 跑通 `student.current`，样本字段齐全。
3. **SSE 读取与首 token 计时**：帧解析、`session→text→done` 顺序、首 token 起止口径落地。验证：stub 流的 `firstTokenMs` 有值且 >0；缺 `done` 时样本归类 `sseError`。
4. **VU 编排与并发调度**：`src/scenario.mjs` 实现登录复用、单学生会话复用、VU 池、ramp-up、硬截止收尾。验证：`--target stub --students 40` 与 `--students 60` 各跑完一轮，`perStudent` 条数等于并发数。
5. **指标抓取与解析**：`src/metrics.mjs` 解析 10 指标名、12 桶、busy 增量、token 按学生汇总；缺失清单落地。验证：stub `/metrics` 全绿；人为删一个桶名时 `missingBuckets` 出现该项。
6. **汇总与分位数**：`src/summarize.mjs` 实现最近秩法分位数、错误率、每学生聚合、低样本标记。验证：json 样本条数与 `sampleCount` 一致；已知固定延迟序列的 P50/P95/P99 手算对得上最近秩结果。
7. **双格式报告**：`src/report.mjs` 生成 md + json。验证：md 的 P95、错误率、busy 次数与 json 同名字段相等；失败样本原始帧落 `sse/` 目录。
8. **告警规则与自检收尾**：`prometheus/alerts.yml` 五条规则 + `scripts/check-alerts.mjs` 核对规则名、字段、指标清单；本机无 `promtool` 时以自检脚本兜底，有 `promtool` 时跑 `promtool check rules`。验证：5 条规则齐全；清单外指标只出现在规则 3 的缺口注释里；README 跑法与参数表与本文 §5 一致。

## 参考

- [R1] k6 文档 — https://grafana.com/docs/k6/latest/ — 支撑 §1 VU 模型与 §3.2 并发档位 / ramp-up 概念 — 借鉴「场景 = VU 脚本 + 阈值」；不引入 k6 运行时。
- [R2] Gatling — https://github.com/gatling/gatling — 支撑 §1 报告结构与 §3.7 分位数报告维度 — 借鉴 P50/P95/P99 + 每用户明细；不引入 Scala 栈。
- [R3] alexfernandez/loadtest — https://github.com/alexfernandez/loadtest — 支撑 §1 模块分层、§2.1 独立包取舍与 §3.2 轻量并发模型 — 借鉴并发数 + 逐请求统计；不照搬其 CLI。
- [R4] Prometheus 告警实践 — https://prometheus.io/docs/practices/alerting/ — 支撑 §3.9 症状告警与 `for` 抑抖 — 采用「报症状 + 持续时间」；不做因果推断类告警。
- [R5] Prometheus 告警规则语法 — https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/ — 支撑 §3.9 规则字段合法性 — 直接采用 `expr`/`for`/`labels`/`annotations`，不自创字段名。
- [R6] Prometheus 直方图与分位数 — https://prometheus.io/docs/practices/histograms/ — 支撑 §3.5、§3.7、§7.2 的分位数口径 — 采用直方图与排序分位数；禁止用平均值代替 P95/P99。
- [R7] 12-Factor · Logs — https://12factor.net/logs — 支撑 §3.8 证据落盘、§4 隔离落盘、§5 配置观与 §6 日志口径 — 采用事件流落盘；不引入日志聚合服务。
- [R8] Server-Sent Events（WHATWG 规范） — https://html.spec.whatwg.org/multipage/server-sent-events.html — 支撑 §3.3 帧格式与 `id`/`event`/`data` 解析 — 采用帧格式；不实现自动重连与 Last-Event-ID 重放。
- [R9] MDN · Using server-sent events — https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events — 支撑 §3.3 心跳注释行与代理缓冲注意点 — 采用注释行跳过；不做 polyfill。
- [R10] fortio — https://github.com/fortio/fortio — 支撑 §7.1 QPS 与延迟直方图统计维度 — 借鉴「记录延迟分布而非只记平均」；不引入其 Go 运行时。
- [R11] HdrHistogram — https://github.com/HdrHistogram/HdrHistogram — 支撑 §3.7 分位数高动态范围直方图思路 — 借鉴计数桶思想；样本量百量级，F 直接数组排序，不实现对数编码。
- [R12] Prometheus 主仓库 — https://github.com/prometheus/prometheus — 支撑 §3.5/§3.9 对 `rate`/`increase`/`histogram_quantile`/`sum by` 支持范围的口径 — 参照规则引擎能力；不在 F 侧部署 Prometheus 服务。
- [R13] JSON-RPC 2.0 规范 — https://www.jsonrpc.org/specification — 支撑 §3.1 RPC 信封解包 — 借鉴 `method/params/error`；不做 batch 与 notification。
- [R14] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §8 小步拆分与可执行验证点 — 采用可机器判定的验证；不引入其全部工具链。
