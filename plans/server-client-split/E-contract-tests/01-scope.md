# E · 契约测试 · 范围与边界

> 轮次：E · 契约测试
> 文档角色：01-scope
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1
> 一句话：同一套断言既能打 `apps/server` 的 HTTP/RPC 与 5 个专用通道，也能复用现有 Playwright 封装打本地 Electron；用例、报告、覆盖检查和 3 条临时 mutation 全部落在 E 自己名下的 `tools/contract-tests/`。

## 1 目标

1. **双 target 复用一套用例**：`--target http` 打 `apps/server` 的 `POST /api/v1/rpc` 与 5 个专用通道；`--target electron` 复用 `tools/automated-testing/` 现有的 Playwright 封装打本地 Electron；`--target both` 双跑对照，`--target stub` 用内置桩自洽可跑。
   判断标准：同一用例条目在两个 target 上各自产出一条 `passed/failed/skipped/pending` 记录；http 不可达时对应用例标 `skipped` 而不是整轮崩掉 [R34]。
2. **30 个业务方法每个 ≥2 条用例**：合法输入 1 条断言响应结构，非法输入 1 条断言中文错误消息逐字匹配；4 个 legacy 只读方法各 ≥1 条合法用例。
   判断标准：`run.mjs` 汇总的 `summary.total` 与 `02-contract.md` §2 的总量算术一致；方法清单与冻结表 §5 逐字对齐 [R3]。
3. **非法五类全覆盖**：缺字段、类型错、404 归属（资源不存在）、403（越权）、未知方法，每类至少一条专属用例，分别断言对应 code、HTTP 状态与逐字中文消息 [R7]。
4. **专用通道与 SSE 序列成组覆盖**：`chat/stream` 事件顺序（`session` 最先、`done` 终态）、取消后停止产字、`answer`/`answer-set` 回读、`health` 无鉴权可达 [R10]。
5. **OpenAPI 覆盖检查独立成命令**：`coverage.mjs` 核对 method 枚举 30 项、5 个通道 path、`x-legacy-methods` 4 个、`*Result` schema 覆盖；`docs/contracts/openapi.yaml` 缺失时输出 `pending` 且退出码 0，只按冻结表核对，不阻塞开工 [R37]。
6. **3 条 mutation 能把用例打红**：临时 patch 存 E 目录，apply → 对应用例必须变红 → revert → 恢复绿色；结束时 `git status --porcelain apps/server docs/contracts` 必须为空 [R38]。
7. **报告机读落盘**：每条用例的期望/实际/断言明细/证据路径写入 `report/` 下的 JSON，汇总结构在 `02-contract.md` §6 冻结；失败取证沿用现有 evidence 思路 [R36]。

目标排序：先把用例目录与断言器立住（不依赖活服务），再接 http target，最后接 electron target 与 mutation 回放；这样并行期 E 不需要等 A 交付就能先跑 stub [R39]。

## 2 非目标

| 不做 | 为什么 |
|---|---|
| 不改 `apps/server` 的任何行为、不修服务端 bug | 服务端代码 owner 是 A；E 发现缺漏只写进报告列给 A，不顺手改 [R2] |
| 不修改 `docs/contracts/openapi.yaml` | OpenAPI 唯一 owner 是 A；E 只读，缺漏在 coverage 报告里列出，由 A 修（冻结 §8） |
| 不引入新测试运行时（jest / vitest / Pact 运行时 / 快照测试框架） | 工具包独立安装、依赖要轻；断言与采集复用 Node 原生能力与现有 Playwright，不把整套契约框架搬进来 [R38] |
| 不做 UI 视觉回归、不做页面快照比对 | 本轮契约面是 RPC 信封、错误码、事件序列与 OpenAPI 覆盖；UI 断言归现有 `tools/automated-testing` 31 条基线 |
| 不做并发压测、不看 P50/P99 | 那是 F 轮 `tools/loadtest/` 的范围；E 只关心单次调用的契约是否成立 [R36] |
| 不落地 `apps/desktop` 的 mutation patch | 桌面端临时 patch 归 H 轮 `tools/automated-testing/mutations/`；E 的 mutation 只针对服务端代码与契约文件，且全部 revert |
| 不写用户真实数据目录（`%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent`） | 并行隔离硬规则；被测库一律复制到 `.scratch/run/E/home-*/`（冻结 §10.3、归属 §3） |
| 不替代现有 31 条 Playwright 用例 | `tools/automated-testing/src/scenarios/dependencies.ts:5-41` 是 H 轮回归基线；E 的 electron target 是对照同一冻结契约的新一批断言，不删不改旧 spec |
| 不实现 CAS / OAuth 回调的真实登录 | 预留端点本阶段返回 501；E 只断言 501 形状，不接上游 IdP [R7] |
| 不生成对外公开的契约文档站点 | OpenAPI 文件由 A 产出；E 只做覆盖核对，不做 Redoc/Scrape 之类渲染 |

