/**
 * Hand-written JSON Schema fragments for the 30 RPC result envelopes and the
 * shared entity shapes they reference.
 *
 * Per 03-implementation §3.10 these fragments are authored by hand on purpose:
 * reflecting TypeScript types would add noise and drift from the frozen contract.
 * Field names stay aligned with packages/db columns (snake_case) where the row
 * comes straight from the database; camelCase fields follow the service-layer
 * return shapes in packages/profile / packages/agent.
 *
 * Every object declares `type` and `required` (possibly an empty array) and
 * keeps `additionalProperties: true`, so future additive fields do not break
 * old clients (02-contract §8).
 */

const str = (maxLength?: number): Record<string, unknown> => ({
  type: 'string',
  ...(maxLength !== undefined ? { maxLength } : {}),
})

const int = (): Record<string, unknown> => ({ type: 'integer', format: 'int64' })

const num = (): Record<string, unknown> => ({ type: 'number' })

const bool = (): Record<string, unknown> => ({ type: 'boolean' })

const nullable = (schema: Record<string, unknown>): Record<string, unknown> => ({
  ...schema,
  nullable: true,
})

const ref = (name: string): Record<string, unknown> => ({ $ref: `#/components/schemas/${name}` })

const arr = (items: Record<string, unknown>): Record<string, unknown> => ({ type: 'array', items })

const obj = (
  required: string[],
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: true,
  required,
  properties,
  ...extra,
})

/* ------------------------------------------------------------------ */
/* Entities (rows and service-layer shapes)                            */
/* ------------------------------------------------------------------ */

