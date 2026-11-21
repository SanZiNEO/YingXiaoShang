// 职责：F 轮压测内置桩服务——真实监听 127.0.0.1 的 node:http 服务，端点、SSE 帧序、信封与 /metrics 口径对齐冻结契约；不写盘、不访问外网，供同一套客户端代码打桩或打真机。

import http from 'node:http'
import crypto from 'node:crypto'
import { BUCKET_BOUNDARIES } from './metrics.mjs'

const ONE_MIB = 1024 * 1024
const DEFAULT_PASSWORD = 'yxs-loadtest'

/** 冻结契约 §3.1：同一 IP 每分钟 5 次登录尝试。 */
const LOGIN_LIMIT = 5
const LOGIN_WINDOW_MS = 60_000

/** 生成 `req_` + 12 位 base36 请求 ID。 */
function newRequestId() {
  const n = crypto.randomBytes(8).readBigUInt64BE(0)
  return `req_${n.toString(36).padStart(12, '0').slice(-12)}`
}

/** 边界数值的 exposition 文本形式。 */
function boundaryText(b) {
  return Number.isInteger(b) ? String(b) : String(b)
}

function makeHist() {
  return {
    buckets: new Array(BUCKET_BOUNDARIES.length + 1).fill(0),
    sum: 0,
    count: 0,
  }
}

