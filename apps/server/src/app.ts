import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { ApiError } from './errors.js'
import { readJson } from './http/read-json.js'
import { assertObject, sendError, sendJson, sendOk } from './http/respond.js'
import { REQUEST_ID_PATTERN, newRequestId } from './http/request-id.js'
import { requireStudent } from './auth/bearer.js'
import { METHODS } from './rpc/registry.js'
import { runWithTimeout, timeoutFor } from './rpc/timeout.js'
import type { Services } from './services.js'
import type { HandlerCtx } from './rpc/types.js'
import { TurnRegistry } from './chat/turns.js'
import { handleChatStream, handleChatCancel } from './chat/stream.js'
import { handleAnswer, handleAnswerSet } from './chat/answers.js'
import { startupHealth } from './health.js'
import { handleLogin, handleLogout } from './auth/routes.js'

const RATE_WINDOW_MS = 60_000
const LOGIN_LIMIT = 5

export interface AppOptions {
  corsOrigins: string[]
}

interface RequestMeta {
  requestId: string
  startedAt: number
}

function requestIdFrom(req: IncomingMessage, body?: Record<string, unknown>): string {
  const candidate = body?.requestId ?? req.headers['x-request-id']
  if (typeof candidate === 'string' && REQUEST_ID_PATTERN.test(candidate)) return candidate
  return newRequestId()
}

/**
 * A client-supplied `requestId` is optional and only adopted when it is well
 * formed; anything else is replaced instead of failing the call (contract §2.1).
 */
function adoptRequestId(meta: RequestMeta, body: Record<string, unknown>): void {
  const candidate = body.requestId
  if (typeof candidate === 'string' && REQUEST_ID_PATTERN.test(candidate)) meta.requestId = candidate
}

function elapsedSeconds(meta: RequestMeta): number {
  return Math.max(0, performance.now() - meta.startedAt) / 1000
}

function pathOf(req: IncomingMessage): string {
  const url = req.url ?? '/'
  const index = url.indexOf('?')
  return (index >= 0 ? url.slice(0, index) : url).replace(/\/+$/, '') || '/'
}

interface ResWithMeta extends ServerResponse {
  yxsBytes?: number
  yxsStudentId?: string
  yxsIgnoredStudentId?: boolean
}

