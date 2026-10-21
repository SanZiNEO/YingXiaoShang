import { chapterId, chapterNumberFromPath, CHAPTER_TITLES } from './constants.js'
export { chapterId, chapterNumberFromPath, CHAPTER_TITLES }
export { locateSpan, type SpanLocation } from './span.js'

import { z } from 'zod'

export const ReviewStatusSchema = z.enum(['draft', 'reviewed', 'adjudicated', 'published', 'rejected'])
export const EvidenceLevelSchema = z.enum(['auto', 'verified', 'gold'])
export const TagRoleSchema = z.enum(['core', 'example', 'mention'])
export const TAG_ROLE_WEIGHTS: Record<z.infer<typeof TagRoleSchema>, number> = {
  core: 1,
  example: 0.7,
  mention: 0.3,
}
export const TAG_ROLE_LABELS: Record<z.infer<typeof TagRoleSchema>, string> = {
  core: '核心',
  example: '例证',
  mention: '提及',
}
export const TagTypeSchema = z.enum(['knowledge_point', 'competency', 'decision', 'context'])

export const ChapterSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  source_path: z.string(),
})

export const SectionSchema = z.object({
  id: z.string(),
  chapter_id: z.string(),
  number: z.number().int(),
  title: z.string(),
})

export const KnowledgePointSchema = z.object({
  id: z.string(),
  chapter_id: z.string(),
  section_id: z.string(),
  name: z.string(),
  name_en: z.string().default(''),
  definition: z.string(),
  keywords: z.array(z.string()).default([]),
  examples: z.array(z.string()).default([]),
  non_examples: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
  difficulty: z.number().int().min(1).max(4).default(2),
  competencies: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  source: z.string(),
  status: z.enum(['draft', 'reviewed', 'published']).default('draft'),
  parent_id: z.string().nullable().optional(),
})

// Manually adjudicated synonym merges: old_id collapses into canonical_id.
// Only true duplicate extractions of the same concept belong here; genuine
// parent/child concept hierarchy (parent_id) must not be merged.
export const KpMergeEntrySchema = z.object({
  old_id: z.string().min(1),
  canonical_id: z.string().min(1),
  reason: z.string().default(''),
})
export const KpMergeMapSchema = z.object({
  version: z.number().int().positive(),
  description: z.string().default(''),
  updated: z.string().default(''),
  merges: z.array(KpMergeEntrySchema).default([]),
})

export const ContentBlockSchema = z.object({
  id: z.string(),
  chapter_id: z.string(),
  section_id: z.string(),
  block_type: z.enum(['paragraph', 'table', 'figure', 'exercise', 'case_fragment']),
  text: z.string(),
  page: z.number().int().optional(),
  source: z.string(),
  rights: z.string(),
})

export const ContentTagSchema = z.object({
  id: z.string(),
  block_id: z.string(),
  tag_type: TagTypeSchema,
  tag_key: z.string(),
  tag_role: TagRoleSchema,
  confidence: z.number().min(0).max(1),
  method: z.enum(['rule', 'llm', 'human', 'hybrid']),
  evidence_span: z.string(),
  evidence_start: z.number().int().optional(),
  evidence_end: z.number().int().optional(),
  review_status: ReviewStatusSchema.default('draft'),
  evidence_level: EvidenceLevelSchema.default('auto'),
  version: z.string().default('v0.1'),
  reviewer_id: z.string().default(''),
  reviewed_at: z.string().default(''),
})

export const IdeologyPointSchema = z.object({
  id: z.string(),
  name: z.string(),
  definition: z.string(),
  examples: z.array(z.string()).default([]),
  non_examples: z.array(z.string()).default([]),
  related_kp_ids: z.array(z.string()).default([]),
  source: z.string(),
})

export const IdeologyTagSchema = z.object({
  id: z.string(),
  target_type: z.enum(['content_block', 'news_article']),
  target_id: z.string(),
  ideology_id: z.string(),
  confidence: z.number().min(0).max(1),
  evidence_span: z.string(),
  rationale: z.string().default(''),
  review_status: ReviewStatusSchema.default('draft'),
  evidence_level: EvidenceLevelSchema.default('auto'),
  version: z.string().default('v0.1'),
  reviewer_id: z.string().default(''),
  reviewed_at: z.string().default(''),
})

export const NewsArticleSchema = z.object({
  id: z.string(),
  source: z.string(),
  source_id: z.string(),
  title: z.string(),
  url: z.string(),
  author: z.string().default(''),
  published_at: z.string(),
  summary: z.string().default(''),
  content: z.string(),
  content_status: z.enum(['full', 'partial', 'unavailable']),
  rights: z.string(),
  fetched_at: z.string(),
})

