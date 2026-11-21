/**
 * stub 目标 —— 断网、不起进程的内存桩（03-implementation §3.5）。
 *
 * 它存在有两个明确理由（不是「假回退」）：
 * 1. 并行开工：A 轮服务端还没交付时，E 的断言、报告、编号算术必须先自洽可跑；
 * 2. 把「冻结表」落成可执行的东西：桩对每条方法的返回形状、每条非法输入的错误码与逐字中文消息
 *    都按 src/frozen.mjs 实现，用例一旦与冻结表漂移，桩与断言会有一边先红。
 *
 * 它**不**替代真实验证：http 目标打真实 apps/server，electron 目标打真实 Electron；桩的通过只说明用例自洽。
 * 桩不访问网络、不写库、不读真实数据目录。
 */

import {
  METHODS,
  LEGACY_METHODS,
  ERROR_CODES,
  PARAMS_NOT_OBJECT,
  MESSAGE_ANSWER_SET_EMPTY,
  unknownMethodMessage,
  requiredMessage,
} from './frozen.mjs'
import { newRequestId, MISSING_ID } from './fixtures.mjs'

const STUDENT_A_ID = '20230001'
const STUDENT_B_ID = '20230002'

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isInteger(value) {
  return typeof value === 'number' && Number.isInteger(value)
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0)
}

/** 错误信封：code / http / 逐字消息 / field。 */
function failure(code, message, field = null) {
  const httpStatus = ERROR_CODES[code]?.http ?? 400
  return { ok: false, error: { code, message, field, detail: {} }, httpStatus }
}

export class StubTarget {
  constructor({ home = '.scratch/run/E/home-stub', studentId = STUDENT_A_ID } = {}) {
    this.kind = 'stub'
    this.home = home
    this.studentId = studentId
    this.pending = new Map()
    this.attempts = []
    this.answerSets = []
    this.connected = false
    this.discovery = {}
  }

  describe() {
    return { kind: 'stub', home: this.home, note: '内存桩：不联网、不起进程、不读写业务库' }
  }

  async connect() {
    this.connected = true
    // 桩的「种子数据」：一条会话、一份产物、一条事实、一条证据、一个新闻源、一道题。
    // discovery 的作用与 http 目标一致：把冻结表里的 $symbol 换成真实 ID。
    this.discovery = {
      articleId: 'stub-article-1',
      sessionId: 'stub-session-1',
      artifactId: 'stub-artifact-1',
      factId: 'stub-fact-1',
      evidenceId: 'stub-evidence-1',
      sourceId: 'stub-source-1',
      chapterId: 'stub-chapter-1',
      kpId: 'stub-kp-1',
      blockId: 'stub-block-1',
      resourceId: 'stub-resource-1',
      questionId: 'stub-question-1',
      questionIds: ['stub-question-1', 'stub-question-2'],
    }
  }

  async close() {
    this.connected = false
  }

  /** 作答行 id：按 AttemptSchema 的形状给稳定可复现的序号，便于回读断言逐条对照。 */
  nextAttemptId() {
    return 'stub-attempt-' + String(this.attempts.length + 1)
  }

  /** 身份解析：opts.asStudent='B' 用第二个学生；auth=false → AUTH_REQUIRED；auth='invalid' → AUTH_INVALID。 */
  identity(opts = {}) {
    if (opts.auth === false) return { error: failure('AUTH_REQUIRED', ERROR_CODES.AUTH_REQUIRED.message) }
    if (opts.auth === 'invalid') return { error: failure('AUTH_INVALID', ERROR_CODES.AUTH_INVALID.message) }
    const role = opts.asStudent === 'B' ? 'B' : 'A'
    return { studentId: role === 'B' ? STUDENT_B_ID : this.studentId }
  }

