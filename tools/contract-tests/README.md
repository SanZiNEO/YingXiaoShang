# E · 契约测试（tools/contract-tests）

一套断言，三个目标：`stub`（内存桩，断网可跑）、`http`（打 `apps/server` 的 RPC 与 5 个专用通道）、`electron`（经 `tools/automated-testing` 的 `launchElectron` 打本地桌面端）。外加 OpenAPI 覆盖核对命令与 3 条 mutation 回放机制。

本包是独立包：`type=module`、纯 `.mjs`、**零第三方运行时依赖**（HTTP/SSE 用 Node 22 内置 `fetch`，YAML 用手写轻量解析，Electron 复用 `tools/automated-testing` 已装好的 `tsx`/`playwright`）。不进根 workspace，不跑根 `pnpm install`，不动根 `package.json` 与 `pnpm-lock.yaml`。

## 1 目录与职责

```text
tools/contract-tests/
  package.json              独立包声明（scripts: test / test:http / test:electron / test:both / coverage / mutations）
  run.mjs                   CLI 入口：解析参数、选 target、编排用例、汇总退出码（不写断言、不发 HTTP）
  coverage.mjs              OpenAPI 覆盖核对命令（读 docs/contracts/openapi.yaml，只读）
  cases/
    methods.mjs             30 个方法的合法/非法用例（E-001..E-060）+ 4 个 legacy（E-061..E-064）
    illegal-class.mjs       非法五类专属（E-065..E-069）
    channels.mjs            5 个专用通道（E-070..E-076）
    openapi.mjs             OpenAPI 覆盖四项（E-077..E-080）
  src/
    frozen.mjs              冻结表：30 方法/4 legacy/5 通道/14 错误码/逐字中文消息（唯一事实来源）
    target-interface.mjs    目标抽象与 SkipSignal / TargetUnreachable
    stub-target.mjs         内存桩（按冻结表实现返回形状与全部错误分支）
    http-target.mjs         fetch + Bearer + RPC 信封 + 通道 + discovery
    electron-target.mjs     经 launchElectron 启动，`window.learning` 桥接
    sse-client.mjs          SSE 逐帧解析与 CollectedStream
    assert.mjs              断言原语、深比较、脱敏
    report.mjs              report.json / report.md / 证据落盘
    fixtures.mjs            学生夹具、符号占位解析、缺失 ID
    openapi.mjs             openapi.yaml 轻量解析与四项核对
    patch.mjs               mutation 声明式规格的 apply/revert 与单文件状态复查
  report/                   运行产物（.gitignore 已忽略），按 yyyyMMdd-HHmmss 分目录
  mutations/
    m1-drop-done.mjs        M1 规格：删 SSE done 帧 → E-070
    m2-loosen-limit.mjs     M2 规格：放开 limit 校验 → E-034
    m3-enum-29.mjs          M3 规格：method 枚举 30→29 → E-077
    apply-revert.ps1        回放驱动（apply → 复跑 → revert → 单文件状态复查）
    README.md               口径说明、锚点策略、漂移维护
```

分层规则：`cases/` 只描述「打什么、断言什么」，不出现 `fetch` / IPC / `_electron`；传输差异全在 `src/*-target.mjs`；断言失败一律落盘 expected/actual，不吞。

## 1.5 跑 http 目标的前置条件（干净克隆照做即可）

```bash
# 1) 起服务端（另开一个终端，隔离 home，别指真实数据目录）
LEARNING_AGENT_HOME=<repo>/.scratch/run/E/server-home pnpm --dir apps/server start

# 2) 建学生 A（E 默认 20230001）
pnpm --dir apps/server exec tsx scripts/add-student.mjs \
  --id 20230001 --name 契约测试学生甲 --cohort 2023 --password <口令>

# 3) 建学生 B（E-068 越权构造需要；缺 B 时 E-068 显式 skip 并写明原因）
pnpm --dir apps/server exec tsx scripts/add-student.mjs \
  --id 20230002 --name 契约测试学生乙 --cohort 2023 --password <与 A 同口令>

# 4) 跑
node run.mjs --target http --base-url http://127.0.0.1:8080 \
  --student-id 20230001 --password <口令>
```

账号口令取 `apps/server/README.md` 的测试账号；`src/fixtures.mjs` 里的默认值只是本地夹具，可用 `--student-id` / `--password` 覆盖。

- **E-062 / E-063**：`getBlock` 的 `blockId` 与 `getResource` 的 `resourceId` 没有列表方法，本包只从服务端自己返回过的引用里取（章节 id、会话消息 citations、产物 source_refs），逐个试调用验证；取不到就 skipped 并写原因，绝不编造 ID。
- **E-073 / E-074**：题目 id 从 `questions.attempts` 的 `question_id`（snake_case，按 openapi 的 QuestionAttempt）取；没有作答时回落到题目集产物的 `content_json.questions`。E-074 必须拿到**两个不同**题号（同一题提交两次会被服务端按「重复提交」拒绝），不足两道即 skip。

## 2 怎么跑

```powershell
cd tools\contract-tests

node run.mjs --target stub                        # 内置桩自洽跑（不联网、不起进程）
node run.mjs --target http                        # 打 --base-url（默认 http://127.0.0.1:8080）
node run.mjs --target http --base-url http://127.0.0.1:8080 --only news.list
node run.mjs --target electron                    # 复用现有 driver 拉本地 Electron
node run.mjs --target electron --only E-001       # 单条合法用例（最小可验收单位）
node run.mjs --target both                        # 先 http 组，再 electron 组，报告分两组
node coverage.mjs                                 # OpenAPI 覆盖核对
powershell -NoProfile -File mutations\apply-revert.ps1   # mutation 回放
```

