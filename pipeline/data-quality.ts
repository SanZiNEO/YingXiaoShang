import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LearningDb from '@learning-agent/db'
import { locateSpan } from '@learning-agent/shared'
import { loadEnv, repoRoot } from './env.ts'

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const value = key(item)
    counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

loadEnv()

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function readJsonOrJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, 'utf8')
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) return JSON.parse(trimmed) as unknown[]
  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown)
}

const appHome = process.env.LEARNING_AGENT_HOME || repoRoot
const chapterId = argValue('--chapter') ?? 'ch04'
const judgmentsPath = argValue('--judgments')
const annotationsPath = argValue('--annotations')
const outPath = argValue('--out')
const limitNews = Math.min(500, Math.max(1, Number(argValue('--limit-news') ?? 100)))
const cleanMock = process.argv.includes('--clean-mock')
const cleanTestQuestions = process.argv.includes('--clean-test-questions')
const allowIncomplete = process.argv.includes('--allow-incomplete')

const ctx = new Context()
await ctx.plugin(LearningDb, { appHome })
const db = ctx.learningDb

const cleaned = {
  ...(cleanMock ? { mock: db.cleanMockPollution() } : {}),
  ...(cleanTestQuestions ? { test_questions: db.cleanTestQuestions() } : {}),
}
const blocks = db.listBlocks(chapterId)
const tags = db.listContentTags({ chapterId, limit: 100000 })
const blockById = new Map(blocks.map((block) => [block.id, block]))
const tagCounts = new Map<string, number>()
let invalidSpans = 0
let invalidOffsets = 0
for (const tag of tags) {
  if (tag.review_status !== 'rejected') {
    tagCounts.set(tag.block_id, (tagCounts.get(tag.block_id) ?? 0) + 1)
  }
  const block = blockById.get(tag.block_id)
  const located = block ? locateSpan(block.text, tag.evidence_span) : undefined
  if (!located) {
    invalidSpans += 1
    continue
  }
  if (
    tag.evidence_start !== undefined &&
    (tag.evidence_start !== located.start || tag.evidence_end !== located.end)
  ) {
    invalidOffsets += 1
  }
}

const teachable = blocks.filter((block) => block.text.trim().length >= 20)
const shortFragments = blocks.filter((block) => {
  const text = block.text.trim()
  return text.length < 20 && !/[。！？!?；;]/.test(text)
})
const autoTaggedBlocks = new Set(
  tags
    .filter((tag) => tag.evidence_level === 'auto' && tag.method !== 'human' && tag.review_status !== 'rejected')
    .map((tag) => tag.block_id),
)
const manualTaggedBlocks = new Set(
  tags
    .filter(
      (tag) =>
        tag.evidence_level !== 'auto' &&
        tag.reviewer_id.trim().length > 0 &&
        ['reviewed', 'adjudicated', 'published'].includes(tag.review_status),
    )
    .map((tag) => tag.block_id),
)
const autoCovered = teachable.filter((block) => autoTaggedBlocks.has(block.id)).length
const manualCovered = teachable.filter((block) => manualTaggedBlocks.has(block.id)).length
const kpTaggedBlocks = new Set(
  tags
    .filter((tag) => tag.tag_type === 'knowledge_point' && tag.review_status !== 'rejected')
    .map((tag) => tag.block_id),
)
const kpCovered = teachable.filter((block) => kpTaggedBlocks.has(block.id)).length
const zeroTagBlocks = teachable.filter((block) => (tagCounts.get(block.id) ?? 0) === 0).length
const overThree = [...tagCounts.entries()].filter(([blockId, count]) => blockById.has(blockId) && count > 3)

