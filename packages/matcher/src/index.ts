import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import {
  createKpIndex,
  locateSpan,
  TAG_ROLE_WEIGHTS,
  type CaseMatch,
  type IdeologyMatch,
  type IdeologyPoint,
  type KnowledgePoint,
  type MatchCandidate,
  type MatchDiagnostics,
  type MatchResult,
  type NewsArticle,
  type TagRole,
} from '@learning-agent/shared'
import { callStructuredTool, jsonObjectSchema } from '@learning-agent/llm-json'
import type LearningDb from '@learning-agent/db'

declare module '@deepseek-ai/cordis' {
  interface Context {
    matcher: Matcher
  }
}

export interface MatchInput {
  articleId: string
  topK?: number
  /** `false` forces the deterministic three-stage recall path (no model call). */
  useLlm?: boolean
  /** Restrict recall to one chapter's knowledge points. Omitted = whole library. */
  chapterId?: string
}

export interface MatchOutput extends MatchResult {
  diagnostics: MatchDiagnostics
}

const PROMPT_VERSION = 'match-v2'
const SYSTEM_PROMPT = '你是营销知识点标注器。只通过 emit_matches 工具返回结果。证据必须是新闻原文的连续片段，不得改写。'
const RETRY_NOTE = '上一次证据不是原文连续片段。证据必须是原文连续片段，直接复制，不要改写。'
const LLM_FALLBACK = /DEEPSEEK_API_KEY|fetch failed|ECONN|ENOTFOUND|401|403|404|429|5\d\d|not configured|model did not call|invalid JSON|aborted/i

interface RawMatch {
  kp_id?: unknown
  tag_role?: unknown
  confidence?: unknown
  evidence_span?: unknown
  rationale?: unknown
}

interface RawIdeologyMatch {
  ideology_id?: unknown
  confidence?: unknown
  evidence_span?: unknown
  rationale?: unknown
}

interface RawMatches {
  matches?: RawMatch[]
  ideology?: RawIdeologyMatch[]
}

interface TermProfile {
  kp: KnowledgePoint
  terms: Map<string, number>
  text: string
  tagWeight: number
  tagRole: TagRole | undefined
}

function tokenize(value: string): string[] {
  const normalized = value.toLowerCase()
  const tokens: string[] = []
  const latin = normalized.match(/[a-z0-9]{2,}/g) ?? []
  tokens.push(...latin)
  for (const run of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let index = 0; index < run.length - 1; index++) {
      tokens.push(run.slice(index, index + 2))
    }
  }
  return tokens
}

function termCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokenize(value)) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

function cosine(left: Map<string, number>, right: Map<string, number>): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (const [token, count] of left) {
    leftNorm += count * count
    const other = right.get(token)
    if (other) dot += count * other
  }
  for (const count of right.values()) rightNorm += count * count
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

function sentences(content: string): string[] {
  return (content.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 6)
}

function bestSentence(content: string, terms: Map<string, number>): string | undefined {
  let best: { sentence: string; score: number } | undefined
  for (const sentence of sentences(content)) {
    const counts = termCounts(sentence)
    let score = 0
    for (const [token, weight] of terms) {
      if (counts.has(token)) score += weight
    }
    if (score > 0 && (!best || score > best.score)) best = { sentence, score }
  }
  return best?.sentence
}

function roleWeight(role: TagRole | undefined): number {
  return role ? TAG_ROLE_WEIGHTS[role] : 0.3
}

function validRole(value: unknown): value is CaseMatch['tag_role'] {
  return value === 'core' || value === 'example' || value === 'mention'
}

function validConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function knowledgePrompt(points: KnowledgePoint[]): string {
  return points
    .map(
      (point) =>
        `- ${point.id} | ${point.name} | aliases=${point.aliases.join(',')} | ${point.definition}`,
    )
    .join('\n')
}

function ideologyPrompt(points: IdeologyPoint[]): string {
  return points.map((point) => `- ${point.id} | ${point.name} | ${point.definition}`).join('\n')
}

function profileText(point: KnowledgePoint): string {
  return [
    point.name,
    point.name_en,
    ...point.aliases,
    ...point.keywords,
    ...point.examples,
    point.definition,
  ].filter(Boolean).join(' ')
}