## 3 真实依据（现状代码）

| # | 位置 | 现在是什么 | 为什么与本轮目标直接相关 |
|---|---|---|---|
| 1 | `apps/desktop/src/main/index.ts:203-393` | 一个 `switch (method)` 承载全部 30 个业务方法，直接调 `db` / `profileService` / `agentRuntime` | 30 个方法名、必填参数、返回形状的唯一事实来源；E 的用例目录必须按这张表逐方法生成，方法集合漂移立刻能被覆盖检查发现 |
| 2 | `apps/desktop/src/main/index.ts:225-250` | 4 个 legacy 只读方法：`getKp`、`getBlock`、`getResource`、`listIdeology` 的现有实现 | 冻结 §6 要求每个 legacy 至少 1 条合法用例；入参名（`kpId`/`blockId`/`resourceId`，兼容 `sourceId`）只能从这里取 |
| 3 | `apps/desktop/src/main/index.ts:390-392` | 未知方法走 `default` 分支抛英文 `unknown learning method: ${method}` | HTTP 契约要求 `404 UNKNOWN_METHOD` + 中文 `没有这个方法：<method>`；E 的未知方法用例断言的是新契约，不是现状英文抛错 |
| 4 | `apps/desktop/src/main/index.ts:445-536` | 6 个 `ipcMain.handle`：`learning:invoke`、`learning:cancel`、`learning:chat`、`learning:answer`、`learning:answer-set`、`learning:health` | 5 个专用通道（SSE、cancel、answer、answer-set、health）的请求体形状与返回对象来源；electron target 的封装对照这套 IPC 面 |
| 5 | `apps/desktop/src/main/errors.ts:9-64` | `friendlyError` 纯函数把上游错误翻成中文目录，`context: 'answer'` 追加「这次作答没有记成成绩，可以直接重试。」 | 中文消息是产品契约；E 逐字比对的文案取自冻结 §4.2 与本文件行 9-64，不在测试里另写一套措辞 |
| 6 | `tools/automated-testing/README.md:54` | 编写约束：「禁止 spec 自己启动 Electron：Electron 只能经 `src/driver` 的 `launchElectron` 启动；spec 不得直接 import `_electron` 或 `@playwright/test`」 | E 的 electron target 必须走同一约束：启动入口复用 `driver` 封装，不在 E 包里直接 `import _electron` [R35] |
| 7 | `tools/automated-testing/src/driver/electron-driver.ts:1-9` | driver 层导入 `_electron`、`env`、`log`、`paths`、`ports`、`processes`，对外暴露 `launchElectron` 与关闭报告 | E 复用进程拉起、环境注入、日志落盘、进程清理；E 侧只写断言，不重写进程生命周期管理 |
| 8 | `tools/automated-testing/src/driver/ports.ts:3-17` | `allocatePort()` 用 `net.createServer().listen(0)` 向操作系统要随机空闲端口 | E 的 http 与 electron 实例都按这个思路取随机端口，避免与 A（8080）、F（18080）、D/G 的 PG 端口冲突 |
| 9 | `tools/automated-testing/src/client/learning-client.ts:100-124` | `LearningClient` 强类型封装 `invoke`/`health`/`chat`/`cancel`/`answer`/`answerSet`，每次调用记入 `calls` 日志 | electron target 的调用层参照这层封装；http target 实现同构接口（`invoke/chat/answer/answerSet/cancel/health`），用例代码只面对同一套接口 |
| 10 | `tools/automated-testing/src/client/chat-events.ts:14-85` | `ChatEventCollector` 挂采集函数、按 `requestId` 过滤、`waitFor` 轮询断言、`waitQuiet` 确认取消后不再产字 | SSE 顺序与取消停止两条用例的采集/等待模式直接复用；禁止 `waitForTimeout` 固定等待（README 同节约束）[R36] |
| 11 | `tools/automated-testing/src/scenarios/dependencies.ts:5-41` | `TC_DEPS` 台账登记 13 条 p0 + 18 条 p1 共 31 条现有用例与实现侧 ID 的映射 | E 不重复这 31 条；台账用于交叉核对 E 的方法覆盖没有漏掉桌面端真实在调的方法 |
| 12 | `packages/agent/src/team.ts:17-35` | `TeamEvent.type` 只有 `round`/`text`/`tool`/`tool-end`/`session` 五种，`sessionId` 必须在任何失败调用之前发出 | SSE 事件名白名单与「`session` 最先」断言的依据；白名单之外的事件名判违约 [R10] |
| 13 | `packages/agent/src/index.ts:52-67` | `HandleTurnOutput` 含 `sessionId`/`turnId`/`text`/`artifacts`/`citations`/`warnings`/`trace?` 等字段 | `done` 事件载荷字段只能从这里取；E 断言 `done` 必发且字段齐全，不自造 `stats` 之类新字段 |
| 14 | `packages/db/src/index.ts:245`、`:276`、`:283`、`:292`、`:308` | `evidence`、`chat_sessions`、`chat_messages`、`memory_facts`、`artifacts` 五张表都带 `student_id` | 403 归属校验的依据表；越权用例按这五类资源分别构造「别人的记录」 |