  /**
   * 逐方法校验：顺序按「方法存在 → params 形态 → 必填 → 类型 → 枚举 → 范围 → 归属」。
   * 用例断言的 400 消息都是「先于归属」的参数错误，这个顺序与冻结 §4.3 的严格口径一致。
   */
  validate(method, params, rules) {
    if (!isPlainObject(params)) {
      return failure(PARAMS_NOT_OBJECT.code, PARAMS_NOT_OBJECT.message, PARAMS_NOT_OBJECT.field)
    }
    for (const field of rules.required ?? []) {
      const value = params[field]
      if (value === undefined || value === null || value === '') {
        return failure('BAD_REQUEST', requiredMessage(field), field)
      }
    }
    for (const field of rules.nonEmptyStrings ?? []) {
      const value = params[field]
      if (value === undefined || value === null || value === '') {
        return failure('BAD_REQUEST', requiredMessage(field), field)
      }
    }
    for (const field of rules.nonEmptyStringArray ?? []) {
      if (params[field] !== undefined && !isNonEmptyStringArray(params[field])) {
        const message = field === 'sources' ? 'sources 必须是非空字符串数组。' : `${field} 必须是非空字符串数组。`
        return failure('BAD_REQUEST', message, field)
      }
    }
    for (const [field, spec] of Object.entries(rules.enum ?? {})) {
      if (params[field] !== undefined && !spec.values.includes(params[field])) {
        return failure('BAD_REQUEST', spec.message, field)
      }
    }
    if (rules.limit) {
      const field = rules.limit.param ?? 'limit'
      const value = params[field]
      if (value !== undefined) {
        if (!isInteger(value)) {
          return failure('BAD_REQUEST', rules.limit.typeMessage, field)
        }
        if (value < rules.limit.min || value > rules.limit.max) {
          return failure('BAD_REQUEST', rules.limit.rangeMessage, field)
        }
      }
    }
    return null
  }

  /** 归属校验（冻结 §3.3 四类）。桩里只有一条会话/产物/证据/事实，且都属于学生 A。 */
  ownershipError(method, params, studentId) {
    if (studentId !== STUDENT_A_ID) {
      if (method === 'chat.messages' || method === 'agent.turns') {
        if (params.sessionId === 'stub-session-1') return failure('FORBIDDEN', ERROR_CODES.FORBIDDEN.message)
      }
      if (method === 'artifacts.get' || method === 'artifacts.export') {
        if (params.artifactId === 'stub-artifact-1') return failure('FORBIDDEN', ERROR_CODES.FORBIDDEN.message)
      }
      if (method === 'profile.review') {
        if (params.evidenceId === 'stub-evidence-1') return failure('FORBIDDEN', ERROR_CODES.FORBIDDEN.message)
      }
      if (method === 'memory.delete') {
        // 冻结 §3.3：按 student_id 查不到该 factId → 403（不暴露「存在但不属于你」）
        if (params.factId === 'stub-fact-1') return failure('FORBIDDEN', ERROR_CODES.FORBIDDEN.message)
      }
    }
    return null
  }

  /** 不存在判定：只有「本方法真的按 ID 查记录」的方法才判 404。 */
  notFoundError(method, params) {
    if (method === 'news.get' || method === 'news.match') {
      if (params.articleId && params.articleId !== this.discovery.articleId) return failure('NOT_FOUND', ERROR_CODES.NOT_FOUND.message)
    }
    if (method === 'chat.messages' || method === 'agent.turns') {
      if (params.sessionId && params.sessionId !== this.discovery.sessionId) return failure('NOT_FOUND', ERROR_CODES.NOT_FOUND.message)
    }
    if (method === 'artifacts.get' || method === 'artifacts.export') {
      if (params.artifactId && params.artifactId !== this.discovery.artifactId) return failure('NOT_FOUND', ERROR_CODES.NOT_FOUND.message)
    }
    if (method === 'memory.delete') {
      if (params.factId && params.factId !== this.discovery.factId) return failure('NOT_FOUND', ERROR_CODES.NOT_FOUND.message)
    }
    if (method === 'profile.review') {
      if (params.evidenceId && params.evidenceId !== this.discovery.evidenceId) return failure('NOT_FOUND', ERROR_CODES.NOT_FOUND.message)
    }
    if (method === 'agent.retry') {
      if (params.sourceId && params.sourceId !== this.discovery.sourceId) return failure('NOT_FOUND', ERROR_CODES.NOT_FOUND.message)
    }
    return null
  }

