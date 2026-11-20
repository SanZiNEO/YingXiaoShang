# tools/loadtest — F 轮压测工具使用说明

面向要在本机跑压测的人：怎么起、参数怎么填、报告在哪看、哪些数字能下结论、哪些只是工具链自检。口径来源为 `plans/server-client-split/F-loadtest-observability/02-contract.md` 与 `03-implementation.md`，字段名与 CLI 参数名以本目录代码为准。

## 1 这是什么

本工具是 F 轮（压测 + 可观测性）的独立压测 CLI：模拟 40–60 个并发虚拟学生（VU），按「登录 → 提问（SSE）→ 出题 → 作答 → 交卷 → 回读」跑完完整场景，从客户端采样与服务端 `/metrics` 两侧汇总，产出 Markdown + JSON 压测报告与 5 条 Prometheus 告警规则演练结果。对被测系统只发 HTTP/SSE 请求，不直连业务库、不打开 SQLite 文件句柄，不改服务端一行代码。

- **两个目标**：`--target stub` 用内置全内存桩（退出即清空，自洽演练）；`--target http` 连 `--base-url` 指向的本机实例。
- **产出**：`loadtest-report.md`（人读）、`loadtest-report.json`（脚本消费）、两份 `/metrics` 原始快照、失败样本 SSE 原始帧、`run.log`，以及 `prometheus/alerts.yml` 五条规则。

## 2 运行环境与依赖

Node v22（本机已核实 v22.23.2），ESM 纯 `.mjs`，无编译步骤。`package.json` 的 `dependencies` 与 `devDependencies` 均为空：**零第三方依赖，无需 `pnpm install`**，不新增根依赖；HTTP/SSE 只用全局 `fetch` 与 Web Streams，其余为 `node:fs` / `node:path` / `node:process` / `node:crypto` 等内置模块，`node tools\loadtest\scenario.mjs ...` 直接执行。

## 3 怎么跑

以下命令均在仓库根目录 `<仓库根>` 下，PowerShell 可直接粘贴：

```powershell
# 40 学生 stub 自洽演练；默认报告落到 .scratch\run\F\report\<时间戳>\
node tools\loadtest\scenario.mjs --target stub --students 40

# 60 学生，显式指定报告目录（目录为空时直接用；已有报告则另起时间戳子目录）
node tools\loadtest\scenario.mjs --target stub --students 60 --out .scratch\run\F\report\60

# 告警规则兜底自检（结构 / 字段 / 指标清单 / 冻结阈值）
node tools\loadtest\scripts\check-alerts.mjs

# 工具链自测：FT-01…FT-12 契约断言 + M1–M5 反向变异
node tools\loadtest\scripts\selftest.mjs
```

连真机实例时把 `--target stub` 换成 `--target http --base-url http://127.0.0.1:18080`。预检 `/api/v1/health` 不过、`/metrics` 抓不到或参数非法时，进程直接以退出码 1 失败，不产生红绿判定。

## 4 CLI 参数

参数名与 `scenario.mjs` 实际解析集合逐字一致；覆盖顺序：内置默认值 < `--config` 同名项 < 命令行；`--help` / `-h` 打印参数表后退出码 0。

### 4.1 参数表

