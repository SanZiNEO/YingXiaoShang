import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'
import { cleanText, htmlToText, normalizeDate } from './html.js'
import { fetchText } from './http.js'
import type { NewsSource, RawArticle, RawListItem } from './types.js'

const BASE = 'https://www.brandstar.com.cn/'

interface ArticleLd {
  headline?: string
  datePublished?: string
  author?: { name?: string } | Array<{ name?: string }>
}

function isArticleLd(value: unknown): value is ArticleLd {
  if (!value || typeof value !== 'object' || !('@type' in value)) return false
  const type = value['@type']
  return type === 'Article' || type === 'NewsArticle'
}

function collectJsonLd($: CheerioAPI): unknown[] {
  const nodes: unknown[] = []
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const parsed: unknown = JSON.parse($(element).text())
      if (Array.isArray(parsed)) {
        nodes.push(...parsed)
      } else if (parsed && typeof parsed === 'object') {
        nodes.push(parsed)
        if ('@graph' in parsed) {
          const graph = parsed['@graph']
          if (Array.isArray(graph)) nodes.push(...graph)
        }
      }
    } catch {
      // Malformed structured data is not fatal; fall back to DOM selectors.
    }
  })
  return nodes
}

// Verified live 2026-10-18 with fetch + cheerio:
// - the SSR homepage links /in-depth/<id> and /news/<id>;
// - detail pages use .art-title, .art-sum, .art-body, plus JSON-LD Article
//   nodes carrying datePublished and author.name.
export const brandstar: NewsSource = {
  id: 'brandstar',

  async list(signal) {
    const html = await fetchText(BASE, { source: 'brandstar', signal })
    const $ = cheerio.load(html)
    const entries = new Map<string, RawListItem>()

    const add = (href: string, title: string) => {
      let url: URL
      try {
        url = new URL(href, BASE)
      } catch {
        return
      }
      const match = url.pathname.match(/^\/(in-depth|news)\/(\d+)$/)
      if (!match) return
      const absolute = url.toString()
      const existing = entries.get(absolute)
      if (existing) {
        if (!existing.title && title) existing.title = title
        return
      }
      entries.set(absolute, {
        sourceId: `${match[1]}-${match[2]}`,
        url: absolute,
        title: title || undefined,
      })
    }

    $('a[href]').each((_, element) => {
      add($(element).attr('href') ?? '', cleanText($(element).text()))
    })

    return [...entries.values()]
  },

  async fetchDetail(item, signal): Promise<RawArticle> {
    const html = await fetchText(item.url, { source: 'brandstar', signal })
    const $ = cheerio.load(html)
    const ld = collectJsonLd($).find(isArticleLd)
    const ldAuthor = ld?.author
    const author = (Array.isArray(ldAuthor) ? ldAuthor[0]?.name : ldAuthor?.name)?.trim() ?? ''
    const title =
      cleanText($('.art-title').first().text()) ||
      ld?.headline?.trim() ||
      cleanText($('meta[property="og:title"]').attr('content') ?? '') ||
      item.title ||
      ''
    const contentHtml = $('.art-body').first().html() ?? ''
    const summary =
      cleanText($('.art-sum').first().text()) ||
      cleanText($('meta[name="description"]').attr('content') ?? '') ||
      item.summary ||
      ''

    return {
      sourceId: item.sourceId,
      url: item.url,
      title,
      author,
      publishedAt: normalizeDate(ld?.datePublished),
      summary,
      content: htmlToText(contentHtml),
      contentHtml,
    }
  },
}
