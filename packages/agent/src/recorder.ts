import type { Context } from '@deepseek-ai/cordis'
import type {
  Evidence,
  LearningStateSnapshot,
  SummaryLedger,
  TurnPlan,
  TurnRecord,
  TurnRow,
} from '@learning-agent/shared'
import { locateSpan } from '@learning-agent/shared'
import type {} from '@learning-agent/db'
import { isAbilityEvidence } from '@learning-agent/profile'
import { evidenceIdFor } from './subagents.js'

export interface RecorderStatus {
  items: SummaryLedger[]
  counts: {
    summarized: number
    pending: number
    stale: number
    failed: number
  }
}

function asRecord(value: unknown): TurnRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<TurnRecord>
  return typeof record.turnId === 'string' && typeof record.status === 'string'
    ? (record as TurnRecord)
    : undefined
}

function asPlan(value: unknown): TurnPlan | undefined {
  if (!value || typeof value !== 'object') return undefined
  const plan = value as Partial<TurnPlan>
  return typeof plan.intent === 'string' && typeof plan.phase === 'string'
    ? (plan as TurnPlan)
    : undefined
}

function policyOf(turn: TurnRow): {
  summarize: boolean
  extractEvidence: boolean
  force: boolean
} {
  const policy = asPlan(turn.plan_json)?.recordPolicy
  return {
    summarize: policy?.summarize !== false,
    extractEvidence: policy?.extractEvidence !== false,
    force: policy?.force === true,
  }
}