| 参数 | 默认 | 取值 / 校验 | 含义 |
|---|---|---|---|
| `--target <stub\|http>` | `stub` | `stub` / `http`；非法值 → 退出码 1 | `stub` = 内置内存桩；`http` = 连 `--base-url` 指向的实例 |
| `--base-url <url>` | `http://127.0.0.1:18080` | 必须以 `http://` 或 `https://` 开头；尾斜杠归一 | 被测服务端根地址 |
| `--students <n>` | `40` | 1..200 整数 | 并发虚拟学生数（VU）；本轮验收档位 40 与 60 |
| `--ramp-up <seconds>` | `5` | 0..300 数字 | 从 0 爬到 `--students` 的时长；0 表示一次性全部拉起 |
| `--iterations <n>` | `1` | 1..20 整数 | 每个学生重复完整场景的轮次 |
| `--scenario <full\|login\|ask\|answer\|submit>` | `full` | 五值之一 | 场景裁剪；`full` = 登录→提问→出题→作答→交卷→回读，其余为单步调试场景 |
| `--llm <mock\|real>` | 空（读 `YXS_LLM`，再退 `mock`） | `mock` / `real` | 仅记录到 `meta.llmMode` 分栏；F 不直接调模型，真实模型调用由被测服务端按其 `YXS_LLM` 决定 |
| `--home <dir>` | `.scratch/run/F/home` | 必须在 `.scratch/run/F/` 下；指向真实数据目录 → 退出码 1 | stub / 被测实例的 `LEARNING_AGENT_HOME` |
| `--out <dir>` | `.scratch/run/F/report` | 同 `--home` 目录约束；目录自动创建 | md/json 报告与原始 `/metrics` 快照落点 |
| `--token-quota <n>` | `200000` | 1..10000000 整数 | 替代 `yxs_token_quota` 的固定常量配额，仅用于第 3 条告警的 F 侧替代口径 |
| `--metrics-token <token>` | 空 | 字符串 | 抓 `/metrics` 用的 Bearer（与被测端 `YXS_METRICS_TOKEN` 一致）；为空则不带鉴权头 |
| `--config <file>` | `tools/loadtest/config/loadtest.example.json` | 仓库内 JSON；未显式传且文件不存在则按空配置；非法 JSON / 读取失败 → 退出码 1 | 补充配置文件；CLI 同名项覆盖文件 |
| `--stub-mutations <csv>` | 空 | 仅 `M1` / `M2` / `M3` / `M4`，逗号分隔；**仅 `--target stub` 生效** | 自检 / 反向验证专用变异开关，见 §4.2 |
| `--client-ips <distinct\|shared>` | `distinct` | 二值之一 | 登录限流适配：`distinct` = 每个 VU 独立 `X-Forwarded-For`；`shared` = 全部共用本机 IP（复现限流），见 §4.4 |

### 4.2 `--stub-mutations` 反向变异

| 编号 | 注入行为（映射到 stub mutations） | 验证点 |
|---|---|---|
| `M1` | 首帧延迟 500ms（`firstTokenDelayMs=500`） | 首 token 计时对慢首帧的响应；慢首帧不误判为网络中断 |
| `M2` | 发出 3 帧 text 后不发 `done`（`dropDoneAfterTextFrames=3`） | 流无 `done` 收尾 → 归类 `sseError`，失败帧落 `sse/` 目录 |
| `M3` | 缺 30 秒桶（`missingBuckets=['30']`） | 12 桶核对能列出缺失桶，verdict 不为 green |
| `M4` | 改坏 errors 指标名（`renameErrorsMetric=true`，`yxs_errors_total` → `yxs_error_total`） | 指标清单核对能把改名后的指标列入 `missing` |

第五类反向变异 `M5`（仅 `selftest.mjs` 内部使用，不暴露 CLI）：在内存中把规则 3 表达式改回引用清单外的 `yxs_token_quota` 原式并删除 `pending` 标签，验证 `check-alerts.mjs` 能报出清单外指标与标签缺失；只改内存文本、不落盘，还原后基线复通过。七类 `stub.faults` 故障注入（`http500` / `http400` / `business` / `sseError` / `timeout` / `noDone` / `cancelOk`）由 FT-04 错误分类用例与配置 `stub.faults` 覆盖，不走 `--stub-mutations`。

### 4.3 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `YXS_LLM` | `mock` | 被测实例 LLM 模式；F 读取后写入 `meta.llmMode` 分栏，不替服务端改模式 |
| `YXS_METRICS_TOKEN` | 空（不校验） | `/metrics` 的 Bearer；`--metrics-token` 与配置 `metricsToken` 都未给时取此环境变量 |
| `DEEPSEEK_API_KEY` | — | `--llm real` 时必填；缺失则前置拦截退出码 1，mock 模式忽略 |
| `YXS_SSE_TIMEOUT_MS` / `YXS_LOADTEST_DEADLINE_MS` | 超时 `60000` ms；硬截止 `max(90000, students × iterations × 500)` | SSE 等待终态的空闲超时；整轮硬截止，超时未结束的轮次记 `timeout`，报告照常生成 |

### 4.4 登录限流与 `--client-ips`（对真机跑压测必读）

**约束事实**：冻结契约 §3.1 规定「同一 IP 每分钟 5 次登录尝试」，超出返回 `429 RATE_LIMITED`（`apps/server/src/app.ts:18-19` 的 `LOGIN_LIMIT=5` / `RATE_WINDOW_MS=60s`，按 `clientIp()` 计数）。**这是契约行为，不是服务端缺陷，F 侧不改服务端。**

