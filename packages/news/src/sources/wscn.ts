import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { canonicalUrl, htmlToText, normalizeDate } from './html.js'
import { fetchJson } from './http.js'
import type { NewsSource, RawArticle, RawListItem } from './types.js'

const API_BASE = 'https://api-one-wscn.awtmt.com/apiv1/content/articles'

interface SeedArticle {
  article_id?: string | number
  title?: string
  url?: string
  published_at?: string
  author?: string
  summary?: string
  content?: string
  content_html?: string
}

interface SeedFile {
  articles?: SeedArticle[]
}

interface WscnResponse {
  code?: number
  message?: string
  data?: {
    id?: number
    title?: string
    content?: string
    content_short?: string
    display_time?: number
    author?: { display_name?: string }
  }
}

function resolveSeedPath(): string {
  const candidates = [
    resolve(process.cwd(), 'data/marketing_news/wscn/normalized/news_articles_all_tagged.json'),
    resolve(process.cwd(), 'data/legacy/marketing_news/wscn/normalized/news_articles_all_tagged.json'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`WSCN seed file not found; looked in: ${candidates.join(', ')}`)
}

// Detail endpoint returns {code: 20000, data: {content, content_short,
// display_time, author, ...}}; display_time is Unix seconds. The seed file supplies
// list entries and the fallback payload when the API is unavailable or paywalled.
export const wscn: NewsSource = {
  id: 'wscn',

  async list(signal) {
    signal?.throwIfAborted()
    const seed = JSON.parse(readFileSync(resolveSeedPath(), 'utf8')) as SeedFile
    const items: RawListItem[] = []
    const seen = new Set<string>()

    for (const article of seed.articles ?? []) {
      const rawUrl = article.url?.trim() ?? ''
      const sourceId =
        String(article.article_id ?? '').replace(/^wscn-/, '') ||
        rawUrl.match(/\/articles\/(\d+)/)?.[1] ||
        ''
      if (!sourceId || !rawUrl) continue
      const url = canonicalUrl(rawUrl)
      if (seen.has(url)) continue
      seen.add(url)

      const seedContent = article.content?.trim() || htmlToText(article.content_html)
      const fallback: RawArticle = {
        sourceId,
        url,
        title: article.title?.trim() ?? '',
        author: article.author?.trim() ?? '',
        publishedAt: normalizeDate(article.published_at),
        summary: article.summary?.trim() ?? '',
        content: seedContent,
        contentHtml: article.content_html ?? article.content ?? '',
      }
      items.push({
        sourceId,
        url,
        title: fallback.title,
        author: fallback.author,
        publishedAt: fallback.publishedAt,
        summary: fallback.summary,
        fallback,
      })
    }

    return items
  },

  async fetchDetail(item, signal): Promise<RawArticle> {
    const fallback = item.fallback
    try {
      const response = await fetchJson<WscnResponse>(
        `${API_BASE}/${encodeURIComponent(item.sourceId)}?extract=0&accept_theme=theme,premium-theme&remove_disclaimer=1`,
        { source: 'wscn', signal },
      )
      if (response.code !== 20000 || !response.data) {
        throw new Error(`WSCN API code ${response.code ?? 'unknown'}: ${response.message ?? 'no data'}`)
      }
      const data = response.data
      const apiHtml = data.content ?? ''
      const apiContent = htmlToText(apiHtml)
      const useApi = apiContent.length >= 300
      const displayTime = data.display_time
      const publishedAt =
        typeof displayTime === 'number' && Number.isFinite(displayTime)
          ? new Date(displayTime > 1e12 ? displayTime : displayTime * 1_000).toISOString()
          : fallback?.publishedAt || item.publishedAt || ''

      return {
        sourceId: item.sourceId,
        url: item.url,
        title: data.title?.trim() || fallback?.title || item.title || '',
        author: data.author?.display_name?.trim() || fallback?.author || item.author || '',
        publishedAt,
        summary: data.content_short?.trim() || fallback?.summary || item.summary || '',
        content: useApi ? apiContent : fallback?.content ?? apiContent,
        contentHtml: useApi ? apiHtml : fallback?.contentHtml ?? apiHtml,
      }
    } catch (error) {
      if (signal?.aborted) throw error
      if (!fallback) throw error
      const reason = error instanceof Error ? error.message : String(error)
      console.warn(`[wscn] API failed for ${item.sourceId}; using seed content (${reason})`)
      return fallback
    }
  },
}
