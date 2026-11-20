import { ApiError } from '../errors.js'

/** Frozen §2: RPC default 10s, `news.refresh` 30s, `artifacts.export` 20s. */
export const RPC_DEFAULT_TIMEOUT_MS = 10_000
export const RPC_TIMEOUTS: Readonly<Record<string, number>> = {
  'news.refresh': 30_000,
  'artifacts.export': 20_000,
}

/** Frozen §4.2 `TIMEOUT` copy — product text, not a log line. */
export const TIMEOUT_MESSAGE = '这一步等太久了，已经停下，可以直接重试。'

export function timeoutFor(method: string): number {
  return RPC_TIMEOUTS[method] ?? RPC_DEFAULT_TIMEOUT_MS
}

/**
 * Bounds one RPC call.
 *
 * A bare `Promise.race` would only stop the HTTP response while the model or
 * the crawler kept running, so the controller is aborted on the deadline and
 * its signal is handed to the handler: `news.refresh` / `news.match` forward it
 * to `fetch` and to the matcher's model call, which is what actually stops the
 * work. The late rejection of an abandoned handler is swallowed so it cannot
 * surface as an unhandled rejection after the response has been sent.
 */
export async function runWithTimeout<T>(
  timeoutMs: number,
  controller: AbortController,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const work = run(controller.signal)
  work.catch(() => {})

  // `Promise.withResolvers` would read better but needs `lib: es2024`; this
  // workspace compiles against ES2023 (tsconfig.base.json).
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new ApiError(504, 'TIMEOUT', TIMEOUT_MESSAGE)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })

  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}