const entities: Record<string, Record<string, unknown>> = {
  Chapter: obj(['id', 'number', 'title'], {
    id: str(),
    number: int(),
    title: str(),
    source_path: str(),
  }),

  KnowledgePoint: obj(['id', 'chapter_id', 'name'], {
    id: str(),
    chapter_id: str(),
    section_id: str(),
    name: str(),
    name_en: str(),
    definition: str(),
    keywords: arr(str()),
    examples: arr(str()),
    non_examples: arr(str()),
    aliases: arr(str()),
    difficulty: int(),
    competencies: arr(str()),
    decisions: arr(str()),
    source: str(),
    status: str(),
    parent_id: nullable(str()),
  }),

  NewsArticle: obj(['id', 'source', 'title', 'url', 'published_at', 'content', 'content_status'], {
    id: str(),
    source: str(),
    source_id: str(),
    title: str(),
    url: str(),
    author: str(),
    published_at: str(),
    summary: str(),
    content: str(),
    content_status: str(),
    rights: str(),
    fetched_at: str(),
  }),

  CaseMatch: obj(['article_id', 'kp_id', 'score', 'evidence_span', 'review_status'], {
    article_id: str(),
    kp_id: str(),
    score: num(),
    confidence: num(),
    tag_role: str(),
    evidence_span: str(),
    evidence_start: int(),
    evidence_end: int(),
    rationale: str(),
    method: str(),
    review_status: str(),
    evidence_level: str(),
    version: str(),
    reviewer_id: str(),
    reviewed_at: str(),
    created_at: str(),
  }),

  IdeologyMatch: obj(['article_id', 'ideology_id', 'confidence', 'evidence_span'], {
    article_id: str(),
    ideology_id: str(),
    confidence: num(),
    evidence_span: str(),
    rationale: str(),
    review_status: str(),
    evidence_level: str(),
    version: str(),
  }),

  QuestionAttempt: obj(['id', 'question_id', 'student_id', 'answer', 'score', 'created_at'], {
    id: str(),
    question_id: str(),
    student_id: str(),
    answer: str(),
    feedback_json: {},
    score: num(),
    created_at: str(),
  }),

  Competency: obj(['id', 'name', 'definition', 'levels'], {
    id: str(),
    name: str(),
    definition: str(),
    levels: arr(obj(['level', 'description'], { level: str(), description: str() })),
    observable: arr(str()),
    version: str(),
  }),

  StudentProfile: obj(['id', 'name'], {
    id: str(),
    name: str(),
    cohort: str(),
    background: { type: 'object', additionalProperties: true },
    goals: arr(str()),
    preferences: { type: 'object', additionalProperties: true },
    constraints: arr(str()),
    self_assessment: { type: 'object', additionalProperties: true },
    created_at: str(),
    updated_at: str(),
  }),

  Evidence: obj(['id', 'student_id', 'competency_id', 'excerpt', 'occurred_at'], {
    id: str(),
    student_id: str(),
    competency_id: str(),
    level: str(),
    strength: str(),
    evidence_type: str(),
    source_type: str(),
    source_id: str(),
    chapter_id: str(),
    session_id: str(),
    excerpt: str(),
    rationale: str(),
    confidence: num(),
    method: str(),
    review_status: str(),
    review_note: str(),
    occurred_at: str(),
    created_at: str(),
    metadata: { type: 'object', additionalProperties: true },
  }),

  Artifact: obj(['id', 'student_id', 'type', 'title', 'path', 'created_at'], {
    id: str(),
    student_id: str(),
    session_id: str(),
    skill_id: str(),
    template_id: str(),
    type: str(),
    title: str(),
    format: str(),
    path: str(),
    content: str(),
    content_json: {},
    schema_version: str(),
    version: int(),
    status: str(),
    source_refs: arr(str()),
    evidence_ids: arr(str()),
    created_at: str(),
  }),

  MemoryFact: obj(['id', 'kind', 'key', 'updated_at'], {
    id: str(),
    student_id: str(),
    kind: str(),
    key: str(),
    value: {},
    confidence: num(),
    source: str(),
    updated_at: str(),
  }),

  MemoryEpisode: obj(['id', 'student_id', 'summary', 'created_at'], {
    id: str(),
    student_id: str(),
    session_id: str(),
    summary: str(),
    decisions: arr(str()),
    open_questions: arr(str()),
    created_at: str(),
  }),

  ChatSession: obj(['id', 'student_id', 'created_at', 'updated_at'], {
    id: str(),
    student_id: str(),
    chapter_id: str(),
    title: str(),
    created_at: str(),
    updated_at: str(),
  }),

  ChatMessage: obj(['id', 'session_id', 'role', 'content', 'created_at', 'seq'], {
    id: str(),
    session_id: str(),
    role: str(),
    content: str(),
    evidence_count: int(),
    created_at: str(),
    seq: int(),
    turn_id: str(),
    kind: str(),
    payload_json: {},
  }),

  TurnRow: obj(['id', 'session_id', 'status', 'started_at'], {
    id: str(),
    session_id: str(),
    turn_id: str(),
    status: str(),
    plan_json: {},
    record_json: {},
    seq_start: int(),
    seq_end: int(),
    started_at: str(),
    finished_at: str(),
  }),

  ChatSessionSummary: obj(['id', 'status'], {
    id: str(),
    title: str(),
    chapterId: str(),
    chapterTitle: str(),
    status: str(),
    lastTurnAt: str(),
    pendingAsks: int(),
    hasNewArtifact: bool(),
    ledgerStatus: str(),
  }),

  SummaryLedger: obj(['source_type', 'source_id', 'status', 'updated_at'], {
    source_type: str(),
    source_id: str(),
    source_seq: int(),
    summarized_seq: int(),
    source_hash: str(),
    status: str(),
    summary_id: str(),
    attempts: int(),
    last_error: str(),
    updated_at: str(),
  }),

  LearningStateSnapshot: obj(['student_id', 'phase', 'phase_confidence', 'scope'], {
    student_id: str(),
    phase: str(),
    phase_confidence: str(),
    phase_reasons: arr(str()),
    scope: { type: 'object', additionalProperties: true },
    goal: str(),
    plan: { type: 'object', additionalProperties: true },
    evidence: { type: 'object', additionalProperties: true },
    artifacts: { type: 'object', additionalProperties: true },
    session: { type: 'object', additionalProperties: true },
    signals: arr(str()),
    features: { type: 'object', additionalProperties: true },
  }),

  LearningSuggestions: obj(['title', 'items'], {
    title: str(),
    description: str(),
    source: str(),
    items: arr(obj(['label', 'prompt'], { label: str(), prompt: str() })),
  }),

  GrowthSnapshot: obj(
    ['id', 'student_id', 'chapter_id', 'checkpoint', 'competency_id', 'level', 'confidence', 'evidence_count', 'created_at'],
    {
      id: str(),
      student_id: str(),
      chapter_id: str(),
      checkpoint: str(),
      competency_id: str(),
      level: str(),
      confidence: num(),
      evidence_count: int(),
      summary: str(),
      created_at: str(),
    },
  ),

  GrowthSummaryItem: obj(['competency', 'level', 'confidence', 'evidenceCount', 'status'], {
    competency: ref('Competency'),
    level: str(),
    confidence: num(),
    evidenceCount: int(),
    status: str(),
    preLevel: str(),
    postLevel: str(),
    latestEvidence: ref('Evidence'),
  }),

  MatchHit: obj(['kp_id', 'score', 'evidence', 'review_status'], {
    kp_id: str(),
    score: num(),
    evidence: str(),
    review_status: str(),
  }),
}

/* ------------------------------------------------------------------ */
/* 30 RPC result envelopes (frozen order, 00-master §5)               */
/* ------------------------------------------------------------------ */

