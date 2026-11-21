import {
  TAG_ROLE_WEIGHTS,
  locateSpan,
  stableId,
  type ContentBlock,
  type ContentTag,
  type KnowledgePoint,
  type TagRole,
} from '@learning-agent/shared'

const COMPETENCY_IDS: Record<string, string> = {
  problem_framing: 'problem_framing',
  evidence_hypothesis: 'evidence_hypothesis',
  decision_tradeoff: 'decision_tradeoff',
  communication: 'communication',
  市场与消费者洞察: 'problem_framing',
  数据与效果: 'evidence_hypothesis',
  伦理与可持续: 'decision_tradeoff',
  创意与沟通: 'communication',
  营销策略与组合: 'decision_tradeoff',
  品牌与定位: 'communication',
}

const DECISION_KEYS: Record<string, string> = {
  环境分析: 'decision_environment_analysis',
  消费者洞察: 'decision_consumer_insight',
  组织市场: 'decision_organizational_market',
}

const CONTEXT_TERMS: Array<{ key: string; terms: string[] }> = [
  { key: 'context_digital', terms: ['数智', '算法', '平台', '人工智能', 'AI', '全渠道', '个性化推荐'] },
  { key: 'context_purchase_situation', terms: ['情境', '卖场', '环境', '灯光', '陈列'] },
  { key: 'context_social_group', terms: ['群体', '家庭', '社会', '文化', '参照'] },
  { key: 'context_decision_process', terms: ['决策', '信息搜集', '信息搜索', '评估', '购后'] },
  { key: 'context_learning_loyalty', terms: ['学习', '忠诚', '经验', '习惯'] },
  { key: 'context_consumer_market', terms: ['消费者市场', '生活消费', '最终市场', '个人和家庭'] },
]

const DEFINITION_MARKERS = /是指|指的是|定义为|含义|集合|模式|过程是|包括/
const EXAMPLE_MARKERS = /例如|比如|举例|案例|如.*购买|如.*选择/

/**
 * Widen a bare term match to its containing sentence: tags are retrieval evidence
 * downstream, and a lone term carries no teaching content.
 */
function expandToSentence(
  text: string,
  start: number,
  end: number,
): { span: string; start: number; end: number } | undefined {
  let left = start
  while (left > 0 && !/[\n。！？!?；;]/.test(text[left - 1]!)) left--
  let right = end
  while (right < text.length && !/[\n。！？!?；;]/.test(text[right]!)) right++
  const sentence = text.slice(left, right).trim()
  if (sentence.length >= 20) {
    const located = locateSpan(text, sentence)
    if (located) return located
  }
  const whole = text.trim()
  return locateSpan(text, whole) ?? locateSpan(text, text.slice(start, end))
}

interface KpHit {
  kp: KnowledgePoint
  score: number
  role: TagRole
  span: string
  start: number
  end: number
}

export interface ContentTaggingStats {
  blocks: number
  teachable_blocks: number
  tagged_blocks: number
  kp_tagged_blocks: number
  untagged_blocks: number
  tags: number
  by_type: Record<string, number>
  by_role: Record<string, number>
}

export interface ContentTaggingResult {
  tags: ContentTag[]
  stats: ContentTaggingStats
}

function countOccurrences(text: string, term: string): number {
  if (term.length === 0) return 0
  let count = 0
  let index = text.indexOf(term)
  while (index >= 0) {
    count += 1
    index = text.indexOf(term, index + term.length)
  }
  return count
}