  /** 30 个方法 + 4 legacy 的返回形状（字段名按冻结 §5 顶层列）。 */
  resultFor(method, params, requestId) {
    switch (method) {
      case 'student.current':
        return { studentId: STUDENT_A_ID, name: '桩·学生甲', cohort: '2023' }
      case 'chapters.list':
        return [{ id: this.discovery.chapterId, title: '第一章', order: 1 }]
      case 'kps.list':
        return [{ id: this.discovery.kpId, title: '知识点 1', chapterId: this.discovery.chapterId }]
      case 'news.list':
        return [{ id: this.discovery.articleId, title: '新闻 1', source: '36kr', fetchedAt: '2026-11-19T00:00:00.000Z' }]
      case 'news.status':
        return { count: 1, newestFetchedAt: '2026-11-19T00:00:00.000Z' }
      case 'news.refresh':
        return { results: [], queued: 0, accepted: 0, count: 1, newestFetchedAt: '2026-11-19T00:00:00.000Z' }
      case 'news.get':
        return { article: { id: params.articleId, title: '新闻 1' }, matches: [], ideology: [] }
      case 'news.match':
        return { matches: [] }
      case 'questions.attempts':
        return this.attempts.slice()
      case 'profile.get':
        return { studentId: STUDENT_A_ID, competencies: [], updatedAt: '2026-11-19T00:00:00.000Z' }
      case 'profile.growth':
        // 真实 growthSummary() 返回 GrowthSummaryItem[]（packages/profile/src/index.ts:382）。
        return []
      case 'profile.evidence':
        return [{ id: this.discovery.evidenceId, studentId: STUDENT_A_ID, status: 'draft', competencyId: 'c1' }]
      case 'profile.snapshot':
        // 真实 recordSnapshot() 返回 GrowthSnapshot[]（packages/profile/src/index.ts:331）。
        return []
      case 'profile.review':
        return { ok: true }
      case 'artifacts.list':
        return [{ id: this.discovery.artifactId, studentId: STUDENT_A_ID, title: '导出件 1' }]
      case 'artifacts.get':
        return { id: this.discovery.artifactId, studentId: STUDENT_A_ID, title: '导出件 1', format: 'md' }
      case 'artifacts.export':
        return { path: `${this.home}/exports/${this.discovery.artifactId}.${params.format ?? 'docx'}` }
      case 'memory.facts':
        return [{ id: this.discovery.factId, key: 'demo', value: '桩数据', kind: 'goal' }]
      case 'memory.episodes':
        return []
      case 'memory.summary':
        return { facts: 1, episodes: 0 }
      case 'memory.upsert':
        return { id: 'stub-fact-upsert-1', key: params.key, value: params.value, kind: params.kind && ['goal', 'preference', 'constraint', 'background', 'self_assessment', 'open_question'].includes(params.kind) ? params.kind : 'goal' }
      case 'memory.delete':
        return { ok: true }
      case 'chat.sessions':
        return [{ id: this.discovery.sessionId, studentId: STUDENT_A_ID, title: '会话 1' }]
      case 'chat.messages':
        return [
          { id: 'stub-msg-1', sessionId: this.discovery.sessionId, role: 'user', content: '你好', createdAt: '2026-11-19T00:00:00.000Z' },
          { id: 'stub-msg-2', sessionId: this.discovery.sessionId, role: 'assistant', content: '你好，有什么可以帮你的？', createdAt: '2026-11-19T00:00:01.000Z' },
        ]
      case 'agent.snapshot':
        return { chapterId: this.discovery.chapterId, pending: [], updatedAt: '2026-11-19T00:00:00.000Z' }
      case 'agent.suggestions':
        return { items: [{ id: 'sug-1', text: '继续读下一篇' }] }
      case 'agent.turns':
        return [{ id: 'stub-turn-1', sessionId: this.discovery.sessionId, requestId }]
      case 'agent.ledger':
        return { items: [], counts: { pending: 0, retried: 0 } }
      case 'agent.retry':
        return { items: [], counts: { pending: 0, retried: 0 } }
      case 'agent.sessions':
        return [{ id: this.discovery.sessionId, title: '会话 1', updatedAt: '2026-11-19T00:00:00.000Z' }]
      case 'getKp':
        return { id: params.kpId, title: '知识点 1' }
      case 'getBlock':
        return { block: { id: params.blockId, text: '段落 1' }, chapter: this.discovery.chapterId }
      case 'getResource':
        return { guide: { id: params.resourceId ?? params.sourceId, title: '资源 1' }, chapter: this.discovery.chapterId }
      case 'listIdeology':
        return [{ id: 'stub-ideology-1', text: '思政点 1' }]
      default:
        return null
    }
  }

