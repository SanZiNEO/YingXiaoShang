# F · 压测 + 可观测性 · 范围与边界

> 轮次：F · 压测 + 可观测性
> 文档角色：01-scope
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1（§9.1 日志、§9.2 指标与桶、§9.3 告警阈值逐字取用）
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1、§3
> 一句话：在不改动服务端一行代码的前提下，用 40–60 个并发学生把 `apps/server` 压一遍，产出带分位数、首 token 延迟、错误率、`SQLITE_BUSY` 计数与每学生 token/turns 的 md + json 报告，并交付一份可被 `promtool` 校验的告警规则文件。

## 1 目标

1. **40–60 并发学生全链路场景可跑**：每个虚拟学生依次走「登录 → 提问（SSE）→ 出题 → 交卷 → 回读成绩」，场景编排固化在 `tools/loadtest/scenario.mjs`。
   判断标准：`--students 40` 与 `--students 60` 两档都能跑完一轮；报告 `summary.requestsTotal` 等于各场景调用次数之和；每个学生都有一条 `perStudent` 记录。并发虚拟用户（VU）模型与「脚本 + 阈值」的组织方式参照 k6 的场景思路 [R39]。
2. **`YXS_LLM=mock` 默认可断网跑，`real` 为可选加跑**：默认目标连本机服务端的 mock 实例；只有显式传 `--llm real` 且环境具备 `DEEPSEEK_API_KEY` 时才走真实模型。
   判断标准：断网状态下 mock 模式一轮跑完无 `UPSTREAM_FAILED`；real 模式缺 Key 时在报告里标记 `llmMode=real` 且相关轮次计入错误率，而不是进程崩溃。
3. **报告出齐冻结口径要求的指标**：HTTP/RPC 延迟 P50/P95/P99、SSE 首 token 延迟分位数、错误率、`yxs_sqlite_busy_total` 增量、每学生 tokens（prompt/completion）与 turns。
   判断标准：json 报告里 `summary.latency`、`summary.firstToken`、`summary.errorRate`、`summary.sqliteBusyTotal`、`perStudent[].tokensPrompt/tokensCompletion/turns` 字段齐全；分位数由样本排序计算，不用平均值代替 [R44]。
4. **双格式报告落盘**：Markdown 报告给人读，JSON 报告给脚本/契约测试二次消费；两者同源，数字一致。
   判断标准：`.scratch/run/F/report/` 下同时出现 `loadtest-report.md` 与 `loadtest-report.json`；md 里的 P95、错误率、busy 次数与 json 同名字段相等。
5. **交付 5 条 Prometheus 告警规则**：`tools/loadtest/prometheus/alerts.yml`，规则名、表达式要点、`for`、级别与冻结 §9.3 逐条对齐，能通过 `promtool check rules`。
   判断标准：`promtool check rules tools/loadtest/prometheus/alerts.yml` 退出码 0；5 条规则与 §9.3 表一一对应。告警只报症状、用 `for` 抑制抖动，遵循 Prometheus 告警实践 [R42]。
6. **只读消费服务端可观测性面**：F 只 `GET /metrics`、`GET /health` 与业务端点，不新增、不改名、不重算任何服务端指标；指标名与桶以冻结 §9.2 为唯一真相源。
   判断标准：F 的代码与文档里出现的 `yxs_*` 指标名，逐条能在 §9.2 的 10 个指标清单里找到；清单之外的名字只出现在「缺口与替代口径」说明里。
7. **内置 stub 目标，A 未就绪时 F 自洽可跑**：除了连真实/本机服务端，F 自带一个内存 stub，按冻结信封回登录、RPC、SSE、作答、健康检查与 `/metrics`，用于并行期自检与规则演练。
   判断标准：`--target stub` 不依赖 `apps/server` 进程即可跑完一轮并出报告；stub 的响应形状与冻结 §4、§7 对齐，避免「stub 绿了、真机红了」的口径错位。轻量并发模型与延迟直方图参照 Node 侧 loadtest 工具的做法 [R41]。

## 2 非目标