export const CaseMatchSchema = z.object({
  article_id: z.string(),
  kp_id: z.string(),
  score: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  tag_role: TagRoleSchema,
  evidence_span: z.string(),
  evidence_start: z.number().int().optional(),
  evidence_end: z.number().int().optional(),
  rationale: z.string(),
  method: z.enum(['rule', 'llm', 'hybrid']),
  review_status: ReviewStatusSchema.default('draft'),
  evidence_level: EvidenceLevelSchema.default('auto'),
  version: z.string().default('v0.1'),
  reviewer_id: z.string().default(''),
  reviewed_at: z.string().default(''),
  created_at: z.string().default(''),
})

export const IdeologyMatchSchema = z.object({
  article_id: z.string(),
  ideology_id: z.string(),
  confidence: z.number().min(0).max(1),
  evidence_span: z.string(),
  rationale: z.string(),
  review_status: ReviewStatusSchema.default('draft'),
  evidence_level: EvidenceLevelSchema.default('auto'),
  version: z.string().default('v0.1'),
  reviewer_id: z.string().default(''),
  reviewed_at: z.string().default(''),
})

export const MatchCandidateSchema = z.object({
  articleId: z.string(),
  kpId: z.string(),
  kpName: z.string(),
  tagRole: TagRoleSchema,
  roleLabel: z.string(),
  confidence: z.number().min(0).max(1),
  evidenceSpan: z.string(),
  evidenceStart: z.number().int().optional(),
  evidenceEnd: z.number().int().optional(),
  rationale: z.string().default(''),
  method: z.enum(['rule', 'llm', 'hybrid']),
  reviewStatus: ReviewStatusSchema,
  evidenceLevel: EvidenceLevelSchema,
  version: z.string(),
})

export const MatchDiagnosticsSchema = z.object({
  stages: z.array(z.string()).default([]),
  degraded: z.boolean().default(false),
  vector: z.enum(['lexical-hash', 'unavailable']).default('lexical-hash'),
  semantic: z.boolean().default(false),
  notes: z.array(z.string()).default([]),
  candidates: z.number().int().nonnegative().default(0),
  llm: z.boolean().default(false),
})

export const QuestionTypeSchema = z.enum([
  '名词解释',
  '填空',
  '判断',
  '单选',
  '多选',
  '简答',
  '案例分析',
])

export const QuestionSchema = z.object({
  id: z.string(),
  source_type: z.enum(['news', 'kp', 'text', 'resource']),
  source_id: z.string().default(''),
  type: QuestionTypeSchema,
  stem: z.string(),
  options: z.array(z.string()).default([]),
  answer: z.string(),
  explanation: z.string(),
  difficulty: z.number().int().min(1).max(3),
  kp_ids: z.array(z.string()).min(1),
  ideology_ids: z.array(z.string()).default([]),
  status: z.enum(['draft', 'reviewed', 'published']).default('draft'),
})

export const QuestionAttemptSchema = z.object({
  id: z.string(),
  question_id: z.string(),
  student_id: z.string(),
  answer: z.string(),
  feedback_json: z.unknown().default({}),
  score: z.number(),
  created_at: z.string(),
})

export const QuestionBankEntrySchema = z.object({
  question_id: z.string(),
  stem_hash: z.string(),
  stem: z.string(),
  chapter_id: z.string().default(''),
  kp_ids: z.array(z.string()).default([]),
  type: z.string(),
  difficulty: z.number().int().default(2),
  source: z.string().default(''),
  usage_count: z.number().int().nonnegative().default(0),
  created_at: z.string(),
  last_used_at: z.string(),
})

export const ResearchProjectSchema = z.object({
  id: z.string(),
  student_id: z.string(),
  brief: z.string(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
})

export const ResearchArtifactSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  step: z.string(),
  content: z.unknown(),
  created_at: z.string(),
})

export const BpProjectSchema = z.object({
  id: z.string(),
  student_id: z.string(),
  idea: z.string(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
})

export const BpSectionSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  section: z.string(),
  content: z.string(),
  evidence: z.unknown(),
  updated_at: z.string(),
})

export const CompetencyLevelSchema = z.object({
  level: z.enum(['L1', 'L2', 'L3', 'L4']),
  description: z.string(),
})

