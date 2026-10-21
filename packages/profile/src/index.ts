import { Service, type Context } from '@deepseek-ai/cordis'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { callStructuredTool, jsonObjectSchema } from '@learning-agent/llm-json'
import type {
  Competency,
  Evidence,
  GrowthSnapshot,
  LearningPlanItem,
  MemoryEpisode,
  MemoryFact,
  StudentProfile,
} from '@learning-agent/shared'
import { locateSpan, stableId } from '@learning-agent/shared'
import type {} from '@learning-agent/db'

declare module '@deepseek-ai/cordis' {
  interface Context {
    profile: ProfileService
  }
}

export interface ExtractEvidenceInput {
  studentId: string
  sessionId: string
  chapterId?: string
  sourceType?: Evidence['source_type']
  sourceId?: string
  messages: Array<{ id?: string; role: 'user' | 'assistant'; content: string; createdAt?: string }>
  signal?: AbortSignal
}

export interface GrowthSummaryItem {
  competency: Competency
  level: GrowthSnapshot['level']
  confidence: number
  evidenceCount: number
  status: '进步' | '停滞' | '证据不足' | '待验证'
  preLevel?: GrowthSnapshot['level']
  postLevel?: GrowthSnapshot['level']
  latestEvidence?: Evidence
}

const LEVEL_VALUE: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4, unknown: 0 }
const LEVEL_NAME: Record<number, GrowthSnapshot['level']> = { 1: 'L1', 2: 'L2', 3: 'L3', 4: 'L4', 0: 'unknown' }
const STRENGTH_WEIGHT: Record<string, number> = { A: 4, B: 3, C: 2, D: 1 }

/**
 * Synthetic demo evidence (seeded examples) must never be presented as real
 * student growth or a quality anchor.
 */
export function isSyntheticEvidence(
  evidence: Pick<Evidence, 'id' | 'method' | 'metadata'>,
): boolean {
  const metadata = evidence.metadata ?? {}
  return metadata.synthetic === true
    || metadata.synthetic === 'true'
    || metadata.seed === 'evidence_seed.yaml'
    || evidence.id.startsWith('ev_demo_')
    || String(evidence.method) === 'synthetic'
}

/** Ability evidence: student-authored, not rejected, not participation-only. */
export function isAbilityEvidence(evidence: Evidence): boolean {
  return !isSyntheticEvidence(evidence)
    && evidence.review_status !== 'rejected'
    && evidence.strength !== 'D'
}

function weightedLevel(evidence: Evidence[]): { level: GrowthSnapshot['level']; confidence: number; count: number } {
  const usable = evidence.filter(isAbilityEvidence)
  if (usable.length === 0) return { level: 'unknown', confidence: 0, count: 0 }
  // A single conversation-level observation (C) cannot determine a level.
  // D is participation/self-report and is excluded entirely.
  if (usable.every((item) => item.strength === 'C') && usable.length < 2) {
    return { level: 'unknown', confidence: 0, count: usable.length }
  }
  const rows = usable
    .map((item) => ({
      level: LEVEL_VALUE[item.level] ?? 0,
      weight: (STRENGTH_WEIGHT[item.strength] ?? 1) * item.confidence,
    }))
    .filter((row) => row.level > 0 && row.weight > 0)
    .sort((left, right) => left.level - right.level)
  if (rows.length === 0) return { level: 'unknown', confidence: 0, count: usable.length }
  const total = rows.reduce((sum, row) => sum + row.weight, 0)
  let cumulative = 0
  let chosen = rows[0]!.level
  for (const row of rows) {
    cumulative += row.weight
    chosen = row.level
    if (cumulative >= total / 2) break
  }
  const confidence = Math.min(1, 0.15 * total) * (usable.length < 2 ? 0.6 : 1)
  return { level: LEVEL_NAME[chosen] ?? 'unknown', confidence: Number(confidence.toFixed(2)), count: usable.length }
}

export class ProfileService extends Service {
  static inject = ['learningDb', 'llm']

  constructor(ctx: Context) {
    super(ctx, 'profile')
  }