| 不做 | 为什么不做 |
|---|---|
| 不实现、不修改服务端路由、指标暴露与日志格式 | 那是 A 轮写权（`02-ownership-and-parallel.md` §1）；F 只消费 `/metrics` 与业务端点，改服务端会破坏 E 的契约基线 |
| 不做分布式/多机压测、不做录制回放、不做持续压测平台 | 本轮目标是单机能复现的基线分位数与告警演练；分布式压测需要独立的调度与采样口径，超出 40–60 并发的本地场景 |
| 不调优 SQLite 并发参数（WAL、`busy_timeout`、连接池） | 属于 A/D 轮的数据读写域；F 只采集 `yxs_sqlite_busy_total` 观察现象，不替服务端改配置 |
| 不做真实成本核算与账单对账 | mock LLM 的 usage 是固定值（A 轮 mock 口径 `prompt_tokens:100,completion_tokens:50`），与真实计费口径不同；F 只汇总 token 计数，不出费用结论 |
| 不做浏览器端性能、不做 Electron 端到端回归 | Web Vitals 归前端，Electron 场景归 H 轮；F 的测量面是 HTTP/SSE 服务端链路 |
| 不改 `packages/**`、`apps/desktop/**`、`docs/contracts/openapi.yaml`、根 `pnpm-lock.yaml` | 写权矩阵 §1 的禁区；F 需要共享文件变更时只在本文档「需要 owner 配合的变更」里写建议 diff |
| 不跑 docker / compose，不写真实数据目录 | 禁区见 `05-writing-brief.md` §6；F 的临时库与产物全部落在 `.scratch/run/F/` |
| 不做模型降级链、多 provider 路由 | 那是模型运行时域（R18 后续项）；F 只在 `mock` / `real` 两档之间切换 |

场景编排上不引入 k6/Gatling 的运行时：借鉴它们的 VU 与报告结构，但用 Node 自研脚本，便于复用冻结信封与登录逻辑 [R39][R40]。

## 3 真实依据（现状代码证据）

> 行号以 2026-11-19 的 `main` 分支为准；下表每条都回答「这段代码现在干什么、为什么会影响 F 的压测口径」。

| # | 位置 | 现状是什么 | 对本轮的影响 |
|---|---|---|---|
| 1 | `apps/desktop/src/main/llm.ts:84-87` | `endpoint()` 从 `DEEPSEEK_BASE_URL` 拼 `/chat/completions`，默认官方地址 | `real` 模式的首 token 与错误率受外部端点影响；报告必须记录 `llmMode` 与目标 baseUrl，mock 与 real 的数字不可混排 |
| 2 | `apps/desktop/src/main/llm.ts:89-202` | `DeepSeekLlm.stream()` 产出 `block-start` / `text-delta` / `tool-call-delta` / `block-end` / `finish` / `usage` 六类 chunk | F 内置 stub 与 SSE 解析必须识别同一套 chunk/事件形状；首 token 只能认第一个带正文的事件，不能把 `session`/`round` 帧算成首字 |
| 3 | `apps/desktop/src/main/llm.ts:120`、`:146-147` | 请求带 `stream_options.include_usage: true`，流末解析 `payload.usage` 并 yield `{type:'usage', usage}` | token 汇总的唯一来源是流末 usage 事件；mock 若不发 usage，F 侧只能按兜底口径估算并在报告里标注，不能记成真实用量 |
| 4 | `apps/desktop/src/main/llm.ts:94` | 无 Key 时抛英文 `DEEPSEEK_API_KEY is not configured` | real 模式缺 Key 是可预期失败路径；F 必须把这类失败映射进错误分类，而不是让进程以未捕获异常退出 |
| 5 | `packages/agent/src/tool-loop.ts:136-145` | `AgentLoopResult` 含 `text/rounds/called/calls/context`，**没有 token 用量字段** | 每学生 turns 可由结果 `rounds` 与 SSE `done` 事件计数；tokens 不能从 loop 结果取，必须回服务端指标 `yxs_tokens_total` |
| 6 | `packages/agent/src/tool-loop.ts:147-154` | `LoopContextStats` 只统计字符数（`toolsChars/messageChars/...`），不统计 token | 字符数与 token 数不可互换；报告里若要给字符量只能作为辅助字段，禁止用字符数冒充 token 数 |
| 7 | `packages/agent/src/tool-loop.ts:112-128`、`:234`、`:382` | `AgentLoopInput.signal` 透传 `AbortSignal`，循环两处检查 `aborted` 并抛「已停止」 | 压测场景需要覆盖取消路径（`chat/cancel`）；F 记录被取消轮次的状态时必须区分「主动取消」与「超时/失败」 |
| 8 | `apps/desktop/src/main/health.ts:23-35` | `startupHealth` 按章节 0 / 知识点 0 / 新闻 0 产出 `warnings` 与 `notices` | F 开跑前先打 `/health` 做前置自检；库里章节为 0 时报告要带 warning，避免在空库上压出无意义的延迟分位数 |
| 9 | `apps/desktop/src/main/errors.ts:59-60`、`:33-35` | 错误翻译把 `SQLITE`/`database is locked` 归为本地写入失败；把 `402/insufficient/balance/quota` 归为额度不足 | `SQLITE_BUSY` 类失败在响应里有对应中文提示；额度不足类错误是「token 用量 80%」告警的现实背景，也是 §9.3 第 3 条缺口的出处 |
| 10 | `apps/desktop/src/main/errors.ts:13-18` | `friendlyError` 按 `context: 'chat' | 'answer'` 给不同的重试提示 | F 统计错误率时按场景区分聊天轮次与作答轮次；回答类失败的文案与聊天类不同，断言与归类不能混用 |
| 11 | `packages/agent/src/team.ts:17-19` | `TeamEvent.type` 只有 `round|text|tool|tool-end|session` 五种 | SSE 事件名以这五种 + 传输层 `done`/`error` 为准；F 的 SSE 客户端只认这套事件，遇到未知事件记入告警样本而不是崩溃 |
| 12 | `docs/requirements/R18-model-runtime.md` §7 第 7 条 | 现状事实：`usage` 事件被适配器发出，但界面只显示调用次数，token 用量没有落地汇总 | 这正是 F 要补的观测面：按学生汇总 prompt/completion tokens；同时也说明仓库内目前没有现成的 token 汇总实现可复用 |

