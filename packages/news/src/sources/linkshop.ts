import * as cheerio from 'cheerio'
import { cleanText, htmlToText, normalizeDate } from './html.js'
import { fetchText } from './http.js'
import type { NewsSource, RawArticle, RawListItem } from './types.js'

const BASE = 'http://www.linkshop.com/news/'

// Selectors: /news/ is GB2312 (decoded as GBK) and lists /news/<id>.shtml
// detail links; detail pages use article.page header h1, .info .author,
// .info .time, and the first article.page > section as the body.
export const linkshop: NewsSource = {
  id: 'linkshop',

  async list(signal) {
    const html = await fetchText(BASE, { source: 'linkshop', signal })
    const $ = cheerio.load(html)
    const entries = new Map<string, RawListItem>()

    $('a[href]').each((_, element) => {
      const href = $(element).attr('href') ?? ''
      let url: URL
      try {
        url = new URL(href, BASE)
      } catch {
        return
      }
      const match = url.pathname.match(/^\/news\/(\d+)\.shtml$/)
      if (!match) return
      const absolute = url.toString()
      if (entries.has(absolute)) return
      entries.set(absolute, {
        sourceId: match[1]!,
        url: absolute,
        title: cleanText($(element).text()) || undefined,
      })
    })

    return [...entries.values()]
  },

  async fetchDetail(item, signal): Promise<RawArticle> {
    const html = await fetchText(item.url, { source: 'linkshop', signal })
    const $ = cheerio.load(html)
    const title =
      cleanText($('article.page header h1').first().text()) ||
      cleanText($('meta[property="og:title"]').attr('content') ?? '') ||
      item.title ||
      ''
    const author = cleanText($('.info .author').first().text())
    const publishedAt = normalizeDate(cleanText($('.info .time').first().text()))
    const contentElement = $('article.page > section').first()
    const contentHtml = contentElement.html() ?? ''
    const summary = cleanText($('meta[name="description"]').attr('content') ?? '') || item.summary || ''

    return {
      sourceId: item.sourceId,
      url: item.url,
      title,
      author,
      publishedAt,
      summary,
      content: htmlToText(contentHtml),
      contentHtml,
    }
  },
}