  getProfile(studentId: string): {
    profile: StudentProfile | undefined
    competencies: Competency[]
    plan: LearningPlanItem[]
    evidence: Evidence[]
    growth: GrowthSummaryItem[]
  } {
    const profile = this.ctx.learningDb.getStudentProfile(studentId)
    const competencies = this.ctx.learningDb.listCompetencies()
    const plan = this.ctx.learningDb.listLearningPlan(studentId)
    const evidence = this.ctx.learningDb
      .listEvidence({ studentId, limit: 500 })
      .filter((item) => !isSyntheticEvidence(item))
    return {
      profile,
      competencies,
      plan,
      evidence,
      growth: this.growthSummary(studentId),
    }
  }

  memorySummary(studentId: string): {
    headline: string
    facts: MemoryFact[]
    episodes: MemoryEpisode[]
  } {
    const facts = this.ctx.learningDb.listMemoryFacts(studentId)
    const episodes = this.ctx.learningDb.listMemoryEpisodes(studentId, 8)
    const goals = facts.filter((fact) => fact.kind === 'goal').map((fact) => String(fact.value))
    const preferences = facts.filter((fact) => fact.kind === 'preference').map((fact) => `${fact.key}: ${String(fact.value)}`)
    const constraints = facts.filter((fact) => fact.kind === 'constraint').map((fact) => String(fact.value))
    const headline = [
      goals.length > 0 ? `目标：${goals.slice(0, 2).join('；')}` : '',
      preferences.length > 0 ? `偏好：${preferences.slice(0, 2).join('；')}` : '',
      constraints.length > 0 ? `约束：${constraints.slice(0, 2).join('；')}` : '',
    ].filter((line) => line.length > 0).join('。')
    return { headline, facts, episodes }
  }

  upsertMemoryFact(input: {
    studentId: string
    kind: MemoryFact['kind']
    key: string
    value: unknown
  }): MemoryFact {
    const fact: MemoryFact = {
      id: stableId('mem', `${input.studentId}:${input.kind}:${input.key}`),
      student_id: input.studentId,
      kind: input.kind,
      key: input.key,
      value: input.value,
      confidence: 0.9,
      source: 'student-correction',
      updated_at: new Date().toISOString(),
    }
    this.ctx.learningDb.upsertMemoryFact(fact)
    return fact
  }

  deleteMemoryFact(id: string): void {
    this.ctx.learningDb.deleteMemoryFact(id)
  }

  listEvidence(studentId: string, opts: { competencyId?: string; chapterId?: string; limit?: number } = {}): Evidence[] {
    return this.ctx.learningDb
      .listEvidence({ studentId, ...opts })
      .filter((item) => !isSyntheticEvidence(item))
  }

  /**
   * Extract evidence candidates from student-authored messages only. Returns
   * unpersisted rows: RecorderAgent is the single writer of `evidence`.
   */
  async extractEvidence(input: ExtractEvidenceInput): Promise<Evidence[]> {
    const studentMessages = input.messages
      .filter((message) => message.role === 'user' && message.content.trim().length > 0)
    const studentText = studentMessages.map((message) => message.content).join('\n\n').trim()
    if (studentText.length < 8) return []
    const competencies = this.ctx.learningDb.listCompetencies()
    if (competencies.length === 0) return []
    const profile = this.ctx.learningDb.getStudentProfile(input.studentId)
    const prompt = this.buildExtractionPrompt(profile, competencies, studentText, input.chapterId)
    let raw = await this.callExtraction(prompt, input.signal)
    let accepted = this.validateExtraction(raw, studentMessages, competencies, input)
    if (accepted.length === 0 && raw.evidence.length > 0) {
      raw = await this.callExtraction(`${prompt}\n\n上一次的 excerpt 不是学生原话。请只复制学生原话中的连续片段。`, input.signal)
      accepted = this.validateExtraction(raw, studentMessages, competencies, input)
    }
    return accepted
  }