这 14 条的共同判据是「同一份调用面在两种 transport 下契约一致」：HTTP 与 Electron 返回的字段名、错误码、事件序列必须对得上，测试才能只换调用层不换断言 [R38]。

## 4 与现行为的差异（有意收紧）

| 项 | 现状（IPC，宽容） | HTTP 契约（严格，E 断言） | 影响谁 |
|---|---|---|---|
| 缺必填字段 | 退化成空串继续走（`index.ts:204-393`） | `400 BAD_REQUEST` + 该字段中文消息 | 必填方法的非法用例；electron target 跑现状时这类断言可能不成立，报告分列差异 |
| 类型错（如 `limit: "10"`） | 当没传，用默认值 | `400 BAD_REQUEST` + `limit 必须是整数。` | 类型错专属用例；http 必须严格，electron 现状对照 |
| 查询不到记录 | 多个 getter 返回 `undefined` | `404 NOT_FOUND` + `没有找到这条记录，可能已被删除。` | 404 归属用例；客户端错误处理 |
| 归属校验 | 单机单学生，靠约定 | 会话/产物/证据/事实四类强制校验，失败 `403` | 越权用例；构造第二个学生 token 对照 |
| 未知方法 | 抛英文 `unknown learning method` | `404 UNKNOWN_METHOD` + `没有这个方法：<method>` | 未知方法用例；调试体验 |
| 身份来源 | 请求体 `studentId`，缺省演示学号 | 只从 token 解析；请求体 `studentId` 忽略 | http target 登录后再调用；electron target 仍走现状桥接 |

> 差异不是 E 自行放宽或收紧的空间：口径以冻结 §4.3 为准。E 在 electron target 上遇到「现状宽容、契约严格」的不一致时，只把差异写进报告，交人裁决，不偷偷改断言期望值 [R7]。

## 5 产物清单

全部落在 `tools/contract-tests/**`（归属 §1 中 E 的唯一写权路径），目录树：

