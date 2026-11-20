import type { IncomingMessage } from 'node:http'
import { ApiError } from '../errors.js'

export const MAX_BODY_BYTES = 1024 * 1024
/** Frozen product copy for the 413 case. */
export const TOO_LARGE_MESSAGE = '这次提交的内容太大了（上限 1 MB），分几次发。'

/**
 * Reads a JSON object body. Content-Type must be JSON; bodies over 1 MiB are
 * rejected with 413. Empty or malformed bodies are 400, not "empty params".
 */
export async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const type = String(req.headers['content-type'] ?? '')
  if (type.length > 0 && !type.toLowerCase().startsWith('application/json')) {
    throw new ApiError(400, 'BAD_REQUEST', '请求体不是合法 JSON。')
  }
  const declared = Number(req.headers['content-length'] ?? '0')
  if (Number.isFinite(declared) && declared > limit) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', TOO_LARGE_MESSAGE)
  }
  const chunks: Buffer[] = []
  let total = 0
  let tooLarge = false
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.length
    if (total > limit) {
      tooLarge = true
      continue
    }
    chunks.push(buffer)
  }
  if (tooLarge) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', TOO_LARGE_MESSAGE)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', '请求体不是合法 JSON。')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ApiError(400, 'BAD_REQUEST', '请求体不是合法 JSON。')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, 'BAD_REQUEST', '请求体必须是 JSON 对象。')
  }
  return parsed as Record<string, unknown>
}