参数（启动期一次读完冻结，运行期不再重读）：`--target stub|http|electron|both`（默认 `stub`）、`--base-url`（`http://host:port`，路径前缀固定 `/api/v1`）、`--only`/`--case`（用例编号或方法名）、`--home`（默认 `.scratch/run/E/home-<短id>/`）、`--report`（默认 `report/<时间戳>/`，相对本包；同一秒撞名自动加 `-2`/`-3`，不复用别的运行目录）、`--student-id`、`--password`。

退出码：

| 码 | 含义 | 实测触发条件 |
|---|---|---|
| 0 | 通过 / 按设计跳过 | 全绿；或 http 组不可达整组 skipped、electron 锁未取得整组 skipped、OpenAPI 缺失 4 条 pending |
| 1 | 至少一条用例 failed | 断言不成立、coverage red、SSE 超时、登录失败；mutation 回放期预期变红 |
| 2 | 显式 `--target http` 且服务端不可达 | 连接拒绝/超时；`--target both` 下 http 组只记 skipped，不记 2 |
| 3 | CLI 参数非法 | `--target` 非法值、`--base-url` 形态错、`--only` 无匹配、`--home` 指向真实目录、`--report` 越界或不可写 |

## 3 80 条用例的算术

```text
30 方法 × 2（合法 E-001..E-030 + 非法 E-031..E-060） = 60
4 legacy 方法 × 1（E-061..E-064）                      =  4
非法五类专属（缺字段/类型错/404/403/未知方法 E-065..E-069）=  5
专用通道 7（E-070 SSE 顺序 / E-071 取消 / E-072 cancel 未知 /
           E-073 answer 回读 / E-074 answer-set 回读 /
           E-075 交卷空数组 / E-076 health 无鉴权）        =  7
OpenAPI 覆盖 4（E-077 enum 30 / E-078 通道 5 /
                E-079 legacy 4 / E-080 Result schema 30）  =  4
合计                                                     = 80
```

`summary.total` 在单目标运行下恒为 80（`--target both` 下按「同一编号在两个目标各记一条」计为 160，另给 `uniqueCases=80`）。`coverage` 不计入执行计数，它的四项核对对应 E-077..E-080。

## 4 报告与证据

```text
report/<yyyyMMdd-HHmmss>/
  report.json     汇总：schemaVersion 1.0 / round E / target / startedAt / finishedAt /
                  environment{baseUrl,port,home,openapi,openapiReadAt,lockedElectron,seed,electronLock,electron,http,...} /
                  summary{total,passed,failed,skipped,pending,uniqueCases,expectedTotal} /
                  cases[{id,kind,method,channel,target,status,assertions[],expected,actual,evidence,durationMs,error,reason}] /
                  mutations[] / probes[]
  report.md       人读：失败明细、覆盖矩阵、跳过与待定、mutation、前置探针
  cases/<id>.json 单条用例：入参、期望、实际、逐条断言差异、耗时、源码依据
  sse/<id>.txt    SSE 原始帧（stub/http）或事件序列（electron）
  coverage.json   coverage.mjs 产出（含 readAt 读取时刻）
  mutations/<id>.diff  mutation 运行时生成的 diff（准入通过并实际 apply 时才有）
  run.log         每用例一行结构化日志（脱敏：token / 口令 / 消息正文不落盘）
```

## 5 已实测（本机实跑记录）

环境：Windows + Node v22.23.2，仓库根 `<仓库根>`，命令均在 `tools\contract-tests` 下执行。下表是**最终一轮**实跑（A 轮产物 `apps/server/`、`docs/contracts/openapi.yaml` 均已落盘之后）。

| # | 命令 | 退出码 | 结果 | 报告目录 |
|---|---|---|---|---|
| A | `node run.mjs --target stub` | 0 | 共 80 条：**passed 80 / failed 0 / skipped 0 / pending 0**（本轮修复后复跑：`report/20261120-221847-2`） | `report/20261120-093902` |
| B | `node coverage.mjs` | 0 | `openapi:"present"`、`status:"green"`；E-077 30/30、E-078 5/5、E-079 4/4、E-080 30/30，missing 与 extra 均为 `[]`；读取时刻 `2026-11-20T01:39:03.052Z` | `report/20261120-093903/coverage.json` |
| C | `node run.mjs --target http --base-url http://127.0.0.1:8099`（该端口无人监听） | 2 | 中文一行 `服务端不可达（http://127.0.0.1:8099）：请先启动 apps/server，或用 --target stub 跑自洽用例。`；80 条全部 `skipped` 且 reason 为该句 | `report/20261120-093939` |
| D | `node run.mjs --target electron --only E-001` | 0 | Electron 真实拉起，E-001 `student.current` passed；环境段有 `mainPid`、`launchMs`、`close{exitCode,forced,portFree}` | `report/20261120-093914` |
| E | `powershell -NoProfile -File mutations\apply-revert.ps1` | 0 | 三条全部 `not-run`、`applied=false`、`reverted=true`，reason 均为「改动中（`?? …`）」（见 §7） | 无 diff 产物（准入拦截，未写入被测文件） |
| F | `python plans\server-client-split\00-master\check-docs.py --round E` | 0 | 轮次齐全、节数达标、引用与行号对得上（E 轮文档未被本包改动） | — |

补充实测：

