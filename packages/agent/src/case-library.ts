import { locateSpan } from '@learning-agent/shared'
import type {
  CaseStudyContent,
  CaseMatch,
  Chapter,
  ContentBlock,
  ContentTag,
  KnowledgePoint,
  NewsArticle,
  Section,
} from '@learning-agent/shared'

/**
 * Material layer for case lessons. Nothing in this file is a fixed lesson:
 * knowledge points are resolved from the course DB, evidence is recalled from
 * tagged textbook blocks or verified news sentences, and every quote is
 * checked against its source before it can become a citation.
 */

export interface MaterialDb {
  getKp(id: string): KnowledgePoint | undefined
  listKpsByChapter(chapterId: string): KnowledgePoint[]
  searchKps(query: string, chapter?: string, limit?: number): KnowledgePoint[]
  listBlocks(chapterId: string): ContentBlock[]
  getTagsForBlock(blockId: string): ContentTag[]
  listSections(chapterId?: string): Section[]
  listChapters(): Chapter[]
  listNews(opts?: { source?: string; since?: string; limit?: number }): NewsArticle[]
  getMatches(articleId: string): CaseMatch[]
  getNews?(id: string): NewsArticle | undefined
  findContentBlocksByTags?(
    tagKeys: string[],
    opts?: { chapterId?: string; limit?: number; minRole?: 'core' | 'example' | 'mention' },
  ): Array<{ block: ContentBlock; tags: ContentTag[] }>
  resolveCanonicalKpId?(idOrAlias: string): string | undefined
}

export interface MaterialPart {
  id: string
  kind: string
  label: string
  question: string
  kpIds?: string[]
  required?: boolean
}

export interface SupplementalKp {
  id: string
  name: string
  definition: string
  definitionSource: string
  aliases: string[]
}

export interface MaterialEvidence {
  sourceId: string
  sourceType: 'textbook' | 'news' | 'kp'
  sourceTitle: string
  quote: string
  locator: Record<string, unknown>
  text: string
  kpIds: string[]
}

export const SUPERMARKET_META = {
  id: 'case_regional_supermarkets',
  title: '胖东来、永辉、步步高：同一门生意，三种消费者逻辑',
  subtitle: '区域商超案例 · 消费者、购买角色与学习/忠诚（示例对话·教学示例）',
  companies: ['永辉', '胖东来', '步步高'],
  summary:
    '永辉、胖东来、步步高都在卖生鲜、熟食和日用品。判断顾客是不是消费者，先看购买用途；判断角色，看一次购买里谁发起、谁影响、谁决定、谁付款、谁使用；判断学习与忠诚，则要把“过程”和“结果”分开。',
  sourceNote:
    '案例事实只引用本库新闻原文中可核对的句子；没有原文证据的判断会标为教学推断。对话为教学示例（示例对话），不是学生本人的真实发言。',
}

export const SUPPLEMENTAL_KPS: SupplementalKp[] = [
  {
    id: 'kp_decision_participants',
    name: '购买决策参与者',
    definition:
      '购买决策中的发起者、影响者、决策者、购买者和使用者等角色；同一人可能同时承担多个角色。',
    definitionSource: '补充定义（课程数据暂未收录，非教材原文，未人审）',
    aliases: ['购买角色', '决策参与者', 'buying center', '发起者', '影响者', '决策者', '购买者', '使用者'],
  },
  {
    id: 'kp_organizational_market',
    name: '组织市场',
    definition:
      '为生产、转售或组织运行而购买产品和服务的组织构成的集合；与消费者市场的最终生活消费用途相对。组织市场不等同于产业市场，也不是消费者市场的子概念。',
    definitionSource: '补充定义（课程数据暂未收录，非教材原文，未人审）',
    aliases: ['组织购买'],
  },
  {
    id: 'kp_brand_loyalty',
    name: '品牌忠诚',
    definition:
      '消费者在存在可选替代时，仍对某一品牌保持稳定偏好并重复选择的行为倾向；忠诚是结果/表现，消费者学习是经验导致行为规则变化的过程，两者可以并存但不等同。',
    definitionSource: '补充定义（课程数据暂未收录，非教材原文，未人审）',
    aliases: ['忠诚', '品牌忠诚度', '转换意愿'],
  },
]

