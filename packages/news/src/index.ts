import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import * as cheerio from 'cheerio'
import type {} from '@learning-agent/db'
import type {} from '@learning-agent/matcher'
import type { CaseMatch, IdeologyMatch, NewsArticle } from '@learning-agent/shared'
import { stableId } from '@learning-agent/shared'
import pLimit from 'p-limit'
import { normalizeArticle } from './normalize.js'
import { fetchText } from './sources/http.js'
import { cleanText, htmlToText, normalizeDate } from './sources/html.js'
import { NEWS_SOURCES, type NewsSource } from './sources/index.js'
import type { RawArticle } from './sources/types.js'

export interface Config {
  refreshMinutes?: number
  autoRefresh?: boolean
  /** Read lazily so the desktop can use the current settings without recreating the service. */
  apiKey?: () => string
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

export interface RefreshStats {
  source: string
  fetched: number
  inserted: number
  skipped: number
  errors: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    news: NewsService
  }
}

const MAX_ITEMS_PER_SOURCE = 30
const STALE_AFTER_MS = 30 * 60 * 1000

export class NewsService extends Service {
  static inject = ['learningDb']
  private refreshing: Promise<RefreshStats[]> | undefined

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'news')
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

  private apiKey(): string {
    return this.config.apiKey?.()?.trim()
      || process.env.DEEPSEEK_API_KEY?.trim()
      || ''
  }

  /**
   * DeepSeek Search API. Results are not persisted here; `searchAndIngest` does that.
   */
  async webSearch(query: string, count = 5): Promise<WebSearchItem[]> {
    const key = this.apiKey()
    if (!key) throw new Error('DEEPSEEK_API_KEY is not configured')
    const response = await fetch('https://api.deepseek.com/v1/tools/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query: query.slice(0, 128),
        count: Math.min(20, Math.max(1, Math.trunc(count))),
        ori_question: query.slice(0, 128),
        need_content: true,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      throw new Error(`DeepSeek Search ${response.status}: ${(await response.text()).slice(0, 300)}`)
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
  }

  private async deepSeekFetch(url: string): Promise<{ title: string; content: string } | undefined> {
    const key = this.apiKey()
    if (!key) return undefined
    const response = await fetch('https://api.deepseek.com/v1/tools/fetch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) return undefined
    const payload = await response.json() as { title?: string; content?: string }
    return { title: payload.title ?? '', content: payload.content ?? '' }
  }

  private async crawlHtml(url: string): Promise<RawArticle> {
    const html = await fetchText(url, { source: 'web' })
    const $ = cheerio.load(html)
    const title = cleanText($('meta[property="og:title"]').attr('content') ?? '')
      || cleanText($('h1').first().text())
      || cleanText($('title').text())
    const summary = cleanText($('meta[name="description"]').attr('content') ?? '')
      || cleanText($('meta[property="og:description"]').attr('content') ?? '')
    const publishedAt = normalizeDate(
      $('meta[property="article:published_time"]').attr('content')
      ?? $('meta[name="publishdate"]').attr('content')
      ?? $('time').first().attr('datetime'),
    )
    const author = cleanText($('meta[name="author"]').attr('content') ?? '')
    const contentHtml = $('article').first().html()
      ?? $('main').first().html()
      ?? $('body').html()
      ?? ''
    return {
      sourceId: stableId('u', url),
      url,
      title,
      author,
      publishedAt,
      summary,
      content: htmlToText(contentHtml),
      contentHtml,
    }
  }

  /** Fetch one arbitrary URL and persist it as a `web` news article. */
  async crawlAndIngest(url: string): Promise<NewsArticle> {
    const page = await this.deepSeekFetch(url).catch(() => undefined)
    const raw = page && page.content.trim().length >= 300
      ? {
          sourceId: stableId('u', url),
          url,
          title: page.title || url,
          content: page.content,
        }
      : await this.crawlHtml(url)
    const normalized = normalizeArticle('web', raw)
    if (!normalized.ok) throw new Error(normalized.reason)
    this.ctx.learningDb.upsertNews([normalized.article])
    return normalized.article
  }

  /** Search the web, fetch content when needed, and persist usable results. */
  async searchAndIngest(query: string, count = 5): Promise<SearchIngestResult> {
    const results = await this.webSearch(query, count)
    const articles: NewsArticle[] = []
    const errors: string[] = []
    for (const result of results) {
      try {
        let content = result.content.trim()
        if (content.length < 300) {
          const page = await this.deepSeekFetch(result.url).catch(() => undefined)
          content = page?.content?.trim() ?? content
        }
        if (content.length < 300) {
          const raw = await this.crawlHtml(result.url)
          content = raw.content
        }
        const normalized = normalizeArticle('web', {
          sourceId: stableId('u', result.url),
          url: result.url,
          title: result.title,
          summary: result.summary || result.snippet,
          publishedAt: result.date,
          content,
        })
        if (!normalized.ok) {
          errors.push(`${result.url}: ${normalized.reason}`)
          continue
        }
        articles.push(normalized.article)
      } catch (error) {
        errors.push(`${result.url}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (articles.length > 0) {
      this.ctx.learningDb.upsertNews(articles)
      await this.tagArticles(articles)
    }
    return { query, results, articles, errors }
  }

  async refresh(sourceIds?: string[]): Promise<RefreshStats[]> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.runRefresh(sourceIds).finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  async ensureFresh(): Promise<void> {
    const newest = this.ctx.learningDb.newestNewsFetchedAt()
    if (newest) {
      const age = Date.now() - new Date(newest).getTime()
      if (Number.isFinite(age) && age < STALE_AFTER_MS) return
    }
    try {
      await this.refresh()
    } catch (error) {
      this.warn(error, 'news refresh failed')
    }
  }

  private warn(error: unknown, message: string): void {
    const logger = (this.ctx as unknown as {
      logger?: (name: string) => { warn: (...args: unknown[]) => void }
    }).logger
    if (logger) logger('learning-news').warn(error, message)
    else console.warn(`[learning-news] ${message}`, error)
  }

  /**
   * Tag freshly ingested articles so a search result is analysable without waiting
   * for the periodic backfill. Deterministic only, so it needs no API key; a missing
   * matcher is not fatal because the backfill covers the article later.
   */
  private async tagArticles(articles: NewsArticle[]): Promise<void> {
    const matcher = this.ctx.get('matcher')
    if (!matcher) return
    for (const article of articles) {
      try {
        await matcher.candidates(article.id, { topK: 3 })
      } catch (error) {
        this.warn(error, `tag failed: ${article.id}`)
      }
    }
  }

  private async runRefresh(sourceIds?: string[]): Promise<RefreshStats[]> {
    const selected = sourceIds && sourceIds.length > 0
      ? NEWS_SOURCES.filter((source) => sourceIds.includes(source.id))
      : NEWS_SOURCES
    const seenUrls = new Set<string>()
    const results: RefreshStats[] = []
    for (const source of selected) {
      results.push(await this.ingestSource(source, seenUrls))
    }
    return results
  }

  private async ingestSource(source: NewsSource, seenUrls: Set<string>): Promise<RefreshStats> {
    const db = this.ctx.learningDb
    const runId = db.startIngestRun(source.id)
    const stats: RefreshStats = { source: source.id, fetched: 0, inserted: 0, skipped: 0, errors: 0 }
    try {
      const items = (await source.list()).slice(0, MAX_ITEMS_PER_SOURCE)
      stats.fetched = items.length
      const limit = pLimit(2)
      const articles = await Promise.all(
        items.map((item) =>
          limit(async () => {
            try {
              const raw = await source.fetchDetail(item)
              const normalized = normalizeArticle(source.id, raw)
              if (!normalized.ok) {
                stats.skipped += 1
                return undefined
              }
              if (seenUrls.has(normalized.article.url)) {
                stats.skipped += 1
                return undefined
              }
              seenUrls.add(normalized.article.url)
              return normalized.article
            } catch (error) {
              stats.errors += 1
              this.warn(error, `detail failed: ${item.url}`)
              return undefined
            }
          }),
        ),
      )
      const fresh = articles.filter((article): article is NewsArticle => article !== undefined)
      if (fresh.length > 0) stats.inserted = db.upsertNews(fresh)
      db.finishIngestRun(runId, stats.errors > 0 ? 'partial' : 'ok', stats)
    } catch (error) {
      stats.errors += 1
      db.finishIngestRun(runId, 'partial', stats)
      this.warn(error, `list failed: ${source.id}`)
    }
    return stats
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

  const minutes = Math.max(config.refreshMinutes ?? 30, 1)
  if (config.autoRefresh !== false) {
    const timer = setInterval(() => {
      void news.ensureFresh()
    }, minutes * 60 * 1000)
    ctx.effect(() => () => clearInterval(timer), 'learning-news.scheduler')
    void news.ensureFresh()
  }

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
      description: '用 DeepSeek Search 搜索网页，并把可用结果抓取入库。用于学生报新闻、找案例、补充最新事实。',
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
      description: '抓取一个指定 URL 的网页正文，并作为新闻入库。适合学生直接报一条新闻链接。',
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
      async execute(args) {
        const article = await news.crawlAndIngest(args.url)
        return { articleId: article.id, title: article.title, url: article.url }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'refresh_news',
      description: '立即刷新新闻源。可只刷新指定来源；网络失败时保留旧数据。',
      parameters: {
        sources: { type: 'array', items: { type: 'string' } },
      },
      output: jsonOutput({
        type: 'object',
        additionalProperties: false,
        properties: {
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      }),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const results = (await news.refresh(args.sources)).map((item) => ({
          source: item.source,
          fetched: item.fetched,
          inserted: item.inserted,
          skipped: item.skipped,
          errors: item.errors,
        }))
        return { results }
      },
    }),
  )
}
