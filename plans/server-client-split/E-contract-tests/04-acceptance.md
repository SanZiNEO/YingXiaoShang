# E · 契约测试 · 验收

> 轮次：E · 契约测试
> 文档角色：04-acceptance
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1
> 一句话：14 条 AC 全部可命令复现；覆盖矩阵、SSE 顺序、非法消息逐字比对与 3 条 mutation 红→还原→绿，缺一不算过。

## 1 验收口径

**过 = 下列三组同时成立**：

1. **硬指标**：30 个业务方法全覆盖且每方法 ≥2 条用例；4 个 legacy 各 ≥1 条；5 类非法用例齐全；SSE 顺序与 `done` 唯一性断言通过；`coverage` 三判据全绿（openapi 缺失时按冻结 §8 标 `pending`，不算红）；`--target stub` 自洽可跑、退出码 0。
2. **反向验证**：§5 的 3 条 mutation 各自「应用 → 指定 AC 变红 → 还原 → 变绿」，过程与输出落盘。
3. **证据**：每条 AC 在 `tools/contract-tests/report/<时间戳>/` 留下 JSON 汇总、单条用例证据、SSE 原始帧与运行日志，可按同一命令复跑。

不可替代项（不能用「手工点过一遍」代替）：method 枚举恰好 30、中文错误消息逐字比对、`done` 只出现一次、越权 403 不泄漏存在性、mutation 确实杀死用例。

「可机器判定的才算验收」这条口径来自测试实践：断言写成可执行检查，失败判据必须是可观察的输出，而不是人工印象 [R3]。契约测试用例与被测传输解耦，使同一套断言能复用到 http、electron、stub 三个目标 [R8]。

## 2 前置条件

```powershell
cd E:\Documents\GitHub\YingXiaoShang

# 1) E 包独立安装（不进根 workspace，不动根 lockfile）
cd tools\contract-tests
pnpm install --ignore-workspace
cd ..\..

# 2) 隔离数据（禁止使用真实数据目录）
New-Item -ItemType Directory -Force .scratch\run\E\home-1\data | Out-Null
# 有种子库时复制副本；无种子库则依赖只读方法与空库 fixture，相关章节数断言放宽为 >= 0
Copy-Item .scratch\sample-home\data\learning.db .scratch\run\E\home-1\data\learning.db -ErrorAction SilentlyContinue

# 3) http 目标前置：A 轮服务端已在本地起 mock 实例（可选加跑；stub 不依赖它）
$env:YXS_LLM = 'mock'
# 服务端默认 http://127.0.0.1:8080；换地址用 --base-url 覆盖

# 4) 跑 stub 自洽基线（断网可跑）
node tools\contract-tests\run.mjs --target stub
```

缺什么就明说「缺则跳过并标记」：

- 服务端没起 → http 目标用例标 `blocked`，退出码 2 的前置提示见 03 文档 §6；stub/electron 目标不受影响。
- `docs/contracts/openapi.yaml` 缺失 → `coverage` 输出 `openapi: missing`，按冻结表降级核对，报告标 `pending`，退出码 0。
- 拿不到 `.scratch/run/electron.lock` 互斥锁 → electron 整组标 `skipped`，报告写明原因，不计失败。
- 没有打包产物或种子库 → electron 启动类用例跳过；只读方法用例照常跑。

Electron 目标复用 `tools/automated-testing` 现有 `node_modules`（`@playwright/test` 1.64.1，见 `tools/automated-testing/package.json:16`），E 包不重复安装 Playwright [R1]。

## 3 用例清单

