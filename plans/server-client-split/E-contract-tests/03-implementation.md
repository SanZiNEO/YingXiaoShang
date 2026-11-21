# E · 契约测试 · 实现方案

> 轮次：E · 契约测试
> 文档角色：03-implementation
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1（`tools/contract-tests/**` 归 E）
> 一句话：一套用例经统一 Target 抽象分别打 HTTP 服务端、本地 Electron 与内置 stub；断言信封、中文错误消息、SSE 事件顺序与 OpenAPI 覆盖，证据全部落盘到 `tools/contract-tests/report/`。

## 1 目录与模块

E 轮产物全部落在 `tools/contract-tests/`（写权见归属矩阵「`tools/contract-tests/**` | **E** | 全部」）。目录树与职责如下；README 里的 `src/cli.ts` 草图是早期形态，本轮按下表落地为 `.mjs` 扁平结构，不再分 `src/` 层。

```text
tools/contract-tests/
  package.json                 # 独立包声明；type=module；不进根 workspace
  run.mjs                      # CLI 入口：解析参数、选 target、编排用例、汇总退出码
  coverage.mjs                 # 覆盖核对命令：解析 openapi.yaml，输出三判据结果
  cases/
    methods.mjs                # 30 个业务方法的合法/非法用例 + 4 个 legacy 只读用例
    illegal-class.mjs          # 5 类非法输入的构造器与逐字中文消息表
    channels.mjs               # 5 个专用通道用例：chat/stream、chat/cancel、answer、answer-set、health
    openapi.mjs                # 4 项覆盖断言枚举（enum 30、通道 path 5、legacy 4、Result schema 30）
  src/
    target-interface.mjs       # Target 抽象接口（connect / rpc / stream / cancel / answer / health / close）
    http-target.mjs            # HTTP 实现：fetch + Bearer token + 登录前置
    sse-client.mjs             # SSE 逐帧解析器：按 event/data/id 切帧，产出有序事件数组（http-target 内部模块）
    electron-target.mjs        # Electron 实现：复用 automated-testing 的 driver 封装
    stub-target.mjs            # 内置 stub：内存 fixture，断网可跑，供用例开发与自洽验收
    assert.mjs                 # 信封断言：ok/result/error.code/error.message/requestId/字段类型
    report.mjs                 # 报告汇总：JSON + Markdown + 每条用例证据落盘
    openapi.mjs                # openapi.yaml 解析与三判据核对（缺失时降级为冻结表比对）
    ports.mjs                  # 随机空闲端口分配（net.createServer listen 0）
    fixtures.mjs               # 测试数据：学生对、会话/产物/事实样例 ID、消息边界值
    patch.mjs                  # mutation apply/revert：读 mutations/*.patch，复查干净状态
  report/                      # 运行产物根目录（gitignore），按时间戳分子目录
  mutations/
    m1-drop-done.patch         # 删 SSE done 事件
    m2-loosen-limit.patch      # 放开 limit 整数/越界校验
    m3-enum-29.patch           # method 枚举删掉一项
    apply-revert.ps1           # 脚本化 apply / 复测 / revert / 干净状态复查
  README.md                    # 本工具包使用说明（E 自建，不改轮次目录下的原始 README）
```

分层原则：`cases/` 只描述「打什么、断言什么」，不感知传输方式；传输差异全部收进 `src/*-target.mjs`。这样同一套断言既能打 `--target http`，也能打 `--target electron`，与 consumer-driven contract 测试里「用例与传输解耦」的做法一致 [R8]。Playwright 的 fixture 与取证模式沿用现有测试模块的成熟结构，不在本包另造一套 [R1]。