function hasStream(value: unknown): value is { stream: unknown } {
  return typeof value === 'object' && value !== null && 'stream' in value && typeof value.stream === 'function'
}

/** Teaching requirements start with a verb; real points are noun phrases. */
const IDEOLOGY_REQUIREMENT_PREFIX = /^(举出|分析|说明|能够|培养|树立|认识|理解|掌握|通过|了解|引导|增强|深刻|正确|全面|强化|加深|明晰|学习|探究|介绍|讨论|运用|把握|体会|感受|明确|学会|提升)/

/**
 * The ideology table mixes real 课程思政点 with the requirement sentences they
 * come from ("举出违背社会营销观的企业营销实例，剖析危害。") and source
 * documents ("中共中央办公厅《…》"). Only noun-phrase names can be matched as
 * points; anything else would surface as a nonsense "思政点".
 */
function plausibleIdeologyPoint(name: string): boolean {
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > 24) return false
  if (/[。！？?《》]/.test(trimmed)) return false
  return !IDEOLOGY_REQUIREMENT_PREFIX.test(trimmed)
}

/**
 * Deterministic three-stage candidate generation: textbook tag inverted
 * recall, lexical char-bigram vector supplement (explicitly non-semantic),
 * then role/quality/diversity ranking. No model call and no network.
 */
