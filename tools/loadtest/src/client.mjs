/**
 * tools/loadtest/src/client.mjs — F 轮压测传输层。
 * 职责：唯一发 HTTP/SSE 请求的地方；负责 Bearer 鉴权、信封解包、SSE 帧读取、
 * 起止计时与样本错误分类；不做业务断言、不算汇总、不解析 /metrics 文本。
 * 只用 Node 22 内置能力与全局 fetch，零第三方依赖。
 */
import crypto from 'node:crypto'

/**
 * 生成压测请求 ID：`req_` + 12 位 base36。
 * @returns {string}
 */
export function newRequestId() {
  const n = crypto.randomBytes(6).readUIntBE(0, 6)
  return 'req_' + n.toString(36).padStart(12, '0').slice(-12)
}

/** 安全解析 JSON；失败返回 null，不抛异常。 */
function safeJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 构造一条空白样本，字段形状对齐 impl-spec §2.1。 */
function baseSample({ studentId = '', iteration = 1, scenario, method = null, requestId, counted = true }) {
  return {
    studentId,
    iteration,
    scenario,
    method,
    at: Date.now(),
    durationMs: 0,
    firstTokenMs: null,
    status: null,
    code: null,
    ok: false,
    errorClass: null,
    requestId,
    counted,
    message: null,
    meta: null,
    rawFrames: null
  }
}

/**
 * 错误分类（impl-spec §2.1，每请求恰好落一类，顺序即优先级）。
 * 入参给出传输/HTTP/信封/SSE 各层事实，返回 { errorClass, ok }。
 */
function classify({ callerAborted, timedOut, fetchError, status, envelopeOk, sseCode, endedWithoutDone }) {
  // 1. 调用方主动取消
  if (callerAborted) return { errorClass: 'cancelled', ok: false }
  // 8/9. 传输层异常：区分自有超时中止、调用方中止与其它网络错误
  if (fetchError) {
    if (fetchError.name === 'AbortError') {
      if (timedOut) return { errorClass: 'timeout', ok: false }
      return { errorClass: 'cancelled', ok: false }
    }
    return { errorClass: 'networkAbort', ok: false }
  }
  // 2. HTTP 499 → cancelled（CANCELLED）
  if (status === 499) return { errorClass: 'cancelled', ok: false }
  // 3. 5xx
  if (status !== null && status >= 500) return { errorClass: 'http5xx', ok: false }
  // 4. 4xx 一律单列，不进 businessError
  if (status !== null && status >= 400) return { errorClass: 'http4xx', ok: false }
  // 5. HTTP 200 且信封 ok:false
  if (envelopeOk === false) return { errorClass: 'businessError', ok: false }
  // 6a. SSE error(code=CANCELLED) → cancelled（优先于普通 sseError）
  if (sseCode === 'CANCELLED') return { errorClass: 'cancelled', ok: false }
  // 6b. 其余 SSE error 帧 → sseError
  if (sseCode !== null && sseCode !== undefined) return { errorClass: 'sseError', ok: false }
  // 7. SSE 未收到 done 即结束
  if (endedWithoutDone) return { errorClass: 'sseError', ok: false }
  // 8. 空闲/整体超时（计时器中止但未走到 fetchError 分支的兜底）
  if (timedOut) return { errorClass: 'timeout', ok: false }
  // 10. 成功
  return { errorClass: null, ok: true }
}

/**
 * 压测客户端：登录、RPC、chat/stream、answer、answer-set、cancel、指标抓取。
 */