**为什么必须适配**：F 的全部 VU 默认从 `127.0.0.1` 出，服务端按 IP 计数 → 第 6 个学生起必然 429。不处理的话 `--students 40` 只有 5 个能登录，其余 35 个在第一步就失败，压测结果没有意义。

**选型：`X-Forwarded-For`（默认 `--client-ips distinct`）**。理由：

1. 服务端 `clientIp()` 已读该头（`apps/server/src/app.ts:80-83`，取首段），**无需改服务端一行**；
2. 每个 VU 按学号哈希得到稳定的 `198.18.x.y`（RFC 2544 基准测试网段，不会指向真实主机），同一学生跨轮次 IP 不变，报告可复现；
3. 相比「分批 ≤5 个 + 等 60s」，不引入分钟级等待，40/60 档仍是一次性拉起，与 AC-02/AC-03 的并发口径一致；
4. 相比「在报告里标注受约束」，它真的能跑满并发，而不是把结论降级。

`--client-ips shared` 保留用于**复现**该约束：20 个学生只会有 5 个登录成功、15 个 429，报告 `verdicts` 会出现 `login-rate-limit` 一条 `incomplete` 记录，明确写出「本档实际可登录学生数 = 5/分钟」。

> 注意：`X-Forwarded-For` 只在**受信任的反向代理之后**才有安全意义。本工具仅在隔离压测环境使用；真实部署不要在公网直连时信任该头（服务端已有该行为，属 A 轮口径，F 不改）。

## 5 退出码与 verdict

退出码由报告 `verdicts.overall` 映射；基础设施失败不写 verdict，直接退出 1。

| 退出码 | `verdicts.overall` | 含义 | 触发条件 |
|---|---|---|---|
| `0` | `green` | 通过 | 场景跑完；适用阈值全部 green；无缺失指标；样本量达标 |
| `1` | 不产生 verdict | 基础设施失败 | 参数非法、目标不可达、stub 启动失败、`/metrics` 抓取失败（含 401）、real 缺 Key、报告写盘失败 |
| `2` | `red` | 阈值越线 | 跑完但至少一条适用规则 red |
| `3` | `incomplete` | 无法判定 | 指标缺失、关键样本不足或服务端中途重启；不用估计值凑红绿 |

## 6 报告结构

### 6.1 目录落点与六类产物

默认落点 `<out>/<时间戳>/`（本地秒级 `YYYYMMDD-HHMMSS`）；显式 `--out` 且目录下已有 `loadtest-report.json` 时另起时间戳子目录，避免复跑覆盖证据，目录为空则直接使用该目录。

| 产物 | 说明 |
|---|---|
| `loadtest-report.md` | 人读报告，八节骨架（§6.3）；数字与 JSON 同源，渲染层不改数 |
| `loadtest-report.json` | 全量字段落盘，供脚本与后续轮次消费；时间 ISO-8601 UTC，延迟 ms，token 为整数 |
| `metrics-before.txt` / `metrics-after.txt` | 起始 / 结束两份 `/metrics` 原始快照 |
| `sse/<requestId>.txt` | 失败样本原始 SSE 帧；成功流不保留正文 |
| `run.log` | 每请求一行 JSON：`ts / studentId / iteration / scenario / method / status / code / errorClass / durationMs / firstTokenMs / requestId`；不含 token、口令、正文与 Authorization |

### 6.2 JSON 顶层字段

顶层八个键：`meta`、`summary`、`perStudent`、`errors`、`metricsScrape`、`alerts`、`verdicts`、`warnings`。

**`meta`**

| 字段 | 含义 |
|---|---|
| `runId` / `toolVersion` | 一次压测唯一 ID：`run_` + 12 位 base36；`toolVersion` 为工具包版本（当前 `0.1.0`） |
| `startedAt` / `endedAt` / `durationMs` | 开跑 / 结束时刻 ISO；`durationMs` 为全场景墙钟时长（ms） |
| `target` | `{type, baseUrl, port}`；`port` 为端口退避后的实际端口 |
| `llmMode` | `mock` / `real` |
| `config` | `{students, rampUpSec, iterations, scenario, tokenQuota, home}` |
| `caveats` | 固定口径说明数组（回环失真、mock 固定 usage、stub 不作基线、桶限制、低样本提示） |
| `serverRestarted` / `client` | 对比前后 `yxs_process_start_time_seconds`，变过则 `true`；`client` 为压测机占用 `{rssMbStart, rssMbPeak, cpuSec}` |