export const BUYING_ROLE_NAMES = ['发起者', '影响者', '决策者', '购买者', '使用者'] as const

const TAG_ROLE_LABELS: Record<string, string> = {
  core: '核心',
  example: '例证',
  mention: '提及',
}

export const BUYING_ROLE_DEFINITIONS: Record<(typeof BUYING_ROLE_NAMES)[number], string> = {
  发起者: '最先提出购买需求的人，例如家里人说“没菜了”。',
  影响者: '影响选择标准或候选品牌的人，例如朋友推荐、店员介绍、测评内容。',
  决策者: '最终决定买哪家、买什么、买多少的人。',
  购买者: '实际完成交易或付款的人。',
  使用者: '实际消费或使用商品的人。',
}


/** Verify a quote is a verbatim substring (whitespace-normalized) of a source. */
export function locateQuote(
  source: string,
  quote: string,
): { quote: string; start: number; end: number } | undefined {
  const located = locateSpan(source, quote)
  return located ? { quote: located.span, start: located.start, end: located.end } : undefined
}

export function sentencesOf(text: string): string[] {
  return (text.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 8)
}

/** Pick a real sentence that contains at least one anchor and the most context terms. */
export function bestSentence(
  text: string,
  anchors: string[],
  context: string[] = [],
): string | undefined {
  let best: { sentence: string; score: number } | undefined
  for (const sentence of sentencesOf(text)) {
    if (anchors.length > 0 && !anchors.some((anchor) => sentence.includes(anchor))) continue
    const hits = context.filter((term) => term.length >= 2 && sentence.includes(term)).length
    if (!best || hits > best.score) best = { sentence, score: hits }
  }
  return best?.sentence
}

export function supplementalFor(value: string): SupplementalKp | undefined {
  const lower = value.toLowerCase()
  return SUPPLEMENTAL_KPS.find(
    (kp) =>
      kp.id === value
      || kp.name === value
      || kp.aliases.some((alias) => alias.toLowerCase() === lower),
  )
}

export function partWantsRoles(part: MaterialPart): boolean {
  return part.kind === 'roles'
    || /角色|发起者|影响者|决策者|购买者|使用者|谁买|谁用/.test(`${part.id} ${part.label} ${part.question}`)
}

export function partWantsLoyalty(part: MaterialPart): boolean {
  return /忠诚|学习|复购|打卡|跨城|品牌偏好/.test(`${part.id} ${part.label} ${part.question}`)
}

export function partWantsOrganization(part: MaterialPart): boolean {
  return /组织市场|消费者市场|最终用途|不是组织市场/.test(`${part.id} ${part.label} ${part.question}`)
}

function kpNamesForPart(part: MaterialPart): string[] {
  const names: string[] = []
  if (partWantsOrganization(part)) {
    names.push('组织市场')
    if (/消费者|最终用途|区别|区分|对比|vs|VS|不是/.test(`${part.label} ${part.question}`)) {
      names.push('消费者', '消费者与消费者市场', '消费者市场')
    }
  }
  if (partWantsRoles(part)) names.push('购买决策参与者', '购买决策', '购买角色')
  if (partWantsLoyalty(part)) {
    names.push('学习', '消费者学习')
    if (/忠诚|区别|区分|对比|vs|VS|品牌/.test(`${part.label} ${part.question}`)) names.push('品牌忠诚')
  }
  return names
}

function preferCanonical(items: KnowledgePoint[]): KnowledgePoint[] {
  const rank = (kp: KnowledgePoint): number => (kp.status === 'published' ? 0 : kp.status === 'reviewed' ? 1 : 2)
  const byName = new Map<string, KnowledgePoint>()
  for (const kp of items) {
    const current = byName.get(kp.name)
    if (!current || rank(kp) < rank(current)) byName.set(kp.name, kp)
  }
  return [...byName.values()]
}

export function canonicalChapterKps(db: MaterialDb, chapterId: string): KnowledgePoint[] {
  return preferCanonical(db.listKpsByChapter(chapterId))
}

