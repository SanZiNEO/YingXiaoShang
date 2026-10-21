import { setTimeout as sleep } from 'node:timers/promises'
import type { Browser, BrowserType } from 'playwright'

export const USER_AGENT = 'learning-agent/0.1 (course research; contact: teacher@example.com)'

const REQUEST_INTERVAL_MS = 1_000
const REQUEST_TIMEOUT_MS = 30_000

/**
 * Per-source request gate. Sources are polite independently: each source
 * starts at most one request per second, while `p-limit(2)` in the pipeline
 * caps in-flight detail work.
 */
class RateLimiter {
  private lastStart = 0
  private tail: Promise<void> = Promise.resolve()

  async wait(): Promise<void> {
    const run = this.tail.then(async () => {
      const delay = this.lastStart + REQUEST_INTERVAL_MS - Date.now()
      if (delay > 0) await sleep(delay)
      this.lastStart = Date.now()
    })
    this.tail = run.catch(() => {})
    await run
  }
}

const limiters = new Map<string, RateLimiter>()

function limiterFor(source: string): RateLimiter {
  let limiter = limiters.get(source)
  if (!limiter) {
    limiter = new RateLimiter()
    limiters.set(source, limiter)
  }
  return limiter
}

export interface FetchOptions {
  source: string
  signal?: AbortSignal
  headers?: Record<string, string>
  /** Ask the Playwright fallback for `document.body.innerText` instead of HTML. */
  json?: boolean
}

// Cloudflare and 火山引擎 interstitials seen in the wild. Keep the list
// narrow so ordinary article copy cannot trigger a false positive.
const CHALLENGE_MARKERS = [
  'cf-chl',
  'challenge-platform',
  'just a moment...',
  'attention required!',
  'verify-container',
  '访问验证',
  '安全验证',
  '人机验证',
  '请完成验证',
]

function looksChallenged(text: string): boolean {
  const sample = text.slice(0, 6_000).toLowerCase()
  return CHALLENGE_MARKERS.some((marker) => sample.includes(marker))
}

function decodeBody(buffer: Buffer, contentType: string | null): string {
  const headerCharset = contentType?.match(/charset=["']?([\w-]+)/i)?.[1]
  const head = buffer.subarray(0, 4_096).toString('latin1')
  const metaCharset = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]
  const charset = (headerCharset ?? metaCharset)?.toLowerCase()
  if (!charset || charset === 'utf-8' || charset === 'utf8') return buffer.toString('utf8')
  try {
    // Linkshop still serves GB2312; WHATWG labels it as GBK.
    return new TextDecoder(charset === 'gb2312' ? 'gbk' : charset).decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
}

async function fetchOnce(url: string, options: FetchOptions): Promise<string> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const response = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: options.json ? 'application/json, text/plain, */*' : 'text/html, application/xhtml+xml',
      ...options.headers,
    },
    redirect: 'follow',
    signal,
  })
  const text = decodeBody(Buffer.from(await response.arrayBuffer()), response.headers.get('content-type'))
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  if (looksChallenged(text)) throw new Error('challenge page detected')
  return text
}

let browserPromise: Promise<Browser> | undefined
let chromiumPromise: Promise<BrowserType> | undefined

/**
 * Playwright is loaded on demand: the four bundled sources all work over plain
 * `fetch`, so a build without the Playwright package (or without its browsers)
 * must still start and refresh. Only the challenge-retry path needs it.
 */
function loadChromium(): Promise<BrowserType> {
  chromiumPromise ??= import('playwright')
    .then((mod) => mod.chromium)
    .catch((error: unknown) => {
      chromiumPromise = undefined
      throw new Error(
        `Playwright 不可用（直接 fetch 已失败）：${error instanceof Error ? error.message : String(error)}`,
      )
    })
  return chromiumPromise
}

async function playwrightText(url: string, options: FetchOptions): Promise<string> {
  if (!browserPromise) {
    browserPromise = loadChromium().then((chromium) => chromium.launch({ headless: true }))
  }
  const browser = await browserPromise.catch((error: unknown) => {
    browserPromise = undefined
    throw error
  })
  const page = await browser.newPage({ userAgent: USER_AGENT })
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT_MS })
    if (!response) throw new Error('Playwright received no response')
    if (!response.ok()) throw new Error(`HTTP ${response.status()}`)
    const text = options.json
      ? await page.evaluate(() => document.body?.innerText ?? '')
      : await page.content()
    if (looksChallenged(text)) throw new Error('challenge page detected')
    return text
  } finally {
    await page.close().catch(() => {})
  }
}

/**
 * Fetch text with the shared User-Agent and per-source rate limit. A non-200
 * response or a challenge page gets exactly one headless-Chromium retry.
 */
export async function fetchText(url: string, options: FetchOptions): Promise<string> {
  const limiter = limiterFor(options.source)
  await limiter.wait()
  try {
    return await fetchOnce(url, options)
  } catch (error) {
    if (options.signal?.aborted) throw error
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[${options.source}] direct fetch failed (${reason}); retrying with Playwright: ${url}`)
    await limiter.wait()
    try {
      return await playwrightText(url, options)
    } catch (fallbackError) {
      const fallbackReason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      throw new Error(`${url} failed after Playwright retry: ${fallbackReason}`, { cause: error })
    }
  }
}

export async function fetchJson<T>(url: string, options: FetchOptions): Promise<T> {
  return JSON.parse(await fetchText(url, { ...options, json: true })) as T
}