function isTeachable(block: ContentBlock): boolean {
  return block.text.trim().length >= 20 && !/^关键词\s*[：:]/.test(block.text.trim())
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const value = key(item)
    counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

function buildStats(blocks: ContentBlock[], tags: ContentTag[]): ContentTaggingStats {
  const taggedBlocks = new Set(tags.map((tag) => tag.block_id))
  const kpBlocks = new Set(
    tags.filter((tag) => tag.tag_type === 'knowledge_point').map((tag) => tag.block_id),
  )
  const teachable = blocks.filter(isTeachable)
  return {
    blocks: blocks.length,
    teachable_blocks: teachable.length,
    tagged_blocks: taggedBlocks.size,
    kp_tagged_blocks: kpBlocks.size,
    untagged_blocks: blocks.length - taggedBlocks.size,
    tags: tags.length,
    by_type: countBy(tags, (tag) => tag.tag_type),
    by_role: countBy(tags, (tag) => tag.tag_role),
  }
}

export function tagContentBlocks(
  blocks: ContentBlock[],
  knowledgePoints: KnowledgePoint[],
  options: { version?: string } = {},
): ContentTaggingResult {
  const version = options.version ?? 'v0.1'
  const tags: ContentTag[] = []

  for (const block of blocks) {
    if (!isTeachable(block)) continue
    const hits: KpHit[] = []
    for (const kp of knowledgePoints) {
      const terms = [kp.name, ...kp.aliases, ...kp.keywords].filter((term) => term.length >= 2)
      let best: KpHit | undefined
      for (const term of terms) {
        const count = countOccurrences(block.text, term)
        if (count === 0) continue
        const located = locateSpan(block.text, term)
        if (!located) continue
        const base = term === kp.name ? 3 : kp.aliases.includes(term) ? 2 : 1
        const role: TagRole = DEFINITION_MARKERS.test(block.text) && term === kp.name
          ? 'core'
          : EXAMPLE_MARKERS.test(block.text)
            ? 'example'
            : 'mention'
        const score = base + Math.min(2, count - 1) + (role === 'core' ? 2 : role === 'example' ? 1 : 0)
        if (!best || score > best.score) {
          best = { kp, score, role, span: located.span, start: located.start, end: located.end }
        }
      }
      if (best) hits.push(best)
    }
    hits.sort((left, right) => right.score - left.score)
    const chosen = hits.slice(0, 2)

    const blockTags: ContentTag[] = []
    const pushTag = (
      tagType: ContentTag['tag_type'],
      key: string,
      role: TagRole,
      confidence: number,
      span: string,
      start: number,
      end: number,
    ): void => {
      if (blockTags.length >= 3) return
      if (blockTags.some((tag) => tag.tag_type === tagType && tag.tag_key === key)) return
      const located = tagType === 'knowledge_point'
        ? expandToSentence(block.text, start, end)
        : locateSpan(block.text, span)
      if (!located) return
      blockTags.push({
        id: stableId('ct', `${block.id}|${tagType}|${key}|${role}|${version}`),
        block_id: block.id,
        tag_type: tagType,
        tag_key: key,
        tag_role: role,
        confidence: Math.min(0.95, Math.max(0.2, Number(confidence.toFixed(2)))),
        method: 'rule',
        evidence_span: located.span,
        evidence_start: located.start,
        evidence_end: located.end,
        review_status: 'draft',
        evidence_level: 'auto',
        version,
        reviewer_id: '',
        reviewed_at: '',
      })
    }

    for (const hit of chosen) {
      const confidence = hit.score > 0
        ? 0.45 + Math.min(0.4, hit.score * 0.1) + TAG_ROLE_WEIGHTS[hit.role] * 0.1
        : 0.35
      pushTag('knowledge_point', hit.kp.id, hit.role, confidence, hit.span, hit.start, hit.end)
    }

    const primary = chosen[0]
    const context = CONTEXT_TERMS.find((entry) => entry.terms.some((term) => block.text.includes(term)))
    const contextTerm = context?.terms.find((term) => block.text.includes(term))
    const contextLocated = contextTerm ? locateSpan(block.text, contextTerm) : undefined
    if (primary) {
      const competencyName = primary.kp.competencies.find((name) => COMPETENCY_IDS[name])
      const competencyId = competencyName ? COMPETENCY_IDS[competencyName] : undefined
      const decisionName = primary.kp.decisions.find((name) => DECISION_KEYS[name])
      const decisionKey = decisionName ? DECISION_KEYS[decisionName] : undefined
      const secondary: Array<{
        type: ContentTag['tag_type']
        key: string
        role: TagRole
        confidence: number
        span: string
        start: number
        end: number
      }> = []
      if (context && contextLocated) {
        secondary.push({
          type: 'context',
          key: context.key,
          role: 'mention',
          confidence: 0.55,
          span: contextLocated.span,
          start: contextLocated.start,
          end: contextLocated.end,
        })
      }
      if (decisionKey) {
        secondary.push({
          type: 'decision',
          key: decisionKey,
          role: 'mention',
          confidence: 0.5,
          span: primary.span,
          start: primary.start,
          end: primary.end,
        })
      }
      if (competencyId) {
        secondary.push({
          type: 'competency',
          key: competencyId,
          role: primary.role === 'core' ? 'core' : 'mention',
          confidence: primary.role === 'core' ? 0.7 : 0.5,
          span: primary.span,
          start: primary.start,
          end: primary.end,
        })
      }
      for (const item of secondary) {
        pushTag(item.type, item.key, item.role, item.confidence, item.span, item.start, item.end)
      }
    } else if (context && contextLocated) {
      pushTag(
        'context',
        context.key,
        'mention',
        0.35,
        contextLocated.span,
        contextLocated.start,
        contextLocated.end,
      )
    }

    tags.push(...blockTags)
  }

  return { tags, stats: buildStats(blocks, tags) }
}

export interface TaggingLlm {
  stream(options: {
    system?: string
    messages: ReadonlyArray<{ role: string; content: ReadonlyArray<{ type: string; text?: string }> }>
    maxTokens?: number
    temperature?: number
    signal?: AbortSignal
  }): AsyncIterable<Record<string, unknown>>
}

function extractJsonArray(value: string): unknown[] {
  const start = value.indexOf('[')
  const end = value.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(value.slice(start, end + 1)) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Optional model pre-labeling for blocks the rules cannot ground: a controlled KP
 * from the same section plus a verbatim quote, re-located in the block before it
 * becomes an auto/draft tag. Never gold/verified, never changes the denominator.
 */
export async function tagContentBlocksWithLlm(
  blocks: ContentBlock[],
  knowledgePoints: KnowledgePoint[],
  llm: TaggingLlm,
  options: { version?: string; batchSize?: number; maxBlocks?: number } = {},
): Promise<ContentTaggingResult> {
  const version = options.version ?? 'v0.1'
  const rule = tagContentBlocks(blocks, knowledgePoints, { version })
  const tags = [...rule.tags]
  const kpTagged = new Set(
    tags.filter((tag) => tag.tag_type === 'knowledge_point').map((tag) => tag.block_id),
  )
  const uncovered = blocks.filter((block) => isTeachable(block) && !kpTagged.has(block.id))
  const batchSize = Math.min(Math.max(options.batchSize ?? 6, 1), 12)
  const pending = uncovered.slice(0, Math.max(options.maxBlocks ?? uncovered.length, 0))
  if (pending.length === 0) return { tags, stats: buildStats(blocks, tags) }

  const kpsBySection = new Map<string, KnowledgePoint[]>()
  for (const kp of knowledgePoints) {
    const list = kpsBySection.get(kp.section_id) ?? []
    list.push(kp)
    kpsBySection.set(kp.section_id, list)
  }

  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const group = pending.slice(offset, offset + batchSize)
    const sections = [...new Set(group.map((block) => block.section_id))]
    const allowed = sections.flatMap((section) => kpsBySection.get(section) ?? [])
    if (allowed.length === 0) continue
    const prompt = [
      '你是教材段落标注器。只从“允许知识点”中挑选与段落语义直接相关的知识点。',
      '规则：每段最多 2 个知识点；没有直接相关就返回空；quote 必须逐字复制段落中的连续原文，且能支撑该知识点；不得改写、不得凭章节标题猜测。',
      '只输出 JSON 数组，不要解释：',
      '[{"block_id":"...","kp_id":"...","role":"core|example|mention","quote":"..."}]',
      '',
      `允许知识点：${JSON.stringify(allowed.map((kp) => ({
        id: kp.id,
        section_id: kp.section_id,
        name: kp.name,
        aliases: kp.aliases,
        keywords: kp.keywords,
      })))}`,
      '',
      `段落：${JSON.stringify(group.map((block) => ({
        block_id: block.id,
        section_id: block.section_id,
        text: block.text,
      })))}`,
    ].join('\n')
    let output = ''
    try {
      for await (const event of llm.stream({
        system: '你只输出经过原文核对的教材标注 JSON，不输出其他内容。',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 2048,
        temperature: 0,
      })) {
        if (event.type !== 'block-end') continue
        const block = event.block as { type?: string; text?: string } | undefined
        if (block?.type === 'text' && block.text) output += block.text
      }
    } catch {
      continue
    }
    const byBlock = new Map<string, ContentBlock>(
      group.map((block): [string, ContentBlock] => [block.id, block]),
    )
    for (const raw of extractJsonArray(output)) {
      if (typeof raw !== 'object' || raw === null) continue
      const item = raw as Record<string, unknown>
      const blockId = typeof item.block_id === 'string' ? item.block_id : ''
      const kpId = typeof item.kp_id === 'string' ? item.kp_id : ''
      const quote = typeof item.quote === 'string' ? item.quote.trim() : ''
      const role: TagRole = item.role === 'core'
        ? 'core'
        : item.role === 'example' ? 'example' : 'mention'
      const block = byBlock.get(blockId)
      const kp = knowledgePoints.find((point) => point.id === kpId)
      if (!block || !kp || kp.section_id !== block.section_id || quote.length < 2) continue
      const located = locateSpan(block.text, quote)
      if (!located) continue
      const blockTags = tags.filter((tag) => tag.block_id === blockId)
      if (blockTags.length >= 3) continue
      if (blockTags.some((tag) => tag.tag_type === 'knowledge_point' && tag.tag_key === kpId)) continue
      tags.push({
        id: stableId('ct', `${block.id}|knowledge_point|${kp.id}|${role}|${version}|llm`),
        block_id: block.id,
        tag_type: 'knowledge_point',
        tag_key: kp.id,
        tag_role: role,
        confidence: role === 'core' ? 0.7 : role === 'example' ? 0.6 : 0.55,
        method: 'llm',
        evidence_span: located.span,
        evidence_start: located.start,
        evidence_end: located.end,
        review_status: 'draft',
        evidence_level: 'auto',
        version,
        reviewer_id: '',
        reviewed_at: '',
      })
    }
  }

  return { tags, stats: buildStats(blocks, tags) }
}