export function generateDeterministicMatches(
  db: LearningDb,
  article: NewsArticle,
  topK: number,
  chapterId?: string,
): { matches: CaseMatch[]; ideology: IdeologyMatch[]; notes: string[] } {
  const scoped = chapterId ? db.listKpsByChapter(chapterId) : []
  const points = scoped.length > 0 ? scoped : db.listAllKps()
  const index = createKpIndex(points)
  const blocks = new Map(db.listAllBlocks().map((block) => [block.id, block]))
  const tags = db.listContentTags(chapterId ? { chapterId, limit: 100000 } : { limit: 100000 })
    .filter((tag) => tag.tag_type === 'knowledge_point' && tag.review_status !== 'rejected')
  const notes: string[] = []
  if (tags.length === 0) notes.push('no textbook tags found; tag recall falls back to KP profiles')
  const tagProfiles = new Map<string, { weight: number; terms: Map<string, number>; roles: Map<TagRole, number> }>()
  for (const tag of tags) {
    const kpId = db.resolveCanonicalKpId(tag.tag_key) ?? index.resolve(tag.tag_key)?.id
    if (!kpId) continue
    const entry = tagProfiles.get(kpId) ?? { weight: 0, terms: new Map(), roles: new Map() }
    const weight = TAG_ROLE_WEIGHTS[tag.tag_role] * tag.confidence
    entry.weight += weight
    entry.roles.set(tag.tag_role, (entry.roles.get(tag.tag_role) ?? 0) + weight)
    const block = blocks.get(tag.block_id)
    for (const token of tokenize(`${tag.evidence_span} ${block?.text ?? ''}`)) {
      entry.terms.set(token, (entry.terms.get(token) ?? 0) + weight)
    }
    tagProfiles.set(kpId, entry)
  }

  const articleTerms = termCounts(`${article.title} ${article.summary} ${article.content}`)
  const profiles: TermProfile[] = points.map((kp) => {
    const tagged = tagProfiles.get(kp.id)
    const terms = new Map<string, number>()
    for (const token of tokenize(profileText(kp))) {
      terms.set(token, (terms.get(token) ?? 0) + 1)
    }
    if (tagged) {
      for (const [token, weight] of tagged.terms) {
        terms.set(token, (terms.get(token) ?? 0) + weight * 2)
      }
    }
    const roleEntries = tagged ? [...tagged.roles.entries()].sort((left, right) => right[1] - left[1]) : []
    return {
      kp,
      terms,
      text: profileText(kp),
      tagWeight: tagged?.weight ?? 0,
      tagRole: roleEntries[0]?.[0],
    }
  })

  const tagScores = new Map<string, number>()
  const vectorScores = new Map<string, number>()
  let maxTag = 0
  for (const profile of profiles) {
    let tagScore = 0
    for (const [token, weight] of profile.terms) {
      const hits = articleTerms.get(token) ?? 0
      if (hits > 0) tagScore += Math.min(3, hits) * weight
    }
    const literal = [profile.kp.name, ...profile.kp.aliases]
      .filter((term) => term.length >= 2)
      .reduce((sum, term) => sum + (article.content.includes(term) ? 3 : 0), 0)
    tagScore += literal
    tagScores.set(profile.kp.id, tagScore)
    maxTag = Math.max(maxTag, tagScore)
    vectorScores.set(profile.kp.id, cosine(articleTerms, profile.terms))
  }

  const quality = article.content_status === 'full' ? 1 : article.content_status === 'partial' ? 0.6 : 0.2
  const lengthFactor = Math.min(1, article.content.length / 1200)
  const ranked: CaseMatch[] = []
  for (const profile of profiles) {
    const rawTag = tagScores.get(profile.kp.id) ?? 0
    const tagScore = maxTag > 0 ? Math.min(1, rawTag / maxTag) : 0
    const vectorScore = Math.min(1, (vectorScores.get(profile.kp.id) ?? 0) * 2.5)
    if (tagScore <= 0 && vectorScore < 0.12) continue
    const evidence = bestSentence(article.content, profile.terms)
    if (!evidence) continue
    const located = locateSpan(article.content, evidence)
    if (!located) continue
    const role: TagRole = profile.tagRole ?? (tagScore >= 0.6 ? 'core' : tagScore >= 0.4 ? 'example' : 'mention')
    const score = Number(
      Math.min(
        0.98,
        0.5 * tagScore + 0.25 * vectorScore + 0.15 * roleWeight(role) + 0.1 * quality * lengthFactor,
      ).toFixed(2),
    )
    ranked.push({
      article_id: article.id,
      kp_id: profile.kp.id,
      score,
      confidence: score,
      tag_role: role,
      evidence_span: located.span,
      evidence_start: located.start,
      evidence_end: located.end,
      rationale: `规则候选：标签倒排=${tagScore.toFixed(2)}；词法向量=${vectorScore.toFixed(2)}（非语义）；角色权重=${roleWeight(role).toFixed(2)}；来源质量=${(quality * lengthFactor).toFixed(2)}`,
      method: 'rule',
      review_status: 'draft',
      evidence_level: 'auto',
      version: 'v0.1',
      reviewer_id: '',
      reviewed_at: '',
      created_at: new Date().toISOString(),
    })
  }

  ranked.sort((left, right) => right.score - left.score)
  const selected: CaseMatch[] = []
  const sectionCounts = new Map<string, number>()
  const kpById = new Map(points.map((point) => [point.id, point]))
  for (const candidate of ranked) {
    if (selected.length >= topK) break
    const section = kpById.get(candidate.kp_id)?.section_id ?? ''
    const count = sectionCounts.get(section) ?? 0
    const adjusted = candidate.score * (1 - Math.min(0.3, count * 0.15))
    if (count >= 2) continue
    if (adjusted < 0.18) continue
    selected.push({ ...candidate, score: Number(adjusted.toFixed(2)), confidence: Number(adjusted.toFixed(2)) })
    sectionCounts.set(section, count + 1)
  }

  // Ideology rows mix real points with textbook *requirements* ("举出…实例",
  // "理解…") and source documents. Matching those by token overlap against a
  // news article produces noise, so only plausible point names are considered
  // and the evidence must hit at least two distinct name terms.
  const ideology: IdeologyMatch[] = []
  for (const point of db.listIdeology()) {
    if (!plausibleIdeologyPoint(point.name)) continue
    const terms = termCounts(`${point.name} ${point.examples.join(' ')}`)
    if (terms.size === 0) continue
    const evidence = bestSentence(article.content, terms)
    if (!evidence) continue
    const hits = [...terms.keys()].filter((term) => evidence.includes(term)).length
    if (hits < Math.min(2, terms.size)) continue
    const located = locateSpan(article.content, evidence)
    if (!located) continue
    const confidence = Number(Math.min(0.6, 0.2 + 0.1 * hits).toFixed(2))
    ideology.push({
      article_id: article.id,
      ideology_id: point.id,
      confidence,
      evidence_span: located.span,
      rationale: `规则候选：课程思政词法命中 ${hits} 处（非语义）`,
      review_status: 'draft',
      evidence_level: 'auto',
      version: 'v0.1',
      reviewer_id: '',
      reviewed_at: '',
    })
  }
  ideology.sort((left, right) => right.confidence - left.confidence)
  return { matches: selected, ideology: ideology.slice(0, topK), notes }
}