export const CompetencySchema = z.object({
  id: z.string(),
  name: z.string(),
  definition: z.string(),
  levels: z.array(CompetencyLevelSchema).min(4),
  observable: z.array(z.string()).default([]),
  version: z.string().default('v0.1'),
})

export const StudentProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  cohort: z.string().default(''),
  background: z.record(z.string(), z.unknown()).default({}),
  goals: z.array(z.string()).default([]),
  preferences: z.record(z.string(), z.unknown()).default({}),
  constraints: z.array(z.string()).default([]),
  self_assessment: z.record(z.string(), z.enum(['L1', 'L2', 'L3', 'L4', 'unknown'])).default({}),
  created_at: z.string().default(''),
  updated_at: z.string().default(''),
})

export const EvidenceSchema = z.object({
  id: z.string(),
  student_id: z.string(),
  competency_id: z.string(),
  level: z.enum(['L1', 'L2', 'L3', 'L4']),
  strength: z.enum(['A', 'B', 'C', 'D']),
  evidence_type: z.enum([
    'explanation',
    'decision',
    'hypothesis',
    'evidence_use',
    'tradeoff',
    'communication',
    'reflection',
    'artifact',
  ]),
  source_type: z.enum(['chat', 'question', 'news', 'research', 'bp', 'reflection', 'teacher']),
  source_id: z.string().default(''),
  chapter_id: z.string().default(''),
  session_id: z.string().default(''),
  excerpt: z.string(),
  rationale: z.string().default(''),
  confidence: z.number().min(0).max(1),
  method: z.enum(['rule', 'llm', 'human', 'hybrid']).default('llm'),
  review_status: z.enum(['draft', 'reviewed', 'rejected']).default('draft'),
  review_note: z.string().default(''),
  occurred_at: z.string(),
  created_at: z.string().default(''),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export const GrowthSnapshotSchema = z.object({
  id: z.string(),
  student_id: z.string(),
  chapter_id: z.string(),
  checkpoint: z.enum(['pre', 'post']),
  competency_id: z.string(),
  level: z.enum(['L1', 'L2', 'L3', 'L4', 'unknown']),
  confidence: z.number().min(0).max(1),
  evidence_count: z.number().int().nonnegative(),
  summary: z.string().default(''),
  created_at: z.string(),
})

export const LearningPlanItemSchema = z.object({
  id: z.string(),
  student_id: z.string(),
  chapter_id: z.string(),
  phase: z.enum(['pre', 'learning', 'post']),
  title: z.string(),
  tasks: z.array(z.string()).default([]),
  status: z.enum(['pending', 'active', 'done']).default('pending'),
  due_at: z.string().default(''),
  updated_at: z.string().default(''),
})

export const ChatMessageSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
  evidence_count: z.number().int().nonnegative().default(0),
  created_at: z.string(),
  seq: z.number().int().nonnegative().default(0),
  turn_id: z.string().default(''),
  kind: z
    .enum([
      'message',
      'user_message',
      'assistant_message',
      'tool_call',
      'artifact_created',
      'evidence_added',
      'answer_submitted',
    ])
    .default('message'),
  payload_json: z.unknown().default({}),
})

export const MemoryFactSchema = z.object({
  id: z.string(),
  student_id: z.string(),
  kind: z.enum(['goal', 'preference', 'constraint', 'background', 'self_assessment', 'open_question']),
  key: z.string(),
  value: z.unknown(),
  confidence: z.number().min(0).max(1).default(0.7),
  source: z.string().default('chat'),
  updated_at: z.string(),
})

export const MemoryEpisodeSchema = z.object({
  id: z.string(),
  student_id: z.string(),
  session_id: z.string(),
  summary: z.string(),
  decisions: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
  created_at: z.string(),
})

export const ArtifactSchema = z.object({
  id: z.string(),
  student_id: z.string(),
  session_id: z.string().default(''),
  skill_id: z.string(),
  template_id: z.string().default(''),
  type: z.enum([
    // 默认产物：模型直接写成的 HTML 页面。
    'page',
    // 需要学生动手、动完手系统还要接着算的，才走结构化。
    'question_set',
    // 旧管线（skills / research / bp / news-lab）仍在写这些类型，保留枚举。
    'research_design',
    'questionnaire',
    'bp_outline',
    'bp_section',
    'growth_card',
    'evidence_pack',
    'case_analysis',
    'case_study',
  ]),
  title: z.string(),
  format: z.enum(['md', 'docx', 'csv', 'json', 'html']),
  path: z.string(),
  content: z.string(),
  content_json: z.unknown().default({}),
  schema_version: z.string().default('Markdown@1'),
  version: z.number().int().positive().default(1),
  status: z.enum(['draft', 'ready', 'stale', 'archived']).default('ready'),
  source_refs: z.array(z.string()).default([]),
  evidence_ids: z.array(z.string()).default([]),
  created_at: z.string(),
})

