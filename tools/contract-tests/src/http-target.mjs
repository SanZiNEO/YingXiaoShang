/**
 * http 目标 —— 用 Node 22 内置 fetch 打真实 HTTP 服务端（03-implementation §3.2）。
 *
 * 与 src/stub-target.mjs 同构：用例只依赖 target-interface.mjs 声明的那组方法，
 * 传输差异（Bearer token、登录前置、SSE 读取、错误信封解包）全部收在本文件内。
 *
 * 口径冻结在 02-contract / 01-frozen-contracts：
 * - 先探 `GET <baseUrl>/health`（不带 Authorization），连不上或非 2xx → TargetUnreachable；
 * - 登录 `POST /api/v1/auth/login` 取 `result.token`；登录失败不抛 TargetUnreachable，
 *   把失败信封记住，后续带鉴权的调用直接回这份信封（记用例 failed，不悄悄 skipped）；
 * - RPC / answer / answer-set 无论 200 还是 4xx/5xx 都解包成同一份信封，只有连接级失败才抛 TargetUnreachable；
 * - 超时：RPC 默认 10s，`news.refresh` 30s，`artifacts.export` 20s；超时映射 TIMEOUT 信封；
 * - 本文件不出现 Electron / Playwright 相关 import（§3.4 的硬约束归 electron-target）。
 */

import { TargetUnreachable, ContractViolation } from './target-interface.mjs'
import { readSseStream, DEFAULT_SSE_TIMEOUT_MS } from './sse-client.mjs'
import { newRequestId, STUDENT_B } from './fixtures.mjs'
import { ERROR_CODES } from './frozen.mjs'

/** RPC 默认超时 10s；两个慢方法按冻结 §2 放宽。 */
const DEFAULT_RPC_TIMEOUT_MS = 10_000
const RPC_TIMEOUTS = {
  'news.refresh': 30_000,
  'artifacts.export': 20_000,
}

/** 连接级错误码：这些才判「服务端不可达」，业务 4xx/5xx 一律走信封。 */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
])

/** 不可达提示逐字对齐 03-implementation §6（run.mjs 退出码 2 的同一句话）。 */
function unreachableMessage(baseUrl) {
  return `服务端不可达（${baseUrl}）：请先启动 apps/server，或用 --target stub 跑自洽用例。`
}

export class HttpTarget {
  constructor({ baseUrl, studentId, password, home } = {}) {
    this.kind = 'http'
    this.baseUrl = String(baseUrl ?? '').replace(/\/+$/, '')
    this.studentId = studentId
    this.password = password
    this.home = home ?? null

    this.tokenA = null
    this.tokenB = null
    this.tokenExpiresAt = null
    /** A 登录失败信封：后续带鉴权调用直接回它（02-contract §2.4 记 failed，不 skipped）。 */
    this.authError = null
    this.authErrorB = null
    this.authenticated = false
    this.connected = false

    this.discovery = {}
    this.sseHeaders = { cacheControl: null, xAccelBuffering: null }
  }

  describe() {
    return {
      kind: 'http',
      baseUrl: this.baseUrl,
      authenticated: this.authenticated,
      ...(this.tokenExpiresAt ? { tokenExpiresAt: this.tokenExpiresAt } : {}),
      sseHeaders: { ...this.sseHeaders },
    }
  }

  /** 连接级失败判定：fetch 拒绝为 TypeError（undici 把 ECONNREFUSED 等包在 cause 里）或错误码命中连接集。 */
  isConnectionError(error) {
    if (error instanceof TypeError) return true
    const code = error?.cause?.code ?? error?.code
    return CONNECTION_ERROR_CODES.has(code)
  }

  /** AbortSignal.timeout 触发的超时：Node 22 直接抛 name=TimeoutError（部分形态 cause.name 同为 TimeoutError）。 */
  isTimeout(error) {
    return error?.name === 'TimeoutError'
      || (error?.name === 'AbortError' && error?.cause?.name === 'TimeoutError')
  }

  toUnreachable(error) {
    return new TargetUnreachable(unreachableMessage(this.baseUrl), { cause: error })
  }

  /** 登录前置：健康探测 → A 登录 → 只读探测收种子 ID。 */
  async connect() {
    await this.probeHealth()
    await this.loginStudentA()
    if (!this.authError) {
      await this.probeDiscovery()
    }
    this.connected = true
  }