这 12 条共同指向一个约束：**F 的所有统计口径必须能回指到现有代码事实或冻结契约**，不能凭界面印象造指标名 [R44]。

## 4 与现行为的差异（有意收紧/放宽）

| 项 | 现状（桌面单体，单机单学生） | F 压测口径 | 影响谁 |
|---|---|---|---|
| 并发模型 | 一个 Electron 进程对一个当前学生，IPC 调用 | 40–60 个虚拟学生并发打 HTTP/SSE，各自持 token | 服务端并发承载；E 的契约测试不承压，不做此口径 |
| 身份与归属 | 本机约定，`studentId` 显式传参 | 每个虚拟学生先登录拿 token，后续请求只带 `Authorization: Bearer`；请求体里的 `studentId` 按冻结 §3.2 忽略 | 压测脚本必须实现登录闭环，不能复用固定学号直连 |
| 延迟度量 | 界面无分位数概念 | 客户端侧采样每请求起止时间，算 P50/P95/P99；服务端直方图用于 `/metrics` 复核，两侧口径并列展示 | 报告读者；分位数算法在 `02-contract.md` §3 写死 |
| token 汇总 | 只在流末 usage 事件出现，不落库、不汇总 | F 从 `/metrics` 的 `yxs_tokens_total{student_id,kind}` 按学生汇总；usage 事件只作交叉核对 | 报告的每学生 token 字段 |
| 失败归类 | `friendlyError` 翻成中文上屏 | F 把失败分成 5xx / 4xx / 业务 `ok:false` / SSE `error` / 取消 / 超时六类，错误率分母是全部请求 | 告警与报告判读；4xx 不计入 5xx 率告警 |
| mock 与 real 数字 | 人工在设置里切模型，无对照记录 | 报告分 `llmMode` 两栏；mock 的固定 usage 与 real 的真实 token 不合并平均 | 成本与容量判断；见 §7 风险 R2 |

> 这些差异是「压测观测」对「单机交互」的有意收紧：对外暴露的 HTTP 面需要并发与分位数口径，而单机 IPC 场景从来没有这些概念。差异条目写进 `02-contract.md` 供自测逐条对照。分位数与错误率口径之所以要在本轮先定死，是因为平均值会把长尾抹平，掩盖 SSE 卡顿 [R44]。

## 5 产物清单

> 写权依据：`02-ownership-and-parallel.md` §1，`tools/loadtest/**` 唯一 owner 是 F。以下路径均为新建；`tools/loadtest/README.md` 是本轮交付物之一，但本目录原始 `README.md`（轮次需求基线）保持原样不改写。