```text
tools/contract-tests/
  package.json                    独立包（不在 pnpm-workspace 三条 glob 内），scripts: run/coverage/typecheck
  README.md                       怎么跑：target 选择、前置条件、报告落点、mutation 回放命令
  run.mjs                         CLI 入口：--target http|electron|both|stub、--home、--base-url、--case 过滤
  coverage.mjs                    OpenAPI 覆盖检查命令：读 docs/contracts/openapi.yaml，出 coverage JSON
  cases/
    methods.mjs                   30 方法合法/非法用例 + 4 legacy 合法用例，参数与期望逐方法声明
    illegal-class.mjs             5 类非法专属用例（缺字段/类型错/404/403/未知方法）
    channels.mjs                  SSE 顺序、取消停止、cancel 未知 requestId、answer/answer-set 回读、health
    openapi.mjs                   4 项覆盖断言枚举（enum 30、通道 path 5、legacy 4、Result schema 30）
  src/
    http-target.mjs               http 调用层：登录取 token、RPC 信封、SSE 帧解析、5 通道请求
    electron-target.mjs           electron 调用层：复用 driver 的 launchElectron 与 LearningClient 同构接口
    stub-target.mjs               内置确定性桩：不联网、不起进程，供并行期自洽跑通断言器与报告
    assert.mjs                    断言原语：HTTP 状态、code、逐字消息、字段齐全、事件序列、集合相等
    report.mjs                    组装 report JSON、写证据目录、汇总 passed/failed/skipped/pending
    patch.mjs                     mutation apply/revert：读 mutations/*.patch、调用脚本化还原、复查干净状态
    fixtures.mjs                  测试数据：学生对、会话/产物/事实样例 ID、消息文本上限边界值
  report/
    .gitkeep                      运行期产物目录；meta/断言明细/证据快照按用例编号落盘
  mutations/
    m1-drop-done.patch            临时删除 SSE done 帧（见 §7 例外申请）
    m2-loosen-limit.patch         临时放开 limit 校验（见 §7）
    m3-enum-29.patch              临时把 method enum 改成 29 项（见 §7）
    apply-revert.ps1              脚本化 apply / 复测 / revert / 干净状态复查
```

**同时新增（不改动）**：除 §7 列明的 3 个临时 patch 外，E 不写 `apps/server/**`、不写 `docs/contracts/**`；`tools/automated-testing/src/**` 只读复用，不新增 spec、不改 driver。目录划分（用例 / 调用层 / 断言 / 报告 / patch 分开）与 fixture 数据外置的做法参照现有工具包结构与 fixture 外置思路 [R40]。

## 6 并行边界

本节是硬验收：A–I 八轮必须能同一时刻开工，以下 5 条自证逐条成立。

1. **只读依赖**：E 读取 `apps/server`（运行实例代码与行为）、`docs/contracts/openapi.yaml`（覆盖核对）、`packages/**`（只读引用类型与表结构）、`tools/automated-testing/src/**`（复用封装）。这些路径 E 不写一个字符；openapi 尚未生成时走 §7 的 pending 口径，不阻塞 E 开工 [R2]。
2. **写权唯一**：E 的全部新建与修改只发生在 `tools/contract-tests/**`；根 `package.json` / `pnpm-lock.yaml` 不由 E 碰（工具包独立 `pnpm install --ignore-workspace`）；`apps/server` 与 `docs/contracts` 仅在 §7 例外申请的 3 个临时 patch 应用期内被改动，且结束前必须 revert 干净。
3. **运行时资源**：http 与 electron 实例端口由 `allocatePort` 风格的随机空闲端口分配，不固定占用 8080；临时 home 用 `.scratch/run/E/home-<短id>/`（含 `data/learning.db` 副本与 `auth.db`）；Electron 启动走 `.scratch/run/electron.lock` 目录锁，与 H 轮互斥；不写真实数据目录，不删 `.scratch/` 下别的轮次目录。
4. **不依赖他轮产物**：`--target stub` 自洽可跑，不连任何活服务；openapi 缺失时 `coverage` 输出 `openapi: missing`、状态 `pending`、退出码 0；http target 连不上 A 的实例时用例标 `skipped` 并写明原因，不把「前置未就绪」当成断言失败 [R39]。
5. **冲突裁决**：文件被非 owner 修改，E 在报告里记录「外部改动」并重新验证，不擅自回滚别人的改动；契约冲突以 `01-frozen-contracts.md` 为准，实现确实做不到时写例外申请到本文件 §7；拿不到 electron 锁时退避重试 30s（每 2s 一次），仍失败则跳过 electron target 并在报告写明「未取得 electron 锁，本轮 electron 目标未执行」；禁止用 `git stash` 清场抢锁。

与 A、F 的接口都落在稳定面上：E 读 A 的 OpenAPI 文件与冻结方法表，F 读 E 不需要的指标口径；三者之间没有进程调用依赖，只有文件与契约名 [R37]。

## 7 契约例外申请：3 个临时 mutation 对 A 文件的改动

