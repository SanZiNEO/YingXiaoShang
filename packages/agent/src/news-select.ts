import type LearningDb from '@learning-agent/db'
import type { KnowledgePoint, NewsArticle } from '@learning-agent/shared'

export interface LocalNewsSelection {
  articles: NewsArticle[]
  fallback: boolean
  matchedTerms: string[]
}

/**
 * Weights are per source field, so a KP's own name outranks a keyword and a
 * keyword outranks an example phrase lifted from the textbook.
 */
const TERM_WEIGHTS: Array<{ field: (kp: KnowledgePoint) => string[]; weight: number }> = [
  { field: (kp) => [kp.name], weight: 5 },
  { field: (kp) => kp.aliases, weight: 3 },
  { field: (kp) => kp.keywords, weight: 2 },
  { field: (kp) => kp.examples, weight: 1 },
]

const MIN_CONTENT_LENGTH = 300
const MAX_ARTICLES = 3

/**
 * Deterministic local retrieval: no network, no model. Ranks the stored news
 * library against the chapter's knowledge-point vocabulary, then falls back to
 * the newest article so a chapter with no keyword hits still gets material to
 * analyse instead of an empty answer.
 */
export function selectRelevantNews(
  db: Pick<LearningDb, 'listKpsByChapter' | 'listAllKps' | 'listNews'>,
  opts: { query: string; chapterId?: string; limit: number },
): LocalNewsSelection {
  const scoped = opts.chapterId ? db.listKpsByChapter(opts.chapterId) : []
  const points = scoped.length > 0 ? scoped : db.listAllKps()

  // Same term reached from several fields keeps its highest weight only, so a
  // name repeated in `aliases` cannot inflate the score.
  const terms = new Map<string, number>()
  for (const entry of TERM_WEIGHTS) {
    for (const point of points) {
      for (const raw of entry.field(point)) {
        const term = raw.trim()
        if (term.length < 2) continue
        if ((terms.get(term) ?? 0) >= entry.weight) continue
        terms.set(term, entry.weight)
      }
    }
  }

  const query = opts.query
  const matchedTerms = [...terms.keys()].filter((term) => query.includes(term))
  const articles = db.listNews({ limit: 500 })
    .filter((article) => article.content.length >= MIN_CONTENT_LENGTH)

  // A term the student typed is worth double, a title hit quadruple, a summary
  // hit double, and a bare body hit single: the score follows how much of the
  // article is actually about the chapter's vocabulary.
  const scored: Array<{ article: NewsArticle; score: number }> = []
  for (const article of articles) {
    const title = article.title
    const summary = article.summary
    const content = article.content
    let score = 0
    for (const [term, weight] of terms) {
      if (query.includes(term)) score += weight * 2
      if (title.includes(term)) score += weight * 4
      if (summary.includes(term)) score += weight * 2
      if (content.includes(term)) score += weight
    }
    if (score > 0) scored.push({ article, score })
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return right.article.published_at.localeCompare(left.article.published_at)
  })

  const limit = Math.min(Math.max(opts.limit, 1), MAX_ARTICLES)
  if (scored.length > 0) {
    return { articles: scored.slice(0, limit).map((entry) => entry.article), fallback: false, matchedTerms }
  }
  const newest = articles[0]
  return {
    articles: newest ? [newest] : [],
    fallback: newest !== undefined,
    matchedTerms,
  }
}