  private buildExtractionPrompt(
    profile: StudentProfile | undefined,
    competencies: Competency[],
    studentText: string,
    chapterId?: string,
  ): string {
    const rubric = competencies.map((competency) => [
      `${competency.id} | ${competency.name} | ${competency.definition}`,
      ...competency.levels.map((level) => `  ${level.level}: ${level.description}`),
    ].join('\n')).join('\n\n')
    return [
      '你是商科学习评价的证据抽取器。只从“学生原话”中抽取证据，不能把 AI 的话当证据。',
      '学生只是在提问、说“我会了/懂了”、报告参与次数或复述 AI 结论时，不算能力证据。',
      '只有学生自己的推理、判断、取舍或证据使用才能支撑能力等级；没有可支撑的原文时返回空数组，不要硬凑。',
      `学生：${profile?.name ?? '学生'}；章节：${chapterId ?? '未指定'}`,
      '',
      '能力 rubric：',
      rubric,
      '',
      '学生原话：',
      studentText,
      '',
      '对每个维度，判断是否有学生原话能支撑 L1-L4 中的某一级。',
      'strength：A=独立跨情境任务，B=有过程记录的复杂任务，C=单次对话，D=参与度/自评（D 不要作为能力证据）。',
      'evidence_type：explanation/decision/hypothesis/evidence_use/tradeoff/communication/reflection/artifact。',
      'excerpt 必须逐字复制学生原话的连续片段；rationale 说明为什么支持该水平；confidence 0-1。',
    ].join('\n')
  }

  private async callExtraction(prompt: string, signal?: AbortSignal): Promise<{
    evidence: Array<{
      competency_id?: unknown
      level?: unknown
      strength?: unknown
      evidence_type?: unknown
      excerpt?: unknown
      rationale?: unknown
      confidence?: unknown
    }>
  }> {
    return callStructuredTool({
      ctx: this.ctx,
      system: '你是学习证据抽取器。只通过 emit_evidence 返回结果。',
      prompt,
      toolName: 'emit_evidence',
      toolDescription: '返回从学生原话中抽取的能力证据。',
      parameters: jsonObjectSchema(
        {
          evidence: {
            type: 'array',
            items: jsonObjectSchema(
              {
                competency_id: { type: 'string' },
                level: { type: 'string', enum: ['L1', 'L2', 'L3', 'L4'] },
                strength: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
                evidence_type: { type: 'string', enum: ['explanation', 'decision', 'hypothesis', 'evidence_use', 'tradeoff', 'communication', 'reflection', 'artifact'] },
                excerpt: { type: 'string' },
                rationale: { type: 'string' },
                confidence: { type: 'number' },
              },
              ['competency_id', 'level', 'strength', 'evidence_type', 'excerpt', 'rationale', 'confidence'],
            ),
          },
        },
        ['evidence'],
      ),
      signal,
      maxTokens: 2048,
    }) as Promise<{ evidence: Array<Record<string, unknown>> }>
  }

