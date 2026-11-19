# F · 压测 + 可观测性 · 契约

> 轮次：F · 压测 + 可观测性
> 文档角色：02-contract
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1（本文件只细化，不新增指标名、不改端口、不改错误码）
> 一句话：压测脚本的参数、采样口径、报告字段、告警规则字段全部在本文档写死；实现者照字段名落地，验收者照字段名判过。

## 1 契约总览

| 层 | 冻结来源 | 本轮细化 |
|---|---|---|
| 被测端点与信封 | 冻结 §2、§4、§7 | 压测客户端调用顺序与字段形状（§2） |
| 指标名 / 标签 / 桶 | 冻结 §9.2（10 个指标、12 个桶） | F 侧抓取、解析与汇总口径（§3.1），不新增指标 |
| 告警阈值与表达式要点 | 冻结 §9.3（5 条） | `alerts.yml` 的 `expr`/`for`/`labels`/`annotations` 字段级写法（§3.4、§4.3） |
| 报告形态 | F README：md + json，P50/P95/P99、首 token、错误率、busy、每学生 tokens/turns | JSON schema 逐字段、md 骨架、分位数与错误率算法（§3.2、§3.3） |
| 运行资源 | 冻结 §10、`02-ownership-and-parallel.md` §3：端口 18080、`.scratch/run/F/home` | CLI 参数与退出码（§2.1、§4.2） |

**契约稳定性**：本文件出现的报告 JSON 字段名、CLI 参数名、告警规则名视为 v1 冻结。报告允许新增可选字段（消费方必须容忍未知字段）；删改字段、改指标名、改阈值需要按冻结 §12 走变更登记。告警规则的字段组织遵循 Prometheus 规则语法，字段名不自创 [R43]。

**与冻结口径的唯一已知缺口**：§9.3 第 3 条引用了 §9.2 清单之外的 `yxs_token_quota`。本文档 §4.3 给出替代口径与差异标注，不在 `alerts.yml` 里默默照抄一个不存在的指标名。

## 2 接口契约（CLI、目标端点、场景步骤）

### 2.1 `scenario.mjs` CLI 参数

入口固定为 `tools/loadtest/scenario.mjs`，Node 运行，ESM。所有参数可被 `config/loadtest.example.json` 同名配置覆盖；命令行参数优先于配置文件。

| 参数 | 类型 | 默认 | 边界与校验 | 说明 |
|---|---|---|---|---|
| `--target <stub\|http>` | enum | `stub` | 仅两值；非法值 → 退出码 1 | `stub` 用内置内存桩；`http` 连 `--base-url` 指向的实例 |
| `--base-url <url>` | string | `http://127.0.0.1:18080` | 必须带 `http://` 或 `https://`；路径尾斜杠归一 | 被测服务端根地址；端口被占时按 +100 退避并写进报告 |
| `--students <n>` | integer | `40` | 1..200；本轮验收档位 `40` 与 `60` | 并发虚拟学生数（VU）；并发模型参照 k6 的 VU 概念 [R39] |
| `--ramp-up <seconds>` | number | `5` | 0..300 | 从 0 到 `--students` 的爬坡时长；0 表示一次性全部拉起 |
| `--iterations <n>` | integer | `1` | 1..20 | 每个学生重复完整场景的轮次 |
| `--scenario <full\|login\|ask\|answer\|submit>` | enum | `full` | 五值 | `full` = 登录→提问→出题→交卷→回读；其余为单步调试场景 |
| `--llm <mock\|real>` | enum | `mock` | 两值 | 仅记录到报告 `meta.llmMode`；真实模型调用由被测服务端按 `YXS_LLM` 决定，F 不直接调模型 |
| `--home <dir>` | path | `.scratch/run/F/home` | 必须在仓库 `.scratch/run/F/` 下；指向真实数据目录 → 退出码 1 | stub/被测实例的 `LEARNING_AGENT_HOME` |
| `--out <dir>` | path | `.scratch/run/F/report` | 自动创建 | md/json 报告与原始 `/metrics` 快照落点 |
| `--token-quota <n>` | integer | `200000` | 1..10_000_000 | 替代 `yxs_token_quota` 的固定常量配额（§4.3）；仅用于第 3 条告警的 F 侧替代口径 |
| `--metrics-token <token>` | string | 空 | — | 对应冻结 §10.2 的 `YXS_METRICS_TOKEN`；为空则不带鉴权头抓 `/metrics` |
| `--help` | flag | — | — | 打印参数表后退出码 0 |

PowerShell 可直接粘贴的开跑命令（仓库根）：

```powershell
cd E:\Documents\GitHub\YingXiaoShang
node tools\loadtest\scenario.mjs --target stub --students 40 --llm mock
node tools\loadtest\scenario.mjs --target http --base-url http://127.0.0.1:18080 --students 60 --llm mock --out .scratch\run\F\report-60
```