**`summary`**

| 字段 | 含义 |
|---|---|
| `requestsTotal` / `requestsOk` | 全部已派发请求数（含失败、超时；不含未派发的 blocked 学生）；`requestsOk` = HTTP 2xx 且信封 `ok:true`，或 SSE 正常收到 `done` |
| `requestsFailed` | 失败分子，口径见 §10 第 5 条 |
| `errorRate` | `requestsFailed / requestsTotal`；分母为 0 时为 `null` |
| `fiveXxRate` | 5xx 率：`http5xx / (http2xx + http4xx + http5xx)`，与 `errorRate` 分列 |
| `statusBreakdown` | `{http2xx, http4xx, http5xx, businessError, sseError, cancelled, timeout, networkAbort}` |
| `latency` | HTTP/RPC 延迟分位数 `{p50, p95, p99, avg, min, max, sampleCount, unit}`，ms；`avg` 仅参考 |
| `firstToken` | SSE 首 token 分位数，字段同 `latency`；无样本时 `sampleCount=0`、分位数 `null` |
| `sseActivePeak` | 运行期间观察到的 SSE 并发连接峰值 |
| `sqliteBusyTotal` | 本轮 `yxs_sqlite_busy_total` 增量（结束 − 起始，按 `db` 汇总） |
| `tokens` / `turnsTotal` | `tokens` 为 `{prompt, completion, total, mode}`（`mode` 同 `meta.llmMode`）；`turnsTotal` 为全部学生收到的 `done` 事件总数 |

**`perStudent[]`**：`{studentId, loginOk, asks, answers, submissions, turns, tokensPrompt, tokensCompletion, tokensTotal, rpcCalls, rpcErrors, cancelled, timeouts, firstTokenMs[], latencyMs[], status}`；`status` 为 `ok` / `partial` / `failed`，`tokensTotal = prompt + completion`。**`errors[]`**：仅失败样本，带 `requestId`、分类码、方法/路由、状态与耗时；明细只记分类码与字段名，不回显凭证与正文。

**`metricsScrape`**

| 字段 | 含义 |
|---|---|
| `scrapedAt` / `endpoint` | 快照时刻 ISO；抓取的 `/metrics` 地址 |
| `present` / `missing` | §7 清单中本次实际出现 / 未出现的指标名；`missing` 非空时整体 verdict 不得为 green。**存在性以 `# TYPE` / `# HELP` 声明行为准**（见 §7.3） |
| `counters` / `rawSnapshotPath` | 按指标名展开的标签→值快照；原始快照落盘相对路径（`metrics-after.txt`） |
| `bucketsOk` / `missingBuckets` / `missingBucketsByHistogram` | 12 有限桶核对结果：**缺桶与多出桶都算不通过**；缺桶按直方图分别列出 |
| `extraBuckets` / `extraBucketsByHistogram` | 清单外（`le` 不在 12 个冻结边界内）的桶，按直方图分别列出；`+Inf` 不算多出 |
| `busyByDb` / `tokenByStudent` | 按 `db` 的 busy 增量；按 `student_id` 的 `{prompt, completion}` 增量 |
| `processStartTime` / `counterReset` | 进程启动时间戳；计数器回退（结束值 < 起始值）标记 |
| `serverLatency` / `firstTokenServer` | 服务端直方图复算 `{p50, p95, p99}`（ms），与客户端采样并列，不互相覆盖 |

**`alerts.rules[]`**：`{name, severity, expr, for, state, value, reason}`；`state` 为 `firing` / `pending` / `inactive` / `unknown`。**`verdicts`**：`{overall, items[]}`，每条 `{rule, threshold, observed, state, note}`；`state` 为 `green` / `red` / `incomplete` / `unknown`。

**`warnings[]`**：固定四条偏差登记（4xx 口径、无 usage 事件、`yxs_token_quota` 缺口、`+Inf` 桶说明），外加每学生回读轮次与本地计数不一致时的差异提示。

### 6.3 Markdown 八节骨架

`loadtest-report.md` 与 JSON 同源生成，骨架固定为八节：

