import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LearningDb from '@learning-agent/db'
import { NEWS_SOURCES } from '../packages/news/src/sources/index.ts'
import type { NewsSource } from '../packages/news/src/sources/types.ts'
import { normalizeArticle } from '../packages/news/src/normalize.ts'
import { NewsArticleSchema } from '@learning-agent/shared'
import type { NewsArticle } from '@learning-agent/shared'
import pLimit from 'p-limit'
import { loadEnv } from './env.ts'

loadEnv()
const APP_HOME = process.env.LEARNING_AGENT_HOME || join(process.cwd(), '.learning-agent')
const OUTPUT_PATH = resolve(process.cwd(), 'data/normalized/news_articles.json')
const MAX_ITEMS_PER_SOURCE = 30

interface SourceStats {
  fetched: number
  inserted: number
  skipped: number
  errors: number
}

interface SourceResult {
  source: string
  stats: SourceStats
  articles: NewsArticle[]
}

function readExistingArticles(): NewsArticle[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'))
    if (!Array.isArray(parsed)) return []
    const articles: NewsArticle[] = []
    for (const value of parsed) {
      const result = NewsArticleSchema.safeParse(value)
      if (result.success) articles.push(result.data)
    }
    return articles
  } catch {
    return []
  }
}

function writeOutput(articles: NewsArticle[]): void {
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(articles, null, 2)}\n`, 'utf8')
}

function writeDebugHtml(source: string, articleId: string, html: string | undefined): void {
  if (process.env.LEARNING_AGENT_DEBUG !== '1' || !html) return
  const path = join(APP_HOME, 'raw', source, `${articleId}.html`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, html, 'utf8')
}

async function ingestSource(
  db: LearningDb,
  source: NewsSource,
  seenUrls: Set<string>,
): Promise<SourceResult> {
  const runId = db.startIngestRun(source.id)
  const stats: SourceStats = { fetched: 0, inserted: 0, skipped: 0, errors: 0 }
  const articles: NewsArticle[] = []

  try {
    const items = await source.list()
    const batch = items.slice(0, MAX_ITEMS_PER_SOURCE)
    stats.fetched = batch.length
    console.log(`[${source.id}] listed ${items.length} item(s); processing ${batch.length}`)

    const limit = pLimit(2)
    const normalized = await Promise.all(
      batch.map((item) =>
        limit(async () => {
          try {
            const raw = await source.fetchDetail(item)
            writeDebugHtml(source.id, raw.sourceId, raw.contentHtml)
            const result = normalizeArticle(source.id, raw)
            if (!result.ok) {
              stats.skipped += 1
              console.warn(`[${source.id}] skipped ${raw.sourceId}: ${result.reason}`)
              return undefined
            }
            if (seenUrls.has(result.article.url)) {
              stats.skipped += 1
              console.warn(`[${source.id}] skipped duplicate url: ${result.article.url}`)
              return undefined
            }
            seenUrls.add(result.article.url)
            return result.article
          } catch (error) {
            stats.errors += 1
            const reason = error instanceof Error ? error.message : String(error)
            console.warn(`[${source.id}] detail failed for ${item.url}: ${reason}`)
            return undefined
          }
        }),
      ),
    )

    for (const article of normalized) {
      if (article) articles.push(article)
    }
    if (articles.length > 0) stats.inserted = db.upsertNews(articles)
    db.finishIngestRun(runId, stats.errors > 0 ? 'partial' : 'ok', stats)
  } catch (error) {
    stats.errors += 1
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[${source.id}] list failed: ${reason}`)
    db.finishIngestRun(runId, 'partial', stats)
  }

  console.log(
    `[${source.id}] fetched=${stats.fetched} inserted=${stats.inserted} skipped=${stats.skipped} errors=${stats.errors}`,
  )
  return { source: source.id, stats, articles }
}

function mergeOutput(existing: NewsArticle[], fresh: NewsArticle[]): NewsArticle[] {
  const byUrl = new Map<string, NewsArticle>()
  for (const article of existing) byUrl.set(article.url, article)
  for (const article of fresh) byUrl.set(article.url, article)
  return [...byUrl.values()].sort((a, b) => b.published_at.localeCompare(a.published_at))
}

async function main(): Promise<void> {
  const ctx = new Context()
  const fiber = await ctx.plugin(LearningDb, { appHome: APP_HOME })
  const db = ctx.learningDb
  console.log(`DB: ${db.dbPath}`)
  console.log(`App home: ${APP_HOME}`)

  const seenUrls = new Set<string>()
  const results: SourceResult[] = []
  try {
    for (const source of NEWS_SOURCES) {
      results.push(await ingestSource(db, source, seenUrls))
    }
  } finally {
    await fiber.dispose()
  }

  const fresh = results.flatMap((result) => result.articles)
  const merged = mergeOutput(readExistingArticles(), fresh)
  if (merged.length > 0) {
    writeOutput(merged)
    console.log(`Wrote ${merged.length} article(s) to ${OUTPUT_PATH}`)
  } else {
    console.warn('No articles fetched; leaving the existing normalized output untouched')
  }

  console.log('\nPer-source summary')
  console.table(
    results.map(({ source, stats }) => ({
      source,
      fetched: stats.fetched,
      inserted: stats.inserted,
      skipped: stats.skipped,
      errors: stats.errors,
    })),
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
