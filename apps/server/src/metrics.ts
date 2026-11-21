import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'
import { DatabaseSync } from 'node:sqlite'

/** Frozen bucket set from 00-master §9.2 (12 le buckets, plus +Inf). */
export const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 13, 20, 30] as const

/** The single `db` label value: `learning.db` is the only SQLite file the server counts. */
export const SQLITE_BUSY_DB_LABEL = 'learning'

export interface Metrics {
  observeHttp(method: string, route: string, status: number, durationSeconds: number): void
  observeRpc(method: string, code: string, durationSeconds?: number): void
  observeTokens(studentId: string, kind: string, count: number): void
  observeError(code: string): void
  observeLogin(result: 'ok' | 'fail' | 'rate_limited'): void
  observeFirstToken(seconds: number): void
  incSseActive(): void
  decSseActive(): void
  render(): Promise<string>
  contentType: string
}

export function createMetrics(): Metrics {
  const registry = new Registry()
  collectDefaultMetrics({ register: registry })

  const httpRequests = new Counter({
    name: 'yxs_http_requests_total',
    help: 'HTTP requests by method, route and status',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  })
  const httpDuration = new Histogram({
    name: 'yxs_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route'],
    buckets: [...DURATION_BUCKETS],
    registers: [registry],
  })
  const rpcRequests = new Counter({
    name: 'yxs_rpc_requests_total',
    help: 'RPC method calls by method and resulting error code',
    labelNames: ['method', 'code'],
    registers: [registry],
  })
  const rpcDuration = new Histogram({
    name: 'yxs_rpc_duration_seconds',
    help: 'RPC method duration in seconds',
    labelNames: ['method', 'code'],
    buckets: [...DURATION_BUCKETS],
    registers: [registry],
  })
  const tokens = new Counter({
    name: 'yxs_tokens_total',
    help: 'Model tokens consumed, by student and direction',
    labelNames: ['student_id', 'kind'],
    registers: [registry],
  })
  const errors = new Counter({
    name: 'yxs_errors_total',
    help: 'Errors by public error code',
    labelNames: ['code'],
    registers: [registry],
  })
  const sqliteBusy = new Counter({
    name: 'yxs_sqlite_busy_total',
    help: 'SQLite busy/locked failures',
    labelNames: ['db'],
    registers: [registry],
  })
  const sseActive = new Gauge({
    name: 'yxs_sse_active_connections',
    help: 'Open SSE connections',
    registers: [registry],
  })
  const firstToken = new Histogram({
    name: 'yxs_sse_first_token_seconds',
    help: 'Time from POST to the first text chunk',
    buckets: [...DURATION_BUCKETS],
    registers: [registry],
  })
  const logins = new Counter({
    name: 'yxs_login_total',
    help: 'Login attempts',
    labelNames: ['result'],
    registers: [registry],
  })
  const startTime = new Gauge({
    name: 'yxs_process_start_time_seconds',
    help: 'Process start time in unix seconds',
    registers: [registry],
  })
  startTime.set(Date.now() / 1000)

  // One label value for both the counter and its zero pre-initialisation: two
  // different `db` values rendered the same metric as two series, so a PromQL
  // `increase(...)` split the real count away from the seeded zero.
  installSqliteBusyCounter(() => sqliteBusy.inc({ db: SQLITE_BUSY_DB_LABEL }))
  // Pre-initialise the zero series so the contract's metric list is visible on a
  // freshly started process, not only after the first busy/error event.
  sqliteBusy.inc({ db: SQLITE_BUSY_DB_LABEL }, 0)

  return {
    contentType: registry.contentType,
    observeHttp(method, route, status, durationSeconds) {
      const statusText = String(status)
      httpRequests.inc({ method, route, status: statusText })
      httpDuration.observe({ method, route }, durationSeconds)
    },
    observeRpc(method, code, durationSeconds) {
      rpcRequests.inc({ method, code })
      if (typeof durationSeconds === 'number') rpcDuration.observe({ method, code }, durationSeconds)
    },
    observeTokens(studentId, kind, count) {
      if (count <= 0) return
      tokens.inc({ student_id: studentId || 'anonymous', kind }, count)
    },
    observeError(code) {
      errors.inc({ code })
    },
    observeLogin(result) {
      logins.inc({ result })
    },
    observeFirstToken(seconds) {
      firstToken.observe(seconds)
    },
    incSseActive() {
      sseActive.inc()
    },
    decSseActive() {
      sseActive.dec()
    },
    render() {
      return registry.metrics()
    },
  }
}

const PATCHED = Symbol.for('yxs.sqlite.busy.patched')

/**
 * node:sqlite does not expose error hooks. Wrapping the two entry points is the
 * only way to count SQLITE_BUSY without forking a second database layer.
 */
function installSqliteBusyCounter(onBusy: () => void): void {
  const target = globalThis as unknown as Record<symbol, boolean>
  if (target[PATCHED]) return
  target[PATCHED] = true

  const proto = DatabaseSync.prototype as unknown as Record<string, (...args: unknown[]) => unknown>
  const originalExec = proto.exec as (...args: unknown[]) => unknown
  const originalPrepare = proto.prepare as (...args: unknown[]) => unknown

  const isBusy = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error)
    return /database is locked|SQLITE_BUSY/i.test(message)
  }

  proto.exec = function patchedExec(this: unknown, ...args: unknown[]) {
    try {
      return originalExec.apply(this, args)
    } catch (error) {
      if (isBusy(error)) onBusy()
      throw error
    }
  }

  proto.prepare = function patchedPrepare(this: unknown, ...args: unknown[]) {
    const statement = originalPrepare.apply(this, args)
    if (typeof statement !== 'object' || statement === null) return statement
    return new Proxy(statement, {
      get(object, property, receiver) {
        const value = Reflect.get(object, property, receiver)
        if (typeof value !== 'function') return value
        const name = String(property)
        if (name !== 'run' && name !== 'get' && name !== 'all' && name !== 'iterate') return value
        return (...callArgs: unknown[]) => {
          try {
            return value.apply(object, callArgs)
          } catch (error) {
            if (isBusy(error)) onBusy()
            throw error
          }
        }
      },
    })
  }
}
