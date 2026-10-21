import { Context } from '@deepseek-ai/cordis'
import LearningDb from '@learning-agent/db'
import { Matcher } from '@learning-agent/matcher'
import { DeepSeekLlm } from './lib/llm.ts'
import { loadEnv, repoRoot } from './env.ts'

loadEnv()

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const appHome = process.env.LEARNING_AGENT_HOME || repoRoot
const all = process.argv.includes('--all')
const force = process.argv.includes('--force')
const noLlm = process.argv.includes('--no-llm')
const articleId = argValue('--article')
const requestedLimit = Number(argValue('--limit') ?? 20)
const limit = all ? 1000 : Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 20
const requestedTopK = Number(argValue('--top-k') ?? 3)
const topK = Number.isFinite(requestedTopK) ? Math.max(1, Math.min(10, Math.floor(requestedTopK))) : 3

const ctx = new Context()
const apiKey = process.env.DEEPSEEK_API_KEY ?? ''
if (!noLlm && apiKey) {
  ctx.provide('llm', new DeepSeekLlm(() => ({
    apiKey,
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
  })))
} else {
  ctx.provide('llm', {
    async *stream() {
      throw new Error('DEEPSEEK_API_KEY is not configured')
    },
  })
}
await ctx.plugin(LearningDb, { appHome })
const matcher = new Matcher(ctx)
const db = ctx.learningDb

const single = articleId ? db.getNews(articleId) : undefined
const articles = articleId
  ? single
    ? [single]
    : []
  : db.listNews({ limit: Math.min(200, Math.max(limit * 4, 40)) })
      .filter((article) => article.content.length >= 300)
      .slice(0, limit)

if (articles.length === 0) {
  console.error('no real news articles found; run pnpm pipeline:news and db:seed first')
  process.exit(1)
}

let processed = 0
let skipped = 0
let failed = 0
let llmUsed = 0
let candidates = 0
const notes: string[] = []

for (const article of articles) {
  const reviewed = db.getMatches(article.id).some((match) =>
    ['reviewed', 'adjudicated', 'published'].includes(match.review_status),
  )
  if (reviewed && !force) {
    skipped += 1
    continue
  }
  try {
    const result = await matcher.match({ articleId: article.id, topK, useLlm: !noLlm, chapterId: 'ch04' })
    processed += 1
    candidates += result.matches.length
    if (result.diagnostics.llm) llmUsed += 1
    notes.push(...result.diagnostics.notes)
    console.log(
      `${article.id}: ${result.matches.length} matches, ${result.ideology.length} ideology, llm=${result.diagnostics.llm}, degraded=${result.diagnostics.degraded}`,
    )
  } catch (error) {
    failed += 1
    console.error(`${article.id}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(JSON.stringify({
  articles: articles.length,
  processed,
  skipped,
  failed,
  candidates,
  llm_articles: llmUsed,
  vector: 'lexical-hash',
  semantic: false,
  degraded: noLlm || llmUsed < processed,
  notes: [...new Set(notes)],
}, null, 2))
if (failed > 0) process.exit(1)