1. **运行概览**：startedAt、endedAt、durationMs、students、scenario、baseUrl、port、llmMode、serverRestarted
2. **总体结论**：overall verdict + 阈值判定表（规则 / 阈值 / 实测 / 状态 / 备注）
3. **延迟分位数**：3.1 HTTP/RPC；3.2 SSE 首 token（注明回环口径）
4. **错误率与状态分布**：errorRate、5xx 率、状态表；4.1 按错误码；4.2 按方法/路由
5. **每学生明细**：学号、状态、asks / answers / submissions / turns、三类 token、rpcErrors、cancelled、timeouts
6. **指标抓取快照**：present / missing、busy、tokens、sseActivePeak、桶核对；6.1 服务端直方图对照
7. **告警规则演练结果**：五条规则的 state、value、reason
8. **口径与失真说明**：8.1 固定 caveats；8.2 已知偏差与缺口

## 7 指标与桶

### 7.1 十个冻结指标（`yxs_*`，逐字）

| 指标名 | 类型 | 标签 | F 侧用途 |
|---|---|---|---|
| `yxs_http_requests_total` | counter | `method`,`route`,`status` | 总请求量、5xx 率、状态分布 |
| `yxs_http_request_duration_seconds` | histogram | `method`,`route` | 服务端侧延迟分位数（与客户端采样并列） |
| `yxs_rpc_requests_total` | counter | `method`,`code` | 按方法错误率旁证 |
| `yxs_tokens_total` | counter | `student_id`,`kind`（`prompt` / `completion`） | 每学生 token 汇总 |
| `yxs_errors_total` | counter | `code` | 错误分类计数旁证 |
| `yxs_sqlite_busy_total` | counter | `db` | `SQLITE_BUSY` 本轮增量 |
| `yxs_sse_active_connections` | gauge | — | SSE 并发连接峰值对照 |
| `yxs_sse_first_token_seconds` | histogram | — | 服务端侧首 token 延迟复核 |
| `yxs_login_total` | counter | `result`（`ok` / `fail`） | 登录成功率 |
| `yxs_process_start_time_seconds` | gauge | — | 检测跑测期间服务端是否重启 |

清单之外的 `yxs_*` 名字一律视为缺口，列入 `metricsScrape.missing`，不映射到既有指标。

### 7.2 十二个有限桶边界（秒）

```text
0.05  0.1  0.25  0.5  1  2  3  5  8  13  20  30
```

两张直方图（`yxs_http_request_duration_seconds`、`yxs_sse_first_token_seconds`）逐一核对这 12 个有限 `le`。**`+Inf` 桶是 Prometheus exposition 的结构性产物，不参与 12 桶核对。** 客户端采样分位数在内存排序，不受这组桶约束；服务端直方图分位精度受桶边界限制。

桶核对是「恰好 12 个」：缺桶进 `missingBuckets`，清单外的 `le` 进 `extraBuckets`，两者任一非空都令 `bucketsOk=false` 且 verdict 标 `incomplete`。只查缺不查多，会让服务端偷偷加宽桶边界的行为蒙混过关。

### 7.3 指标「存在」的判定口径

判定一个冻结指标是否存在，看 exposition 里的 **`# TYPE` / `# HELP` 声明行**，而不是样本行。

原因：`prom-client` 对**带标签且从未 `inc`** 的 counter 只输出 HELP/TYPE 两行，不输出任何样本行。零错误轮次里 `yxs_errors_total` 就是这种形态（实测 A 轮 `createMetrics().render()` 的 8743 字节文本中，`yxs_errors_total` 有 2 行声明、0 行样本）。若按样本行判定，AC-08 在「一切正常」的轮次反而永远不过——这正是修复前的缺陷（`present=9/10`）。

现在的口径：`declaredNames.has(name) || familyNames.has(name)` 即算 present。`yxs_errors_total` 有声明无样本 → present，且 `counters` 里对应项为空对象，报告如实反映「本轮没有错误样本」。

## 8 告警规则

规则文件 `prometheus/alerts.yml` 为 Prometheus 原生规则格式，顶层一条组 `name: yxs-server`；字段只用官方 `expr` / `for` / `labels` / `annotations`，不自创字段名；阈值全部取自冻结口径，F 不自行收紧或放宽。

### 8.1 五条规则