export function findKp(db: MaterialDb, chapterId: string, value: string): KnowledgePoint | undefined {
  const direct = db.getKp(value)
  if (direct) return direct
  const resolved = db.resolveCanonicalKpId?.(value)
  if (resolved) {
    const canonical = db.getKp(resolved)
    if (canonical) return canonical
  }
  return canonicalChapterKps(db, chapterId).find(
    (kp) => kp.name === value || kp.aliases.includes(value),
  )
}

/**
 * Resolve the course knowledge points for one inquiry part. Supplemental
 * definitions are used only when the course DB has no canonical point; they
 * are labelled as teacher supplements, never as textbook/gold material.
 */
export function selectMaterialKps(
  db: MaterialDb,
  chapterId: string,
  part: MaterialPart,
): { kps: KnowledgePoint[]; supplemental: SupplementalKp[]; missing: string[] } {
  const wantedIds = new Set(part.kpIds ?? [])
  const names = kpNamesForPart(part)
  const chapterKps = canonicalChapterKps(db, chapterId)
  const selected: KnowledgePoint[] = []
  const supplemental: SupplementalKp[] = []
  const missing: string[] = []
  if (names.length === 0 && wantedIds.size === 0) {
    const exact = findKp(db, chapterId, part.label)
    if (exact) selected.push(exact)
  }

  for (const id of wantedIds) {
    const kp = findKp(db, chapterId, id)
    if (kp) selected.push(kp)
    else {
      const fallback = supplementalFor(id)
      if (fallback) supplemental.push(fallback)
      else missing.push(id)
    }
  }

  for (const name of names) {
    const kp = findKp(db, chapterId, name)
    if (kp) selected.push(kp)
    else {
      const fallback = supplementalFor(name)
      if (fallback) {
        if (!supplemental.some((item) => item.id === fallback.id)) supplemental.push(fallback)
      } else if (!missing.includes(name)) {
        missing.push(name)
      }
    }
  }

  if (selected.length === 0 && supplemental.length === 0) {
    const query = part.question.trim()
    if (query.length >= 2) {
      for (const kp of db.searchKps(query, chapterId, 4)) selected.push(kp)
    }
    if (selected.length === 0) {
      const label = part.label.replace(/[和与vsVS、，。！？\s]+/g, ' ').trim()
      for (const kp of chapterKps) {
        if (label.length >= 2 && (label.includes(kp.name) || kp.name.includes(label))) selected.push(kp)
      }
    }
  }

  const deduped = preferCanonical(selected)
  const supplementalDeduped = supplemental.filter(
    (item) => !deduped.some((kp) => kp.id === item.id || kp.name === item.name),
  )
  return { kps: deduped.slice(0, 6), supplemental: supplementalDeduped.slice(0, 3), missing }
}

function chapterMeta(db: MaterialDb, chapterId: string): { chapterTitle: string; chapterNumber: number } {
  const chapter = db.listChapters().find((item) => item.id === chapterId)
  return { chapterTitle: chapter?.title ?? chapterId, chapterNumber: chapter?.number ?? 0 }
}

function blockLocator(
  db: MaterialDb,
  block: ContentBlock,
  chapterId: string,
): { sourceTitle: string; locator: Record<string, unknown> } {
  const chapter = chapterMeta(db, chapterId)
  const section = db.listSections(chapterId).find((item) => item.id === block.section_id)
  const page = block.page ? ` · 第${block.page}页` : ''
  const sectionTitle = section ? ` · ${section.title}` : ''
  return {
    sourceTitle: `教材 · 第${chapter.chapterNumber}章 ${chapter.chapterTitle}${sectionTitle}${page}`,
    locator: {
      blockId: block.id,
      chapterId,
      sectionId: block.section_id,
      sectionTitle: section?.title ?? '',
      page: block.page ?? null,
      source: block.source,
      title: chapter.chapterTitle,
    },
  }
}

function tagMatchesKp(tag: ContentTag, kp: KnowledgePoint, db: MaterialDb): boolean {
  if (tag.tag_type !== 'knowledge_point') return false
  if (tag.tag_key === kp.id || tag.tag_key === kp.name) return true
  if (kp.aliases.includes(tag.tag_key)) return true
  const canonical = db.resolveCanonicalKpId?.(tag.tag_key)
  return canonical !== undefined && canonical === kp.id
}

