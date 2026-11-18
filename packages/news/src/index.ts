import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@learning-agent/db'
import type { CaseMatch, IdeologyMatch, NewsArticle } from '@learning-agent/shared'

/**
 * The TypeScript package is deliberately only a client for the Python
 * collection service. Source adapters, HTML parsing and the ingest loop live in
 * `services/news-crawler-py`; this package owns the app-facing contract.
 */

export interface Config {
  /** Base URL of the Python control plane. Defaults to NEWS_CRAWLER_URL or :8787. */
  baseUrl?: string
  /** Query facade budget; the backend itself has a 3 second hard deadline. */
  queryTimeoutMs?: number
  /** Manual refresh request budget; refreshes are normally fire-and-forget. */
  refreshTimeoutMs?: number
  /** @deprecated The Python service owns scheduling and API credentials. */
  apiKey?: () => string
  /** @deprecated Scheduling is owned by the Python service. */
  autoRefresh?: boolean
}

export interface WebSearchItem {
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

export interface SearchIngestResult {
  query: string
  results: WebSearchItem[]
  articles: NewsArticle[]
  errors: string[]
}

export type SourceRunStatus = 'success' | 'empty' | 'partial_failure' | 'failure'
export type SourceFailureStage = 'list' | 'detail' | 'normalize' | 'db'

export interface SourceFailure {
  stage: SourceFailureStage
  url?: string
  message: string
}

export interface SourceRunResult {
  source: string
  status: SourceRunStatus
  fetched: number
  inserted: number
  updated?: number
  skipped: number
  errors: number
  failures: SourceFailure[]
  startedAt: number
  durationMs: number
}

/** Backwards-compatible name used by callers and the desktop IPC. */
export type RefreshStats = SourceRunResult

export interface RefreshOptions {
  signal?: AbortSignal
  /**
   * When false (the default), the backend starts the round and returns
   * immediately. A manual refresh of every source can take longer than an HTTP
   * request should block, while the scheduled service keeps collecting.
   */
  wait?: boolean
}

export interface RefreshOutcome {
  results: RefreshStats[]
  queued: boolean
  accepted: string[]
}

interface QueryItem {
  id: string
  source: string
  sourceName?: string
  title: string
  url: string
  publishedAt?: string
  summary?: string
  content?: string
  contentStatus?: string
}

interface QueryResponse {
  ok?: boolean
  items?: QueryItem[]
  meta?: {
    degraded?: boolean
    reason?: string
    elapsedMs?: number
    dbHits?: number
    crawledHits?: number
    sourcesUsed?: string[]
  }
  error?: string
  message?: string
}

interface RunResponse {
  ok?: boolean
  wait?: boolean
  rounds?: Array<{
    source?: string
    status?: string
    started_at?: string
    finished_at?: string
    duration_ms?: number
    fetched?: number
    inserted?: number
    updated?: number
    skipped?: number
    errors?: number
    failures?: Array<{ stage?: string; message?: string; url?: string }>
  }>
  accepted?: string[]
  error?: string
  message?: string
}

interface IngestResponse {
  ok?: boolean
  article?: QueryItem & { author?: string }
  error?: string
  message?: string
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787'
const QUERY_TIMEOUT_MS = 5_000
const REFRESH_TIMEOUT_MS = 120_000
const STALE_AFTER_MS = 30 * 60 * 1000

function baseUrl(config: Config): string {
  const value = config.baseUrl || process.env.NEWS_CRAWLER_URL || DEFAULT_BASE_URL
  return value.replace(/\/+$/, '')
}

function failureStage(value: string | undefined): SourceFailureStage {
  return value === 'detail' || value === 'normalize' || value === 'db' ? value : 'list'
}

function runStatus(value: string | undefined): SourceRunStatus {
  return value === 'empty' || value === 'partial_failure' || value === 'failure'
    ? value
    : 'success'
}

function mapRun(round: NonNullable<RunResponse['rounds']>[number]): SourceRunResult {
  const startedAt = round.started_at ? Date.parse(round.started_at) : Date.now()
  return {
    source: round.source ?? 'unknown',
    status: runStatus(round.status),
    fetched: round.fetched ?? 0,
    inserted: round.inserted ?? 0,
    updated: round.updated ?? 0,
    skipped: round.skipped ?? 0,
    errors: round.errors ?? 0,
    failures: (round.failures ?? []).map((failure) => ({
      stage: failureStage(failure.stage),
      url: failure.url,
      message: failure.message ?? '',
    })),
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    durationMs: round.duration_ms ?? 0,
  }
}

function mapItem(item: QueryItem): WebSearchItem {
  const content = item.content ?? ''
  return {
    title: item.title,
    url: item.url,
    snippet: item.summary ?? '',
    summary: item.summary ?? '',
    content,
    siteName: item.sourceName ?? item.source,
    date: item.publishedAt ?? '',
    authority: -1,
    rerankScore: 0,
  }
}

function toNewsArticle(item: QueryItem): NewsArticle {
  return {
    id: item.id,
    source: item.source,
    source_id: item.id,
    title: item.title,
    url: item.url,
    author: '',
    published_at: item.publishedAt ?? '',
    summary: item.summary ?? '',
    content: item.content ?? '',
    content_status: item.contentStatus === 'full' ? 'full' : 'partial',
    rights: 'internal-research; source-link',
    fetched_at: '',
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    news: NewsService
  }
}

export class NewsService extends Service {
  static inject = ['learningDb']
  private readonly base: string
  private readonly queryTimeoutMs: number
  private readonly refreshTimeoutMs: number

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'news')
    this.base = baseUrl(config)
    this.queryTimeoutMs = config.queryTimeoutMs ?? QUERY_TIMEOUT_MS
    this.refreshTimeoutMs = config.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS
  }