### 7.1 为什么走例外申请

mutation 验证的范式是「在真实被测代码里植入一处故障，让对应用例必须变红」[R38]。本轮 3 条 mutation 的故障点恰好落在 A 名下的 `apps/server` 与 `docs/contracts/openapi.yaml`；按归属矩阵这些路径 E 没有写权。因此本节按归属 §5「需要 owner 配合的变更」流程登记：patch 存 E 自己的 `tools/contract-tests/mutations/`，脚本化 apply/revert，结束时复查干净，不直接改 A 的工作区。

### 7.2 三条 mutation 登记

| 编号 | patch 文件 | 落点（A 的路径，以 A 最终目录为准） | 临时改动 | 必须变红的用例 |
|---|---|---|---|---|
| M1 | `mutations/m1-drop-done.patch` | `apps/server/src/chat/stream.ts`（发 `done` 帧的位置） | 移除 `done` 帧发送，流结束不发终态事件 | SSE 顺序用例（断言末帧为 `done`） |
| M2 | `mutations/m2-loosen-limit.patch` | `apps/server/src/rpc/validate.ts` 或对应 `limit` 校验 handler | 去掉 `limit` 整数/上限校验，越界值放行 | 越界非法输入用例（期望 `400 BAD_REQUEST`） |
| M3 | `mutations/m3-enum-29.patch` | `docs/contracts/openapi.yaml`（`method` 枚举） | 枚举删除 1 项，30 → 29 | OpenAPI enum 覆盖用例（断言恰好 30 项） |

### 7.3 为什么必须临时改 A 的文件

- **M1 验的是真实链路的终态帧**：只有在真实 `stream.ts` 里不发 `done`，才能证明「用例真的在测服务端 SSE 收尾，而不是测自己的桩」。若在桩里模拟缺 `done`，只能验证断言器写法，证明不了服务端实现会被这条契约守住 [R10]。
- **M2 验的是真实校验器**：放开真实校验路径，越界值才会从 400 变成 200；断言器若只在 E 包内改阈值，被改坏的对象不是被测代码，mutation 没有杀伤力。
- **M3 验的是真实契约文件**：enum 少一项必须让 coverage 报缺；改的是 A 产出的 yaml 本身，而非 E 内存里的副本。

### 7.4 影响哪个轮次

- 仅影响 **E 轮验收期**：patch 只在 `apply-revert.ps1` 驱动的回放窗口内存在，回放结束立即 revert。
- **A 轮不知情、不配合改代码**：patch 以相对路径 + 上下文锚点生成，A 后续调整文件结构时，锚点漂移属于 E 维护 patch 的责任，不靠 A 留接口。
- **H 轮跑 31 条基线时 patch 必须已 revert**；两套 mutation 目录（E 的 `tools/contract-tests/mutations/` 与 H 的 `tools/automated-testing/mutations/`）互不借用。
- 收尾硬校验：`git status --porcelain apps/server docs/contracts` 输出必须为空；revert 失败时 E 阻塞并报告，不允许带脏状态结束。

### 7.5 替代方案与不采用的理由

| 替代方案 | 为什么不采用 |
|---|---|
| A 在生产代码里加测试故障开关（env 控制不发 `done` / 跳过校验） | 等于把验收钩子留在生产路径上，违背错误最小披露原则，也给 A 的镜像留了未交付口径；开关长期存在后会被当成正式功能 [R7] |
| E 复制一份 `apps/server` 副本再改 | 副本脱离真实依赖与路径布局，测的不是交付物；workspace 包引用在副本里容易漂移，故障可能在副本里才出现 |
| 全部用 `--target stub` 的故障模式 | 只能验证 E 自己的断言器，覆盖不到真实服务端与真实 OpenAPI；mutation 的「被杀掉」证据链不成立 |

## 8 未知与风险