  async rpc(method, params = {}, opts = {}) {
    const requestId = opts.requestId ?? newRequestId()
    const identity = this.identity(opts)
    if (identity.error) return { ...identity.error, requestId, elapsedMs: 0 }

    const row = METHODS.find((item) => item.method === method)
    const legacy = LEGACY_METHODS.find((item) => item.method === method)
    if (!row && !legacy) {
      return { ...failure('UNKNOWN_METHOD', unknownMethodMessage(method)), requestId, elapsedMs: 0 }
    }

    const rules = row?.rules ?? legacy?.rules ?? {}
    const invalid = this.validate(method, params, rules)
    if (invalid) return { ...invalid, requestId, elapsedMs: 0 }

    const ownership = this.ownershipError(method, params, identity.studentId)
    if (ownership) return { ...ownership, requestId, elapsedMs: 0 }

    const notFound = this.notFoundError(method, params)
    if (notFound) return { ...notFound, requestId, elapsedMs: 0 }

    return { ok: true, result: this.resultFor(method, params, requestId), requestId, httpStatus: 200, elapsedMs: 0 }
  }

  /**
   * SSE：固定帧序列 session → round → text → text → done（03-implementation §3.5）。
   * 每次写完一帧让出一次事件循环，好让 cancel() 有机会插进来——E-071 靠这个真取消，不靠 sleep。
   */
  async stream(input, hooks = {}) {
    const requestId = input.requestId ?? newRequestId()
    const state = { cancelled: false }
    this.pending.set(requestId, state)
    const events = []
    const rawFrames = []
    const firstStartedAt = Date.now()
    let firstTokenMs = -1

    const emit = (event, data) => {
      const frame = { id: events.length + 1, event, data, raw: `id: ${events.length + 1}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n` }
      events.push(frame)
      rawFrames.push(frame.raw)
      if (event === 'text' && firstTokenMs < 0) firstTokenMs = Date.now() - firstStartedAt
      hooks.onFrame?.(frame)
    }

    const yieldTurn = () => new Promise((resolve) => setImmediate(resolve))

    emit('session', { requestId, sessionId: this.discovery.sessionId })
    await yieldTurn()
    if (state.cancelled) {
      emit('error', { requestId, code: 'CANCELLED', message: ERROR_CODES.CANCELLED.message })
      this.pending.delete(requestId)
      return { events, rawFrames, doneCount: 0, errorCount: 1, firstTokenMs: firstTokenMs < 0 ? -1 : firstTokenMs, closed: true }
    }

    emit('round', { requestId, round: 1 })
    emit('text', { requestId, agent: 'lead', text: '这是桩返回的第一段中文，' })
    await yieldTurn()
    if (state.cancelled) {
      emit('error', { requestId, code: 'CANCELLED', message: ERROR_CODES.CANCELLED.message })
      this.pending.delete(requestId)
      return { events, rawFrames, doneCount: 0, errorCount: 1, firstTokenMs: firstTokenMs < 0 ? -1 : firstTokenMs, closed: true }
    }

    emit('text', { requestId, agent: 'lead', text: '用来证明增量拼接与终态帧顺序。' })
    emit('done', {
      requestId,
      turnId: 'stub-turn-stream-1',
      sessionId: this.discovery.sessionId,
      text: '这是桩返回的第一段中文，用来证明增量拼接与终态帧顺序。',
      artifacts: [],
      citations: [],
      warnings: [],
    })
    this.pending.delete(requestId)
    return {
      events,
      rawFrames,
      doneCount: 1,
      errorCount: 0,
      firstTokenMs: firstTokenMs < 0 ? -1 : firstTokenMs,
      closed: true,
    }
  }

  async cancel(requestId) {
    const state = this.pending.get(requestId)
    if (!state) {
      return { httpStatus: 200, body: { ok: true, result: { cancelled: false }, requestId } }
    }
    state.cancelled = true
    return { httpStatus: 200, body: { ok: true, result: { cancelled: true }, requestId } }
  }

