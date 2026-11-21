/**
 * Target 抽象 —— 用例只依赖这一份接口，传输差异全部收进 src/*-target.mjs。
 *
 * 接口与 plans/server-client-split/E-contract-tests/03-implementation.md §3.1 对齐，并补上用例真正需要的三处细节：
 *   1. `rpc(method, params, opts)` 的 `opts` 承担「换一个学生 / 不带凭证」这两类构造（E-068 越权、AUTH 探针）；
 *   2. `stream(input, hooks)` 的 `hooks.onFrame` 让用例能在第一帧到达后再发取消（E-071 必须真的中途取消，不能靠固定等待）；
 *   3. `answerSet` / `health` 返回 `{ httpStatus, body }` 而不是解包后的 result，
 *      因为 E-075 要断言 400 与逐字消息，E-076 要断言「不带 Authorization 也 200」。
 *
 * 三个实现：src/stub-target.mjs（内存桩，断网可跑）、src/http-target.mjs（打 apps/server）、src/electron-target.mjs（复用现有 driver）。
 */

export const TARGET_KINDS = ['stub', 'http', 'electron']

/**
 * @typedef {Object} RpcEnvelope
 * @property {boolean} ok
 * @property {unknown} [result]
 * @property {{ code: string, message: string, field?: string|null, detail?: unknown }} [error]
 * @property {string} requestId        服务端必回；桩也必须回，便于断言 E-02 §2.3「requestId 回显」
 * @property {number} [elapsedMs]      ≥0 的数字，不校验具体值
 * @property {number} httpStatus       HTTP 状态（electron 目标用 200/映射值占位，只在报告里展示）
 */

/**
 * @typedef {Object} StreamEvent
 * @property {number|null} id          SSE 的 `id:` 递增整数；center 目标为 null
 * @property {string} event            session / round / text / tool / tool-end / done / error
 * @property {unknown} data            解析后的 JSON（注释行心跳不入列）
 * @property {string} raw              原始帧文本（证据落盘用）
 */

/**
 * @typedef {Object} CollectedStream
 * @property {StreamEvent[]} events
 * @property {string[]} rawFrames      原样保留的帧文本，供 report/sse/<case-id>.txt
 * @property {number} doneCount
 * @property {number} errorCount
 * @property {number} firstTokenMs
 * @property {boolean} closed          流是否已结束（正常关闭或异常中断都算 closed=true）
 */

/**
 * 契约目标接口（http / electron / stub 三实现必须一致）：
 *
 *   readonly kind: 'stub' | 'http' | 'electron'
 *   async connect(): Promise<void>                 // 登录前置 / 启动实例 / 装载 fixture
 *   async rpc(method, params, opts?): Promise<RpcEnvelope>
 *   async stream(input, hooks?): Promise<CollectedStream>
 *   async cancel(requestId, opts?): Promise<{ httpStatus: number, body: unknown }>
 *   async answer(input, opts?): Promise<RpcEnvelope>
 *   async answerSet(input, opts?): Promise<RpcEnvelope>
 *   async health(opts?): Promise<{ httpStatus: number, body: unknown }>
 *   async close(): Promise<void>
 *   readonly discovery: Record<string, string>     // connect() 后填好，供 $symbol 占位解析
 *   describe(): Record<string, unknown>            // 进 report.environment，不含 token / 口令
 *
 * opts（都可不传）：
 *   { asStudent?: 'A' | 'B', auth?: boolean | 'invalid' }
 *      asStudent='B'  用第二个学生身份（E-068 越权）
 *      auth=false     故意不带 Authorization（AUTH_REQUIRED 探针 / E-076 无鉴权 health）
 *      auth='invalid' 带一个格式合法但不存在的 token（AUTH_INVALID 探针）
 *
 * hooks：
 *   { onFrame?: (event: StreamEvent) => void }     每解析出一帧就回调一次
 */

/** 连不上被测实例（服务端没起 / Electron 拉不起来）。run.mjs 据此决定 skipped 还是退出码 2。 */
export class TargetUnreachable extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'TargetUnreachable'
  }
}

/**
 * 用例主动跳过：前置不具备（取不到种子 ID、该目标不支持这条构造、拿不到 electron 锁……）。
 * `pending:true` 只用于 OpenAPI 缺失时的覆盖核对（02-contract §6 的 status 定义）。
 */
export class SkipSignal extends Error {
  constructor(reason, { pending = false } = {}) {
    super(reason)
    this.name = 'SkipSignal'
    this.reason = reason
    this.pending = pending
  }
}

/**
 * 被测实例返回了契约里没有的形状（不是断言失败，是环境/实现异常）。
 * run.mjs 把这类异常记进 case.error，堆栈只进 run.log。
 */
export class ContractViolation extends Error {
  constructor(message) {
    super(message)
    this.name = 'ContractViolation'
  }
}
