import type { ServerResponse } from 'node:http'
import { ApiError, toApiError } from '../errors.js'

export interface RespondMeta {
  requestId: string
  startedAt: number
}

export function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt))
}

export function okEnvelope(result: unknown, meta: RespondMeta): Record<string, unknown> {
  return { ok: true, result, requestId: meta.requestId, elapsedMs: elapsedMs(meta.startedAt) }
}

export function errorEnvelope(error: unknown, meta: RespondMeta, context: 'chat' | 'answer' = 'chat'): {
  status: number
  body: Record<string, unknown>
} {
  const api = toApiError(error, context)
  const payload: Record<string, unknown> = {
    code: api.code,
    message: api.message,
  }
  if (api.field !== undefined) payload.field = api.field
  if (api.detail !== undefined) payload.detail = api.detail
  return {
    status: api.status,
    body: {
      ok: false,
      error: payload,
      requestId: meta.requestId,
      elapsedMs: elapsedMs(meta.startedAt),
    },
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown, meta: RespondMeta): number {
  const body = JSON.stringify(payload)
  const length = Buffer.byteLength(body)
  if (!res.headersSent) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(length),
      'Cache-Control': 'no-store',
      'X-Request-Id': meta.requestId,
    })
  }
  res.end(body)
  return length
}

export function sendOk(res: ServerResponse, result: unknown, meta: RespondMeta): number {
  return sendJson(res, 200, okEnvelope(result, meta), meta)
}

export function sendError(
  res: ServerResponse,
  error: unknown,
  meta: RespondMeta,
  context: 'chat' | 'answer' = 'chat',
): { status: number; code: string; bytes: number } {
  const { status, body } = errorEnvelope(error, meta, context)
  const bytes = sendJson(res, status, body, meta)
  const code = (body.error as { code?: string }).code ?? 'INTERNAL'
  return { status, code, bytes }
}

export function assertObject(value: unknown, field = 'params'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'BAD_REQUEST', `${field} 必须是对象。`, field)
  }
  return value as Record<string, unknown>
}