let rawFileBlocks: number | null = null
const rawFile = join(repoRoot, 'data', 'normalized', 'content_blocks.jsonl')
if (existsSync(rawFile)) {
  rawFileBlocks = (await readFile(rawFile, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { chapter_id?: string })
    .filter((block) => block.chapter_id === chapterId).length
}

const allKps = db.listAllKps()
const duplicateGroups = new Map<string, typeof allKps>()
for (const kp of allKps) {
  const key = `${kp.chapter_id}|${kp.name.trim()}`
  const group = duplicateGroups.get(key) ?? []
  group.push(kp)
  duplicateGroups.set(key, group)
}
const duplicates = [...duplicateGroups.entries()]
  .filter(([, group]) => group.length > 1)
  .map(([key, group]) => ({
    key,
    ids: group.map((kp) => kp.id),
    statuses: group.map((kp) => kp.status),
  }))
const artifactRefs = new Set(db.listAllArtifacts(10000).flatMap((artifact) => artifact.source_refs))
const staleBlockRefs = [...artifactRefs].filter((ref) => ref.startsWith('cb_') && !db.getBlock(ref))
const staleKpRefs = [...artifactRefs].filter((ref) => ref.startsWith('kp_') && !db.getKp(ref))

const matches = db.listCaseMatches({ chapterId, limit: 100000 })
const articlesWithMatches = new Set(matches.map((match) => match.article_id))
const newsById = new Map<string, string>()
let invalidMatchSpans = 0
for (const match of matches) {
  let content = newsById.get(match.article_id)
  if (content === undefined) {
    content = db.getNews(match.article_id)?.content ?? ''
    newsById.set(match.article_id, content)
  }
  if (!locateSpan(content, match.evidence_span)) invalidMatchSpans += 1
}
const claimedGoldWithoutHuman = [
  ...tags.filter((tag) => tag.evidence_level !== 'auto' && tag.reviewer_id.trim().length === 0),
  ...matches.filter((match) => match.evidence_level !== 'auto' && match.reviewer_id.trim().length === 0),
].length

const newsAudit = db.newsAudit()
const newsSample = db.listNews({ limit: limitNews })
const newsTotal = newsAudit.reduce((sum, row) => sum + row.count, 0)
const sources: Record<string, number> = {}
const contentStatus: Record<string, number> = {}
for (const row of newsAudit) {
  sources[row.source] = (sources[row.source] ?? 0) + row.count
  contentStatus[row.content_status] = (contentStatus[row.content_status] ?? 0) + row.count
}

let precision: {
  value: number | null
  reason: string
  queries: number
  judgments: number
  reviewers: number
  formula: string
} = {
  value: null,
  reason: 'no --judgments input; human relevance judgments are required',
  queries: 0,
  judgments: 0,
  reviewers: 0,
  formula: 'mean over queries of relevant items in top 5 / 5; missing results count as not relevant',
}
if (judgmentsPath) {
  const raw = await readJsonOrJsonl(judgmentsPath)
  const judgments = raw.filter((item): item is {
    queryId?: unknown
    articleId?: unknown
    kpId?: unknown
    relevant?: unknown
    rank?: unknown
    reviewerId?: unknown
  } => typeof item === 'object' && item !== null)
  const human = judgments.filter(
    (item) =>
      typeof item.articleId === 'string' &&
      typeof item.kpId === 'string' &&
      typeof item.relevant === 'boolean',
  )
  if (human.length === 0) {
    precision = {
      ...precision,
      reason: 'judgment file has no rows with articleId + kpId + relevant; no metric',
      judgments: judgments.length,
      reviewers: 0,
    }
  } else {
    const reviewers = new Set(
      human
        .map((item) => (typeof item.reviewerId === 'string' ? item.reviewerId.trim() : ''))
        .filter((reviewer) => reviewer.length > 0),
    )
    const groups = new Map<string, typeof human>()
    for (const item of human) {
      const key = typeof item.queryId === 'string' ? item.queryId : item.articleId as string
      const group = groups.get(key) ?? []
      group.push(item)
      groups.set(key, group)
    }
    const values: number[] = []
    for (const group of groups.values()) {
      const articleId = group[0]!.articleId as string
      const uniqueKps = new Set(group.map((item) => item.kpId))
      if (uniqueKps.size !== group.length) {
        throw new Error('Each query must contain one final relevance judgment per knowledge point; resolve duplicate or disputed judgments first.')
      }
      const ranks = group.filter((item) => typeof item.rank === 'number').map((item) => Number(item.rank))
      if (ranks.some((rank) => !Number.isInteger(rank) || rank < 1)
        || new Set(ranks).size !== ranks.length) {
        throw new Error('Supplied ranks must be distinct positive integers within each query.')
      }
      const ranked = group.every((item) => typeof item.rank === 'number')
        ? [...group].filter((item) => Number(item.rank) <= 5).sort((left, right) => Number(left.rank) - Number(right.rank))
        : db.getMatchCandidates(articleId, { topK: 5, chapterId }).map((candidate) => ({
            articleId,
            kpId: candidate.kpId,
            relevant: group.some((item) => item.kpId === candidate.kpId && item.relevant === true),
          }))
      const hits = ranked.filter((item) => item.relevant === true).length
      values.push(hits / 5)
    }
    precision = {
      value: values.length > 0 ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)) : null,
      reason: values.length > 0
        ? reviewers.size > 0
          ? `computed from --judgments file (${reviewers.size} reviewer id(s))`
          : 'computed from --judgments file (no reviewerId supplied)'
        : 'no query produced a top-5 list',
      queries: values.length,
      judgments: human.length,
      reviewers: reviewers.size,
      formula: 'mean over queries of relevant items in top 5 / 5; missing results count as not relevant',
    }
  }
}