- **对准真实 `apps/server` 的只读抽测**（实例已在 `127.0.0.1:8080` 运行，A 轮自己的 home，账号按 `apps/server/README.md` 的 `20230001 / abc12345`）：`E-001` passed、`E-069`（未知方法 404 `没有这个方法：learning.__nonexistent__`）passed。`E-034` 曾暴露 `error.field="params.limit"` 与冻结 §4.1 样例 `"field": "limit"` 不一致，A 已修复，本轮实测一致。`E-031` / `E-065` 遇到服务端登录限流（`429 RATE_LIMITED 尝试太频繁…`，与其它并行轮的验收流量抢同一 IP 窗口），属环境争用，未据此改期望值；等窗口内无并发后可复跑。
- **http 全链路**：`.scratch/run/E/http-fixture/` 下的临时 fixture 服务端做过全量 80 条（74 passed / 2 skipped / 0 failed / 4 pending，那时 openapi 还没落地）；`E-070` 帧序 `session→round→text→text→done`、`E-071` 取消后 `eventOrder=[session,error]`、`code=CANCELLED`、`doneCount=0`。fixture 只是自测件，不替代 `apps/server`、不进仓库产物。
- **`--target both`**：http 组不可达 + electron 锁被别的轮次占着时，160 条记录全 `skipped`、退出码 0、`uniqueCases=80`，两条 reason 各自写明（解锁后 electron 组正常跑）。
- **CLI 非法参数**（全部退出码 3，且不落任何文件）：`--target nope`、`--only E-999`、`--base-url banana`、`--report ..\outside`、`--home "$env:APPDATA"` / `~/.learning-agent` / `<repo>/.learning-agent`；`node coverage.mjs --report ..\evil` 同样 3。
- **mutation 闭环**：`.scratch/run/E/selftest/` 的干净假仓库里真跑过 apply→变红（killed）→按原字节还原（逐字节复核一致）→复跑变绿；另有 survived、「` M` 改动中拦截」两个口径自测，三套均退出 0。
- **报告目录同名保护**：自动命名只到秒，同一秒连跑会撞名。实测连跑 4 次 `--only E-001` 得到 `…092148`、`…092148-2`、`…092149`、`…092149-2`，后一次不再覆盖前一次的 `report.json`（此前正是这样丢过一次证据，已修）。

## 6 与设计文档的偏差（代码为准，逐条写明）

1. **文件形态**：`E-contract-tests/README.md` 的产出草图写的是 `src/cli.ts` 等 `.ts` 路径；`03-implementation.md` §1 已明确「按下表落地为 `.mjs` 扁平结构，不再分 `src/` 层」。本包按 `.mjs` 落地，无编译步骤。
2. **mutation 载体**：文档写 `mutations/*.patch`。本包改为**声明式规格** `mutations/m1-drop-done.mjs` 等：被测文件当前不存在，手写 patch 会把不存在的 diff 硬编码进仓库；现在 apply 时按行比对**运行时生成** unified diff 落盘，revert 用原字节备份逐字节还原，并复查单文件 `git status`。理由与被拒方案对比见 `mutations/README.md`。
3. **electron 的事件序列**：桌面端 `learning:chat` 是一次性 IPC（不是 SSE），没有事件流可采。`electron-target.mjs` 把 `TurnResponse` 合成 `session → text(1-3 段) → done` 帧，并在文件头注释写清这一点；E-070 因此可在 electron 上跑，而 E-071..E-075（在途取消、交卷回读）在 electron 上显式 `skip` 并写明原因。
4. **报告的新增字段**：冻结 schema 之外只增不改——
   - `environment.openapiReadAt`、`coverage.json.readAt`：并行期 A 轮可能随时落盘 `openapi.yaml`，报告必须写明「读取时」的状态（冻结字段 `openapi`/`file`/`status`/`checks` 名字与结构未动）；
   - `summary.uniqueCases` / `summary.expectedTotal`：`--target both` 下 `total` 是记录数，这两个字段保留 80 条算术；
   - `probes[]`：`AUTH_REQUIRED` / `AUTH_INVALID` 是冻结 §4.1 说的「鉴权前置探测」，不占 80 条编号，单独成段。
5. **`FORBIDDEN` 文案的文档内冲突**：`01-frozen-contracts.md` §3.3 写「这条会话不属于当前学号。」，§4.2 与 `02-contract.md` §4.1 写「这个资源不属于当前学号，换回自己的账号再试。」。E-068 断言的是**后者**（§4.2 是「冻结错误码表（不得新增同义码）」且被 E 轮契约逐字引用）。这条冲突需要人裁决：若确认按 §3.3 分资源给文案，改 `src/frozen.mjs` 的 `ERROR_CODES.FORBIDDEN` 一处即可。
6. **`E-080` 的 missing 口径**：冻结 §8 写「至少覆盖 30」，本包 `missing` 列未覆盖的方法名；`extra` 只列「结尾 `Result` 且不在 30 个期望名内」的 schema，并把 `HealthResult` / `LoginResult` 这类健康检查与登录的伴随 schema 排除在 extra 之外（它们不是方法覆盖项，A 的契约里本来就该有）。
7. **`--target both` 的 total**：冻结要求「同一编号在不同 target 各产出一条记录」，实现按记录数统计并在 `uniqueCases` 保留 80。
8. **客户端请求号形态**：A 的 `REQUEST_ID = /^req_[a-z0-9]{1,24}$/` 不接受下划线，而本包早先用的是 `req_<base36>_<序号>`，带第二个下划线 → 服务端按「不合法则自生成」分支换掉了我们的号，`requestId 回显` 断言因此红过一次。已把 `src/fixtures.mjs` 的 `newRequestId()` 改成 `req_` + 12 位小写 base36（与冻结 §4.1 示例 `req_abc123`、03-implementation §3.2 第 3 条同形），改后对真实实例 E-001 直接 passed。

## 7 mutation 当前状态（如实记录，未写死结论）

| 编号 | 目标文件 | 状态 | reason（原文口径） | 入库干净后的预判（只读干跑，非实测） |
|---|---|---|---|---|
| M1 | `apps/server/src/chat/stream.ts` | not-run | 目标文件被其它轮次改动中（`git status: ?? apps/server/src/chat/stream.ts`） | **锚点已修，可跑通**：锚点改为 `writer.done(`（`stream.ts:127`，全文唯一 1 次；实测 `writer.done (` / `emit('done'` / `sendEvent(res, 'done'` 均为 0 次）。替换为 `if (false) writer.done(`：调用进恒假分支、载荷字面量原位保留，文件仍可编译，效果是不再发 done 帧 |
| M2 | `apps/server/src/rpc/validate.ts` | not-run | 目标文件被其它轮次改动中（`git status: ?? apps/server/src/rpc/validate.ts`） | **预计可跑通**：`limit` 专属消息不在这个文件里（落在 `src/rpc/handlers/content.ts:57`），但通用数字守卫 `validate.ts:39`（`value < options.min || value > options.max` 那句）唯一命中，已补为兜底候选；注意中和它会同时放开其它数字参数的上限校验 |
| M3 | `docs/contracts/openapi.yaml` | not-run | 目标文件被其它轮次改动中（`git status: ?? docs/contracts/openapi.yaml`） | **预计可跑通**：`- news.list` 在枚举块 `L227` 唯一命中（另有 3 条兜底各唯一） |