### 2.2 被测端点（F 调用面，全部对齐冻结 §2、§7）

| 步骤 | 端点 | 鉴权 | 场景用途 |
|---|---|---|---|
| 前置自检 | `GET /health`、`GET /api/v1/health` | 否 | 开跑前确认实例存活与库内容；`warnings` 非空记入报告 meta |
| 登录 | `POST /api/v1/auth/login` | 否 | 每虚拟学生取 token；失败计入 `login.fail` 与错误率 |
| 提问 | `POST /api/v1/chat/stream`（SSE） | 是 | 主压测面；测首 token 延迟、轮次、token 用量 |
| 取消（可选路径） | `POST /api/v1/chat/cancel` | 是 | 少量样本走取消路径；归类为 `cancelled`，不计错误率 |
| 作答 | `POST /api/v1/answer` | 是 | 单题作答路径 |
| 交卷 | `POST /api/v1/answer-set` | 是 | 交卷落库路径 |
| 回读 | `POST /api/v1/rpc`（`agent.turns`、`chat.sessions` 等只读方法） | 是 | 校验轮次/成绩落库，不计入写路径延迟基线 |
| 指标抓取 | `GET /metrics` | 可选 token | 场景结束后抓取一次快照；运行中不轮询，避免干扰基线 |

请求信封、错误码与中文消息以冻结 §4.1–§4.2 为唯一真相源；F 不自定义错误码。RPC 单端点分发形态沿用 JSON-RPC 的 `method`/`params` 习惯，但成败由 HTTP 状态码与 `ok` 布尔承载 [R3]。

### 2.3 场景步骤时序（每个虚拟学生）

```text
t0  GET /api/v1/health → 记录 warnings/notices；不健康则该学生标记 blocked
t1  POST /auth/login {studentId,password} → 保存 token；失败 → 状态 failed，跳过后续
t2  POST /chat/stream（第 1 轮提问）→ 收 SSE 帧直到 done/error；记录首 token 时间与轮次
t3  （出题路径）随 SSE done 携带的 artifactId / 题目集，POST /answer 逐题作答
t4  POST /answer-set 交卷 → 记录落库结果
t5  POST /rpc agent.turns 回读本轮 turns，与本地计数对账
```

学生编号 `2023F001` 起顺序生成；口令由 stub/被测实例的本地种子库提供，F 不写真实账号库。

## 3 数据结构

### 3.1 指标抓取口径（冻结 §9.2 逐字）

F 解析 `/metrics` 文本时，指标名与标签必须与下表逐字一致；下表之外的 `yxs_*` 名字在 F 侧一律视为缺口，列入 `metricsScrape.missing`，不映射到既有指标。

| 指标名 | 类型 | 标签（逐字） | F 侧用途 |
|---|---|---|---|
| `yxs_http_requests_total` | counter | `method`,`route`,`status` | 总请求量、5xx 率、状态分布 |
| `yxs_http_request_duration_seconds` | histogram | `method`,`route` | 服务端侧延迟分位数（与客户端采样并列展示） |
| `yxs_rpc_requests_total` | counter | `method`,`code` | 按方法错误率 |
| `yxs_tokens_total` | counter | `student_id`,`kind`（`prompt`/`completion`） | 每学生 token 汇总 |
| `yxs_errors_total` | counter | `code` | 错误分类计数 |
| `yxs_sqlite_busy_total` | counter | `db` | `SQLITE_BUSY` 增量（本轮关键观测项） |
| `yxs_sse_active_connections` | gauge | — | SSE 并发连接峰值 |
| `yxs_sse_first_token_seconds` | histogram | — | 服务端侧首 token 延迟，与客户端采样复核 |
| `yxs_login_total` | counter | `result`（`ok`/`fail`） | 登录成功率 |
| `yxs_process_start_time_seconds` | gauge | — | 检测压测期间服务端是否重启 |

桶边界（histogram buckets，秒，逐字取自冻结 §9.2）：

```text
0.05 0.1 0.25 0.5 1 2 3 5 8 13 20 30
```

F 不自造桶；客户端采样的分位数不受这组桶约束（样本在内存排序），但报告里引用服务端直方图时必须说明其分位精度受桶边界限制。分位数必须由 histogram/样本排序计算，禁止用平均值代替 P95/P99 [R44]。

### 3.2 报告 JSON schema（`loadtest-report.json` 逐字段）

> 类型标注：`string` / `number` / `integer` / `boolean` / `null` / `array` / `object`；`?` 表示可选字段。所有时间为 ISO-8601 UTC；延迟单位毫秒（`ms`），token 为整数计数。

#### 3.2.1 `meta`（对象，必填）