/**
 * Recall textbook blocks by their controlled tags. If the tag layer is empty,
 * fall back to an exact sentence containing the KP name and label it as
 * keyword recall in the warning list (never as tag-based evidence).
 */
export function collectTextbookEvidence(
  db: MaterialDb,
  chapterId: string,
  kp: KnowledgePoint,
): { items: MaterialEvidence[]; warnings: string[] } {
  const keys = [kp.id, kp.name, ...kp.aliases]
  const warnings: string[] = []
  const items: MaterialEvidence[] = []
  const seen = new Set<string>()

  const accept = (block: ContentBlock, tags: ContentTag[]): void => {
    if (items.length >= 2) return
    if (/知识框图|关键词/.test(block.source)) return
    for (const tag of tags) {
      if (!tagMatchesKp(tag, kp, db)) continue
      if (tag.review_status === 'rejected' || tag.tag_role === 'mention') continue
      const located = locateQuote(block.text, tag.evidence_span)
      if (!located) {
        warnings.push(`教材块 ${block.id} 的标签证据无法在原文定位，已丢弃。`)
        continue
      }
      if (located.quote.trim().length < 20) continue
      if (seen.has(located.quote)) continue
      seen.add(located.quote)
      const meta = blockLocator(db, block, chapterId)
      items.push({
        sourceId: block.id,
        sourceType: 'textbook',
        sourceTitle: meta.sourceTitle,
        quote: located.quote,
        locator: {
          ...meta.locator,
          tagRole: TAG_ROLE_LABELS[tag.tag_role] ?? '提及',
          reviewStatus: tag.review_status ?? 'draft',
        },
        text: block.text,
        kpIds: [kp.id],
      })
      if (items.length >= 2) return
    }
  }

  if (db.findContentBlocksByTags) {
    const found = db.findContentBlocksByTags(keys, { chapterId, limit: 8, minRole: 'example' })
    for (const entry of found) accept(entry.block, entry.tags)
  } else {
    for (const block of db.listBlocks(chapterId)) {
      accept(block, db.getTagsForBlock(block.id))
    }
  }

  if (items.length === 0) {
    const terms = [kp.name, ...kp.keywords].filter((term) => term.length >= 2)
    for (const block of db.listBlocks(chapterId)) {
      if (/知识框图|关键词/.test(block.source)) continue
      const sentence = bestSentence(block.text, [kp.name], terms)
      if (!sentence || sentence.length < 20) continue
      const located = locateQuote(block.text, sentence)
      if (!located || seen.has(located.quote)) continue
      seen.add(located.quote)
      const meta = blockLocator(db, block, chapterId)
      items.push({
        sourceId: block.id,
        sourceType: 'textbook',
        sourceTitle: `${meta.sourceTitle}（关键词定位，非标签召回）`,
        quote: located.quote,
        locator: { ...meta.locator, tagRole: '提及', reviewStatus: 'draft' },
        text: block.text,
        kpIds: [kp.id],
      })
      warnings.push(`「${kp.name}」暂无可用标签块，教材证据改用关键词定位。`)
      break
    }
  }

  return { items, warnings }
}