准入规则：**目标文件存在** 且 **该文件单文件 `git status --porcelain` 为空** 两条同时成立才 apply；否则记 not-run 并不写入。revert 只用 apply 前的字节备份原样写回 + 逐字节复核 + 同一单文件状态复查，**不用** `git checkout`/`git stash`/`git reset`，不碰别人未提交的实现。三条目标现在都已由 A 轮落盘但尚未 `git add`，所以仍被「改动中」拦下——这是准入规则在起作用，不是失败。A 轮提交、工作区干净后直接重跑 `mutations\apply-revert.ps1` 即可看到 killed/绿恢复的完整链路。

## 8 并行隔离与安全边界

- **写权**：只写 `tools/contract-tests/**` 与 `.scratch/run/E/**`；不写 `apps/server`、`docs/contracts`、`packages`、`apps/desktop`、根 `package.json`/`pnpm-lock.yaml`。A 轮随时可能落盘 `apps/server` 与 `openapi.yaml`，本包**不因它们的出现改期望值**，也不提交或还原别人的改动。
- **数据目录**：只读写 `.scratch/run/E/` 下的隔离副本（种子库从 `release/win-unpacked/resources/seed/learning.db` 或 `.scratch/sample-home/data/learning.db` 复制）；拒绝 `--home` 指向 `%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent`。
- **端口**：E 不启动服务端；http 目标只连 `--base-url`；electron 本地实例端口用 `listen(0)` 取空闲端口；不 kill 任何进程。
- **Electron 锁**：与 H 轮共享 `.scratch/run/electron.lock`，只原子创建；拿不到退避 30s（每 2s 一次）后整组 `skipped` 并写原因；只删除自己创建成功的那把。
- **报告**：只落 `tools/contract-tests/report/**`（已被本包 `.gitignore` 忽略），日志脱敏。

## 8.5 本轮修复（E 轮对真实 apps/server 的缺陷清单）

每条都带「修复前红 / 修复后绿」的可执行证据，命令与输出见提交说明。

| # | 缺陷 | 修复位置 | 修复前 | 修复后 |
|---|---|---|---|---|
| P1-2 | E-072 用字面量 `req_contract_tests_unknown`（含下划线，不匹配服务端 `^req_[a-z0-9]{1,24}# E · 契约测试（tools/contract-tests）

一套断言，三个目标：`stub`（内存桩，断网可跑）、`http`（打 `apps/server` 的 RPC 与 5 个专用通道）、`electron`（经 `tools/automated-testing` 的 `launchElectron` 打本地桌面端）。外加 OpenAPI 覆盖核对命令与 3 条 mutation 回放机制。

本包是独立包：`type=module`、纯 `.mjs`、**零第三方运行时依赖**（HTTP/SSE 用 Node 22 内置 `fetch`，YAML 用手写轻量解析，Electron 复用 `tools/automated-testing` 已装好的 `tsx`/`playwright`）。不进根 workspace，不跑根 `pnpm install`，不动根 `package.json` 与 `pnpm-lock.yaml`。

## 1 目录与职责

```text
tools/contract-tests/
  package.json              独立包声明（scripts: test / test:http / test:electron / test:both / coverage / mutations）
  run.mjs                   CLI 入口：解析参数、选 target、编排用例、汇总退出码（不写断言、不发 HTTP）
  coverage.mjs              OpenAPI 覆盖核对命令（读 docs/contracts/openapi.yaml，只读）
  cases/
    methods.mjs             30 个方法的合法/非法用例（E-001..E-060）+ 4 个 legacy（E-061..E-064）
    illegal-class.mjs       非法五类专属（E-065..E-069）
    channels.mjs            5 个专用通道（E-070..E-076）
    openapi.mjs             OpenAPI 覆盖四项（E-077..E-080）
  src/
    frozen.mjs              冻结表：30 方法/4 legacy/5 通道/14 错误码/逐字中文消息（唯一事实来源）
    target-interface.mjs    目标抽象与 SkipSignal / TargetUnreachable
    stub-target.mjs         内存桩（按冻结表实现返回形状与全部错误分支）
    http-target.mjs         fetch + Bearer + RPC 信封 + 通道 + discovery
    electron-target.mjs     经 launchElectron 启动，`window.learning` 桥接
    sse-client.mjs          SSE 逐帧解析与 CollectedStream
    assert.mjs              断言原语、深比较、脱敏
    report.mjs              report.json / report.md / 证据落盘
    fixtures.mjs            学生夹具、符号占位解析、缺失 ID
    openapi.mjs             openapi.yaml 轻量解析与四项核对
    patch.mjs               mutation 声明式规格的 apply/revert 与单文件状态复查
  report/                   运行产物（.gitignore 已忽略），按 yyyyMMdd-HHmmss 分目录
  mutations/
    m1-drop-done.mjs        M1 规格：删 SSE done 帧 → E-070
    m2-loosen-limit.mjs     M2 规格：放开 limit 校验 → E-034
    m3-enum-29.mjs          M3 规格：method 枚举 30→29 → E-077
    apply-revert.ps1        回放驱动（apply → 复跑 → revert → 单文件状态复查）
    README.md               口径说明、锚点策略、漂移维护