```text
tools/loadtest/
  package.json                  独立包；pnpm install --ignore-workspace（不在 pnpm-workspace 三条 glob 内）
  scenario.mjs                  CLI 入口：解析参数 → 选目标(http/stub) → 编排场景 → 汇总 → 出报告
  src/client.mjs                HTTP/SSE 客户端：登录、RPC、chat/stream、answer、answer-set、cancel；计时与采样
  src/scenario.mjs              虚拟学生编排：登录→提问→出题→交卷→回读；并发 VU 调度与 ramp-up
  src/stub.mjs                  内置 stub：内存实现冻结信封 /health /metrics /rpc /chat/stream /answer /answer-set
  src/metrics.mjs               抓取 /metrics 文本，解析 10 个 yxs_* 指标，busy 增量与 token 汇总
  src/summarize.mjs             样本排序算 P50/P95/P99、错误率、每学生聚合；产出报告数据对象
  src/report.mjs                由报告数据对象生成 loadtest-report.md 与 loadtest-report.json（同源）
  config/loadtest.example.json  示例配置：并发数、场景开关、阈值引用、stub 开关；不含真实 Key
  prometheus/alerts.yml         5 条告警规则（冻结 §9.3），promtool 可校验
  README.md                     怎么跑、参数表、报告字段说明、mock/real 区别、已知失真
scripts/
  check-alerts.mjs              本机自检：alerts.yml 可解析、5 条规则齐全、指标名在 §9.2 清单内（promtool 不可用时兜底）
```

运行期临时产物（不进版本库）：

```text
.scratch/run/F/home/           被测 stub/服务端实例的临时 appHome（LEARNING_AGENT_HOME），含临时 learning.db 副本与 auth.db
.scratch/run/F/report/         loadtest-report.md / loadtest-report.json / 原始 /metrics 快照
```

需要引用但**不写**的既有面：冻结 §9.2 的 10 个指标由 A 在 `/metrics` 暴露；F 只解析文本，不负责指标落地。目录按「入口 / 客户端 / 编排 / stub / 指标 / 报告」分层，参照单职责工具的组织方式 [R41]；报告结构（分位数 + 每用户明细）参照 Gatling 的汇总维度，但不引入 Scala 运行时 [R40]。

## 6 并行边界（5 条编号自证）

| 项 | 值 |
|---|---|
| 只读依赖 | `packages/*`（只读 import 类型/事件形状）、`apps/desktop/src/main/llm.ts` 与 `errors.ts`（只读对照 chunk 与文案）、冻结 §4/§5/§7/§9；`/metrics` 与 `/health` 由 A 实现，F 只读抓取 |
| 写权唯一 | `tools/loadtest/**`、`.scratch/run/F/**`；除此之外的仓库文件一律只读 |
| 运行时资源 | 端口 `18080`（被测服务/stub）；被占按 +100 退避到 `18180`、`18280` 并在报告写明实际端口；临时 home `.scratch/run/F/home/`；不碰 `.learning-agent`、`%APPDATA%` |
| 与 A 的接口 | 薄接口 = 冻结 §9.2 指标名/标签/桶 + §4 信封 + §7 事件序列；A 未起时 F 用内置 stub，不阻塞开工 |
| 与 E 的接口 | 无直接进程依赖；两者都可能连本机服务端实例，E 用随机端口、F 用 18080，互不抢端口 |
| 与 G 的接口 | 无；G 的备份目录与 PG 端口（55433）与 F 无关 |

**自证 1：只读依赖**。F 对服务端的全部依赖是 `GET /metrics`、`GET /health` 与业务端点；指标名、标签、桶边界逐字取自冻结 §9.2，F 不读取 A 的源码产物（`openapi.yaml` 只读不写）。若 A 实现的指标名与冻结清单不一致，以冻结为准并在报告「差异」节登记，F 不改名适配。

**自证 2：写权唯一**。F 新建/修改的文件全部位于 `tools/loadtest/**` 与 `.scratch/run/F/**`；`apps/server/**`、`docs/contracts/openapi.yaml`、`packages/**`、`apps/desktop/**`、根 lockfile 一律不写。需要 owner 配合的变更（例如补一个 F 侧想要的指标）按 `02-ownership-and-parallel.md` §1 约定，只在本文档列出建议 diff，不直接改。