| # | 规则名 | 阈值要点 | `for` | 级别 |
|---|---|---|---|---|
| 1 | `YxsHttp5xxRate` | 5xx 率 > 0.01（1%）：`sum(rate(yxs_http_requests_total{status=~"5.."}[5m])) / sum(rate(yxs_http_requests_total[5m])) > 0.01` | `5m` | `page` |
| 2 | `YxsHttpP95Latency` | 直方图 P95 > 3 秒：`histogram_quantile(0.95, sum by (le)(rate(yxs_http_request_duration_seconds_bucket[10m]))) > 3` | `10m` | `warn` |
| 3 | `YxsTokenUsageHigh` | 最高学生 prompt > 160000（= 0.8 × 200000）：`sum by (student_id)(yxs_tokens_total{kind="prompt"}) > 160000` | `15m` | `warn` |
| 4 | `YxsSqliteBusySpike` | 5 分钟内 BUSY 增量 > 5 次：`increase(yxs_sqlite_busy_total[5m]) > 5` | `5m` | `warn` |
| 5 | `YxsServerDown` | 目标失联：`up{job="yxs-server"} == 0` | `1m` | `page` |

### 8.2 规则 3 的 `yxs_token_quota` 缺口与替代口径

- **缺口事实**：冻结 §9.3 第 3 条原式为 `yxs_tokens_total{kind="prompt"} / yxs_token_quota > 0.8`；但 `yxs_token_quota` 不在冻结 §9.2 的 10 项清单内，仓库现状也不存在该指标。它不是既有指标，活动表达式不能把它当作现存指标引用。
- **F 侧替代口径**：按 `student_id` 汇总 `yxs_tokens_total{kind="prompt"}`，与固定常量配额比较；阈值 `= 0.8 × --token-quota`（默认 `200000` → `160000`）。规则 labels 带 `quota: "200000"` 与 `pending: "token-quota-gauge"`。
- **阈值随 `--token-quota` 走**：`alerts.yml` 里写的是默认口径常量 `160000`；**评估**时由 `summarize.mjs` 的 `alertRulesFor(tokenQuota)` 按本轮实际配额重算（`0.8 × quota`）。改文件阈值需同步 `alerts.yml`，两者只在默认配额下逐字相等（`selftest` FT-06 校验该一致性）。这样 `--token-quota 100` 时 verdict 按 80 判红、告警演练也按 80 判越线，不会出现同一份报告里两个口径打架。
- **原式备查**：冻结原式与缺口说明原样保留在 `alerts.yml` 顶部及规则 3 上方注释中；待 A 轮补齐 `yxs_token_quota` gauge 后，按冻结 §12 变更登记恢复原式（先改冻结清单与版本号并登记，再改 F 的规则）。

## 9 mock 与 real

- **mock**：token 为固定 usage，每轮 prompt 100 / completion 50，与真实模型计费口径不同；`summary.tokens.mode` 记为 `mock`。**real**：需要 `DEEPSEEK_API_KEY`，缺 Key 在开跑前前置拦截退出码 1；真实模型调用由被测服务端发起，F 只汇总 `/metrics` 上的 token 增量，调用失败按错误分类计入错误率。
- **两档不合并平均**：mock 与 real 的 token 汇总各自带 `mode` 字段，不跨档合并出平均值。

## 10 已知失真与偏差

以下条目如实登记，不复用 stub 数字为服务端结论：

1. **首 token 测自本机回环**：起点为 `fetch` 派发前一刻，终点为首条非空 `text` 帧；本机回环无网络往返，只用于回归对比，不代表局域网 / 公网真实首字节时间。
2. **stub 数字只验证工具链**：stub 无数据库与真实模型，其延迟与 `SQLITE_BUSY` 数字不作为服务端性能基线；stub 的 busy 计数恒为 0，不伪造 BUSY 样本。
3. **直方图分位受桶限制**：服务端分位数由 12 个桶边界复算，桶间真实分布不可还原；报告中服务端 P95/P99 均标注桶边界受限。
4. **低样本不参与红绿**：客户端分位数为内存样本最近秩法，样本数 < 30 时标 `low-sample`，照常计算但不参与红绿判定。
5. **4xx 单列口径**：4xx 一律归入 `http4xx` 单列、不进失败分子；`businessError` 仅指 HTTP 200 且信封 `ok:false`。与 `02-contract.md` §4.1 表格「4xx 同时单列」的表述冲突处，已按 AC-05 定案为上述口径，并登记在报告 `warnings`。
6. **无 usage 事件交叉核对**：冻结 SSE 事件集（`session` / `round` / `text` / `tool` / `tool-end` / `done` / `error`）不含 `usage` 事件，本轮不做流末 usage 与指标的交叉核对，token 一律取 `/metrics`。
7. **promtool 未执行**：本机无 `promtool`，`promtool check rules` 未运行（skipped）；告警规则由 `scripts/check-alerts.mjs` 兜底校验结构、必填字段、指标清单与冻结阈值。
8. **真机 http 档已实跑（10 学生）**：`--target http --students 10` 于 2026-11-20 对 `apps/server`（`YXS_LLM=mock` + `YXS_MOCK_SCRIPT=tools`，端口 18080）跑通：70 请求全 2xx、10 名学生全部 `ok`、作答 20 次、交卷 10 次。注意 `YXS_MOCK_SCRIPT=tools` 是**前提**——不设它 mock 模型不会产出题目集，`done.artifacts` 为空，作答/交卷无样本可打。40/60 档真机仍未实跑（本机只种了 10 个测试学生，且登录限流约束下需逐批补种）。
9. **`--home` 只约束本工具的隔离目录**：它写进 `process.env.LEARNING_AGENT_HOME` 并传给内置 stub（`/health` 的 `appHome` 回显该值）；对 `--target http` 的被测实例**不会**改其 home，被测实例的 `LEARNING_AGENT_HOME` 必须在启动它之前设好。