export const SkillRowSchema = z.object({
  id: z.string(),
  expert_id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  input_schema_json: z.string().default('{}'),
  template_id: z.string().default(''),
  enabled: z.boolean().default(true),
  updated_at: z.string(),
})

export const ChatSessionSchema = z.object({
  id: z.string(),
  student_id: z.string(),
  chapter_id: z.string().default(''),
  title: z.string().default(''),
  created_at: z.string(),
  updated_at: z.string(),
})

export const ChatSessionSummarySchema = z.object({
  id: z.string(),
  title: z.string().default(''),
  chapterId: z.string().default(''),
  chapterTitle: z.string().default(''),
  status: z.enum(['active', 'awaiting_confirmation', 'new_artifact', 'organized']),
  lastTurnAt: z.string().default(''),
  pendingAsks: z.number().int().nonnegative().default(0),
  hasNewArtifact: z.boolean().default(false),
  ledgerStatus: z.enum(['pending', 'summarized', 'stale', 'failed']).or(z.literal('')).default(''),
})

export const GrowthRecordSchema = z.object({
  id: z.string(),
  student_id: z.string(),
  competency: z.string(),
  level: z.string(),
  evidence: z.unknown(),
  created_at: z.string(),
})

export const TeachingGuideSchema = z.object({
  chapter_id: z.string(),
  summary: z.string().default(''),
  key_points: z.array(z.string()).default([]),
  difficulties: z.array(z.string()).default([]),
  objectives: z.array(z.string()).default([]),
  tasks: z.array(z.string()).default([]),
  framework_text: z.string().default(''),
  source: z.string(),
})

export const IngestReportSchema = z.object({
  started_at: z.string(),
  finished_at: z.string(),
  chapters: z.array(
    z.object({
      chapter_id: z.string(),
      number: z.number().int(),
      title: z.string(),
      files: z.array(z.string()),
      failed: z.array(z.string()),
      warnings: z.array(z.string()),
      counts: z.record(z.string(), z.number()),
    }),
  ),
  totals: z.record(z.string(), z.number()),
  failed: z.array(z.string()),
})

export const MatchResultSchema = z.object({
  matches: z.array(CaseMatchSchema),
  ideology: z.array(IdeologyMatchSchema),
  diagnostics: MatchDiagnosticsSchema.optional(),
})

/* ------------------------------------------------------------------ */
/* Runtime contracts: state -> turn plan -> subagent -> record -> ledger */
/* ------------------------------------------------------------------ */

export const TurnPhaseSchema = z.enum(['pre', 'learning', 'post', 'review', 'assessment'])
export const ConfidenceSchema = z.enum(['low', 'medium', 'high'])
export const DecisionSchema = z.enum(['act', 'ask', 'chat'])
export const SubagentNameSchema = z.enum(['knowledge', 'question', 'research', 'bp', 'feedback', 'growth', 'news_lab', 'case', 'plan'])

export const ScopeSchema = z.object({
  chapterId: z.string().optional(),
  chapterTitle: z.string().default(''),
  topicIds: z.array(z.string()).default([]),
  source: z.enum(['explicit', 'inferred', 'carried', 'default']).default('inferred'),
  confidence: ConfidenceSchema.default('medium'),
})

export const AskSchema = z.object({
  question: z.string(),
  options: z.array(z.string()).default([]),
  default: z.string().optional(),
})

export const TurnStepSchema = z.object({
  id: z.string(),
  agent: SubagentNameSchema,
  skill: z.string().default(''),
  dependsOn: z.array(z.string()).default([]),
  input: z.record(z.string(), z.unknown()).default({}),
  outputSchema: z.string().default(''),
  /**
   * Codex-style routing keeps read-heavy work parallel and write work serial.
   * `read` steps may run concurrently; `write` steps produce artifacts and run
   * one at a time in plan order.
   */
  mode: z.enum(['read', 'write']).default('write'),
})

export const RoutingTraceSchema = z.object({
  strategy: z.enum(['rule', 'llm', 'fallback']).default('rule'),
  reason: z.string().default(''),
  candidates: z.array(z.string()).default([]),
  parallel: z.boolean().default(false),
  elapsedMs: z.number().int().nonnegative().default(0),
})