| 字段 | 类型 | 说明 |
|---|---|---|
| `runId` | string | `run_` + 12 位 base36，一次压测唯一 |
| `startedAt` | string | 开跑时刻 ISO；`endedAt` 同型 |
| `endedAt` | string | 结束时刻 ISO |
| `durationMs` | integer | 全场景墙钟时长 |
| `toolVersion` | string | `tools/loadtest` 包版本 |
| `target` | object | `{type: "stub"\|"http", baseUrl: string, port: integer}`；退避后的实际端口 |
| `llmMode` | string | `mock` / `real` |
| `config` | object | `{students: integer, rampUpSec: number, iterations: integer, scenario: string, tokenQuota: integer}` |
| `caveats` | string[] | 固定口径说明，至少含「首 token 测自本机回环」「mock token 为固定 usage」两条 |
| `serverRestarted` | boolean? | 对比 `yxs_process_start_time_seconds` 前后值；压测期间变过则为 `true` |

#### 3.2.2 `summary`（对象，必填）

| 字段 | 类型 | 口径 |
|---|---|---|
| `requestsTotal` | integer | 全部已派发请求数（含失败、超时；不含未派发的 blocked 学生） |
| `requestsOk` | integer | HTTP 2xx 且信封 `ok:true`，或 SSE 正常收到 `done` |
| `requestsFailed` | integer | 见 §3.3.3 错误率口径的失败分子 |
| `errorRate` | number | `requestsFailed / requestsTotal`；分母为 0 → `null` |
| `statusBreakdown` | object | `{http2xx: integer, http4xx: integer, http5xx: integer, businessError: integer, sseError: integer, cancelled: integer, timeout: integer, networkAbort: integer}` |
| `latency` | object | HTTP/RPC 请求延迟分位数，字段见 §3.2.3 |
| `firstToken` | object | SSE 首 token 分位数，字段见 §3.2.3；无 SSE 样本时 `sampleCount=0`、分位数 `null` |
| `sseActivePeak` | integer | 运行期间观察到的 SSE 并发连接峰值（对照 `yxs_sse_active_connections`） |
| `sqliteBusyTotal` | integer | 本轮 `yxs_sqlite_busy_total` 增量（结束快照 − 起始快照） |
| `tokens` | object | `{prompt: integer, completion: integer, total: integer, mode: string}`；`mode` 同 `meta.llmMode` |
| `turnsTotal` | integer | 全部学生收到的 `done` 事件总数 |

#### 3.2.3 分位数对象（`latency` 与 `firstToken` 同构）

| 字段 | 类型 | 口径 |
|---|---|---|
| `p50` | number \| null | 中位数，算法见 §3.3.1 |
| `p95` | number \| null | 95 分位 |
| `p99` | number \| null | 99 分位 |
| `avg` | number \| null | 算术平均，仅作参考，不替代分位数 |
| `min` | number \| null | 最小样本 |
| `max` | number \| null | 最大样本 |
| `sampleCount` | integer | 纳入计算的样本数；0 时全部分位数为 `null` |
| `unit` | string | 恒为 `"ms"` |

#### 3.2.4 `perStudent`（数组，长度 = 参与场景的学生数）

每个元素：

| 字段 | 类型 | 说明 |
|---|---|---|
| `studentId` | string | 压测学号（`2023F001` …） |
| `loginOk` | boolean | 登录是否成功 |
| `asks` | integer | 发起的 `chat/stream` 次数 |
| `answers` | integer | `answer` 成功次数 |
| `submissions` | integer | `answer-set` 成功次数 |
| `turns` | integer | 该学生收到的 `done` 事件数（轮次）；对照 `agent.turns` 回读值 |
| `tokensPrompt` | integer | `yxs_tokens_total{student_id,kind="prompt"}` 汇总 |
| `tokensCompletion` | integer | `kind="completion"` 汇总 |
| `tokensTotal` | integer | 两者之和 |
| `rpcCalls` | integer | 该学生全部 RPC/业务调用次数 |
| `rpcErrors` | integer | 该学生失败调用次数（口径同 §3.3.3） |
| `cancelled` | integer | 主动取消的轮次数 |
| `timeouts` | integer | 超时轮次数 |
| `firstTokenMs` | number[] | 该学生每次 SSE 的首 token 样本（可空数组） |
| `latencyMs` | number[] | 该学生每次 HTTP/RPC 延迟样本 |
| `status` | string | `ok` / `partial`（部分步骤失败）/ `failed`（登录失败或全败） |

#### 3.2.5 `metricsScrape`（对象）