  /** `GET <baseUrl>/health`，不带 Authorization；连不上 / 超时 / 非 2xx 都判不可达。 */
  async probeHealth() {
    let response
    try {
      response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(DEFAULT_RPC_TIMEOUT_MS),
      })
    } catch (error) {
      throw this.toUnreachable(error)
    }
    if (!response.ok) {
      throw new TargetUnreachable(unreachableMessage(this.baseUrl))
    }
  }

  async loginStudentA() {
    const login = await this.performLogin(this.studentId, this.password)
    if (!login.ok) {
      this.authError = login.envelope
      return
    }
    this.tokenA = login.token
    this.tokenExpiresAt = login.expiresAt ?? null
    this.authenticated = true
  }

  /**
   * 学号口令登录。HTTP 4xx/5xx 或响应体 ok:false → 失败信封（不抛 TargetUnreachable）；
   * 连接级失败才抛 TargetUnreachable。
   */
  async performLogin(studentId, password) {
    const startedAt = Date.now()
    let response
    try {
      response = await fetch(`${this.baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ studentId, password }),
        signal: AbortSignal.timeout(DEFAULT_RPC_TIMEOUT_MS),
      })
    } catch (error) {
      throw this.toUnreachable(error)
    }
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = null }

    if (!response.ok || !body?.ok) {
      const error = body?.error ?? {
        code: 'AUTH_FAILED',
        message: ERROR_CODES.AUTH_FAILED.message,
        field: null,
        detail: {},
      }
      return {
        ok: false,
        envelope: {
          ok: false,
          result: undefined,
          error,
          requestId: body?.requestId ?? null,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          httpStatus: response.status,
        },
      }
    }
    return {
      ok: true,
      token: body.result?.token,
      expiresAt: body.result?.expiresAt ?? null,
    }
  }

  /** 第二个学生懒登录（E-068 越权构造用）；失败记 authErrorB，不影响 A 的会话。 */
  async ensureStudentB() {
    if (this.tokenB || this.authErrorB) return
    const login = await this.performLogin(STUDENT_B.studentId, STUDENT_B.password)
    if (!login.ok) this.authErrorB = login.envelope
    else this.tokenB = login.token
  }

  /**
   * 越权用例的前置：B 必须真的存在，否则「403 越权」这条契约根本构造不出来。
   * 返回 {ok:false, reason} 让用例显式 skip，而不是拿一个 401 去撞 403 断言、报成红。
   */
  async requireStudentB() {
    await this.ensureStudentB()
    if (this.tokenB) return { ok: true, reason: null }
    const code = this.authErrorB?.error?.code ?? 'AUTH_FAILED'
    const message = this.authErrorB?.error?.message ?? 'B 登录失败'
    return {
      ok: false,
      reason:
        `学生 B（${STUDENT_B.studentId}）登录失败（${code}：${message}）：被测实例里没有这个账号，` +
        'E-068 的越权构造不成立。按 apps/server/README.md 用 scripts/add-student.mjs 建 B 后重跑。',
    }
  }

  /**
   * 身份解析（对齐 target-interface 的 opts 语义）：
   * - auth=false      不带 Authorization（AUTH_REQUIRED 探针）；
   * - auth='invalid'   带一个格式合法但不存在的 token（AUTH_INVALID 探针）；
   * - asStudent='B'   用 B 的 token（懒登录）；
   * - 默认             用 A 的 token；A 登录失败则直接回记住的失败信封。
   */
  async resolveAuth(opts = {}) {
    if (opts.auth === false) return { header: null, envelope: null }
    if (opts.auth === 'invalid') {
      return { header: `Bearer ${'x'.repeat(43)}`, envelope: null }
    }
    if (opts.asStudent === 'B') {
      await this.ensureStudentB()
      if (this.authErrorB) return { header: null, envelope: this.authErrorB }
      return { header: this.tokenB ? `Bearer ${this.tokenB}` : null, envelope: null }
    }
    if (this.authError) return { header: null, envelope: this.authError }
    return { header: this.tokenA ? `Bearer ${this.tokenA}` : null, envelope: null }
  }

  timeoutEnvelope(requestId, elapsedMs) {
    return {
      ok: false,
      result: undefined,
      error: { code: 'TIMEOUT', message: ERROR_CODES.TIMEOUT.message, field: null, detail: {} },
      requestId,
      elapsedMs,
      httpStatus: 504,
    }
  }

  /** 把响应体解包成同一份信封：200 与 4xx/5xx 都返回信封，不抛业务错误。 */
  unwrapEnvelope(httpStatus, text, requestId, startedAt) {
    const elapsedMs = Math.max(0, Date.now() - startedAt)
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      // 非 JSON：BAD_REQUEST 形状，原始文本截断 400 字符进 error.detail.raw。
      return {
        ok: false,
        result: undefined,
        error: {
          code: 'BAD_REQUEST',
          message: '响应不是合法 JSON。',
          field: null,
          detail: { raw: String(text ?? '').slice(0, 400) },
        },
        requestId,
        elapsedMs,
        httpStatus,
      }
    }
    const ok = body.ok === true
    return {
      ok,
      result: body.result,
      error: body.error,
      requestId: body.requestId ?? requestId,
      elapsedMs: typeof body.elapsedMs === 'number' ? body.elapsedMs : elapsedMs,
      httpStatus,
    }
  }

  /** 通用 JSON 请求：鉴权 → fetch → 解包信封；超时回 TIMEOUT 信封，连接级失败抛 TargetUnreachable。 */
  async requestEnvelope(path, { body, opts, timeoutMs, requestId, method = 'POST' }) {
    const startedAt = Date.now()
    const { header, envelope: authEnvelope } = await this.resolveAuth(opts)
    if (authEnvelope) {
      return { ...authEnvelope, requestId: authEnvelope.requestId ?? requestId }
    }
    const headers = { 'Content-Type': 'application/json; charset=utf-8' }
    if (header) headers.Authorization = header

    let response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (this.isTimeout(error)) return this.timeoutEnvelope(requestId, Math.max(0, Date.now() - startedAt))
      throw this.toUnreachable(error)
    }
    const text = await response.text()
    return this.unwrapEnvelope(response.status, text, requestId, startedAt)
  }

  /** RPC：POST /api/v1/rpc，body `{ method, params, requestId }`。 */
  async rpc(method, params = {}, opts = {}) {
    const requestId = opts.requestId ?? newRequestId()
    const timeoutMs = RPC_TIMEOUTS[method] ?? DEFAULT_RPC_TIMEOUT_MS
    return this.requestEnvelope('/api/v1/rpc', {
      body: { method, params, requestId },
      opts,
      timeoutMs,
      requestId,
    })
  }

  /**
   * SSE：POST /api/v1/chat/stream。校验 Content-Type 含 text/event-stream；
   * Cache-Control / X-Accel-Buffering 只记录进 describe，缺头不判失败。
   */
  async stream(input = {}, hooks = {}) {
    const requestId = input.requestId ?? newRequestId()
    const { header, envelope: authEnvelope } = await this.resolveAuth({})
    if (authEnvelope) return authEnvelope

    const body = {}
    for (const key of ['sessionId', 'message', 'chapterId', 'scopeOverride', 'requestId']) {
      if (input[key] !== undefined) body[key] = input[key]
    }

    const sseTimeoutMs = Number(process.env.YXS_SSE_TIMEOUT_MS) || DEFAULT_SSE_TIMEOUT_MS
    let response
    try {
      response = await fetch(`${this.baseUrl}/api/v1/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(header ? { Authorization: header } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(sseTimeoutMs),
      })
    } catch (error) {
      if (this.isTimeout(error)) {
        throw new ContractViolation('SSE 连接超时：未在约定时间内建立响应。')
      }
      throw this.toUnreachable(error)
    }

    const contentType = response.headers.get('content-type') ?? ''
    this.sseHeaders.cacheControl = response.headers.get('cache-control')
    this.sseHeaders.xAccelBuffering = response.headers.get('x-accel-buffering')

    if (!contentType.includes('text/event-stream')) {
      throw new ContractViolation(`SSE 响应 Content-Type 不是 text/event-stream：${contentType || '(空)'}`)
    }

    return readSseStream(response.body, { onFrame: hooks?.onFrame, timeoutMs: sseTimeoutMs })
  }

  /** 取消：POST /api/v1/chat/cancel，body `{ requestId }`；返回 `{ httpStatus, body }`。 */
  async cancel(requestId, opts = {}) {
    const { header, envelope: authEnvelope } = await this.resolveAuth(opts)
    if (authEnvelope) {
      return { httpStatus: authEnvelope.httpStatus, body: { ok: false, error: authEnvelope.error, requestId } }
    }
    let response
    try {
      response = await fetch(`${this.baseUrl}/api/v1/chat/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(header ? { Authorization: header } : {}),
        },
        body: JSON.stringify({ requestId }),
        signal: AbortSignal.timeout(DEFAULT_RPC_TIMEOUT_MS),
      })
    } catch (error) {
      if (this.isTimeout(error)) {
        return {
          httpStatus: 504,
          body: { ok: false, error: { code: 'TIMEOUT', message: ERROR_CODES.TIMEOUT.message, field: null, detail: {} }, requestId },
        }
      }
      throw this.toUnreachable(error)
    }
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = text }
    return { httpStatus: response.status, body }
  }

  /** 单题作答：POST /api/v1/answer，解包信封（同 rpc 口径）。 */
  async answer(input, opts = {}) {
    const requestId = opts.requestId ?? newRequestId()
    return this.requestEnvelope('/api/v1/answer', {
      body: input,
      opts,
      timeoutMs: DEFAULT_RPC_TIMEOUT_MS,
      requestId,
    })
  }

  /** 交卷：POST /api/v1/answer-set，解包信封（同 rpc 口径，含 400 逐字消息）。 */
  async answerSet(input, opts = {}) {
    const requestId = opts.requestId ?? newRequestId()
    return this.requestEnvelope('/api/v1/answer-set', {
      body: input,
      opts,
      timeoutMs: DEFAULT_RPC_TIMEOUT_MS,
      requestId,
    })
  }

  /** 健康通道：GET /api/v1/health，契约上不带 Authorization（opts.auth===false 只是显式再确认一次）。 */
  async health(opts = {}) {
    let response
    try {
      response = await fetch(`${this.baseUrl}/api/v1/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(DEFAULT_RPC_TIMEOUT_MS),
      })
    } catch (error) {
      throw this.toUnreachable(error)
    }
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = text }
    return { httpStatus: response.status, body }
  }

  /**
   * 只读探测收种子 ID：全部失败也不抛错，取不到的键不放进 discovery，
   * 用例按 02-contract §3.1 自动 skipped，不许编造 ID。
   *
   * 字段名口径按 `docs/contracts/openapi.yaml`：`questions.attempts` 的作答行是
   * `QuestionAttempt`（`question_id`），`agent.ledger` 的条目是 `SummaryLedger`
   * （`source_id`）——两者都是 snake_case，早先按 camelCase 取值导致 E-073/E-074/E-029
   * 永久 skipped。
   *
   * `blockId` / `resourceId` 没有专用列表方法，只能从服务端自己给出的引用里找：
   * - `resourceId`：`getResource` 按 `resource/guide/<chapterId>` 取指南，所以章节 id 就是候选；
   * - `blockId`：会话消息 payload 的 `citations[].sourceId`（textbook 引用）与产物
   *   `source_refs` 里出现的 id 才可能是 `content_blocks.id`，逐个用 `getBlock` 验证，
   *   只有 200 才收——不猜、不拼。
   */
  async probeDiscovery() {
    const call = async (method, params = {}) => {
      try {
        const envelope = await this.rpc(method, params)
        return envelope.ok ? envelope.result : undefined
      } catch {
        return undefined
      }
    }

    /** 逐个候选试调用，第一个 200 的留下（候选来自服务端自己的输出，不是编的）。 */
    const probeOne = async (method, paramKey, candidates) => {
      for (const candidate of candidates) {
        if (typeof candidate !== 'string' || candidate.length === 0) continue
        const result = await call(method, { [paramKey]: candidate })
        if (result !== undefined) return candidate
      }
      return undefined
    }

    const setIf = (key, value) => {
      if (typeof value === 'string' && value.length > 0) this.discovery[key] = value
    }

    const chapters = await call('chapters.list')
    if (Array.isArray(chapters)) {
      setIf('chapterId', chapters[0]?.id)
      this.discovery.chapterIds = chapters.map((row) => row?.id).filter((id) => typeof id === 'string')
    }

    const news = await call('news.list', { limit: 1 })
    if (Array.isArray(news)) setIf('articleId', news[0]?.id)

    const sessions = await call('chat.sessions')
    if (Array.isArray(sessions)) {
      setIf('sessionId', sessions[0]?.id)
      this.discovery.sessionIds = sessions.map((row) => row?.id).filter((id) => typeof id === 'string')
    }

    const artifacts = await call('artifacts.list')
    if (Array.isArray(artifacts)) {
      setIf('artifactId', artifacts[0]?.id)
      const questionSet = artifacts.find((row) => row?.type === 'question_set')
      setIf('questionArtifactId', questionSet?.id)
      this.discovery.artifactSourceRefs = artifacts
        .flatMap((row) => (Array.isArray(row?.source_refs) ? row.source_refs : []))
        .filter((ref) => typeof ref === 'string')
    }

    const facts = await call('memory.facts')
    if (Array.isArray(facts)) setIf('factId', facts[0]?.id)

    const evidence = await call('profile.evidence')
    if (Array.isArray(evidence)) setIf('evidenceId', evidence[0]?.id)

    const kps = await call('kps.list')
    if (Array.isArray(kps)) setIf('kpId', kps[0]?.id)

    // 台账条目是 SummaryLedger（source_id）；字段名按 openapi.yaml，不用 camelCase 猜。
    const ledger = await call('agent.ledger')
    if (Array.isArray(ledger?.items)) setIf('sourceId', ledger.items[0]?.source_id)

    // 作答行是 QuestionAttempt（question_id）。库里有作答时这是最权威的题目来源。
    const attempts = await call('questions.attempts')
    if (Array.isArray(attempts)) {
      const ids = attempts.map((row) => row?.question_id).filter((id) => typeof id === 'string' && id.length > 0)
      if (ids.length > 0) {
        setIf('questionId', ids[0])
        this.discovery.questionIds = [...new Set(ids)]
      }
    }

    // 没有作答记录时，题目 id 只能从题目集产物的 content_json.questions 里取
    // （服务端登记题目时会把最终 id 写回这份内容，见 packages/agent/src/question-registry.ts）。
    if (!this.discovery.questionIds && this.discovery.questionArtifactId) {
      const artifact = await call('artifacts.get', { artifactId: this.discovery.questionArtifactId })
      const questions = artifact?.content_json?.questions
      if (Array.isArray(questions)) {
        const ids = questions.map((row) => row?.id).filter((id) => typeof id === 'string' && id.length > 0)
        if (ids.length > 0) {
          this.discovery.questionIds = [...new Set(ids)]
          setIf('questionId', this.discovery.questionIds[0])
        }
      }
    }

    // 资源指南按 `resource/guide/<chapterId>` 存，所以章节 id 就是合法 resourceId 候选。
    if (!this.discovery.resourceId && Array.isArray(this.discovery.chapterIds)) {
      setIf('resourceId', await probeOne('getResource', 'resourceId', this.discovery.chapterIds))
    }

    // blockId：只从服务端返回过的引用里挑，并逐个 getBlock 验证。
    if (!this.discovery.blockId) {
      const candidates = new Set(this.discovery.artifactSourceRefs ?? [])
      for (const sessionId of (this.discovery.sessionIds ?? []).slice(0, 5)) {
        const messages = await call('chat.messages', { sessionId })
        if (!Array.isArray(messages)) continue
        for (const message of messages) {
          const citations = message?.payload_json?.citations
          if (!Array.isArray(citations)) continue
          for (const citation of citations) {
            if (citation?.sourceType === 'textbook' || citation?.sourceType === 'text') {
              if (typeof citation.sourceId === 'string') candidates.add(citation.sourceId)
            }
          }
        }
      }
      setIf('blockId', await probeOne('getBlock', 'blockId', [...candidates]))
    }
  }

  /** 无长连接可关：置位即可。 */
  async close() {
    this.connected = false
  }
}

/** 便捷工厂：`createHttpTarget({ baseUrl, studentId, password, home })`，与其它 target 签名一致。 */
export function createHttpTarget(options = {}) {
  return new HttpTarget(options)
}