export const RecordPolicySchema = z.object({
  summarize: z.boolean().default(true),
  extractEvidence: z.boolean().default(true),
  force: z.boolean().optional(),
})

export const TurnPlanSchema = z.object({
  turnId: z.string(),
  sessionId: z.string(),
  studentId: z.string(),
  phase: TurnPhaseSchema,
  phaseConfidence: ConfidenceSchema,
  intent: z.string(),
  scope: ScopeSchema,
  decision: DecisionSchema,
  asks: z.array(AskSchema).default([]),
  steps: z.array(TurnStepSchema).default([]),
  routing: RoutingTraceSchema.optional(),
  assumptions: z.array(z.string()).default([]),
  recordPolicy: RecordPolicySchema.default({ summarize: true, extractEvidence: true }),
  pending: z
    .object({
      kind: z.enum(['diagnose', 'research', 'bp']),
      original: z.string().default(''),
    })
    .optional(),
})

export const CitationSchema = z.object({
  sourceType: z.enum(['kp', 'news', 'textbook', 'resource']),
  sourceId: z.string(),
  quote: z.string(),
  locator: z.record(z.string(), z.unknown()).default({}),
})

export const EvidenceCandidateSchema = z.object({
  competencyId: z.string(),
  level: z.enum(['L1', 'L2', 'L3', 'L4']),
  strength: z.enum(['A', 'B', 'C', 'D']),
  excerpt: z.string(),
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
  attemptId: z.string().optional(),
  questionId: z.string().optional(),
  evidenceType: EvidenceSchema.shape.evidence_type.optional(),
})

export const ArtifactDraftSchema = z.object({
  type: ArtifactSchema.shape.type,
  title: z.string(),
  schemaVersion: z.string(),
  contentJson: z.unknown(),
  markdownFallback: z.string(),
  sourceRefs: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).default([]),
})

export const SubagentResultSchema = z.object({
  stepId: z.string(),
  agent: SubagentNameSchema,
  status: z.enum(['ok', 'partial', 'needs_input', 'failed']),
  schema: z.string().default(''),
  content: z.unknown(),
  citations: z.array(CitationSchema).default([]),
  evidenceCandidates: z.array(EvidenceCandidateSchema).default([]),
  artifactDraft: ArtifactDraftSchema.optional(),
  artifactDrafts: z.array(ArtifactDraftSchema).optional(),
  warnings: z.array(z.string()).default([]),
  usage: z.object({ ms: z.number(), tokens: z.number() }).optional(),
})

export const TurnRecordSchema = z.object({
  turnId: z.string(),
  sessionId: z.string(),
  status: z.enum(['completed', 'failed', 'partial']),
  phaseBefore: TurnPhaseSchema,
  phaseAfter: TurnPhaseSchema,
  scope: ScopeSchema,
  subagents: z.array(
    z.object({
      agent: SubagentNameSchema,
      status: z.enum(['ok', 'partial', 'needs_input', 'failed']),
      schema: z.string().default(''),
    }),
  ).default([]),
  artifactIds: z.array(z.string()).default([]),
  evidenceArtifactIds: z.array(z.string()).default([]),
  evidenceCandidateCount: z.number().int().nonnegative().default(0),
  attemptIds: z.array(z.string()).default([]),
  episodeId: z.string().optional(),
  ledgerWatermark: z.number().int().nonnegative().default(0),
  errors: z.array(z.string()).default([]),
  startedAt: z.string(),
  finishedAt: z.string(),
  evidenceCandidates: z.array(EvidenceCandidateSchema).default([]),
  facts: z
    .array(
      z.object({
        kind: z.enum(['goal', 'preference', 'constraint', 'background', 'self_assessment', 'open_question']),
        key: z.string(),
        value: z.unknown(),
        confidence: z.number().min(0).max(1).default(0.7),
      }),
    )
    .default([]),
  openQuestions: z.array(z.string()).default([]),
})

export const StateFeaturesSchema = z.object({
  days_since_last_evidence: z.number().int().nonnegative().default(999),
  chapter_evidence_count: z.number().int().nonnegative().default(0),
  chapter_artifact_count: z.number().int().nonnegative().default(0),
  plan_phase: z.string().default(''),
  plan_status: z.string().default(''),
  explicit_chapter: z.string().nullable().default(null),
  recent_intents: z.array(z.string()).default([]),
  question_type_distribution: z.record(z.string(), z.number()).default({}),
  review_status_mix: z.record(z.string(), z.number()).default({}),
  session_turns: z.number().int().nonnegative().default(0),
  open_questions: z.array(z.string()).default([]),
  last_summary_seq: z.number().int().nonnegative().default(0),
})