| 字段 | 类型 | 说明 |
|---|---|---|
| `scrapedAt` | string | 快照时刻 ISO |
| `endpoint` | string | 抓取的 `/metrics` 地址 |
| `present` | string[] | §3.1 清单中本次实际出现的指标名 |
| `missing` | string[] | 清单中未出现的指标名；非空时整体 verdict 不得为 `green` |
| `counters` | object | 按指标名展开的标签→值快照，如 `{"yxs_sqlite_busy_total":{"learning.db": 3}}` |
| `rawSnapshotPath` | string? | 原始文本快照落盘相对路径 |

#### 3.2.6 `alerts` 与 `verdicts`

`alerts.rules[]` 每条：`{name: string, severity: "page"\|"warn", expr: string, for: string, state: "firing"\|"pending"\|"inactive"\|"unknown", value: number|null, reason: string}`。

`verdicts`：`{overall: "green"\|"red"\|"incomplete", items: array}`；每条 `{rule: string, threshold: string, observed: string, state: "green"\|"red"\|"incomplete"\|"unknown", note: string}`。

### 3.3 计算口径（算法写死，实现不得另选）

#### 3.3.1 P50/P95/P99 算法

1. 取纳入样本的数值数组，按升序排序；空数组 → 分位数 `null`、`sampleCount=0`。
2. 对分位 `p`（0.50 / 0.95 / 0.99），排名 `rank = ceil(p × n)`，`n` 为样本数；`rank` 夹到 `[1, n]`。
3. 取排序后第 `rank` 个元素（最近秩法，不做线性插值）；并列值保持原顺序。
4. 样本数 < 30 时，分位数照常计算，但 `verdicts` 对应项标 `low-sample`，不参与红绿判定。
5. 客户端样本单位为毫秒；服务端直方图分位数由 Prometheus `histogram_quantile` 计算，单位秒，报告展示时换算并标注来源。

#### 3.3.2 首 token 测量起点与终点

- **起点 t0**：客户端即将写出 `chat/stream` 请求头的时刻（`fetch` 派发前一刻），不含本地排队与脚本调度等待。
- **终点 t1**：收到第一条带非空正文的 SSE `event: text` 帧的时刻；`session`、`round`、`tool`、`tool-end` 帧都不算首 token（事件类型对齐 `packages/agent/src/team.ts:17-19`）。
- 若流以 `error` 事件结束、被取消、超时或连接中断：该轮首 token 记 `null`，进入失败归类，不补 0、不用上一次样本顶替。
- 非流式 RPC 不产生首 token 样本；`firstToken.sampleCount` 只统计 SSE 轮次。
- 服务端对照指标为 `yxs_sse_first_token_seconds`；两侧口径差异（客户端含网络回环、服务端含排队）在 `caveats` 写明。

#### 3.3.3 错误率口径

- **失败分子**（`requestsFailed`）满足任一：HTTP 状态 ≥500；信封 `ok:false`；SSE `error` 事件；超时（超过冻结 §2 的各路径超时上限）；网络中断/连接重置。
- **不计入失败分子**：主动 `cancelled`（单列 `cancelled`）；HTTP 4xx（单列 `http4xx`，属于客户端/契约问题，不计入 5xx 率告警）。
- **分母**：`requestsTotal`，全部已派发请求；blocked（健康检查未过、未派发）的学生不计入分母。
- 错误率 `errorRate = requestsFailed / requestsTotal`；同时按 `yxs_errors_total{code}` 与 `yxs_rpc_requests_total{method,code}` 给出分类明细。
- 5xx 率（告警口径）单独计算：`http5xx / (http2xx + http4xx + http5xx)`，与 `errorRate` 不是同一个数，报告里分列。

### 3.4 `alerts.yml` 契约（`tools/loadtest/prometheus/alerts.yml`）

文件为 Prometheus 规则格式，顶层 `groups:` 一条组 `name: yxs-server`。5 条规则与冻结 §9.3 一一对应；阈值只取冻结值，本轮不新增阈值。表达式中出现的指标名必须在 §3.1 清单内（第 3 条的缺口处理见 §4.3）。

### 3.4.1 五条规则逐字对照表（冻结 §9.3）

| # | 规则名（F 落地） | `expr`（冻结原式逐字） | `for` | 级别 | 绿（green） | 红（red） |
|---|---|---|---|---|---|---|
| 1 | `YxsHttp5xxRate` | `sum(rate(yxs_http_requests_total{status=~"5.."}[5m])) / sum(rate(yxs_http_requests_total[5m])) > 0.01` | `5m` | `page` | 5xx 率 ≤ 0.01 | 5xx 率 > 0.01 持续 5m |
| 2 | `YxsHttpP95Latency` | `histogram_quantile(0.95, sum by (le)(rate(yxs_http_request_duration_seconds_bucket[10m]))) > 3` | `10m` | `warn` | P95 ≤ 3s | P95 > 3s 持续 10m |
| 3 | `YxsTokenUsageHigh` | 冻结原式：`yxs_tokens_total{kind="prompt"} / yxs_token_quota > 0.8`（`yxs_token_quota` 不在 §9.2 清单，默认启用 §4.3 替代口径） | `15m` | `warn` | prompt 用量 ≤ 配额 80% | 用量 > 配额 80% 持续 15m |
| 4 | `YxsSqliteBusySpike` | `increase(yxs_sqlite_busy_total[5m]) > 5` | `5m` | `warn` | 5m 内 BUSY 增量 ≤ 5 | 增量 > 5 持续 5m |
| 5 | `YxsServerDown` | `up{job="yxs-server"} == 0` | `1m` | `page` | `up == 1` | `up == 0` 持续 1m |

