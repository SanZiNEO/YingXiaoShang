import { Service, type Context } from '@deepseek-ai/cordis'
import { createHash, randomUUID } from 'node:crypto'
import type {
  Artifact,
  Ask,
  ChatMessage,
  ChatSessionSummary,
  Citation,
  Evidence,
  LearningStateSnapshot,
  LearningSuggestions,
  QuestionSetContent,
  Scope,
  SubagentResult,
  SummaryLedger,
  TurnPlan,
  TurnRecord,
  TurnStep,
  TurnRow,
} from '@learning-agent/shared'
import type {} from '@learning-agent/db'
import type {} from '@learning-agent/artifacts'
import type {} from '@learning-agent/profile'
import type {} from '@learning-agent/questions'
import type {} from '@learning-agent/research'
import type {} from '@learning-agent/bp'
import type {} from '@learning-agent/matcher'
import { StateProjector } from './state.js'
import { FeedbackAgent } from './subagents.js'
import { RecorderAgent, type RecorderStatus } from './recorder.js'
import { runTeamTurn, type TeamHooks, type TurnTrace } from './team.js'

export type { TeamHooks, TeamEvent, TurnTrace } from './team.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentRuntime: AgentService
  }
}

export interface HandleTurnInput {
  studentId: string
  sessionId?: string
  message: string
  scopeOverride?: Scope
  chapterId?: string
}

export interface HandleTurnOutput {
  sessionId: string
  /** 程序侧记录：本轮跑了哪些轮次、读了什么。不是模型写的。 */
  trace?: TurnTrace
  turnId: string
  text: string
  artifacts: Artifact[]
  citations: Citation[]
  plan: TurnPlan
  asks: Ask[]
  evidence: Evidence[]
  ledger: SummaryLedger | undefined
  snapshot: LearningStateSnapshot
  /** Degraded/partial reasons. Raw details stay in the turn payload. */
  warnings: string[]
}

export interface AnswerQuestionInput {
  studentId: string
  sessionId: string
  questionId: string
  answer: string
  artifactId?: string
  chapterId?: string
}

export interface AnswerQuestionOutput {
  turnId: string
  text: string
  feedback: Record<string, unknown>
  evidence: Evidence[]
  ledger: SummaryLedger | undefined
  warnings: string[]
  status: TurnRecord['status']
}

export interface AnswerSetInput {
  studentId: string
  sessionId: string
  artifactId: string
  chapterId?: string
  answers: Array<{ questionId: string; answer: string }>
}

export interface AnswerSetOutput {
  turnId: string
  text: string
  results: Array<Record<string, unknown>>
  ledger: SummaryLedger | undefined
  warnings: string[]
  status: TurnRecord['status']
}

export interface AgentRuntime {
  handleConversation(input: HandleTurnInput, hooks?: TeamHooks): Promise<HandleTurnOutput>
  answerQuestion(input: AnswerQuestionInput): Promise<AnswerQuestionOutput>
  answerQuestionSet(input: AnswerSetInput): Promise<AnswerSetOutput>
  getSnapshot(studentId: string, sessionId?: string, chapterId?: string): LearningStateSnapshot
  sessionSummaries(studentId: string): ChatSessionSummary[]
  suggestions(studentId: string, sessionId?: string): LearningSuggestions
  listLedger(studentId: string): RecorderStatus
  retryLedger(studentId: string, sourceId: string): Promise<void>
  listTurns(sessionId: string, limit?: number): TurnRow[]
  flushRecorder(): Promise<void>
}

const DIAGNOSE_PATTERN = /我想学|从哪开始|怎么学|先学什么|入门|刚开始学/
const PRACTICE_PATTERN = /出.*题|题目|练习|测验|几道|做题/
const RESEARCH_PATTERN = /调研|研究设计|问卷|访谈|抽样/
const BP_PATTERN = /商业计划书|bp|创业计划|商业模式/i
const GROWTH_PATTERN = /成长卡|复盘|评估|进步|我学得怎么样|学得怎么样/
const NEWS_PATTERN = /新闻|报道|资讯|文章/
const STUDENT_NEWS_PATTERN = /https?:\/\/|报一条新闻|我(?:看|找)到一条新闻|这条新闻|这篇报道|最新(?:的)?(?:消息|新闻)|根据最新|用第\s*\d+\s*章.*(?:分析|出题)|分析.*新闻.*(?:出题|题目)/
const SEARCH_NEWS_PATTERN = /搜一下|查一下|搜索.*(?:新闻|案例)|找.*(?:新闻|案例)|最新.*新闻|web\s*search/i
/**
 * "Use the news to teach me X": the local library is the teaching material, not
 * a fresh search. Kept separate from STUDENT_NEWS_PATTERN so an explicit URL,
 * "这条新闻" or "搜一下" still wins and takes the search/crawl path.
 */