  async answer(input, opts = {}) {
    const requestId = opts.requestId ?? newRequestId()
    const identity = this.identity(opts)
    if (identity.error) return { ...identity.error, requestId, httpStatus: 401, elapsedMs: 0 }
    if (input === null || typeof input !== 'object') {
      return { ...failure('BAD_REQUEST', PARAMS_NOT_OBJECT.message, 'params'), requestId, httpStatus: 400, elapsedMs: 0 }
    }
    for (const field of ['sessionId', 'questionId', 'answer']) {
      if (!input[field]) return { ...failure('BAD_REQUEST', requiredMessage(field), field), requestId, httpStatus: 400, elapsedMs: 0 }
    }
    if (input.sessionId !== this.discovery.sessionId) {
      return { ...failure('NOT_FOUND', ERROR_CODES.NOT_FOUND.message), requestId, httpStatus: 404, elapsedMs: 0 }
    }
    this.attempts.push({ id: this.nextAttemptId(), question_id: input.questionId, student_id: STUDENT_A_ID, answer: input.answer, score: 1, created_at: new Date().toISOString() })
    return {
      ok: true,
      requestId,
      httpStatus: 200,
      elapsedMs: 0,
      result: {
        turnId: `stub-turn-answer-${this.attempts.length}`,
        text: '作答已记录。',
        feedback: '回答抓住了要点。',
        evidence: [],
        ledger: { items: [], counts: { pending: 0, retried: 0 } },
        warnings: [],
        status: 'graded',
      },
    }
  }

  async answerSet(input, opts = {}) {
    const requestId = opts.requestId ?? newRequestId()
    const identity = this.identity(opts)
    if (identity.error) return { ...identity.error, requestId, httpStatus: 401, elapsedMs: 0 }
    if (input === null || typeof input !== 'object') {
      return { ...failure('BAD_REQUEST', PARAMS_NOT_OBJECT.message, 'params'), requestId, httpStatus: 400, elapsedMs: 0 }
    }
    for (const field of ['sessionId', 'artifactId']) {
      if (!input[field]) return { ...failure('BAD_REQUEST', requiredMessage(field), field), requestId, httpStatus: 400, elapsedMs: 0 }
    }
    if (!Array.isArray(input.answers) || input.answers.length === 0) {
      return { ...failure('BAD_REQUEST', MESSAGE_ANSWER_SET_EMPTY, 'answers'), requestId, httpStatus: 400, elapsedMs: 0 }
    }
    if (input.sessionId !== this.discovery.sessionId) {
      return { ...failure('NOT_FOUND', ERROR_CODES.NOT_FOUND.message), requestId, httpStatus: 404, elapsedMs: 0 }
    }
    const results = input.answers.map((row, index) => ({ questionId: row.questionId, answer: row.answer, status: 'graded', index }))
    this.answerSets.push({ artifactId: input.artifactId, results, at: new Date().toISOString() })
    for (const row of input.answers) {
      this.attempts.push({ id: this.nextAttemptId(), question_id: row.questionId, student_id: STUDENT_A_ID, answer: row.answer, score: 1, created_at: new Date().toISOString() })
    }
    return {
      ok: true,
      requestId,
      httpStatus: 200,
      elapsedMs: 0,
      result: {
        turnId: `stub-turn-set-${this.answerSets.length}`,
        text: '整卷已提交。',
        results,
        ledger: { items: [], counts: { pending: 0, retried: 0 } },
        warnings: [],
        status: 'graded',
      },
    }
  }

  async health(opts = {}) {
    if (opts.auth === true) {
      // health 通道本身不带鉴权；显式要求带 token 时桩也不该报 401（E-076 断言的正是「无鉴权可达」）
    }
    return {
      httpStatus: 200,
      body: {
        ok: true,
        requestId: newRequestId(),
        result: {
          ok: true,
          warnings: [],
          notices: [],
          chapters: 1,
          knowledgePoints: 1,
          newsArticles: 1,
          appHome: `${this.home}`,
          version: '0.1.0',
          uptimeMs: 1234,
        },
      },
    }
  }
}

/** 便捷构造：`new StubTarget({ home })`，与其它 target 的工厂签名一致。 */
export function createStubTarget(options = {}) {
  return new StubTarget(options)
}