> 阈值数值（0.01、3s、0.8、5 次、1m）全部来自冻结 §9.3，F 不自行收紧或放宽；实测分位数与增量在报告 `verdicts.items[].observed` 记录，样本不足时标 `incomplete`，不用估计值凑红绿。

### 3.4.2 每条规则的字段级说明

| 规则 | `expr` 字段要点 | `labels` | `annotations` |
|---|---|---|---|
| `YxsHttp5xxRate` | 分子按 `status=~"5.."` 筛 5xx 再 `rate[5m]`，分母为全量 `rate[5m]`；比率 > 0.01 触发；除零由 Prometheus 空序列处理，F 报告侧分母为 0 时记 `unknown` | `severity: page`、`job: yxs-server` | `summary`：「5xx 错误率超过 1%（持续 5 分钟）。」；`description`：分子/分母口径与当前 5xx 计数，指向 `/metrics` 的 `yxs_http_requests_total` |
| `YxsHttpP95Latency` | `sum by (le)` 先合并标签再喂 `histogram_quantile(0.95, …)`；`rate[10m]`；阈值 3 秒；分位数来自直方图，不用 `avg` [R44] | `severity: warn`、`job: yxs-server` | `summary`：「HTTP P95 延迟超过 3 秒（持续 10 分钟）。」；`description`：分位数对应的桶区间与慢路由（`method`/`route` 标签） |
| `YxsTokenUsageHigh` | 冻结原式依赖缺口指标 `yxs_token_quota`；替代口径按 `student_id` 汇总 `yxs_tokens_total{kind="prompt"}` 与配置常量比较（§4.3）；`for: 15m` | `severity: warn`、`job: yxs-server`、`quota: <常量>` | `summary`：「学生 {{ $labels.student_id }} prompt token 用量达到配额阈值。」；`description`：标注替代口径与缺口指标状态 |
| `YxsSqliteBusySpike` | `increase(yxs_sqlite_busy_total[5m])` 取 5 分钟增量；阈值 5 次；`db` 标签在报告明细中展开 | `severity: warn`、`job: yxs-server` | `summary`：「5 分钟内 SQLITE_BUSY 超过 5 次。」；`description`：涉及的 `db` 标签与并发档位，指向 busy 计数指标 |
| `YxsServerDown` | `up{job="yxs-server"} == 0`；`up` 由 Prometheus 抓取目标产生，F 自测时用 stub 健康检查模拟；`for: 1m` | `severity: page`、`job: yxs-server` | `summary`：「服务端目标失联超过 1 分钟。」；`description`：抓取地址与最后一次 `/health` 状态 |

### 3.4.3 通用字段规则

| 字段 | 取值规则 |
|---|---|
| `expr` | 逐字采用 §4.3 表内表达式；PromQL 函数仅限 `rate` / `increase` / `histogram_quantile` / `sum by` |
| `for` | 冻结表给定的持续时间；到点前状态为 `pending`，到点才 `firing` |
| `labels.severity` | `page` / `warn`，与冻结级别一致 |
| `labels.job` | 恒为 `yxs-server` |
| `annotations.summary` | 一句话症状（中文），含规则名与阈值 |
| `annotations.description` | 现象、当前值口径、对应排查方向；不写内部堆栈与文件路径 |
| `annotations.runbook` | 可选，指向仓库内排查文档路径；本轮可缺省 |

规则可被 `promtool check rules` 校验；本机无 promtool 时用 `scripts/check-alerts.mjs` 做兜底自检（YAML 可解析、5 条齐全、指标名在清单内）。告警命名与 `for` 抑抖的做法遵循 Prometheus 告警实践 [R42]。

### 3.5 Markdown 报告骨架（`loadtest-report.md`）