| 编号 | 操作步骤 | 期望输出 | 失败判据 | 证据文件 |
|---|---|---|---|---|
| AC-01 | `node tools\contract-tests\run.mjs --target stub` | 退出码 0；stub 用例全绿；`report/<时间戳>/report.json` 生成且 `summary.passed = summary.total` | 退出码非 0；报告缺失；有用例 `failed` | `report.json`、`run.log` |
| AC-02 | `node tools\contract-tests\coverage.mjs` | 三判据全绿：method 枚举恰好 30；5 通道 path 齐全；4 legacy 在 `x-legacy-methods`；`components.schemas` ≥30 个 `<Method>Result`。openapi 缺失时 `pending` 且退出码 0 | 枚举多/少项；legacy 误入枚举；缺通道 path；schema 命名不符；缺失时误判红 | `coverage.json` |
| AC-03 | 打开 `report.json` 覆盖矩阵 | 30/30 方法各有 ≥2 条用例（合法 + 非法/边界各至少 1）；无方法落空 | 任一方法用例数 <2；矩阵缺方法名 | `report.json` 覆盖矩阵段 |
| AC-04 | 逐方法跑合法输入用例（http 或 stub） | 响应 `ok:true`；顶层字段与冻结 §5 表一致（数组/对象/标量形态）；`requestId` 服务端必回 | `ok:false`；顶层结构不符；缺 `requestId` | `cases/<method>-ok.json` |
| AC-05 | 跑 4 个 legacy：`getKp`、`getBlock`、`getResource`、`listIdeology` | 4/4 `ok:true`，字段齐全；覆盖统计里 legacy 单列，不计入 30 方法数 | 任一 `UNKNOWN_METHOD`；legacy 被计入 30 统计 | `legacy.jsonl` |
| AC-06 | 跑 5 类非法用例：缺字段、类型错、资源不存在、越权、未知方法 | 每类 ≥1 条；状态码与 `error.code` 对齐冻结 §4.2；中文消息逐字匹配（如 `articleId 不能为空。`、`limit 必须是整数。`、`没有找到这条记录，可能已被删除。`、`这个资源不属于当前学号，换回自己的账号再试。`、`没有这个方法：foo.bar`） | 任一类缺失；消息只做包含匹配；状态码/码不符；越权返回空数组泄漏存在性 | `invalid/*.json` |
| AC-07 | `--target http`（或 electron）发一轮对话，收集 SSE 帧 | 首帧 `event: session` 且含 `sessionId/requestId`；中间 `round/text/tool/tool-end` 有序到达；`done` 恰好 1 次且含 `turnId/sessionId/text/artifacts/citations/warnings` | 首帧不是 `session`；无 `done`；`done` 出现 ≥2 次；`done` 载荷缺字段 | `sse/ct-sse-01.txt` |
| AC-08 | 发起一轮对话后 `POST /chat/cancel` 传 `requestId` | 最多 1 个 `error(code=CANCELLED)`；此后静默窗口内不再出现 `text` 增量；`cancel` 对不存在的 `requestId` 返回 `cancelled:false` 且仍 200 | 取消后继续产 `text`；无 `error` 帧；HTTP 裸断无事件；不存在 requestId 报错 | `sse/ct-sse-cancel.txt` |
| AC-09 | 出题拿 `artifactId` → `answer-set` 提交 → `questions.attempts` 回读 | 交卷 `ok:true` 且 `status` 为完成态；回读能查到本次作答；`answers` 为空数组时 `400`「这一卷还没有作答，先答一题再交。」 | 交卷 500；回读为空；空数组被接受 | `answer-set.json`、`attempts.json` |
| AC-10 | 不带 token 请求 `/health` 与 `/api/v1/health` | 均 `200`；`result.warnings` 为数组；`appHome` 为绝对路径 | 401；`warnings` 非数组 | `health-no-auth.json` |
| AC-11 | http 目标先登录再带 `Authorization: Bearer <token>` 调 RPC；另发一条不带 token 的请求 | 带 token 请求 `ok:true`；不带 token → `401 AUTH_REQUIRED`，消息 `请先登录。`；失效 token → `401 AUTH_INVALID`，消息 `登录已失效，请重新登录。` | 无 token 仍 200；消息不符；token 出现在报告正文 | `auth-required.json`、`auth-invalid.json` |
| AC-12 | `--target electron` 跑可用例组；静态检查 E 包源码 | 启动只经 `launchElectron` 封装；E 包内无 `import _electron`、无直接 `import '@playwright/test'`；抢不到锁时整组 `skipped` 并写明原因 | spec 直接启动 Electron；直接 import `_electron`；锁竞争下报错退出 | `electron-run.json`、源码 grep 记录 |
| AC-13 | 按 §5 逐条应用 3 个 mutation | 每条：应用后指定 AC 变红（失败输出落盘）→ 还原后同一条 AC 变绿；`git status --porcelain` 对 `apps/desktop`、`packages`、`docs/contracts` 为空 | 任一 mutation 用例仍绿（survived）；还原后未复绿；留下未还原改动 | `mutations/*.json`、`mutation-report.md` |
| AC-14 | 按 §4 路径检查证据目录并复跑一次 | 每条 AC 有请求/入参、期望、实际、断言差异、耗时；第二次复跑结果与首次同口径；日志不含 token、口令、消息正文 | 只有截图或口头结论；证据缺实际响应；二次跑依赖首次残留 | `report/<时间戳>/` 全目录 |

用例写法遵循「一条 AC 一个可观察结果 + 明确失败判据」，等待状态变化走事件收集器或轮询，不用固定 sleep [R3]。RPC 信封与错误对象字段对齐 JSON-RPC 单端点形态，但不做 batch [R6]。