let agreement: {
  value: number | null
  reason: string
  blocks: number
  reviewers: number
  exactMatchRate: number | null
  formula: string
} = {
  value: null,
  reason: 'no --annotations input; two independent annotators are required',
  blocks: 0,
  reviewers: 0,
  exactMatchRate: null,
  formula: 'mean pairwise Jaccard(tagKeys) over blocks with >=2 reviewers',
}
if (annotationsPath) {
  const raw = await readJsonOrJsonl(annotationsPath)
  const rows = raw.filter((item): item is {
    blockId?: unknown
    reviewerId?: unknown
    tagKeys?: unknown
  } => typeof item === 'object' && item !== null)
  const byBlock = new Map<string, Map<string, Set<string>>>()
  for (const row of rows) {
    if (
      typeof row.blockId !== 'string' ||
      typeof row.reviewerId !== 'string' ||
      row.reviewerId.trim().length === 0 ||
      !Array.isArray(row.tagKeys)
    ) continue
    const reviewers = byBlock.get(row.blockId) ?? new Map<string, Set<string>>()
    reviewers.set(row.reviewerId, new Set(row.tagKeys.filter((key): key is string => typeof key === 'string')))
    byBlock.set(row.blockId, reviewers)
  }
  const scores: number[] = []
  let exact = 0
  let blocksWithTwo = 0
  const reviewerIds = new Set<string>()
  for (const reviewers of byBlock.values()) {
    if (reviewers.size < 2) continue
    blocksWithTwo += 1
    reviewers.forEach((_value, reviewer) => reviewerIds.add(reviewer))
    const sets = [...reviewers.values()]
    let pairSum = 0
    let pairs = 0
    let allEqual = true
    for (let left = 0; left < sets.length; left++) {
      for (let right = left + 1; right < sets.length; right++) {
        const a = sets[left]!
        const b = sets[right]!
        const union = new Set([...a, ...b])
        const intersection = [...a].filter((key) => b.has(key))
        pairSum += union.size > 0 ? intersection.length / union.size : 1
        pairs += 1
        if (a.size !== b.size || intersection.length !== a.size) allEqual = false
      }
    }
    if (pairs > 0) scores.push(pairSum / pairs)
    if (allEqual) exact += 1
  }
  agreement = {
    value: scores.length > 0 ? Number((scores.reduce((sum, value) => sum + value, 0) / scores.length).toFixed(4)) : null,
    reason: scores.length > 0 ? 'computed from two or more independent annotators' : 'no block has two annotators',
    blocks: blocksWithTwo,
    reviewers: reviewerIds.size,
    exactMatchRate: blocksWithTwo > 0 ? Number((exact / blocksWithTwo).toFixed(4)) : null,
    formula: 'mean pairwise Jaccard(tagKeys) over blocks with >=2 reviewers',
  }
}