  private validateExtraction(
    raw: { evidence: Array<Record<string, unknown>> },
    studentMessages: Array<{ id?: string; content: string; createdAt?: string }>,
    competencies: Competency[],
    input: ExtractEvidenceInput,
  ): Evidence[] {
    const allowed = new Set(competencies.map((competency) => competency.id))
    const output: Evidence[] = []
    const seen = new Set<string>()
    for (const item of raw.evidence ?? []) {
      const competencyId = typeof item.competency_id === 'string' ? item.competency_id : ''
      const level = typeof item.level === 'string' ? item.level : ''
      const strength = typeof item.strength === 'string' ? item.strength : ''
      const evidenceType = typeof item.evidence_type === 'string' ? item.evidence_type : ''
      const excerpt = typeof item.excerpt === 'string' ? item.excerpt.trim() : ''
      const confidence = typeof item.confidence === 'number' ? item.confidence : 0
      if (!allowed.has(competencyId)) continue
      if (level !== 'L1' && level !== 'L2' && level !== 'L3' && level !== 'L4') continue
      // D is participation/self-report, never ability evidence.
      if (strength !== 'A' && strength !== 'B' && strength !== 'C') continue
      if (!['explanation', 'decision', 'hypothesis', 'evidence_use', 'tradeoff', 'communication', 'reflection', 'artifact'].includes(evidenceType)) continue
      if (confidence < 0 || confidence > 1) continue
      if (excerpt.length < 4) continue
      if (/^(我)?(会了|懂了|明白了|学会了|知道了)[。！!]*$/.test(excerpt)) continue
      const match = studentMessages
        .map((message) => ({ message, located: locateSpan(message.content, excerpt) }))
        .find((entry) => entry.located !== undefined)
      if (!match?.located) continue
      const sourceId = match.message.id ?? input.sourceId ?? ''
      const occurredAt = match.message.createdAt ?? new Date().toISOString()
      const id = stableId(
        'ev',
        `${input.studentId}:${competencyId}:${input.sessionId}:${sourceId}:${match.located.span}`,
      )
      if (seen.has(id)) continue
      seen.add(id)
      output.push({
        id,
        student_id: input.studentId,
        competency_id: competencyId,
        level,
        strength,
        evidence_type: evidenceType as Evidence['evidence_type'],
        source_type: input.sourceType ?? 'chat',
        source_id: sourceId,
        chapter_id: input.chapterId ?? '',
        session_id: input.sessionId,
        excerpt: match.located.span,
        rationale: typeof item.rationale === 'string' ? item.rationale : '',
        confidence,
        method: 'llm',
        review_status: 'draft',
        review_note: '',
        occurred_at: occurredAt,
        created_at: occurredAt,
        metadata: {
          messageId: match.message.id ?? '',
          origin: 'chat_extraction',
        },
      })
    }
    return output
  }

  recordSnapshot(studentId: string, chapterId: string, checkpoint: 'pre' | 'post'): GrowthSnapshot[] {
    const competencies = this.ctx.learningDb.listCompetencies()
    const plan = this.ctx.learningDb.listLearningPlan(studentId, chapterId)
    const checkpointPlan = plan.find((item) => item.phase === checkpoint)
    const until = checkpointPlan?.due_at || new Date().toISOString()
    const evidence = this.ctx.learningDb
      .listEvidence({ studentId, chapterId, limit: 500 })
      .filter((item) => item.occurred_at <= until && isAbilityEvidence(item))
    const created = new Date().toISOString()
    const existing = this.ctx.learningDb
      .listGrowthSnapshots(studentId, chapterId)
      .filter((item) => item.checkpoint === checkpoint)
    const snapshots: GrowthSnapshot[] = competencies.map((competency) => {
      const relevant = evidence.filter((item) => item.competency_id === competency.id)
      const level = weightedLevel(relevant)
      const baseId = `${studentId}:${chapterId}:${checkpoint}:${competency.id}`
      const same = existing.filter((item) => item.competency_id === competency.id)
      const latest = same.at(-1)
      const latestSupported = latest
        ? evidence.filter((item) =>
            item.competency_id === competency.id && item.occurred_at <= latest.created_at,
          ).length >= latest.evidence_count
        : false
      const unchanged = latest
        && latestSupported
        && latest.level === level.level
        && latest.evidence_count === level.count
      // A demo/synthetic snapshot must be replaceable by a real one. Keep the
      // deterministic id only when the value is unchanged.
      const id = unchanged
        ? latest.id
        : same.some((item) => item.id === baseId)
          ? `${baseId}:${created}`
          : baseId
      return {
        id,
        student_id: studentId,
        chapter_id: chapterId,
        checkpoint,
        competency_id: competency.id,
        level: level.level,
        confidence: level.confidence,
        evidence_count: level.count,
        summary: '',
        created_at: created,
      }
    })
    for (const snapshot of snapshots) this.ctx.learningDb.insertGrowthSnapshot(snapshot)
    return snapshots
  }