const results: Record<string, Record<string, unknown>> = {
  // 1
  StudentCurrentResult: obj(['studentId', 'name', 'cohort'], {
    studentId: str(),
    name: str(),
    cohort: str(),
  }),

  // 2
  ChaptersListResult: arr(ref('Chapter')),

  // 3
  KpsListResult: arr(ref('KnowledgePoint')),

  // 4
  NewsListResult: arr(ref('NewsArticle')),

  // 5
  NewsStatusResult: obj(['count', 'newestFetchedAt'], {
    count: int(),
    newestFetchedAt: str(),
  }),

  // 6
  NewsRefreshResult: obj(['results', 'queued', 'accepted', 'count', 'newestFetchedAt'], {
    results: arr({ type: 'object', additionalProperties: true }),
    queued: int(),
    accepted: int(),
    count: int(),
    newestFetchedAt: str(),
  }),

  // 7
  NewsGetResult: obj(['article', 'matches', 'ideology'], {
    article: nullable(ref('NewsArticle')),
    matches: arr(ref('CaseMatch')),
    ideology: arr(ref('IdeologyMatch')),
  }),

  // 8
  NewsMatchResult: obj(['matches'], {
    matches: arr(ref('MatchHit')),
  }),

  // 9
  QuestionsAttemptsResult: arr(ref('QuestionAttempt')),

  // 10
  ProfileGetResult: obj(['profile', 'competencies'], {
    profile: nullable(ref('StudentProfile')),
    competencies: arr(ref('Competency')),
    plan: arr({ type: 'object', additionalProperties: true }),
    evidence: arr(ref('Evidence')),
    growth: arr(ref('GrowthSummaryItem')),
  }),

  // 11 — code fact: profileService.growthSummary returns an array of items.
  ProfileGrowthResult: arr(ref('GrowthSummaryItem')),

  // 12
  ProfileEvidenceResult: arr(ref('Evidence')),

  // 13
  ProfileSnapshotResult: ref('GrowthSnapshot'),

  // 14
  ProfileReviewResult: obj(['ok'], { ok: bool() }),

  // 15
  ArtifactsListResult: arr(ref('Artifact')),

  // 16
  ArtifactsGetResult: ref('Artifact'),

  // 17
  ArtifactsExportResult: obj(['path'], { path: str() }),

  // 18
  MemoryFactsResult: arr(ref('MemoryFact')),

  // 19
  MemoryEpisodesResult: arr(ref('MemoryEpisode')),

  // 20
  MemorySummaryResult: obj(['headline', 'facts', 'episodes'], {
    headline: str(),
    facts: arr(ref('MemoryFact')),
    episodes: arr(ref('MemoryEpisode')),
  }),

  // 21
  MemoryUpsertResult: ref('MemoryFact'),

  // 22
  MemoryDeleteResult: obj(['ok'], { ok: bool() }),

  // 23
  ChatSessionsResult: arr(ref('ChatSession')),

  // 24
  ChatMessagesResult: arr(ref('ChatMessage')),

  // 25
  AgentSnapshotResult: ref('LearningStateSnapshot'),

  // 26
  AgentSuggestionsResult: ref('LearningSuggestions'),

  // 27
  AgentTurnsResult: arr(ref('TurnRow')),

  // 28
  AgentLedgerResult: obj(['items', 'counts'], {
    items: arr(ref('SummaryLedger')),
    counts: obj(['summarized', 'pending', 'stale', 'failed'], {
      summarized: int(),
      pending: int(),
      stale: int(),
      failed: int(),
    }),
  }),

  // 29 — retry returns the same ledger shape after re-running the source.
  AgentRetryResult: ref('AgentLedgerResult'),

  // 30
  AgentSessionsResult: arr(ref('ChatSessionSummary')),
}

/* ------------------------------------------------------------------ */
/* Transport / channel envelopes                                       */
/* ------------------------------------------------------------------ */

const envelopes: Record<string, Record<string, unknown>> = {
  HealthResult: obj(
    ['ok', 'warnings', 'notices', 'chapters', 'knowledgePoints', 'newsArticles', 'appHome', 'version', 'uptimeMs'],
    {
      ok: bool(),
      warnings: arr(str()),
      notices: arr(str()),
      chapters: int(),
      knowledgePoints: int(),
      newsArticles: int(),
      appHome: str(),
      version: str(),
      uptimeMs: int(),
    },
  ),

  LoginResult: obj(['token', 'expiresAt', 'student'], {
    token: str(),
    expiresAt: str(),
    student: obj(['studentId', 'name', 'cohort'], {
      studentId: str(),
      name: str(),
      cohort: str(),
    }),
  }),

  AnswerOutput: obj(['turnId', 'text', 'feedback', 'evidence', 'ledger', 'warnings', 'status'], {
    turnId: str(),
    text: str(),
    feedback: { type: 'object', additionalProperties: true },
    evidence: arr(ref('Evidence')),
    ledger: nullable(ref('SummaryLedger')),
    warnings: arr(str()),
    status: str(),
  }),

  AnswerSetOutput: obj(['turnId', 'text', 'results', 'ledger', 'warnings', 'status'], {
    turnId: str(),
    text: str(),
    results: arr({ type: 'object', additionalProperties: true }),
    ledger: nullable(ref('SummaryLedger')),
    warnings: arr(str()),
    status: str(),
  }),

  ErrorBody: obj(['code', 'message'], {
    code: str(),
    message: str(),
    field: str(),
    detail: {},
  }),
}

export const SCHEMAS: Record<string, Record<string, unknown>> = {
  ...entities,
  ...results,
  ...envelopes,
}

/** Names of the 30 frozen RPC result schemas, in frozen method order. */
export const RESULT_SCHEMA_NAMES: string[] = Object.keys(results)