## 4 证据落点

- **根目录**：`tools/contract-tests/report/<yyyyMMdd-HHmmss>/`（相对 E 包根；`--report` 可覆盖）。
- **文件清单**：

| 文件 | 内容 |
|---|---|
| `report.json` | 汇总：总数/通过/失败/跳过/pending，按 target 分组；每条用例 `caseId/method/expected/actual/durationMs/status` |
| `report.md` | 人读报告：覆盖矩阵、失败明细、mutation 记录、环境与端口 |
| `cases/<case-id>.json` | 单条用例：入参 fixture、期望错误码/消息、实际响应、断言差异 |
| `sse/<case-id>.txt` | SSE 原始帧（http 目标保留 `id/event/data/raw`；electron 目标保留事件序列） |
| `coverage.json` | 三判据结果、缺失/多出方法差集、legacy 列表、schema 命名清单 |
| `run.log` | 每用例一行结构化日志；不含 token、口令、消息正文、工具结果正文 |

- **复跑命令**（同一隔离 home 可重复；第二次跑前清理 `auth.db` 或换测试学生）：

```powershell
cd E:\Documents\GitHub\YingXiaoShang
node tools\contract-tests\run.mjs --target stub
node tools\contract-tests\run.mjs --target http --base-url http://127.0.0.1:8080
node tools\contract-tests\coverage.mjs
```

证据存「请求原文 + 响应原文 + 断言差异」而不是截图，失败可在 CI 里复盘；结构化日志每行一条事件，敏感字段不落盘 [R11]。

## 5 反向验证（mutation）

3 条 mutation 对应 02 契约的三处可改坏点；patch 存 `tools/contract-tests/mutations/*.patch`，是 E 轮临时 patch 流程，**不落地进被测代码**。每条流程固定为：应用 patch → 跑指定 AC → 记录失败输出 → 还原 patch → 重跑确认变绿。

| # | 改坏哪一处（patch 文件 → 被测位置，落点以 A 最终目录为准） | 预期变红的 AC | 还原后 |
|---|---|---|---|
| M1 | `mutations/m1-drop-done.patch` → `apps/server/src/chat/stream.ts`：移除 `done` 帧发送，流结束不发终态事件 | AC-07（无 `done` 帧 / `doneCount=0` 断言失败）；AC-14 的 SSE 证据随之缺终态帧 | 变绿 |
| M2 | `mutations/m2-loosen-limit.patch` → `apps/server/src/rpc/validate.ts`（或对应 `limit` 校验 handler）：去掉 `limit` 整数/上限校验，越界值放行 | AC-06 中类型错用例（`limit:"10"` 应 400 却被接受）；越界类若同分支被放开，一并变红 | 变绿 |
| M3 | `mutations/m3-enum-29.patch` → `docs/contracts/openapi.yaml`：method 枚举删除 1 项，30 → 29 | AC-02（枚举数量与冻结表差集非空，coverage 判红）；AC-03 对应方法在矩阵落空 | 变绿 |

执行约定：

```powershell
cd E:\Documents\GitHub\YingXiaoShang
git status --porcelain                      # 改前确认工作区干净（除 .scratch 与 report）
# 应用对应 patch → 跑 node tools\contract-tests\run.mjs --only <case-id> → 记录失败输出
git checkout -- <被测文件>                  # 还原；禁止用 git stash 清场
node tools\contract-tests\run.mjs --only <case-id>   # 确认变绿
git status --porcelain apps/server docs/contracts   # 必须为空（patch 已全部 revert）
```

mutation 判据用 killed / survived 术语：用例变红 = killed；仍绿 = survived，说明该用例没覆盖到这条契约。我们只维护 3 个手写 patch，不引入 mutation 运行时 [R12][R13]。

## 6 排查表

