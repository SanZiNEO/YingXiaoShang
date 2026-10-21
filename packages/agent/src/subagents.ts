import type { Context } from '@deepseek-ai/cordis'
import type {
  Citation,
  EvidenceCandidate,
  KnowledgePoint,
  NewsArticle,
  Question,
  SubagentResult,
  TurnStep,
} from '@learning-agent/shared'
import { stableId } from '@learning-agent/shared'
import type {} from '@learning-agent/db'
import type {} from '@learning-agent/artifacts'
import type {} from '@learning-agent/profile'
import type {} from '@learning-agent/questions'
import type {} from '@learning-agent/research'
import type {} from '@learning-agent/bp'
import { BUYING_ROLE_DEFINITIONS, BUYING_ROLE_NAMES, counterexampleText, learningLoyaltyStandard, partWantsLoyalty, partWantsOrganization, partWantsRoles, roleSummary, type MaterialEvidence, type MaterialPart, type SupplementalKp } from './case-library.js'
import { selectRelevantNews } from './news-select.js'
import { hintedTopicIds, scoreAnswer, topicLabel } from './text.js'
export interface StepContext {
  studentId: string
  sessionId: string
  message: string
  chapterId: string
  chapterName: string
  topicIds: string[]
  recentMessages?: Array<{ role: 'user' | 'assistant'; content: string }>
}

function usage(started: number): { ms: number; tokens: number } {
  return { ms: Date.now() - started, tokens: 0 }
}

function boundedController(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  }
}

function failed(step: TurnStep, error: unknown): SubagentResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    stepId: step.id,
    agent: step.agent,
    status: 'failed',
    schema: step.outputSchema,
    content: {},
    citations: [],
    evidenceCandidates: [],
    warnings: [message],
  }
}

function stemKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？；：、,.!?;:'"“”‘’（）()【】\[\]《》<>—\-_/\\]/g, '')
}

function dedupeKps(items: KnowledgePoint[]): KnowledgePoint[] {
  const seen = new Set<string>()
  const output: KnowledgePoint[] = []
  for (const item of items) {
    const key = item.name
    if (seen.has(key)) continue
    seen.add(key)
    output.push(item)
  }
  return output
}