**自证 3：运行时资源隔离**。F 固定使用 `18080` 端口与 `.scratch/run/F/home/` 数据目录；与 A 的 `8080`、D 的 `55432`、G 的 `55433` 不冲突。端口占用时按 §3 的 +100 退避，不 kill 不明进程；临时库从仓库 seed 副本复制，绝不读写用户真实数据目录。

**自证 4：不依赖他轮产物即可开工**。A 的服务端未就绪时，`--target stub` 在 `tools/loadtest/src/stub.mjs` 内自洽实现全部被测端点；F 的场景编排、报告 schema、告警规则都能对着 stub 先开发与自检。连真机实例属于可选加跑，不是开工前置条件——这与 E 轮「stub 先行、真机联调可选」的并行约定一致（`02-ownership-and-parallel.md` §2、§6）。

**自证 5：冲突裁决**。文件被非 owner 修改：F 在自己的验收文档记录外部改动并重新验证，不擅自回滚；契约冲突以冻结文件为准，实现做不到时写「契约例外申请」到本文档 §7；端口冲突按 +100 退避；指标/告警口径与冻结冲突时先改冻结文件并按 §12 登记版本，F 不私自放宽阈值。告警规则与指标名是 F 与 A 之间唯一需要共同遵守的薄接口，接口稳定性参照 Prometheus 规则契约的做法 [R42]。

## 7 未知与风险

| # | 风险 | 口径与验证方法 |
|---|---|---|
| R1 | **stub 与真服务端口冲突**：并行期同一台机器上 A 的实例、E 的用例与 F 的 stub 都可能监听本机端口，18080 被占用时首轮可能起不来 | 启动前先探测端口；被占按 18180/18280 退避，报告 `meta.target.port` 记录实际端口。验证方法：`Test-NetConnection -Port 18080` 预检；报告里出现退避端口即说明发生过冲突，需在复核时确认占用者身份 |
| R2 | **mock LLM 与真实 token 计费口径不同**：mock 的 usage 是固定值（`prompt_tokens:100,completion_tokens:50` 量级），real 模式的 prompt 含历史消息与工具 schema，token 数显著更高；两档数字不能合并平均 | 报告按 `llmMode` 分栏，json 里 `summary.tokens` 带 `mode` 字段；跨模式对比只比延迟与错误率，不比 token 总量。验证方法：同一脚本分别跑 mock 与 real，对比 `perStudent[].tokensPrompt` 分布；若 mock 栏 token 全为固定值，属预期，不记为缺陷 |
| R3 | **SSE 首 token 在本地回环上失真**：`127.0.0.1` 无网络往返，首 token 延迟主要由进程内调度决定，不能代表局域网/公网真实首字节时间 | 报告 `meta.caveats` 固定写明「首 token 延迟测自本机回环，仅用于回归对比，不代表生产网络」；首 token 分位数与服务端 `yxs_sse_first_token_seconds` 直方图并列展示以便复核。验证方法：对比客户端采样首 token 与服务端直方图 P95，二者差距应在回环调度误差内；差距过大说明采样点取错 |
| R4 | **`yxs_token_quota` 指标缺失**：冻结 §9.3 第 3 条告警表达式用到 `yxs_token_quota`，但 §9.2 的 10 个指标清单里没有这个指标；它不是既有指标，不能默默照抄进 `alerts.yml` | 双轨处理：① `alerts.yml` 中该规则默认使用 F 侧替代口径——按学生汇总 prompt token 与配置常量配额比较，规则注释里保留冻结原表达式与缺口说明；② 登记为「待 A 轮补指标」：`yxs_token_quota` 应由服务端以 gauge 暴露（按学生或全局配额），补齐后按冻结 §12 变更规则恢复原表达式。口径差异在 `02-contract.md` §4 逐条写明。验证方法：`promtool check rules` 通过；grep 确认替代规则表达式不引用清单外的现存指标名；若 A 后续补上该指标，核对注释里的原表达式可直接还原 |
| R5 | **`/metrics` 未就绪时抓空，报告假绿**：A 实例未暴露 §9.2 全部指标时，F 抓到空样本会把分位数算成 0、busy 记成 0 | 抓取后校验 10 个指标名是否出现；缺失指标在报告 `metricsScrape.missing` 列出，该轮 verdict 标 `incomplete` 而非 `green`。验证方法：对 stub 跑一轮应全绿；对未暴露指标的旧实例跑一轮应出现 `missing` 清单 |
| R6 | **并发写同一临时 SQLite 副本触发 `SQLITE_BUSY`**：40–60 路并发包含 `profile.snapshot`、`memory.upsert`、作答落库等写路径，临时库可能出现锁冲突 | 以 `yxs_sqlite_busy_total` 增量为观测值，不在 F 侧调 `busy_timeout`；报告单列 busy 次数与对应时段。验证方法：60 并发跑完后读指标增量；若为 0，记录「本档并发未观察到 BUSY」，不推断生产也为 0 |
| R7 | **stub 的延迟与行为不代表真实服务端**：内存 stub 无 DB、无模型调用，压出的延迟分位数只用于验证 F 工具链与规则，不能作为服务端性能基线 | 报告 `meta.target` 标明 `stub` 或 `http`；stub 轮次的延迟数字不进入性能结论。验证方法：stub 轮首 token 应接近进程内调度量级；出现网络级延迟说明目标连错 |
| R8 | **样本不足时分位数不稳定**：并发档位低或失败轮次被剔除后，某场景样本量过小，P95/P99 抖动大 | 报告每个分位数附 `sampleCount`；样本数低于阈值（默认 30）时分位数标 `low-sample`，不参与红绿判定。验证方法：json 报告里 `latency.sampleCount` 与原始样本条数一致 |
| R9 | **real 模式外部依赖不可控**：真实模型限流、超时、余额不足会污染本轮基线，且结果不可复现 | real 模式为显式加跑；失败按 §4 错误分类计入错误率，报告保留 `requestId` 便于对照服务端日志。验证方法：real 轮次出现 `UPSTREAM_FAILED` / `TIMEOUT` 时，报告错误分类与冻结 §4.2 码表一致 |