  /** The control-plane URL this client is wired to, for diagnostics. */
  get baseUrl(): string {
    return this.base
  }

  list(opts: { source?: string; since?: string; limit?: number } = {}): NewsArticle[] {
    return this.ctx.learningDb.listNews(opts)
  }

  get(articleId: string): {
    article: NewsArticle
    matches: CaseMatch[]
    ideology: IdeologyMatch[]
  } | undefined {
    const article = this.ctx.learningDb.getNews(articleId)
    if (!article) return undefined
    return {
      article,
      matches: this.ctx.learningDb.getMatches(articleId),
      ideology: this.ctx.learningDb.getIdeologyMatches(articleId),
    }
  }

  /**
   * Trigger a collection round. The Python service owns the workers and the
   * per-source schedule; `wait:false` only asks it to enqueue the work.
   */
  async refresh(
    sourceIds?: string[],
    options: RefreshOptions = {},
  ): Promise<RefreshOutcome> {
    const wait = options.wait === true
    const payload = await this.request<RunResponse>(
      '/run',
      {
        method: 'POST',
        body: JSON.stringify({
          sources: sourceIds && sourceIds.length > 0 ? sourceIds : undefined,
          wait,
        }),
      },
      wait ? this.refreshTimeoutMs : 5_000,
      options.signal,
    )
    if (payload.ok === false) throw new Error(payload.message || payload.error || 'news refresh failed')
    return {
      results: (payload.rounds ?? []).map(mapRun),
      queued: !wait,
      accepted: payload.accepted ?? [],
    }
  }

  /**
   * Start a background collection when the local DB is empty or stale. The
   * desktop still calls this periodically, but the Python service also has its
   * own per-source schedule for server deployments.
   */
  async ensureFresh(): Promise<void> {
    const newest = this.ctx.learningDb.newestNewsFetchedAt()
    const age = newest ? Date.now() - Date.parse(newest) : Number.POSITIVE_INFINITY
    if (Number.isFinite(age) && age < STALE_AFTER_MS) return
    await this.refresh(undefined, { wait: false })
  }

  /**
   * AI-facing query: local library first, then a bounded factual crawl inside
   * the Python service. The backend returns within its 3 second budget even
   * when a source is slow or blocked.
   */
  async searchAndIngest(
    query: string,
    count = 5,
    options: { crawl?: boolean; signal?: AbortSignal } = {},
  ): Promise<SearchIngestResult> {
    const limit = Math.max(1, Math.min(100, count))
    const fresh = options.crawl !== false
    const params = new URLSearchParams({
      q: query,
      limit: String(limit),
      fresh: fresh ? 'true' : 'false',
    })
    const payload = await this.request<QueryResponse>(
      `/query?${params.toString()}`,
      { method: 'GET' },
      this.queryTimeoutMs,
      options.signal,
    )
    if (payload.ok === false) throw new Error(payload.message || payload.error || 'news query failed')
    const items = payload.items ?? []
    const errors = payload.meta?.degraded && payload.meta.reason ? [payload.meta.reason] : []
    return {
      query,
      results: items.map(mapItem),
      articles: items.map(toNewsArticle),
      errors,
    }
  }