| 层 | 文件 | 一句话职责 | 不许干的事 |
|---|---|---|---|
| 入口 | `run.mjs` | 参数解析、target 选择、用例编排、退出码汇总 | 不写断言细节，不直接发 HTTP |
| 覆盖 | `coverage.mjs` | 独立命令，核对 OpenAPI 与冻结表 | 不改 `docs/contracts/openapi.yaml`（A 是唯一 owner） |
| 用例 | `cases/*.mjs` | 用例清单、入参 fixture、期望错误码与中文消息 | 不出现 `fetch`/`_electron` 等传输符号 |
| 传输 | `src/*-target.mjs` | 把用例调用翻译成对应通道的请求/事件流 | 不做业务断言 |
| 断言 | `src/assert.mjs` | 信封、字段类型、中文消息逐字比对 | 不吞断言失败（失败必须抛出并落盘） |
| 报告 | `src/report.mjs` | 汇总通过/失败/跳过/pending，写 JSON 与 Markdown | 不修改被测代码 |
| 工具 | `src/ports.mjs`、`src/openapi.mjs` | 端口分配、yaml 解析 | 不访问真实数据目录 |

## 2 依赖与构建

### 2.1 独立包，不进根 workspace

`pnpm-workspace.yaml:1` 的 glob 只有 `packages/*`、`profiles/*`、`apps/*`，`tools/*` 不在其内；因此 E 包在自己目录下独立安装，各自 lockfile，根 `pnpm-lock.yaml` 只归 A 碰（归属矩阵 §1 与 §2「各工具包都改根 lockfile」一节）。

```powershell
cd E:\Documents\GitHub\YingXiaoShang\tools\contract-tests
pnpm install --ignore-workspace
```

`package.json` 声明：

```json
{
  "name": "@yingxiaoshang/contract-tests",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node run.mjs --target stub",
    "test:http": "node run.mjs --target http",
    "test:electron": "node run.mjs --target electron",
    "coverage": "node coverage.mjs"
  }
}
```

### 2.2 运行时依赖口径

- **HTTP 与 SSE 只用 Node 内置**：`fetch`（Node 22 全局）、`node:net`、`node:fs`、`node:path`、`node:module`，不引 axios/got/eventsource 第三方包，减少独立包的安装面。
- **Playwright 复用现有安装**：Electron 目标需要的 `@playwright/test` 与 `playwright` 已在 `tools/automated-testing/package.json:16`（`@playwright/test` 1.64.1）及其 `node_modules` 内；E 包**不在自己的 dependencies 里重复声明**，运行 electron 目标时经 `createRequire` 把 `tools/automated-testing/node_modules` 加入解析路径。这条与归属矩阵 §3「H 复用 `tools/automated-testing` 现有 `node_modules`」同一口径。
- **不新增根依赖**：不在仓库根 `package.json` 加任何条目，不跑根 `pnpm install`；E 包的 lockfile 只落在 `tools/contract-tests/` 内。
- **YAML 解析**：`openapi.yaml` 是 3.0.3 纯文本，`src/openapi.mjs` 用轻量手写解析（取 `paths`、`components.schemas`、`x-legacy-methods`、method enum 四处）；不引 `yaml` 包。若后续 OpenAPI 结构复杂化，再评估 Redocly CLI 作为外部核对手段 [R7]。

测试结构上遵循「禁止固定等待、用轮询/事件收集器断言」的既有实践，不在用例里写 `sleep`/`waitForTimeout` [R3]。

### 2.3 构建与类型

E 包是纯 `.mjs`，不做编译步骤；`node run.mjs` 直接执行。Electron 目标复用的 driver 源码是 `.ts`，经 `tools/automated-testing` 已有的 `tsx`（其 `node_modules/.bin/tsx`）加载；E 包不另装 `tsx`、`typescript`。类型检查由 automated-testing 包自己的 `pnpm typecheck` 负责，E 不重复。

## 3 关键实现

### 3.1 Target 抽象接口

`src/target-interface.mjs` 定义所有目标必须实现的同一组方法；用例只依赖这个接口，不依赖具体传输。

