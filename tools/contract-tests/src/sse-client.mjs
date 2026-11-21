/**
 * SSE 逐帧解析（03-implementation §3.3）—— http 目标用它，channels 用例的断言只看 CollectedStream 形状。
 *
 * 按 WHATWG 帧格式切分：以空行分隔帧，每帧解析 `id:` / `event:` / `data:`（多行 data 按换行拼接）、
 * `:` 开头的注释行心跳直接跳过。**不实现自动重连与 Last-Event-ID 重放**（冻结 §7.1 明确不做）。
 *
 * 收尾规则（冻结 §7.1）：
 * - 收到 `done` 或 `error` 即视为终态；默认（取证模式）继续读到 EOF 或宽限超时，
 *   这样「done 之后还发帧」「error 之后还发 text」这类违约才有证据，而不是被读取端提前掐断后恒真；
 *   `stopAfterTerminal: true` 保留给「只关心终态之前」的调用方；
 * - `done` 只允许出现一次，出现第二次也要如实记录（交给用例的 eventOrder 断言判红）；
 * - 超过 timeoutMs 仍未收到终态 → 抛 StreamTimeout（由用例记 failed，不补帧）。
 */

import { ContractViolation } from './target-interface.mjs'

export const DEFAULT_SSE_TIMEOUT_MS = 60000

/**
 * 终态之后继续取证的最长等待。真实服务端在 done 后立刻关连接，EOF 会先到；
 * 这个上限只用于「服务端不关连接」的场景，避免取证模式把整条用例拖到总超时。
 */
export const DEFAULT_TERMINAL_GRACE_MS = 2000

/** 解析单个帧文本块；注释行与空帧返回 null。 */
export function parseFrame(block) {
  const lines = String(block).split(/\r?\n/)
  const fields = { id: null, event: null, dataLines: [] }
  let isCommentOnly = true
  for (const line of lines) {
    if (line === '') continue
    if (line.startsWith(':')) continue
    isCommentOnly = false
    const colon = line.indexOf(':')
    const name = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (name === 'id') fields.id = Number.parseInt(value, 10)
    else if (name === 'event') fields.event = value
    else if (name === 'data') fields.dataLines.push(value)
    // retry / 其它字段：契约里没有，忽略
  }
  if (isCommentOnly) return null
  const dataText = fields.dataLines.join('\n')
  let data = dataText
  if (dataText.length > 0) {
    try {
      data = JSON.parse(dataText)
    } catch {
      data = dataText
    }
  }
  return { id: Number.isNaN(fields.id) ? null : fields.id, event: fields.event ?? 'message', data, raw: block }
}

/** 流超时：不补帧、不重试，直接让用例变红（03-implementation §6）。 */
export class StreamTimeout extends Error {
  constructor(message) {
    super(message)
    this.name = 'StreamTimeout'
  }
}

/**
 * 读取一个 SSE 响应体，产出 CollectedStream。
 * @param {ReadableStream<Uint8Array>} body fetch 的 response.body
 * @param {{ onFrame?: (ev: object) => void, timeoutMs?: number, stopAfterTerminal?: boolean, terminalGraceMs?: number }} [options]
 *   `stopAfterTerminal` 默认 false（取证模式）：终态之后继续读到 EOF 或 `terminalGraceMs` 宽限耗尽。
 *   只有明确「终态之后不关心」的调用方才传 true——传 true 时 E-070/E-071 的尾部断言会恒真。
 */