| # | 风险 | 怎么验证这个风险是否发生 |
|---|---|---|
| 1 | A 尚未交付可运行的 `apps/server`，http target 暂时打不通 | 先跑 `--target stub` 全绿；http 用例前置探测 `/health`，不可达一律 `skipped` 并记录原因；交付后补跑 http，不需要改用例 |
| 2 | Electron 实例与 H 轮同时启动，端口/home/锁冲突 | 走 `.scratch/run/electron.lock` 目录锁与随机端口；拿不到锁按 §6 第 5 条退避跳过；报告写明实际端口与 home 路径 |
| 3 | 中文消息随实现漂移（错别字、改写、标点变化） | 断言器对 `error.message` 做逐字相等比对，不做包含匹配；消息表来自冻结 §4.2 与 `errors.ts:9-64`，漂移项在报告里列期望/实际原文 |
| 4 | OpenAPI 文件缺失或字段命名与冻结口径不符 | `coverage.mjs` 两种状态分开：`missing` 走 pending 退出 0；`present` 但缺项走 red 并列出 `missing`/`extra` 清单交 A |
| 5 | http（严格）与 electron（宽容现状）对同一非法输入期望不一致 | 两个 target 各自出报告，差异不合并、不互相覆盖；对照表在报告 `environment.target` 字段下分栏，交人裁决是否调整 electron 现状 |
| 6 | mock LLM 下 SSE 事件不全，顺序断言误红 | stub 与 http 都用确定性脚本事件序列；断言只验契约要求的事件（`session` 首、`done` 终、事件名白名单），不要求模型产出固定文本 [R36] |
| 7 | patch 锚点在 A 改文件后失效，apply 失败 | `apply-revert.ps1` 先 `git status` 确认干净再 apply；apply 失败不强行 patch，记录失败锚点并在报告标 mutation 未执行；revert 后复查 `git status` 为空 |
| 8 | 工具包独立安装时 Node 版本或 Playwright 浏览器与现有 `tools/automated-testing` 不一致 | electron target 优先复用现有 `tools/automated-testing/node_modules`；http/stub 只用 Node 原生能力；版本不一致时在 README 写明复用口径 |

## 参考

- [R3] JSON-RPC 2.0 规范 — https://www.jsonrpc.org/specification — 支撑 §1 目标 2 的 RPC 信封与方法清单对齐 — 借鉴 `method`/`params`/`error` 结构；不引入 batch 与 notification。
- [R7] OWASP REST Security Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html — 支撑 §2 非目标、§4 差异与 §7 故障开关取舍 — 采用最小信息披露与归属校验口径；不引入 API key 体系。
- [R10] Server-Sent Events（WHATWG 规范） — https://html.spec.whatwg.org/multipage/server-sent-events.html — 支撑 §1 目标 4 与 §7 M1 的事件帧断言 — 采用 `event:`/`data:`/`id:` 帧与终态语义；不实现自动重连与 Last-Event-ID 重放。
- [R2] OpenAPI 3.0.3 规范 — https://spec.openapis.org/oas/v3.0.3 — 支撑 §1 目标 5 与 §6 只读依赖口径 — 采用 `paths`/`components.schemas` 组织；不使用 3.1 方言。
- [R34] Playwright 文档 — https://playwright.dev/docs/intro — 支撑 §1 目标 1 的 fixture 与证据落盘 — 采用 fixture 分层与失败取证；不用其快照测试。
- [R35] Playwright Electron — https://playwright.dev/docs/api/class-electron — 支撑 §3 第 6 条 driver 复用约束 — 采用唯一启动入口复用；E 包内不直接 import `_electron`。
- [R36] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §1 目标 7、§3 第 10 条与 §8 风险 6 — 采用禁固定等待、轮询断言、测试分层；不引入其全部工具链。
- [R37] Redocly CLI 文档 — https://redocly.com/docs/cli — 支撑 §1 目标 5 与 §6 第 5 条覆盖检查思路 — 借鉴「先读契约再比对覆盖」；不引入其云服务。
- [R38] Pact JS — https://github.com/pact-foundation/pact-js — 支撑 §7.1 mutation 范式与 §3 末尾的契约一致性判据 — 借鉴消费者驱动契约的「用例对照 provider」思路；不引入 Pact 运行时与契约文件交换。
- [R39] Prism — https://github.com/stoplightio/prism — 支撑 §1 排序与 §6 第 4 条 stub 自洽 — 借鉴「契约可先于实现被桩满足」；不引入其 mock server 依赖。
- [R40] factory_boy — https://github.com/FactoryBoy/factory_boy — 支撑 §5 产物清单的 fixture 数据外置 — 借鉴测试样例数据集中生成；不引入 Python 栈。
