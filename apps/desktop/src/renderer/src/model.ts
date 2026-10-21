import type {
  Artifact,
  Ask,
  ChatMessage,
  Citation,
  Chapter,
  Competency,
  ContentBlock,
  Evidence,
  LearningStateSnapshot,
  LearningPlanItem,
  MemoryEpisode,
  MemoryFact,
  NewsArticle,
  QuestionAttempt,
  Scope,
  Section,
  StudentProfile,
  SummaryLedger,
  TeachingGuide,
  TurnPlan,
  TurnRow,
} from '@learning-agent/shared'

export interface TurnPayload {
  turnId?: string
  plan?: TurnPlan
  citations?: Citation[]
  artifactIds?: string[]
  asks?: Ask[]
  checkQuestion?: string
  evidenceCandidateCount?: number
  warnings?: string[]
  feedback?: {
    attemptId?: string
    questionId?: string
    correct?: boolean
    partial?: boolean
    score?: number
    message?: string
    hint?: string
    explanation?: string
    correctAnswer?: string
  }
  artifactId?: string
}

export interface ChatEvent extends Omit<ChatMessage, 'payload_json'> {
  payload: TurnPayload
}

export interface LedgerStatus {
  items: SummaryLedger[]
  counts: {
    summarized: number
    pending: number
    stale: number
    failed: number
  }
}

export interface GrowthItem {
  competency: Competency
  level: string
  confidence: number
  evidenceCount: number
  status: '进步' | '停滞' | '证据不足' | '待验证'
  preLevel?: string
  postLevel?: string
  latestEvidence?: Evidence
}

export interface ProfileData {
  profile?: StudentProfile
  competencies: Competency[]
  plan: LearningPlanItem[]
  evidence: Evidence[]
  growth: GrowthItem[]
}

export interface MemorySummary {
  headline: string
  facts: MemoryFact[]
  episodes: MemoryEpisode[]
}

export interface FilePreview {
  path: string
  name: string
  kind: 'markdown' | 'html' | 'text' | 'image' | 'pdf' | 'unsupported'
  content: string
  mime: string
}

export interface NewsDetail {
  article: NewsArticle
  matches: Array<{ kp_id: string; kpName?: string; confidence: number; tag_role: string; evidence_span: string; rationale: string }>
  ideology: Array<{ ideology_id: string; confidence: number; evidence_span: string; rationale: string }>
}

/** One textbook block plus the chapter/section metadata needed to cite it. */
export interface BlockDetail {
  block: ContentBlock
  chapter?: Chapter
  section?: Section
}

/** A resource teaching guide stored under `resource/guide/<chapterId>`. */
export interface ResourceDetail {
  guide: TeachingGuide
  chapter?: Chapter
}

export type SourceDetail =
  | ({ kind: 'textbook'; quote: string } & BlockDetail)
  | ({ kind: 'resource'; quote: string } & ResourceDetail)

export type SessionStatus = 'active' | 'awaiting_confirmation' | 'awaiting_input' | 'new_artifact' | 'organized'

/** Per-session summary rendered in the left rail; backend may omit it on older builds. */
export interface SessionSummary {
  id: string
  title?: string
  chapterId?: string
  chapterTitle?: string
  status?: SessionStatus
  lastTurnAt?: string
  pendingAsks?: number
  hasNewArtifact?: boolean
  ledgerStatus?: 'pending' | 'summarized' | 'stale' | 'failed' | ''
}

export interface Capabilities {
  localFiles: boolean
  revealFiles: boolean
  downloadArtifacts: 'desktop' | 'browser'
}

export type DocKind = 'artifact' | 'overview' | 'artifacts' | 'evidence' | 'process' | 'files' | 'file' | 'news' | 'source'

export interface DocTab {
  id: string
  kind: DocKind
  title: string
  artifactId?: string
  file?: FilePreview
  news?: NewsDetail
  source?: SourceDetail
}

export interface TurnTrace {
  modelCalls: number
  leadRounds: number
  members: Array<{ name: string; rounds: number; tools: number }>
  reads: {
    kps: string[]
    blocks: number
    news: number
    queries: string[]
    references: string[]
  }
  citations: number
  toolCalls: number
  artifacts: number
}

export interface TurnResponse {
  sessionId: string
  turnId: string
  text: string
  artifacts: Artifact[]
  citations: Citation[]
  plan: TurnPlan
  asks: Ask[]
  evidence: Evidence[]
  ledger?: SummaryLedger
  snapshot: LearningStateSnapshot
  /** 程序侧记录的本轮执行轨迹；不依赖模型自述。 */
  trace?: TurnTrace
}

export interface AnswerResponse {
  turnId: string
  text: string
  feedback: TurnPayload['feedback']
  evidence: Evidence[]
  ledger?: SummaryLedger
}

export type SetSubmissionStatus = 'completed' | 'partial' | 'failed'

export interface AnswerSetResponse {
  turnId: string
  text: string
  status?: SetSubmissionStatus
  warnings?: string[]
  results: Array<Record<string, unknown>>
  ledger?: SummaryLedger
}

export interface StudentIdentity {
  studentId: string
  name: string
  cohort: string
}

export interface NewsStatus {
  count: number
  newestFetchedAt: string
}

export interface NewsRefreshResult extends NewsStatus {
  results: Array<{
    source: string
    fetched: number
    inserted: number
    skipped: number
    errors: number
  }>
}

export interface ScopeSelection {
  chapterId: string
  chapterTitle: string
  topicIds: string[]
  source: Scope['source']
  confidence: Scope['confidence']
}

export type { Artifact, Citation, Evidence, LearningStateSnapshot, QuestionAttempt, Scope, SummaryLedger, TurnPlan, TurnRow }