## 11 自检与验收命令

在仓库根目录执行：

```powershell
# 工具链自测：FT-01…FT-12 契约断言 + M1–M5 反向变异
node tools\loadtest\scripts\selftest.mjs

# 告警规则兜底自检：5 条齐全、字段存在、yxs_* 指标在清单内、for/severity/阈值与冻结一致
node tools\loadtest\scripts\check-alerts.mjs

# 文档口径一致性检查（按轮次过滤）
python plans\server-client-split\00-master\check-docs.py --round F
```

`selftest.mjs` 对应 `02-contract.md` §7 的 FT-01…FT-12（全链路、分位数算法、首 token 测量点、错误分类、指标缺失、告警规则、端口退避、每学生聚合、取消归类、mock/real 分栏、退出码、报告同源），外加 M1 慢首帧、M2 丢 `done`、M3 缺桶、M4 改坏指标名、M5 告警规则改坏（清单外指标 + 标签缺失，内存操作不落盘）；自测临时产物只写 `.scratch/run/F/tmp/selftest/`。`check-alerts.mjs` 无参数时默认读本目录 `prometheus/alerts.yml`，也可传入另一个规则文件路径对照。

FT-13…FT-20 是 2026-11-20 真机全链路修复的回归锁：

| 用例 | 锁定的缺陷 |
|---|---|
| `FT-13` | `done.artifacts` 按真实 `ArtifactSchema` 解析（`content_json.questions[].id` / `art.id`），作答与交卷不再 400 |
| `FT-14` | 指标存在性看 HELP/TYPE 声明行；零错误轮次 `present=10/10` |
| `FT-15` | 桶核对查多出（`le=45` 被报），`+Inf` 不算多出 |
| `FT-16` | 登录限流：共用 IP 恰好 5 成功 / 3 个 429；`distinct` 8 个全成功 |
| `FT-17` | `--home` 真正生效（目录被创建、写进 env、传给 stub 并由 `/health` 回显） |
| `FT-18` | `blocked` 与 `studentIds` 去重，`perStudent` 不翻倍 |
| `FT-19` | 规则 3 阈值随 `--token-quota` 派生，同一份样本在不同配额下得出相反结论 |
| `FT-20` | `--scenario submit` 先补答案再交卷，不再必然 400 |

## 12 边界

- **写权范围与目录隔离**：只写 `tools/loadtest/**` 与 `.scratch/run/F/**`；不改服务端代码，不改 `packages/` / `apps/` / `desktop` / `docs`，不在根 `package.json` 新增依赖；`--home` 与 `--out` 必须落在 `.scratch/run/F/` 下，禁止指向真实数据目录（`%APPDATA%`、`~/.learning-agent`、仓库内 `.learning-agent`）。
- **不直连业务库、不轮询指标**：不打开 `learning.db` / `auth.db` 文件句柄；业务库由服务端自己写，F 只观察 `yxs_sqlite_busy_total`，不替服务端调 WAL 或 `busy_timeout`；只在场景前后各抓一次 `/metrics` 快照，运行期间不轮询，避免干扰基线。
- **端口退避**：stub 端口按 18080 → 18180 → 18280 尝试；`EADDRINUSE` 时 +100 退避，不 kill 不明进程；三个端口都被占则报基础设施失败，可改用 `--target http`。