```ts
interface ContractTarget {
  readonly kind: 'http' | 'electron' | 'stub'
  connect(): Promise<void>                                  // 登录前置 / 启动实例 / 装载 fixture
  rpc(method: string, params: Record<string, unknown>): Promise<RpcEnvelope>
  stream(input: ChatStreamInput): Promise<CollectedStream> // SSE：返回有序事件数组
  cancel(requestId: string): Promise<{ cancelled: boolean }>
  answer(input: AnswerInput): Promise<unknown>
  answerSet(input: AnswerSetInput): Promise<AnswerSetResponse>
  health(): Promise<HealthResponse>
  close(): Promise<void>
}

interface RpcEnvelope {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string; field?: string; detail?: unknown }
  requestId: string
  elapsedMs?: number
}
```

- 信封字段与冻结 §4.1 一致：成功 `ok:true` + `result`；失败 `ok:false` + `error{code,message,field,detail}` + `requestId`。
- `rpc()` 不抛传输层异常来表达业务失败：业务 4xx/5xx 一律解包成信封返回，由 `assert.mjs` 判 `ok`；只有连接级失败才抛 `TargetUnreachable`（见 §6）。
- 三个实现（http / electron / stub）在 `run.mjs` 按 `--target` 选择；`both` 时先跑 http 再跑 electron，报告分两组小节。

### 3.2 HTTP 目标：fetch + Bearer + 登录前置

`src/http-target.mjs`：

1. **登录前置**：`connect()` 先 `POST /api/v1/auth/login`（学号/口令来自配置，见 §5），从响应 `result.token` 取 43 字符 base64url token；失败按 §6 的 token 路径处理。
2. **携带凭证**：后续每个 `/api/v1/rpc`、`/chat/stream`、`/chat/cancel`、`/answer`、`/answer-set` 请求带 `Authorization: Bearer <token>`；`/health` 与 `/api/v1/openapi.yaml` 不带。
3. **请求体**：`Content-Type: application/json; charset=utf-8`，body `{ method, params, requestId }`；`requestId` 由 `newRequestId()` 生成（`req_` + 时间戳 base36 + 序号），便于日志串查。
4. **响应解包**：`fetch` 拿到状态码与 JSON body；非 JSON 响应按 `BAD_REQUEST` 形态包装并落盘原始文本。请求体上限 1 MiB、RPC 超时 10s（`news.refresh` 30s、`artifacts.export` 20s）与冻结 §2 一致，超时映射为 `TIMEOUT` 信封。
5. **身份口径**：请求体里不主动塞 `studentId`；若用例需要测「忽略 body 里的 studentId」，由专门用例显式塞入并断言服务端仍以 token 为准（冻结 §3.2）。

鉴权与错误信息披露口径参照 REST 安全实践：登录失败不区分学号不存在与口令错，错误响应不回堆栈 [R11]。RPC 单端点 + `method/params/error` 的形态取自 JSON-RPC 2.0，但不做 batch 与 notification [R6]。

### 3.3 SSE 目标：逐帧解析与顺序断言

`src/sse-client.mjs` 按 WHATWG 帧格式切分响应体：以空行分隔帧，每帧解析 `id:`、`event:`、`data:`（多行 `data:` 按换行拼接）、`: ` 注释行（心跳，跳过）[R4]。解析器参考通用 SSE 客户端的帧状态机做法，但不实现自动重连与 Last-Event-ID 重放 [R10][R5]。

```text
输入：fetch ReadableStream 逐块累积 → 按 \n\n 切帧 → 每帧 {id, event, data, raw}
输出：CollectedStream { events: StreamEvent[], rawFrames: string[], firstTokenMs, doneCount }
```

顺序断言在 `cases/channels.mjs` 内完成，判据对应冻结 §7.1：

1. **首帧必须是 `session`**：`events[0].event === 'session'`，且含 `requestId`、`sessionId`；`session` 对应 `TeamEvent.type='session'`（`packages/agent/src/team.ts:19`），早发的理由见 `packages/agent/src/team.ts:29` 的注释。
2. **中间帧**：`round` / `text`（`agent:"lead"`）/ `tool` / `tool-end` 按到达顺序记录，不要求固定轮数，但 `text` 增量拼接后非空。
3. **终态 `done` 只出现一次**：`doneCount === 1`；`done` 载荷含 `turnId/sessionId/text/artifacts/citations/warnings`，结构对应 `HandleTurnOutput`（`packages/agent/src/index.ts:52`）。
4. **异常分支**：收到 `error` 帧即终止收集；此后不得再出现 `done`；取消场景最多 1 个 `error(code=CANCELLED)`，其后不再产 `text`。
5. **心跳**：`: keep-alive` 注释行不计入事件序列；60s 无任何事件按 §6 超时处理。

