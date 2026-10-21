import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LearningDb, { type BlockSyncReport } from '@learning-agent/db'
import {
  ChapterSchema,
  ContentBlockSchema,
  IdeologyPointSchema,
  KnowledgePointSchema,
  KpMergeMapSchema,
  NewsArticleSchema,
  QuestionSchema,
  SectionSchema,
  TeachingGuideSchema,
} from '@learning-agent/shared'
import { generateDeterministicMatches } from '@learning-agent/matcher'
import { normalizeContentBlocksWithMap } from './lib/content.ts'
import { DeepSeekLlm } from './lib/llm.ts'
import { tagContentBlocks, tagContentBlocksWithLlm } from './lib/tags.ts'
import { loadEnv, repoRoot } from './env.ts'

loadEnv()
const appHome = process.env.LEARNING_AGENT_HOME || repoRoot
const normalized = join(repoRoot, 'data', 'normalized')

async function readJson<T>(name: string, fallback: T): Promise<T> {
  const path = join(normalized, name)
  if (!existsSync(path)) return fallback
  return JSON.parse(await readFile(path, 'utf8')) as T
}

async function readJsonl<T>(name: string): Promise<T[]> {
  const path = join(normalized, name)
  if (!existsSync(path)) return []
  const text = await readFile(path, 'utf8')
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T)
}

const ctx = new Context()
await ctx.plugin(LearningDb, { appHome })
const db = ctx.learningDb
if (process.env.RESET_DB === '1') db.resetDomainData()
const useLlm = process.env.CONTENT_TAGS_LLM === '1' && Boolean(process.env.DEEPSEEK_API_KEY)
const llm = useLlm
  ? new DeepSeekLlm(() => ({
      apiKey: process.env.DEEPSEEK_API_KEY ?? '',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    }))
  : undefined

const chapters = ChapterSchema.array().parse(await readJson('chapters.json', []))
const sections = SectionSchema.array().parse(await readJson('sections.json', []))
const normalizedKps = KnowledgePointSchema.array().parse(await readJson('knowledge_points.json', []))
const curatedKps = KnowledgePointSchema.array().parse(await readJson('knowledge_points.curated.json', []))
const kpMergeMap = KpMergeMapSchema.parse(await readJson('kp_merge_map.json', { version: 1, merges: [] }))
const knowledgePoints = [...normalizedKps]
for (const point of curatedKps) {
  const at = knowledgePoints.findIndex((existing) => existing.id === point.id)
  if (at >= 0) knowledgePoints[at] = point
  else knowledgePoints.push(point)
}
const rawBlocks = (await readJsonl<unknown>('content_blocks.jsonl')).map((row) => ContentBlockSchema.parse(row))
const normalizedBlocks = normalizeContentBlocksWithMap(rawBlocks)
const blocks = normalizedBlocks.blocks
const questions = QuestionSchema.array().parse(await readJson('questions.json', []))
const ideology = IdeologyPointSchema.array().parse(await readJson('ideology_points.json', []))
const guides = TeachingGuideSchema.array().parse(await readJson('teaching_guides.json', []))
const news = NewsArticleSchema.array().parse(await readJson('news_articles.json', []))

if (chapters.length === 0) {
  throw new Error('data/normalized/chapters.json is empty; run pnpm run pipeline:resources first')
}

db.upsertChapters(chapters)
db.upsertSections(sections)
db.upsertKps(knowledgePoints)
const blockSync: Array<{ chapter: string } & BlockSyncReport> = []
for (const chapter of chapters) {
  blockSync.push({
    chapter: chapter.id,
    ...db.syncBlocksForChapter(
      chapter.id,
      blocks.filter((block) => block.chapter_id === chapter.id),
      normalizedBlocks.mapping,
    ),
  })
}
db.upsertIdeology(ideology)
const manualKpMerges = kpMergeMap.merges.map((entry) => ({
  oldId: entry.old_id,
  canonicalId: entry.canonical_id,
}))
const mergedKps = db.mergeDuplicateKps(manualKpMerges)
const blockMappings = blockSync.reduce((sum, report) => sum + report.recorded_mappings, 0)