export class YxsClient {
  /**
   * @param {{baseUrl:string, timeoutMs?:number, metricsToken?:string, fetchImpl?:typeof fetch,
   *   distinctClientIps?:boolean, ipv4Prefix?:string}} options
   *   `distinctClientIps`：给每个虚拟学生伪造独立的 `X-Forwarded-For`。
   *   服务端登录限流按客户端 IP 计数（冻结契约 §3.1：同一 IP 每分钟 5 次），所有 VU 从
   *   127.0.0.1 出时第 6 个起必然 429；这是契约行为而非服务端缺陷，压测侧必须自己错开 IP。
   *   服务端 `clientIp()` 读该头，因此这是唯一不需要改服务端的做法。
   */
  constructor({ baseUrl, timeoutMs = 60000, metricsToken = '', fetchImpl = globalThis.fetch, distinctClientIps = false, ipv4Prefix = '198.18.' }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 60000
    this.metricsToken = String(metricsToken ?? '')
    this.fetchImpl = fetchImpl
    this.distinctClientIps = distinctClientIps === true
    this.ipv4Prefix = String(ipv4Prefix || '198.18.')
    this.#activeSse = 0
    this.#activePeak = 0
  }

  #activeSse = 0
  #activePeak = 0

  /** 运行期在途 SSE 连接数峰值。 */
  get activePeak() {
    return this.#activePeak
  }