  /** Fetch exactly one URL through the Python backend and store it. */
  async crawlAndIngest(url: string, options: { signal?: AbortSignal } = {}): Promise<NewsArticle> {
    const payload = await this.request<IngestResponse>(
      '/ingest',
      { method: 'POST', body: JSON.stringify({ url }) },
      60_000,
      options.signal,
    )
    if (payload.ok === false || !payload.article) {
      throw new Error(payload.message || payload.error || 'news URL ingest failed')
    }
    return toNewsArticle(payload.article)
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = (): void => controller.abort()
    externalSignal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(`${this.base}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...init.headers },
        signal: controller.signal,
      })
      const text = await response.text()
      let payload: T
      try {
        payload = (text ? JSON.parse(text) : {}) as T
      } catch {
        throw new Error(`news backend returned non-JSON (${response.status}): ${text.slice(0, 200)}`)
      }
      if (!response.ok) {
        const error = payload as { error?: string; message?: string }
        throw new Error(error.message || error.error || `news backend HTTP ${response.status}`)
      }
      return payload
    } catch (error) {
      if (controller.signal.aborted && !externalSignal?.aborted) {
        throw new Error(`news backend timed out after ${timeoutMs}ms: ${path}`)
      }
      throw error
    } finally {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onAbort)
    }
  }
}

const jsonOutput = <const S extends ValueSchemaSpec>(schema: S) => ({
  schema,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
})

export const name = 'learning-news'
export const inject = ['tools', 'learningDb']

export function apply(ctx: Context, config: Config = {}): void {
  const news = new NewsService(ctx, config)

  ctx.tools.register(
    defineTool({
      name: 'list_news',
      description: '列出已入库的营销新闻，可按来源、时间和数量筛选。',
      parameters: {
        source: { type: 'string' },
        since: { type: 'string' },
        limit: { type: 'integer' },
      },
      output: jsonOutput({
        type: 'object',
        additionalProperties: false,
        properties: {
          articles: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                source: { type: 'string' },
                published_at: { type: 'string' },
                url: { type: 'string' },
                summary: { type: 'string' },
              },
            },
          },
        },
      }),
      async execute(args) {
        const articles = news.list({
          source: args.source,
          since: args.since,
          limit: args.limit ?? 20,
        })
        return {
          articles: articles.map((article) => ({
            id: article.id,
            title: article.title,
            source: article.source,
            published_at: article.published_at,
            url: article.url,
            summary: article.summary,
          })),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'get_news',
      description: '读取一条新闻的原文、知识点匹配和课程思政匹配。',
      parameters: {
        article_id: { type: 'string', required: true },
      },
      output: jsonOutput({
        type: 'object',
        additionalProperties: false,
        properties: {
          article: { type: 'object', additionalProperties: true },
          matches: { type: 'array', items: { type: 'object', additionalProperties: true } },
          ideology: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      }),
      async execute(args) {
        const result = news.get(args.article_id)
        if (!result) throw new Error(`news article not found: ${args.article_id}`)
        return result
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'web_search',
      description:
        '检索 Python 新闻采集后端：先查已入库新闻，不足时在 3 秒预算内对注册源做事实增量采集。用于学生报新闻、找案例、补充最新事实。',
      parameters: {
        query: { type: 'string', required: true },
        count: { type: 'integer' },
      },
      output: jsonOutput({
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          articleIds: { type: 'array', items: { type: 'string' } },
          errors: { type: 'array', items: { type: 'string' } },
        },
      }),
      async execute(args) {
        const result = await news.searchAndIngest(args.query, args.count ?? 5)
        return {
          query: result.query,
          results: result.results.map((item) => ({
            title: item.title,
            url: item.url,
            snippet: item.snippet,
            summary: item.summary,
            siteName: item.siteName,
            date: item.date,
            authority: item.authority,
          })),
          articleIds: result.articles.map((article) => article.id),
          errors: result.errors,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'crawl_url',
      description:
        '把学生给出的一条 URL 交给 Python 采集服务抓取正文并入库。仅支持单篇，不做站内扩散。',
      parameters: {
        url: { type: 'string', required: true },
      },
      output: jsonOutput({
        type: 'object',
        additionalProperties: false,
        properties: {
          articleId: { type: 'string' },
          title: { type: 'string' },
          url: { type: 'string' },
        },
      }),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const article = await news.crawlAndIngest(args.url, { signal: exec.signal })
        return { articleId: article.id, title: article.title, url: article.url }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'refresh_news',
      description:
        '请求 Python 采集服务立即跑一轮新闻源。默认后台执行，不阻塞对话；也可只刷新指定来源。',
      parameters: {
        sources: { type: 'array', items: { type: 'string' } },
        wait: { type: 'boolean' },
      },
      output: jsonOutput({
        type: 'object',
        additionalProperties: false,
        properties: {
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          queued: { type: 'boolean' },
          accepted: { type: 'array', items: { type: 'string' } },
        },
      }),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const outcome = await news.refresh(args.sources, {
          wait: args.wait === true,
          signal: exec.signal,
        })
        return {
          results: outcome.results.map((item) => ({
            source: item.source,
            status: item.status,
            fetched: item.fetched,
            inserted: item.inserted,
            updated: item.updated ?? 0,
            skipped: item.skipped,
            errors: item.errors,
          })),
          queued: outcome.queued,
          accepted: outcome.accepted,
        }
      },
    }),
  )
}
