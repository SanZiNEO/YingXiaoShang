import type { Context } from '@deepseek-ai/cordis'
import type {
  LearningStateSnapshot,
  Scope,
  StateFeatures,
  TurnPlan,
  TurnRow,
} from '@learning-agent/shared'
import { isAbilityEvidence } from '@learning-agent/profile'
import {
  chapterTitle,
  explicitChapter,
  hintedTopicIds,
  inferChapterFromText,
} from './text.js'

export interface SnapshotInput {
  studentId: string
  sessionId?: string
  message?: string
  scopeOverride?: Scope
}

function lastPlanOf(turn: TurnRow | undefined): TurnPlan | undefined {
  if (!turn || typeof turn.plan_json !== 'object' || turn.plan_json === null) return undefined
  const plan = turn.plan_json as Partial<TurnPlan>
  return typeof plan.phase === 'string' && typeof plan.intent === 'string'
    ? (plan as TurnPlan)
    : undefined
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

export class StateProjector {
  constructor(private readonly ctx: Context) {}

  private get db() {
    return this.ctx.learningDb
  }

  project(input: SnapshotInput): LearningStateSnapshot {
    const message = input.message ?? ''
    const chapters = this.db.listChapters()
    const session = input.sessionId ? this.db.getChatSession(input.sessionId) : undefined
    const turns = input.sessionId ? this.db.listTurns(input.sessionId, 100) : []
    const lastTurn = turns[0]
    const lastPlan = lastPlanOf(lastTurn)

    const explicit = explicitChapter(message)
    const inferred = inferChapterFromText(message)
    const carried = lastPlan?.scope.chapterId || session?.chapter_id || ''
    const activePlanAll = this.db.listLearningPlan(input.studentId)
    const activePlanChapter = activePlanAll.find((item) => item.status === 'active')?.chapter_id
      ?? activePlanAll.find((item) => item.phase === 'learning')?.chapter_id
      ?? ''

    let chapterId = input.scopeOverride?.chapterId || explicit || inferred || ''
    let source: Scope['source'] = input.scopeOverride?.chapterId
      ? 'explicit'
      : explicit
        ? 'explicit'
        : inferred
          ? 'inferred'
          : 'default'
    if (!chapterId && message.length > 0) {
      const tokens = message
        .split(/[\s,，。！？；：、]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
      const matches = tokens.flatMap((token) => this.db.searchKps(token, undefined, 3))
      chapterId = matches[0]?.chapter_id ?? ''
      if (chapterId) source = 'inferred'
    }
    if (!chapterId && carried) {
      chapterId = carried
      source = 'carried'
    }
    if (!chapterId && activePlanChapter) {
      chapterId = activePlanChapter
      source = 'default'
    }
    if (!chapterId && chapters[0]) {
      chapterId = chapters[0].id
      source = 'default'
    }

    const activePlanSelected = source === 'default'
      && activePlanChapter.length > 0
      && chapterId === activePlanChapter
    const confidence: Scope['confidence'] = input.scopeOverride || source === 'explicit'
      ? 'high'
      : source === 'inferred' || source === 'carried' || activePlanSelected
        ? 'medium'
        : 'low'

    const topicIds = unique([
      ...(input.scopeOverride?.topicIds ?? []),
      ...(message.length > 0 ? hintedTopicIds(message) : []),
      ...(message.length > 0
        ? message
            .split(/[\s,，。！？；：、]+/)
            .filter((token) => token.length >= 2)
            .flatMap((token) => this.db.searchKps(token, chapterId, 4).map((kp) => kp.id))
        : []),
      ...(lastPlan?.scope.chapterId === chapterId ? lastPlan.scope.topicIds : []),
    ]).slice(0, 5)

    const scope: Scope = {
      chapterId,
      chapterTitle: chapterTitle(chapters, chapterId),
      topicIds,
      source,
      confidence,
    }

    const evidence = this.db.listEvidence({
      studentId: input.studentId,
      chapterId: chapterId || undefined,
      limit: 500,
    }).filter(isAbilityEvidence)
    const plan = this.db.listLearningPlan(input.studentId, chapterId || undefined)
    const artifacts = this.db.listArtifacts(input.studentId, 100)
    const ledger = input.sessionId
      ? this.db.getSummaryLedger('session', input.sessionId)
      : undefined
    const facts = this.db.listMemoryFacts(input.studentId, 'open_question')
    const profile = this.db.getStudentProfile(input.studentId)

    const learningPlan = plan.find((item) => item.phase === 'learning')
    const activePlan = plan.find((item) => item.status === 'active') ?? learningPlan
    const planCompleted = plan.length > 0 && plan.every((item) => item.status === 'done')
    const learningDone = learningPlan?.status === 'done'
    const completed = plan.filter((item) => item.status === 'done').length
    const recentIntents = turns
      .slice(0, 6)
      .map((turn) => lastPlanOf(turn)?.intent)
      .filter((intent): intent is string => typeof intent === 'string')
    const lastEvidence = evidence[0]
    const daysSince = lastEvidence
      ? Math.max(0, Math.floor((Date.now() - new Date(lastEvidence.occurred_at).getTime()) / 86_400_000))
      : 999
    const reviewMix: Record<string, number> = {}
    for (const item of evidence) reviewMix[item.review_status] = (reviewMix[item.review_status] ?? 0) + 1
    // Question-type distribution comes from actual attempts, never from the
    // recent intent mix.
    const questionTypeMix: Record<string, number> = {}
    for (const attempt of this.db.listAttempts({ studentId: input.studentId, limit: 100 })) {
      const question = this.db.getQuestion(attempt.question_id)
      if (question) {
        questionTypeMix[question.type] = (questionTypeMix[question.type] ?? 0) + 1
      }
    }

    const features: StateFeatures = {
      days_since_last_evidence: Number.isFinite(daysSince) ? daysSince : 999,
      chapter_evidence_count: evidence.length,
      chapter_artifact_count: artifacts.filter((artifact) => !input.sessionId || artifact.session_id === input.sessionId).length,
      plan_phase: activePlan?.phase ?? '',
      plan_status: activePlan?.status ?? (planCompleted ? 'done' : ''),
      explicit_chapter: explicit ?? null,
      recent_intents: recentIntents,
      question_type_distribution: questionTypeMix,
      review_status_mix: reviewMix,
      session_turns: turns.length,
      open_questions: facts
        .map((fact) => (typeof fact.value === 'string' ? fact.value : ''))
        .filter((value) => value.length > 0)
        .slice(0, 5),
      last_summary_seq: ledger?.summarized_seq ?? 0,
    }

    const onboarding = /我想学|从哪开始|怎么学|先学什么|入门|刚开始学/.test(message)
    const reviewRequest = /复习|考试|再看一遍|回顾一下/.test(message)
    const assessmentRequest = /成长卡|评估|教师.*(?:看|复核)|我学得怎么样|学得怎么样/.test(message)
    const postRequest = /写完了|我做完了|帮我看看(?:我的|这份|整份|作业|计划书|报告)|总结一下|复盘/.test(message)

    let phase: LearningStateSnapshot['phase'] = 'pre'
    let phaseConfidence: LearningStateSnapshot['phase_confidence'] = 'low'
    const phaseReasons: string[] = []

    if (reviewRequest) {
      phase = 'review'
      phaseConfidence = 'high'
      phaseReasons.push('学生明确要求复习/考试')
    } else if (assessmentRequest) {
      phase = 'assessment'
      phaseConfidence = 'high'
      phaseReasons.push('学生要求成长卡或评估')
    } else if (postRequest || planCompleted || learningDone) {
      phase = 'post'
      phaseConfidence = postRequest || planCompleted ? 'high' : 'medium'
      phaseReasons.push(
        planCompleted
          ? '当前章节计划已完成'
          : learningDone
            ? '学习阶段计划已完成，进入后测/复盘'
            : '学生表示已完成并希望复盘',
      )
    } else if (onboarding && turns.length === 0 && !learningPlan) {
      phase = 'pre'
      phaseConfidence = 'high'
      phaseReasons.push('首次进入，学生明确说想开始学')
    } else if (learningPlan?.status === 'active' || evidence.length > 0) {
      phase = 'learning'
      phaseConfidence = learningPlan?.status === 'active' && evidence.length > 0 ? 'high' : 'medium'
      if (learningPlan?.status === 'active') {
        phaseReasons.push(`${chapterId} 有 active 学习计划`)
      }
      if (evidence.length > 0) phaseReasons.push(`已有 ${evidence.length} 条能力证据`)
      if (learningPlan?.status === 'active' && evidence.length === 0) {
        phaseReasons.push('计划已开始，证据待积累')
      }
    } else if (turns.length >= 2 && recentIntents.length >= 2) {
      phase = 'learning'
      phaseConfidence = 'medium'
      phaseReasons.push('最近多轮围绕同一章节')
    } else if (!activePlan && evidence.length === 0) {
      phase = 'pre'
      phaseConfidence = 'high'
      phaseReasons.push('当前章节没有 active 计划和证据')
    } else {
      phase = 'pre'
      phaseConfidence = 'low'
      phaseReasons.push('信号不足，按学习前处理')
    }

    const signals: string[] = []
    if (/为什么|怎么理解|不懂|看不懂/.test(message)) signals.push('user_asked_why')
    if (artifacts.length === 0) signals.push('no_artifact_yet')
    if (evidence.some((item) => item.review_status === 'draft')) signals.push('evidence_pending_review')
    if (ledger && ledger.status !== 'summarized') signals.push(`ledger_${ledger.status}`)

    const openQuestions = unique([
      ...features.open_questions,
      ...(lastTurn?.record_json && typeof lastTurn.record_json === 'object'
        ? ((lastTurn.record_json as { openQuestions?: unknown }).openQuestions as string[] | undefined) ?? []
        : []),
    ]).slice(0, 5)

    return {
      student_id: input.studentId,
      phase,
      phase_confidence: phaseConfidence,
      phase_reasons: phaseReasons,
      scope,
      goal: profile?.goals[0] ?? activePlan?.title ?? '',
      plan: {
        active_item: activePlan?.title ?? '',
        completed,
        total: plan.length,
      },
      evidence: {
        count: evidence.length,
        coverage: unique(evidence.map((item) => item.competency_id)),
        recent: evidence.slice(0, 3).map((item) => item.excerpt),
      },
      artifacts: {
        recent_types: unique(artifacts.slice(0, 5).map((artifact) => artifact.type)),
        pending_review: evidence.filter((item) => item.review_status === 'draft').length,
      },
      session: {
        turns: turns.length,
        open_questions: openQuestions,
        last_summary_seq: ledger?.summarized_seq ?? 0,
      },
      signals,
      features,
    }
  }
}