  #url(path) {
    return `${this.baseUrl}${path}`
  }

  /**
   * 由学号派生稳定的伪客户端 IP（RFC 2544 基准测试网段，不会被当成真实主机）。
   * 同一学号每轮拿到同一 IP，跨轮次也不会与别人撞号（最多 254×254 个）。
   * @param {string} studentId
   * @returns {string}
   */
  #ipFor(studentId) {
    const key = String(studentId ?? '')
    let hash = 0
    for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) % 64516
    return `${this.ipv4Prefix}${Math.floor(hash / 254) + 1}.${(hash % 254) + 1}`
  }

  #authHeaders(token, studentId) {
    const headers = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    if (this.distinctClientIps && studentId) headers['x-forwarded-for'] = this.#ipFor(studentId)
    return headers
  }

  /**
   * 通用 JSON 请求（非流式）：计时、超时中止、信封解包与分类。
   * 返回 { sample, data }；data 为信封 result（失败为 null）。
   */
  async #jsonRequest({ scenario, method, path, token, body, ctx = {}, counted = true, requestId = newRequestId(), signal, methodLabel }) {
    const at = Date.now()
    const sample = baseSample({
      studentId: ctx.studentId ?? '',
      iteration: ctx.iteration ?? 1,
      scenario,
      method: methodLabel ?? method,
      requestId,
      counted
    })

    const ac = new AbortController()
    let callerAborted = false
    let timedOut = false
    if (signal) {
      if (signal.aborted) callerAborted = true
      else signal.addEventListener('abort', () => { callerAborted = true; ac.abort() }, { once: true })
    }
    const timer = setTimeout(() => { timedOut = true; ac.abort() }, this.timeoutMs)

    let res = null
    let envelope = null
    let fetchError = null
    try {
      res = await this.fetchImpl(this.#url(path), {
        method,
        headers: this.#authHeaders(token, ctx.studentId),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal
      })
      sample.status = res.status
      const text = await res.text()
      envelope = safeJson(text)
    } catch (err) {
      fetchError = err
    } finally {
      clearTimeout(timer)
    }

    sample.durationMs = Date.now() - at
    const errBody = envelope && envelope.error ? envelope.error : null
    const { errorClass, ok } = classify({
      callerAborted,
      timedOut,
      fetchError,
      status: sample.status,
      envelopeOk: envelope ? envelope.ok : null,
      sseCode: null,
      endedWithoutDone: false
    })
    sample.errorClass = errorClass
    sample.ok = ok
    sample.code = errBody ? errBody.code : null
    sample.message = errBody ? errBody.message : null
    return { sample, data: ok && envelope ? envelope.result : null }
  }

  /**
   * 全局健康预检（不计入请求分母）。
   * @returns {{sample: object, data: object|null}}
   */
  async health() {
    const requestId = newRequestId()
    const at = Date.now()
    const sample = baseSample({ scenario: 'health', method: '/api/v1/health', requestId, counted: false })

    const ac = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ac.abort() }, this.timeoutMs)

    let res = null
    let envelope = null
    let fetchError = null
    try {
      res = await this.fetchImpl(this.#url('/api/v1/health'), {
        headers: { 'content-type': 'application/json' },
        signal: ac.signal
      })
      sample.status = res.status
      envelope = safeJson(await res.text())
    } catch (err) {
      fetchError = err
    } finally {
      clearTimeout(timer)
    }

    sample.durationMs = Date.now() - at
    const errBody = envelope && envelope.error ? envelope.error : null
    const { errorClass, ok } = classify({
      callerAborted: false,
      timedOut,
      fetchError,
      status: sample.status,
      envelopeOk: envelope ? envelope.ok : null,
      sseCode: null,
      endedWithoutDone: false
    })
    sample.errorClass = errorClass
    // 预检样本：信封缺 ok 字段时按未失败处理，避免把无信封的纯 200 误判成 businessError。
    sample.ok = fetchError === null && sample.status !== null && sample.status < 400 && (envelope ? envelope.ok !== false : true)
    sample.code = errBody ? errBody.code : null
    sample.message = errBody ? errBody.message : null
    return { sample, data: envelope }
  }

  /**
   * 学号口令登录；登录请求体携带 studentId 与口令（冻结 §3.1），不带 Authorization。
   * @returns {{sample: object, data: {token:string, studentId:string|null, name:string|null, cohort:string|null}|null}}
   */
  async login(studentId, password) {
    const { sample, data } = await this.#jsonRequest({
      scenario: 'login',
      method: 'POST',
      path: '/api/v1/auth/login',
      token: '',
      body: { studentId, password },
      ctx: { studentId, iteration: 1 },
      counted: true,
      methodLabel: '/api/v1/auth/login'
    })
    let mapped = null
    if (data && typeof data === 'object') {
      mapped = {
        token: data.token ?? null,
        studentId: data.student?.studentId ?? data.studentId ?? null,
        name: data.student?.name ?? data.name ?? null,
        cohort: data.student?.cohort ?? data.cohort ?? null
      }
    }
    return { sample, data: mapped }
  }

  /**
   * RPC 单端点调用；请求体只放 method/params/requestId，不带 studentId（冻结 §3.2）。
   * @param {string} method
   * @param {object} params
   * @param {{studentId:string, token:string, iteration:number}} ctx
   * @returns {{sample: object, data: any}}
   */
  async rpc(method, params, ctx) {
    const { sample, data } = await this.#jsonRequest({
      scenario: 'readback',
      method: 'POST',
      path: '/api/v1/rpc',
      token: ctx?.token ?? '',
      body: { method, params: params ?? {}, requestId: newRequestId() },
      ctx: ctx ?? {},
      counted: true,
      methodLabel: method
    })
    return { sample, data }
  }

  /**
   * 取消在途轮次。
   * @returns {{sample: object, data: any}}
   */
  async cancel(requestId, ctx) {
    const { sample, data } = await this.#jsonRequest({
      scenario: 'cancel',
      method: 'POST',
      path: '/api/v1/chat/cancel',
      token: ctx?.token ?? '',
      body: { requestId },
      ctx: ctx ?? {},
      counted: true,
      methodLabel: '/api/v1/chat/cancel'
    })
    return { sample, data }
  }

  /**
   * 单题作答。
   * @returns {{sample: object, data: any}}
   */
  async answer(payload, ctx) {
    const { sample, data } = await this.#jsonRequest({
      scenario: 'answer',
      method: 'POST',
      path: '/api/v1/answer',
      token: ctx?.token ?? '',
      body: payload,
      ctx: ctx ?? {},
      counted: true,
      methodLabel: '/api/v1/answer'
    })
    return { sample, data }
  }

  /**
   * 交卷（answer-set）。
   * @returns {{sample: object, data: any}}
   */
  async answerSet(payload, ctx) {
    const { sample, data } = await this.#jsonRequest({
      scenario: 'answer-set',
      method: 'POST',
      path: '/api/v1/answer-set',
      token: ctx?.token ?? '',
      body: payload,
      ctx: ctx ?? {},
      counted: true,
      methodLabel: '/api/v1/answer-set'
    })
    return { sample, data }
  }

  /**
   * 对话 SSE 流：按 WHATWG 帧格式读取；首 token 只认首个非空正文的 text 帧。
   * @param {{studentId:string, token:string, message:string, sessionId?:string|null, iteration:number, requestId?:string, signal?:AbortSignal}} options
   * @returns {{sample: object, event: {done:boolean, sessionId:string|null, artifacts:any, citations:any, text:string, turnId:string|null, errorCode:string|null, frames:string[]}}}
   */
  async chatStream({ studentId, token, message, sessionId = null, iteration = 1, requestId = newRequestId(), signal } = {}) {
    const at = Date.now()
    const sample = baseSample({
      studentId,
      iteration,
      scenario: 'ask',
      method: '/api/v1/chat/stream',
      requestId,
      counted: true
    })

    const event = {
      done: false,
      sessionId: sessionId ?? null,
      artifacts: null,
      citations: null,
      text: '',
      turnId: null,
      errorCode: null,
      frames: []
    }

    const body = { message, requestId }
    if (sessionId) body.sessionId = sessionId

    const ac = new AbortController()
    let callerAborted = false
    let timedOut = false
    if (signal) {
      if (signal.aborted) callerAborted = true
      else signal.addEventListener('abort', () => { callerAborted = true; ac.abort() }, { once: true })
    }
    let idleTimer = null
    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => { timedOut = true; ac.abort() }, this.timeoutMs)
    }

    this.#activeSse += 1
    if (this.#activeSse > this.#activePeak) this.#activePeak = this.#activeSse

    const rawFrames = []
    let firstTokenMs = null
    let firstTokenRecorded = false
    let endedWithoutDone = false
    let sseCode = null
    let sseMessage = null
    let envelopeOk = null
    let envelopeCode = null
    let envelopeMessage = null
    let fetchError = null
    let reader = null

    const handleEvent = (ev, parsed) => {
      switch (ev) {
        case 'session': {
          if (parsed && parsed.sessionId) {
            event.sessionId = parsed.sessionId
            sample.meta = { ...(sample.meta ?? {}), sessionId: parsed.sessionId }
          }
          break
        }
        case 'round':
        case 'tool':
        case 'tool-end':
          // 元数据帧：不计首 token。
          break
        case 'text': {
          const t = parsed && typeof parsed.text === 'string' ? parsed.text : ''
          event.text += t
          if (!firstTokenRecorded && t.trim() !== '') {
            firstTokenMs = Date.now() - at
            firstTokenRecorded = true
          }
          break
        }
        case 'done': {
          event.done = true
          event.turnId = parsed?.turnId ?? null
          if (parsed?.sessionId) event.sessionId = parsed.sessionId
          if (typeof parsed?.text === 'string' && parsed.text) event.text = parsed.text
          event.artifacts = parsed?.artifacts ?? null
          event.citations = parsed?.citations ?? null
          break
        }
        case 'error': {
          sseCode = parsed?.code ?? 'SSE_ERROR'
          sseMessage = parsed?.message ?? null
          event.errorCode = sseCode
          break
        }
        default:
          // 未知事件记入明细但不中断流（02 §5.2）。
          break
      }
    }

    try {
      armIdle()
      const res = await this.fetchImpl(this.#url('/api/v1/chat/stream'), {
        method: 'POST',
        headers: this.#authHeaders(token, studentId),
        body: JSON.stringify(body),
        signal: ac.signal
      })
      sample.status = res.status
      const contentType = res.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        // 服务端在建立事件流之前就用 JSON 信封拒绝了请求（冻结 §4 的错误信封）：
        // 按「HTTP 200 + 信封 ok:false」归 businessError，4xx/5xx 仍由状态码优先分类。
        const text = await res.text()
        const envelope = safeJson(text)
        if (!envelope || typeof envelope !== 'object') {
          throw new Error('SSE 响应既不是事件流，也不是冻结信封')
        }
        envelopeOk = envelope.ok === true
        if (envelope.ok !== true) {
          envelopeCode = envelope.error?.code ?? 'SSE_ERROR'
          envelopeMessage = envelope.error?.message ?? null
          event.errorCode = envelopeCode
        }
      } else if (!res.body) throw new Error('SSE 响应缺少可读流')
      if (contentType.includes('text/event-stream')) {
        reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let curEvent = null
        let dataLines = []
        let frameLines = []

        const dispatch = () => {
          const hasContent = curEvent !== null || dataLines.length > 0
          const raw = frameLines.join('\n')
          frameLines = []
          if (!hasContent) return
          if (raw) rawFrames.push(raw)
          const data = dataLines.join('\n')
          const parsed = data ? safeJson(data) : null
          handleEvent(curEvent, parsed)
          curEvent = null
          dataLines = []
        }

        for (;;) {
          if (event.done) break // done 只认一次，收到后立即收尾
          armIdle()
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let nl
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).replace(/\r$/, '')
            buffer = buffer.slice(nl + 1)
            armIdle()
            if (line === '') {
              dispatch()
              if (event.done) break
              continue
            }
            frameLines.push(line)
            if (line.startsWith(':')) continue // 注释行（心跳），跳过但仍刷新空闲计时
            const colon = line.indexOf(':')
            const field = colon < 0 ? line : line.slice(0, colon)
            let value = colon < 0 ? '' : line.slice(colon + 1)
            if (value.startsWith(' ')) value = value.slice(1)
            if (field === 'event') curEvent = value
            else if (field === 'data') dataLines.push(value)
            // id 字段仅做诊断，不实现断线重连。
          }
        }
        if (event.done) {
          try { await reader.cancel() } catch { /* 流已关闭则忽略 */ }
        }
        dispatch()
        if (!event.done && sseCode === null) endedWithoutDone = true
      }
    } catch (err) {
      fetchError = err
    } finally {
      clearTimeout(idleTimer)
      if (reader) {
        try { reader.releaseLock() } catch { /* 锁已释放则忽略 */ }
      }
      this.#activeSse -= 1
    }

    sample.durationMs = Date.now() - at
    const { errorClass, ok } = classify({
      callerAborted,
      timedOut,
      fetchError,
      status: sample.status,
      envelopeOk,
      sseCode,
      endedWithoutDone
    })
    sample.errorClass = errorClass
    sample.ok = ok
    sample.code = sseCode ?? envelopeCode
    sample.message = sseMessage ?? envelopeMessage
    // 失败轮次首 token 必须为 null：不补 0、不用上一次样本顶替。
    sample.firstTokenMs = errorClass === null ? firstTokenMs : null

    if (errorClass !== null) {
      sample.rawFrames = rawFrames.join('\n\n')
      event.frames = rawFrames
    } else {
      sample.rawFrames = null
      event.frames = []
    }
    return { sample, event }
  }

  /**
   * 抓取 /metrics 原始文本；不在客户端解析。metricsToken 非空时带 Bearer。
   * @returns {{ok: boolean, status: number|null, text: string}}
   */
  async scrapeMetrics() {
    const headers = {}
    if (this.metricsToken) headers.authorization = `Bearer ${this.metricsToken}`
    try {
      const res = await this.fetchImpl(this.#url('/metrics'), { headers })
      const text = await res.text()
      return { ok: res.status === 200, status: res.status, text }
    } catch (err) {
      return { ok: false, status: null, text: '' }
    }
  }
}