const NEWS_AS_MATERIAL_PATTERN = /(?:根据|结合|用|拿|参考).{0,12}(?:新闻|报道|资讯)|(?:新闻|报道|资讯).{0,8}(?:讲|分析|解释|说明)|(?:新闻|报道|资讯)(?:里|中)/
const CASE_ENTITY_PATTERN = /胖东来|永辉|步步高/
const CASE_REQUEST_PATTERN = /案例|举例|举个例子|用.{0,14}(?:讲|分析|说明|落地)|结合.{0,14}(?:案例|实际)/
const CASE_CONTEXT_PATTERN = /进店|门店|生鲜|零售/
const EXPLAIN_PATTERN = /为什么|怎么理解|解释|不懂|看不懂|是什么|区别|怎么判断|有哪些|分别|谁.*(?:买|决定|使用)/
const RESEARCH_FOCUS = /购买意愿|品牌态度|态度|意愿|接受度|偏好|满意度|需求|行为/
const MULTI_INTENT_PATTERN = /并|顺便|同时|再.*(?:题|分析|案例|解释)/
const META_CHAT_PATTERN = /我刚才问|我刚刚问|你刚才说|上一轮|还记得|我们聊到|刚才聊/
const RULE_ONLY_INTENTS: Record<string, true> = {
  practice: true,
  research: true,
  bp: true,
  growth: true,
  news_lab: true,
  diagnose: true,
  plan: true,
  case: true,
}

function nowIso(): string {
  return new Date().toISOString()
}

function asPlan(value: unknown): TurnPlan | undefined {
  if (!value || typeof value !== 'object') return undefined
  const plan = value as Partial<TurnPlan>
  return typeof plan.intent === 'string' && typeof plan.phase === 'string'
    ? (plan as TurnPlan)
    : undefined
}