export class Matcher extends Service {
  static inject = ['learningDb', 'llm']

  constructor(ctx: Context) {
    super(ctx, 'matcher')
  }

  /**
   * Stored candidates only; no model call. If none exist (or refresh=true),
   * runs the deterministic tag/lexical/rank pipeline and persists draft rows.
   * This is the API teaching surfaces should use for "candidate, not answer".
   */
  async candidates(
    articleId: string,
    opts: { topK?: number; refresh?: boolean; chapterId?: string } = {},
  ): Promise<MatchCandidate[]> {
    const article = this.ctx.learningDb.getNews(articleId)
    if (!article) throw new Error(`news article not found: ${articleId}`)
    const topK = Math.min(Math.max(opts.topK ?? 3, 1), 10)
    const chapterId = opts.chapterId
    if (!opts.refresh) {
      const stored = this.ctx.learningDb.getMatchCandidates(articleId, { topK, chapterId })
      const usable = stored.filter((candidate) => candidate.reviewStatus !== 'rejected')
      if (usable.length > 0) return usable
    }
    const deterministic = this.deterministic(article, topK, chapterId)
    this.ctx.learningDb.upsertMatches(articleId, deterministic.matches, deterministic.ideology, { chapterId })
    return this.ctx.learningDb.getMatchCandidates(articleId, { topK, chapterId })
  }

