# F · 压测 + 可观测性 · 验收

> 轮次：F · 压测 + 可观测性
> 文档角色：04-acceptance
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1（§4 信封、§7 SSE 序列、§9.2 指标与桶、§9.3 告警阈值）
> 契约细化：[`02-contract.md`](02-contract.md) §2 CLI、§3.2 报告 schema、§3.3 计算口径、§3.4 规则、§4.2 退出码
> 一句话：14 条 AC 全部可命令复现；分位数、首 token、错误率、busy 计数、每学生 token/turns、10 指标名与 12 桶逐条对得上冻结口径，反向 mutation 能把对应 AC 打红。

## 1 验收口径

**过 = 下列三组同时成立**：

1. **硬指标**：40 与 60 两档并发各跑完一轮；json 报告含 `summary.latency` 与 `summary.firstToken` 的 P50/P95/P99；`summary.errorRate` 与 `statusBreakdown` 八类计数齐全；`yxs_sqlite_busy_total` 出现在指标快照；每学生 `tokensPrompt/tokensCompletion/turns` 可与 `/metrics` 对账；10 个 `yxs_*` 指标名与 12 个 histogram 桶逐一核对通过；`alerts.yml` 5 条规则齐全且通过规则校验。
2. **反向验证**：§5 的 5 个 mutation 每个都能让指定 AC 变红或产生可辨的数值变化；改回后恢复基线。
3. **证据**：md/json 报告、`/metrics` 原始快照、失败样本帧与运行日志全部落在 `.scratch/run/F/` 下，可按 §4 复跑。

不可替代项（不能用「手工点了一遍」代替）：两档并发各跑一次、分位数由样本最近秩法 / 直方图得出（不用平均值）、每学生 token 可回指标对账、桶清单逐一比对、告警规则字段合法。

「可机器判定的才算验收」这条口径来自测试实践：断言写成可执行检查，而不是人工观察 [R11]；分位数必须由 histogram / 排序样本计算，禁止用平均值代替 P95/P99 [R6]。

## 2 前置条件

```powershell
cd E:\Documents\GitHub\YingXiaoShang

# 1) 安装 F 独立包（不进根 workspace，不动根 lockfile）
cd tools\loadtest
pnpm install --ignore-workspace
cd ..\..

# 2) 准备隔离临时目录（禁止指向真实数据目录）
New-Item -ItemType Directory -Force .scratch\run\F\home\data | Out-Null
New-Item -ItemType Directory -Force .scratch\run\F\report | Out-Null

# 3) 启动被测服务端（A 轮产物；mock 模式，端口 18080，临时 home）
$env:LEARNING_AGENT_HOME = (Resolve-Path .scratch\run\F\home).Path
$env:YXS_LLM = 'mock'
$env:YXS_SERVER_PORT = '18080'
# 服务端启动命令以 A 轮 README 为准；F 不负责启动它
```

缺什么就明说「缺则跳过并标记」：

- **被测服务端未就绪**：先跑 `--target stub` 完成工具链类 AC（AC-13 及报告生成、规则自检）；真机 AC（AC-02/03/06/07/08/09）标 `skipped`，待 A 实例起好后加跑。
- **本机无 `promtool`**：AC-10 的 `promtool check rules` 步骤标 `skipped`，改跑 `node scripts/check-alerts.mjs` 兜底；不因为缺工具判规则不合法。
- **没有种子库副本**：`/health` 的 `chapters` 可能为 0；依赖真实章节数的场景断言放宽为 `chapters >= 0`，报告带 warning。

并发档位、ramp-up 与场景脚本的组织参照 k6 的 VU 场景思路 [R1]；本机 Node 22 全局 `fetch` 即可完成全部 HTTP/SSE 请求，不需要额外运行时。

## 3 用例清单

每条 AC 追到契约 §x 的一个契约点；操作命令均可直接粘进 PowerShell。