function uniqueCitations(items: Citation[]): Citation[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.sourceType}:${item.sourceId}:${item.quote.slice(0, 30)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function contentOf(result: SubagentResult): Record<string, unknown> {
  return result.content && typeof result.content === 'object'
    ? (result.content as Record<string, unknown>)
    : {}
}

function stringField(content: Record<string, unknown>, key: string): string {
  return typeof content[key] === 'string' ? content[key] as string : ''
}

function storedAnswers(value: unknown): Array<{ questionId: string; answer: string }> {
  if (!Array.isArray(value)) return []
  const output: Array<{ questionId: string; answer: string }> = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    if (!('questionId' in item) || !('answer' in item)) continue
    if (typeof item.questionId !== 'string' || typeof item.answer !== 'string') continue
    output.push({ questionId: item.questionId, answer: item.answer })
  }
  return output
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

export class AgentService extends Service implements AgentRuntime {
  static inject = ['learningDb', 'questionSmith', 'research', 'bp', 'profile', 'artifacts', 'matcher', 'news']

  private readonly projector: StateProjector
  private readonly feedbackAgent: FeedbackAgent
  private readonly recorder: RecorderAgent
  private readonly inFlightSubmissions = new Map<string, Promise<AnswerSetOutput>>()

  constructor(ctx: Context) {
    super(ctx, 'agentRuntime')
    this.projector = new StateProjector(ctx)
    this.feedbackAgent = new FeedbackAgent(ctx)
    this.recorder = new RecorderAgent(ctx, (studentId, sessionId, chapterId) =>
      this.projector.project({
        studentId,
        sessionId,
        message: '',
        scopeOverride: chapterId
          ? { chapterId, chapterTitle: '', topicIds: [], source: 'carried', confidence: 'high' }
          : undefined,
      }),
    )
  }

  private get db() {
    return this.ctx.learningDb
  }

  getSnapshot(studentId: string, sessionId?: string, chapterId?: string): LearningStateSnapshot {
    return this.projector.project({
      studentId,
      sessionId,
      message: '',
      scopeOverride: chapterId
        ? { chapterId, chapterTitle: '', topicIds: [], source: 'explicit', confidence: 'high' }
        : undefined,
    })
  }

  sessionSummaries(studentId: string): ChatSessionSummary[] {
    return this.db.listChatSessionSummaries(studentId)
  }

  suggestions(studentId: string, sessionId?: string): LearningSuggestions {
    const snapshot = this.getSnapshot(studentId, sessionId)
    const chapters = this.db.listChapters()
    const chapterLabel = snapshot.scope.chapterTitle
      || (snapshot.scope.chapterId
        ? chapters.find((chapter) => chapter.id === snapshot.scope.chapterId)?.title ?? '当前章节'
        : '课程通识')
    const artifacts = this.db.listArtifacts(studentId, 20)
      .filter((artifact) => artifact.status !== 'archived')
      .filter((artifact) => !sessionId || artifact.session_id === sessionId)
    const submittedArtifacts = new Set(
      (sessionId ? this.db.listTurns(sessionId, 30) : [])
        .flatMap((turn) => {
          const record = turn.record_json
          if (!record || typeof record !== 'object') return []
          if (!('status' in record) || record.status !== 'completed') return []
          if (!('evidenceArtifactIds' in record) || !Array.isArray(record.evidenceArtifactIds)) return []
          return record.evidenceArtifactIds.filter((id): id is string => typeof id === 'string')
        }),
    )
    const unfinished = artifacts.find((artifact) =>
      artifact.status === 'draft'
      || artifact.status === 'stale'
      || (artifact.type === 'question_set' && !submittedArtifacts.has(artifact.id)))
    const recentCase = artifacts.find((artifact) =>
      artifact.type === 'case_study' || artifact.type === 'case_analysis')
    const hasNews = this.db.countNews() > 0
    const phaseLabel = snapshot.phase === 'pre'
      ? '学习前'
      : snapshot.phase === 'post'
        ? '学习后'
        : snapshot.phase === 'review'
          ? '复习'
          : snapshot.phase === 'assessment'
            ? '评估'
            : '学习中'
    const basis = `依据：${phaseLabel} · ${chapterLabel} · ${snapshot.evidence.count} 条证据`
      + `${unfinished ? ' · 有未完成产物' : recentCase ? ' · 有最近案例' : hasNews ? ' · 有最新新闻' : ''}`
    const base = (title: string, description: string, items: LearningSuggestions['items']): LearningSuggestions => ({
      title,
      description: `${description} ${basis}`,
      source: 'state',
      items: items.slice(0, 3),
    })

    if (unfinished) {
      if (unfinished.type === 'question_set') {
        return base(
          '先把刚才那组题做完',
          '题目集还没交卷，先完成它，再根据逐题反馈判断下一步。',
          [
            { label: '继续做刚才那组题', prompt: '继续做刚才那组题，做完交卷' },
            { label: '先复盘已做的题', prompt: '帮我复盘刚才做过的题' },
            { label: '换一个情境再练', prompt: '给我出 3 道消费者情境题' },
          ],
        )
      }
      if (unfinished.type === 'research_design') {
        return base(
          '把研究设计再推进一格',
          '你已经有一份研究设计，下一步不是重写，而是补一个会改变结论的证据。',
          [
            { label: '继续改研究设计', prompt: '继续改研究设计，先补最关键的一个证据' },
            { label: '用案例检验研究问题', prompt: `用胖东来案例检验「${chapterLabel}」里的研究问题` },
            { label: '给我出 3 道方法题', prompt: '给我出 3 道营销调研方法题' },
          ],
        )
      }
      if (unfinished.type === 'bp_outline') {
        return base(
          '把 BP 目录补成能答辩的版本',
          '目录已经搭好，下一步是给每节补上真实证据，而不是继续加标题。',
          [
            { label: '继续补 BP 证据', prompt: '继续补商业计划书每一节需要的证据' },
            { label: '先检查最弱的一节', prompt: '帮我看看商业计划书里最需要补证据的是哪一节' },
            { label: '用案例检验商业模式', prompt: '用胖东来案例检验这个商业模式' },
          ],
        )
      }
      return base(
        '接着刚才的产物往下走',
        '上一份产物还没整理完，先补最关键的一处，再开新任务。',
        [
          { label: '继续刚才的产物', prompt: '继续完善刚才的产物' },
          { label: '先指出证据缺口', prompt: '刚才的产物还缺哪些证据' },
          { label: '换一个情境验证', prompt: '换一个情境验证刚才的判断' },
        ],
      )
    }

    if (recentCase) {
      return base(
        '接着刚才的案例追问一层',
        '案例已经打开过，下一步不是重看整份材料，而是只追一个还没想透的判断。',
        [
          { label: '只讲案例里的「学习」', prompt: '接着刚才的案例，讲一下学习' },
          { label: '追问消费者与组织市场', prompt: '接着刚才的案例，为什么这些人是消费者而不是组织市场' },
          { label: '追问五种购买角色', prompt: '接着刚才的案例，他们分别扮演哪些购买角色' },
        ],
      )
    }

    if (snapshot.phase === 'pre') {
      return base(
        chapterLabel === '课程通识' ? '先把你的起点摸清' : `先把「${chapterLabel}」的起点摸清`,
        '你还没有在这门课里留下判断记录。先选一个入口，我会用两三个问题确认你该从哪开始。',
        [
          { label: '我想学消费者行为', prompt: '我想学消费者行为' },
          { label: '用胖东来案例讲“消费者”', prompt: '用胖东来案例讲消费者' },
          { label: '先测一下我的基础', prompt: '先测一下我的基础，再决定从哪开始' },
        ],
      )
    }

    if (snapshot.phase === 'post') {
      return base(
        '把学到的判断迁移一次',
        `你在「${chapterLabel}」已经有 ${snapshot.evidence.count} 条证据。现在最有价值的不是再听一遍，而是换一个情境验证。`,
        [
          { label: '我学得怎么样', prompt: '我学得怎么样' },
          { label: '用胖东来案例检验“学习”', prompt: '用胖东来案例检验学习这个知识点' },
          { label: '给我出 5 道情境题', prompt: '给我出 5 道消费者情境题' },
        ],
      )
    }

    const items: LearningSuggestions['items'] = [
      { label: '用胖东来案例讲“消费者”', prompt: '用胖东来案例讲消费者' },
      { label: '消费者市场是什么', prompt: '消费者市场是什么，和普通市场有什么区别' },
      hasNews
        ? { label: '用第4章分析最新新闻', prompt: '用第4章分析最新新闻' }
        : { label: '给我出 5 道情境题', prompt: '给我出 5 道消费者情境题' },
    ]
    return base(
      `接着「${chapterLabel}」往下走`,
      `你正在学「${chapterLabel}」，已有 ${snapshot.evidence.count} 条证据。下一步优先把知识点用回案例，而不是继续堆概念。`,
      items,
    )
  }

  listLedger(studentId: string): RecorderStatus {
    return this.recorder.status(studentId)
  }

  async retryLedger(studentId: string, sourceId: string): Promise<void> {
    await this.recorder.retry(studentId, sourceId)
  }

  listTurns(sessionId: string, limit = 20): TurnRow[] {
    return this.db.listTurns(sessionId, limit)
  }

  async flushRecorder(): Promise<void> {
    await this.recorder.flush()
  }

  /**
   * The conversational path: the agent reads material, writes artifacts as
   * needed, and writes the single reply. No step pipeline, no pre-selected
   * material — see `runTeamTurn`.
   */
  async handleConversation(input: HandleTurnInput, hooks?: TeamHooks): Promise<HandleTurnOutput> {
    const studentId = input.studentId
    this.ensureStudent(studentId)
    const sessionId = input.sessionId || this.db.createChatSession({
      studentId,
      chapterId: input.chapterId ?? '',
      title: input.message.slice(0, 24),
    })
    const turnId = `t_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`
    const startedAt = nowIso()
    const userMessage = this.db.insertChatMessage({
      id: `msg_${randomUUID()}`,
      session_id: sessionId,
      role: 'user',
      content: input.message,
      evidence_count: 0,
      created_at: startedAt,
      seq: 0,
      turn_id: turnId,
      kind: 'user_message',
      payload_json: {},
    })
    const scopeOverride = input.scopeOverride
      ?? (input.chapterId
        ? {
            chapterId: input.chapterId,
            chapterTitle: '',
            topicIds: [],
            source: 'explicit' as const,
            confidence: 'high' as const,
          }
        : undefined)
    const snapshot = this.projector.project({
      studentId,
      sessionId,
      message: input.message,
      scopeOverride,
    })
    // Conversation history is sent as messages, not folded into the system prompt.
    const history = this.db.listChatMessages(sessionId)
      .filter((item) => item.seq < userMessage.seq && (item.role === 'user' || item.role === 'assistant'))
      .map((item) => ({ role: item.role as 'user' | 'assistant', content: item.content }))

    const team = await runTeamTurn({
      ctx: this.ctx,
      scope: {
        studentId,
        sessionId,
        chapterId: snapshot.scope.chapterId ?? '',
        chapterTitle: snapshot.scope.chapterTitle ?? '',
        phase: snapshot.phase,
      },
      message: input.message,
      history,
      hooks,
    })

    const plan: TurnPlan = {
      turnId,
      sessionId,
      studentId,
      phase: snapshot.phase,
      phaseConfidence: 'medium',
      intent: 'team',
      scope: snapshot.scope,
      decision: 'act',
      asks: [],
      steps: [],
      assumptions: [],
      recordPolicy: { summarize: true, extractEvidence: true },
    }
    const finishedAt = nowIso()
    const assistantMessage = this.db.insertChatMessage({
      id: `msg_${randomUUID()}`,
      session_id: sessionId,
      role: 'assistant',
      content: team.text,
      evidence_count: 0,
      created_at: finishedAt,
      seq: 0,
      turn_id: turnId,
      kind: 'assistant_message',
      payload_json: {
        turnId,
        plan,
        citations: team.citations,
        artifactIds: team.artifacts.map((artifact) => artifact.id),
        asks: [],
        checkQuestion: '',
        warnings: team.warnings,
        evidenceCandidateCount: 0,
        team: { called: team.called, members: [] },
        trace: team.trace,
      },
    })
    this.db.upsertTurn({
      id: `turn_${turnId}`,
      session_id: sessionId,
      turn_id: turnId,
      status: 'completed',
      plan_json: plan,
      record_json: {},
      seq_start: userMessage.seq,
      seq_end: assistantMessage.seq,
      started_at: startedAt,
      finished_at: finishedAt,
    })
    this.recorder.schedule(studentId, sessionId)

    return {
      sessionId,
      turnId,
      trace: team.trace,
      text: team.text,
      artifacts: team.artifacts,
      citations: team.citations,
      plan,
      asks: [],
      evidence: [],
      ledger: this.db.getSummaryLedger('session', sessionId),
      snapshot: this.projector.project({ studentId, sessionId, message: '' }),
      warnings: team.warnings,
    }
  }

  async answerQuestion(input: AnswerQuestionInput): Promise<AnswerQuestionOutput> {
    this.ensureStudent(input.studentId)
    this.assertSessionOwner(input.studentId, input.sessionId)
    if (input.artifactId) {
      const artifact = this.assertQuestionSetOwner(input.studentId, input.sessionId, input.artifactId)
      this.assertQuestionMember(artifact, input.questionId)
    }
    if (!this.db.getQuestion(input.questionId)) {
      throw new Error('这道题不存在，没有写入答题记录。')
    }
    const turnId = `t_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`
    const startedAt = nowIso()
    const lastTurn = this.db.getLastTurn(input.sessionId)
    const lastPlan = asPlan(lastTurn?.plan_json)
    const chapterId = input.chapterId || lastPlan?.scope.chapterId || ''
    const userMessage = this.db.insertChatMessage({
      id: `msg_${randomUUID()}`,
      session_id: input.sessionId,
      role: 'user',
      content: `我的答案：${input.answer}`,
      evidence_count: 0,
      created_at: startedAt,
      seq: 0,
      turn_id: turnId,
      kind: 'answer_submitted',
      payload_json: {
        questionId: input.questionId,
        artifactId: input.artifactId ?? '',
        answer: input.answer,
      },
    })
    const step: TurnStep = {
      id: 's1',
      agent: 'feedback',
      skill: 'feedback.answer',
      dependsOn: [],
      input: {},
      outputSchema: 'AnswerFeedback@1',
      mode: 'write',
    }
    const result = await this.feedbackAgent.run(step, {
      studentId: input.studentId,
      sessionId: input.sessionId,
      chapterId,
      questionId: input.questionId,
      answer: input.answer,
      artifactId: input.artifactId,
    })
    const content = contentOf(result)
    const message = stringField(content, 'message')
    const hint = stringField(content, 'hint')
    const recorded = typeof content.attemptId === 'string'
    const text = result.status === 'ok'
      ? [message, hint].filter((line) => line.length > 0).join('\n')
      : recorded
        ? '这道题的反馈生成不完整，作答已记录，但还没有可靠的对错判定；可以稍后重试。'
        : '这道题的反馈没有生成成功。系统没有把它算成你答错，也没有写入答题记录；可以稍后重试，或先换一题。'
    const finishedAt = nowIso()
    const assistantMessage = this.db.insertChatMessage({
      id: `msg_${randomUUID()}`,
      session_id: input.sessionId,
      role: 'assistant',
      content: text,
      evidence_count: result.evidenceCandidates.length,
      created_at: finishedAt,
      seq: 0,
      turn_id: turnId,
      kind: 'assistant_message',
      payload_json: {
        turnId,
        feedback: content,
        citations: result.citations,
        artifactIds: [],
        asks: [],
        checkQuestion: '',
        warnings: result.warnings,
        evidenceCandidateCount: result.evidenceCandidates.length,
        artifactId: input.artifactId ?? '',
      },
    })
    const ledger = this.db.getSummaryLedger('session', input.sessionId)
    const record: TurnRecord = {
      turnId,
      sessionId: input.sessionId,
      status: this.recordStatus([result], result.status === 'failed' ? result.warnings : []),
      phaseBefore: lastPlan?.phase ?? 'learning',
      phaseAfter: 'learning',
      scope: lastPlan?.scope ?? {
        chapterId,
        chapterTitle: '',
        topicIds: [],
        source: 'carried',
        confidence: 'medium',
      },
      subagents: [{ agent: 'feedback', status: result.status, schema: result.schema }],
      artifactIds: [],
      evidenceArtifactIds: [],
      evidenceCandidateCount: result.evidenceCandidates.length,
      attemptIds: typeof content.attemptId === 'string' ? [content.attemptId] : [],
      ledgerWatermark: ledger?.source_seq ?? assistantMessage.seq,
      errors: result.warnings,
      startedAt,
      finishedAt,
      evidenceCandidates: result.evidenceCandidates,
      facts: [],
      openQuestions: [],
    }
    this.db.upsertTurn({
      id: `turn_${turnId}`,
      session_id: input.sessionId,
      turn_id: turnId,
      status: record.status,
      plan_json: lastPlan ?? {},
      record_json: record,
      seq_start: userMessage.seq,
      seq_end: assistantMessage.seq,
      started_at: startedAt,
      finished_at: finishedAt,
    })
    this.recorder.schedule(input.studentId, input.sessionId)
    return {
      turnId,
      text,
      feedback: content,
      evidence: [],
      ledger,
      warnings: result.warnings,
      status: record.status,
    }
  }

  async answerQuestionSet(input: AnswerSetInput): Promise<AnswerSetOutput> {
    this.ensureStudent(input.studentId)
    this.assertSessionOwner(input.studentId, input.sessionId)
    const artifact = this.assertQuestionSetOwner(input.studentId, input.sessionId, input.artifactId)
    const memberIds = new Set(this.questionIdsOf(artifact))
    if (!Array.isArray(input.answers) || input.answers.length === 0) {
      throw new Error('交卷失败：答卷为空，没有写入任何答题记录。')
    }
    if (input.answers.some((answer) => !answer
      || typeof answer.questionId !== 'string'
      || typeof answer.answer !== 'string')) {
      throw new Error('交卷失败：答卷格式无效，没有写入任何答题记录。')
    }
    if (input.answers.every((answer) => answer.answer.trim().length === 0)) {
      throw new Error('交卷失败：所有答案都是空的，没有写入任何答题记录。')
    }
    const seen = new Set<string>()
    for (const [index, answer] of input.answers.entries()) {
      if (typeof answer.questionId !== 'string' || typeof answer.answer !== 'string') {
        throw new Error(`交卷失败：第 ${index + 1} 题格式无效，没有写入任何答题记录。`)
      }
      if (seen.has(answer.questionId)) {
        throw new Error(`交卷失败：第 ${index + 1} 题重复提交，没有写入任何答题记录。`)
      }
      seen.add(answer.questionId)
      if (!memberIds.has(answer.questionId)) {
        throw new Error(`交卷失败：第 ${index + 1} 题不属于这份题目集，没有写入任何答题记录。`)
      }
      if (!this.db.getQuestion(answer.questionId)) {
        throw new Error(`交卷失败：第 ${index + 1} 题的题目数据缺失，没有写入任何答题记录。`)
      }
    }

    const key = `${input.studentId}\0${input.sessionId}\0${input.artifactId}`
    const running = this.inFlightSubmissions.get(key)
    if (running) return running
    const task = this.submitAnswerSet(input)
    this.inFlightSubmissions.set(key, task)
    try {
      return await task
    } finally {
      this.inFlightSubmissions.delete(key)
    }
  }

  private async submitAnswerSet(input: AnswerSetInput): Promise<AnswerSetOutput> {
    const existing = this.findSubmission(input.studentId, input.sessionId, input.artifactId)
    const existingStatus = existing?.record?.status
    const retrying = existingStatus === 'failed' || existingStatus === 'partial'
    if (existing && existingStatus === 'completed') {
      return this.existingSubmissionOutput(existing, input.sessionId)
    }

    const storedPayload = existing?.assistant?.payload_json as {
      feedbackBatch?: unknown
      citations?: unknown
    } | undefined
    const storedResults = Array.isArray(storedPayload?.feedbackBatch)
      ? storedPayload.feedbackBatch as Array<Record<string, unknown>>
      : []
    const storedStatuses = existing?.record?.subagents?.map((item) => item.status) ?? []
    const baseAnswers = retrying && existing && existing.answers.length > 0 ? existing.answers : input.answers
    const reusable = retrying
      && (existing?.answers.length ?? 0) > 0
      && storedResults.length === baseAnswers.length
      && storedStatuses.length === baseAnswers.length
    const statuses: Array<SubagentResult['status']> = baseAnswers.map((_, index) =>
      reusable ? storedStatuses[index] ?? 'failed' : 'failed')
    const results: Array<Record<string, unknown>> = baseAnswers.map((_, index) =>
      reusable ? storedResults[index] ?? {} : {})

    const turnId = existing?.turn.turn_id
      ?? this.submissionTurnId(input.studentId, input.sessionId, input.artifactId)
    const startedAt = retrying
      ? existing?.record?.startedAt ?? nowIso()
      : nowIso()
    const lastTurn = this.db.getLastTurn(input.sessionId)
    const lastPlan = asPlan(lastTurn?.plan_json)
    const chapterId = input.chapterId || lastPlan?.scope.chapterId || ''
    const userMessage = this.db.insertChatMessage({
      id: `msg_${randomUUID()}`,
      session_id: input.sessionId,
      role: 'user',
      content: retrying ? `重试交卷：${baseAnswers.length} 题` : `交卷：${baseAnswers.length} 题`,
      evidence_count: 0,
      created_at: nowIso(),
      seq: 0,
      turn_id: turnId,
      kind: 'answer_submitted',
      payload_json: { artifactId: input.artifactId, answers: baseAnswers },
    })

    const newFeedback: SubagentResult[] = []
    const errors: string[] = []
    for (let index = 0; index < baseAnswers.length; index++) {
      if (statuses[index] === 'ok') continue
      const answer = baseAnswers[index]!
      const step: TurnStep = {
        id: `s${index + 1}`,
        agent: 'feedback',
        skill: 'feedback.answer',
        dependsOn: [],
        input: {},
        outputSchema: 'AnswerFeedback@1',
        mode: 'write',
      }
      const result = await this.feedbackAgent.run(step, {
        studentId: input.studentId,
        sessionId: input.sessionId,
        chapterId,
        questionId: answer.questionId,
        answer: answer.answer,
        artifactId: input.artifactId,
      })
      newFeedback.push(result)
      statuses[index] = result.status
      results[index] = contentOf(result)
      if (result.status !== 'ok') errors.push(...result.warnings)
    }

    const attemptIds = [...new Set([
      ...(retrying ? existing?.record?.attemptIds ?? [] : []),
      ...results
        .map((result) => result.attemptId)
        .filter((attemptId): attemptId is string => typeof attemptId === 'string'),
    ])]
    const text = this.submissionText(results, statuses, attemptIds.length)
    const storedCitations: Citation[] = Array.isArray(storedPayload?.citations)
      ? storedPayload.citations as Citation[]
      : []
    const citations = uniqueCitations([
      ...storedCitations,
      ...newFeedback.flatMap((result) => result.citations),
    ])
    const seenEvidence = new Set<string>()
    const evidenceCandidates = [
      ...(retrying ? existing?.record?.evidenceCandidates ?? [] : []),
      ...newFeedback.flatMap((result) => result.evidenceCandidates),
    ].filter((candidate) => {
      const key = candidate.attemptId ?? candidate.questionId ?? candidate.excerpt
      if (seenEvidence.has(key)) return false
      seenEvidence.add(key)
      return true
    })
    const graded = statuses.filter((status) => status === 'ok').length
    const recordStatus: TurnRecord['status'] = statuses.length > 0 && graded === statuses.length
      ? 'completed'
      : graded > 0
        ? 'partial'
        : 'failed'
    const finishedAt = nowIso()
    const assistantMessage = this.db.insertChatMessage({
      id: `msg_${randomUUID()}`,
      session_id: input.sessionId,
      role: 'assistant',
      content: text,
      evidence_count: evidenceCandidates.length,
      created_at: finishedAt,
      seq: 0,
      turn_id: turnId,
      kind: 'assistant_message',
      payload_json: {
        turnId,
        feedbackBatch: results,
        artifactId: input.artifactId,
        citations,
        artifactIds: [],
        asks: [],
        checkQuestion: '',
        warnings: errors,
        evidenceCandidateCount: evidenceCandidates.length,
      },
    })
    const ledger = this.db.getSummaryLedger('session', input.sessionId)
    const record: TurnRecord & { submissionArtifactId?: string } = {
      turnId,
      sessionId: input.sessionId,
      status: recordStatus,
      phaseBefore: existing?.record?.phaseBefore ?? lastPlan?.phase ?? 'learning',
      phaseAfter: existing?.record?.phaseAfter ?? 'learning',
      scope: existing?.record?.scope ?? lastPlan?.scope ?? {
        chapterId,
        chapterTitle: '',
        topicIds: [],
        source: 'carried',
        confidence: 'medium',
      },
      subagents: statuses.map((status) => ({
        agent: 'feedback',
        status,
        schema: 'AnswerFeedback@1',
      })),
      artifactIds: [],
      evidenceArtifactIds: attemptIds.length > 0 ? [input.artifactId] : [],
      evidenceCandidateCount: evidenceCandidates.length,
      attemptIds,
      ledgerWatermark: ledger?.source_seq ?? assistantMessage.seq,
      errors,
      startedAt,
      finishedAt,
      evidenceCandidates,
      facts: [],
      openQuestions: [],
      submissionArtifactId: input.artifactId,
    }
    this.db.upsertTurn({
      id: `turn_${turnId}`,
      session_id: input.sessionId,
      turn_id: turnId,
      status: record.status,
      plan_json: lastPlan ?? {},
      record_json: record,
      seq_start: existing?.turn.seq_start ?? userMessage.seq,
      seq_end: assistantMessage.seq,
      started_at: startedAt,
      finished_at: finishedAt,
    })
    this.recorder.schedule(input.studentId, input.sessionId)
    return { turnId, text, results, ledger, warnings: errors, status: record.status }
  }

  private submissionText(
    results: Array<Record<string, unknown>>,
    statuses: Array<SubagentResult['status']>,
    recordedAttempts = 0,
  ): string {
    const graded = statuses.filter((status) => status === 'ok').length
    const failed = statuses.length - graded
    const correct = results.filter((result) => result.correct === true).length
    const wrongIndexes = results
      .map((result, index) => result.correct === true || statuses[index] !== 'ok' ? -1 : index + 1)
      .filter((index) => index > 0)
    const lines: string[] = []
    if (graded === 0) {
      lines.push(recordedAttempts > 0
        ? '交卷没有完成：反馈服务暂时不可用，部分作答已记录，但还没有可靠的对错判定，也没有算成你答错。'
        : '交卷没有完成：反馈服务暂时不可用，这组题没有写入任何答题记录，也没有算成你答错。')
      lines.push('可以稍后再次交卷，系统会自动重试；已成功的作答不会重复记分。')
      return lines.join('\n')
    }
    lines.push(`已交卷：${correct}/${graded} 题正确。`)
    if (failed > 0) {
      lines.push(`另有 ${failed} 题反馈没有生成成功，未计入对错；再次交卷只会重试这些题，已成功的作答不会重复记分。`)
    }
    if (correct === graded) {
      lines.push(failed === 0
        ? '这组题的整体判断是稳的。下一步换一个情境再验证一次，别只记住答案。'
        : '已评分的题都正确，但还有题没有反馈，先别把这组题当成全部完成。')
    } else if (wrongIndexes.length > 0) {
      lines.push(`错题：第 ${wrongIndexes.join('、')} 题。先看解析，重点看是概念没记住，还是没读懂题干情境。`)
    }
    return lines.join('\n')
  }

  private submissionTurnId(studentId: string, sessionId: string, artifactId: string): string {
    const digest = createHash('sha1')
      .update(`${studentId}\0${sessionId}\0${artifactId}`)
      .digest('hex')
      .slice(0, 16)
    return `t_sub_${digest}`
  }

  private findSubmission(studentId: string, sessionId: string, artifactId: string): {
    turn: TurnRow
    record: (TurnRecord & { submissionArtifactId?: string }) | undefined
    assistant: ChatMessage | undefined
    answers: Array<{ questionId: string; answer: string }>
  } | undefined {
    let turn = this.db.getTurn(sessionId, this.submissionTurnId(studentId, sessionId, artifactId))
    if (!turn) {
      const turns = this.db.listTurns(sessionId, 100)
      turn = turns.find((item) => {
        const record = item.record_json
        return record !== null
          && typeof record === 'object'
          && 'submissionArtifactId' in record
          && record.submissionArtifactId === artifactId
      })
    }
    const messages = this.db.listChatMessages(sessionId)
    if (!turn) {
      const submitted = messages.find((message) => {
        if (message.kind !== 'answer_submitted') return false
        const payload = message.payload_json as { artifactId?: unknown; answers?: unknown } | undefined
        return payload?.artifactId === artifactId && Array.isArray(payload.answers)
      })
      if (submitted) turn = this.db.getTurn(sessionId, submitted.turn_id)
    }
    if (!turn) return undefined
    const resolvedTurn = turn
    const record = resolvedTurn.record_json && typeof resolvedTurn.record_json === 'object'
      ? resolvedTurn.record_json as TurnRecord & { submissionArtifactId?: string }
      : undefined
    const turnMessages = messages.filter((message) => message.turn_id === resolvedTurn.turn_id)
    const assistant = turnMessages.filter((message) => message.role === 'assistant').at(-1)
    const submitted = turnMessages.find((message) => {
      if (message.kind !== 'answer_submitted') return false
      const payload = message.payload_json as { answers?: unknown } | undefined
      return Array.isArray(payload?.answers)
    })
    const payload = submitted?.payload_json as { answers?: unknown } | undefined
    return { turn: resolvedTurn, record, assistant, answers: storedAnswers(payload?.answers) }
  }

  private existingSubmissionOutput(
    existing: {
      turn: TurnRow
      record: (TurnRecord & { submissionArtifactId?: string }) | undefined
      assistant: ChatMessage | undefined
    },
    sessionId: string,
  ): AnswerSetOutput {
    const payload = existing.assistant?.payload_json as { feedbackBatch?: unknown } | undefined
    const results = Array.isArray(payload?.feedbackBatch)
      ? payload.feedbackBatch as Array<Record<string, unknown>>
      : []
    return {
      turnId: existing.turn.turn_id,
      text: existing.assistant?.content
        ?? '这份题目集已经交过卷，本次没有重复记分。',
      results,
      ledger: this.db.getSummaryLedger('session', sessionId),
      warnings: existing.record?.errors ?? [],
      status: existing.record?.status ?? 'failed',
    }
  }

  private assertSessionOwner(studentId: string, sessionId: string): void {
    const session = this.db.getChatSession(sessionId)
    if (!session || session.student_id !== studentId) {
      throw new Error('交卷失败：会话不存在或不属于当前学生，没有写入任何答题记录。')
    }
  }

  private assertQuestionSetOwner(studentId: string, sessionId: string, artifactId: string): Artifact {
    const artifact = this.db.getArtifact(artifactId)
    if (!artifact
      || artifact.student_id !== studentId
      || artifact.session_id !== sessionId
      || artifact.type !== 'question_set') {
      throw new Error('交卷失败：题目集不存在或不属于当前学生/会话，没有写入任何答题记录。')
    }
    return artifact
  }

  private questionIdsOf(artifact: Artifact): string[] {
    const content = artifact.content_json as Partial<QuestionSetContent> | undefined
    return Array.isArray(content?.questions)
      ? content.questions.map((question) => question.id).filter((id): id is string => typeof id === 'string')
      : []
  }

  private assertQuestionMember(artifact: Artifact, questionId: string): void {
    if (!this.questionIdsOf(artifact).includes(questionId)) {
      throw new Error('这道题不属于当前题目集，没有写入答题记录。')
    }
  }

  private ensureStudent(studentId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(studentId)) {
      throw new Error('无效的学生标识，没有写入学习数据。')
    }
    if (this.db.getStudentProfile(studentId)) return
    const timestamp = nowIso()
    this.db.upsertStudentProfile({
      id: studentId,
      name: '学生',
      cohort: '',
      background: {},
      goals: [],
      preferences: {},
      constraints: [],
      self_assessment: {},
      created_at: timestamp,
      updated_at: timestamp,
    })
  }

  private recordStatus(results: SubagentResult[], errors: string[]): TurnRecord['status'] {
    if (results.length === 0) return errors.length > 0 ? 'failed' : 'completed'
    const ok = results.filter((result) => result.status === 'ok').length
    const failed = results.filter((result) => result.status === 'failed').length
    if (ok === 0 && (failed > 0 || errors.length > 0)) return 'failed'
    if (ok === results.length && errors.length === 0) return 'completed'
    return 'partial'
  }
}

export { QuestionOrganizer } from './question-organizer.js'
export default AgentService