```text
# 压测报告 <runId>（<llmMode> / <target.type>）

 ## 1 运行概览
  表格：startedAt、durationMs、students、scenario、baseUrl、port、serverRestarted

 ## 2 总体结论
  overall verdict（green/red/incomplete）+ 阈值判定表（规则 / 阈值 / 实测 / 状态）

 ## 3 延迟分位数
  3.1 HTTP/RPC 延迟：P50/P95/P99/avg/min/max/sampleCount
  3.2 SSE 首 token：同上；注明回环口径

 ## 4 错误率与状态分布
  errorRate、5xx 率、statusBreakdown 表、按 code/method 的错误明细

 ## 5 每学生明细
  表格：studentId、status、asks、answers、submissions、turns、tokensPrompt、
        tokensCompletion、tokensTotal、rpcErrors、cancelled、timeouts

 ## 6 指标抓取快照
  present/missing 清单、sqliteBusyTotal、tokens 汇总、sseActivePeak、服务端直方图对照

 ## 7 告警规则演练结果
  5 条规则的 state、value、reason

 ## 8 口径与失真说明
  caveats 原文：回环失真、mock 固定 usage、低样本提示、缺口指标状态
```

md 与 json 同源生成；md 表格中的数字必须与 json 同名字段相等，不允许 md 手写估算值。

## 4 错误与消息

### 4.1 压测侧失败分类（对应 §3.2.2 `statusBreakdown`）

| 分类 | 触发条件 | 是否进错误率分子 | 对照冻结错误码 |
|---|---|---|---|
| `http5xx` | 状态码 500/501/502/504 等服务端/网关类（不含 499 `CANCELLED`） | 是 | `INTERNAL` / `UPSTREAM_FAILED` / `TIMEOUT` |
| `businessError` | 信封 `ok:false`（含 4xx 业务校验失败） | 是（4xx 同时单列 `http4xx`） | 冻结 §4.2 全码表 |
| `sseError` | SSE 收到 `event: error` | 是 | `error.code` 记入明细 |
| `timeout` | 超过路径超时上限未收到终态 | 是 | `TIMEOUT`（504） |
| `networkAbort` | 连接重置/DNS/中断 | 是 | `UPSTREAM_FAILED` 口径 |
| `cancelled` | 主动调 `chat/cancel` 且被服务端确认 | 否 | `CANCELLED`（499） |
| `http4xx` | 400/401/403/404/413/429 | 否（单列） | 对应冻结 4xx 码 |

错误消息逐字取自冻结 §4.2 中文模板；F 只分类、不改写文案。底层错误翻译的现成纯函数在 `apps/desktop/src/main/errors.ts:13-18`，F 侧归类参照其 chat/answer 上下文区分，但不 import 桌面端代码。错误分类遵循最小信息披露原则：报告明细只记错误码与字段名，不回显 token、口令或消息正文 [R7]。

### 4.2 退出码

| 退出码 | 含义 | 触发条件 |
|---|---|---|
| `0` | 通过 | 场景跑完；适用阈值全部 `green`；无 `missing` 指标；样本量达标 |
| `1` | 基础设施失败 | 参数非法、目标不可达、stub 启动失败、`/metrics` 抓取失败、报告写盘失败；不产生 `red` 判定 |
| `2` | 阈值越线 | 跑完但至少一条适用规则 `red` |
| `3` | 无法判定 | 指标缺失、关键样本不足或服务端中途重启，verdict 为 `incomplete` |

退出码与报告 `verdicts.overall` 对应：`green→0`、`red→2`、`incomplete→3`；基础设施失败不写 verdict，直接 `1`。

### 4.3 `yxs_token_quota` 缺口处理（冻结 §9.3 第 3 条）

**缺口事实**：冻结 §9.3 第 3 条表达式 `yxs_tokens_total{kind="prompt"} / yxs_token_quota > 0.8` 引用了 `yxs_token_quota`；但 §9.2 的 10 个指标清单中没有这个指标，仓库代码里也不存在该指标名（现状只有 `errors.ts:33-35` 对「余额/额度不足」的错误文案匹配）。因此它**不是既有指标**，F 不能把它当作已存在的指标写进规则表达式。

**F 侧替代口径（默认启用）**：

```yaml
# 替代口径：配额来自 CLI/配置常量 --token-quota，不依赖服务端暴露 quota 指标。
- alert: YxsTokenUsageHigh
  expr: |
    sum by (student_id) (yxs_tokens_total{kind="prompt"}) > scalar(config("tokenQuota"))
  for: 15m
  labels:
    severity: warn
    job: yxs-server
  annotations:
    summary: "学生 {{ $labels.student_id }} 的 prompt token 用量达到配额阈值。"
    description: "替代 yxs_token_quota 口径：与固定常量配额比较；待服务端补齐 quota 指标后恢复冻结原表达式。"
```

> 实现注记：`scalar(config("tokenQuota"))` 仅为表达占位；Node 侧脚本不启动 Prometheus，规则文件落地时改为把常量写入 `labels.quota` 或在 `expr` 中使用数字常量（默认 200000），具体写法以 `promtool` 可校验为准。落地约束：表达式不得引用 §3.1 清单外的现存指标名。

