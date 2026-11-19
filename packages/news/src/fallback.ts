import type { NewsArticle } from '@learning-agent/shared'
import { stableId } from '@learning-agent/shared'

/**
 * 桌面端的联网兜底：Python 采集服务不可用时，直接用 DeepSeek 搜索 API。
 *
 * 为什么需要它：桌面交付包是「解压双击即用」，学生机器上不会有 Python 与
 * `.venv`（`apps/desktop/electron-builder.yml` 只打包 `out/**`、`templates/**`、
 * 种子库与提示词）。没有这条兜底，学生查一条本地没有的新闻就会看到
 * 「联网补抓失败」——而这条路径恰恰是学生最常感知的。
 *
 * 这条路径刻意**不爬网页**：搜索 API 自带正文，实测 0.3–0.5 秒返回；
 * 爬网页是 30 秒/篇 + 每秒限流，正是当初「查一条新闻卡三分钟」的元凶。
 */

export interface WebSearchItemLike {
  title: string
  url: string
  snippet: string
  summary: string
  content: string
  siteName: string
  date: string
  authority: number
  rerankScore: number
}

/** 正文门槛：低于这个长度的条目只作为线索返回，不入库。 */
export const FALLBACK_MIN_CONTENT = 300
const FALLBACK_TIMEOUT_MS = 15_000

export function fallbackApiKey(read?: () => string): string {
  return (read?.() ?? '').trim() || process.env.DEEPSEEK_API_KEY?.trim() || ''
}

/**
 * 后端「不可用」与「后端报错」要分开：
 * 只有连不上/超时才值得退回 API；后端明确返回 4xx/5xx 说明服务在，不该绕过它。
 */
export function isBackendUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error)
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|timed out|socket hang up|connect ECONN/i.test(message)
}

export async function deepSeekSearch(
  apiKey: string,
  query: string,
  count: number,
  signal?: AbortSignal,
): Promise<WebSearchItemLike[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FALLBACK_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch('https://api.deepseek.com/v1/tools/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        query: query.slice(0, 128),
        count: Math.min(20, Math.max(1, Math.trunc(count))),
        ori_question: query.slice(0, 128),
        need_content: true,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`DeepSeek Search ${response.status}: ${(await response.text()).slice(0, 200)}`)
    }
    const payload = await response.json() as {
      results?: Array<{
        rerank_score?: number
        title?: string
        url?: string
        snippet?: string
        summary?: string
        content?: string
        site_name?: string | null
        date?: string | null
        authority?: number
      }>
    }
    return (payload.results ?? []).map((item) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: item.snippet ?? '',
      summary: item.summary ?? '',
      content: item.content ?? '',
      siteName: item.site_name ?? '',
      date: item.date ?? '',
      authority: typeof item.authority === 'number' ? item.authority : -1,
      rerankScore: typeof item.rerank_score === 'number' ? item.rerank_score : 0,
    }))
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error(`联网检索超过 ${Math.round(FALLBACK_TIMEOUT_MS / 1000)} 秒，已放弃`)
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 搜索命中 → 可入库的新闻条目。正文太短的不要，宁缺毋滥。 */
export function toFallbackArticle(item: WebSearchItemLike): NewsArticle | undefined {
  const content = item.content.trim()
  if (content.length < FALLBACK_MIN_CONTENT) return undefined
  const url = item.url.trim()
  if (url.length === 0) return undefined
  return {
    id: stableId('web', url),
    source: item.siteName.trim() || 'web',
    source_id: url,
    title: item.title.trim(),
    url,
    author: '',
    published_at: item.date,
    summary: (item.summary || item.snippet).trim().slice(0, 400),
    content,
    content_status: content.length >= 1000 ? 'full' : 'partial',
    rights: 'internal-research; source-link',
    fetched_at: new Date().toISOString(),
  }
}

/**
 * 一次完整的兜底检索：搜索 → 过滤 → 入库 → 返回候选。
 * 与 Python 服务的结果形状保持一致，上层工具不需要知道走的是哪条路。
 */
export async function searchFallback(input: {
  apiKey: string
  query: string
  count: number
  signal?: AbortSignal
}): Promise<{ results: WebSearchItemLike[]; articles: NewsArticle[]; errors: string[] }> {
  // 没 key 就别发请求：否则学生看到的是 401，而不是「去设置里填 Key」。
  if (input.apiKey.trim().length === 0) {
    throw new Error('没有配置模型密钥（DEEPSEEK_API_KEY），无法联网检索')
  }
  const results = await deepSeekSearch(input.apiKey, input.query, input.count, input.signal)
  const articles: NewsArticle[] = []
  const errors: string[] = []
  for (const item of results) {
    const article = toFallbackArticle(item)
    if (!article) {
      errors.push(`${item.title || item.url}: 正文太短（${item.content.trim().length} 字），只作线索未入库`)
      continue
    }
    articles.push(article)
  }
  return { results, articles, errors }
}