| 编号 | 契约点 | 操作步骤 | 期望输出 | 失败判据 | 证据文件 |
|---|---|---|---|---|---|
| AC-01 | 契约 §2.2 前置自检、§2.1 `--home` 隔离 | 预检：`curl.exe -s http://127.0.0.1:18080/health`；确认 `.scratch\run\F\home` 为本次临时 home | `200`，`result.ok=true`；报告 `meta.target.baseUrl` 指向 18080，`meta.config.home` 在 `.scratch/run/F/` 下 | 连接拒绝；`meta.config.home` 指向 `%APPDATA%`、`~/.learning-agent` 或 `.learning-agent` | `report/<ts>/health.json` |
| AC-02 | 契约 §2.1 `--students 40`、§3.2.2 `requestsTotal`/`perStudent` | 40 并发一轮：`node tools\loadtest\scenario.mjs --target http --base-url http://127.0.0.1:18080 --students 40 --llm mock --out .scratch\run\F\report\40` | 退出码 0（green）；`summary.requestsTotal` 等于各场景调用次数之和；`perStudent` 条数 = 40；`meta.config.students=40` | 退出码非 0；`perStudent` 缺条；有 VU 整轮 `blocked` 且未在错误分类中说明 | `report/40/loadtest-report.md`、`.json` |
| AC-03 | 契约 §2.1 `--students 60`、§3.2.4 `perStudent` | 60 并发一轮：`node tools\loadtest\scenario.mjs --target http --base-url http://127.0.0.1:18080 --students 60 --llm mock --out .scratch\run\F\report\60` | 退出码 0；`perStudent` 条数 = 60；两档报告 `meta.config.students` 分别记录 40 / 60 | 与 AC-02 混档；60 档样本数不足 60 学生 | `report/60/loadtest-report.md`、`.json` |
| AC-04 | 契约 §3.2.3 分位数对象、§3.3.1 最近秩法、§3.3.2 首 token | 打开两轮 json 报告，核对延迟与首 token 字段 | `summary.latency` 含 `p50/p95/p99/avg/min/max/sampleCount/unit`；`summary.firstToken` 含同组字段；md 表中 P50/P95/P99 与 json 同值；首 token 终点为首个非空 `text` 帧 | 缺任一分位数字段；md 与 json 数值不一致；首 token 把 `session`/`round`/`tool` 帧计入；用平均值充当 P95；分位数用线性插值而非最近秩法 | `loadtest-report.json` 的 `summary.latency`、`summary.firstToken` |
| AC-05 | 契约 §3.2.2 `errorRate`/`statusBreakdown`、§3.3.3 错误率口径、§4.1 分类 | 核对错误率字段与分类计数 | `summary.errorRate = requestsFailed / requestsTotal`；`statusBreakdown` 含 `http2xx/http4xx/http5xx/businessError/sseError/cancelled/timeout/networkAbort`；`cancelled` 与 `http4xx` 不进失败分子；失败样本带 `requestId` 与 `code` | 错误率分母不含失败样本；分类缺项；`cancelled` 被计入失败分子；失败样本无 `requestId` | `loadtest-report.json` 的 `summary.statusBreakdown`、`errors[]` |
| AC-06 | 契约 §3.1 `yxs_sqlite_busy_total`、§3.2.2 `sqliteBusyTotal` | 对比首尾两次 `/metrics` 快照，核对 busy 指标 | 快照含 `yxs_sqlite_busy_total{db=...}`；`summary.sqliteBusyTotal` 为增量（>0，或明确为 0 且报告注明「本档并发未观察到 BUSY」）；counter 重置场景标 `counter-reset` | 指标名缺失被记成 0；出现负增量未标注；busy 次数与快照对不上 | `metrics-before.txt`、`metrics-after.txt`、json `metricsScrape` |
| AC-07 | 契约 §3.2.4 `perStudent` 字段、§3.1 `yxs_tokens_total` | 每学生汇总核对：抽 1 名学生，把报告 `perStudent[]` 与 `/metrics` 对账 | `tokensPrompt/tokensCompletion/tokensTotal` 与 `yxs_tokens_total{student_id=<学号>,kind=prompt/completion}` 增量一致，且 `tokensTotal = prompt + completion`；`turns` 与 SSE `done` 计数、`agent.turns` 回读条数对得上 | token 用字符数折算；学生缺 token 或 turns 字段；`tokensTotal` 不等于两项之和；对账偏差无 warning 说明 | `loadtest-report.json` 的 `perStudent[]`、`metrics-after.txt` |
| AC-08 | 契约 §3.1 十项指标清单 | 指标名集合核对：解析 `/metrics` 文本，与冻结 §9.2 十项逐一比对 | `metricsScrape.present` 集合恰好等于：`yxs_http_requests_total`、`yxs_http_request_duration_seconds`、`yxs_rpc_requests_total`、`yxs_tokens_total`、`yxs_errors_total`、`yxs_sqlite_busy_total`、`yxs_sse_active_connections`、`yxs_sse_first_token_seconds`、`yxs_login_total`、`yxs_process_start_time_seconds`；缺失项进 `missing`，verdict 不得为 `green` | 清单外名字被当作现存指标断言；缺指标仍判 `green` | `metricsScrape.present/missing` |
| AC-09 | 契约 §3.1 桶边界 12 项 | 桶集合核对：取两个 histogram 的 `_bucket` 样本，收集 `le` 标签 | `yxs_http_request_duration_seconds_bucket` 与 `yxs_sse_first_token_seconds_bucket` 的 `le` 列表恰好为 `0.05 0.1 0.25 0.5 1 2 3 5 8 13 20 30` 共 12 个；缺桶进 `missingBuckets` | 桶数量 ≠ 12；桶边界与清单不一致；缺桶被忽略不报错 | `metricsScrape.bucketsOk/missingBuckets` |
| AC-10 | 契约 §3.4.1 五条规则、§3.4.2 字段、§3.4.3 通用字段 | 规则校验：有 `promtool` 时跑 `promtool check rules tools/loadtest/prometheus/alerts.yml`；无则跑 `node tools\loadtest\scripts\check-alerts.mjs` | 5 条规则齐全（`YxsHttp5xxRate`、`YxsHttpP95Latency`、`YxsTokenUsageHigh`、`YxsSqliteBusySpike`、`YxsServerDown`）；每条含 `expr`/`for`/`labels`/`annotations`；`labels.job=yxs-server`；校验退出码 0 | 规则名缺项；字段缺失；缺 `job` 标签；表达式语法报错未被兜底脚本捕获 | `alerts-check.txt` |
| AC-11 | 契约 §4.3 `yxs_token_quota` 缺口处理、§3.4.1 规则 3 | 缺口规则核对：检查第 3 条 `YxsTokenUsageHigh` | 活动表达式使用 F 侧固定配额替代口径，**不**把 `yxs_token_quota` 当作现存指标断言；规则注释保留冻结原表达式；`labels.pending="token-quota-gauge"`、`labels.quota` 为配置常量；报告/文档登记「待 A 轮补 gauge，按冻结 §12 走变更」 | 活动表达式直接引用 `yxs_token_quota` 且未标缺口；缺口无替代口径；无缺口登记 | `alerts.yml` 规则 3、json `warnings` |
| AC-12 | 契约 §3.5 报告骨架、§2.1 `--out` | 证据落点检查：列 `.scratch\run\F\` 本轮产物 | `report/<ts>/` 下同时有 `loadtest-report.md`、`loadtest-report.json`、`metrics-before.txt`、`metrics-after.txt`、`run.log`；失败样本原始帧在 `sse/<requestId>.txt`；第二次复跑产物另起时间戳目录 | 只有 md 没有 json；指标快照缺失；日志含 token / 口令 / 消息正文；复跑覆盖上一轮证据 | `.scratch\run\F\report\` 目录清单 |
| AC-13 | 契约 §1 目标 7 内置 stub、§6 stub 与真机兼容 | stub 自洽：断网状态下 `node tools\loadtest\scenario.mjs --target stub --students 40 --iterations 1 --llm mock` | 退出码 0；stub 按冻结信封回登录/RPC/SSE/作答；报告 verdict 不含 `incomplete`；不访问网络、不写业务库 | stub 依赖真机实例；断网时失败；stub 响应形状与冻结信封不符 | `report/<ts-stub>/loadtest-report.json` |
| AC-14 | 归属 §1 写权矩阵、§3 运行期资源 | 隔离与写权核对：`git status --porcelain` 对比本轮前后 | 变更只在 `tools/loadtest/**` 与 `.scratch/run/F/**`；根 `pnpm-lock.yaml`、`packages/**`、`apps/desktop/**`、`docs/contracts/openapi.yaml` 无改动；无 commit / push / stash | 根 lockfile 被改；出现禁区路径变更；存在 git 提交记录 | `git-status.txt` |

用例写法遵循「一条 AC 一个可观察结果 + 明确失败判据」，避免「看起来正常」这类不可判定描述 [R11]；报告分位数与每用户明细的维度参照 Gatling 汇总结构 [R2]。

## 4 证据

- **落点**：`.scratch/run/F/report/<时间戳>/`，结构与 03 §3.8、契约 §3.5 一致：

```text
.scratch/run/F/
  home/                         # 被测实例临时 appHome（F 不直接写库文件）
  report/
    40/
      loadtest-report.md        # 人读报告
      loadtest-report.json       # 脚本二次消费，数字与 md 同源
      metrics-before.txt         # 起始 /metrics 原始快照
      metrics-after.txt         # 结束 /metrics 原始快照
      sse/<requestId>.txt        # 失败样本原始帧
      run.log                    # 每请求一行 JSON，不含敏感字段
    60/                          # 60 档同上
    <ts-stub>/                   # stub 自洽轮次
```

- **采集命令**（验收时直接跑）：

```powershell
cd E:\Documents\GitHub\YingXiaoShang
curl.exe -s http://127.0.0.1:18080/health -o .scratch\run\F\report\health.json
node tools\loadtest\scenario.mjs --target http --base-url http://127.0.0.1:18080 --students 40 --llm mock --out .scratch\run\F\report\40
node tools\loadtest\scenario.mjs --target http --base-url http://127.0.0.1:18080 --students 60 --llm mock --out .scratch\run\F\report\60
```

- **复跑要求**：两轮必须能在同一个隔离 home 上重复跑；第二次跑前如需重置登录学生，在隔离 `auth.db` 内重建，不依赖「第一次跑才过」的残留状态。
- **对账留痕**：AC-07 抽中的学生学号、其报告字段值与 `/metrics` 原始行一并贴进报告 `perStudent` 节附录；usage 事件与指标增量的偏差写进 `warnings`，不留无解释的差异。

证据存「请求/样本原文 + 结构化报告」而不是截图，是为了失败能在命令行复盘；结构化事件落盘与 12-Factor 日志观一致 [R7]。轻量并发工具把逐请求统计留在可导出报告里的做法参照 Node 侧 loadtest [R3]。

## 5 反向验证（mutation）

每条 mutation 写清「改坏哪一处 → 哪条 AC 变红 / 产生可辨变化 → 还原后恢复基线」。执行流程：手工改坏 → 跑对应 AC → 记录失败输出 → 还原 → 再跑记录通过输出；全程不碰 `apps/server`、`packages`、`apps/desktop`，只在 `tools/loadtest` 替身或配置层改。

| # | 改坏哪里 | 预期变红 / 变化的 AC | 还原后 |
|---|---|---|---|
| M1 | `src/stub.mjs`（或 mock 注入点）：把 SSE 首 token 固定延迟从约 20ms 提到 500ms，其余不变 | AC-04：首 token P50/P95/P99 相对基线明显上升，`sampleCount` 不变；报告 `meta.caveats` 仍标注回环口径 | 延迟回落，分位数回到基线量级 |
| M2 | `src/stub.mjs`：在吐出若干 `text` 帧后不发 `done` 直接断开 reader | AC-05：错误率上升，出现 `sseError`/`timeout` 分类样本；AC-02 对应轮次样本带失败记录与 `sse/` 帧落盘 | 恢复 `done` 帧，错误率回落基线 |
| M3 | 把 stub `/metrics` 里两个 histogram 的桶删掉一个（如去掉 `le="30"`） | AC-09：`missingBuckets` 出现 `30`，`bucketsOk=false`，verdict 至少 `incomplete` | 桶恢复 12 个，核对通过 |
| M4 | 把 stub `/metrics` 中 `yxs_errors_total` 改名为 `yxs_error_total`（少一个 s） | AC-08：`missing` 清单出现 `yxs_errors_total`，`present` 集合不等于冻结十项 | 改回原名，集合比对通过 |
| M5 | 编辑 `prometheus/alerts.yml` 规则 3：把替代表达式换回冻结原表达式 `yxs_tokens_total{kind="prompt"} / yxs_token_quota > 0.8` 且删掉缺口注释与 `pending` 标签 | AC-11：`check-alerts.mjs` 报「清单外指标 yxs_token_quota 被当作现存指标」；AC-10 规则字段完整性同时不通过 | 恢复替代口径与缺口注释，自检通过 |

mutation 判据沿用 killed / survived 口径：用例变红 = killed，仍绿 = survived（说明用例没覆盖到这条契约）[R11]。直方图类 mutation（M3）必须落到桶清单比对上，而不是看平均值变化 [R6]。

## 6 排查表

| 症状 | 最可能原因 | 一条命令确认 |
|---|---|---|
| 预检即退出，基础设施失败退出码 1 | 服务端没起 / 端口不是 18080 | `curl.exe -s -i http://127.0.0.1:18080/health`；`Test-NetConnection -Port 18080` |
| 登录 401 批量失败 | 隔离 home 里没建测试学生，或口令与配置不一致 | 查看被测实例 `auth.db` 所在目录；对比 `--password` 与建学生命令 |
| 报告 `metricsScrape.missing` 整列缺失 | `/metrics` 未暴露 §9.2 指标，或地址 / token 不对 | `curl.exe -s -H "Authorization: Bearer $env:YXS_METRICS_TOKEN" http://127.0.0.1:18080/metrics | Select-String "yxs_"` |
| `/metrics` 返回 401 | 服务端配了 `YXS_METRICS_TOKEN`，F 侧未带或不一致 | 对比两侧 `YXS_METRICS_TOKEN` / `--metrics-token`；不带 token 手抓一次看状态码 |
| 首 token 恒为 0 或异常小 | 计时起点取在 `session` 帧之后，或把元数据帧算成首字 | 查 `src/client.mjs` 首 token 终点是否为首个非空 `text` 帧；对照 `sse/<requestId>.txt` 帧序 |
| 客户端 P95 远高于服务端直方图 P95 | 压测机自身瓶颈（CPU / 内存 / 排队），不是服务端慢 | 对比报告 `meta.client.cpuSec/rssMb` 与排队时间；服务端侧取 `yxs_http_request_duration_seconds` 直方图复算 |
| busy 计数恒 0 | 本档并发未触发锁冲突，或指标未被服务端包装层捕获 | 60 并发写路径跑完后 `curl /metrics | Select-String sqlite_busy`；为 0 时报告注明「未观察到 BUSY」 |
| 桶数量 ≠ 12 | 服务端用了默认桶，或 stub 桶清单被改 | 解析 `*_bucket{le=...}` 行，比对冻结 §9.2 的 12 个边界 |
| `promtool check rules` 找不到命令 | 本机未装 Prometheus 工具链 | `Get-Command promtool`；缺失则按 AC-10 跑 `node tools\loadtest\scripts\check-alerts.mjs` 兜底并标 `skipped` |
| real 模式首轮即崩 | 缺 `DEEPSEEK_API_KEY` 或 Key 无效 | 检查环境变量；按 03 §6 归入 real 前置失败，不按 mock 口径判 |

指标类症状必须落到 `/metrics` 原始快照上核对，不看平均值下结论 [R6]；规则表达式能力边界（`rate`/`increase`/`histogram_quantile`/`sum by`）以 Prometheus 规则引擎为准 [R12]。

## 7 自检输出

文档自检是「交活前的最后一道机器闸」：只查结构与引用是否对得上，查不到内容对不对——内容由 §3 的 14 条 AC 负责。这种「机器查形式、人查语义」的分工是测试实践里反复强调的底线 [R11]。

```powershell
cd E:\Documents\GitHub\YingXiaoShang
python plans\server-client-split\00-master\check-docs.py --round F
```

```text
仓库根：E:\Documents\GitHub\YingXiaoShang
检查轮次：F
行数统计：
  F-*: 1202 行 / 4 份

全部通过：轮次齐全、节数达标、每节有引用、参考清单与本地行号引用都对得上。
退出码：0
```

（实跑时间 2026-11-19，退出码 0；行数统计会随文档微调变化，以最后一次 `check-docs.py --round F` 为准。若后续重跑仅报 01/02 相关问题，属并行期状态，由主代理在四份齐备后重跑回填。）

## 参考

- [R1] k6 文档 — https://grafana.com/docs/k6/latest/ — 支撑 §2 前置的 VU 场景与并发档位口径 — 借鉴场景组织；不引入 k6 运行时。
- [R2] Gatling — https://github.com/gatling/gatling — 支撑 §3 报告分位数与每用户明细维度 — 借鉴汇总结构；不引入 Scala 栈。
- [R3] alexfernandez/loadtest — https://github.com/alexfernandez/loadtest — 支撑 §4 逐请求统计与可导出报告 — 借鉴并发数 + 延迟直方图；不照搬其 CLI。
- [R4] Prometheus 告警实践 — https://prometheus.io/docs/practices/alerting/ — 支撑 §3 AC-10/11 的症状告警与 `for` 口径 — 采用「报症状 + 持续时间」；不做因果推断。
- [R5] Prometheus 告警规则语法 — https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/ — 支撑 §3 AC-10 规则字段合法性 — 直接采用 `expr`/`for`/`labels`/`annotations`。
- [R6] Prometheus 直方图与分位数 — https://prometheus.io/docs/practices/histograms/ — 支撑 §1、§3 AC-04/09、§5 M3、§6 排查的分位数与桶口径 — 采用 `histogram_quantile` 与排序分位数；禁用平均值。
- [R7] 12-Factor · Logs — https://12factor.net/logs — 支撑 §4 证据落盘与日志不含敏感字段 — 采用事件流落盘；不引入日志聚合。
- [R8] Server-Sent Events（WHATWG 规范） — https://html.spec.whatwg.org/multipage/server-sent-events.html — 支撑 §3 AC-04 首 token 帧序判据 — 采用 `event:`/`data:` 帧格式；不实现重放。
- [R9] fortio — https://github.com/fortio/fortio — 支撑 §6 压测机瓶颈判别与延迟分布记录 — 借鉴 QPS/延迟直方图维度；不引入 Go 运行时。
- [R10] HdrHistogram — https://github.com/HdrHistogram/HdrHistogram — 支撑 §3 AC-04 分位数样本量与低样本标记思路 — 借鉴高动态范围分位数；F 样本量百量级，数组排序即可。
- [R11] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §1 可机器判定口径、§3 用例写法、§5 mutation 范式与 §7 自检分工 — 采用可执行断言；不引入其全部工具链。
- [R12] Prometheus 主仓库 — https://github.com/prometheus/prometheus — 支撑 §6 排查表规则表达式能力边界 — 参照规则引擎对 `rate`/`increase`/`histogram_quantile` 的支持；不在 F 侧部署服务。