export const LearningStateSnapshotSchema = z.object({
  student_id: z.string(),
  phase: TurnPhaseSchema,
  phase_confidence: ConfidenceSchema,
  phase_reasons: z.array(z.string()).default([]),
  scope: ScopeSchema,
  goal: z.string().default(''),
  plan: z.object({
    active_item: z.string().default(''),
    completed: z.number().int().nonnegative().default(0),
    total: z.number().int().nonnegative().default(0),
  }),
  evidence: z.object({
    count: z.number().int().nonnegative().default(0),
    coverage: z.array(z.string()).default([]),
    recent: z.array(z.string()).default([]),
  }),
  artifacts: z.object({
    recent_types: z.array(z.string()).default([]),
    pending_review: z.number().int().nonnegative().default(0),
  }),
  session: z.object({
    turns: z.number().int().nonnegative().default(0),
    open_questions: z.array(z.string()).default([]),
    last_summary_seq: z.number().int().nonnegative().default(0),
  }),
  signals: z.array(z.string()).default([]),
  features: StateFeaturesSchema,
})

export const SummaryLedgerSchema = z.object({
  source_type: z.string(),
  source_id: z.string(),
  source_seq: z.number().int().nonnegative().default(0),
  summarized_seq: z.number().int().nonnegative().default(0),
  source_hash: z.string().default(''),
  status: z.enum(['pending', 'summarized', 'stale', 'failed']),
  summary_id: z.string().default(''),
  attempts: z.number().int().nonnegative().default(0),
  last_error: z.string().default(''),
  updated_at: z.string(),
})

export const LearningStateRowSchema = z.object({
  student_id: z.string(),
  chapter_id: z.string(),
  phase: TurnPhaseSchema,
  state_json: z.unknown(),
  updated_at: z.string(),
})

export const TurnRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  turn_id: z.string(),
  status: z.enum(['running', 'completed', 'partial', 'failed']),
  plan_json: z.unknown(),
  record_json: z.unknown(),
  seq_start: z.number().int().nonnegative().default(0),
  seq_end: z.number().int().nonnegative().default(0),
  started_at: z.string(),
  finished_at: z.string().default(''),
})

/* ------------------------------------------------------------------ */
/* Native artifact content (content_json)                              */
/* ------------------------------------------------------------------ */

/**
 * 一份由模型直接写成的 HTML 页面。右栏按沙箱 iframe 渲染，所以这份内容
 * 不需要后端再做任何转换——它就是最终形态。
 */
export const PageContentSchema = z.object({
  title: z.string().default(''),
  html: z.string(),
})

export const QuestionSetContentSchema = z.object({
  intro: z.string().default(''),
  questions: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      stem: z.string(),
      options: z.array(z.string()).default([]),
      answer: z.string(),
      explanation: z.string().default(''),
      kpIds: z.array(z.string()).default([]),
      difficulty: z.number().int().default(2),
    }),
  ).default([]),
})

export const ResearchDesignContentSchema = z.object({
  researchQuestion: z.string(),
  objectives: z.array(z.string()).default([]),
  method: z.object({
    chosen: z.string(),
    rationale: z.string().default(''),
    alternatives: z.array(z.object({ method: z.string(), tradeoff: z.string() })).default([]),
  }),
  sampling: z.object({
    frame: z.string().default(''),
    technique: z.string().default(''),
    targetSize: z.number().int().default(0),
    recruitment: z.string().default(''),
    risks: z.array(z.string()).default([]),
  }),
  nextSteps: z.array(z.string()).default([]),
})

export const BpOutlineContentSchema = z.object({
  idea: z.string(),
  sections: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      purpose: z.string(),
      requiredEvidence: z.array(z.string()).default([]),
    }),
  ).default([]),
})