export async function readSseStream(body, options = {}) {
  const {
    onFrame,
    timeoutMs = DEFAULT_SSE_TIMEOUT_MS,
    stopAfterTerminal = false,
    terminalGraceMs = DEFAULT_TERMINAL_GRACE_MS,
  } = options
  if (!body || typeof body.getReader !== 'function') {
    throw new ContractViolation('SSE 响应没有可读的 body：Content-Type 必须是 text/event-stream')
  }

  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  const events = []
  const rawFrames = []
  const startedAt = Date.now()
  let firstTokenMs = -1
  let buffer = ''
  let doneCount = 0
  let errorCount = 0
  let closed = false
  let terminalSeen = false
  let terminalAtMs = -1
  let graceTimer = null

  const timer = setTimeout(() => {
    // 主动取消读取：超时后不等待服务端补帧
    reader.cancel().catch(() => {})
  }, timeoutMs)

  /** 终态之后继续收帧的宽限：服务端不关连接时，别把整条用例拖到总超时。 */
  const armGraceTimer = () => {
    if (stopAfterTerminal || graceTimer !== null) return
    graceTimer = setTimeout(() => {
      reader.cancel().catch(() => {})
    }, terminalGraceMs)
  }

  const emit = (frame) => {
    events.push(frame)
    rawFrames.push(frame.raw)
    if (frame.event === 'done') doneCount += 1
    if (frame.event === 'error') errorCount += 1
    if (frame.event === 'text' && firstTokenMs < 0) firstTokenMs = Date.now() - startedAt
    if (!terminalSeen && (frame.event === 'done' || frame.event === 'error')) {
      terminalSeen = true
      terminalAtMs = Date.now() - startedAt
      armGraceTimer()
    }
    onFrame?.(frame)
  }

  const drain = () => {
    let processed = true
    while (processed) {
      processed = false
      const match = buffer.match(/\r?\n\r?\n/)
      if (match) {
        const index = match.index ?? 0
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + match[0].length)
        const frame = parseFrame(block)
        if (frame) {
          emit(frame)
          processed = true
        } else {
          processed = true
        }
        if (stopAfterTerminal && terminalSeen) {
          return true
        }
      }
    }
    return false
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (drain()) {
        closed = true
        reader.cancel().catch(() => {})
        break
      }
    }
    // 流结束时把残留的最后一帧（没有以空行收尾）也解析掉。
    // stopAfterTerminal 模式下残留的正是「终态之后的内容」，按契约不该计入事件序列。
    buffer += decoder.decode()
    if (!(stopAfterTerminal && terminalSeen) && buffer.trim().length > 0) {
      const frame = parseFrame(buffer)
      if (frame) emit(frame)
    }
    closed = true
  } catch (error) {
    // 取消读取会导致 read() 拒绝，这是我们自己的 cancel，不算失败
    closed = true
    if (!(error instanceof TypeError) && error?.name !== 'AbortError') {
      // 其它传输层错误如实抛给用例，由 run.mjs 记 error
      throw new ContractViolation(`SSE 读取中断：${error?.message ?? String(error)}`)
    }
  } finally {
    clearTimeout(timer)
    clearTimeout(graceTimer)
  }

  const sawTerminal = events.some((frame) => frame.event === 'done' || frame.event === 'error')
  if (!sawTerminal) {
    throw new StreamTimeout(`等待 SSE 终态事件超时（${timeoutMs}ms）：未收到 done`)
  }

  return {
    events,
    rawFrames,
    doneCount,
    errorCount,
    firstTokenMs,
    closed,
    /** 终态帧之后收到的帧数（取证模式 > 0 即服务端违约，E-070/E-071 据此判红）。 */
    trailingAfterTerminal: countTrailing(events),
    terminalAtMs,
    forensics: !stopAfterTerminal,
  }
}

/** 终态帧（首个 done/error）之后还有多少帧。 */
function countTrailing(events) {
  const index = events.findIndex((frame) => frame.event === 'done' || frame.event === 'error')
  return index < 0 ? 0 : events.length - index - 1
}

/** 把帧数组渲染成证据文本（report/sse/<case-id>.txt）。 */
export function renderFrames(events) {
  return events
    .map((frame) => {
      const dataText = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data)
      return `id: ${frame.id ?? ''}\nevent: ${frame.event}\ndata: ${dataText}\n`
    })
    .join('\n')
}