Electron 目标下事件来自现有 `ChatEventCollector`（`tools/automated-testing/src/client/chat-events.ts:56` 的 `waitFor`、`:70` 的 `waitQuiet`），`CollectedStream` 由采集器数组转换而来，断言代码与 http 目标共用同一份。

### 3.4 Electron 目标：复用现有 driver 封装

`src/electron-target.mjs` **不自己启动 Electron**：

- 启动一律走 `tools/automated-testing/src/driver/electron-driver.ts:82` 导出的 `launchElectron`，传入隔离 home、`userDataDir`、分配的端口与环境变量；关闭走返回句柄的 `close()`，复用其进程树清理与端口释放逻辑。
- **禁止**在 E 的用例或 target 代码里 `import { _electron } from 'playwright'`，也不得直接 `import '@playwright/test'`；这条是现有模块的硬约束，证据见 `tools/automated-testing/README.md:54`。E 只经 driver 句柄拿 `page`，再经 `LearningClient` 同款桥接调用。
- 端口分配复用 `tools/automated-testing/src/driver/ports.ts:3` 的 `allocatePort` 思路（`net.createServer().listen(0)` 让操作系统给空闲端口）；E 包 `src/ports.mjs` 内置同实现，避免跨包反向依赖 driver 的内部函数。
- **互斥锁**：electron 目标运行前按归属 §5.3 抢 `.scratch/run/electron.lock` 目录锁；拿不到则退避重试 30s（每 2s 一次），仍失败则跳过 electron 目标全部用例，报告标 `skipped` 并写明「未取得 electron 锁」。
- Electron 桥接方法名与现有 `LearningClient` 对齐（`invoke(method, input)`、`chat`、`cancel`、`answer`、`answerSet`、`health`，见 `tools/automated-testing/src/client/learning-client.ts:100-124`）；RPC 信封在桥接层做一次适配，使下游断言与 http 目标同构。

Playwright Electron 的启动与主进程求值能力由 driver 内部使用，E 侧只消费句柄 [R2]。

### 3.5 stub 目标：断网自洽可跑

`src/stub-target.mjs` 在内存里按冻结表构造 fixture：

- 30 方法各返回一份最小合法结构（数组/对象/空数组按冻结 §5 返回顶层形态）；4 个 legacy 返回只读样例。
- SSE 产出固定帧序列：`session` → 2 个 `text` → `done`；`cancel` 用例返回 `cancelled:true`。
- 非法输入在 stub 里同样返回对应错误信封（缺字段/类型错/不存在/越权/未知方法），让非法用例在没有服务端时也能跑通断言逻辑。
- stub 不访问网络、不写库；`--target stub` 是 E 包独立开工与 CI 自检的默认目标（归属 §4 E 的 DoD：`--target stub` 自洽可跑）。

### 3.6 五类非法用例的构造方式

`cases/illegal-class.mjs` 按冻结 §4.2 错误码表与 §5 必填字段消息表构造；每类至少 1 条，覆盖口径见轮次 README「非法输入覆盖」。