export const NewsAnalysisContentSchema = z.object({
  article: z
    .object({
      title: z.string().default(''),
      source: z.string().default(''),
      publishedAt: z.string().default(''),
      url: z.string().default(''),
      summary: z.string().default(''),
    })
    .nullable()
    .default(null),
  matches: z.array(
    z.object({
      kpId: z.string(),
      name: z.string(),
      role: z.string().default('mention'),
      confidence: z.number().default(0),
      evidence: z.string().default(''),
      definition: z.string().default(''),
      caseMapping: z.string().default(''),
      candidate: z.boolean().default(false),
      reviewStatus: ReviewStatusSchema.default('draft'),
      evidenceLevel: EvidenceLevelSchema.default('auto'),
      roleLabel: z.string().default(''),
      method: z.enum(['rule', 'llm', 'hybrid']).default('rule'),
      dialogue: z.array(
        z.object({
          role: z.enum(['student', 'mentor']),
          text: z.string(),
        }),
      ).default([]),
    }),
  ).default([]),
  ideology: z.array(
    z.object({
      name: z.string(),
      evidence: z.string().default(''),
      rationale: z.string().default(''),
    }),
  ).default([]),
  usageNote: z.string().default(''),
})

/**
 * Case-first lesson: every knowledge point starts with its definition, then
 * maps the definition onto concrete case evidence, then explains it through a
 * short student/mentor dialogue. This is the canonical shape for the
 * "定义先行 + 案例对话" presentation.
 */
export const CaseStudyContentSchema = z.object({
  case: z.object({
    id: z.string(),
    title: z.string(),
    subtitle: z.string().default(''),
    summary: z.string().default(''),
    companies: z.array(z.string()).default([]),
    sourceNote: z.string().default(''),
  }),
  knowledgePoints: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      definition: z.string(),
      definitionSource: z.string().default(''),
      caseMapping: z.string().default(''),
      evidence: z.array(
        z.object({
          quote: z.string(),
          sourceId: z.string().default(''),
          sourceTitle: z.string().default(''),
          // Legacy rows predate typed evidence and were all news quotes.
          sourceType: z.enum(['kp', 'news', 'textbook', 'resource']).default('news'),
        }),
      ).default([]),
      dialogue: z.array(
        z.object({
          role: z.enum(['student', 'mentor']),
          text: z.string(),
        }),
      ).default([]),
      takeaway: z.string().default(''),
      boundary: z.string().default(''),
      checkQuestion: z.string().default(''),
    }),
  ).default([]),
  transfer: z.array(z.string()).default([]),
  boundaries: z.array(z.string()).default([]),
  usageNote: z.string().default(''),
})

export const LearningSuggestionsSchema = z.object({
  title: z.string(),
  description: z.string().default(''),
  source: z.enum(['state', 'fallback']).default('state'),
  items: z.array(
    z.object({
      label: z.string(),
      prompt: z.string(),
    }),
  ).default([]),
})

export const GrowthCardContentSchema = z.object({
  dimensions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      level: z.string(),
      levelWord: z.string(),
      status: z.string(),
      evidenceCount: z.number().int().nonnegative().default(0),
      preLevel: z.string().optional(),
      postLevel: z.string().optional(),
      evidence: z.array(z.object({ quote: z.string(), strength: z.string().default('C') })).default([]),
      nextStep: z.string().default(''),
    }),
  ).default([]),
})

export type TurnPhase = z.infer<typeof TurnPhaseSchema>
export type Confidence = z.infer<typeof ConfidenceSchema>
export type Scope = z.infer<typeof ScopeSchema>
export type Ask = z.infer<typeof AskSchema>
export type TurnStep = z.infer<typeof TurnStepSchema>
export type RoutingTrace = z.infer<typeof RoutingTraceSchema>
export type TurnPlan = z.infer<typeof TurnPlanSchema>
export type Citation = z.infer<typeof CitationSchema>
export type EvidenceCandidate = z.infer<typeof EvidenceCandidateSchema>
export type ArtifactDraft = z.infer<typeof ArtifactDraftSchema>
export type SubagentResult = z.infer<typeof SubagentResultSchema>
export type TurnRecord = z.infer<typeof TurnRecordSchema>
export type StateFeatures = z.infer<typeof StateFeaturesSchema>
export type LearningStateSnapshot = z.infer<typeof LearningStateSnapshotSchema>
export type SummaryLedger = z.infer<typeof SummaryLedgerSchema>
export type LearningStateRow = z.infer<typeof LearningStateRowSchema>
export type TurnRow = z.infer<typeof TurnRowSchema>
export type QuestionSetContent = z.infer<typeof QuestionSetContentSchema>
export type PageContent = z.infer<typeof PageContentSchema>
export type ResearchDesignContent = z.infer<typeof ResearchDesignContentSchema>
export type BpOutlineContent = z.infer<typeof BpOutlineContentSchema>
export type NewsAnalysisContent = z.infer<typeof NewsAnalysisContentSchema>
export type CaseStudyContent = z.infer<typeof CaseStudyContentSchema>
export type LearningSuggestions = z.infer<typeof LearningSuggestionsSchema>
export type GrowthCardContent = z.infer<typeof GrowthCardContentSchema>

