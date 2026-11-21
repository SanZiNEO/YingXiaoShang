import type { ServerResponse } from 'node:http'

const HEARTBEAT_INTERVAL_MS = 15_000
const IDLE_TIMEOUT_MS = 60_000

/**
 * Server-Sent Event writer.
 *
 * Frame contract (00-master §7.1): `id` increments from 1 on every data frame,
 * the heartbeat is a bare comment line without an id, each frame ends with a
 * blank line, and `done` / `error` can only be emitted once. Chinese text is
 * JSON-encoded verbatim (`ensure_ascii=false`); no manual escaping here.
 */
export class SseWriter {
  private seq = 0
  private closed = false
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly res: ServerResponse,
    private readonly requestId: string,
  ) {}

  /** Sends the 200 response head and starts the keep-alive / idle timers. */
  start(): void {
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    })
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return
      this.res.write(': keep-alive\n\n')
    }, HEARTBEAT_INTERVAL_MS)
    this.resetIdle()
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Emits one named event frame with an incrementing `id`. */
  send(event: string, data: unknown): void {
    if (this.closed) return
    this.seq += 1
    const frame = `id: ${this.seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    this.res.write(frame)
    this.resetIdle()
  }

  /** Terminal `done` frame, then close. No second frame follows. */
  done(payload: unknown): void {
    if (this.closed) return
    this.send('done', payload)
    this.close()
  }

  /** Terminal `error` frame, then close. Never followed by `done`. */
  error(code: string, message: string): void {
    if (this.closed) return
    this.send('error', { requestId: this.requestId, code, message })
    this.close()
  }

  /** Idempotent cleanup: stop timers and end the response. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    if (!this.res.writableEnded) this.res.end()
  }

  private resetIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.close(), IDLE_TIMEOUT_MS)
  }
}
