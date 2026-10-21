import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import LearningDb from '@learning-agent/db'
import {
  ContentTagSchema,
  locateSpan,
  type ContentTag,
  type ReviewStatus,
  type EvidenceLevel,
} from '@learning-agent/shared'
import { loadEnv, repoRoot } from './env.ts'

loadEnv()

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const appHome = process.env.LEARNING_AGENT_HOME || repoRoot
const command = process.argv[2] ?? 'list'
const kind = argValue('--kind') ?? 'content'
const chapterId = argValue('--chapter')
const status = (argValue('--status') ?? 'draft') as ReviewStatus
const reviewer = argValue('--reviewer') ?? ''
const version = argValue('--version') ?? 'v0.1'
const level = (argValue('--level') ?? 'verified') as EvidenceLevel
const limit = Math.min(5000, Math.max(1, Number(argValue('--limit') ?? 100)))
const REVIEW_STATUSES: ReviewStatus[] = ['draft', 'reviewed', 'adjudicated', 'published', 'rejected']
const EVIDENCE_LEVELS: EvidenceLevel[] = ['auto', 'verified', 'gold']
if (!REVIEW_STATUSES.includes(status) || !EVIDENCE_LEVELS.includes(level)) {
  console.error(`invalid --status/--level; status=${status} level=${level}`)
  process.exit(1)
}

const ctx = new Context()
await ctx.plugin(LearningDb, { appHome })
const db = ctx.learningDb

if (command === 'versions') {
  console.log(JSON.stringify({
    content_tags: db.contentTagAudit(),
    matches: db.matchAudit(),
    canonical_map: db.getCanonicalKpMap().length,
  }, null, 2))
} else if (command === 'list') {
  if (kind === 'match') {
    const rows = db.listCaseMatches({ chapterId, reviewStatus: status, limit }).map((match) => ({
      ...match,
      kp_name: db.getKp(match.kp_id)?.name ?? '',
      role_label: match.tag_role === 'core' ? '核心' : match.tag_role === 'example' ? '例证' : '提及',
    }))
    console.log(JSON.stringify({ kind, count: rows.length, rows }, null, 2))
  } else {
    const rows = db.listContentTags({ chapterId, reviewStatus: status, limit }).map((tag) => ({
      ...tag,
      kp_name: tag.tag_type === 'knowledge_point' ? db.getKp(tag.tag_key)?.name ?? '' : '',
      role_label: tag.tag_role === 'core' ? '核心' : tag.tag_role === 'example' ? '例证' : '提及',
    }))
    console.log(JSON.stringify({ kind, count: rows.length, rows }, null, 2))
  }
} else if (command === 'accept' || command === 'reject') {
  if (!reviewer.trim()) {
    console.error('--reviewer is required; this CLI never fabricates a human reviewer')
    process.exit(1)
  }
  const nextStatus: ReviewStatus = command === 'accept' ? 'reviewed' : 'rejected'
  const nextLevel: EvidenceLevel = command === 'accept' ? level : 'auto'
  if (kind === 'match') {
    const articleId = argValue('--article')
    const kpId = argValue('--kp')
    if (!articleId || !kpId) {
      console.error('match review requires --article <id> --kp <id>')
      process.exit(1)
    }
    const changed = db.reviewCaseMatch(articleId, kpId, {
      status: nextStatus,
      evidenceLevel: nextLevel,
      reviewerId: reviewer,
      version,
    })
    console.log(JSON.stringify({ kind, changed, articleId, kpId, status: nextStatus, level: nextLevel, reviewer, version }, null, 2))
  } else {
    const tagId = argValue('--tag')
    if (!tagId) {
      console.error('content tag review requires --tag <id>')
      process.exit(1)
    }
    const changed = db.reviewContentTag(tagId, {
      status: nextStatus,
      evidenceLevel: nextLevel,
      reviewerId: reviewer,
      version,
    })
    console.log(JSON.stringify({ kind, changed, tagId, status: nextStatus, level: nextLevel, reviewer, version }, null, 2))
  }
} else if (command === 'import') {
  const file = argValue('--file')
  if (!file) {
    console.error('import requires --file <json>')
    process.exit(1)
  }
  const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
  const tags = ContentTagSchema.array().parse(raw) as ContentTag[]
  const invalid: string[] = []
  for (const tag of tags) {
    if (
      ['reviewed', 'adjudicated', 'published'].includes(tag.review_status) &&
      tag.reviewer_id.trim().length === 0
    ) {
      invalid.push(`${tag.id}: reviewed status requires reviewer_id`)
    }
    if (tag.evidence_level !== 'auto' && tag.reviewer_id.trim().length === 0) {
      invalid.push(`${tag.id}: ${tag.evidence_level} requires reviewer_id`)
    }
    if (tag.evidence_level !== 'auto' && !['human', 'hybrid'].includes(tag.method)) {
      invalid.push(`${tag.id}: ${tag.evidence_level} requires method human/hybrid, not ${tag.method}`)
    }
    if (tag.tag_type === 'knowledge_point' && !db.resolveCanonicalKpId(tag.tag_key)) {
      invalid.push(`${tag.id}: unknown knowledge point ${tag.tag_key}`)
    }
    const block = db.getBlock(tag.block_id)
    if (!block || !locateSpan(block.text, tag.evidence_span)) {
      invalid.push(`${tag.id}: evidence_span is not a verbatim block substring`)
    }
  }
  if (invalid.length > 0) {
    console.error(JSON.stringify({ imported: 0, invalid }, null, 2))
    process.exit(1)
  }
  db.upsertContentTags(tags, { preserveReviewed: false })
  console.log(JSON.stringify({
    imported: tags.length,
    reviewed: tags.filter((tag) => tag.review_status !== 'draft').length,
    gold_or_verified: tags.filter((tag) => tag.evidence_level !== 'auto').length,
  }, null, 2))
} else {
  console.error(`unknown command: ${command}. Use list|accept|reject|import|versions`)
  process.exit(1)
}