for (const guide of guides) {
  db.setState('resource', `guide/${guide.chapter_id}`, guide)
}

// Fresh installs must have textbook tags without running a manual pipeline.
// Tagging is deterministic and offline by default; every row stays auto/draft.
// CONTENT_TAGS_LLM=1 adds validated model pre-labels for blocks the rules
// cannot ground, still auto/draft.
let contentTagCount = 0
const contentCoverage: Array<Record<string, unknown>> = []
for (const chapter of chapters) {
  const chapterBlocks = db.listBlocks(chapter.id)
  const chapterKps = db.listKpsByChapter(chapter.id)
  if (chapterBlocks.length === 0 || chapterKps.length === 0) continue
  db.deleteAutoContentTags(chapter.id)
  const tagged = llm
    ? await tagContentBlocksWithLlm(chapterBlocks, chapterKps, llm)
    : tagContentBlocks(chapterBlocks, chapterKps)
  db.upsertContentTags(tagged.tags, { preserveReviewed: true })
  db.dedupeContentTags()
  const storedTags = db.listContentTags({ chapterId: chapter.id, limit: 100000 })
  contentTagCount += storedTags.length
  contentCoverage.push({
    chapter: chapter.id,
    blocks: chapterBlocks.length,
    teachable_blocks: tagged.stats.teachable_blocks,
    tagged_blocks: tagged.stats.tagged_blocks,
    kp_tagged_blocks: tagged.stats.kp_tagged_blocks,
    auto_coverage: tagged.stats.teachable_blocks > 0
      ? Number((tagged.stats.tagged_blocks / tagged.stats.teachable_blocks).toFixed(4))
      : null,
    kp_coverage: tagged.stats.teachable_blocks > 0
      ? Number((tagged.stats.kp_tagged_blocks / tagged.stats.teachable_blocks).toFixed(4))
      : null,
    generated_tags: tagged.tags.length,
    stored_tags: storedTags.length,
    by_type: tagged.stats.by_type,
    by_role: tagged.stats.by_role,
  })
}

const knownKps = new Set<string>()
for (const chapter of chapters) {
  for (const point of db.listKpsByChapter(chapter.id)) knownKps.add(point.id)
}
const validQuestions = questions
  .map((question) => ({
    ...question,
    kp_ids: question.kp_ids
      .map((id) => db.resolveCanonicalKpId(id) ?? id)
      .filter((id) => knownKps.has(id)),
  }))
  .filter((question) => question.kp_ids.length > 0)
const insertedQuestions = db.insertQuestions(validQuestions)
const insertedNews = news.length > 0 ? db.upsertNews(news) : 0

// Fresh installs also need real news candidates; deterministic only, no network.
// Whole-library (no chapter scope) so any chapter surface can filter afterwards.
let newsCandidates = 0
for (const article of db.listNews({ limit: 500 }).filter((item) => item.content.length >= 300)) {
  const matched = generateDeterministicMatches(db, article, 3)
  db.upsertMatches(article.id, matched.matches, matched.ideology)
  newsCandidates += matched.matches.length
}

console.log(JSON.stringify({
  appHome,
  db: db.dbPath,
  chapters: chapters.length,
  sections: sections.length,
  knowledge_points: db.listAllKps().length,
  merged_duplicate_kps: mergedKps,
  content_blocks: db.listAllBlocks().length,
  block_sync: blockSync,
  block_mappings: blockMappings,
  content_tags: contentTagCount,
  content_coverage: contentCoverage,
  content_tag_llm: useLlm ? (process.env.DEEPSEEK_MODEL || 'deepseek-chat') : 'not-configured (rule-only)',
  questions: validQuestions.length,
  inserted_questions: insertedQuestions,
  ideology_points: ideology.length,
  teaching_guides: guides.length,
  news: news.length,
  news_changed: insertedNews,
  news_candidates: newsCandidates,
}, null, 2))