function selectTopics(ctx: Context, query: string, chapterId: string, topicIds: string[], limit = 3): KnowledgePoint[] {
  const explicit = topicIds
    .map((id) => ctx.learningDb.getKp(id))
    .filter((kp): kp is KnowledgePoint => kp !== undefined)
  const hinted = hintedTopicIds(query)
    .map((id) => ctx.learningDb.getKp(id))
    .filter((kp): kp is KnowledgePoint => kp !== undefined)
  const tokens = query
    .split(/[\s,，。！？；：、]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
  const searched = tokens.flatMap((token) => ctx.learningDb.searchKps(token, chapterId, 4))
  const chapterKps = chapterId ? ctx.learningDb.listKpsByChapter(chapterId) : []
  const scored = chapterKps
    .map((kp) => {
      let score = 0
      if (query.includes(kp.name)) score += 5
      for (const keyword of kp.keywords) if (query.includes(keyword)) score += 3
      for (const alias of kp.aliases) if (query.includes(alias)) score += 3
      for (const example of kp.examples) if (query.includes(example.slice(0, 6))) score += 1
      return { kp, score }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((item) => item.kp)
  return dedupeKps([...explicit, ...hinted, ...searched, ...scored]).slice(0, limit)
}

function selectNews(ctx: Context, query: string, chapterId: string): NewsArticle | undefined {
  return selectRelevantNews(ctx.learningDb, { query, chapterId, limit: 1 }).articles[0]
}

function retrievalQuery(context: StepContext): string {
  const message = context.message.trim()
  const isFollowUp = /^(那|这|它|再|还有|为什么|怎么|继续|具体|举个例子)/.test(message)
  if (!isFollowUp) return message
  const lastUser = [...(context.recentMessages ?? [])]
    .reverse()
    .find((item) => item.role === 'user')
  return lastUser ? `${lastUser.content}\n${message}` : message
}

function coveragePartsFrom(input: Record<string, unknown>, message: string): MaterialPart[] {
  const value = input.coverage
  if (typeof value === 'object' && value !== null && 'parts' in value && Array.isArray(value.parts)) {
    const focusIds = new Set<string>()
    if ('focusPartIds' in value && Array.isArray(value.focusPartIds)) {
      for (const id of value.focusPartIds) if (typeof id === 'string') focusIds.add(id)
    }
    const parts = value.parts
      .map((part, index): MaterialPart | undefined => {
        if (typeof part !== 'object' || part === null) return undefined
        const label = 'label' in part && typeof part.label === 'string' ? part.label.trim() : ''
        const question = 'question' in part && typeof part.question === 'string' ? part.question.trim() : ''
        if (label.length === 0 && question.length === 0) return undefined
        const kpIds = 'kpIds' in part && Array.isArray(part.kpIds)
          ? part.kpIds.filter((id: unknown): id is string => typeof id === 'string')
          : []
        return {
          id: 'id' in part && typeof part.id === 'string' && part.id.length > 0 ? part.id : `part_${index + 1}`,
          kind: 'kind' in part && typeof part.kind === 'string' ? part.kind : 'concept',
          label: label || question.slice(0, 18),
          question: question || label,
          kpIds,
          required: !('required' in part) || part.required !== false,
        }
      })
      .filter((part): part is MaterialPart => part !== undefined)
    if (parts.length > 0) {
      const focused = focusIds.size > 0
        ? parts.filter((part) => focusIds.has(part.id) || (part.kpIds ?? []).some((id) => focusIds.has(id)))
        : parts
      return focused.length > 0 ? focused : parts
    }
  }
  return [{ id: 'main', kind: 'concept', label: topicLabel(message), question: message }]
}

function knowledgePartMaterial(
  part: MaterialPart,
  kps: KnowledgePoint[],
  supplemental: SupplementalKp[],
  evidence: MaterialEvidence[],
): { summary: string; lines: string[]; checkQuestion: string } {
  const definitions = [
    ...kps.map((kp) => `${kp.name}：${kp.definition}`),
    ...supplemental.map((item) => `${item.name}：${item.definition}（${item.definitionSource}）`),
  ]
  const lines: string[] = []
  const summary: string[] = []

  if (partWantsOrganization(part)) {
    const standard = '判断标准：先看最终用途。个人和家庭为生活消费而购买，属于消费者市场；餐馆、食堂、便利店等买回去用于生产、转售或组织运行，属于组织市场。数量、金额、包装和店型都不是分界线。'
    lines.push(standard)
    summary.push(standard)
    if (kps.some((kp) => /组织市场/.test(kp.name))) {
      lines.push('组织市场的例外：小餐馆临时买一袋土豆，只要用于做菜再卖，也可能是组织市场。')
    }
  }
  if (partWantsRoles(part)) {
    lines.push(`五种购买角色：${BUYING_ROLE_NAMES.map((name) => `${name}（${BUYING_ROLE_DEFINITIONS[name]}）`).join('；')}`)
    lines.push('同一位消费者可以同时承担多个角色；组织采购中角色更可能分离。')
    summary.push(`五种购买角色：${BUYING_ROLE_NAMES.join('、')}；单人可以同时承担多个角色。${roleSummary()}`)
  }
  if (partWantsLoyalty(part)) {
    const hasLoyalty = kps.some((kp) => /忠诚/.test(kp.name))
      || supplemental.some((item) => /忠诚/.test(item.name))
    const standard = hasLoyalty
      ? learningLoyaltyStandard()
      : '消费者学习强调经验引起的行为或行为潜能变化，关键看下一次的判断规则有没有变；重复购买本身不等于学习。'
    lines.push(standard)
    summary.push(standard)
    if (hasLoyalty) lines.push(`反例：${counterexampleText()}`)
  }
  if (part.kind === 'counterexample' || part.id === 'counterexample') {
    const example = counterexampleText()
    lines.push(example)
    summary.push(example)
  }
  if (definitions.length > 0 && summary.length === 0) summary.push(definitions.join('；'))
  const explanation = [...definitions, ...lines]
  const examples = kps.flatMap((kp) => kp.examples.map((example) => `${kp.name}：${example}`))
  const boundaries = kps.flatMap((kp) => kp.non_examples.map((example) => `${kp.name}的反例：${example}`))
  const decisions = kps.flatMap((kp) => kp.decisions)
  const evidenceLines = evidence.map((item) => `原文证据（${item.sourceTitle}）：${item.quote}`)
  const exampleMaterial = examples.length > 0
    ? `教学示例（不是已核新闻事实）：${[...new Set(examples)].join('；')}`
    : '当前课程条目没有现成示例；可以先列出情境中的主体、目的和选择条件，再逐项对照定义，不把猜测补成案例事实。'
  const boundaryMaterial = boundaries.length > 0
    ? [...new Set(boundaries)].join('；')
    : '不能只因出现同一个词或一次行为就认定概念成立；还需要核对定义中的条件，并考虑其他解释。'
  const sourceMaterial = evidenceLines.length > 0
    ? evidenceLines.join('\n')
    : '未检索到可核对的教材标签块或已审新闻原文；以上仅为课程条目和教学判断，不冒充案例事实。'

  const checkQuestion = partWantsRoles(part)
    ? '一次家庭买菜里，发起者、影响者、决策者、购买者和使用者分别可能是谁？'
    : partWantsLoyalty(part)
      ? '一位顾客每周顺路复购，另一位只去过两次却跨城，谁更可能发生学习？还需要什么证据？'
      : partWantsOrganization(part)
        ? '开餐馆的人来超市买土豆做菜卖，属于消费者市场还是组织市场？为什么？'
        : `换一个${kps[0]?.name ? `与「${kps[0].name}」有关的` : ''}情境，哪些事实支持这个判断，哪条证据会推翻它？`

  return {
    summary: summary.join(' '),
    lines: [
      `先抓住结论：${summary.join(' ') || '当前材料不足，先不下结论。'}`,
      `概念与理由：\n${explanation.join('\n') || '没有检索到课程定义。'}${decisions.length > 0 ? `\n判断线索：${[...new Set(decisions)].join('；')}` : ''}`,
      `放到情境中：\n${exampleMaterial}\n${sourceMaterial}`,
      `边界与反例：${boundaryMaterial}`,
    ],
    checkQuestion,
  }
}

function questionLine(question: Question, index: number): string {
  const options = question.options.length > 0
    ? `\n${question.options.map((option, optionIndex) => `   ${String.fromCharCode(65 + optionIndex)}. ${option}`).join('\n')}`
    : ''
  return `${index + 1}. [${question.type}] ${question.stem}${options}`
}

export interface FeedbackInput {
  studentId: string
  sessionId: string
  chapterId: string
  questionId: string
  answer: string
  artifactId?: string
}

export class FeedbackAgent {
  constructor(private readonly ctx: Context) {}

  async run(step: TurnStep, input: FeedbackInput): Promise<SubagentResult> {
    const started = Date.now()
    try {
      if (input.answer.trim().length === 0) {
        return {
          stepId: step.id,
          agent: 'feedback',
          status: 'needs_input',
          schema: 'AnswerFeedback@1',
          content: {
            questionId: input.questionId,
            correct: false,
            partial: false,
            score: 0,
            message: '没有收到作答内容，所以没有记录这次尝试，也没有生成能力证据。',
            hint: '先写下你的答案或判断理由，再交卷。',
            explanation: '',
            correctAnswer: '',
          },
          citations: [],
          evidenceCandidates: [],
          warnings: ['作答为空，未记录尝试或证据'],
          usage: usage(started),
        }
      }
      const question = this.ctx.learningDb.getQuestion(input.questionId)
      if (!question) throw new Error(`题目不存在：${input.questionId}`)
      const scored = scoreAnswer(question, input.answer)
      const attemptId = this.ctx.learningDb.recordAttempt({
        questionId: question.id,
        studentId: input.studentId,
        answer: input.answer,
        feedback: { ...scored, questionId: question.id },
        score: scored.score,
      })
      const feedbackMessage = scored.correct
        ? '答对了。你的判断和参考答案一致。'
        : scored.partial
          ? '方向接近，但还差一个关键条件。先看提示，再补一次理由。'
          : '这题不对。先别急着看答案，按提示回到定义的核心特征。'
      const competencies = this.ctx.learningDb.listCompetencies()
      const byId = new Map(competencies.map((competency) => [competency.id, competency]))
      const byName = new Map(competencies.map((competency) => [competency.name, competency]))
      const kpValues = question.kp_ids
        .flatMap((kpId) => this.ctx.learningDb.getKp(kpId)?.competencies ?? [])
      const hints: Array<{ id: string; pattern: RegExp }> = [
        { id: 'problem_framing', pattern: /问题|洞察|界定|市场|消费者|框架|目标/ },
        { id: 'evidence_hypothesis', pattern: /证据|假设|分析|数据|验证|来源/ },
        { id: 'decision_tradeoff', pattern: /决策|取舍|策略|方案|风险|权衡/ },
        { id: 'communication', pattern: /沟通|表达|传播|影响|受众|论证/ },
      ]
      let competencyId: string | undefined
      for (const value of kpValues) {
        const exact = byId.get(value) ?? byName.get(value)
        if (exact) {
          competencyId = exact.id
          break
        }
        const hinted = hints.find((hint) => hint.pattern.test(value) && byId.has(hint.id))
        if (hinted) {
          competencyId = hinted.id
          break
        }
      }
      if (!competencyId) {
        const objective = question.type === '单选' || question.type === '多选'
          || question.type === '判断' || question.type === '填空' || question.type === '名词解释'
        const fallback = objective
          ? 'evidence_hypothesis'
          : question.type === '案例分析'
            ? 'decision_tradeoff'
            : 'problem_framing'
        competencyId = byId.has(fallback)
          ? fallback
          : competencies.find((competency) => competency.id === 'evidence_hypothesis')?.id
            ?? competencies[0]?.id
      }
      const objective = question.type === '单选' || question.type === '多选'
        || question.type === '判断' || question.type === '填空' || question.type === '名词解释'
      const level: 'L1' | 'L2' = scored.correct && !objective && scored.score >= 0.6 ? 'L2' : 'L1'
      const evidenceCandidates: EvidenceCandidate[] = competencyId
        ? [{
            competencyId,
            level,
            strength: 'C',
            excerpt: input.answer.slice(0, 200),
            rationale: scored.correct
              ? objective
                ? '单题选择正确只说明识别/再认层面，属于知识线索，不足以证明高级判断能力。'
                : '这次作答方向正确，但单次作答仍不足以给出高等级判断，需要更多证据。'
              : scored.partial
                ? '作答方向接近，但关键条件不完整，只能作为待验证的学习线索。'
                : '作答暴露出对该知识点的理解缺口，需要补证据后再判断能力水平。',
            confidence: scored.correct ? (objective ? 0.45 : 0.5) : scored.partial ? 0.4 : 0.3,
            attemptId,
            questionId: question.id,
            evidenceType: question.type === '案例分析' ? 'decision' : 'explanation',
          }]
        : []
      const citations: Citation[] = question.kp_ids
        .map((kpId) => this.ctx.learningDb.getKp(kpId))
        .filter((kp): kp is KnowledgePoint => kp !== undefined)
        .map((kp) => ({
          sourceType: 'kp',
          sourceId: kp.id,
          quote: kp.definition,
          locator: { name: kp.name },
        }))
      return {
        stepId: step.id,
        agent: 'feedback',
        status: 'ok',
        schema: 'AnswerFeedback@1',
        content: {
          attemptId,
          questionId: question.id,
          correct: scored.correct,
          partial: scored.partial,
          score: scored.score,
          message: feedbackMessage,
          hint: scored.correct
            ? '下一步：换一个情境，看看这条规则还成不成立。'
            : `提示：先找题干里的核心特征，再看「${question.kp_ids.join('、')}」的定义。`,
          explanation: question.explanation,
          correctAnswer: question.answer,
        },
        citations,
        evidenceCandidates,
        warnings: [],
        usage: usage(started),
      }
    } catch (error) {
      return failed(step, error)
    }
  }
}

export function evidenceIdFor(studentId: string, candidate: EvidenceCandidate): string {
  return stableId(
    'ev',
    `${studentId}:${candidate.competencyId}:${candidate.attemptId ?? candidate.questionId ?? 'chat'}:${candidate.excerpt}`,
  )
}