export function findCaseArticles(
  db: MaterialDb,
  query: string,
  companies: string[],
): NewsArticle[] {
  const articles = db.listNews({ limit: 100 })
  if (companies.length > 0) {
    return articles
      .filter((article) =>
        companies.some((company) => article.title.includes(company) || article.content.includes(company)),
      )
      .slice(0, 6)
  }
  const tokens = query
    .split(/[\s,，。！？；：、]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !/^(案例|分析|新闻|最新|这条|一个|怎么|为什么)$/.test(token))
  const scored = articles
    .map((article) => {
      let score = 0
      for (const token of tokens) {
        if (article.title.includes(token)) score += 4
        if (article.summary.includes(token)) score += 2
        if (article.content.includes(token)) score += 1
      }
      return { article, score }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
  return scored.slice(0, 2).map((item) => item.article)
}

/** Only an explicitly reviewed mapping can turn a news sentence into teaching evidence. */
export function evidenceForPart(
  db: MaterialDb,
  article: NewsArticle,
  part: MaterialPart,
  kpIds: string[],
): MaterialEvidence | undefined {
  const approved = db.getMatches(article.id).filter((match) =>
    kpIds.includes(match.kp_id)
    && (match.review_status === 'reviewed' || match.review_status === 'adjudicated' || match.review_status === 'published')
    && (match.evidence_level === 'verified' || match.evidence_level === 'gold'))
  for (const match of approved) {
    const located = locateQuote(article.content, match.evidence_span)
    if (!located) continue
    return {
      sourceId: article.id,
      sourceType: 'news',
      sourceTitle: `${article.source}${article.published_at ? ` · ${article.published_at.slice(0, 10)}` : ''} · ${article.title}`,
      quote: located.quote,
      locator: {
        title: article.title,
        source: article.source,
        publishedAt: article.published_at,
        url: article.url,
        reviewStatus: match.review_status,
        evidenceLevel: match.evidence_level,
        coveragePart: part.id,
      },
      text: article.content,
      kpIds: [match.kp_id],
    }
  }
  return undefined
}

export function roleSummary(): string {
  return BUYING_ROLE_NAMES.map((name) => `${name}：${BUYING_ROLE_DEFINITIONS[name]}`).join('；')
}

export function learningLoyaltyStandard(): string {
  return [
    '判断标准分两步：',
    '第一步看过程——消费者学习强调经验引起了行为或行为潜能的变化，关键是“下一次的判断规则有没有变”；',
    '第二步看结果——品牌忠诚强调在存在可选替代时仍对某一品牌保持稳定偏好并重复选择，关键是“选择是否稳定、转换意愿是否低”。',
    '两者不是一回事：学习可能导向忠诚，但不必然形成忠诚；便利、合约或转换成本也可能造成重复选择，不能把这种惯性重复直接称为品牌忠诚。',
    '注意：一次跨城打卡只是单次行为，不能单独判定学习或忠诚；学习要看经验是否改变了判断规则，忠诚要看存在可选替代时是否稳定偏好并重复选择。',
  ].join('')
}

export function counterexampleText(): string {
  return [
    '反例一：顾客每周只因顺路、价格低而重复买同一家店，没有形成新的判断规则，不能仅凭复购判定消费者学习，也不必然是品牌忠诚。',
    '反例二：开餐馆的人买土豆用于做菜再卖，哪怕买得不多，也属于组织市场的生产用途，不是消费者市场。',
  ].join('')
}

export function demoNote(): string {
  return '对话是教学示例（示例对话），用于说明概念，不是学生本人的真实发言；请用自己的判断替换示例学生的回答。'
}

export function caseStudyMarkdown(content: CaseStudyContent): string {
  const lines: string[] = [
    `# 案例精讲 · ${content.case.title}`,
    '',
    content.case.subtitle,
    '',
    content.case.summary,
    '',
    `来源说明：${content.case.sourceNote}`,
    '',
  ]
  for (const kp of content.knowledgePoints) {
    lines.push(`## ${kp.name}`)
    lines.push(`定义：${kp.definition}`)
    if (kp.definitionSource) lines.push(`定义来源：${kp.definitionSource}`)
    lines.push(`案例对应：${kp.caseMapping}`)
    for (const item of kp.evidence) {
      const source = item.sourceTitle ? `（${item.sourceTitle}）` : ''
      lines.push(`证据${source}：${item.quote}`)
    }
    lines.push('示例对话（教学示例，用于说明概念，不是你的真实发言）：')
    for (const turn of kp.dialogue) {
      lines.push(`${turn.role === 'student' ? '示例学生' : '营小商（教学示例）'}：${turn.text}`)
    }
    lines.push(`结论：${kp.takeaway}`)
    lines.push(`边界：${kp.boundary}`)
    if (kp.checkQuestion) lines.push(`想一想：${kp.checkQuestion}`)
    lines.push('')
  }
  if (content.transfer.length > 0) {
    lines.push('## 可迁移结论')
    for (const item of content.transfer) lines.push(`- ${item}`)
  }
  if (content.boundaries.length > 0) {
    lines.push('## 边界与反例')
    for (const item of content.boundaries) lines.push(`- ${item}`)
  }
  lines.push('', content.usageNote)
  return lines.filter((line, index, all) => line.length > 0 || all[index - 1] !== '').join('\n')
}
