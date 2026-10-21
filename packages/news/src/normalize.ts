import { NewsArticleSchema } from '@learning-agent/shared'
import type { NewsArticle } from '@learning-agent/shared'
import { canonicalUrl } from './sources/html.js'
import type { RawArticle } from './sources/types.js'

export type NormalizeResult =
  | { ok: true; article: NewsArticle }
  | { ok: false; reason: string }

/**
 * Apply the shared news contract. Articles shorter than 300 characters are
 * rejected instead of being written as `unavailable` rows.
 */
export function normalizeArticle(source: string, raw: RawArticle): NormalizeResult {
  const content = raw.content.trim()
  if (content.length < 300) return { ok: false, reason: `content too short (${content.length} chars)` }
  const title = raw.title.trim()
  if (!title) return { ok: false, reason: 'missing title' }
  const sourceId = raw.sourceId.trim()
  if (!sourceId) return { ok: false, reason: 'missing source id' }
  const url = canonicalUrl(raw.url.trim())
  if (!url) return { ok: false, reason: 'missing url' }

  const parsed = NewsArticleSchema.safeParse({
    id: `${source}-${sourceId}`,
    source,
    source_id: sourceId,
    title,
    url,
    author: raw.author?.trim() ?? '',
    published_at: raw.publishedAt?.trim() ?? '',
    summary: raw.summary?.trim() ?? '',
    content,
    content_status: content.length >= 1_000 ? 'full' : 'partial',
    rights: 'internal-research; source-link',
    fetched_at: new Date().toISOString(),
  })
  if (!parsed.success) return { ok: false, reason: parsed.error.message }
  return { ok: true, article: parsed.data }
}
