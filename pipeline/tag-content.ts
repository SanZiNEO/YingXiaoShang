import { Context } from '@deepseek-ai/cordis'
import LearningDb from '@learning-agent/db'
import { loadEnv, repoRoot } from './env.ts'
import { DeepSeekLlm } from './lib/llm.ts'
import { tagContentBlocks, tagContentBlocksWithLlm } from './lib/tags.ts'

loadEnv()

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const appHome = process.env.LEARNING_AGENT_HOME || repoRoot
const all = process.argv.includes('--all')
const force = process.argv.includes('--force')
const chapterArg = argValue('--chapter') ?? 'ch04'
const limitBlocks = argValue('--limit-blocks')
const version = argValue('--version') ?? 'v0.1'
const useLlm = process.argv.includes('--llm') || process.env.CONTENT_TAGS_LLM === '1'
const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat'
if (useLlm && !process.env.DEEPSEEK_API_KEY) {
  console.error('--llm requires DEEPSEEK_API_KEY; rule-only tagging is still available without it')
  process.exit(1)
}
const llm = useLlm
  ? new DeepSeekLlm(() => ({ apiKey: process.env.DEEPSEEK_API_KEY ?? '', model }))
  : undefined

const ctx = new Context()
await ctx.plugin(LearningDb, { appHome })
const db = ctx.learningDb
const chapters = all ? db.listChapters() : db.listChapters().filter((chapter) => chapter.id === chapterArg)
if (chapters.length === 0) {
  console.error(`chapter not found: ${chapterArg}; seed the database first`)
  process.exit(1)
}

const results: Array<Record<string, unknown>> = []
for (const chapter of chapters) {
  let blocks = db.listBlocks(chapter.id)
  if (limitBlocks) {
    const parsed = Number(limitBlocks)
    if (Number.isFinite(parsed) && parsed > 0) blocks = blocks.slice(0, parsed)
  }
  const knowledgePoints = db.listKpsByChapter(chapter.id)
  if (force) db.deleteAutoContentTags(chapter.id)
  const tagged = llm
    ? await tagContentBlocksWithLlm(blocks, knowledgePoints, llm, { version })
    : tagContentBlocks(blocks, knowledgePoints, { version })
  db.upsertContentTags(tagged.tags, { preserveReviewed: true })
  db.dedupeContentTags()
  const storedTags = db.listContentTags({ chapterId: chapter.id, limit: 100000 })
  results.push({
    chapter: chapter.id,
    blocks: blocks.length,
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
    review_status: 'draft',
    evidence_level: 'auto',
    version,
    llm: useLlm ? model : 'not-configured (rule-only)',
  })
}

console.log(JSON.stringify({ appHome, db: db.dbPath, results }, null, 2))
