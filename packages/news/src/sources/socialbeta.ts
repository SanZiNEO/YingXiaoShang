import * as cheerio from 'cheerio'
import { cleanText, htmlToText, normalizeDate } from './html.js'
import { fetchText } from './http.js'
import type { NewsSource, RawArticle, RawListItem } from './types.js'

const BASE = 'https://socialbeta.com/'

// Verified live 2026-10-18 with fetch + cheerio:
// - the homepage exposes detail links as absolute
//   https://socialbeta.com/article/<id> and .../campaign/<id> in both <a href>
//   and hero <li data-href>;
// - article pages use .tit_art / .info_art / .cont_art .content;
// - campaign pages use .tit_cam / .info_cam / .cont_cam .content.
export const socialbeta: NewsSource = {
  id: 'socialbeta',

  async list(signal) {
    const html = await fetchText(BASE, { source: 'socialbeta', signal })
    const $ = cheerio.load(html)
    const entries = new Map<string, RawListItem>()

    const add = (href: string, title: string) => {
      let url: URL
      try {
        url = new URL(href, BASE)
      } catch {
        return
      }
      const match = url.pathname.match(/^\/(article|campaign)\/(\d+)$/)
      if (!match) return
      const sourceId = `${match[1]}-${match[2]}`
      const existing = entries.get(url.toString())
      if (existing) {
        if (!existing.title && title) existing.title = title
        return
      }
      entries.set(url.toString(), {
        sourceId,
        url: url.toString(),
        title: title || undefined,
      })
    }

    $('a[href]').each((_, element) => {
      add($(element).attr('href') ?? '', cleanText($(element).text()))
    })
    $('[data-href]').each((_, element) => {
      add($(element).attr('data-href') ?? '', cleanText($(element).text()))
    })

    return [...entries.values()]
  },

  async fetchDetail(item, signal): Promise<RawArticle> {
    const html = await fetchText(item.url, { source: 'socialbeta', signal })
    const $ = cheerio.load(html)
    const title =
      cleanText($('.tit_art, .tit_cam').first().text()) ||
      cleanText($('title').text()).replace(/｜SocialBeta$/i, '') ||
      item.title ||
      ''
    const info = cleanText($('.info_art, .info_cam').first().text())
    const publishedAt = normalizeDate(info.match(/\d{4}-\d{2}-\d{2}/)?.[0])
    const author =
      $('.info_art a[href*="/user/"], .info_cam a[href*="/user/"]')
        .toArray()
        .map((element) => cleanText($(element).text()))
        .find((value) => value.length > 0) ?? ''
    const contentHtml = $('.cont_art .content, .cont_cam .content').first().html() ?? ''
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