**口径差异标注（必须写进 `alerts.yml` 注释与报告 §8）**：

| 项 | 冻结原表达式 | F 侧替代 |
|---|---|---|
| 分母 | `yxs_token_quota`（按学生/全局的配额 gauge，应由服务端暴露） | 固定常量配额 `--token-quota`，所有学生同一阈值 |
| 比较对象 | 比率 `prompt / quota > 0.8` | 绝对量 `prompt > quota 常量`；等价前提是配额 = 常量值 × 0.8 |
| 数据来源 | 服务端指标 | 服务端 `yxs_tokens_total` + F 配置常量 |
| 恢复路径 | A 轮在 §9.2 补齐 `yxs_token_quota` gauge 后，按冻结 §12 变更登记，把表达式还原为冻结原式 | 替代规则保留注释中的原式备查 |

**走变更规则**：本条同时登记为「待 A 轮补指标」；若后续决定由服务端暴露 quota，需要先改冻结文件 §9.2/§9.3、升版本号并在总索引 §7 登记，再改 F 的规则，顺序不可反。

## 5 事件与序列

### 5.1 单学生场景时序（文字版）

```text
client                server/stub
  │ ── GET /api/v1/health ────────▶ │ 自检（startupHealth 口径，health.ts:23-35）
  │ ◀── 200 {ok,warnings,notices} ─ │
  │ ── POST /auth/login ───────────▶ │ 校验 → 签 token
  │ ◀── 200 {token,expiresAt,student}│
  │ ── POST /chat/stream ─────────▶ │
  │ ◀── event: session ───────────── │ 第一条帧；不计首 token
  │ ◀── event: round ────────────── │
  │ ◀── event: text (首条非空正文) ─ │ t1 在此刻记录首 token
  │ ◀── event: tool / tool-end ──── │
  │ ◀── event: done ──────────────── │ 终态；turns +1
  │ ── POST /answer ───────────────▶ │ 逐题作答
  │ ── POST /answer-set ───────────▶ │ 交卷
  │ ── POST /rpc agent.turns ──────▶ │ 回读对账
```

### 5.2 SSE 帧与测量点契约

- 事件名集合：`session` / `round` / `text` / `tool` / `tool-end` / `done` / `error`，对齐冻结 §7.1 与 `packages/agent/src/team.ts:17-19`；未知事件记入报告明细，不中断流。SSE 帧的 `event:`/`data:`/空行格式以 WHATWG 规范为准 [R10]。
- `done` 只出现一次；收到 `done` 后关闭读取。`error` 之后不期望 `done`。
- 首 token 只认 `text` 帧（§3.3.2）；心跳注释行 `: keep-alive` 不计帧。
- 取消路径：发 `chat/cancel` 后观察是否再有 `text`；有则记为取消未生效样本，归类进 `sseError` 旁注，不伪造成功。
- 流末 `usage`（对齐 `apps/desktop/src/main/llm.ts:146-147`）可作为 `yxs_tokens_total` 的交叉核对；两者不一致时以服务端指标为准，差异写入报告明细。

### 5.3 并发与启动序列

1. 解析参数 → 校验目录在 `.scratch/run/F/` 下 → 启动 stub 或探测 `--base-url`。
2. 起始快照：抓一次 `/metrics`（用于 busy 与 token 增量、启动时间对比）。
3. 按 `--ramp-up` 拉起虚拟学生；每个学生独立 token 与样本数组，学生间不共享 HTTP 连接池状态。
4. 全部学生结束（或超时硬截止）后抓结束快照，汇总、生成 md/json。
5. 硬截止：`iterations × 预估单生时长` 兜底；超时未结束的轮次记 `timeout`，报告照常生成。

## 6 兼容与版本

- **报告消费方兼容**：JSON 允许新增可选字段；消费方必须忽略未知字段。必填字段在 §3.2 表内标「必填」；可选字段缺失时解析为 `null` 或空数组，不得报错。
- **指标兼容**：F 只认 §3.1 清单内的指标名；新增指标由 A 在冻结 §9.2 登记后，F 再扩展解析。F 不读取未登记指标做判定。
- **规则兼容**：`alerts.yml` 规则名一旦发布不改名；调整阈值属于冻结 §9.3 变更，需先走冻结文件登记。规则字段只使用 Prometheus 官方定义的 `expr`/`for`/`labels`/`annotations`，不引入自定义字段名 [R43]。
- **stub 与真机兼容**：stub 的响应信封、事件顺序与真机一致；stub 不实现的行为（如真实模型延迟、真实 BUSY）在 `caveats` 标注，不在 stub 里伪造指标样本。
- **版本对齐**：本契约对应冻结 v1；冻结升 v2 时，F 文档按变更条目逐条复核 §3.1 指标表与 §4.3 缺口状态。
- **与 E 轮的边界**：E 做契约正确性断言，F 做并发与观测汇总；两者共享同一冻结信封，F 不替代 E 的非法输入用例，E 不承担分位数报告。