| 类别 | 构造方式 | 期望 | 代表用例 |
|---|---|---|---|
| 缺字段 | 从合法 params 里删掉必填键（如 `articleId`、`sessionId`、`artifactId`、`factId`、`evidenceId`、`sourceId`、`chapterId`） | `400 BAD_REQUEST`，消息逐字匹配「`<字段> 不能为空。`」；`checkpoint`/`status` 类枚举缺失/非法用「`checkpoint 必须是 pre 或 post。`」「`status 必须是 draft、reviewed 或 rejected。`」 | `news.get` 不带 `articleId`；`profile.snapshot` 不带 `chapterId` |
| 类型错 | 把数值参数传成字符串（`limit:"10"`）、把数组传成字符串、把枚举传成未收录值 | `400 BAD_REQUEST`，消息「`limit 必须是整数。`」等逐字匹配；`memory.upsert` 非法 `kind` 按冻结 §5 归一为 `goal`，不算非法类 | `kps.list` 传 `limit:"10"` |
| 资源不存在 | 用库里不可能存在的 ID（`articleId`/`artifactId`/`factId`/`evidenceId`/`sessionId` 取随机 uuid 形态） | `404 NOT_FOUND`，消息「`没有找到这条记录，可能已被删除。`」 | `news.get` 不存在 articleId |
| 越权 | 用学生 B 的 token 访问学生 A 的会话/产物/证据（ID 取自 A 的合法用例返回） | `403 FORBIDDEN`，消息「`这个资源不属于当前学号，换回自己的账号再试。`」；不得返回空数组来泄漏存在性 | B 读 A 的 `chat.messages`、`artifacts.get`、`profile.review` |
| 未知方法 | `method` 传冻结表外的名字（`foo.bar`） | `404 UNKNOWN_METHOD`，消息「`没有这个方法：foo.bar`」；对照现状桌面端抛英文 `unknown learning method`（`apps/desktop/src/main/index.ts:391`），HTTP 契约必须是结构化中文错误 | `rpc { method:"foo.bar" }` |

中文消息是产品契约，断言走逐字比对（不含省略号、不做包含匹配）；错误对象的 `field` 字段在有明确字段时必须出现。越权与不存在两类都遵循最小信息披露，不区分「不存在」与「不属于你」的可观测差异 [R11]。

### 3.7 coverage.mjs：OpenAPI 三判据

`coverage.mjs` 独立于用例运行，解析 `docs/contracts/openapi.yaml`（A 轮产物，E 只读），按冻结 §8 的覆盖判据核对：

1. **方法枚举恰好 30**：`paths./api/v1/rpc` 请求体 schema 的 `method` 枚举必须**恰好**等于冻结 §5 的 30 个名字——不多（legacy 不得混入）、不少（缺一项即红）。
2. **通道与 legacy 齐全**：§7 的 5 个专用通道（`/chat/stream`、`/chat/cancel`、`/answer`、`/answer-set`、`/health`）每个都有独立 `path` 条目；§6 的 4 个 legacy（`getKp`、`getBlock`、`getResource`、`listIdeology`）出现在 `x-legacy-methods` 扩展里，而不是 method 枚举中。
3. **返回结构 schema 覆盖**：`components.schemas` 至少覆盖 30 个方法返回结构，命名 `<Method>Result`（点转驼峰，如 `news.list` → `NewsListResult`）。

附加核对：枚举与冻结表做集合差集，报告列出「缺失方法 / 多出方法 / legacy 误入枚举」三类明细。OpenAPI 缺失时（A 尚未产出，或本地未拉到），按冻结 §8 降级：输出 `openapi: missing`，只拿冻结表核对用例侧覆盖，退出码 0，报告整体标 `pending`，不判红。OpenAPI lint 与覆盖检查的先后顺序参照 Redocly 的思路：先结构解析、再比对覆盖 [R7]。

## 4 数据读写

E 轮是测试工具，**对业务库只读、对 OpenAPI 只读**，不写任何业务数据：

| 读 | 写 | 说明 |
|---|---|---|
| `docs/contracts/openapi.yaml`（只读） | — | 仅 `coverage.mjs` 解析；缺文件走 §3.7 降级分支 |
| 被测服务端背后的 `learning.db`（经服务端/桥接间接读） | — | 用例优先选只读方法；写方法（`profile.snapshot`、`memory.upsert`、`memory.delete`、`agent.retry`、`artifacts.export`、`profile.review`）只在隔离 home 副本上跑，且断言后不依赖残留数据 |
| 冻结表（本 plan `01-frozen-contracts.md` §5/§6/§7） | — | 作为 openapi 缺失时的比对基线 |
| — | `tools/contract-tests/report/<时间戳>/` | 唯一写入位置：报告 JSON/Markdown、用例证据、SSE 原始帧、运行日志 |