export class RecorderAgent {
  private readonly pending = new Map<string, Promise<void>>()
  // Evidence-extraction failures are kept in `warnings` (visible), but the raw
  // error stack is only logged once per distinct reason so an offline run does
  // not flood the console on every turn.
  private readonly reportedExtractFailures = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly projectSnapshot: (
      studentId: string,
      sessionId: string,
      chapterId: string,
    ) => LearningStateSnapshot,
  ) {}

  private get db() {
    return this.ctx.learningDb
  }

  schedule(studentId: string, sessionId: string): void {
    const key = `${studentId}:${sessionId}`
    const previous = this.pending.get(key) ?? Promise.resolve()
    const next = previous
      .then(() => this.processSession(studentId, sessionId))
      .catch((error: unknown) => {
        console.warn('recorder failed', error)
      })
      .finally(() => {
        if (this.pending.get(key) === next) this.pending.delete(key)
      })
    this.pending.set(key, next)
  }

  async flush(): Promise<void> {
    // A flush may itself be followed by newly scheduled work; drain until idle.
    while (this.pending.size > 0) {
      await Promise.all([...this.pending.values()])
    }
  }

  async processSession(studentId: string, sessionId: string): Promise<void> {
    let ledger = this.db.getSummaryLedger('session', sessionId)
    if (!ledger) {
      const sourceSeq = this.db.listChatMessages(sessionId).at(-1)?.seq ?? 0
      this.db.saveSummaryLedger({
        source_type: 'session',
        source_id: sessionId,
        source_seq: sourceSeq,
        summarized_seq: 0,
        source_hash: '',
        status: 'pending',
        summary_id: '',
        attempts: 0,
        last_error: '',
        updated_at: new Date().toISOString(),
      })
      ledger = this.db.getSummaryLedger('session', sessionId)
      if (!ledger) return
    }
    if (ledger.status === 'failed' && ledger.attempts >= 3) return

    const start = ledger.summarized_seq
    const limit = ledger.source_seq
    if (start >= limit) {
      if (ledger.status !== 'summarized' && ledger.status !== 'failed') {
        this.saveProgress(ledger, start)
      }
      return
    }

    try {
      const turns = this.db
        .listTurnsBetween(sessionId, start + 1, limit)
        .sort((left, right) => left.seq_start - right.seq_start)
      const consumed: Array<{ turn: TurnRow; record: TurnRecord }> = []
      let watermark = start
      for (const turn of turns) {
        if (turn.seq_end <= start) continue
        // Only consume a complete TurnRecord whose assistant message is
        // already inside the ledger snapshot. A running turn blocks the
        // watermark until its record lands.
        if (turn.seq_end > limit) break
        const record = asRecord(turn.record_json)
        if (!record) break
        consumed.push({ turn, record })
        watermark = Math.max(watermark, turn.seq_end)
      }

      if (watermark <= start) {
        if (ledger.status === 'failed') return
        const pendingEvents = this.db
          .listChatMessagesAfter(sessionId, start)
          .filter((event) => event.seq <= limit)
        if (pendingEvents.length === 0) this.saveProgress(ledger, limit)
        else this.saveProgress(ledger, start)
        return
      }

      const sessionMessages = this.db.listChatMessages(sessionId)
      const evidenceWarnings: string[] = []

      for (const { turn, record } of consumed) {
        const policy = policyOf(turn)
        const collected = policy.extractEvidence
          ? await this.collectEvidence(studentId, sessionId, turn, record, sessionMessages)
          : { rows: [], warnings: [] }
        evidenceWarnings.push(...collected.warnings)
        if (collected.rows.length > 0) this.db.insertEvidence(collected.rows)
        const turnEvidenceIds = collected.rows.map((row) => row.id)
        for (const artifactId of [...record.artifactIds, ...(record.evidenceArtifactIds ?? [])]) {
          this.db.appendArtifactEvidence(artifactId, turnEvidenceIds)
        }

        for (const fact of record.facts) {
          this.db.upsertMemoryFact({
            id: `${studentId}:${fact.kind}:${fact.key}`,
            student_id: studentId,
            kind: fact.kind,
            key: fact.key,
            value: fact.value,
            confidence: fact.confidence,
            source: 'record',
            updated_at: new Date().toISOString(),
          })
        }

        const chapterId = record.scope.chapterId
        if (chapterId) {
          const snapshot = this.projectSnapshot(studentId, sessionId, chapterId)
          this.db.upsertLearningState({
            student_id: studentId,
            chapter_id: chapterId,
            phase: snapshot.phase,
            state_json: snapshot,
            updated_at: new Date().toISOString(),
          })
          if (record.phaseAfter === 'post') {
            // recordSnapshot only inserts a new row when the computed level
            // changed, so a synthetic demo post snapshot is replaced by real
            // evidence without duplicating unchanged snapshots.
            this.ctx.profile.recordSnapshot(studentId, chapterId, 'post')
          }
        }
      }

      const summarized = consumed.filter(({ turn }) => policyOf(turn).summarize)
      const forced = consumed.some(({ turn }) => policyOf(turn).force)
      const summarizedRecords = summarized.map(({ record }) => record)
      const summarizedTurns = summarized.map(({ turn }) => turn)
      const summarizedEvents = sessionMessages.filter((event) =>
        summarizedRecords.some((record) => record.turnId === event.turn_id),
      )
      const meaningful = summarizedRecords.some((record) =>
        record.artifactIds.length > 0
        || record.evidenceCandidateCount > 0
        || record.attemptIds.length > 0
        || record.subagents.some((agent) => agent.agent !== 'plan'),
      ) || summarizedEvents.some((event) => event.role === 'user' && event.content.trim().length > 3)
      const episodeId = `ep_${sessionId}_${watermark}`
      let summaryId = ''
      if (summarized.length > 0 && (meaningful || forced)) {
        const summary = this.buildSummary(summarizedEvents, summarizedTurns, summarizedRecords)
        this.db.insertMemoryEpisode({
          id: episodeId,
          student_id: studentId,
          session_id: sessionId,
          summary: evidenceWarnings.length > 0
            ? `${summary}\n证据抽取：${[...new Set(evidenceWarnings)].join('；')}`
            : summary,
          decisions: summarizedRecords.flatMap((record) => record.artifactIds),
          open_questions: [...new Set(summarizedRecords.flatMap((record) => record.openQuestions))].slice(0, 5),
          created_at: new Date().toISOString(),
        })
        summaryId = episodeId
      }

      this.saveProgress(ledger, watermark, summaryId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const latest = this.db.getSummaryLedger('session', sessionId) ?? ledger
      this.db.saveSummaryLedger({
        ...latest,
        status: 'failed',
        attempts: latest.attempts + 1,
        last_error: message,
        updated_at: new Date().toISOString(),
      })
      throw error
    }
  }

  async retry(studentId: string, sourceId: string): Promise<void> {
    const ledger = this.db.getSummaryLedger('session', sourceId)
    if (!ledger) return
    this.db.saveSummaryLedger({
      ...ledger,
      attempts: 0,
      status: 'pending',
      last_error: '',
      updated_at: new Date().toISOString(),
    })
    await this.processSession(studentId, sourceId)
  }

  status(studentId: string): RecorderStatus {
    const items = this.db.listSummaryLedgers(studentId)
    const counts = { summarized: 0, pending: 0, stale: 0, failed: 0 }
    for (const item of items) {
      if (item.status === 'summarized' && item.summarized_seq >= item.source_seq) counts.summarized += 1
      else if (item.status === 'pending') counts.pending += 1
      else if (item.status === 'failed') counts.failed += 1
      else counts.stale += 1
    }
    return { items, counts }
  }

  /**
   * Only student-authored text becomes evidence. Question answers are verified
   * against `question_attempts`; chat utterances against the exact user message.
   * AI output, generated artifacts and self-reported participation are ignored.
   */
  private async collectEvidence(
    studentId: string,
    sessionId: string,
    turn: TurnRow,
    record: TurnRecord,
    sessionMessages: Array<{ role: string; content: string; turn_id: string; id?: string; kind?: string; created_at?: string }>,
  ): Promise<{ rows: Evidence[]; warnings: string[] }> {
    const rows = new Map<string, Evidence>()
    const warnings: string[] = []
    const chapterId = record.scope.chapterId ?? ''
    const userMessages = sessionMessages.filter(
      (event) => event.turn_id === record.turnId && event.role === 'user',
    )
    const questionIds = [...new Set(
      record.evidenceCandidates
        .map((candidate) => candidate.questionId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )]
    const attempts = questionIds.length > 0
      ? this.db.listAttempts({ studentId, questionIds, limit: 500 })
      : []
    const attemptById = new Map(attempts.map((attempt) => [attempt.id, attempt]))

    for (const candidate of record.evidenceCandidates) {
      // Participation / self-report is not ability evidence.
      if (candidate.strength === 'D') continue
      const attempt = candidate.attemptId
        ? attemptById.get(candidate.attemptId)
        : candidate.questionId
          ? attempts.find((item) => item.question_id === candidate.questionId)
          : undefined
      // Answer-derived candidates must resolve to a real student attempt.
      if ((candidate.attemptId || candidate.questionId) && !attempt) continue
      let excerpt = ''
      let sourceId = ''
      let occurredAt = turn.finished_at || new Date().toISOString()
      let metadata: Record<string, unknown> = { turnId: record.turnId }
      if (attempt) {
        const located = locateSpan(attempt.answer, candidate.excerpt)
        if (!located) continue
        excerpt = located.span
        sourceId = attempt.id
        occurredAt = attempt.created_at
        metadata = {
          ...metadata,
          origin: 'answer',
          attemptId: attempt.id,
          questionId: attempt.question_id,
        }
      } else {
        const message = userMessages.find((item) => locateSpan(item.content, candidate.excerpt))
        if (!message?.id) continue
        const located = locateSpan(message.content, candidate.excerpt)
        if (!located) continue
        excerpt = located.span
        sourceId = message.id
        occurredAt = message.created_at ?? occurredAt
        metadata = {
          ...metadata,
          origin: 'chat',
          messageId: message.id,
          questionId: candidate.questionId ?? '',
        }
      }
      const id = evidenceIdFor(studentId, candidate)
      rows.set(id, {
        id,
        student_id: studentId,
        competency_id: candidate.competencyId,
        level: candidate.level,
        strength: candidate.strength,
        evidence_type: candidate.evidenceType ?? 'explanation',
        source_type: attempt ? 'question' : 'chat',
        source_id: sourceId,
        chapter_id: chapterId,
        session_id: sessionId,
        excerpt,
        rationale: candidate.rationale,
        confidence: candidate.confidence,
        method: attempt ? 'hybrid' : 'llm',
        review_status: 'draft',
        review_note: '',
        occurred_at: occurredAt,
        created_at: new Date().toISOString(),
        metadata,
      })
    }

    // Free-form student reasoning (not an answer submission) is extracted by
    // the profile service. If the model is unavailable we keep the honest
    // warning and write no evidence.
    const answerTurn = record.attemptIds.length > 0
      || userMessages.some((event) => event.kind === 'answer_submitted')
    // Plan preferences ("每周4小时") are not ability evidence.
    const planIntent = asPlan(turn.plan_json)?.intent ?? ''
    if (!answerTurn && planIntent !== 'plan') {
      const extractable = userMessages.filter(
        (event) => event.kind !== 'answer_submitted' && event.content.trim().length >= 8,
      )
      if (extractable.length > 0) {
        try {
          const extracted = await this.ctx.profile.extractEvidence({
            studentId,
            sessionId,
            chapterId,
            sourceType: 'chat',
            messages: extractable.map((event) => ({
              id: event.id,
              role: 'user' as const,
              content: event.content,
              createdAt: event.created_at,
            })),
          })
          for (const item of extracted) {
            if (isAbilityEvidence(item)) rows.set(item.id, item)
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          if (!this.reportedExtractFailures.has(reason)) {
            this.reportedExtractFailures.add(reason)
            // One short info line per distinct reason; the failure itself stays
            // visible per-turn via `warnings` below.
            console.info(`[recorder] evidence extraction unavailable (logged once): ${reason}`)
          }
          warnings.push('本轮有学生原话，但证据抽取未完成（模型不可用或返回无效），未生成能力结论')
        }
      }
    }

    return { rows: [...rows.values()], warnings }
  }

  private saveProgress(
    ledger: SummaryLedger,
    watermark: number,
    summaryId?: string,
  ): void {
    const latest = this.db.getSummaryLedger('session', ledger.source_id) ?? ledger
    const sourceSeq = Math.max(latest.source_seq, ledger.source_seq)
    const summarizedSeq = Math.max(latest.summarized_seq, watermark)
    this.db.saveSummaryLedger({
      ...latest,
      source_seq: sourceSeq,
      summarized_seq: summarizedSeq,
      summary_id: watermark > latest.summarized_seq
        ? summaryId ?? ''
        : latest.summary_id,
      // DB recomputes summarized when caught up; 'pending' also clears a
      // previous failure's attempts. Preserve stale when still behind.
      status: latest.status === 'stale' && summarizedSeq < sourceSeq
        ? 'stale'
        : 'pending',
      attempts: 0,
      last_error: '',
      updated_at: new Date().toISOString(),
    })
  }

  private buildSummary(
    events: Array<{ role: string; content: string; turn_id: string }>,
    turns: TurnRow[],
    records: TurnRecord[],
  ): string {
    if (records.length === 0) {
      const user = [...events].reverse().find((event) => event.role === 'user')
      return user ? `学生说「${user.content.slice(0, 80)}」，本轮尚未形成结构化记录。` : '本轮没有可总结的内容。'
    }
    return records.map((record, index) => {
      const plan = asPlan(turns.find((turn) => turn.turn_id === record.turnId)?.plan_json)
      const user = events.find((event) => event.turn_id === record.turnId && event.role === 'user')
      const request = (user?.content ?? plan?.intent ?? '').replace(/\s+/g, ' ').slice(0, 70)
      const agents = record.subagents.map((agent) => agent.agent).filter((agent) => agent !== 'plan')
      return [
        `第${index + 1}轮「${request}」`,
        `${record.phaseBefore}→${record.phaseAfter}`,
        record.scope.chapterId ? `章节 ${record.scope.chapterId}` : '',
        agents.length > 0 ? `调用 ${agents.join('/')}` : '主 Agent 直接回应',
        record.artifactIds.length > 0 ? `产出 ${record.artifactIds.length} 个` : '',
        record.attemptIds.length > 0 ? `作答 ${record.attemptIds.length} 次` : '',
        record.evidenceCandidateCount > 0 ? `证据候选 ${record.evidenceCandidateCount} 条` : '',
      ].filter((part) => part.length > 0).join('；')
    }).join('\n')
  }
}