export type Chapter = z.infer<typeof ChapterSchema>
export type Section = z.infer<typeof SectionSchema>
export type KnowledgePoint = z.infer<typeof KnowledgePointSchema>
export type KpMergeEntry = z.infer<typeof KpMergeEntrySchema>
export type KpMergeMap = z.infer<typeof KpMergeMapSchema>
export type ContentBlock = z.infer<typeof ContentBlockSchema>
export type ContentTag = z.infer<typeof ContentTagSchema>
export type IdeologyPoint = z.infer<typeof IdeologyPointSchema>
export type IdeologyTag = z.infer<typeof IdeologyTagSchema>
export type NewsArticle = z.infer<typeof NewsArticleSchema>
export type CaseMatch = z.infer<typeof CaseMatchSchema>
export type IdeologyMatch = z.infer<typeof IdeologyMatchSchema>
export type QuestionType = z.infer<typeof QuestionTypeSchema>
export type Question = z.infer<typeof QuestionSchema>
export type QuestionAttempt = z.infer<typeof QuestionAttemptSchema>
export type QuestionBankEntry = z.infer<typeof QuestionBankEntrySchema>
export type ResearchProject = z.infer<typeof ResearchProjectSchema>
export type ResearchArtifact = z.infer<typeof ResearchArtifactSchema>
export type BpProject = z.infer<typeof BpProjectSchema>
export type BpSection = z.infer<typeof BpSectionSchema>
export type CompetencyLevel = z.infer<typeof CompetencyLevelSchema>
export type Competency = z.infer<typeof CompetencySchema>
export type StudentProfile = z.infer<typeof StudentProfileSchema>
export type Evidence = z.infer<typeof EvidenceSchema>
export type GrowthSnapshot = z.infer<typeof GrowthSnapshotSchema>
export type LearningPlanItem = z.infer<typeof LearningPlanItemSchema>
export type ChatMessage = z.infer<typeof ChatMessageSchema>
export type MemoryFact = z.infer<typeof MemoryFactSchema>
export type MemoryEpisode = z.infer<typeof MemoryEpisodeSchema>
export type Artifact = z.infer<typeof ArtifactSchema>
export type SkillRow = z.infer<typeof SkillRowSchema>
export type ChatSession = z.infer<typeof ChatSessionSchema>
export type GrowthRecord = z.infer<typeof GrowthRecordSchema>
export type TeachingGuide = z.infer<typeof TeachingGuideSchema>
export type IngestReport = z.infer<typeof IngestReportSchema>
export type MatchResult = z.infer<typeof MatchResultSchema>
export type MatchCandidate = z.infer<typeof MatchCandidateSchema>
export type MatchDiagnostics = z.infer<typeof MatchDiagnosticsSchema>
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>
export type EvidenceLevel = z.infer<typeof EvidenceLevelSchema>
export type TagRole = z.infer<typeof TagRoleSchema>
export type TagType = z.infer<typeof TagTypeSchema>
export type ChatSessionSummary = z.infer<typeof ChatSessionSummarySchema>

export interface KpIndex {
  points: KnowledgePoint[]
  byId: Map<string, KnowledgePoint>
  resolve(value: string): KnowledgePoint | undefined
}

/**
 * Canonical knowledge-point resolution: id, name, English name and aliases all
 * point at exactly one knowledge point. Consumers should resolve before using
 * a kp id/name from user text, tags, questions or persisted legacy rows.
 */
export function createKpIndex(points: KnowledgePoint[]): KpIndex {
  const byId = new Map<string, KnowledgePoint>()
  const byKey = new Map<string, KnowledgePoint>()
  for (const point of points) {
    byId.set(point.id, point)
    for (const key of [point.id, point.name, point.name_en, ...point.aliases]) {
      const normalized = key.trim().toLowerCase().replace(/\s+/g, '')
      if (normalized && !byKey.has(normalized)) byKey.set(normalized, point)
    }
  }
  return {
    points,
    byId,
    resolve(value: string): KnowledgePoint | undefined {
      if (!value) return undefined
      const direct = byId.get(value)
      if (direct) return direct
      return byKey.get(value.trim().toLowerCase().replace(/\s+/g, ''))
    },
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function stableId(prefix: string, value: string): string {
  // Keep ids deterministic without pulling a crypto implementation into the client bundle.
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0
  }
  return `${prefix}_${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}