隔离口径：electron/http 目标使用的 home 副本放在 `.scratch/run/E/home-*/`（归属 §3 E 行），**禁止**读写真实数据目录（`%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent`）；stub 目标不落盘任何库文件。fixture 数据由用例内置或从隔离副本只读探针读取，不复制别人的 `.scratch` 目录。

测试夹具与真实库的关系参照 testfixtures 的做法：用真实结构的隔离副本做断言，而不是 mock 掉整层数据访问；但 E 不引入其运行时 [R9]。报告目录结构：

```text
report/20261119-153000/
  report.json          # 汇总：总数/通过/失败/跳过/pending，按 target 分组
  report.md            # 人读报告：覆盖矩阵、失败明细、mutation 记录
  cases/<case-id>.json # 单条用例：入参、期望、实际、断言差异、耗时
  sse/<case-id>.txt    # SSE 原始帧（http 目标）或事件序列（electron 目标）
  coverage.json        # 三判据结果与差集明细
  run.log              # 运行日志（每用例一行，不含 token/口令/消息正文）
```

## 5 配置

配置分 CLI 参数与环境变量两类；启动期一次读完冻结，运行期不再重读 `process.env`。

### 5.1 CLI 参数（`run.mjs`）

| 参数 | 默认 | 作用 | 取值/校验 |
|---|---|---|---|
| `--target` | `stub` | 选择被测目标：`http` / `electron` / `both` / `stub` | 非法值 → 退出码 3 + 中文一行 |
| `--base-url` | `http://127.0.0.1:8080` | http 目标的服务端地址 | 必须是 `http://host:port` 形态；路径前缀固定 `/api/v1` |
| `--only`（别名 `--case`） | 空（全量） | 只跑匹配的方法名或用例编号（如 `--only news.list`、`--only CT-SSE-01`） | 不匹配任何用例 → 退出码 3 |
| `--home` | `.scratch/run/E/home-<短id>/` | 隔离数据目录；electron/http 实例的库副本位置 | 禁止指向真实数据目录 |
| `--report` | `report/<时间戳>/` | 报告落盘目录 | 相对路径基于 `tools/contract-tests/` |
| `--student-id` / `--password` | 本地测试学生（见 §2 前置） | http 目标登录前置凭证 | 缺省在报告里提示；登录失败按 §6 处理 |

### 5.2 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `YXS_LLM` | `mock` | 透传给被测服务端的 LLM 模式；E 自己不启动服务端，http 目标只校验被测实例是否处于 mock 模式（读 `/health` 旁证，不写服务端配置） |
| `YXS_SERVER_PORT` | `8080` | 与 `--base-url` 对齐；随机空闲端口只用于 electron/stub 侧的本地实例分配 |
| `YXS_ELECTRON_LOCK` | `.scratch/run/electron.lock` | electron 互斥锁目录路径（归属 §5.3） |
| `YXS_SSE_TIMEOUT_MS` | `60000` | SSE 等待终态超时，对齐冻结 §2 的 60s 空闲断开 |
| `YXS_WORKERS` | `1` | 用例并发度，沿用现有模块默认串行口径（`tools/automated-testing/README.md:41`） |

随机空闲端口：electron 目标的本地实例端口由 `src/ports.mjs` 用 `listen(0)` 分配；分配后立即关闭监听再交给被测进程，避免端口在分配与启动之间被抢。配置从环境读取、不在代码里写第二份默认值表，符合 12-Factor 配置观 [R3]。

## 6 失败处理

失败路径分「环境前置失败」与「断言失败」两类：前者退出码非 0 并给出可操作的中文提示；后者逐条记录到报告，汇总退出码 1。

