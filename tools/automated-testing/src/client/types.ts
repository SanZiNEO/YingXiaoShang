/** 与 preload/`learning:invoke` 契约对齐的返回类型（只定义断言用到的字段，其余保留 unknown）。 */

export interface HealthResponse {
  ok: boolean
  warnings: string[]
  notices: string[]
  appHome: string
}

export interface PublicSettings {
  hasApiKey: boolean
  model: string
  apiKeySource: 'env' | 'stored' | 'none'
  configError?: string
}

export interface Student {
  studentId: string
  name: string
  cohort: string
  id?: string
  created_at?: string
  profile_json?: string
}

export interface Chapter {
  id: string
  title: string
  ordinal?: number
  [key: string]: unknown
}

export interface KnowledgePoint {
  id: string
  chapter_id: string
  name: string
  definition: string
  section_id?: string
  [key: string]: unknown
}

export interface NewsArticle {
  id: string
  title: string
  source?: string
  published_at?: string
  url?: string
  [key: string]: unknown
}

export interface Artifact {
  id: string
  student_id: string
  session_id: string
  skill_id: string
  template_id: string
  type: string
  title: string
  format: string
  path: string
  content: string
  content_json: Record<string, unknown>
  schema_version: string
  version: number
  status: string
  source_refs: unknown[]
  evidence_ids: string[]
  created_at: string
}

export interface ChatSession {
  id: string
  student_id: string
  chapter_id: string
  title: string
  updated_at: string
}

export interface ChatMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  evidence_count: number
  created_at: string
  seq: number
  turn_id: string
  kind: string
  payload_json: Record<string, unknown>
}

export interface Citation {
  sourceType: 'kp' | 'textbook' | 'resource' | 'news'
  sourceId: string
  quote: string
  locator: Record<string, unknown>
  [key: string]: unknown
}

export interface TurnResponse {
  sessionId: string
  turnId: string
  text: string
  artifacts: Artifact[]
  citations: Citation[]
  plan: Record<string, unknown>
  asks: unknown[]
  evidence: unknown[]
  ledger: unknown
  snapshot: Record<string, unknown>
  warnings: string[]
  trace: Record<string, unknown>
}

export interface AnswerSetResponse {
  sessionId: string
  turnId: string
  text: string
  status: 'completed' | 'partial' | 'failed'
  results?: unknown[]
  attemptIds?: string[]
  warnings?: string[]
  [key: string]: unknown
}

export interface QuestionAttempt {
  id: string
  question_id: string
  student_id: string
  session_id: string
  answer: string
  score: number
  correct: number
  created_at: string
  [key: string]: unknown
}

export interface MemoryFact {
  id: string
  student_id: string
  kind: string
  key: string
  value_json: string
  confidence: number
  source: string
  updated_at: string
  [key: string]: unknown
}

export interface ProfileEvidence {
  id: string
  student_id: string
  competency_id: string
  level: string
  strength: string
  excerpt: string
  review_status: string
  review_note?: string
  created_at: string
  [key: string]: unknown
}

export interface LedgerRow {
  source_type: string
  source_id: string
  source_seq: number
  summarized_seq: number
  status: string
  summary_id: string
  attempts: number
  last_error: string
  updated_at: string
  [key: string]: unknown
}

export interface AgentTurn {
  id: string
  session_id: string
  turn_id: string
  status: string
  plan_json: Record<string, unknown>
  record_json: Record<string, unknown>
  seq_start: number
  seq_end: number
  started_at: string
  finished_at: string
  [key: string]: unknown
}

export interface ChatEvent {
  requestId: string
  agent: string
  type: 'round' | 'text' | 'tool' | 'tool-end' | 'session'
  round?: number
  text?: string
  tool?: string
  sessionId?: string
  chars?: number
  preview?: string
  cached?: boolean
}

export interface IpcCall {
  seq: number
  method: 'chat' | 'answer' | 'answerSet' | 'cancel' | 'health' | 'settings.get' | 'settings.set' | 'invoke'
  detail: string
  ok: boolean
  durationMs: number
  at: string
  resultPreview?: string
  error?: string
}

export interface ChatInput {
  studentId?: string
  sessionId?: string
  message: string
  scopeOverride?: unknown
  chapterId?: string
  requestId?: string
}

export interface AnswerInput {
  studentId?: string
  sessionId: string
  questionId: string
  answer: string
  artifactId?: string
  chapterId?: string
}

export interface AnswerSetInput {
  studentId?: string
  sessionId: string
  artifactId: string
  answers: Array<{ questionId: string; answer: string }>
  chapterId?: string
}

export interface SettingsInput {
  apiKey?: string
  model?: string
  clearApiKey?: boolean
}
