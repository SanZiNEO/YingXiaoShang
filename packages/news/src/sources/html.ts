import * as cheerio from 'cheerio'

/** Collapse extraction noise while keeping paragraph boundaries. */
export function cleanText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Convert an HTML fragment to plain text. `br` and block elements become
 * newlines so downstream evidence spans keep readable paragraph boundaries.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return ''
  const $ = cheerio.load(html)
  $('script, style, noscript, iframe, svg, form').remove()
  $('br').replaceWith('\n')
  $('p, h1, h2, h3, h4, h5, h6, li, blockquote, div, section, article').each((_, node) => {
    $(node).append('\n')
  })
  return cleanText($.root().text())
}

/**
 * Accept the date formats used by the four sources. Missing values stay empty
 * rather than being invented.
 */
export function normalizeDate(value: string | undefined | null): string {
  const raw = value?.trim()
  if (!raw) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00+08:00`
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(raw)) return `${raw.replace(' ', 'T')}+08:00`
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? raw : date.toISOString()
}

/** Remove tracking query strings while preserving the canonical article path. */
export function canonicalUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return value
  }
}