| 失败场景 | 判定 | 退出码 | 中文信息（用户看到） | 是否重试 |
|---|---|---|---|---|
| 服务端没起（http 目标连接拒绝/超时） | `connect()` 阶段 `fetch` 抛 `ECONNREFUSED`/`ETIMEDOUT` | 显式 `--target http` 且无可用用例 → 2；`--target both`/默认下 http 组整组 `skipped`，退出码 0 | `服务端不可达（<base-url>）：请先启动 apps/server，或用 --target stub 跑自洽用例。` | 否；不自动起服务端 |
| openapi.yaml 缺失 | `coverage.mjs` 读不到文件 | 0（报告标 `pending`） | `openapi: missing，已按冻结表降级核对；覆盖结论待 A 轮产物落地后重跑。` | 否 |
| SSE 超时 | 超过 `YXS_SSE_TIMEOUT_MS` 未收到 `done`（或 `error`） | 1（该用例失败） | `等待 SSE 终态事件超时（<ms>ms）：未收到 done；原始帧见 report/<...>/sse/<case-id>.txt。` | 否；不补帧 |
| token 过期/失效 | 任一鉴权接口返回 `401 AUTH_INVALID` | 1（该用例失败） | `登录已失效，请重新登录。`；报告附响应原文 | 不自动重登；前置用例失败后后续鉴权用例标 `blocked` |
| 未带 token | 用例构造遗漏或登录前置失败 | 1 | `请先登录。`（对齐 `AUTH_REQUIRED` 消息） | 否 |
| 参数非法（CLI） | `--target`/`--only`（`--case`）等校验不过 | 3 | `参数 <name> 非法：<取值说明>。` | 否 |
| electron 锁未取得 | 30s 退避后仍抢不到锁 | 0（electron 组标 `skipped`） | `未取得 electron 锁，本轮 electron 目标未执行；http/stub 用例照常跑完。` | 退避期内每 2s 一次 |
| 被测实例 5xx | 信封 `code=INTERNAL`/`UPSTREAM_FAILED`/`TIMEOUT` | 1（该用例失败） | 透传冻结 §4.2 的中文消息；报告记录 `code` 与 `requestId` | 否 |

所有失败信息只放中文一句话与分类码，内部堆栈只进 `run.log`，不进报告正文与响应断言 [R11]。

## 7 性能与资源

E 轮是契约测试，不承担压测指标；资源口径以「串行可重复、内存可控」为准。

| 项 | 口径 | 怎么量 |
|---|---|---|
| 并发度 | 默认 `YXS_WORKERS=1` 串行；SSE 用例与写方法用例不并行，避免隔离 home 互相干扰 | 报告汇总里记录并发度设置 |
| 全套耗时 | **待实测**：用例数量 = 30 方法 × ≥2 条 + 4 legacy × 1 条 + 5 类非法 + 5 通道专项；首跑后在 `report.json` 回填全套 wall-clock 与每条 `durationMs`。验证方法：`node run.mjs --target stub` 与 `--target http` 各跑一次，对比 stub 基线与 http 实测差值 | `report.json` 的 `durationMs` 字段 |
| 内存 | 用例逐条创建/释放 target 句柄；SSE 原始帧只保留当前用例，避免全量缓冲 | 失败排查时用进程任务管理器观察，不设硬性阈值 |
| 端口 | 每次运行分配独立空闲端口；结束后 `waitPortFree` 复查 | electron 句柄 `close()` 报告里的 `portFree` 字段 |
| 磁盘 | 报告按时间戳分目录；旧报告不自动清理，验收后由人保留最近一次 | `report/` 目录大小 |

不引入固定等待来凑耗时；等待状态变化一律走事件收集器或轮询断言，避免把慢环境误判成失败 [R3]。压测口径（QPS/P95）归 F 轮，E 不重复定义。

## 8 实施顺序

每一步都有可独立验证的产出，顺序按「先自洽、再接真目标、最后补覆盖与 mutation」排；小步可回退、每步带验证点的拆分方式遵循测试代码分层实践 [R3]：