| 症状 | 最可能原因 | 一条命令确认 |
|---|---|---|
| `--target http` 启动即退出，提示服务端不可达 | 服务端没起或端口/地址不符 | `curl.exe -s http://127.0.0.1:8080/health`；对照 `--base-url` 取值 |
| `coverage` 标 `pending`、退出码 0 | `docs/contracts/openapi.yaml` 尚未落地（A 轮并行） | `Test-Path docs\contracts\openapi.yaml` |
| SSE 用例超时，日志「未收到 done」 | 中间层缓冲 / 服务端未发终态帧 / 等待超时阈值过短 | 看 `sse/<case-id>.txt` 最后一帧；`$env:YXS_SSE_TIMEOUT_MS` 现值 |
| 登录 401 但口令确定对 | 测试学生未建 / `auth.db` 指向隔离副本之外 | 检查 `.scratch\run\E\home-1\data\` 下是否有 `auth.db` |
| electron 整组 `skipped` | 未取得 `.scratch/run/electron.lock` 锁（H 轮在用） | `Test-Path .scratch\run\electron.lock`；报告 `report.md` 锁条目 |
| 静态检查报「直接 import _electron」 | E 包 target 代码绕过 driver 自启 Electron | `Select-String -Path tools\contract-tests\lib\*.mjs -Pattern "_electron|@playwright/test"` |
| 越权用例返回空数组而非 403 | 被测侧归属校验未按 token 解析身份 | 复核响应 `error.code`；对照冻结 §3.3 归属校验表 |
| 中文消息断言失败但状态码对 | 服务端消息文案与冻结 §4.2/§5 模板逐字不符 | 比对 `cases/<case-id>.json` 的 `expected.message` 与 `actual.error.message` |
| 端口冲突 | 上次 electron 实例残留占用 | 复用 `tools/automated-testing/src/driver/ports.ts:3` 同款 `allocatePort`；`waitPortFree` 复查 |
| stub 全绿、http 全红 | 用例 fixture 与真服务端契约漂移（stub 未同步冻结表） | 先跑 `coverage.mjs`；再比对冻结 §5 表的必填字段与返回顶层 |

排查表按「症状 → 最可能原因 → 一条确认命令」组织；鉴权与披露类症状必须落到响应 `error.code` 与原文消息上，不凭日志措辞判断 [R11]。

## 7 自检输出

文档自检是交活前的最后一道机器闸：脚本只查结构、节数、引用分布、参考 URL 数量与本地行号引用是否真实，查不到内容语义——语义由 §3 的 14 条 AC 负责 [R3]。

```powershell
cd E:\Documents\GitHub\YingXiaoShang
python plans\server-client-split\00-master\check-docs.py --round E
```

```text
仓库根：E:\Documents\GitHub\YingXiaoShang
检查轮次：E
行数统计：
  E-*: 1077 行 / 4 份

全部通过：轮次齐全、节数达标、每节有引用、参考清单与本地行号引用都对得上。
退出码：0
```

说明：本次自检实跑于 2026-11-19，退出码 0；过程中 `02-contract.md` 曾因并行撰写缺节、缺引用标记被脚本报 4 条，由该文档负责人补齐后复跑转绿。本轮交付的 `03-implementation.md` 与本文件在两轮检查中均未被报问题；`01-scope.md`、`02-contract.md` 由并行子代理交付，`README.md` 保持原样。行数统计会随文档微调变化，以最后一次实跑为准；后续若改动文档，重跑 `python plans\server-client-split\00-master\check-docs.py --round E`，出现行号越界、缺节、占位词等问题按报错逐条修，不绕过脚本。

## 参考

- [R1] Playwright — https://playwright.dev/docs/intro — 支撑 §2 复用现有 node_modules 与 §3 断言/取证模式 — 采用 fixture 与证据落盘；不用快照测试。
- [R3] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §1 可机器判定口径、§3 用例写法与 §7 自检分工 — 采用可执行断言，不用人工观察。
- [R6] JSON-RPC 2.0 规范 — https://www.jsonrpc.org/specification — 支撑 §3 AC-04/06 信封与错误对象字段 — 借鉴 method/params/error；不做 batch。
- [R8] spring-cloud-contract — https://github.com/spring-attic/spring-cloud-contract — 支撑 §1 用例与传输解耦、三目标复用同一套断言 — 借鉴 consumer-driven 思路；不引入 JVM 框架。
- [R11] OWASP REST Security Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html — 支撑 §3 AC-06/11 越权与鉴权、§4 敏感字段不落盘 — 采用最小信息披露；不引入 API key 体系。
- [R12] Stryker JS — https://github.com/stryker-mutator/stryker-js — 支撑 §5 mutation「改坏一处 → 用例变红」范式 — 借鉴 killed/survived；不引入运行时。
- [R13] Stryker 文档 — https://stryker-mutator.io/docs/ — 支撑 §5 报告口径（killed/survived 状态） — 采用状态术语；不做全量 mutant 扫描。
- [R4] Server-Sent Events（WHATWG 规范） — https://html.spec.whatwg.org/multipage/server-sent-events.html — 支撑 §3 AC-07/08 帧格式与终态语义 — 采用 event/data/id 帧；不实现自动重连。
- [R7] Redocly CLI 文档 — https://redocly.com/docs/cli — 支撑 §3 AC-02 OpenAPI 覆盖核对思路 — 借鉴先解析再比对；不引入云服务。