/** 观测一次耗时（秒）；桶计数按 Prometheus 累计口径写入。 */
function observeHist(hist, seconds) {
  hist.count += 1
  hist.sum += seconds
  let idx = BUCKET_BOUNDARIES.findIndex((b) => seconds <= b)
  if (idx === -1) idx = BUCKET_BOUNDARIES.length
  for (let k = idx; k < hist.buckets.length; k += 1) hist.buckets[k] += 1
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

/**
 * 创建压测桩服务。
 * @param {object} options
 * @param {number} [options.port=18080] 监听端口；被占用时退避 +100（18180）
 * @param {string} [options.password='yxs-loadtest'] 登录口令
 * @param {string[]} [options.students=[]] 允许登录的学号清单
 * @param {string} [options.home=''] 隔离数据目录（对应被测实例的 LEARNING_AGENT_HOME），仅回显在 /health 的 appHome
 * @param {object} [options.mutations] 自检/反向验证开关，默认全关
 * @param {(event:object)=>void} [options.log] 可选诊断回调（不记录 token/口令/正文）
 * @returns {Promise<{url:string,port:number,close:()=>Promise<void>,state:object}>}
 */
export function createStubServer(options = {}) {
  const port = options.port ?? 18080
  const password = options.password ?? DEFAULT_PASSWORD
  const students = Array.isArray(options.students) ? options.students : []
  const home = typeof options.home === 'string' ? options.home : ''
  const mutations = options.mutations ?? {}
  const log = typeof options.log === 'function' ? options.log : null

  const m = {
    firstTokenDelayMs: mutations.firstTokenDelayMs ?? 20,
    dropDoneAfterTextFrames:
      mutations.dropDoneAfterTextFrames == null ? null : Number(mutations.dropDoneAfterTextFrames),
    missingBuckets: Array.isArray(mutations.missingBuckets) ? mutations.missingBuckets : [],
    renameErrorsMetric: mutations.renameErrorsMetric === true,
    faults: mutations.faults && typeof mutations.faults === 'object' ? mutations.faults : {},
  }

  const validStudents = new Set(students)

  /** 桩内部真实统计状态；close() 后不再复用。 */
  const state = {
    startedAt: Date.now(),
    tokens: new Map(), // token -> studentId
    cancels: new Map(), // requestId -> { aborted, handle }
    openStreams: new Set(), // 在途 SSE 句柄
    httpRequests: new Map(), // `${method}|${route}|${status}` -> count
    httpHist: new Map(), // `${method}|${route}` -> hist
    rpc: new Map(), // `${method}|${code}` -> count
    usage: new Map(), // `${studentId}|${kind}` -> count
    errors: new Map(), // code -> count
    login: new Map(), // result -> count
    loginAttempts: new Map(), // ip -> { count, resetAt }（与 apps/server/src/app.ts 的 rateLimited 同口径）
    firstToken: makeHist(),
    sseActive: 0,
    ssePeak: 0,
    busy: { 'learning.db': 0 },
    sessionSeq: 0,
    artifactSeq: 0,
    artifacts: new Map(), // artifactId -> { studentId, sessionId, questionIds }（交卷归属校验用）
    turnsBySession: new Map(), // sessionId -> TurnRow[]（每发一次 done 追加一行，供 agent.turns 回读对账）
  }

  function emit(level, message, extra = {}) {
    if (log) log({ level, message, ts: new Date().toISOString(), ...extra })
  }

  // ---------- 基础响应 ----------

  function sendJson(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
    })
    res.end(JSON.stringify(body))
  }

  function fail(res, status, code, message, field, requestId, elapsedMs) {
    state.errors.set(code, (state.errors.get(code) ?? 0) + 1)
    sendJson(res, status, {
      ok: false,
      error: { code, message, field: field ?? null, detail: {} },
      requestId,
      elapsedMs,
    })
  }

  function okEnvelope(result, requestId, elapsedMs) {
    return { ok: true, result, requestId, elapsedMs }
  }

  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > ONE_MIB) return { tooLarge: true }
      chunks.push(chunk)
    }
    if (size === 0) return { body: {} }
    try {
      return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    } catch {
      return { parseError: true }
    }
  }

  function authenticate(req) {
    const header = req.headers.authorization || ''
    if (!header.startsWith('Bearer ')) {
      return { status: 401, code: 'AUTH_REQUIRED', message: '请先登录。', studentId: null }
    }
    const token = header.slice('Bearer '.length).trim()
    const studentId = state.tokens.get(token)
    if (!studentId) {
      return { status: 401, code: 'AUTH_INVALID', message: '登录已失效，请重新登录。', studentId: null }
    }
    return { status: 200, code: 'OK', studentId, token }
  }

  function studentName(studentId) {
    const idx = students.indexOf(studentId)
    const seq = idx >= 0 ? idx + 1 : 1
    return `压测学生${String(seq).padStart(3, '0')}`
  }

  /** 与 apps/server/src/app.ts:80 的 clientIp 同口径：优先 X-Forwarded-For 首段。 */
  function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim()
    return req.socket.remoteAddress ?? 'unknown'
  }

  /** 与 apps/server/src/app.ts:85 的 rateLimited 同口径（冻结契约 §3.1：同 IP 每分钟 5 次）。 */
  function rateLimited(req) {
    const key = clientIp(req)
    const now = Date.now()
    const current = state.loginAttempts.get(key)
    if (!current || current.resetAt <= now) {
      state.loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
      return false
    }
    current.count += 1
    return current.count > LOGIN_LIMIT
  }

  // ---------- 指标记录 ----------

  function recordHttp(method, route, status, elapsedSec) {
    const reqKey = `${method}|${route}|${status}`
    state.httpRequests.set(reqKey, (state.httpRequests.get(reqKey) ?? 0) + 1)
    const histKey = `${method}|${route}`
    let hist = state.httpHist.get(histKey)
    if (!hist) {
      hist = makeHist()
      state.httpHist.set(histKey, hist)
    }
    observeHist(hist, elapsedSec)
  }

  function recordRpc(method, code) {
    const key = `${method}|${code}`
    state.rpc.set(key, (state.rpc.get(key) ?? 0) + 1)
  }

  function recordUsage(studentId, kind, amount) {
    const key = `${studentId}|${kind}`
    state.usage.set(key, (state.usage.get(key) ?? 0) + amount)
  }

  // ---------- 路由 ----------

  function matchRoute(req) {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
    if (req.method === 'GET' && pathname === '/health') return '/health'
    if (req.method === 'GET' && pathname === '/api/v1/health') return '/api/v1/health'
    if (req.method === 'GET' && pathname === '/metrics') return '/metrics'
    if (req.method === 'POST' && pathname === '/api/v1/auth/login') return '/api/v1/auth/login'
    if (req.method === 'POST' && pathname === '/api/v1/rpc') return '/api/v1/rpc'
    if (req.method === 'POST' && pathname === '/api/v1/chat/stream') return '/api/v1/chat/stream'
    if (req.method === 'POST' && pathname === '/api/v1/chat/cancel') return '/api/v1/chat/cancel'
    if (req.method === 'POST' && pathname === '/api/v1/answer') return '/api/v1/answer'
    if (req.method === 'POST' && pathname === '/api/v1/answer-set') return '/api/v1/answer-set'
    return '/*'
  }

  // ---------- 端点实现 ----------

  function handleLogin(req, res, t0) {
    const requestId = newRequestId()
    // 限流在任何读体之前判定，与 apps/server/src/app.ts:233 一致：超限请求连体都不读。
    if (rateLimited(req)) {
      state.login.set('rate_limited', (state.login.get('rate_limited') ?? 0) + 1)
      fail(res, 429, 'RATE_LIMITED', '尝试太频繁，请等一分钟再试。', null, requestId, Date.now() - t0)
      return
    }
    readBody(req)
      .then(({ body, parseError, tooLarge }) => {
        const elapsedMs = Date.now() - t0
        if (tooLarge) {
          state.login.set('fail', (state.login.get('fail') ?? 0) + 1)
          fail(res, 413, 'PAYLOAD_TOO_LARGE', '这次提交的内容太大了（上限 1 MB），分几次发。', null, requestId, elapsedMs)
          return
        }
        if (parseError) {
          state.login.set('fail', (state.login.get('fail') ?? 0) + 1)
          fail(res, 400, 'BAD_REQUEST', '请求体格式不正确，请检查后重试。', null, requestId, elapsedMs)
          return
        }
        const studentId = String(body?.studentId ?? '')
        const bodyPassword = String(body?.password ?? '')
        const studentOk = validStudents.size === 0 || validStudents.has(studentId)
        if (!studentOk || bodyPassword !== password) {
          state.login.set('fail', (state.login.get('fail') ?? 0) + 1)
          fail(res, 401, 'AUTH_FAILED', '学号或口令不对，请检查后再试。', 'password', requestId, elapsedMs)
          return
        }
        const token = crypto.randomBytes(32).toString('base64url')
        state.tokens.set(token, studentId)
        const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
        state.login.set('ok', (state.login.get('ok') ?? 0) + 1)
        sendJson(res, 200, okEnvelope(
          {
            token,
            expiresAt,
            student: { studentId, name: studentName(studentId), cohort: '2023' },
          },
          requestId,
          elapsedMs,
        ))
      })
      .catch((err) => {
        emit('error', '登录请求处理异常', { code: 'INTERNAL', error: String(err?.message ?? err) })
        fail(res, 500, 'INTERNAL', '服务端出了点问题，已经记下来了，请稍后重试。', null, requestId, Date.now() - t0)
      })
  }

  function handleRpc(req, res, t0) {
    const requestId = newRequestId()
    const auth = authenticate(req)
    if (auth.studentId == null) {
      fail(res, auth.status, auth.code, auth.message, null, requestId, Date.now() - t0)
      return
    }
    const fault = m.faults[auth.studentId]
    readBody(req)
      .then(({ body, parseError }) => {
        const elapsedMs = Date.now() - t0
        const method = String(body?.method ?? '')
        const params = body?.params && typeof body.params === 'object' ? body.params : {}

        if (fault === 'http500') {
          recordRpc(method || 'unknown', 'INTERNAL')
          fail(res, 500, 'INTERNAL', '服务端出了点问题，已经记下来了，请稍后重试。', null, requestId, elapsedMs)
          return
        }
        if (fault === 'http400') {
          recordRpc(method || 'unknown', 'BAD_REQUEST')
          fail(res, 400, 'BAD_REQUEST', '请求参数不正确，请检查后重试。', null, requestId, elapsedMs)
          return
        }
        if (fault === 'business') {
          recordRpc(method || 'unknown', 'INTERNAL')
          sendJson(res, 200, {
            ok: false,
            error: { code: 'INTERNAL', message: '业务处理失败，请稍后重试。', field: null, detail: {} },
            requestId,
            elapsedMs,
          })
          return
        }
        if (parseError) {
          recordRpc(method || 'unknown', 'BAD_REQUEST')
          fail(res, 400, 'BAD_REQUEST', '请求体格式不正确，请检查后重试。', null, requestId, elapsedMs)
          return
        }
        if (!method) {
          recordRpc('', 'UNKNOWN_METHOD')
          fail(res, 404, 'UNKNOWN_METHOD', '没有这个方法：', 'method', requestId, elapsedMs)
          return
        }

        if (method === 'student.current') {
          recordRpc(method, 'OK')
          sendJson(res, 200, okEnvelope(
            { studentId: auth.studentId, name: studentName(auth.studentId), cohort: '2023' },
            requestId,
            elapsedMs,
          ))
          return
        }
        if (method === 'agent.turns') {
          if (!params.sessionId) {
            recordRpc(method, 'BAD_REQUEST')
            fail(res, 400, 'BAD_REQUEST', 'sessionId 不能为空。', 'sessionId', requestId, elapsedMs)
            return
          }
          recordRpc(method, 'OK')
          sendJson(res, 200, okEnvelope(
            (state.turnsBySession.get(String(params.sessionId)) ?? []).slice(),
            requestId,
            elapsedMs,
          ))
          return
        }
        if (method === 'chat.sessions') {
          recordRpc(method, 'OK')
          sendJson(res, 200, okEnvelope(
            [{ sessionId: `sess_${String(state.sessionSeq + 1).padStart(4, '0')}`, title: '示例会话' }],
            requestId,
            elapsedMs,
          ))
          return
        }
        recordRpc(method, 'UNKNOWN_METHOD')
        fail(res, 404, 'UNKNOWN_METHOD', `没有这个方法：${method}`, 'method', requestId, elapsedMs)
      })
      .catch((err) => {
        emit('error', 'RPC 请求处理异常', { code: 'INTERNAL', error: String(err?.message ?? err) })
        fail(res, 500, 'INTERNAL', '服务端出了点问题，已经记下来了，请稍后重试。', null, requestId, Date.now() - t0)
      })
  }

  function handleAnswer(req, res, t0) {
    const requestId = newRequestId()
    const auth = authenticate(req)
    if (auth.studentId == null) {
      fail(res, auth.status, auth.code, auth.message, null, requestId, Date.now() - t0)
      return
    }
    const fault = m.faults[auth.studentId]
    readBody(req)
      .then(({ body, parseError }) => {
        const elapsedMs = Date.now() - t0
        if (fault === 'http500') {
          fail(res, 500, 'INTERNAL', '服务端出了点问题，已经记下来了，请稍后重试。', null, requestId, elapsedMs)
          return
        }
        if (fault === 'http400') {
          fail(res, 400, 'BAD_REQUEST', '请求参数不正确，请检查后重试。', null, requestId, elapsedMs)
          return
        }
        if (fault === 'business') {
          sendJson(res, 200, {
            ok: false,
            error: { code: 'INTERNAL', message: '业务处理失败，请稍后重试。', field: null, detail: {} },
            requestId,
            elapsedMs,
          })
          return
        }
        if (parseError) {
          fail(res, 400, 'BAD_REQUEST', '请求体格式不正确，请检查后重试。', null, requestId, elapsedMs)
          return
        }
        if (!body?.sessionId) {
          fail(res, 400, 'BAD_REQUEST', 'sessionId 不能为空。', 'sessionId', requestId, elapsedMs)
          return
        }
        if (!body?.questionId) {
          fail(res, 400, 'BAD_REQUEST', 'questionId 不能为空。', 'questionId', requestId, elapsedMs)
          return
        }
        if (!body?.answer) {
          fail(res, 400, 'BAD_REQUEST', 'answer 不能为空。', 'answer', requestId, elapsedMs)
          return
        }
        // 与真实服务端同口径：带 artifactId 时必须校验「这题属于这份题目集」，
        // 否则压测侧的 artifactId/题目 ID 提取错了桩也照收，P0-1 会一直藏在这里。
        const artifactId = typeof body?.artifactId === 'string' ? body.artifactId : ''
        if (artifactId) {
          const owned = state.artifacts.get(artifactId)
          if (!owned
            || owned.studentId !== auth.studentId
            || owned.sessionId !== String(body?.sessionId)
            || !owned.questionIds.includes(String(body.questionId))) {
            fail(res, 400, 'BAD_REQUEST', '这道题不属于当前题目集，没有写入答题记录。', 'questionId', requestId, elapsedMs)
            return
          }
        }
        sendJson(res, 200, okEnvelope(
          {
            turnId: 'turn_1',
            text: '作答已记录。',
            feedback: {},
            evidence: [],
            ledger: {},
            warnings: [],
            status: 'ok',
          },
          requestId,
          elapsedMs,
        ))
      })
      .catch((err) => {
        emit('error', '作答请求处理异常', { code: 'INTERNAL', error: String(err?.message ?? err) })
        fail(res, 500, 'INTERNAL', '服务端出了点问题，已经记下来了，请稍后重试。', null, requestId, Date.now() - t0)
      })
  }

  function handleAnswerSet(req, res, t0) {
    const requestId = newRequestId()
    const auth = authenticate(req)
    if (auth.studentId == null) {
      fail(res, auth.status, auth.code, auth.message, null, requestId, Date.now() - t0)
      return
    }
    const fault = m.faults[auth.studentId]
    readBody(req)
      .then(({ body, parseError }) => {
        const elapsedMs = Date.now() - t0
        if (fault === 'http500') {
          fail(res, 500, 'INTERNAL', '服务端出了点问题，已经记下来了，请稍后重试。', null, requestId, elapsedMs)
          return
        }
        if (fault === 'http400') {
          fail(res, 400, 'BAD_REQUEST', '请求参数不正确，请检查后重试。', null, requestId, elapsedMs)
          return
        }
        if (fault === 'business') {
          sendJson(res, 200, {
            ok: false,
            error: { code: 'INTERNAL', message: '业务处理失败，请稍后重试。', field: null, detail: {} },
            requestId,
            elapsedMs,
          })
          return
        }
        if (parseError) {
          fail(res, 400, 'BAD_REQUEST', '请求体格式不正确，请检查后重试。', null, requestId, elapsedMs)
          return
        }
        if (!body?.sessionId) {
          fail(res, 400, 'BAD_REQUEST', 'sessionId 不能为空。', 'sessionId', requestId, elapsedMs)
          return
        }
        // 真实服务端 handleAnswerSet 要求 artifactId 必填（apps/server/src/chat/answers.ts）。
        const artifactId = typeof body?.artifactId === 'string' ? body.artifactId.trim() : ''
        if (!artifactId) {
          fail(res, 400, 'BAD_REQUEST', 'artifactId 不能为空。', 'artifactId', requestId, elapsedMs)
          return
        }
        const owned = state.artifacts.get(artifactId)
        if (!owned || owned.studentId !== auth.studentId || owned.sessionId !== String(body.sessionId)) {
          fail(res, 400, 'BAD_REQUEST', '题目集不存在或不属于当前学生/会话，没有写入任何答题记录。', 'artifactId', requestId, elapsedMs)
          return
        }
        const answers = Array.isArray(body?.answers) ? body.answers : []
        if (answers.length === 0) {
          fail(res, 400, 'BAD_REQUEST', '这一卷还没有作答，先答一题再交。', 'answers', requestId, elapsedMs)
          return
        }
        const outsider = answers.find((a) => !owned.questionIds.includes(String(a?.questionId ?? '')))
        if (outsider) {
          fail(res, 400, 'BAD_REQUEST', '有题目不属于这份题目集，没有写入任何答题记录。', 'answers', requestId, elapsedMs)
          return
        }
        const results = answers.map((a) => ({ questionId: String(a.questionId), status: 'ok' }))
        sendJson(res, 200, okEnvelope(
          {
            turnId: 'turn_2',
            text: '交卷完成。',
            results,
            ledger: {},
            warnings: [],
            status: 'ok',
          },
          requestId,
          elapsedMs,
        ))
      })
      .catch((err) => {
        emit('error', '交卷请求处理异常', { code: 'INTERNAL', error: String(err?.message ?? err) })
        fail(res, 500, 'INTERNAL', '服务端出了点问题，已经记下来了，请稍后重试。', null, requestId, Date.now() - t0)
      })
  }

  function handleCancel(req, res, t0) {
    const requestId = newRequestId()
    const auth = authenticate(req)
    if (auth.studentId == null) {
      fail(res, auth.status, auth.code, auth.message, null, requestId, Date.now() - t0)
      return
    }
    readBody(req)
      .then(({ body }) => {
        const elapsedMs = Date.now() - t0
        const targetId = String(body?.requestId ?? '')
        const entry = state.cancels.get(targetId)
        let cancelled = false
        if (entry && !entry.handle.closed) {
          entry.aborted = true
          entry.handle.abort()
          cancelled = true
        }
        sendJson(res, 200, okEnvelope({ cancelled }, targetId || requestId, elapsedMs))
      })
      .catch((err) => {
        emit('error', '取消请求处理异常', { code: 'INTERNAL', error: String(err?.message ?? err) })
        fail(res, 500, 'INTERNAL', '服务端出了点问题，已经记下来了，请稍后重试。', null, requestId, Date.now() - t0)
      })
  }

  // ---------- SSE ----------

  function sseFrame(res, id, event, data) {
    res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  async function handleStream(req, res, t0) {
    const auth = authenticate(req)
    if (auth.studentId == null) {
      fail(res, auth.status, auth.code, auth.message, null, newRequestId(), Date.now() - t0)
      return
    }
    const studentId = auth.studentId
    const fault = m.faults[studentId]
    const { body, parseError } = await readBody(req)
    const requestId = String(body?.requestId ?? newRequestId())
    const message = String(body?.message ?? '')

    if (fault === 'http500') {
      fail(res, 500, 'INTERNAL', '服务端出了点问题，已经记下来了，请稍后重试。', null, requestId, Date.now() - t0)
      return
    }
    if (fault === 'http400') {
      fail(res, 400, 'BAD_REQUEST', '请求参数不正确，请检查后重试。', null, requestId, Date.now() - t0)
      return
    }
    if (fault === 'business') {
      sendJson(res, 200, {
        ok: false,
        error: { code: 'INTERNAL', message: '业务处理失败，请稍后重试。', field: null, detail: {} },
        requestId,
        elapsedMs: Date.now() - t0,
      })
      return
    }
    if (parseError) {
      fail(res, 400, 'BAD_REQUEST', '请求体格式不正确，请检查后重试。', null, requestId, Date.now() - t0)
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    })

    state.sseActive += 1
    state.ssePeak = Math.max(state.ssePeak, state.sseActive)

    const sessionId = String(body?.sessionId ?? '') || `sess_${String(++state.sessionSeq).padStart(4, '0')}`
    let frameId = 0
    let closed = false
    let cancelledSent = false
    let textFrameCount = 0

    const handle = {
      closed: false,
      aborted: false,
      abort() { this.aborted = true },
      close() {
        if (this.closed) return
        this.closed = true
        closed = true
        state.openStreams.delete(this)
        state.sseActive = Math.max(0, state.sseActive - 1)
        state.cancels.delete(requestId)
        res.end()
      },
    }
    state.openStreams.add(handle)
    state.cancels.set(requestId, { aborted: false, handle })

    const questionIntent = message.includes('出题') || message.includes('练习题')
    let artifacts = []
    if (questionIntent) {
      // 产物形状对齐 ArtifactSchema（packages/shared/src/index.ts:446）：题目 ID 在
      // content_json.questions[].id，不是顶层 questionIds；桩若自造字段，压测侧会照着错形状取。
      const seq = ++state.artifactSeq
      const artifactId = `art_q${String(seq).padStart(4, '0')}`
      const questions = [1, 2].map((n) => ({
        id: `${artifactId}_q${n}`,
        type: 'single_choice',
        stem: `压测题目 ${n}`,
        options: ['A', 'B'],
        answer: 'A',
        explanation: '',
        kpIds: [],
        difficulty: 2,
      }))
      artifacts = [{
        id: artifactId,
        student_id: studentId,
        session_id: sessionId,
        skill_id: 'question.generate',
        template_id: '',
        type: 'question_set',
        title: '压测题目集',
        format: 'json',
        path: '',
        content: '',
        content_json: { intro: '', questions },
        schema_version: 'QuestionSet@1',
        version: 1,
        status: 'ready',
        source_refs: [],
        evidence_ids: [],
        created_at: new Date().toISOString(),
      }]
      state.artifacts.set(artifactId, {
        studentId,
        sessionId,
        questionIds: questions.map((q) => q.id),
      })
    }

    const finishWithCancel = () => {
      if (cancelledSent || handle.closed) return
      cancelledSent = true
      state.errors.set('CANCELLED', (state.errors.get('CANCELLED') ?? 0) + 1)
      sseFrame(res, ++frameId, 'error', {
        requestId,
        code: 'CANCELLED',
        message: '已停止这一轮（你点的停止）。这次没有保存结果，可以重新提问。',
      })
      handle.close()
    }

    req.on('close', () => {
      if (!handle.closed) handle.close()
    })

    try {
      // 1. session（必须最先发）
      sseFrame(res, ++frameId, 'session', { requestId, sessionId })
      // 2. round
      sseFrame(res, ++frameId, 'round', { requestId, round: 1 })

      if (fault === 'timeout') {
        // 首帧遥遥无期：保持连接，不再写任何正文帧；由客户端空闲超时收口。
        return
      }

      if (fault === 'sseError') {
        sseFrame(res, ++frameId, 'error', {
          requestId,
          code: 'UPSTREAM_FAILED',
          message: '上游服务没响应（新闻服务 / 模型），稍后重试。',
        })
        state.errors.set('UPSTREAM_FAILED', (state.errors.get('UPSTREAM_FAILED') ?? 0) + 1)
        handle.close()
        return
      }

      // 首帧延迟（firstTokenDelayMs）；延迟期间可被取消。
      const firstTokenStart = Date.now()
      await sleep(m.firstTokenDelayMs)
      if (handle.aborted) {
        finishWithCancel()
        return
      }
      observeHist(state.firstToken, (Date.now() - firstTokenStart) / 1000)

      // 3. 首帧 text
      textFrameCount += 1
      sseFrame(res, ++frameId, 'text', { requestId, agent: 'lead', text: '先看这章的重点。' })

      // 4. tool / tool-end
      sseFrame(res, ++frameId, 'tool', { requestId, tool: 'kps.list' })
      sseFrame(res, ++frameId, 'tool-end', { requestId, tool: 'kps.list', chars: 12, preview: '…' })

      // 5. 第二个 text 帧
      textFrameCount += 1
      sseFrame(res, ++frameId, 'text', { requestId, agent: 'lead', text: '再梳理一下易错点。' })

      const dropDone = m.dropDoneAfterTextFrames != null || fault === 'noDone'
      if (dropDone) {
        // 自检 mutation：吐出 text 帧后不发 done 直接关流。
        handle.close()
        return
      }

      if (handle.aborted) {
        finishWithCancel()
        return
      }

      // 6. done（终态，只发一次）
      sseFrame(res, ++frameId, 'done', {
        requestId,
        turnId: 'turn_1',
        sessionId,
        text: '先看这章的重点。再梳理一下易错点。',
        artifacts,
        citations: [],
        warnings: [],
      })
      recordUsage(studentId, 'prompt', 100)
      recordUsage(studentId, 'completion', 50)
      const turns = state.turnsBySession.get(sessionId) ?? []
      turns.push({ turnId: `turn_${turns.length + 1}`, text: '本轮已完成。', createdAt: new Date().toISOString() })
      state.turnsBySession.set(sessionId, turns)
      handle.close()
    } catch (err) {
      emit('error', 'SSE 流处理异常', { code: 'INTERNAL', error: String(err?.message ?? err) })
      if (!handle.closed) handle.close()
    }
  }

  // ---------- /metrics ----------

  function writeHistSeries(L, base, labelsStr, hist) {
    const finite = BUCKET_BOUNDARIES.map(boundaryText)
    const prefix = labelsStr ? `${labelsStr},` : ''
    for (let i = 0; i < BUCKET_BOUNDARIES.length; i += 1) {
      if (m.missingBuckets.includes(finite[i])) continue
      L.push(`${base}_bucket{${prefix}le="${finite[i]}"} ${hist.buckets[i]}`)
    }
    L.push(`${base}_bucket{${prefix}le="+Inf"} ${hist.buckets[BUCKET_BOUNDARIES.length]}`)
    L.push(`${base}_sum{${labelsStr}} ${hist.sum.toFixed(6)}`)
    L.push(`${base}_count{${labelsStr}} ${hist.count}`)
  }

  function renderMetrics() {
    const L = []
    const errorsName = m.renameErrorsMetric ? 'yxs_error_total' : 'yxs_errors_total'

    L.push('# HELP yxs_http_requests_total 已处理 HTTP 请求总数')
    L.push('# TYPE yxs_http_requests_total counter')
    if (state.httpRequests.size === 0) {
      L.push('yxs_http_requests_total{method="GET",route="/health",status="200"} 0')
    } else {
      for (const [key, count] of state.httpRequests) {
        const [method, route, status] = key.split('|')
        L.push(`yxs_http_requests_total{method="${method}",route="${route}",status="${status}"} ${count}`)
      }
    }

    L.push('# HELP yxs_http_request_duration_seconds HTTP 请求耗时直方图')
    L.push('# TYPE yxs_http_request_duration_seconds histogram')
    const httpSeries = [...state.httpHist.entries()]
    if (httpSeries.length === 0) {
      writeHistSeries(L, 'yxs_http_request_duration_seconds', 'method="GET",route="/health"', makeHist())
    } else {
      for (const [key, hist] of httpSeries) {
        const [method, route] = key.split('|')
        writeHistSeries(L, 'yxs_http_request_duration_seconds', `method="${method}",route="${route}"`, hist)
      }
    }

    L.push('# HELP yxs_rpc_requests_total RPC 调用计数（按方法与结果码）')
    L.push('# TYPE yxs_rpc_requests_total counter')
    if (state.rpc.size === 0) {
      L.push('yxs_rpc_requests_total{method="student.current",code="OK"} 0')
    } else {
      for (const [key, count] of state.rpc) {
        const [method, code] = key.split('|')
        L.push(`yxs_rpc_requests_total{method="${method}",code="${code}"} ${count}`)
      }
    }

    L.push('# HELP yxs_tokens_total mock 口径 token 用量（prompt 100 / completion 50 每轮）')
    L.push('# TYPE yxs_tokens_total counter')
    if (state.usage.size === 0) {
      L.push('yxs_tokens_total{student_id="2023F001",kind="prompt"} 0')
      L.push('yxs_tokens_total{student_id="2023F001",kind="completion"} 0')
    } else {
      for (const [key, count] of state.usage) {
        const [studentId, kind] = key.split('|')
        L.push(`yxs_tokens_total{student_id="${studentId}",kind="${kind}"} ${count}`)
      }
    }

    L.push(`# HELP ${errorsName} 错误分类计数`)
    L.push(`# TYPE ${errorsName} counter`)
    if (state.errors.size === 0) {
      L.push(`${errorsName}{code="OK"} 0`)
    } else {
      for (const [code, count] of state.errors) {
        L.push(`${errorsName}{code="${code}"} ${count}`)
      }
    }

    L.push('# HELP yxs_sqlite_busy_total SQLITE_BUSY 次数（桩无数据库，恒为 0）')
    L.push('# TYPE yxs_sqlite_busy_total counter')
    for (const [db, count] of Object.entries(state.busy)) {
      L.push(`yxs_sqlite_busy_total{db="${db}"} ${count}`)
    }

    L.push('# HELP yxs_sse_active_connections 当前在途 SSE 连接数')
    L.push('# TYPE yxs_sse_active_connections gauge')
    L.push(`yxs_sse_active_connections ${state.sseActive}`)

    L.push('# HELP yxs_sse_first_token_seconds 首 token 延迟直方图')
    L.push('# TYPE yxs_sse_first_token_seconds histogram')
    writeHistSeries(L, 'yxs_sse_first_token_seconds', '', state.firstToken)

    L.push('# HELP yxs_login_total 登录计数（按结果）')
    L.push('# TYPE yxs_login_total counter')
    const loginOk = state.login.get('ok') ?? 0
    const loginFail = state.login.get('fail') ?? 0
    const loginLimited = state.login.get('rate_limited') ?? 0
    L.push(`yxs_login_total{result="ok"} ${loginOk}`)
    L.push(`yxs_login_total{result="fail"} ${loginFail}`)
    if (loginLimited > 0) L.push(`yxs_login_total{result="rate_limited"} ${loginLimited}`)

    L.push('# HELP yxs_process_start_time_seconds 进程启动时刻（秒）')
    L.push('# TYPE yxs_process_start_time_seconds gauge')
    L.push(`yxs_process_start_time_seconds ${(state.startedAt / 1000).toFixed(3)}`)

    return `${L.join('\n')}\n`
  }

  // ---------- 服务装配 ----------

  const server = http.createServer((req, res) => {
    const t0 = Date.now()
    const route = matchRoute(req)

    res.on('finish', () => {
      recordHttp(req.method || 'GET', route, res.statusCode, (Date.now() - t0) / 1000)
    })

    Promise.resolve()
      .then(async () => {
        switch (route) {
          case '/health':
            sendJson(res, 200, { ok: true })
            break
          case '/api/v1/health':
            sendJson(res, 200, okEnvelope(
              {
                ok: true,
                warnings: [],
                notices: ['本地新闻库还是空的（不影响聊天）…'],
                chapters: 13,
                knowledgePoints: 0,
                newsArticles: 0,
                appHome: home,
                version: '0.1.0',
                uptimeMs: Date.now() - state.startedAt,
              },
              newRequestId(),
              Date.now() - t0,
            ))
            break
          case '/metrics':
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end(renderMetrics())
            break
          case '/api/v1/auth/login':
            handleLogin(req, res, t0)
            break
          case '/api/v1/rpc':
            handleRpc(req, res, t0)
            break
          case '/api/v1/chat/stream':
            await handleStream(req, res, t0)
            break
          case '/api/v1/chat/cancel':
            handleCancel(req, res, t0)
            break
          case '/api/v1/answer':
            handleAnswer(req, res, t0)
            break
          case '/api/v1/answer-set':
            handleAnswerSet(req, res, t0)
            break
          default:
            fail(res, 404, 'NOT_FOUND', '没有找到这条记录，可能已被删除。', null, newRequestId(), Date.now() - t0)
        }
      })
      .catch((err) => {
        emit('error', '请求分发异常', { code: 'INTERNAL', error: String(err?.message ?? err) })
        if (!res.headersSent) {
          fail(res, 500, 'INTERNAL', '服务端出了点问题，已经记下来了，请稍后重试。', null, newRequestId(), Date.now() - t0)
        } else {
          res.end()
        }
      })
  })

  function listen(p) {
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(p, '127.0.0.1', () => resolve(server.address().port))
    })
  }

  return (async () => {
    let actualPort
    try {
      actualPort = await listen(port)
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        actualPort = await listen(port + 100)
      } else {
        throw err
      }
    }
    return {
      url: `http://127.0.0.1:${actualPort}`,
      port: actualPort,
      async close() {
        for (const handle of [...state.openStreams]) handle.close()
        await new Promise((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()))
        })
      },
      state,
    }
  })()
}
