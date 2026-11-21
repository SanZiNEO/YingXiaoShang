import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Scope } from '@learning-agent/shared'
import { ApiError, toApiError } from '../errors.js'
import { readJson } from '../http/read-json.js'
import { REQUEST_ID_PATTERN } from '../http/request-id.js'
import { SseWriter } from '../http/sse.js'
import { requireStudent } from '../auth/bearer.js'
import { requireSession } from '../ownership.js'
import { withStudent } from '../llm/metered.js'
import type { Services } from '../services.js'
import type { TurnRegistry } from './turns.js'

const MAX_MESSAGE_CHARS = 8000

interface StreamMeta {
  requestId: string
  startedAt: number
}

/**
 * `POST /api/v1/chat/stream`.
 *
 * The event order is the contract (00-master §7.1): `session` first, then
 * `round` / `text` / `tool` / `tool-end`, then a single `done`; failures emit
 * one `error` frame and close without `done`. The abort signal is passed into
 * the agent chain, not just the HTTP socket.
 */
export async function handleChatStream(
  req: IncomingMessage,
  res: ServerResponse,
  services: Services,
  turns: TurnRegistry,
  meta: StreamMeta,
): Promise<void> {
  const student = requireStudent(req, services.auth)
  const body = await readJson(req)

  const candidate = body.requestId
  if (typeof candidate === 'string' && REQUEST_ID_PATTERN.test(candidate)) meta.requestId = candidate

  const rawMessage = body.message
  if (typeof rawMessage !== 'string' || rawMessage.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', '消息不能为空。', 'message')
  }
  const message = rawMessage.trim()
  if ([...message].length > MAX_MESSAGE_CHARS) {
    throw new ApiError(400, 'BAD_REQUEST', `消息最多 ${MAX_MESSAGE_CHARS} 个字符。`, 'message')
  }
  const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim().length > 0
    ? body.sessionId.trim()
    : undefined
  const chapterId = typeof body.chapterId === 'string' && body.chapterId.trim().length > 0
    ? body.chapterId.trim()
    : undefined
  const scopeOverride = body.scopeOverride as Scope | undefined

  // Ownership is checked before `writer.start()`, because a 403 must still be a
  // real HTTP status; once the SSE head is out the status code is frozen at 200
  // and the failure could only be reported as a frame. Same rule and copy as
  // `chat.messages` / `agent.turns` (frozen §3.3).
  if (sessionId !== undefined) requireSession(services.db, sessionId, student.studentId)

  services.metrics.incSseActive()
  const controller = turns.begin(meta.requestId)
  const writer = new SseWriter(res, meta.requestId)
  let resolvedSessionId = sessionId ?? ''
  let firstTokenObserved = false

  const onClose = (): void => {
    // Client went away: really abort the in-flight turn and free the registry
    // entry, otherwise the model request keeps running after the socket dies.
    if (!controller.signal.aborted) controller.abort()
    turns.done(meta.requestId)
    writer.close()
  }
  res.on('close', onClose)

  try {
    writer.start()
    const output = await withStudent(student.studentId, () => services.agent.handleConversation(
      {
        studentId: student.studentId,
        sessionId,
        message,
        scopeOverride,
        chapterId,
      },
      {
        onEvent: (event) => {
          switch (event.type) {
            case 'session':
              if (typeof event.sessionId === 'string' && event.sessionId.length > 0) {
                resolvedSessionId = event.sessionId
              }
              writer.send('session', { requestId: meta.requestId, sessionId: resolvedSessionId })
              break
            case 'round':
              writer.send('round', { requestId: meta.requestId, round: event.round ?? 0 })
              break
            case 'text':
              if (!firstTokenObserved) {
                firstTokenObserved = true
                services.metrics.observeFirstToken((performance.now() - meta.startedAt) / 1000)
              }
              writer.send('text', { requestId: meta.requestId, agent: 'lead', text: event.text ?? '' })
              break
            case 'tool':
              writer.send('tool', { requestId: meta.requestId, tool: event.tool ?? '' })
              break
            case 'tool-end': {
              const payload: Record<string, unknown> = {
                requestId: meta.requestId,
                tool: event.tool ?? '',
                chars: event.chars ?? 0,
              }
              if (typeof event.preview === 'string') payload.preview = event.preview
              if (typeof event.cached === 'boolean') payload.cached = event.cached
              writer.send('tool-end', payload)
              break
            }
          }
        },
        signal: controller.signal,
      },
    ))

    writer.done({
      requestId: meta.requestId,
      turnId: output.turnId,
      sessionId: output.sessionId || resolvedSessionId,
      text: output.text,
      artifacts: output.artifacts,
      citations: output.citations,
      warnings: output.warnings,
      trace: output.trace,
    })
  } catch (error) {
    if (writer.isClosed) return
    // A cancelled turn surfaces as an aborted model stream ("没有返回内容"),
    // which must not be reported as INTERNAL: the client asked for this.
    if (controller.signal.aborted) {
      services.metrics.observeError('CANCELLED')
      writer.error('CANCELLED', '已停止这一轮（你点的停止）。这次没有保存结果，可以重新提问。')
      return
    }
    const api = toApiError(error, 'chat')
    services.metrics.observeError(api.code)
    writer.error(api.code, api.message)
  } finally {
    res.off('close', onClose)
    turns.done(meta.requestId)
    services.metrics.decSseActive()
    writer.close()
  }
}

/**
 * `POST /api/v1/chat/cancel`. Returns whether an in-flight turn was found and
 * aborted; an unknown / already-finished id reports `false` with HTTP 200.
 */
export function handleChatCancel(turns: TurnRegistry, requestId: string): boolean {
  return turns.cancel(requestId)
}