const checks = {
  ch04_duplicate_names: duplicates.length === 0,
  span_valid: invalidSpans === 0 && invalidOffsets === 0 && invalidMatchSpans === 0,
  auto_coverage_95: teachable.length > 0 && autoCovered / teachable.length >= 0.95,
  tags_per_block_1_to_3: overThree.length === 0,
  no_mock_matches: db.countMockMatches() === 0,
  no_auto_claimed_gold: claimedGoldWithoutHuman === 0,
  references_traceable: staleBlockRefs.length === 0 && staleKpRefs.length === 0,
}

const report = {
  generated_at: new Date().toISOString(),
  app_home: appHome,
  db: db.dbPath,
  chapter: chapterId,
  cleaned,
  blocks: {
    raw_file_blocks: rawFileBlocks,
    db_blocks: blocks.length,
    teachable_blocks: teachable.length,
    teachable_rule: 'text length >= 20 (short heading fragments excluded)',
    short_fragments_in_db: shortFragments.length,
  },
  coverage: {
    auto: {
      covered: autoCovered,
      denominator: teachable.length,
      ratio: teachable.length > 0 ? Number((autoCovered / teachable.length).toFixed(4)) : null,
    },
    manual: {
      covered: manualCovered,
      denominator: teachable.length,
      ratio: teachable.length > 0 ? Number((manualCovered / teachable.length).toFixed(4)) : null,
    },
    knowledge_point: {
      covered: kpCovered,
      denominator: teachable.length,
      ratio: teachable.length > 0 ? Number((kpCovered / teachable.length).toFixed(4)) : null,
      rule: 'blocks with at least one non-rejected knowledge_point tag; no section fallback',
    },
    raw_denominator: rawFileBlocks,
    raw_auto_ratio:
      rawFileBlocks && rawFileBlocks > 0 ? Number((autoCovered / rawFileBlocks).toFixed(4)) : null,
    blocks_with_zero_tags: zeroTagBlocks,
    blocks_over_three_tags: overThree.length,
  },
  tags: {
    total: tags.length,
    by_type: countBy(tags, (tag) => tag.tag_type),
    by_role: countBy(tags, (tag) => tag.tag_role),
    by_method: countBy(tags, (tag) => tag.method),
    by_review_status: countBy(tags, (tag) => tag.review_status),
    by_evidence_level: countBy(tags, (tag) => tag.evidence_level),
    by_version: countBy(tags, (tag) => tag.version),
    span_valid: tags.length - invalidSpans,
    span_invalid: invalidSpans,
    offset_invalid: invalidOffsets,
    audit: db.contentTagAudit(),
  },
  knowledge_points: {
    total: allKps.length,
    ch04: allKps.filter((kp) => kp.chapter_id === 'ch04').length,
    duplicate_names: duplicates,
    canonical_map: db.getCanonicalKpMap(),
    curated_present: allKps.filter((kp) => ['kp_organizational_market', 'kp_brand_loyalty'].includes(kp.id)).map((kp) => kp.id),
  },
  references: {
    block_canonical_map: db.getBlockCanonicalMap().length,
    artifact_refs: artifactRefs.size,
    stale_block_refs: staleBlockRefs,
    stale_kp_refs: staleKpRefs,
  },
  news: {
    total: newsTotal,
    sources,
    content_status: contentStatus,
    sampled: newsSample.length,
    sampled_sources: countBy(newsSample, (article) => article.source),
    matches: matches.length,
    articles_with_matches: articlesWithMatches.size,
    auto_matches: matches.filter((match) => match.evidence_level === 'auto').length,
    reviewed_matches: matches.filter((match) => match.review_status !== 'draft').length,
    match_span_invalid: invalidMatchSpans,
    audit: db.matchAudit(),
  },
  pollution: {
    mock_matches: db.countMockMatches(),
    test_questions: db.countTestQuestions(),
    synthetic_evidence: db.countSyntheticEvidence(),
    auto_claimed_gold: claimedGoldWithoutHuman,
  },
  metrics: {
    precision_at_5: precision,
    inter_annotator_agreement: agreement,
  },
  checks,
}

if (outPath) await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))

if (!allowIncomplete && Object.values(checks).some((value) => !value)) process.exitCode = 1