1. **包骨架与 stub 跑通**：`package.json`、`run.mjs`、`src/target-interface.mjs`、`src/stub-target.mjs`、`src/report.mjs`。验证：`node run.mjs --target stub` 退出码 0，产出空报告骨架。
2. **断言库与信封模型**：`src/assert.mjs` 实现信封、字段类型、中文消息逐字比对。验证：stub 上跑通 1 条合法 + 1 条非法用例，失败时断言差异落盘。
3. **http 目标与登录前置**：`src/http-target.mjs` 接登录、Bearer、RPC 解包。验证：`--target http` 对已起的 mock 实例跑通 `student.current` 与 `health`；不可达时按 §6 标记 `skipped`（显式 http 目标退出码 2）。
4. **方法用例与非法构造**：`cases/methods.mjs`、`cases/illegal-class.mjs` 落 30 方法 ≥2 条 + 4 legacy + 5 类非法。验证：stub 全绿；http 目标下非法用例的错误码与中文消息逐条对上冻结 §4.2/§5。
5. **SSE 与专用通道**：`src/sse-client.mjs` + `cases/channels.mjs` 实现顺序断言、取消静默、answer/answer-set 回读、health 无鉴权。验证：stub 帧序列通过；http 目标 `curl -N` 原始帧与报告 `sse/*.txt` 一致。
6. **electron 目标接入**：`src/electron-target.mjs` 复用 driver、加锁与跳过逻辑。验证：拿到锁时 electron 组与 http 组断言同构；锁被占用时整组 `skipped` 且退出码 0。
7. **coverage 三判据**：`src/openapi.mjs` + `coverage.mjs`。验证：openapi 缺失时降级 `pending`；A 产物落地后三判据全绿，差集明细可列。
8. **mutation 与报告收尾**：`mutations/*.patch` 三条 + `src/patch.mjs` + `apply-revert.ps1`，红→还原→绿流程固化进报告；排查表与本文件 §6 对齐。验证：每条 patch 应用后指定用例变红，还原后变绿，`git status --porcelain apps/server docs/contracts` 为空。

## 参考

- [R1] Playwright — https://playwright.dev/docs/intro — 支撑 §1 fixture 与证据落盘结构 — 采用 fixture + 取证思路；不用其快照测试。
- [R2] Playwright Electron — https://playwright.dev/docs/api/class-electron — 支撑 §3.4 electron 目标复用 driver — 启动能力只在 driver 内部使用，spec 不直接 `import _electron`。
- [R3] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §2.3 禁止固定等待、§5 配置与 §7 并发口径 — 采用轮询/事件断言；不引入其全部工具链。
- [R4] Server-Sent Events（WHATWG 规范） — https://html.spec.whatwg.org/multipage/server-sent-events.html — 支撑 §3.3 帧格式与 id/event/data 解析 — 采用帧格式；不实现自动重放。
- [R5] MDN · Using server-sent events — https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events — 支撑 §3.3 心跳注释行与代理缓冲注意点 — 采用注释行跳过；不做 polyfill。
- [R6] JSON-RPC 2.0 规范 — https://www.jsonrpc.org/specification — 支撑 §3.2 单端点 method/params/error 形态 — 借鉴错误对象；不做 batch 与 notification。
- [R7] Redocly CLI 文档 — https://redocly.com/docs/cli — 支撑 §2.2 与 §3.7 OpenAPI 解析/覆盖核对顺序 — 借鉴先 lint 再比对；不引入云服务。
- [R8] spring-cloud-contract — https://github.com/spring-attic/spring-cloud-contract — 支撑 §1 用例与传输解耦的契约测试分层 — 借鉴 consumer-driven 思路；不引入其 JVM 框架。
- [R9] go-testfixtures/testfixtures — https://github.com/go-testfixtures/testfixtures — 支撑 §4 隔离副本夹具口径 — 借鉴「对真实结构副本断言」；不引入其 Go 运行时。
- [R10] r3labs/sse — https://github.com/r3labs/sse — 支撑 §3.3 SSE 帧状态机 — 借鉴客户端帧解析；不引入其 Go 依赖。
- [R11] OWASP REST Security Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html — 支撑 §3.2/§3.6/§6 鉴权与最小信息披露 — 采用失败原因不区分；不引入 API key 体系。