风险 R3、R5、R8 都依赖「样本与指标能被量到」：没有直方图与原始样本留存的风险只能靠猜，这与直方图实践对可观测性的要求一致 [R44]；规则表达式可用的 `rate`/`increase`/`histogram_quantile` 范围以 Prometheus 规则引擎为准 [R45]。

## 参考

- [R39] k6 文档 — https://grafana.com/docs/k6/latest/ — 支撑 §1 目标 1 的 VU 模型与「脚本 + 阈值」组织 — 借鉴并发虚拟用户与场景分层；不引入 k6 运行时（F 用 Node 自研）。
- [R40] Gatling — https://github.com/gatling/gatling — 支撑 §5 报告结构（分位数 + 每用户明细）— 借鉴汇总维度；不引入 Scala 栈。
- [R41] alexfernandez/loadtest — https://github.com/alexfernandez/loadtest — 支撑 §1 目标 7 与 §5 的轻量并发模型、延迟直方图 — 借鉴并发数 + 逐请求统计；不照搬其 CLI 形态。
- [R42] Prometheus 告警实践 — https://prometheus.io/docs/practices/alerting/ — 支撑 §1 目标 5 与 §6 自证 1 的症状告警、`for` 抑抖 — 采用「报症状 + 持续时间」；不做因果推断类告警。
- [R43] Prometheus 告警规则语法 — https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/ — 支撑 §5 `prometheus/alerts.yml` 的字段合法性 — 直接采用 `expr`/`for`/`labels`/`annotations` 字段，不自创字段名。
- [R44] Prometheus 直方图与分位数 — https://prometheus.io/docs/practices/histograms/ — 支撑 §1 目标 3、§3 引言与 §7 R8 的分位数口径 — 采用 histogram 与排序分位数；禁止用平均值代替 P95/P99。
- [R6] 12-Factor · Logs — https://12factor.net/logs — 支撑 §3 现状证据与报告对账思路 — 采用「日志/指标当事件流、stdout 单行 JSON」；不引入日志聚合服务。
- [R45] Prometheus 主仓库 — https://github.com/prometheus/prometheus — 支撑 §7 R4 缺口处理与告警规则可校验性 — 参照其规则引擎对 `rate`/`increase`/`histogram_quantile` 的支持范围；不在 F 侧部署 Prometheus 服务。