  /**
   * Whole-library auto tagging for articles whose text was never tagged (or
   * changed since). Deliberately chapter-free: a backfilled article carries
   * candidates from every chapter, so chapter-scoped surfaces can filter later.
   */
  async backfill(limit = 20): Promise<{ processed: number; tagged: number; errors: number }> {
    const pending = this.ctx.learningDb.listNewsNeedingTags(limit)
    let processed = 0
    let tagged = 0
    let errors = 0
    for (const article of pending) {
      processed += 1
      try {
        await this.candidates(article.id, { topK: 3, refresh: true })
        if (this.ctx.learningDb.getMatches(article.id).length > 0) tagged += 1
      } catch (error) {
        errors += 1
        this.ctx.logger('learning-matcher').warn(
          `backfill failed for ${article.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return { processed, tagged, errors }
  }

  async match(input: MatchInput, signal?: AbortSignal): Promise<MatchOutput> {
    const article = this.ctx.learningDb.getNews(input.articleId)
    if (!article) throw new Error(`news article not found: ${input.articleId}`)
    const topK = Math.min(Math.max(input.topK ?? 3, 1), 10)
    if (article.content.length < 300) {
      return {
        matches: [],
        ideology: [],
        diagnostics: {
          stages: [],
          degraded: true,
          vector: 'lexical-hash',
          semantic: false,
          notes: ['article content shorter than 300 characters; no candidates'],
          candidates: 0,
          llm: false,
        },
      }
    }

    const points = this.chapterPoints(input.chapterId)
    const ideologyPoints = this.ctx.learningDb.listIdeology()
    const deterministic = this.deterministic(article, topK, input.chapterId)
    const notes = [...deterministic.notes]
    let matches = deterministic.matches
    let ideology = deterministic.ideology
    let usedLlm = false
    let stages = ['tag-inverted-recall', 'lexical-vector-supplement', 'role-quality-diversity-rank']

    const contentHash = createHash('sha256').update(article.content).digest('hex')
    const cacheKey = `cache/${article.id}/${input.chapterId ?? 'all'}`
    const cached = this.ctx.learningDb.getState<{
      content_hash: string
      prompt_version: string
      matches: CaseMatch[]
      ideology: IdeologyMatch[]
    }>('matcher', cacheKey)
    if (cached && cached.content_hash === contentHash && cached.prompt_version === PROMPT_VERSION) {
      const cachedMatches = cached.matches.map((match) => ({
        ...match,
        review_status: match.review_status ?? 'draft',
        evidence_level: match.evidence_level ?? 'auto',
        version: match.version ?? 'v0.1',
        reviewer_id: match.reviewer_id ?? '',
        reviewed_at: match.reviewed_at ?? '',
      }))
      this.ctx.learningDb.upsertMatches(article.id, cachedMatches, cached.ideology, {
        chapterId: input.chapterId,
      })
      return {
        matches: cachedMatches,
        ideology: cached.ideology,
        diagnostics: {
          stages: ['cache'],
          degraded: true,
          vector: 'lexical-hash',
          semantic: false,
          notes: ['cached candidates'],
          candidates: cached.matches.length,
          llm: cached.matches.some((match) => match.method === 'llm'),
        },
      }
    }

    const llm = this.ctx.get('llm')
    if (input.useLlm !== false && hasStream(llm)) {
      try {
        const prompt = this.buildPrompt(article, points, ideologyPoints)
        let accepted = this.validate(await this.callModel(prompt, signal), article, points, ideologyPoints, topK)
        if (accepted.dropped > 0) {
          accepted = this.validate(
            await this.callModel(`${prompt}\n\n${RETRY_NOTE}`, signal),
            article,
            points,
            ideologyPoints,
            topK,
          )
        }
        if (accepted.matches.length > 0) {
          matches = accepted.matches
          ideology = accepted.ideology
          usedLlm = true
          stages = ['llm-tagging', ...stages]
          notes.push('LLM tagging accepted; auto candidates still require review')
        } else {
          notes.push('LLM returned no valid candidates; deterministic recall used')
        }
      } catch (error) {
        signal?.throwIfAborted()
        const message = error instanceof Error ? error.message : String(error)
        if (!LLM_FALLBACK.test(message)) throw error
        notes.push(`LLM unavailable: ${message}`)
      }
    } else {
      notes.push('LLM not configured; deterministic recall used')
    }

    this.ctx.learningDb.upsertMatches(article.id, matches, ideology, { chapterId: input.chapterId })
    this.ctx.learningDb.setState('matcher', cacheKey, {
      content_hash: contentHash,
      prompt_version: PROMPT_VERSION,
      matches,
      ideology,
    })
    return {
      matches,
      ideology,
      diagnostics: {
        stages,
        degraded: true,
        vector: 'lexical-hash',
        semantic: false,
        notes,
        candidates: matches.length,
        llm: usedLlm,
      },
    }
  }

  private chapterPoints(chapterId?: string): KnowledgePoint[] {
    if (chapterId) {
      const chapter = this.ctx.learningDb.listKpsByChapter(chapterId)
      if (chapter.length > 0) return chapter
    }
    return this.ctx.learningDb.listAllKps()
  }

  private deterministic(article: NewsArticle, topK: number, chapterId?: string): {
    matches: CaseMatch[]
    ideology: IdeologyMatch[]
    notes: string[]
  } {
    return generateDeterministicMatches(this.ctx.learningDb, article, topK, chapterId)
  }

  private buildPrompt(
    article: NewsArticle,
    points: KnowledgePoint[],
    ideologyPoints: IdeologyPoint[],
  ): string {
    const content = article.content.slice(0, 6000)
    const ideologySection = ideologyPoints.length > 0
      ? `\n\n课程思政点候选：\n${ideologyPrompt(ideologyPoints)}`
      : ''
    return [
      `文章标题：${article.title}`,
      `来源：${article.source}｜发布时间：${article.published_at}`,
      '',
      '文章正文：',
      content,
      '',
      '消费者行为知识点候选：',
      knowledgePrompt(points),
      ideologySection,
      '',
      '请找出新闻中确实体现的知识点，最多返回 3 条。每条证据必须从正文中直接复制连续片段。',
    ].join('\n')
  }

  private async callModel(prompt: string, signal?: AbortSignal): Promise<RawMatches> {
    return callStructuredTool<RawMatches>({
      ctx: this.ctx,
      system: SYSTEM_PROMPT,
      prompt,
      toolName: 'emit_matches',
      toolDescription: '返回新闻与知识点、课程思政点的匹配结果。',
      parameters: jsonObjectSchema(
        {
          matches: {
            type: 'array',
            items: jsonObjectSchema(
              {
                kp_id: { type: 'string' },
                tag_role: { type: 'string', enum: ['core', 'example', 'mention'] },
                confidence: { type: 'number' },
                evidence_span: { type: 'string' },
                rationale: { type: 'string' },
              },
              ['kp_id', 'tag_role', 'confidence', 'evidence_span', 'rationale'],
            ),
          },
          ideology: {
            type: 'array',
            items: jsonObjectSchema(
              {
                ideology_id: { type: 'string' },
                confidence: { type: 'number' },
                evidence_span: { type: 'string' },
                rationale: { type: 'string' },
              },
              ['ideology_id', 'confidence', 'evidence_span', 'rationale'],
            ),
          },
        },
        ['matches', 'ideology'],
      ),
      signal,
      maxTokens: 4096,
    })
  }

  private validate(
    raw: RawMatches,
    article: NewsArticle,
    points: KnowledgePoint[],
    ideologyPoints: IdeologyPoint[],
    topK: number,
  ): { matches: CaseMatch[]; ideology: IdeologyMatch[]; dropped: number } {
    const allowed = new Set(points.map((point) => point.id))
    const allowedIdeology = new Set(ideologyPoints.map((point) => point.id))
    const matches: CaseMatch[] = []
    const ideology: IdeologyMatch[] = []
    let dropped = 0

    for (const item of raw.matches ?? []) {
      const kpId = typeof item.kp_id === 'string' ? item.kp_id : ''
      const role = item.tag_role
      const confidence = item.confidence
      const span = typeof item.evidence_span === 'string' ? item.evidence_span : ''
      const located = locateSpan(article.content, span)
      if (!allowed.has(kpId) || !validRole(role) || !validConfidence(confidence) || !located) {
        dropped += 1
        continue
      }
      matches.push({
        article_id: article.id,
        kp_id: kpId,
        score: confidence,
        confidence,
        tag_role: role,
        evidence_span: located.span,
        evidence_start: located.start,
        evidence_end: located.end,
        rationale: typeof item.rationale === 'string' ? item.rationale : '',
        method: 'llm',
        review_status: 'draft',
        evidence_level: 'auto',
        version: 'v0.1',
        reviewer_id: '',
        reviewed_at: '',
        created_at: new Date().toISOString(),
      })
    }

    for (const item of raw.ideology ?? []) {
      const ideologyId = typeof item.ideology_id === 'string' ? item.ideology_id : ''
      const confidence = item.confidence
      const span = typeof item.evidence_span === 'string' ? item.evidence_span : ''
      const located = locateSpan(article.content, span)
      if (!allowedIdeology.has(ideologyId) || !validConfidence(confidence) || !located) {
        dropped += 1
        continue
      }
      ideology.push({
        article_id: article.id,
        ideology_id: ideologyId,
        confidence,
        evidence_span: located.span,
        rationale: typeof item.rationale === 'string' ? item.rationale : '',
        review_status: 'draft',
        evidence_level: 'auto',
        version: 'v0.1',
        reviewer_id: '',
        reviewed_at: '',
      })
    }

    matches.sort((a, b) => b.confidence - a.confidence)
    return { matches: matches.slice(0, topK), ideology: ideology.slice(0, topK), dropped }
  }
}

const jsonOutput = <const S extends ValueSchemaSpec>(schema: S) => ({
  schema,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
})

export const name = 'learning-matcher'
export const inject = ['tools', 'learningDb']

export function apply(ctx: Context) {
  ctx.plugin(Matcher)
  ctx.tools.register(
    defineTool({
      name: 'match_news',
      description: '把一条新闻匹配到第4章消费者行为知识点和课程思政点，证据句来自原文。',
      parameters: {
        article_id: { type: 'string', required: true },
        top_k: { type: 'integer' },
      },
      output: jsonOutput({
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: { type: 'array', items: { type: 'object', additionalProperties: true } },
          ideology: { type: 'array', items: { type: 'object', additionalProperties: true } },
          diagnostics: { type: 'object', additionalProperties: true },
        },
      }),
      async execute(args, exec) {
        return ctx.matcher.match({ articleId: args.article_id, topK: args.top_k }, exec.signal)
      },
    }),
  )
}