export function createApp(services: Services, options: AppOptions): Server {
  const turns = new TurnRegistry()
  const loginAttempts = new Map<string, { count: number; resetAt: number }>()

  const cors = (req: IncomingMessage, res: ServerResponse): void => {
    const origin = req.headers.origin
    if (typeof origin !== 'string') return
    if (!options.corsOrigins.includes(origin)) return
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-request-id')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  }

  const clientIp = (req: IncomingMessage): string => {
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0]!.trim()
    return req.socket.remoteAddress ?? 'unknown'
  }

  const rateLimited = (req: IncomingMessage): boolean => {
    const key = clientIp(req)
    const now = Date.now()
    const current = loginAttempts.get(key)
    if (!current || current.resetAt <= now) {
      loginAttempts.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS })
      return false
    }
    current.count += 1
    return current.count > LOGIN_LIMIT
  }

  const serveHealth = (res: ServerResponse, meta: RequestMeta): void => {
    const chapters = services.db.listChapters()
    const knowledgePoints = chapters.reduce((total, chapter) => total + services.db.listKpsByChapter(chapter.id).length, 0)
    const newsArticles = services.db.countNews()
    const health = startupHealth({ chapters: chapters.length, knowledgePoints, newsArticles })
    const result = {
      ok: health.ok,
      chapters: chapters.length,
      knowledgePoints,
      newsArticles,
      warnings: health.warnings,
      notices: health.notices,
      appHome: services.env.home,
      version: services.env.version,
      uptimeMs: Math.round(process.uptime() * 1000),
    }
    sendJson(res, health.ok ? 200 : 503, {
      ok: health.ok,
      result,
      requestId: meta.requestId,
      elapsedMs: Math.max(0, Math.round(performance.now() - meta.startedAt)),
    }, meta)
  }

  const handleRpc = async (req: IncomingMessage, res: ResWithMeta, meta: RequestMeta): Promise<void> => {
    const student = requireStudent(req, services.auth)
    res.yxsStudentId = student.studentId
    const body = await readJson(req)
    adoptRequestId(meta, body)
    const method = body.method
    const paramsRaw = body.params
    if (body.studentId !== undefined) res.yxsIgnoredStudentId = true
    if (typeof method !== 'string' || method.trim().length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'method 不能为空。', 'method')
    }
    // `params` is optional in the contract; `null` is still a type error.
    const params = paramsRaw === undefined ? {} : assertObject(paramsRaw)
    if (params.studentId !== undefined) res.yxsIgnoredStudentId = true
    const spec = METHODS.find((item) => item.name === method)
    if (!spec) throw new ApiError(404, 'UNKNOWN_METHOD', `没有这个方法：${method}`)
    const controller = new AbortController()
    try {
      spec.validate(params)
      const handlerCtx: HandlerCtx = {
        services,
        studentId: student.studentId,
        requestId: meta.requestId,
        signal: controller.signal,
        log: services.log,
      }
      const result = await runWithTimeout(timeoutFor(method), controller, () =>
        Promise.resolve(spec.handler(handlerCtx, params)))
      services.metrics.observeRpc(method, 'OK', elapsedSeconds(meta))
      sendOk(res, result, meta)
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'INTERNAL'
      services.metrics.observeRpc(method, code, elapsedSeconds(meta))
      services.metrics.observeError(code)
      throw error
    }
  }

  const server = createServer((req, res: ResWithMeta) => {
    const meta: RequestMeta = { requestId: requestIdFrom(req), startedAt: performance.now() }
    res.setHeader('X-Request-Id', meta.requestId)
    cors(req, res)
    res.on('finish', () => {
      services.metrics.observeHttp(
        req.method ?? 'GET',
        pathOf(req),
        res.statusCode,
        (performance.now() - meta.startedAt) / 1000,
      )
      services.log.info({
        requestId: meta.requestId,
        studentId: res.yxsStudentId ?? '',
        method: req.method ?? '',
        route: pathOf(req),
        status: res.statusCode,
        durationMs: Math.round(performance.now() - meta.startedAt),
        bytes: res.yxsBytes ?? Number(res.getHeader('content-length') ?? 0),
        ua: String(req.headers['user-agent'] ?? ''),
        ignoredStudentId: res.yxsIgnoredStudentId ?? false,
      })
    })

    const fail = (error: unknown, context: 'chat' | 'answer' = 'chat') => {
      if (res.headersSent) {
        if (!res.writableEnded) res.end()
        return
      }
      const info = sendError(res, error, meta, context)
      res.yxsBytes = info.bytes
      services.metrics.observeError(info.code)
      if (info.status >= 500) services.log.error({ requestId: meta.requestId, code: info.code, status: info.status })
    }

    const run = async (): Promise<void> => {
      const path = pathOf(req)
      const method = req.method ?? 'GET'
      if (method === 'OPTIONS' && options.corsOrigins.length > 0) {
        res.writeHead(204)
        res.end()
        return
      }
      if (method === 'GET' && (path === '/health' || path === '/api/v1/health')) {
        serveHealth(res, meta)
        return
      }
      if (method === 'GET' && path === '/metrics') {
        if (services.env.metricsToken.length > 0) {
          const header = String(req.headers.authorization ?? '')
          if (header !== `Bearer ${services.env.metricsToken}`) {
            throw new ApiError(401, 'AUTH_REQUIRED', '请先登录。')
          }
        }
        const text = await services.metrics.render()
        res.writeHead(200, {
          'Content-Type': services.metrics.contentType,
          'Cache-Control': 'no-store',
        })
        res.yxsBytes = Buffer.byteLength(text)
        res.end(text)
        return
      }
      if (method === 'GET' && path === '/api/v1/openapi.yaml') {
        const text = readFileSync(services.env.openapiPath, 'utf8')
        res.writeHead(200, {
          'Content-Type': 'application/yaml; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': String(Buffer.byteLength(text)),
        })
        res.yxsBytes = Buffer.byteLength(text)
        res.end(text)
        return
      }
      if (method === 'POST' && path === '/api/v1/auth/login') {
        const body = await readJson(req)
        adoptRequestId(meta, body)
        const limited = rateLimited(req)
        const result = await handleLogin(services, body, limited)
        res.yxsStudentId = result.student.studentId
        sendOk(res, result, meta)
        return
      }
      if (method === 'POST' && path === '/api/v1/auth/logout') {
        const student = requireStudent(req, services.auth)
        res.yxsStudentId = student.studentId
        handleLogout(services, student.token)
        sendOk(res, { ok: true }, meta)
        return
      }
      if ((method === 'GET' || method === 'POST') && (
        path === '/api/v1/auth/cas/callback' || path === '/api/v1/auth/oauth/callback'
      )) {
        throw new ApiError(501, 'NOT_IMPLEMENTED', '统一身份认证还没接，请先用学号口令登录。')
      }
      if (method === 'POST' && path === '/api/v1/rpc') {
        await handleRpc(req, res, meta)
        return
      }
      if (method === 'POST' && path === '/api/v1/chat/stream') {
        await handleChatStream(req, res, services, turns, meta)
        return
      }
      if (method === 'POST' && path === '/api/v1/chat/cancel') {
        const student = requireStudent(req, services.auth)
        res.yxsStudentId = student.studentId
        const body = await readJson(req)
        adoptRequestId(meta, body)
        if (typeof body.studentId !== 'undefined') res.yxsIgnoredStudentId = true
        const requestId = body.requestId
        // Frozen §7.2: an unknown or already-finished id is `cancelled:false`
        // with HTTP 200, not an error. Only a missing / non-string id is a 400 —
        // re-deriving a well-formed id would defeat the whole lookup.
        if (typeof requestId !== 'string' || requestId.trim().length === 0) {
          throw new ApiError(400, 'BAD_REQUEST', 'requestId 不能为空。', 'requestId')
        }
        sendOk(res, { cancelled: handleChatCancel(turns, requestId) }, meta)
        return
      }
      if (method === 'POST' && path === '/api/v1/answer') {
        await handleAnswer(req, res, services, meta)
        return
      }
      if (method === 'POST' && path === '/api/v1/answer-set') {
        await handleAnswerSet(req, res, services, meta)
        return
      }
      throw new ApiError(404, 'NOT_FOUND', `没有找到这个接口：${path}`)
    }

    run().catch((error: unknown) => {
      // Ensure an unread request body never holds the socket open.
      if (!req.readableEnded) req.resume()
      fail(error, pathOf(req).includes('answer') ? 'answer' : 'chat')
    })
  })
  return server
}