## 7 契约测试映射（本轮自测编号）

| 编号 | 契约点 | 断言 |
|---|---|---|
| `FT-01` | 场景全链路（§2.3） | stub 目标 40 学生跑完；每学生有 `perStudent` 记录；`turnsTotal` = `done` 事件总数 |
| `FT-02` | 分位数算法（§3.3.1） | 固定样本数组下 P50/P95/P99 等于最近秩法手算值；空数组 → `null`；<30 样本标 `low-sample` |
| `FT-03` | 首 token 测量点（§3.3.2、§5.2） | 首条 `text` 帧前的 `session/round/tool` 不计入；`error` 轮次样本为 `null` |
| `FT-04` | 错误率分类（§3.3.3、§4.1） | 构造 5xx / `ok:false` / SSE error / timeout / cancel / 4xx 各一例，归类与分子分母正确 |
| `FT-05` | 指标缺失（§3.2.5） | stub 缺少某个指标时 `missing` 非空，verdict 不为 `green` |
| `FT-06` | 告警规则（§3.4、§4.3） | `alerts.yml` 5 条齐全；`expr` 中现存指标名在 §3.1 清单内；第 3 条不直接引用 `yxs_token_quota` |
| `FT-07` | 端口退避（§2.1） | 18080 被占时退避 18180，报告 `meta.target.port` 记录实际端口 |
| `FT-08` | 每学生聚合（§3.2.4） | 两个学生的 tokens/turns 互不串号；`tokensTotal = prompt + completion` |
| `FT-09` | 取消归类（§4.1） | 取消轮次计 `cancelled`，不进 `requestsFailed` |
| `FT-10` | mock/real 分栏（§1、§3.2.2） | 两种 `llmMode` 的 token 汇总带 `mode` 字段，不合并平均 |
| `FT-11` | 退出码（§4.2） | green→0、red→2、incomplete→3、基础设施失败→1 各有对应脚本路径 |
| `FT-12` | 报告同源（§3.5） | md 表格中 P95、错误率、busy 次数与 json 同名字段相等 |

自测组织遵循「一个编号一条断言、失败原因写进断言文本」的测试分层建议 [R36]；规则文件的字段合法性对照 Prometheus 官方语法校验 [R43]。

## 参考

- [R3] JSON-RPC 2.0 规范 — https://www.jsonrpc.org/specification — 支撑 §2.2 RPC 信封的 `method`/`params`/`error` 结构 — 借鉴信封形状；不引入 batch 与 notification。
- [R7] OWASP REST Security Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html — 支撑 §4.1 错误明细的最小信息披露 — 采用「只记错误码与字段名、不回显凭证与正文」；不引入 API key 体系。
- [R10] WHATWG Server-Sent Events — https://html.spec.whatwg.org/multipage/server-sent-events.html — 支撑 §5.2 SSE 帧格式与事件边界 — 采用 `event:`/`data:`/空行；不实现 Last-Event-ID 重放。
- [R36] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §7 自测编号与断言组织 — 采用「编号一条断言、禁止固定 sleep」；不引入其全部工具链。
- [R39] k6 文档 — https://grafana.com/docs/k6/latest/ — 支撑 §2.1 VU 模型与阈值概念 — 借鉴 VU 与场景分层；不引入 k6 运行时。
- [R41] alexfernandez/loadtest — https://github.com/alexfernandez/loadtest — 支撑 §2.1 并发调度与逐请求采样 — 借鉴并发数 + 延迟统计；不照搬其 CLI。
- [R42] Prometheus 告警实践 — https://prometheus.io/docs/practices/alerting/ — 支撑 §3.4 与 §4.3 的症状告警、`for` 抑抖、级别划分 — 采用页面级/警告级两级；不做因果推断告警。
- [R43] Prometheus 告警规则语法 — https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/ — 支撑 §3.4 `expr`/`for`/`labels`/`annotations` 字段级写法 — 直接采用官方字段名。
- [R44] Prometheus 直方图与分位数 — https://prometheus.io/docs/practices/histograms/ — 支撑 §3.1 桶边界与 §3.3.1 分位数口径 — 采用 histogram 与 `histogram_quantile`；禁止用平均值代替分位数。
- [R45] Prometheus 主仓库 — https://github.com/prometheus/prometheus — 支撑 §4.3 替代表达式对 `rate`/`increase`/`sum by` 的可用范围 — 参照其规则引擎语义；F 侧不部署 Prometheus 服务。