  growthSummary(studentId: string, chapterId?: string): GrowthSummaryItem[] {
    const competencies = this.ctx.learningDb.listCompetencies()
    const evidence = this.ctx.learningDb.listEvidence({ studentId, chapterId, limit: 500 })
    const snapshots = this.ctx.learningDb.listGrowthSnapshots(studentId, chapterId)
    return competencies.map((competency) => {
      const relevant = evidence.filter((item) => item.competency_id === competency.id)
      const current = weightedLevel(relevant)
      // A stored snapshot only counts when enough real ability evidence
      // existed by its creation time. Synthetic demo snapshots are ignored.
      const supported = (snapshot: GrowthSnapshot): boolean => {
        if (snapshot.level !== 'unknown' && snapshot.evidence_count === 0) return false
        return evidence.filter((item) =>
          isAbilityEvidence(item)
          && item.competency_id === snapshot.competency_id
          && item.occurred_at <= snapshot.created_at,
        ).length >= snapshot.evidence_count
      }
      const pre = snapshots
        .filter((item) =>
          item.competency_id === competency.id && item.checkpoint === 'pre' && supported(item),
        )
        .at(-1)
      const post = snapshots
        .filter((item) =>
          item.competency_id === competency.id && item.checkpoint === 'post' && supported(item),
        )
        .at(-1)
      let status: GrowthSummaryItem['status'] = '待验证'
      if (current.level === 'unknown') {
        status = '证据不足'
      } else if (pre && post && pre.level !== 'unknown' && post.level !== 'unknown') {
        status = (LEVEL_VALUE[post.level] ?? 0) > (LEVEL_VALUE[pre.level] ?? 0)
          ? '进步'
          : '停滞'
      }
      return {
        competency,
        level: current.level,
        confidence: current.confidence,
        evidenceCount: current.count,
        status,
        preLevel: pre?.level,
        postLevel: post?.level,
        latestEvidence: relevant.find(isAbilityEvidence),
      }
    })
  }

  chatContext(studentId: string, chapterId?: string): string {
    const profile = this.ctx.learningDb.getStudentProfile(studentId)
    const growth = this.growthSummary(studentId, chapterId)
    const plan = this.ctx.learningDb.listLearningPlan(studentId, chapterId)
    const recent = this.ctx.learningDb
      .listEvidence({ studentId, chapterId, limit: 50 })
      .filter(isAbilityEvidence)
      .slice(0, 5)
    return [
      `学生：${profile?.name ?? studentId}（${profile?.cohort ?? ''}）`,
      `目标：${profile?.goals.join('；') ?? '未填写'}`,
      `偏好：${JSON.stringify(profile?.preferences ?? {})}`,
      `约束：${profile?.constraints.join('；') ?? '无'}`,
      '',
      '当前能力水平：',
      ...growth.map((item) => `- ${item.competency.name}: ${item.level}（置信度 ${item.confidence}，证据 ${item.evidenceCount} 条，${item.status}）`),
      '',
      '当前章节计划：',
      ...plan.map((item) => `- ${item.chapter_id} ${item.phase}: ${item.title} [${item.status}] ${item.tasks.join(' / ')}`),
      '',
      '最近证据：',
      ...recent.map((item) => `- ${item.competency_id} ${item.level} ${item.strength}: ${item.excerpt}`),
    ].join('\n')
  }

  async generateGrowthCard(studentId: string, chapterId?: string, signal?: AbortSignal): Promise<string> {
    const summary = this.growthSummary(studentId, chapterId)
    const evidence = this.ctx.learningDb
      .listEvidence({ studentId, chapterId, limit: 100 })
      .filter(isAbilityEvidence)
    const prompt = [
      '根据以下能力状态和证据，写一张中文“能力成长卡”。',
      '结构：每个维度一段；当前水平、变化、支持证据、反例/待验证、下一步建议。',
      '证据不足的维度必须写“证据不足”，不要强行给结论。不要编造证据。',
      '',
      ...summary.map((item) => [
        `## ${item.competency.name}`,
        `当前：${item.level}；置信度 ${item.confidence}；证据 ${item.evidenceCount} 条；结论 ${item.status}`,
        ...evidence.filter((ev) => ev.competency_id === item.competency.id).slice(0, 5).map((ev) => `- ${ev.level}/${ev.strength}：${ev.excerpt}（${ev.rationale}）`),
      ].join('\n')),
    ].join('\n')
    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      system: '你是商科学习评价教练。只依据给定证据写成长卡，证据不足要明确说明。',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 2048,
      signal,
    })) {
      assembler.push(chunk)
    }
    return assembler.blocks()
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
  }
}