```

分层规则：`cases/` 只描述「打什么、断言什么」，不出现 `fetch` / IPC / `_electron`；传输差异全在 `src/*-target.mjs`；断言失败一律落盘 expected/actual，不吞。

## 1.5 跑 http 目标的前置条件（干净克隆照做即可）

```bash
# 1) 起服务端（另开一个终端，隔离 home，别指真实数据目录）
LEARNING_AGENT_HOME=<repo>/.scratch/run/E/server-home pnpm --dir apps/server start

# 2) 建学生 A（E 默认 20230001）
pnpm --dir apps/server exec tsx scripts/add-student.mjs \
  --id 20230001 --name 契约测试学生甲 --cohort 2023 --password <口令>

# 3) 建学生 B（E-068 越权构造需要；缺 B 时 E-068 显式 skip 并写明原因）
pnpm --dir apps/server exec tsx scripts/add-student.mjs \
  --id 20230002 --name 契约测试学生乙 --cohort 2023 --password <与 A 同口令>

# 4) 跑
node run.mjs --target http --base-url http://127.0.0.1:8080 \
  --student-id 20230001 --password <口令>
```

账号口令取 `apps/server/README.md` 的测试账号；`src/fixtures.mjs` 里的默认值只是本地夹具，可用 `--student-id` / `--password` 覆盖。

- **E-062 / E-063**：`getBlock` 的 `blockId` 与 `getResource` 的 `resourceId` 没有列表方法，本包只从服务端自己返回过的引用里取（章节 id、会话消息 citations、产物 source_refs），逐个试调用验证；取不到就 skipped 并写原因，绝不编造 ID。
- **E-073 / E-074**：题目 id 从 `questions.attempts` 的 `question_id`（snake_case，按 openapi 的 QuestionAttempt）取；没有作答时回落到题目集产物的 `content_json.questions`。E-074 必须拿到**两个不同**题号（同一题提交两次会被服务端按「重复提交」拒绝），不足两道即 skip。

## 2 怎么跑

```powershell
cd tools\contract-tests

node run.mjs --target stub                        # 内置桩自洽跑（不联网、不起进程）
node run.mjs --target http                        # 打 --base-url（默认 http://127.0.0.1:8080）
node run.mjs --target http --base-url http://127.0.0.1:8080 --only news.list
node run.mjs --target electron                    # 复用现有 driver 拉本地 Electron
node run.mjs --target electron --only E-001       # 单条合法用例（最小可验收单位）
node run.mjs --target both                        # 先 http 组，再 electron 组，报告分两组
node coverage.mjs                                 # OpenAPI 覆盖核对
powershell -NoProfile -File mutations\apply-revert.ps1   # mutation 回放
```

参数（启动期一次读完冻结，运行期不再重读）：`--target stub|http|electron|both`（默认 `stub`）、`--base-url`（`http://host:port`，路径前缀固定 `/api/v1`）、`--only`/`--case`（用例编号或方法名）、`--home`（默认 `.scratch/run/E/home-<短id>/`）、`--report`（默认 `report/<时间戳>/`，相对本包；同一秒撞名自动加 `-2`/`-3`，不复用别的运行目录）、`--student-id`、`--password`。

退出码：

| 码 | 含义 | 实测触发条件 |
|---|---|---|
| 0 | 通过 / 按设计跳过 | 全绿；或 http 组不可达整组 skipped、electron 锁未取得整组 skipped、OpenAPI 缺失 4 条 pending |
| 1 | 至少一条用例 failed | 断言不成立、coverage red、SSE 超时、登录失败；mutation 回放期预期变红 |
| 2 | 显式 `--target http` 且服务端不可达 | 连接拒绝/超时；`--target both` 下 http 组只记 skipped，不记 2 |
| 3 | CLI 参数非法 | `--target` 非法值、`--base-url` 形态错、`--only` 无匹配、`--home` 指向真实目录、`--report` 越界或不可写 |

## 3 80 条用例的算术

```text
30 方法 × 2（合法 E-001..E-030 + 非法 E-031..E-060） = 60
4 legacy 方法 × 1（E-061..E-064）                      =  4
非法五类专属（缺字段/类型错/404/403/未知方法 E-065..E-069）=  5
专用通道 7（E-070 SSE 顺序 / E-071 取消 / E-072 cancel 未知 /
           E-073 answer 回读 / E-074 answer-set 回读 /
           E-075 交卷空数组 / E-076 health 无鉴权）        =  7
OpenAPI 覆盖 4（E-077 enum 30 / E-078 通道 5 /
                E-079 legacy 4 / E-080 Result schema 30）  =  4
合计                                                     = 80
```

`summary.total` 在单目标运行下恒为 80（`--target both` 下按「同一编号在两个目标各记一条」计为 160，另给 `uniqueCases=80`）。`coverage` 不计入执行计数，它的四项核对对应 E-077..E-080。

## 4 报告与证据

```text
report/<yyyyMMdd-HHmmss>/
  report.json     汇总：schemaVersion 1.0 / round E / target / startedAt / finishedAt /
                  environment{baseUrl,port,home,openapi,openapiReadAt,lockedElectron,seed,electronLock,electron,http,...} /
                  summary{total,passed,failed,skipped,pending,uniqueCases,expectedTotal} /
                  cases[{id,kind,method,channel,target,status,assertions[],expected,actual,evidence,durationMs,error,reason}] /
                  mutations[] / probes[]
  report.md       人读：失败明细、覆盖矩阵、跳过与待定、mutation、前置探针
  cases/<id>.json 单条用例：入参、期望、实际、逐条断言差异、耗时、源码依据
  sse/<id>.txt    SSE 原始帧（stub/http）或事件序列（electron）
  coverage.json   coverage.mjs 产出（含 readAt 读取时刻）
  mutations/<id>.diff  mutation 运行时生成的 diff（准入通过并实际 apply 时才有）
  run.log         每用例一行结构化日志（脱敏：token / 口令 / 消息正文不落盘）
```

## 5 已实测（本机实跑记录）

环境：Windows + Node v22.23.2，仓库根 `<仓库根>`，命令均在 `tools\contract-tests` 下执行。下表是**最终一轮**实跑（A 轮产物 `apps/server/`、`docs/contracts/openapi.yaml` 均已落盘之后）。

| # | 命令 | 退出码 | 结果 | 报告目录 |
|---|---|---|---|---|
| A | `node run.mjs --target stub` | 0 | 共 80 条：**passed 80 / failed 0 / skipped 0 / pending 0**（openapi 落地后 E-077..E-080 由 pending 转 passed） | `report/20261120-093902` |
| B | `node coverage.mjs` | 0 | `openapi:"present"`、`status:"green"`；E-077 30/30、E-078 5/5、E-079 4/4、E-080 30/30，missing 与 extra 均为 `[]`；读取时刻 `2026-11-20T01:39:03.052Z` | `report/20261120-093903/coverage.json` |
| C | `node run.mjs --target http --base-url http://127.0.0.1:8099`（该端口无人监听） | 2 | 中文一行 `服务端不可达（http://127.0.0.1:8099）：请先启动 apps/server，或用 --target stub 跑自洽用例。`；80 条全部 `skipped` 且 reason 为该句 | `report/20261120-093939` |
| D | `node run.mjs --target electron --only E-001` | 0 | Electron 真实拉起，E-001 `student.current` passed；环境段有 `mainPid`、`launchMs`、`close{exitCode,forced,portFree}` | `report/20261120-093914` |
| E | `powershell -NoProfile -File mutations\apply-revert.ps1` | 0 | 三条全部 `not-run`、`applied=false`、`reverted=true`，reason 均为「改动中（`?? …`）」（见 §7） | 无 diff 产物（准入拦截，未写入被测文件） |
| F | `python plans\server-client-split\00-master\check-docs.py --round E` | 0 | 轮次齐全、节数达标、引用与行号对得上（E 轮文档未被本包改动） | — |

补充实测：

- **对准真实 `apps/server` 的只读抽测**（实例已在 `127.0.0.1:8080` 运行，A 轮自己的 home，账号按 `apps/server/README.md` 的 `20230001 / abc12345`）：`E-001` passed、`E-069`（未知方法 404 `没有这个方法：learning.__nonexistent__`）passed。`E-034` 曾暴露 `error.field="params.limit"` 与冻结 §4.1 样例 `"field": "limit"` 不一致，A 已修复，本轮实测一致。`E-031` / `E-065` 遇到服务端登录限流（`429 RATE_LIMITED 尝试太频繁…`，与其它并行轮的验收流量抢同一 IP 窗口），属环境争用，未据此改期望值；等窗口内无并发后可复跑。
- **http 全链路**：`.scratch/run/E/http-fixture/` 下的临时 fixture 服务端做过全量 80 条（74 passed / 2 skipped / 0 failed / 4 pending，那时 openapi 还没落地）；`E-070` 帧序 `session→round→text→text→done`、`E-071` 取消后 `eventOrder=[session,error]`、`code=CANCELLED`、`doneCount=0`。fixture 只是自测件，不替代 `apps/server`、不进仓库产物。
- **`--target both`**：http 组不可达 + electron 锁被别的轮次占着时，160 条记录全 `skipped`、退出码 0、`uniqueCases=80`，两条 reason 各自写明（解锁后 electron 组正常跑）。
- **CLI 非法参数**（全部退出码 3，且不落任何文件）：`--target nope`、`--only E-999`、`--base-url banana`、`--report ..\outside`、`--home "$env:APPDATA"` / `~/.learning-agent` / `<repo>/.learning-agent`；`node coverage.mjs --report ..\evil` 同样 3。
- **mutation 闭环**：`.scratch/run/E/selftest/` 的干净假仓库里真跑过 apply→变红（killed）→按原字节还原（逐字节复核一致）→复跑变绿；另有 survived、「` M` 改动中拦截」两个口径自测，三套均退出 0。
- **报告目录同名保护**：自动命名只到秒，同一秒连跑会撞名。实测连跑 4 次 `--only E-001` 得到 `…092148`、`…092148-2`、`…092149`、`…092149-2`，后一次不再覆盖前一次的 `report.json`（此前正是这样丢过一次证据，已修）。

## 6 与设计文档的偏差（代码为准，逐条写明）

1. **文件形态**：`E-contract-tests/README.md` 的产出草图写的是 `src/cli.ts` 等 `.ts` 路径；`03-implementation.md` §1 已明确「按下表落地为 `.mjs` 扁平结构，不再分 `src/` 层」。本包按 `.mjs` 落地，无编译步骤。
2. **mutation 载体**：文档写 `mutations/*.patch`。本包改为**声明式规格** `mutations/m1-drop-done.mjs` 等：被测文件当前不存在，手写 patch 会把不存在的 diff 硬编码进仓库；现在 apply 时按行比对**运行时生成** unified diff 落盘，revert 用原字节备份逐字节还原，并复查单文件 `git status`。理由与被拒方案对比见 `mutations/README.md`。
3. **electron 的事件序列**：桌面端 `learning:chat` 是一次性 IPC（不是 SSE），没有事件流可采。`electron-target.mjs` 把 `TurnResponse` 合成 `session → text(1-3 段) → done` 帧，并在文件头注释写清这一点；E-070 因此可在 electron 上跑，而 E-071..E-075（在途取消、交卷回读）在 electron 上显式 `skip` 并写明原因。
4. **报告的新增字段**：冻结 schema 之外只增不改——
   - `environment.openapiReadAt`、`coverage.json.readAt`：并行期 A 轮可能随时落盘 `openapi.yaml`，报告必须写明「读取时」的状态（冻结字段 `openapi`/`file`/`status`/`checks` 名字与结构未动）；
   - `summary.uniqueCases` / `summary.expectedTotal`：`--target both` 下 `total` 是记录数，这两个字段保留 80 条算术；
   - `probes[]`：`AUTH_REQUIRED` / `AUTH_INVALID` 是冻结 §4.1 说的「鉴权前置探测」，不占 80 条编号，单独成段。
5. **`FORBIDDEN` 文案的文档内冲突**：`01-frozen-contracts.md` §3.3 写「这条会话不属于当前学号。」，§4.2 与 `02-contract.md` §4.1 写「这个资源不属于当前学号，换回自己的账号再试。」。E-068 断言的是**后者**（§4.2 是「冻结错误码表（不得新增同义码）」且被 E 轮契约逐字引用）。这条冲突需要人裁决：若确认按 §3.3 分资源给文案，改 `src/frozen.mjs` 的 `ERROR_CODES.FORBIDDEN` 一处即可。
6. **`E-080` 的 missing 口径**：冻结 §8 写「至少覆盖 30」，本包 `missing` 列未覆盖的方法名；`extra` 只列「结尾 `Result` 且不在 30 个期望名内」的 schema，并把 `HealthResult` / `LoginResult` 这类健康检查与登录的伴随 schema 排除在 extra 之外（它们不是方法覆盖项，A 的契约里本来就该有）。
7. **`--target both` 的 total**：冻结要求「同一编号在不同 target 各产出一条记录」，实现按记录数统计并在 `uniqueCases` 保留 80。
8. **客户端请求号形态**：A 的 `REQUEST_ID = /^req_[a-z0-9]{1,24}$/` 不接受下划线，而本包早先用的是 `req_<base36>_<序号>`，带第二个下划线 → 服务端按「不合法则自生成」分支换掉了我们的号，`requestId 回显` 断言因此红过一次。已把 `src/fixtures.mjs` 的 `newRequestId()` 改成 `req_` + 12 位小写 base36（与冻结 §4.1 示例 `req_abc123`、03-implementation §3.2 第 3 条同形），改后对真实实例 E-001 直接 passed。

## 7 mutation 当前状态（如实记录，未写死结论）

| 编号 | 目标文件 | 状态 | reason（原文口径） | 入库干净后的预判（只读干跑，非实测） |
|---|---|---|---|---|
| M1 | `apps/server/src/chat/stream.ts` | not-run | 目标文件被其它轮次改动中（`git status: ?? apps/server/src/chat/stream.ts`） | **锚点已修，可跑通**：锚点改为 `writer.done(`（`stream.ts:127`，全文唯一 1 次；实测 `writer.done (` / `emit('done'` / `sendEvent(res, 'done'` 均为 0 次）。替换为 `if (false) writer.done(`：调用进恒假分支、载荷字面量原位保留，文件仍可编译，效果是不再发 done 帧 |
| M2 | `apps/server/src/rpc/validate.ts` | not-run | 目标文件被其它轮次改动中（`git status: ?? apps/server/src/rpc/validate.ts`） | **预计可跑通**：`limit` 专属消息不在这个文件里（落在 `src/rpc/handlers/content.ts:57`），但通用数字守卫 `validate.ts:39`（`value < options.min || value > options.max` 那句）唯一命中，已补为兜底候选；注意中和它会同时放开其它数字参数的上限校验 |
| M3 | `docs/contracts/openapi.yaml` | not-run | 目标文件被其它轮次改动中（`git status: ?? docs/contracts/openapi.yaml`） | **预计可跑通**：`- news.list` 在枚举块 `L227` 唯一命中（另有 3 条兜底各唯一） |

准入规则：**目标文件存在** 且 **该文件单文件 `git status --porcelain` 为空** 两条同时成立才 apply；否则记 not-run 并不写入。revert 只用 apply 前的字节备份原样写回 + 逐字节复核 + 同一单文件状态复查，**不用** `git checkout`/`git stash`/`git reset`，不碰别人未提交的实现。三条目标现在都已由 A 轮落盘但尚未 `git add`，所以仍被「改动中」拦下——这是准入规则在起作用，不是失败。A 轮提交、工作区干净后直接重跑 `mutations\apply-revert.ps1` 即可看到 killed/绿恢复的完整链路。

## 8 并行隔离与安全边界

- **写权**：只写 `tools/contract-tests/**` 与 `.scratch/run/E/**`；不写 `apps/server`、`docs/contracts`、`packages`、`apps/desktop`、根 `package.json`/`pnpm-lock.yaml`。A 轮随时可能落盘 `apps/server` 与 `openapi.yaml`，本包**不因它们的出现改期望值**，也不提交或还原别人的改动。
- **数据目录**：只读写 `.scratch/run/E/` 下的隔离副本（种子库从 `release/win-unpacked/resources/seed/learning.db` 或 `.scratch/sample-home/data/learning.db` 复制）；拒绝 `--home` 指向 `%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent`。
- **端口**：E 不启动服务端；http 目标只连 `--base-url`；electron 本地实例端口用 `listen(0)` 取空闲端口；不 kill 任何进程。
- **Electron 锁**：与 H 轮共享 `.scratch/run/electron.lock`，只原子创建；拿不到退避 30s（每 2s 一次）后整组 `skipped` 并写原因；只删除自己创建成功的那把。
- **报告**：只落 `tools/contract-tests/report/**`（已被本包 `.gitignore` 忽略），日志脱敏。

）→ 真实服务端 400，而断言 200 | `cases/channels.mjs:196` 改用 `ctx.newRequestId()` | 对真实服务端红（400 vs 200） | 请求号合法且服务端从未见过，断言 200 成立 |
| P1-3 | discovery 与回读用 camelCase（`questionId`/`sourceId`），真实返回 `question_id`/`source_id` → E-073/E-074/E-029 永久 skipped | `src/http-target.mjs` `probeDiscovery`、`cases/channels.mjs` 回读、`src/electron-target.mjs` | discovery 键为空，用例 skipped | 五个键全部取到（实测 `sourceId=ledger-src-1`、`questionIds=[q-snake-1,q-snake-2]`） |
| P1-4 | E-074 用同一个 questionId 提交两次，服务端抛「重复提交」→ 必红 | `cases/channels.mjs` E-074 + `requireDistinctQuestions` | 必红 | 提交 `[q-alpha, q-beta]`，断言全绿；不足两题时 skip 并写明原因 |
| P1-5 | `limit` 类型错消息与 `field` 口径 | 断言保持冻结口径（裸名 `limit`、`limit 必须是整数。`），未放宽 | 服务端返回 `params.limit` / 范围消息时红 | 服务端按 A 轮 02-contract §4.1 修正后绿（**依赖另一任务**，见 §9） |
| P1-6 | SSE 采集器默认 `stopAfterTerminal=true`，收到 done 即 cancel → E-070 `doneNoTrailingEvents`、E-071 `noTextAfterError` 恒真 | `src/sse-client.mjs`：默认取证模式，读到 EOF 或 `terminalGraceMs`(2s)；返回 `trailingAfterTerminal` | done 后多发的帧被掐断，断言恒绿 | 假 target「done 之后再发 text」实测判红（`eventOrder=session→round→text→done→text`，`trailingAfterTerminal=1`） |
| P1-7 | M1 的 4 个候选锚点在真实 `stream.ts` 全部 0 次命中 → 100% anchor-miss | `mutations/m1-drop-done.mjs` 锚点改 `writer.done(` | anchor-miss | 唯一命中 1 次；替换为 `if (false) writer.done(` 保持可编译 |
| P1-8 | `probeDiscovery` 缺 `blockId`/`resourceId` → E-062/E-063 永久 skipped | `src/http-target.mjs`：resourceId 取章节 id 试 `getResource`；blockId 从 citations/source_refs 候选逐个 `getBlock` 验证 | 永久 skipped | 实测 `blockId=cb_1`、`resourceId=ch01` |
| P1-9 | E-068 需要学生 B 但无创建路径 | `src/fixtures.mjs` 注释 + `README.md §1.5` 建号命令；`src/http-target.mjs` 新增 `requireStudentB()`，B 不存在时显式 skip | 401 撞 403 断言，报成红 | 缺 B 时 skipped 且 reason 写明建号命令 |
| P1-10 | coverage 把解析失败伪装成缺失（`catch { doc=null }` + `present` → pending，退出 0） | `src/openapi.mjs` `loadContract` 区分 `missing`/`invalid`；`runChecks` 新增 `invalidReport`；`coverage.mjs` 摘要 | 坏 yaml → pending，退出 0 | 坏 yaml / 空文件 / 无 paths → `invalid` + `status=red` + 退出 1；不存在才 pending |
| P2-11 | E-077 集合语义看不见重复项（30 项塞一个重复、漏一个方法时 missing/extra 双双为空） | `src/openapi.mjs` `checkEnum` 加 `duplicates` 与条数比对；`cases/openapi.mjs` 加断言 | 31 项（30 方法 + 1 重复）判绿 | 实测判红：`actual=31`、`duplicates=[news.list]`、`status=red` |

## 9 已知限制与未执行项

- 三条 mutation 全部 not-run（原因见 §7）：目标文件已被 A 轮落盘但仍是未跟踪状态，准入按「改动中」拦截，属并行期正常分支，不是「已杀死」。M1 的锚点已按真实实现刷新为 `writer.done(` 并实测唯一命中（§7）；文件入库干净后重跑 `apply-revert.ps1` 即可看到 killed → 绿恢复。
- **没有对真实 `apps/server` 跑全量 http**：E 不代管进程（不启服务、不 kill），A 的实例与测试账号由 A 决定；且全量里含 `memory.upsert` / `news.refresh` 这类写路径，拒绝往别人正在验收的 home 里写。目前只做了只读抽测（E-001 / E-069 passed，E-034 见 §6 第 5 条之外的 `field` 差异，E-031 / E-065 遇 429 限流）。要全量请自备一个隔离 home 的实例，然后 `node run.mjs --target http --base-url http://127.0.0.1:<port> --student-id <A 的测试学号> --password <口令>`。
- **真机抽测里的一条待裁决差异（已裁决并修复）**：A 曾返回 `error.field="params.limit"`，冻结 §4.1 同名消息的样例是 `"field": "limit"`。A 已按冻结样例改成裸参数名（`apps/server/src/rpc/validate.ts`），本轮实测 `field="limit"`，本包的期望值无需改动。
- electron 全量会因桌面端宽容实现出现非法用例 failed（如 `--only student.current` 下 E-031 期望 `400 params 必须是对象。`、桌面端返回 200），这是 01-scope §4 记录的差异；合法用例组用 `--only` 单跑即可退出 0。
- `E-062` / `E-063`（`getBlock` / `getResource`）在 http 目标下依赖 discovery 取到 `blockId` / `resourceId`；本轮已补探测（章节 id 试 `getResource`，citations/source_refs 候选逐个 `getBlock` 验证），种子库为空时仍会 skipped 并写原因，不编造 ID。
- **真实 `apps/server` 的 http 全量待补验**：本轮的 http 修复全部用「假 target / 假服务端」逐项单测（SSE 取证、discovery snake_case、E-072 请求号、E-074 双题号），以及 stub 全量 80/80 与干净克隆模拟验证；全量 http 需要另一个任务先修完服务端 `validate.ts` 的 `params.limit` 与 `limit 必须是整数。` 两处，之后按 §1.5 起实例跑。
- **本包自身修过的三个缺陷（留档，避免再犯）**：① 报告目录同秒撞名覆盖证据（已加 `-2` 后缀）；② `--home` 校验只比前缀、漏了「正好等于 `%APPDATA%`」的写法，实测在真实配置目录建出过一次空 `data/`（当场删干净，判定改为「等根或根的子路径」都拦）；③ `newRequestId()` 带下划线，被 A 的请求号正则判为非法而自生成（见 §6 第 8 条）。
