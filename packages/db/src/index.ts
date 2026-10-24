import { Service, type Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { BRAND } from '@learning-agent/shared/brand'
import { createKpIndex, locateSpan, type KpIndex } from '@learning-agent/shared'
import type {
  BpProject,
  BpSection,
  CaseMatch,
  Artifact,
  Chapter,
  ChatMessage,
  ChatSession,
  ChatSessionSummary,
  EvidenceLevel,
  MatchCandidate,
  ReviewStatus,
  Competency,
  ContentBlock,
  ContentTag,
  Evidence,
  GrowthRecord,
  GrowthSnapshot,
  LearningPlanItem,
  LearningStateRow,
  MemoryEpisode,
  MemoryFact,
  SkillRow,
  SummaryLedger,
  TurnRow,
  StudentProfile,
  IdeologyMatch,
  IdeologyPoint,
  IdeologyTag,
  KnowledgePoint,
  NewsArticle,
  Question,
  QuestionAttempt,
  QuestionBankEntry,
  ResearchArtifact,
  ResearchProject,
  Section,
} from '@learning-agent/shared'

export interface Config {
  path?: string
  appHome?: string
}

export interface BlockSyncReport {
  upserted: number
  remapped_tags: number
  retained_blocks: number
  deleted_blocks: number
  recorded_mappings: number
}

export interface BlockCanonicalMapping {
  oldId: string
  canonicalId: string
  reason?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    learningDb: LearningDb
  }
}

const APP_ID = 0x4c4e5244 // "LN R D"
const SCHEMA_VERSION = 7

const TAG_REVIEW_RANK: Record<string, number> = {
  published: 5,
  adjudicated: 4,
  reviewed: 3,
  rejected: 2,
  draft: 1,
}
const TAG_EVIDENCE_RANK: Record<string, number> = { gold: 3, verified: 2, auto: 1 }
const HUMAN_REVIEW_STATUS: Record<string, true> = {
  reviewed: true,
  adjudicated: true,
  published: true,
  rejected: true,
}

const SCHEMA = `
CREATE TABLE chapters (
  id TEXT PRIMARY KEY, number INTEGER NOT NULL, title TEXT NOT NULL, source_path TEXT NOT NULL
) STRICT;

CREATE TABLE sections (
  id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  number INTEGER NOT NULL, title TEXT NOT NULL
) STRICT;

CREATE TABLE knowledge_points (
  id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  name TEXT NOT NULL, name_en TEXT NOT NULL DEFAULT '', definition TEXT NOT NULL,
  keywords_json TEXT NOT NULL DEFAULT '[]', examples_json TEXT NOT NULL DEFAULT '[]',
  non_examples_json TEXT NOT NULL DEFAULT '[]', aliases_json TEXT NOT NULL DEFAULT '[]',
  difficulty INTEGER NOT NULL DEFAULT 2, competencies_json TEXT NOT NULL DEFAULT '[]',
  decisions_json TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', parent_id TEXT
) STRICT;

CREATE TABLE content_blocks (
  id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  section_id TEXT NOT NULL, block_type TEXT NOT NULL, text TEXT NOT NULL,
  page INTEGER, source TEXT NOT NULL, rights TEXT NOT NULL
) STRICT;

CREATE TABLE content_tags (
  id TEXT PRIMARY KEY, block_id TEXT NOT NULL REFERENCES content_blocks(id) ON DELETE CASCADE,
  tag_type TEXT NOT NULL, tag_key TEXT NOT NULL, tag_role TEXT NOT NULL,
  confidence REAL NOT NULL, method TEXT NOT NULL, evidence_span TEXT NOT NULL,
  evidence_start INTEGER, evidence_end INTEGER, review_status TEXT NOT NULL DEFAULT 'draft'
) STRICT;
CREATE INDEX content_tags_by_key ON content_tags(tag_type, tag_key);

CREATE TABLE ideology_points (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL,
  examples_json TEXT NOT NULL DEFAULT '[]', non_examples_json TEXT NOT NULL DEFAULT '[]',
  related_kp_ids_json TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL
) STRICT;

CREATE TABLE ideology_tags (
  id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  ideology_id TEXT NOT NULL REFERENCES ideology_points(id) ON DELETE CASCADE,
  confidence REAL NOT NULL, evidence_span TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'draft'
) STRICT;
CREATE INDEX ideology_tags_by_target ON ideology_tags(target_type, target_id);

CREATE TABLE news_articles (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
  title TEXT NOT NULL, url TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
  content_status TEXT NOT NULL, rights TEXT NOT NULL, fetched_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX news_articles_by_url ON news_articles(url);
CREATE INDEX news_articles_by_published ON news_articles(published_at);

CREATE TABLE news_tags (
  id TEXT PRIMARY KEY, article_id TEXT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  tag_type TEXT NOT NULL, tag_key TEXT NOT NULL, tag_role TEXT NOT NULL,
  confidence REAL NOT NULL, method TEXT NOT NULL, evidence_span TEXT NOT NULL,
  evidence_start INTEGER, evidence_end INTEGER
) STRICT;
CREATE INDEX news_tags_by_key ON news_tags(tag_type, tag_key);

CREATE TABLE case_matches (
  id TEXT PRIMARY KEY, article_id TEXT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  kp_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  score REAL NOT NULL, confidence REAL NOT NULL, tag_role TEXT NOT NULL,
  evidence_span TEXT NOT NULL, evidence_start INTEGER, evidence_end INTEGER,
  rationale TEXT NOT NULL, method TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE INDEX case_matches_by_article ON case_matches(article_id);
CREATE INDEX case_matches_by_kp ON case_matches(kp_id);

CREATE TABLE questions (
  id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL, stem TEXT NOT NULL, options_json TEXT NOT NULL DEFAULT '[]',
  answer TEXT NOT NULL, explanation TEXT NOT NULL, difficulty INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL
) STRICT;

CREATE TABLE question_kps (
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  kp_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, kp_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX question_kps_by_kp ON question_kps(kp_id);

CREATE TABLE question_ideology (
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  ideology_id TEXT NOT NULL REFERENCES ideology_points(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, ideology_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE question_attempts (
  id TEXT PRIMARY KEY, question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL, answer TEXT NOT NULL, feedback_json TEXT NOT NULL DEFAULT '{}',
  score REAL NOT NULL, created_at TEXT NOT NULL
) STRICT;

CREATE TABLE research_projects (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL, brief TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE research_artifacts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  step TEXT NOT NULL, content_json TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;

CREATE TABLE bp_projects (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL, idea TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE bp_sections (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES bp_projects(id) ON DELETE CASCADE,
  section TEXT NOT NULL, content TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE student_profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, cohort TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
) STRICT;

CREATE TABLE growth_records (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  competency TEXT NOT NULL, level TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE ingest_runs (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT, status TEXT NOT NULL, stats_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE plugin_state (
  plugin_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (plugin_id, key)
) STRICT, WITHOUT ROWID;
`

const MIGRATION_2 = `
ALTER TABLE student_profiles ADD COLUMN profile_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE student_profiles ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

CREATE TABLE competencies (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL,
  levels_json TEXT NOT NULL, observable_json TEXT NOT NULL DEFAULT '[]',
  version TEXT NOT NULL DEFAULT 'v0.1', created_at TEXT NOT NULL
) STRICT;

CREATE TABLE evidence (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  competency_id TEXT NOT NULL REFERENCES competencies(id) ON DELETE CASCADE,
  level TEXT NOT NULL, strength TEXT NOT NULL, evidence_type TEXT NOT NULL,
  source_type TEXT NOT NULL, source_id TEXT NOT NULL DEFAULT '', chapter_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL, method TEXT NOT NULL DEFAULT 'llm', review_status TEXT NOT NULL DEFAULT 'draft',
  review_note TEXT NOT NULL DEFAULT '', occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX evidence_by_student ON evidence(student_id, occurred_at);
CREATE INDEX evidence_by_competency ON evidence(student_id, competency_id);
CREATE INDEX evidence_by_chapter ON evidence(student_id, chapter_id);

CREATE TABLE growth_snapshots (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL, checkpoint TEXT NOT NULL,
  competency_id TEXT NOT NULL REFERENCES competencies(id) ON DELETE CASCADE,
  level TEXT NOT NULL, confidence REAL NOT NULL, evidence_count INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
) STRICT;
CREATE INDEX snapshots_by_student ON growth_snapshots(student_id, chapter_id);

CREATE TABLE learning_plan (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL, phase TEXT NOT NULL, title TEXT NOT NULL,
  tasks_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending',
  due_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX plan_by_student ON learning_plan(student_id, chapter_id);

CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX chat_sessions_by_student ON chat_sessions(student_id, updated_at);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT NOT NULL, evidence_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX chat_messages_by_session ON chat_messages(session_id, created_at);
`

const MIGRATION_3 = `
CREATE TABLE memory_facts (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7, source TEXT NOT NULL DEFAULT 'chat',
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX memory_facts_by_student ON memory_facts(student_id, kind);

CREATE TABLE memory_episodes (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL,
  decisions_json TEXT NOT NULL DEFAULT '[]', open_questions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX memory_episodes_by_student ON memory_episodes(student_id, created_at);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL DEFAULT '', skill_id TEXT NOT NULL, template_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL, title TEXT NOT NULL, format TEXT NOT NULL, path TEXT NOT NULL,
  content TEXT NOT NULL, evidence_ids_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
) STRICT;
CREATE INDEX artifacts_by_student ON artifacts(student_id, created_at);

CREATE TABLE skills (
  id TEXT PRIMARY KEY, expert_id TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', input_schema_json TEXT NOT NULL DEFAULT '{}',
  template_id TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
) STRICT;
`

const MIGRATION_4 = `
ALTER TABLE chat_messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN turn_id TEXT NOT NULL DEFAULT '';
ALTER TABLE chat_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'message';
ALTER TABLE chat_messages ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}';

UPDATE chat_messages
SET seq = (
  SELECT numbered.rn FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at, id) AS rn
    FROM chat_messages
  ) AS numbered
  WHERE numbered.id = chat_messages.id
);
CREATE UNIQUE INDEX chat_messages_seq ON chat_messages(session_id, seq);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_json TEXT NOT NULL DEFAULT '{}',
  record_json TEXT NOT NULL DEFAULT '{}',
  seq_start INTEGER NOT NULL DEFAULT 0,
  seq_end INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT '',
  UNIQUE(session_id, turn_id)
) STRICT;
CREATE INDEX turns_by_session ON turns(session_id, started_at);

CREATE TABLE learning_states (
  student_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (student_id, chapter_id)
) STRICT;

CREATE TABLE summary_ledger (
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  summarized_seq INTEGER NOT NULL DEFAULT 0,
  source_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  summary_id TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_type, source_id)
) STRICT;
CREATE INDEX ledger_by_status ON summary_ledger(status, updated_at);

ALTER TABLE artifacts ADD COLUMN content_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE artifacts ADD COLUMN schema_version TEXT NOT NULL DEFAULT 'Markdown@1';
ALTER TABLE artifacts ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE artifacts ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE artifacts ADD COLUMN source_refs_json TEXT NOT NULL DEFAULT '[]';
`

const MIGRATION_5 = `
CREATE TABLE question_bank (
  question_id TEXT PRIMARY KEY,
  stem_hash TEXT NOT NULL,
  stem TEXT NOT NULL,
  chapter_id TEXT NOT NULL DEFAULT '',
  kp_ids_json TEXT NOT NULL DEFAULT '[]',
  type TEXT NOT NULL,
  difficulty INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX question_bank_stem ON question_bank(stem_hash);
`

const MIGRATION_6 = `
ALTER TABLE content_tags ADD COLUMN evidence_level TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE content_tags ADD COLUMN version TEXT NOT NULL DEFAULT 'v0.1';
ALTER TABLE content_tags ADD COLUMN reviewer_id TEXT NOT NULL DEFAULT '';
ALTER TABLE content_tags ADD COLUMN reviewed_at TEXT NOT NULL DEFAULT '';
CREATE INDEX content_tags_by_review ON content_tags(review_status, evidence_level);

ALTER TABLE case_matches ADD COLUMN review_status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE case_matches ADD COLUMN evidence_level TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE case_matches ADD COLUMN version TEXT NOT NULL DEFAULT 'v0.1';
ALTER TABLE case_matches ADD COLUMN reviewer_id TEXT NOT NULL DEFAULT '';
ALTER TABLE case_matches ADD COLUMN reviewed_at TEXT NOT NULL DEFAULT '';
CREATE INDEX case_matches_by_review ON case_matches(review_status, evidence_level);

ALTER TABLE news_tags ADD COLUMN review_status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE news_tags ADD COLUMN evidence_level TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE news_tags ADD COLUMN version TEXT NOT NULL DEFAULT 'v0.1';
ALTER TABLE news_tags ADD COLUMN reviewer_id TEXT NOT NULL DEFAULT '';
ALTER TABLE news_tags ADD COLUMN reviewed_at TEXT NOT NULL DEFAULT '';

ALTER TABLE ideology_tags ADD COLUMN evidence_level TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE ideology_tags ADD COLUMN version TEXT NOT NULL DEFAULT 'v0.1';
ALTER TABLE ideology_tags ADD COLUMN reviewer_id TEXT NOT NULL DEFAULT '';
ALTER TABLE ideology_tags ADD COLUMN reviewed_at TEXT NOT NULL DEFAULT '';

CREATE TABLE kp_canonical_map (
  old_id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX kp_canonical_map_by_canonical ON kp_canonical_map(canonical_id);

CREATE TABLE block_canonical_map (
  old_id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX block_canonical_map_by_canonical ON block_canonical_map(canonical_id);
`

const MIGRATION_7 = `
ALTER TABLE news_articles ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE news_articles ADD COLUMN tag_content_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX news_articles_by_tag_hash ON news_articles(tag_content_hash);
`

type Row = Record<string, unknown>

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

function nullableNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : number(value)
}

function kpFromRow(row: Row): KnowledgePoint {
  return {
    id: text(row.id),
    chapter_id: text(row.chapter_id),
    section_id: text(row.section_id),
    name: text(row.name),
    name_en: text(row.name_en),
    definition: text(row.definition),
    keywords: parseJson(row.keywords_json, []),
    examples: parseJson(row.examples_json, []),
    non_examples: parseJson(row.non_examples_json, []),
    aliases: parseJson(row.aliases_json, []),
    difficulty: number(row.difficulty),
    competencies: parseJson(row.competencies_json, []),
    decisions: parseJson(row.decisions_json, []),
    source: text(row.source),
    status: text(row.status) as KnowledgePoint['status'],
    parent_id: row.parent_id === null ? null : text(row.parent_id),
  }
}

function newsFromRow(row: Row): NewsArticle {
  return {
    id: text(row.id),
    source: text(row.source),
    source_id: text(row.source_id),
    title: text(row.title),
    url: text(row.url),
    author: text(row.author),
    published_at: text(row.published_at),
    summary: text(row.summary),
    content: text(row.content),
    content_status: text(row.content_status) as NewsArticle['content_status'],
    rights: text(row.rights),
    fetched_at: text(row.fetched_at),
  }
}

function competencyFromRow(row: Row): Competency {
  return {
    id: text(row.id),
    name: text(row.name),
    definition: text(row.definition),
    levels: parseJson(row.levels_json, []),
    observable: parseJson(row.observable_json, []),
    version: text(row.version),
  }
}

function studentProfileFromRow(row: Row): StudentProfile {
  const data = parseJson<Record<string, unknown>>(row.profile_json, {})
  return {
    id: text(row.id),
    name: text(row.name),
    cohort: text(row.cohort),
    background: parseJson(data.background, {}),
    goals: parseJson(data.goals, []),
    preferences: parseJson(data.preferences, {}),
    constraints: parseJson(data.constraints, []),
    self_assessment: parseJson(data.self_assessment, {}),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  }
}

function evidenceFromRow(row: Row): Evidence {
  return {
    id: text(row.id),
    student_id: text(row.student_id),
    competency_id: text(row.competency_id),
    level: text(row.level) as Evidence['level'],
    strength: text(row.strength) as Evidence['strength'],
    evidence_type: text(row.evidence_type) as Evidence['evidence_type'],
    source_type: text(row.source_type) as Evidence['source_type'],
    source_id: text(row.source_id),
    chapter_id: text(row.chapter_id),
    session_id: text(row.session_id),
    excerpt: text(row.excerpt),
    rationale: text(row.rationale),
    confidence: number(row.confidence),
    method: text(row.method) as Evidence['method'],
    review_status: text(row.review_status) as Evidence['review_status'],
    review_note: text(row.review_note),
    occurred_at: text(row.occurred_at),
    created_at: text(row.created_at),
    metadata: parseJson(row.metadata_json, {}),
  }
}

function snapshotFromRow(row: Row): GrowthSnapshot {
  return {
    id: text(row.id),
    student_id: text(row.student_id),
    chapter_id: text(row.chapter_id),
    checkpoint: text(row.checkpoint) as GrowthSnapshot['checkpoint'],
    competency_id: text(row.competency_id),
    level: text(row.level) as GrowthSnapshot['level'],
    confidence: number(row.confidence),
    evidence_count: number(row.evidence_count),
    summary: text(row.summary),
    created_at: text(row.created_at),
  }
}

function planFromRow(row: Row): LearningPlanItem {
  return {
    id: text(row.id),
    student_id: text(row.student_id),
    chapter_id: text(row.chapter_id),
    phase: text(row.phase) as LearningPlanItem['phase'],
    title: text(row.title),
    tasks: parseJson(row.tasks_json, []),
    status: text(row.status) as LearningPlanItem['status'],
    due_at: text(row.due_at),
    updated_at: text(row.updated_at),
  }
}

function memoryFactFromRow(row: Row): MemoryFact {
  return {
    id: text(row.id),
    student_id: text(row.student_id),
    kind: text(row.kind) as MemoryFact['kind'],
    key: text(row.key),
    value: parseJson(row.value_json, null),
    confidence: number(row.confidence),
    source: text(row.source),
    updated_at: text(row.updated_at),
  }
}

function memoryEpisodeFromRow(row: Row): MemoryEpisode {
  return {
    id: text(row.id),
    student_id: text(row.student_id),
    session_id: text(row.session_id),
    summary: text(row.summary),
    decisions: parseJson(row.decisions_json, []),
    open_questions: parseJson(row.open_questions_json, []),
    created_at: text(row.created_at),
  }
}

function artifactFromRow(row: Row): Artifact {
  return {
    id: text(row.id),
    student_id: text(row.student_id),
    session_id: text(row.session_id),
    skill_id: text(row.skill_id),
    template_id: text(row.template_id),
    type: text(row.type) as Artifact['type'],
    title: text(row.title),
    format: text(row.format) as Artifact['format'],
    path: text(row.path),
    content: text(row.content),
    content_json: parseJson(row.content_json, {}),
    schema_version: text(row.schema_version) || 'Markdown@1',
    version: number(row.version) || 1,
    status: (text(row.status) || 'ready') as Artifact['status'],
    source_refs: parseJson(row.source_refs_json, []),
    evidence_ids: parseJson(row.evidence_ids_json, []),
    created_at: text(row.created_at),
  }
}

function skillFromRow(row: Row): SkillRow {
  return {
    id: text(row.id),
    expert_id: text(row.expert_id),
    name: text(row.name),
    description: text(row.description),
    input_schema_json: text(row.input_schema_json),
    template_id: text(row.template_id),
    enabled: number(row.enabled) === 1,
    updated_at: text(row.updated_at),
  }
}

function chatSessionFromRow(row: Row): ChatSession {
  return {
    id: text(row.id),
    student_id: text(row.student_id),
    chapter_id: text(row.chapter_id),
    title: text(row.title),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  }
}

function chatMessageFromRow(row: Row): ChatMessage {
  return {
    id: text(row.id),
    session_id: text(row.session_id),
    role: text(row.role) as ChatMessage['role'],
    content: text(row.content),
    evidence_count: number(row.evidence_count),
    created_at: text(row.created_at),
    seq: number(row.seq),
    turn_id: text(row.turn_id),
    kind: (text(row.kind) || 'message') as ChatMessage['kind'],
    payload_json: parseJson(row.payload_json, {}),
  }
}

function turnFromRow(row: Row): TurnRow {
  return {
    id: text(row.id),
    session_id: text(row.session_id),
    turn_id: text(row.turn_id),
    status: text(row.status) as TurnRow['status'],
    plan_json: parseJson(row.plan_json, {}),
    record_json: parseJson(row.record_json, {}),
    seq_start: number(row.seq_start),
    seq_end: number(row.seq_end),
    started_at: text(row.started_at),
    finished_at: text(row.finished_at),
  }
}

function ledgerFromRow(row: Row): SummaryLedger {
  return {
    source_type: text(row.source_type),
    source_id: text(row.source_id),
    source_seq: number(row.source_seq),
    summarized_seq: number(row.summarized_seq),
    source_hash: text(row.source_hash),
    status: text(row.status) as SummaryLedger['status'],
    summary_id: text(row.summary_id),
    attempts: number(row.attempts),
    last_error: text(row.last_error),
    updated_at: text(row.updated_at),
  }
}

function learningStateFromRow(row: Row): LearningStateRow {
  return {
    student_id: text(row.student_id),
    chapter_id: text(row.chapter_id),
    phase: text(row.phase) as LearningStateRow['phase'],
    state_json: parseJson(row.state_json, {}),
    updated_at: text(row.updated_at),
  }
}

function questionBankFromRow(row: Row): QuestionBankEntry {
  return {
    question_id: text(row.question_id),
    stem_hash: text(row.stem_hash),
    stem: text(row.stem),
    chapter_id: text(row.chapter_id),
    kp_ids: parseJson(row.kp_ids_json, []),
    type: text(row.type),
    difficulty: number(row.difficulty),
    source: text(row.source),
    usage_count: number(row.usage_count),
    created_at: text(row.created_at),
    last_used_at: text(row.last_used_at),
  }
}

function questionFromRow(row: Row, kpIds: string[], ideologyIds: string[]): Question {
  return {
    id: text(row.id),
    source_type: text(row.source_type) as Question['source_type'],
    source_id: text(row.source_id),
    type: text(row.type) as Question['type'],
    stem: text(row.stem),
    options: parseJson(row.options_json, []),
    answer: text(row.answer),
    explanation: text(row.explanation),
    difficulty: number(row.difficulty) as Question['difficulty'],
    kp_ids: kpIds,
    ideology_ids: ideologyIds,
    status: text(row.status) as Question['status'],
  }
}

function contentTagFromRow(row: Row): ContentTag {
  return {
    id: text(row.id),
    block_id: text(row.block_id),
    tag_type: text(row.tag_type) as ContentTag['tag_type'],
    tag_key: text(row.tag_key),
    tag_role: text(row.tag_role) as ContentTag['tag_role'],
    confidence: number(row.confidence),
    method: text(row.method) as ContentTag['method'],
    evidence_span: text(row.evidence_span),
    evidence_start: nullableNumber(row.evidence_start),
    evidence_end: nullableNumber(row.evidence_end),
    review_status: (text(row.review_status) || 'draft') as ContentTag['review_status'],
    evidence_level: (text(row.evidence_level) || 'auto') as ContentTag['evidence_level'],
    version: text(row.version) || 'v0.1',
    reviewer_id: text(row.reviewer_id),
    reviewed_at: text(row.reviewed_at),
  }
}

function caseMatchFromRow(row: Row): CaseMatch {
  return {
    article_id: text(row.article_id),
    kp_id: text(row.kp_id),
    score: number(row.score),
    confidence: number(row.confidence),
    tag_role: text(row.tag_role) as CaseMatch['tag_role'],
    evidence_span: text(row.evidence_span),
    evidence_start: nullableNumber(row.evidence_start),
    evidence_end: nullableNumber(row.evidence_end),
    rationale: text(row.rationale),
    method: text(row.method) as CaseMatch['method'],
    review_status: (text(row.review_status) || 'draft') as CaseMatch['review_status'],
    evidence_level: (text(row.evidence_level) || 'auto') as CaseMatch['evidence_level'],
    version: text(row.version) || 'v0.1',
    reviewer_id: text(row.reviewer_id),
    reviewed_at: text(row.reviewed_at),
    created_at: text(row.created_at),
  }
}

function ideologyMatchFromRow(row: Row): IdeologyMatch {
  return {
    article_id: text(row.target_id),
    ideology_id: text(row.ideology_id),
    confidence: number(row.confidence),
    evidence_span: text(row.evidence_span),
    rationale: text(row.rationale),
    review_status: (text(row.review_status) || 'draft') as IdeologyMatch['review_status'],
    evidence_level: (text(row.evidence_level) || 'auto') as IdeologyMatch['evidence_level'],
    version: text(row.version) || 'v0.1',
    reviewer_id: text(row.reviewer_id),
    reviewed_at: text(row.reviewed_at),
  }
}

export default class LearningDb extends Service {
  static inject: string[] = []

  readonly appHome: string
  readonly dbPath: string
  private readonly db: DatabaseSync
  private kpIndexCache?: KpIndex

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'learningDb')
    this.appHome = config.appHome
      || process.env[BRAND.homeEnv]
      || join(homedir(), BRAND.homeDir)
    this.dbPath = config.path ?? join(this.appHome, 'data', BRAND.dbFile)
    mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 })
    try {
      closeSync(openSync(this.dbPath, 'wx', 0o600))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.ensureApplicationId()
    this.migrate()
    ctx.effect(() => () => this.db.close(), 'learning-db.close')
  }

  private ensureApplicationId(): void {
    const row = this.db.prepare('PRAGMA application_id').get() as Row | undefined
    const current = number(row?.application_id)
    if (current !== 0 && current !== APP_ID) {
      throw new Error('database belongs to another application')
    }
    if (current === 0) this.db.exec(`PRAGMA application_id = ${APP_ID}`)
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as Row | undefined
    let version = number(row?.user_version)
    if (version > SCHEMA_VERSION) {
      throw new Error(`database schema ${version} is newer than supported ${SCHEMA_VERSION}`)
    }
    if (version === 0) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(SCHEMA)
        this.db.exec('PRAGMA user_version = 1')
        this.db.exec('COMMIT')
        version = 1
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 2) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATION_2)
        this.db.exec('PRAGMA user_version = 2')
        this.db.exec('COMMIT')
        version = 2
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 3) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATION_3)
        this.db.exec('PRAGMA user_version = 3')
        this.db.exec('COMMIT')
        version = 3
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 4) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATION_4)
        this.db.exec('PRAGMA user_version = 4')
        this.db.exec('COMMIT')
        version = 4
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 5) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATION_5)
        this.db.exec('PRAGMA user_version = 5')
        this.db.exec('COMMIT')
        version = 5
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 6) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATION_6)
        this.db.exec('PRAGMA user_version = 6')
        this.db.exec('COMMIT')
        version = 6
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 7) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATION_7)
        this.db.exec('PRAGMA user_version = 7')
        this.db.exec('COMMIT')
        version = 7
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version >= 6) this.mergeDuplicateKps()
  }

  /** Clear seeded domain data while leaving the schema and application id intact. */
  resetDomainData(): void {
    this.transaction(() => {
      for (const table of [
        'summary_ledger',
        'kp_canonical_map',
        'block_canonical_map',
        'learning_states',
        'turns',
        'question_bank',
        'artifacts',
        'memory_episodes',
        'memory_facts',
        'skills',
        'chat_messages',
        'chat_sessions',
        'evidence',
        'growth_snapshots',
        'learning_plan',
        'competencies',
        'question_attempts',
        'question_ideology',
        'question_kps',
        'questions',
        'case_matches',
        'news_tags',
        'ideology_tags',
        'news_articles',
        'ideology_points',
        'content_tags',
        'content_blocks',
        'knowledge_points',
        'sections',
        'chapters',
        'research_artifacts',
        'research_projects',
        'bp_sections',
        'bp_projects',
        'growth_records',
        'student_profiles',
        'ingest_runs',
        'plugin_state',
      ]) {
        this.db.exec(`DELETE FROM ${table}`)
      }
    })
    this.kpIndexCache = undefined
  }

  upsertStudentProfile(profile: StudentProfile): void {
    const timestamp = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO student_profiles (id, name, cohort, created_at, profile_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, cohort=excluded.cohort,
           profile_json=excluded.profile_json, updated_at=excluded.updated_at`,
      )
      .run(
        profile.id,
        profile.name,
        profile.cohort,
        profile.created_at || timestamp,
        toJson({
          background: profile.background,
          goals: profile.goals,
          preferences: profile.preferences,
          constraints: profile.constraints,
          self_assessment: profile.self_assessment,
        }),
        profile.updated_at || timestamp,
      )
  }

  getStudentProfile(id: string): StudentProfile | undefined {
    const row = this.db.prepare('SELECT * FROM student_profiles WHERE id=?').get(id) as Row | undefined
    return row ? studentProfileFromRow(row) : undefined
  }

  listStudentProfiles(): StudentProfile[] {
    return this.db
      .prepare('SELECT * FROM student_profiles ORDER BY name')
      .all()
      .map((row) => studentProfileFromRow(row as Row))
  }

  upsertCompetencies(items: Competency[]): void {
    const timestamp = new Date().toISOString()
    const stmt = this.db.prepare(
      `INSERT INTO competencies (id, name, definition, levels_json, observable_json, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, definition=excluded.definition,
         levels_json=excluded.levels_json, observable_json=excluded.observable_json,
         version=excluded.version`,
    )
    this.transaction(() => {
      for (const item of items) {
        stmt.run(
          item.id,
          item.name,
          item.definition,
          toJson(item.levels),
          toJson(item.observable),
          item.version,
          timestamp,
        )
      }
    })
  }

  listCompetencies(): Competency[] {
    return this.db
      .prepare('SELECT * FROM competencies ORDER BY name')
      .all()
      .map((row) => competencyFromRow(row as Row))
  }

  insertEvidence(items: Evidence[]): number {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO evidence (
        id, student_id, competency_id, level, strength, evidence_type, source_type,
        source_id, chapter_id, session_id, excerpt, rationale, confidence, method,
        review_status, review_note, occurred_at, created_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    let inserted = 0
    this.transaction(() => {
      for (const item of items) {
        const result = stmt.run(
          item.id,
          item.student_id,
          item.competency_id,
          item.level,
          item.strength,
          item.evidence_type,
          item.source_type,
          item.source_id,
          item.chapter_id,
          item.session_id,
          item.excerpt,
          item.rationale,
          item.confidence,
          item.method,
          item.review_status,
          item.review_note,
          item.occurred_at,
          item.created_at || new Date().toISOString(),
          toJson(item.metadata),
        )
        inserted += Number(result.changes)
      }
    })
    return inserted
  }

  listEvidence(opts: {
    studentId: string
    competencyId?: string
    chapterId?: string
    limit?: number
  }): Evidence[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
    const clauses = ['student_id=?']
    const args: Array<string | number> = [opts.studentId]
    if (opts.competencyId) {
      clauses.push('competency_id=?')
      args.push(opts.competencyId)
    }
    if (opts.chapterId) {
      clauses.push('chapter_id=?')
      args.push(opts.chapterId)
    }
    args.push(limit)
    return this.db
      .prepare(`SELECT * FROM evidence WHERE ${clauses.join(' AND ')} ORDER BY occurred_at DESC LIMIT ?`)
      .all(...args)
      .map((row) => evidenceFromRow(row as Row))
  }

  /** Re-mark demo seed evidence after a re-seed; never touches other evidence ids. */
  markSyntheticEvidence(ids: string[]): number {
    if (ids.length === 0) return 0
    const stmt = this.db.prepare(
      `UPDATE evidence
       SET method='rule', review_status='draft',
           metadata_json=json_set(COALESCE(NULLIF(metadata_json,''),'{}'), '$.synthetic', 1, '$.seed', 'evidence_seed.yaml')
       WHERE id=? AND (id LIKE 'ev_demo_%' OR json_extract(metadata_json, '$.synthetic') = 1)`,
    )
    let changed = 0
    this.transaction(() => {
      for (const id of ids) changed += Number(stmt.run(id).changes)
    })
    return changed
  }

  updateEvidenceReview(id: string, status: Evidence['review_status'], note: string): void {
    this.db
      .prepare(
        `UPDATE evidence
         SET review_status=?, review_note=?,
             confidence=CASE
               WHEN ?='reviewed' THEN MIN(1, confidence + 0.1)
               WHEN ?='rejected' THEN 0
               ELSE confidence
             END
         WHERE id=?`,
      )
      .run(status, note, status, status, id)
  }

  insertGrowthSnapshot(snapshot: GrowthSnapshot): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO growth_snapshots (
          id, student_id, chapter_id, checkpoint, competency_id, level, confidence,
          evidence_count, summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.student_id,
        snapshot.chapter_id,
        snapshot.checkpoint,
        snapshot.competency_id,
        snapshot.level,
        snapshot.confidence,
        snapshot.evidence_count,
        snapshot.summary,
        snapshot.created_at,
      )
  }

  listGrowthSnapshots(studentId: string, chapterId?: string): GrowthSnapshot[] {
    const rows = chapterId
      ? this.db
          .prepare('SELECT * FROM growth_snapshots WHERE student_id=? AND chapter_id=? ORDER BY created_at')
          .all(studentId, chapterId)
      : this.db
          .prepare('SELECT * FROM growth_snapshots WHERE student_id=? ORDER BY created_at')
          .all(studentId)
    return rows.map((row) => snapshotFromRow(row as Row))
  }

  upsertLearningPlan(items: LearningPlanItem[]): void {
    const timestamp = new Date().toISOString()
    const stmt = this.db.prepare(
      `INSERT INTO learning_plan (
        id, student_id, chapter_id, phase, title, tasks_json, status, due_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET chapter_id=excluded.chapter_id, phase=excluded.phase,
        title=excluded.title, tasks_json=excluded.tasks_json, status=excluded.status,
        due_at=excluded.due_at, updated_at=excluded.updated_at`,
    )
    this.transaction(() => {
      for (const item of items) {
        stmt.run(
          item.id,
          item.student_id,
          item.chapter_id,
          item.phase,
          item.title,
          toJson(item.tasks),
          item.status,
          item.due_at,
          item.updated_at || timestamp,
        )
      }
    })
  }

  listLearningPlan(studentId: string, chapterId?: string): LearningPlanItem[] {
    const rows = chapterId
      ? this.db
          .prepare('SELECT * FROM learning_plan WHERE student_id=? AND chapter_id=? ORDER BY chapter_id, phase')
          .all(studentId, chapterId)
      : this.db
          .prepare('SELECT * FROM learning_plan WHERE student_id=? ORDER BY chapter_id, phase')
          .all(studentId)
    return rows.map((row) => planFromRow(row as Row))
  }

  createChatSession(input: { studentId: string; chapterId?: string; title?: string }): string {
    const id = `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const timestamp = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO chat_sessions (id, student_id, chapter_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.studentId, input.chapterId ?? '', input.title ?? '', timestamp, timestamp)
    return id
  }

  getChatSession(id: string): ChatSession | undefined {
    const row = this.db.prepare('SELECT * FROM chat_sessions WHERE id=?').get(id) as Row | undefined
    return row ? chatSessionFromRow(row) : undefined
  }

  listChatSessions(studentId: string): ChatSession[] {
    return this.db
      .prepare('SELECT * FROM chat_sessions WHERE student_id=? ORDER BY updated_at DESC')
      .all(studentId)
      .map((row) => chatSessionFromRow(row as Row))
  }

  getChatSessionSummary(id: string): ChatSessionSummary | undefined {
    const session = this.getChatSession(id)
    if (!session) return undefined
    const lastTurn = this.getLastTurn(id)
    const plan = lastTurn?.plan_json && typeof lastTurn.plan_json === 'object'
      ? lastTurn.plan_json as { asks?: unknown[] }
      : {}
    const pendingAsks = Array.isArray(plan.asks) ? plan.asks.length : 0
    const ledger = this.getSummaryLedger('session', id)
    const artifact = this.db
      .prepare('SELECT COUNT(*) AS count, MAX(created_at) AS latest FROM artifacts WHERE session_id=?')
      .get(id) as Row | undefined
    const assistant = this.db
      .prepare("SELECT MAX(created_at) AS latest FROM chat_messages WHERE session_id=? AND role='assistant'")
      .get(id) as Row | undefined
    const artifactLatest = text(artifact?.latest)
    const assistantLatest = text(assistant?.latest)
    const hasNewArtifact = artifactLatest.length > 0 && (assistantLatest.length === 0 || artifactLatest > assistantLatest)
    const chapter = session.chapter_id
      ? (this.db.prepare('SELECT title FROM chapters WHERE id=?').get(session.chapter_id) as Row | undefined)
      : undefined
    const status: ChatSessionSummary['status'] =
      pendingAsks > 0
        ? 'awaiting_confirmation'
        : hasNewArtifact
          ? 'new_artifact'
          : ledger && ledger.status === 'summarized' && ledger.summarized_seq >= ledger.source_seq
            ? 'organized'
            : 'active'
    return {
      id: session.id,
      title: session.title,
      chapterId: session.chapter_id,
      chapterTitle: text(chapter?.title) || session.chapter_id,
      status,
      lastTurnAt: lastTurn?.finished_at || lastTurn?.started_at || session.updated_at,
      pendingAsks,
      hasNewArtifact,
      ledgerStatus: (ledger?.status ?? '') as ChatSessionSummary['ledgerStatus'],
    }
  }

  listChatSessionSummaries(studentId: string): ChatSessionSummary[] {
    return this.listChatSessions(studentId)
      .map((session) => this.getChatSessionSummary(session.id))
      .filter((summary): summary is ChatSessionSummary => summary !== undefined)
  }

  nextChatSeq(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM chat_messages WHERE session_id=?')
      .get(sessionId) as Row | undefined
    return number(row?.value) + 1
  }

  insertChatMessage(message: ChatMessage): ChatMessage {
    const seq = message.seq > 0 ? message.seq : this.nextChatSeq(message.session_id)
    const stored: ChatMessage = {
      ...message,
      seq,
      turn_id: message.turn_id ?? '',
      kind: message.kind ?? 'message',
      payload_json: message.payload_json ?? {},
    }
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO chat_messages (
            id, session_id, role, content, evidence_count, created_at, seq, turn_id, kind, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          stored.id,
          stored.session_id,
          stored.role,
          stored.content,
          stored.evidence_count,
          stored.created_at,
          stored.seq,
          stored.turn_id,
          stored.kind,
          toJson(stored.payload_json),
        )
      this.db
        .prepare('UPDATE chat_sessions SET updated_at=? WHERE id=?')
        .run(stored.created_at, stored.session_id)
      this.bumpSummaryLedger(stored.session_id)
    })
    return stored
  }

  listChatMessages(sessionId: string): ChatMessage[] {
    return this.db
      .prepare('SELECT * FROM chat_messages WHERE session_id=? ORDER BY seq, created_at')
      .all(sessionId)
      .map((row) => chatMessageFromRow(row as Row))
  }

  listChatMessagesAfter(sessionId: string, seq: number): ChatMessage[] {
    return this.db
      .prepare('SELECT * FROM chat_messages WHERE session_id=? AND seq>? ORDER BY seq')
      .all(sessionId, seq)
      .map((row) => chatMessageFromRow(row as Row))
  }

  getChatMessage(id: string): ChatMessage | undefined {
    const row = this.db.prepare('SELECT * FROM chat_messages WHERE id=?').get(id) as Row | undefined
    return row ? chatMessageFromRow(row) : undefined
  }

  updateChatSession(id: string, input: { chapterId?: string; title?: string }): void {
    const current = this.getChatSession(id)
    if (!current) return
    this.db
      .prepare('UPDATE chat_sessions SET chapter_id=?, title=?, updated_at=? WHERE id=?')
      .run(
        input.chapterId ?? current.chapter_id,
        input.title ?? current.title,
        new Date().toISOString(),
        id,
      )
  }

  upsertTurn(turn: TurnRow): void {
    this.db
      .prepare(
        `INSERT INTO turns (
          id, session_id, turn_id, status, plan_json, record_json,
          seq_start, seq_end, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, turn_id) DO UPDATE SET
          status=excluded.status,
          plan_json=excluded.plan_json,
          record_json=excluded.record_json,
          seq_start=excluded.seq_start,
          seq_end=excluded.seq_end,
          finished_at=excluded.finished_at`,
      )
      .run(
        turn.id,
        turn.session_id,
        turn.turn_id,
        turn.status,
        toJson(turn.plan_json),
        toJson(turn.record_json),
        turn.seq_start,
        turn.seq_end,
        turn.started_at,
        turn.finished_at,
      )
  }

  getTurn(sessionId: string, turnId: string): TurnRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM turns WHERE session_id=? AND turn_id=?')
      .get(sessionId, turnId) as Row | undefined
    return row ? turnFromRow(row) : undefined
  }

  getLastTurn(sessionId: string): TurnRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM turns WHERE session_id=? ORDER BY started_at DESC LIMIT 1')
      .get(sessionId) as Row | undefined
    return row ? turnFromRow(row) : undefined
  }

  listTurns(sessionId: string, limit = 20): TurnRow[] {
    return this.db
      .prepare('SELECT * FROM turns WHERE session_id=? ORDER BY started_at DESC LIMIT ?')
      .all(sessionId, Math.min(Math.max(limit, 1), 100))
      .map((row) => turnFromRow(row as Row))
  }

  listTurnsBetween(sessionId: string, seqStart: number, seqEnd: number): TurnRow[] {
    return this.db
      .prepare('SELECT * FROM turns WHERE session_id=? AND seq_end>=? AND seq_start<=? ORDER BY started_at')
      .all(sessionId, seqStart, seqEnd)
      .map((row) => turnFromRow(row as Row))
  }

  upsertLearningState(state: LearningStateRow): void {
    this.db
      .prepare(
        `INSERT INTO learning_states (student_id, chapter_id, phase, state_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(student_id, chapter_id) DO UPDATE SET
           phase=excluded.phase, state_json=excluded.state_json, updated_at=excluded.updated_at`,
      )
      .run(state.student_id, state.chapter_id, state.phase, toJson(state.state_json), state.updated_at)
  }

  getLearningState(studentId: string, chapterId: string): LearningStateRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM learning_states WHERE student_id=? AND chapter_id=?')
      .get(studentId, chapterId) as Row | undefined
    return row ? learningStateFromRow(row) : undefined
  }

  listLearningStates(studentId: string): LearningStateRow[] {
    return this.db
      .prepare('SELECT * FROM learning_states WHERE student_id=? ORDER BY updated_at DESC')
      .all(studentId)
      .map((row) => learningStateFromRow(row as Row))
  }

  getSummaryLedger(sourceType: string, sourceId: string): SummaryLedger | undefined {
    const row = this.db
      .prepare('SELECT * FROM summary_ledger WHERE source_type=? AND source_id=?')
      .get(sourceType, sourceId) as Row | undefined
    return row ? ledgerFromRow(row) : undefined
  }

  listSummaryLedgers(studentId?: string): SummaryLedger[] {
    if (!studentId) {
      return this.db
        .prepare('SELECT * FROM summary_ledger ORDER BY updated_at DESC')
        .all()
        .map((row) => ledgerFromRow(row as Row))
    }
    return this.db
      .prepare(
        `SELECT ledger.* FROM summary_ledger AS ledger
         JOIN chat_sessions AS session
           ON ledger.source_type='session' AND session.id=ledger.source_id
         WHERE session.student_id=?
         ORDER BY ledger.updated_at DESC`,
      )
      .all(studentId)
      .map((row) => ledgerFromRow(row as Row))
  }

  saveSummaryLedger(ledger: SummaryLedger): void {
    this.db
      .prepare(
        `INSERT INTO summary_ledger (
          source_type, source_id, source_seq, summarized_seq, source_hash,
          status, summary_id, attempts, last_error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_type, source_id) DO UPDATE SET
          source_seq=MAX(summary_ledger.source_seq, excluded.source_seq),
          summarized_seq=MAX(summary_ledger.summarized_seq, excluded.summarized_seq),
          source_hash=CASE
            WHEN excluded.summarized_seq >= summary_ledger.summarized_seq THEN excluded.source_hash
            ELSE summary_ledger.source_hash
          END,
          summary_id=CASE
            WHEN excluded.summarized_seq >= summary_ledger.summarized_seq THEN excluded.summary_id
            ELSE summary_ledger.summary_id
          END,
          attempts=CASE
            WHEN excluded.status='failed' THEN MAX(summary_ledger.attempts, excluded.attempts)
            WHEN excluded.status='pending' THEN 0
            ELSE summary_ledger.attempts
          END,
          last_error=CASE
            WHEN excluded.status='failed' THEN excluded.last_error
            WHEN excluded.status='pending' THEN ''
            ELSE summary_ledger.last_error
          END,
          status=CASE
            WHEN MAX(summary_ledger.source_seq, excluded.source_seq)
              <= MAX(summary_ledger.summarized_seq, excluded.summarized_seq) THEN 'summarized'
            WHEN excluded.status='failed' THEN 'failed'
            WHEN excluded.status='pending' THEN 'pending'
            ELSE 'stale'
          END,
          updated_at=excluded.updated_at`,
      )
      .run(
        ledger.source_type,
        ledger.source_id,
        ledger.source_seq,
        ledger.summarized_seq,
        ledger.source_hash,
        ledger.status,
        ledger.summary_id,
        ledger.attempts,
        ledger.last_error,
        ledger.updated_at,
      )
  }

  private bumpSummaryLedger(sessionId: string): void {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM chat_messages WHERE session_id=?')
      .get(sessionId) as Row | undefined
    const sourceSeq = number(row?.value)
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO summary_ledger (
          source_type, source_id, source_seq, summarized_seq, status, updated_at
        ) VALUES ('session', ?, ?, 0, 'pending', ?)
        ON CONFLICT(source_type, source_id) DO UPDATE SET
          source_seq=excluded.source_seq,
          status=CASE
            WHEN summary_ledger.summarized_seq >= excluded.source_seq THEN 'summarized'
            WHEN summary_ledger.status IN ('pending', 'failed') THEN summary_ledger.status
            ELSE 'stale'
          END,
          updated_at=excluded.updated_at`,
      )
      .run(sessionId, sourceSeq, now)
  }

  upsertMemoryFact(fact: MemoryFact): void {
    this.db
      .prepare(
        `INSERT INTO memory_facts (id, student_id, kind, key, value_json, confidence, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, key=excluded.key, value_json=excluded.value_json,
           confidence=excluded.confidence, source=excluded.source, updated_at=excluded.updated_at`,
      )
      .run(
        fact.id,
        fact.student_id,
        fact.kind,
        fact.key,
        toJson(fact.value),
        fact.confidence,
        fact.source,
        fact.updated_at,
      )
  }

  listMemoryFacts(studentId: string, kind?: MemoryFact['kind']): MemoryFact[] {
    const rows = kind
      ? this.db.prepare('SELECT * FROM memory_facts WHERE student_id=? AND kind=? ORDER BY updated_at DESC').all(studentId, kind)
      : this.db.prepare('SELECT * FROM memory_facts WHERE student_id=? ORDER BY updated_at DESC').all(studentId)
    return rows.map((row) => memoryFactFromRow(row as Row))
  }

  deleteMemoryFact(id: string): void {
    this.db.prepare('DELETE FROM memory_facts WHERE id=?').run(id)
  }

  insertMemoryEpisode(episode: MemoryEpisode): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_episodes (
          id, student_id, session_id, summary, decisions_json, open_questions_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        episode.id,
        episode.student_id,
        episode.session_id,
        episode.summary,
        toJson(episode.decisions),
        toJson(episode.open_questions),
        episode.created_at,
      )
  }

  /**
   * The two seed-student demo rows stay in the table for provenance but are
   * excluded by exact id + session pair (never a `demo_*` prefix) so chat
   * compression cannot present them as real learning history.
   */
  listMemoryEpisodes(
    studentId: string,
    limit = 20,
    opts: { includeSynthetic?: boolean } = {},
  ): MemoryEpisode[] {
    const limitValue = Math.min(Math.max(limit, 1), 100)
    if (opts.includeSynthetic) {
      return this.db
        .prepare('SELECT * FROM memory_episodes WHERE student_id=? ORDER BY created_at DESC LIMIT ?')
        .all(studentId, limitValue)
        .map((row) => memoryEpisodeFromRow(row as Row))
    }
    const preId = `${studentId}:episode:ch04_pre`
    const postId = `${studentId}:episode:ch04_post`
    return this.db
      .prepare(
        `SELECT * FROM memory_episodes
         WHERE student_id=?
           AND NOT (
             (session_id='demo_pre' AND id=?)
             OR (session_id='demo_post' AND id=?)
           )
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(studentId, preId, postId, limitValue)
      .map((row) => memoryEpisodeFromRow(row as Row))
  }

  insertArtifact(artifact: Artifact): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (
          id, student_id, session_id, skill_id, template_id, type, title, format,
          path, content, evidence_ids_json, created_at,
          content_json, schema_version, version, status, source_refs_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.student_id,
        artifact.session_id,
        artifact.skill_id,
        artifact.template_id,
        artifact.type,
        artifact.title,
        artifact.format,
        artifact.path,
        artifact.content,
        toJson(artifact.evidence_ids),
        artifact.created_at,
        toJson(artifact.content_json),
        artifact.schema_version,
        artifact.version,
        artifact.status,
        toJson(artifact.source_refs),
      )
  }

  appendArtifactEvidence(id: string, evidenceIds: string[]): void {
    if (evidenceIds.length === 0) return
    const artifact = this.getArtifact(id)
    if (!artifact) return
    const merged = [...new Set([...artifact.evidence_ids, ...evidenceIds])]
    this.db
      .prepare('UPDATE artifacts SET evidence_ids_json=? WHERE id=?')
      .run(toJson(merged), id)
  }

  updateArtifactStatus(id: string, status: Artifact['status']): void {
    this.db.prepare('UPDATE artifacts SET status=? WHERE id=?').run(status, id)
  }

  listArtifacts(studentId: string, limit = 20): Artifact[] {
    return this.db
      .prepare('SELECT * FROM artifacts WHERE student_id=? ORDER BY created_at DESC LIMIT ?')
      .all(studentId, Math.min(Math.max(limit, 1), 100))
      .map((row) => artifactFromRow(row as Row))
  }

  listAllArtifacts(limit = 1000): Artifact[] {
    return this.db
      .prepare('SELECT * FROM artifacts ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 10000))
      .map((row) => artifactFromRow(row as Row))
  }

  getArtifact(id: string): Artifact | undefined {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id) as Row | undefined
    return row ? artifactFromRow(row) : undefined
  }

  upsertSkills(skills: SkillRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO skills (id, expert_id, name, description, input_schema_json, template_id, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET expert_id=excluded.expert_id, name=excluded.name,
         description=excluded.description, input_schema_json=excluded.input_schema_json,
         template_id=excluded.template_id, enabled=excluded.enabled, updated_at=excluded.updated_at`,
    )
    this.transaction(() => {
      for (const skill of skills) {
        stmt.run(
          skill.id,
          skill.expert_id,
          skill.name,
          skill.description,
          skill.input_schema_json,
          skill.template_id,
          skill.enabled ? 1 : 0,
          skill.updated_at,
        )
      }
    })
  }

  listSkills(): SkillRow[] {
    return this.db.prepare('SELECT * FROM skills ORDER BY expert_id, name').all().map((row) => skillFromRow(row as Row))
  }

  listChapters(): Chapter[] {
    return this.db
      .prepare('SELECT id, number, title, source_path FROM chapters ORDER BY number')
      .all()
      .map((row) => ({
        id: text((row as Row).id),
        number: number((row as Row).number),
        title: text((row as Row).title),
        source_path: text((row as Row).source_path),
      }))
  }

  upsertChapters(chapters: Chapter[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO chapters (id, number, title, source_path) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET number=excluded.number, title=excluded.title, source_path=excluded.source_path`,
    )
    this.transaction(() => {
      for (const chapter of chapters) {
        stmt.run(chapter.id, chapter.number, chapter.title, chapter.source_path)
      }
    })
  }

  listSections(chapterId?: string): Section[] {
    const rows = chapterId
      ? this.db
          .prepare('SELECT id, chapter_id, number, title FROM sections WHERE chapter_id=? ORDER BY number')
          .all(chapterId)
      : this.db.prepare('SELECT id, chapter_id, number, title FROM sections ORDER BY chapter_id, number').all()
    return rows.map((row) => ({
      id: text((row as Row).id),
      chapter_id: text((row as Row).chapter_id),
      number: number((row as Row).number),
      title: text((row as Row).title),
    }))
  }

  upsertSections(sections: Section[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO sections (id, chapter_id, number, title) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET chapter_id=excluded.chapter_id, number=excluded.number, title=excluded.title`,
    )
    this.transaction(() => {
      for (const section of sections) {
        stmt.run(section.id, section.chapter_id, section.number, section.title)
      }
    })
  }

  getKp(id: string): KnowledgePoint | undefined {
    const row = this.db.prepare('SELECT * FROM knowledge_points WHERE id=?').get(id) as Row | undefined
    if (row) return kpFromRow(row)
    const canonical = this.resolveCanonicalKpId(id)
    if (canonical && canonical !== id) {
      const mapped = this.db.prepare('SELECT * FROM knowledge_points WHERE id=?').get(canonical) as Row | undefined
      return mapped ? kpFromRow(mapped) : undefined
    }
    return undefined
  }

  searchKps(query: string, chapter?: string, limit = 20): KnowledgePoint[] {
    const capped = Math.min(Math.max(limit, 1), 200)
    const like = `%${query}%`
    const rows = chapter
      ? this.db
          .prepare(
            `SELECT * FROM knowledge_points
             WHERE chapter_id=? AND (name LIKE ? OR definition LIKE ? OR aliases_json LIKE ? OR keywords_json LIKE ?)
             ORDER BY CASE WHEN name LIKE ? THEN 0 ELSE 1 END, name LIMIT ?`,
          )
          .all(chapter, like, like, like, like, like, capped)
      : this.db
          .prepare(
            `SELECT * FROM knowledge_points
             WHERE name LIKE ? OR definition LIKE ? OR aliases_json LIKE ? OR keywords_json LIKE ?
             ORDER BY CASE WHEN name LIKE ? THEN 0 ELSE 1 END, name LIMIT ?`,
          )
          .all(like, like, like, like, like, capped)
    return rows.map((row) => kpFromRow(row as Row))
  }

  listKpsByChapter(chapterId: string): KnowledgePoint[] {
    return this.db
      .prepare('SELECT * FROM knowledge_points WHERE chapter_id=? ORDER BY section_id, name')
      .all(chapterId)
      .map((row) => kpFromRow(row as Row))
  }

  listAllKps(): KnowledgePoint[] {
    return this.db
      .prepare('SELECT * FROM knowledge_points ORDER BY chapter_id, section_id, name')
      .all()
      .map((row) => kpFromRow(row as Row))
  }

  private kpIndex(): KpIndex {
    this.kpIndexCache ??= createKpIndex(this.listAllKps())
    return this.kpIndexCache
  }

  resolveCanonicalKpId(value: string): string | undefined {
    if (!value) return undefined
    const direct = this.db.prepare('SELECT id FROM knowledge_points WHERE id=?').get(value) as Row | undefined
    if (direct) return text(direct.id)
    const mapped = this.db
      .prepare('SELECT canonical_id FROM kp_canonical_map WHERE old_id=?')
      .get(value) as Row | undefined
    if (mapped) return text(mapped.canonical_id)
    return this.kpIndex().resolve(value)?.id
  }

  getCanonicalKpMap(): Array<{ old_id: string; canonical_id: string; name: string }> {
    return this.db
      .prepare('SELECT old_id, canonical_id, name FROM kp_canonical_map ORDER BY old_id')
      .all()
      .map((row) => {
        const r = row as Row
        return {
          old_id: text(r.old_id),
          canonical_id: text(r.canonical_id),
          name: text(r.name),
        }
      })
  }

  /**
   * Merge duplicate knowledge points into one canonical id, remap all persisted
   * references, and keep old ids resolvable via kp_canonical_map. Manual merges
   * must both exist in the same chapter and stay acyclic; parent/child hierarchy
   * is never merged. Idempotent: a second run finds nothing left to collapse.
   */
  mergeDuplicateKps(
    manualMerges: ReadonlyArray<{ oldId: string; canonicalId: string }> = [],
  ): number {
    const groups = this.db
      .prepare(
        `SELECT chapter_id, TRIM(name) AS name, GROUP_CONCAT(id) AS ids
         FROM knowledge_points
         GROUP BY chapter_id, TRIM(name)
         HAVING COUNT(*) > 1`,
      )
      .all() as Row[]

    // Fail loudly on a bad alias map instead of silently merging the wrong concept.
    const physicalRow = (id: string): Row | undefined =>
      this.db.prepare('SELECT * FROM knowledge_points WHERE id=?').get(id) as Row | undefined
    const manualGroups: Array<{ canonicalId: string; oldIds: string[] }> = []
    {
      const byCanonical = new Map<string, string[]>()
      const oldTargets = new Map<string, string>()
      for (const entry of manualMerges) {
        const oldId = entry.oldId.trim()
        const canonicalId = entry.canonicalId.trim()
        if (!oldId || !canonicalId) continue
        if (oldId === canonicalId) {
          throw new Error(`[kp-merge] old_id and canonical_id are both ${oldId}`)
        }
        const oldRow = physicalRow(oldId)
        const canonicalRow = physicalRow(canonicalId)
        if (!oldRow || !canonicalRow) continue // already collapsed or not seeded -> idempotent no-op
        if (text(oldRow.chapter_id) !== text(canonicalRow.chapter_id)) {
          throw new Error(
            `[kp-merge] cross-chapter merge refused: ${oldId} (${text(oldRow.chapter_id)}) -> ` +
              `${canonicalId} (${text(canonicalRow.chapter_id)})`,
          )
        }
        if (oldTargets.has(oldId) && oldTargets.get(oldId) !== canonicalId) {
          throw new Error(`[kp-merge] ${oldId} is mapped to two different canonical ids`)
        }
        // Cycle: canonical chain that leads back to oldId.
        let cursor: string | undefined = canonicalId
        const seen = new Set<string>()
        while (cursor && !seen.has(cursor)) {
          seen.add(cursor)
          if (cursor === oldId) {
            throw new Error(`[kp-merge] cycle detected between ${oldId} and ${canonicalId}`)
          }
          cursor = oldTargets.get(cursor)
        }
        oldTargets.set(oldId, canonicalId)
        if (!byCanonical.has(canonicalId)) byCanonical.set(canonicalId, [])
        byCanonical.get(canonicalId)!.push(oldId)
      }
      for (const [canonicalId, oldIds] of byCanonical) {
        const unique = [...new Set(oldIds)].filter(
          (id) => physicalRow(id) !== undefined && id !== canonicalId,
        )
        if (unique.length > 0) manualGroups.push({ canonicalId, oldIds: unique })
      }
    }
    if (groups.length === 0 && manualGroups.length === 0) return 0

    const statusRank: Record<string, number> = { published: 3, reviewed: 2, draft: 1 }
    const reviewRank: Record<string, number> = {
      published: 5,
      adjudicated: 4,
      reviewed: 3,
      rejected: 2,
      draft: 1,
    }
    const evidenceRank: Record<string, number> = { gold: 3, verified: 2, auto: 1 }
    let merged = 0
    const now = new Date().toISOString()
    const referenceCount = this.db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM question_kps WHERE kp_id=?) +
        (SELECT COUNT(*) FROM content_tags WHERE tag_type='knowledge_point' AND tag_key=?) +
        (SELECT COUNT(*) FROM case_matches WHERE kp_id=?) +
        (SELECT COUNT(*) FROM news_tags WHERE tag_type='knowledge_point' AND tag_key=?) +
        (SELECT COUNT(*) FROM knowledge_points WHERE parent_id=?) AS value`,
    )
    const remapJsonArray = (table: string, column: string, oldId: string, newId: string): void => {
      const rows = this.db.prepare(`SELECT rowid AS rid, ${column} AS value FROM ${table}`).all() as Row[]
      const update = this.db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`)
      for (const row of rows) {
        const values = parseJson<unknown>(row.value, [])
        if (!Array.isArray(values) || !values.includes(oldId)) continue
        update.run(toJson(values.map((value) => (value === oldId ? newId : value))), number(row.rid))
      }
    }
    const replaceJsonText = (table: string, column: string, oldId: string, newId: string): void => {
      this.db
        .prepare(
          `UPDATE ${table} SET ${column}=replace(${column}, ?, ?)
           WHERE ${column} LIKE ?`,
        )
        .run(JSON.stringify(oldId), JSON.stringify(newId), `%${oldId}%`)
    }
    const remapMatch = (oldId: string, newId: string): void => {
      const rows = this.db.prepare('SELECT * FROM case_matches WHERE kp_id=?').all(oldId) as Row[]
      for (const row of rows) {
        const existing = this.db
          .prepare('SELECT * FROM case_matches WHERE article_id=? AND kp_id=?')
          .get(text(row.article_id), newId) as Row | undefined
        if (!existing) {
          this.db
            .prepare('UPDATE case_matches SET id=?, kp_id=? WHERE id=?')
            .run(`${text(row.article_id)}:${newId}`, newId, text(row.id))
          continue
        }
        const incomingWins =
          (reviewRank[text(row.review_status)] ?? 0) > (reviewRank[text(existing.review_status)] ?? 0) ||
          ((reviewRank[text(row.review_status)] ?? 0) === (reviewRank[text(existing.review_status)] ?? 0) &&
            ((evidenceRank[text(row.evidence_level)] ?? 0) > (evidenceRank[text(existing.evidence_level)] ?? 0) ||
              ((evidenceRank[text(row.evidence_level)] ?? 0) === (evidenceRank[text(existing.evidence_level)] ?? 0) &&
                number(row.confidence) > number(existing.confidence))))
        if (incomingWins) {
          this.db
            .prepare(
              `UPDATE case_matches SET score=?, confidence=?, tag_role=?, evidence_span=?,
                 evidence_start=?, evidence_end=?, rationale=?, method=?, review_status=?,
                 evidence_level=?, version=?, reviewer_id=?, reviewed_at=?
               WHERE id=?`,
            )
            .run(
              number(row.score),
              number(row.confidence),
              text(row.tag_role),
              text(row.evidence_span),
              nullableNumber(row.evidence_start) ?? null,
              nullableNumber(row.evidence_end) ?? null,
              text(row.rationale),
              text(row.method),
              text(row.review_status) || 'draft',
              text(row.evidence_level) || 'auto',
              text(row.version) || 'v0.1',
              text(row.reviewer_id),
              text(row.reviewed_at),
              text(existing.id),
            )
        }
        this.db.prepare('DELETE FROM case_matches WHERE id=?').run(text(row.id))
      }
    }
    this.transaction(() => {
      // Canonical is the highest-ranked row, or forcedCanonicalId when adjudicated.
      const mergeOneGroup = (points: KnowledgePoint[], forcedCanonicalId?: string): number => {
        if (points.length < 2) return 0
        const ranked = [...points].sort((left, right) => {
          const statusDiff = (statusRank[right.status] ?? 0) - (statusRank[left.status] ?? 0)
          if (statusDiff !== 0) return statusDiff
          const leftRefs = number(referenceCount.get(left.id, left.id, left.id, left.id, left.id)?.value)
          const rightRefs = number(referenceCount.get(right.id, right.id, right.id, right.id, right.id)?.value)
          if (rightRefs !== leftRefs) return rightRefs - leftRefs
          if (left.id.length !== right.id.length) return left.id.length - right.id.length
          return left.id.localeCompare(right.id)
        })
        const canonical = forcedCanonicalId
          ? (ranked.find((point) => point.id === forcedCanonicalId) ?? ranked[0]!)
          : ranked[0]!
        const duplicates = ranked.filter((point) => point.id !== canonical.id)
        const aliases = new Set(canonical.aliases)
        const examples = new Set(canonical.examples)
        const nonExamples = new Set(canonical.non_examples)
        const keywords = new Set(canonical.keywords)
        const competencies = new Set(canonical.competencies)
        const decisions = new Set(canonical.decisions)
        let definition = canonical.definition
        for (const duplicate of duplicates) {
          aliases.add(duplicate.id)
          if (duplicate.name !== canonical.name) aliases.add(duplicate.name)
          duplicate.aliases.forEach((alias) => aliases.add(alias))
          duplicate.examples.forEach((item) => examples.add(item))
          duplicate.non_examples.forEach((item) => nonExamples.add(item))
          duplicate.keywords.forEach((item) => keywords.add(item))
          duplicate.competencies.forEach((item) => competencies.add(item))
          duplicate.decisions.forEach((item) => decisions.add(item))
          if (!definition.trim() && duplicate.definition.trim()) definition = duplicate.definition

          this.db.prepare('UPDATE knowledge_points SET parent_id=? WHERE parent_id=?').run(canonical.id, duplicate.id)
          this.db
            .prepare('INSERT OR IGNORE INTO question_kps (question_id, kp_id) SELECT question_id, ? FROM question_kps WHERE kp_id=?')
            .run(canonical.id, duplicate.id)
          this.db.prepare('DELETE FROM question_kps WHERE kp_id=?').run(duplicate.id)
          this.db
            .prepare("UPDATE questions SET source_id=? WHERE source_type='kp' AND source_id=?")
            .run(canonical.id, duplicate.id)
          this.remapTagKey('content_tags', 'block_id', duplicate.id, canonical.id)
          this.remapTagKey('news_tags', 'article_id', duplicate.id, canonical.id)
          remapMatch(duplicate.id, canonical.id)
          remapJsonArray('ideology_points', 'related_kp_ids_json', duplicate.id, canonical.id)
          remapJsonArray('question_bank', 'kp_ids_json', duplicate.id, canonical.id)
          remapJsonArray('artifacts', 'source_refs_json', duplicate.id, canonical.id)
          replaceJsonText('artifacts', 'content_json', duplicate.id, canonical.id)
          replaceJsonText('research_artifacts', 'content_json', duplicate.id, canonical.id)
          replaceJsonText('bp_sections', 'evidence_json', duplicate.id, canonical.id)
          this.db
            .prepare(
              'INSERT OR REPLACE INTO kp_canonical_map (old_id, canonical_id, name, created_at) VALUES (?, ?, ?, ?)',
            )
            .run(duplicate.id, canonical.id, duplicate.name, now)
          this.db.prepare('DELETE FROM knowledge_points WHERE id=?').run(duplicate.id)
          merged += 1
        }
        this.db
          .prepare(
            `UPDATE knowledge_points SET aliases_json=?, examples_json=?, non_examples_json=?,
               keywords_json=?, competencies_json=?, decisions_json=?, definition=?
             WHERE id=?`,
          )
          .run(
            toJson([...aliases]),
            toJson([...examples]),
            toJson([...nonExamples]),
            toJson([...keywords]),
            toJson([...competencies]),
            toJson([...decisions]),
            definition,
            canonical.id,
          )
        return duplicates.length
      }

      // (1) Exact same-name groups; canonical is chosen by review/reference rank.
      for (const group of groups) {
        const ids = text(group.ids).split(',').filter(Boolean)
        const points = ids
          .map((id) => this.getKp(id))
          .filter((point): point is KnowledgePoint => point !== undefined)
        mergeOneGroup(points)
      }

      // (2) Manually adjudicated synonym merges (canonical id is forced).
      for (const manual of manualGroups) {
        const points = [manual.canonicalId, ...manual.oldIds]
          .map((id) => this.getKp(id))
          .filter((point): point is KnowledgePoint => point !== undefined)
        mergeOneGroup(points, manual.canonicalId)
      }

      // Duplicate tags can appear after key remapping. Dedupe by semantic key,
      // never by rowid: human review outranks drafts, verified/gold outranks
      // auto, and a rejected row is retained as an audit tombstone.
      this.dedupeTagTable('content_tags', 'block_id')
      this.dedupeTagTable('news_tags', 'article_id')
      this.db.exec("DELETE FROM plugin_state WHERE plugin_id='matcher'")
    })
    this.kpIndexCache = undefined
    return merged
  }

  private tagRowScore(row: Row): number {
    return (TAG_REVIEW_RANK[text(row.review_status)] ?? 0) * 1000
      + (TAG_EVIDENCE_RANK[text(row.evidence_level)] ?? 0) * 100
      + Math.round(number(row.confidence) * 100)
  }

  /** Move tag rows from one key to another; human review is never silently dropped. */
  private remapTagKey(
    table: 'content_tags' | 'news_tags',
    ownerColumn: 'block_id' | 'article_id',
    oldId: string,
    newId: string,
  ): void {
    if (oldId === newId) return
    const rows = this.db
      .prepare(`SELECT * FROM ${table} WHERE tag_type='knowledge_point' AND tag_key=?`)
      .all(oldId) as Row[]
    const findExisting = this.db.prepare(
      `SELECT * FROM ${table}
       WHERE ${ownerColumn}=? AND tag_type='knowledge_point' AND tag_key=? AND id<>?`,
    )
    const updateKey = this.db.prepare(`UPDATE ${table} SET tag_key=? WHERE id=?`)
    const remove = this.db.prepare(`DELETE FROM ${table} WHERE id=?`)
    for (const row of rows) {
      const existing = findExisting.all(text(row[ownerColumn]), newId, text(row.id)) as Row[]
      if (existing.length === 0) {
        updateKey.run(newId, text(row.id))
        continue
      }
      const best = existing.reduce((left, right) =>
        this.tagRowScore(right) > this.tagRowScore(left) ? right : left)
      const rowRejected = text(row.review_status) === 'rejected'
      const bestRejected = text(best.review_status) === 'rejected'
      if (rowRejected || bestRejected) {
        // Tombstones: two rejected rows collapse to the stronger; accepted coexists.
        if (rowRejected && bestRejected && this.tagRowScore(row) <= this.tagRowScore(best)) {
          remove.run(text(row.id))
        } else {
          updateKey.run(newId, text(row.id))
        }
        continue
      }
      if (this.tagRowScore(row) > this.tagRowScore(best)) {
        updateKey.run(newId, text(row.id))
      } else {
        remove.run(text(row.id))
      }
    }
  }

  private dedupeTagTable(
    table: 'content_tags' | 'news_tags',
    ownerColumn: 'block_id' | 'article_id',
  ): number {
    const rows = this.db
      .prepare(
        `SELECT rowid AS rid, ${ownerColumn} AS owner_id, tag_type, tag_key,
           review_status, evidence_level, confidence
         FROM ${table}`,
      )
      .all() as Row[]
    const groups = new Map<string, Row[]>()
    for (const row of rows) {
      const key = `${text(row.owner_id)}\u0000${text(row.tag_type)}\u0000${text(row.tag_key)}`
      const group = groups.get(key) ?? []
      group.push(row)
      groups.set(key, group)
    }
    const remove = this.db.prepare(`DELETE FROM ${table} WHERE rowid=?`)
    let deleted = 0
    for (const group of groups.values()) {
      if (group.length < 2) continue
      const active = group.filter((row) => text(row.review_status) !== 'rejected')
      const rejected = group.filter((row) => text(row.review_status) === 'rejected')
      const keep = new Set<number>()
      const bestActive = active.reduce<Row | undefined>(
        (best, row) => (!best || this.tagRowScore(row) > this.tagRowScore(best) ? row : best),
        undefined,
      )
      const bestRejected = rejected.reduce<Row | undefined>(
        (best, row) => (!best || this.tagRowScore(row) > this.tagRowScore(best) ? row : best),
        undefined,
      )
      if (bestRejected) {
        keep.add(number(bestRejected.rid))
        // A draft must not shadow a rejected tombstone; a reviewed row may coexist.
        if (bestActive && this.tagRowScore(bestActive) > this.tagRowScore(bestRejected)) {
          keep.add(number(bestActive.rid))
        }
      } else if (bestActive) {
        keep.add(number(bestActive.rid))
      }
      for (const row of group) {
        if (keep.has(number(row.rid))) continue
        remove.run(number(row.rid))
        deleted += 1
      }
    }
    return deleted
  }

  /** Remove duplicate tag rows, preferring reviewed/verified rows over drafts. */
  dedupeContentTags(): number {
    let deleted = 0
    this.transaction(() => {
      deleted = this.dedupeTagTable('content_tags', 'block_id')
    })
    return deleted
  }

  dedupeNewsTags(): number {
    let deleted = 0
    this.transaction(() => {
      deleted = this.dedupeTagTable('news_tags', 'article_id')
    })
    return deleted
  }

  upsertKps(kps: KnowledgePoint[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO knowledge_points (
        id, chapter_id, section_id, name, name_en, definition, keywords_json, examples_json,
        non_examples_json, aliases_json, difficulty, competencies_json, decisions_json, source,
        status, parent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        chapter_id=excluded.chapter_id, section_id=excluded.section_id, name=excluded.name,
        name_en=excluded.name_en, definition=excluded.definition, keywords_json=excluded.keywords_json,
        examples_json=excluded.examples_json, non_examples_json=excluded.non_examples_json,
        aliases_json=excluded.aliases_json, difficulty=excluded.difficulty,
        competencies_json=excluded.competencies_json, decisions_json=excluded.decisions_json,
        source=excluded.source, status=excluded.status, parent_id=excluded.parent_id`,
    )
    this.transaction(() => {
      for (const kp of kps) {
        stmt.run(
          kp.id,
          kp.chapter_id,
          kp.section_id,
          kp.name,
          kp.name_en,
          kp.definition,
          toJson(kp.keywords),
          toJson(kp.examples),
          toJson(kp.non_examples),
          toJson(kp.aliases),
          kp.difficulty,
          toJson(kp.competencies),
          toJson(kp.decisions),
          kp.source,
          kp.status,
          kp.parent_id ?? null,
        )
      }
    })
    this.kpIndexCache = undefined
  }

  listBlocks(chapterId: string): ContentBlock[] {
    return this.db
      .prepare('SELECT * FROM content_blocks WHERE chapter_id=? ORDER BY rowid')
      .all(chapterId)
      .map((row) => {
        const r = row as Row
        return {
          id: text(r.id),
          chapter_id: text(r.chapter_id),
          section_id: text(r.section_id),
          block_type: text(r.block_type) as ContentBlock['block_type'],
          text: text(r.text),
          page: nullableNumber(r.page),
          source: text(r.source),
          rights: text(r.rights),
        }
      })
  }

  listAllBlocks(): ContentBlock[] {
    return this.db
      .prepare('SELECT * FROM content_blocks ORDER BY chapter_id, section_id, rowid')
      .all()
      .map((row) => {
        const r = row as Row
        return {
          id: text(r.id),
          chapter_id: text(r.chapter_id),
          section_id: text(r.section_id),
          block_type: text(r.block_type) as ContentBlock['block_type'],
          text: text(r.text),
          page: nullableNumber(r.page),
          source: text(r.source),
          rights: text(r.rights),
        }
      })
  }

  upsertBlocks(blocks: ContentBlock[]): void {
    this.transaction(() => {
      this.upsertBlocksTx(blocks)
    })
  }

  private upsertBlocksTx(blocks: ContentBlock[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO content_blocks (id, chapter_id, section_id, block_type, text, page, source, rights)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET chapter_id=excluded.chapter_id, section_id=excluded.section_id,
         block_type=excluded.block_type, text=excluded.text, page=excluded.page,
         source=excluded.source, rights=excluded.rights`,
    )
    for (const block of blocks) {
      stmt.run(
        block.id,
        block.chapter_id,
        block.section_id,
        block.block_type,
        block.text,
        block.page ?? null,
        block.source,
        block.rights,
      )
    }
  }

  /**
   * Cut a chapter over to normalized blocks without losing human review: remap
   * reviewed tags whose quote still locates, keep the old block otherwise, and
   * record old -> canonical ids before deleting stale blocks so historical
   * citations stay resolvable. Only unmapped, review-free blocks are deleted.
   */
  syncBlocksForChapter(
    chapterId: string,
    blocks: ContentBlock[],
    mappings: BlockCanonicalMapping[] = [],
  ): BlockSyncReport {
    const targetIds = new Set(blocks.map((block) => block.id))
    const targetById = new Map<string, ContentBlock>(
      blocks.map((block): [string, ContentBlock] => [block.id, block]),
    )
    const targetBySection = new Map<string, ContentBlock[]>()
    for (const block of blocks) {
      const list = targetBySection.get(block.section_id) ?? []
      list.push(block)
      targetBySection.set(block.section_id, list)
    }
    const oldBlocks = this.listBlocks(chapterId)
    const mappingByOld = new Map<string, string>()
    for (const entry of mappings) {
      if (entry.oldId && entry.canonicalId && targetIds.has(entry.canonicalId)) {
        mappingByOld.set(entry.oldId, entry.canonicalId)
      }
    }
    for (const row of this.db.prepare('SELECT old_id, canonical_id FROM block_canonical_map').all() as Row[]) {
      const canonical = text(row.canonical_id)
      if (targetIds.has(canonical)) mappingByOld.set(text(row.old_id), canonical)
    }
    const resolveTarget = (old: ContentBlock): ContentBlock | undefined => {
      if (targetById.has(old.id)) return targetById.get(old.id)
      const mapped = mappingByOld.get(old.id)
      if (mapped) return targetById.get(mapped)
      const oldText = old.text.trim()
      if (oldText.length < 6) return undefined
      const containing = (targetBySection.get(old.section_id) ?? [])
        .filter((candidate) => candidate.text.includes(oldText))
        .sort((left, right) => left.text.length - right.text.length || left.id.localeCompare(right.id))
      return containing[0]
    }
    const isHumanTag = (row: Row): boolean =>
      HUMAN_REVIEW_STATUS[text(row.review_status)] === true || text(row.method) === 'human'
    let remapped = 0
    const retained = new Set<string>()
    const mappingsToRecord: BlockCanonicalMapping[] = []
    this.transaction(() => {
      this.upsertBlocksTx(blocks)
      for (const old of oldBlocks) {
        if (targetIds.has(old.id)) continue
        const tags = this.db.prepare('SELECT * FROM content_tags WHERE block_id=?').all(old.id) as Row[]
        const humanTags = tags.filter(isHumanTag)
        if (humanTags.length === 0) continue
        const target = resolveTarget(old)
        if (!target) {
          retained.add(old.id)
          continue
        }
        let complete = true
        for (const tag of humanTags) {
          const located = locateSpan(target.text, text(tag.evidence_span))
          if (!located) {
            complete = false
            continue
          }
          this.db
            .prepare(
              'UPDATE content_tags SET block_id=?, evidence_span=?, evidence_start=?, evidence_end=? WHERE id=?',
            )
            .run(target.id, located.span, located.start, located.end, text(tag.id))
          remapped += 1
        }
        if (!complete) retained.add(old.id)
        else mappingsToRecord.push({ oldId: old.id, canonicalId: target.id, reason: 'reseed-remap' })
      }
      for (const entry of mappings) {
        if (!entry.oldId || !entry.canonicalId || entry.oldId === entry.canonicalId) continue
        if (!targetIds.has(entry.canonicalId) || retained.has(entry.oldId)) continue
        mappingsToRecord.push(entry)
      }
      // Resolve remap collisions before stale rows disappear.
      this.dedupeTagTable('content_tags', 'block_id')
      for (const old of oldBlocks) {
        if (targetIds.has(old.id) || retained.has(old.id)) continue
        const human = this.db
          .prepare(
            `SELECT COUNT(*) AS value FROM content_tags
             WHERE block_id=? AND (review_status IN ('reviewed','adjudicated','published','rejected') OR method='human')`,
          )
          .get(old.id) as Row | undefined
        if (number(human?.value) > 0) {
          retained.add(old.id)
          continue
        }
        const target = resolveTarget(old)
        if (!target) {
          retained.add(old.id)
          continue
        }
        mappingsToRecord.push({ oldId: old.id, canonicalId: target.id, reason: 'reseed' })
        this.db.prepare('DELETE FROM content_blocks WHERE id=?').run(old.id)
      }
      this.recordBlockCanonicalMapTx(mappingsToRecord)
    })
    return {
      upserted: blocks.length,
      remapped_tags: remapped,
      retained_blocks: retained.size,
      deleted_blocks: oldBlocks.filter((old) => !targetIds.has(old.id) && !retained.has(old.id)).length,
      recorded_mappings: mappingsToRecord.length,
    }
  }

  getTagsForBlock(blockId: string): ContentTag[] {
    return this.db
      .prepare('SELECT * FROM content_tags WHERE block_id=? ORDER BY confidence DESC')
      .all(blockId)
      .map((row) => contentTagFromRow(row as Row))
  }

  listContentTags(opts: {
    chapterId?: string
    blockId?: string
    reviewStatus?: ReviewStatus
    evidenceLevel?: EvidenceLevel
    limit?: number
  } = {}): ContentTag[] {
    const clauses: string[] = []
    const args: Array<string | number> = []
    if (opts.blockId) {
      clauses.push('tags.block_id=?')
      args.push(opts.blockId)
    }
    if (opts.chapterId) {
      clauses.push('blocks.chapter_id=?')
      args.push(opts.chapterId)
    }
    if (opts.reviewStatus) {
      clauses.push('tags.review_status=?')
      args.push(opts.reviewStatus)
    }
    if (opts.evidenceLevel) {
      clauses.push('tags.evidence_level=?')
      args.push(opts.evidenceLevel)
    }
    const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 100000)
    args.push(limit)
    return this.db
      .prepare(
        `SELECT tags.* FROM content_tags AS tags
         JOIN content_blocks AS blocks ON blocks.id=tags.block_id
         ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY tags.block_id, tags.confidence DESC LIMIT ?`,
      )
      .all(...args)
      .map((row) => contentTagFromRow(row as Row))
  }

  findContentBlocksByTags(
    tagKeys: string[],
    opts: { chapterId?: string; limit?: number; minRole?: ContentTag['tag_role'] } = {},
  ): Array<{ block: ContentBlock; tags: ContentTag[] }> {
    const resolved = tagKeys
      .map((key) => this.resolveCanonicalKpId(key) ?? key)
      .filter((key, index, all) => all.indexOf(key) === index)
    if (resolved.length === 0) return []
    const rank: Record<ContentTag['tag_role'], number> = { core: 3, example: 2, mention: 1 }
    const minRank = rank[opts.minRole ?? 'mention']
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200)
    const placeholders = resolved.map(() => '?').join(',')
    const clauses = [
      `tags.tag_type='knowledge_point'`,
      `tags.tag_key IN (${placeholders})`,
      `CASE tags.tag_role WHEN 'core' THEN 3 WHEN 'example' THEN 2 ELSE 1 END >= ?`,
    ]
    const args: Array<string | number> = [...resolved, minRank]
    if (opts.chapterId) {
      clauses.push('blocks.chapter_id=?')
      args.push(opts.chapterId)
    }
    const rows = this.db
      .prepare(
        `SELECT tags.*, blocks.id AS block_id_join
         FROM content_tags AS tags
         JOIN content_blocks AS blocks ON blocks.id=tags.block_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY tags.confidence DESC LIMIT ?`,
      )
      .all(...args, limit * 8) as Row[]
    const grouped = new Map<string, { block: ContentBlock; tags: ContentTag[] }>()
    for (const row of rows) {
      const tag = contentTagFromRow(row)
      if (rank[tag.tag_role] < minRank) continue
      const blockId = text(row.block_id_join)
      let entry = grouped.get(blockId)
      if (!entry) {
        const block = this.getBlock(blockId)
        if (!block) continue
        entry = { block, tags: [] }
        grouped.set(blockId, entry)
      }
      entry.tags.push(tag)
      if (grouped.size >= limit) break
    }
    return [...grouped.values()].slice(0, limit)
  }

  getBlock(id: string): ContentBlock | undefined {
    const row = this.db.prepare('SELECT * FROM content_blocks WHERE id=?').get(id) as Row | undefined
    if (row) {
      return {
        id: text(row.id),
        chapter_id: text(row.chapter_id),
        section_id: text(row.section_id),
        block_type: text(row.block_type) as ContentBlock['block_type'],
        text: text(row.text),
        page: nullableNumber(row.page),
        source: text(row.source),
        rights: text(row.rights),
      }
    }
    const canonical = this.resolveCanonicalBlockId(id)
    if (canonical && canonical !== id) {
      const mapped = this.db.prepare('SELECT * FROM content_blocks WHERE id=?').get(canonical) as Row | undefined
      if (!mapped) return undefined
      return {
        id: text(mapped.id),
        chapter_id: text(mapped.chapter_id),
        section_id: text(mapped.section_id),
        block_type: text(mapped.block_type) as ContentBlock['block_type'],
        text: text(mapped.text),
        page: nullableNumber(mapped.page),
        source: text(mapped.source),
        rights: text(mapped.rights),
      }
    }
    return undefined
  }

  resolveCanonicalBlockId(value: string): string | undefined {
    if (!value) return undefined
    const direct = this.db.prepare('SELECT id FROM content_blocks WHERE id=?').get(value) as Row | undefined
    if (direct) return text(direct.id)
    const mapped = this.db
      .prepare('SELECT canonical_id FROM block_canonical_map WHERE old_id=?')
      .get(value) as Row | undefined
    return mapped ? text(mapped.canonical_id) : undefined
  }

  getBlockCanonicalMap(): Array<{ old_id: string; canonical_id: string; reason: string }> {
    return this.db
      .prepare('SELECT old_id, canonical_id, reason FROM block_canonical_map ORDER BY old_id')
      .all()
      .map((row) => {
        const r = row as Row
        return {
          old_id: text(r.old_id),
          canonical_id: text(r.canonical_id),
          reason: text(r.reason),
        }
      })
  }

  /**
   * Record block ids merged/dropped by normalization and remap the references we
   * can update; old ids stay resolvable via block_canonical_map.
   */
  recordBlockCanonicalMap(entries: BlockCanonicalMapping[]): number {
    if (entries.length === 0) return 0
    let recorded = 0
    this.transaction(() => {
      recorded = this.recordBlockCanonicalMapTx(entries)
    })
    return recorded
  }

  private recordBlockCanonicalMapTx(entries: BlockCanonicalMapping[]): number {
    if (entries.length === 0) return 0
    const now = new Date().toISOString()
    let recorded = 0
    const remapArray = this.db.prepare('SELECT rowid AS rid, source_refs_json AS value FROM artifacts')
    const updateArray = this.db.prepare('UPDATE artifacts SET source_refs_json=? WHERE rowid=?')
    for (const entry of entries) {
      if (!entry.oldId || !entry.canonicalId || entry.oldId === entry.canonicalId) continue
      this.db
        .prepare(
          'INSERT OR REPLACE INTO block_canonical_map (old_id, canonical_id, reason, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(entry.oldId, entry.canonicalId, entry.reason ?? '', now)
      for (const row of remapArray.all() as Row[]) {
        const values = parseJson<unknown>(row.value, [])
        if (!Array.isArray(values) || !values.includes(entry.oldId)) continue
        updateArray.run(
          toJson(values.map((value) => (value === entry.oldId ? entry.canonicalId : value))),
          number(row.rid),
        )
      }
      for (const [table, column] of [
        ['artifacts', 'content_json'],
        ['research_artifacts', 'content_json'],
        ['bp_sections', 'evidence_json'],
        ['chat_messages', 'payload_json'],
        ['turns', 'plan_json'],
        ['turns', 'record_json'],
        ['learning_states', 'state_json'],
        ['memory_facts', 'value_json'],
      ]) {
        this.db
          .prepare(`UPDATE ${table} SET ${column}=replace(${column}, ?, ?) WHERE ${column} LIKE ?`)
          .run(JSON.stringify(entry.oldId), JSON.stringify(entry.canonicalId), `%${entry.oldId}%`)
      }
      recorded += 1
    }
    return recorded
  }

  upsertContentTags(tags: ContentTag[], opts: { preserveReviewed?: boolean } = {}): void {
    const stmt = this.db.prepare(
      `INSERT INTO content_tags (
        id, block_id, tag_type, tag_key, tag_role, confidence, method, evidence_span,
        evidence_start, evidence_end, review_status, evidence_level, version, reviewer_id, reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET tag_role=excluded.tag_role, confidence=excluded.confidence,
        method=excluded.method, evidence_span=excluded.evidence_span,
        evidence_start=excluded.evidence_start, evidence_end=excluded.evidence_end,
        review_status=excluded.review_status, evidence_level=excluded.evidence_level,
        version=excluded.version, reviewer_id=excluded.reviewer_id, reviewed_at=excluded.reviewed_at`,
    )
    const existingById = this.db.prepare('SELECT review_status, method FROM content_tags WHERE id=?')
    const existingHuman = this.db.prepare(
      `SELECT id FROM content_tags
       WHERE block_id=? AND tag_type=? AND tag_key=?
         AND (review_status IN ('reviewed','adjudicated','published','rejected') OR method='human')
       LIMIT 1`,
    )
    this.transaction(() => {
      for (const tag of tags) {
        const incomingHuman = HUMAN_REVIEW_STATUS[tag.review_status] === true || tag.method === 'human'
        if (opts.preserveReviewed && !incomingHuman) {
          const row = existingById.get(tag.id) as Row | undefined
          if (row && (HUMAN_REVIEW_STATUS[text(row.review_status)] === true || text(row.method) === 'human')) {
            continue
          }
          // A human rejection blocks regenerated drafts even under a new role/version/id.
          const human = existingHuman.get(tag.block_id, tag.tag_type, tag.tag_key)
          if (human) continue
        }
        stmt.run(
          tag.id,
          tag.block_id,
          tag.tag_type,
          tag.tag_key,
          tag.tag_role,
          tag.confidence,
          tag.method,
          tag.evidence_span,
          tag.evidence_start ?? null,
          tag.evidence_end ?? null,
          tag.review_status,
          tag.evidence_level,
          tag.version,
          tag.reviewer_id,
          tag.reviewed_at,
        )
      }
    })
  }

  /** Delete auto tags only; reviewed/rejected rows must survive `tag-content --force`. */
  deleteAutoContentTags(chapterId?: string): number {
    const result = chapterId
      ? this.db
          .prepare(
            `DELETE FROM content_tags WHERE review_status='draft' AND method<>'human' AND block_id IN (
               SELECT id FROM content_blocks WHERE chapter_id=?
             )`,
          )
          .run(chapterId)
      : this.db
          .prepare("DELETE FROM content_tags WHERE review_status='draft' AND method<>'human'")
          .run()
    return Number(result.changes)
  }

  reviewContentTag(
    id: string,
    input: { status: ReviewStatus; evidenceLevel: EvidenceLevel; reviewerId: string; version?: string },
  ): boolean {
    if (!input.reviewerId.trim()) throw new Error('reviewerId is required for tag review')
    const result = this.db
      .prepare(
        `UPDATE content_tags
         SET review_status=?, evidence_level=?, version=?, reviewer_id=?, reviewed_at=?,
             method=CASE WHEN method='human' THEN 'human' ELSE 'hybrid' END
         WHERE id=?`,
      )
      .run(
        input.status,
        input.evidenceLevel,
        input.version ?? 'v0.1',
        input.reviewerId,
        new Date().toISOString(),
        id,
      )
    return Number(result.changes) > 0
  }

  listIdeology(): IdeologyPoint[] {
    return this.db.prepare('SELECT * FROM ideology_points ORDER BY name').all().map((row) => {
      const r = row as Row
      return {
        id: text(r.id),
        name: text(r.name),
        definition: text(r.definition),
        examples: parseJson(r.examples_json, []),
        non_examples: parseJson(r.non_examples_json, []),
        related_kp_ids: parseJson(r.related_kp_ids_json, []),
        source: text(r.source),
      }
    })
  }

  upsertIdeology(points: IdeologyPoint[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO ideology_points (id, name, definition, examples_json, non_examples_json, related_kp_ids_json, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, definition=excluded.definition,
         examples_json=excluded.examples_json, non_examples_json=excluded.non_examples_json,
         related_kp_ids_json=excluded.related_kp_ids_json, source=excluded.source`,
    )
    this.transaction(() => {
      for (const point of points) {
        stmt.run(
          point.id,
          point.name,
          point.definition,
          toJson(point.examples),
          toJson(point.non_examples),
          toJson(point.related_kp_ids),
          point.source,
        )
      }
    })
  }

  upsertIdeologyTags(tags: IdeologyTag[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO ideology_tags (id, target_type, target_id, ideology_id, confidence, evidence_span, rationale, review_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET confidence=excluded.confidence, evidence_span=excluded.evidence_span,
         rationale=excluded.rationale, review_status=excluded.review_status`,
    )
    this.transaction(() => {
      for (const tag of tags) {
        stmt.run(
          tag.id,
          tag.target_type,
          tag.target_id,
          tag.ideology_id,
          tag.confidence,
          tag.evidence_span,
          tag.rationale,
          tag.review_status,
        )
      }
    })
  }

  insertNews(articles: NewsArticle[]): number {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO news_articles (
        id, source, source_id, title, url, author, published_at, summary, content,
        content_status, rights, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    let inserted = 0
    this.transaction(() => {
      for (const article of articles) {
        const result = stmt.run(
          article.id,
          article.source,
          article.source_id,
          article.title,
          article.url,
          article.author,
          article.published_at,
          article.summary,
          article.content,
          article.content_status,
          article.rights,
          article.fetched_at,
        )
        inserted += Number(result.changes)
      }
    })
    return inserted
  }

  upsertNews(articles: NewsArticle[]): number {
    const stmt = this.db.prepare(
      `INSERT INTO news_articles (
        id, source, source_id, title, url, author, published_at, summary, content,
        content_status, rights, fetched_at, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET title=excluded.title, author=excluded.author,
        published_at=excluded.published_at, summary=excluded.summary, content=excluded.content,
        content_status=excluded.content_status, rights=excluded.rights, fetched_at=excluded.fetched_at,
        content_hash=excluded.content_hash`,
    )
    const findExisting = this.db.prepare('SELECT id, content_hash FROM news_articles WHERE url=?')
    const dropMatches = this.db.prepare(
      "DELETE FROM case_matches WHERE article_id=? AND review_status='draft'",
    )
    const dropTags = this.db.prepare(
      "DELETE FROM news_tags WHERE article_id=? AND review_status='draft'",
    )
    const dropIdeology = this.db.prepare(
      "DELETE FROM ideology_tags WHERE target_type='news_article' AND target_id=? AND review_status='draft'",
    )
    let changed = 0
    this.transaction(() => {
      for (const article of articles) {
        const contentHash = createHash('sha256').update(article.content).digest('hex')
        const existing = findExisting.get(article.url) as Row | undefined
        if (existing && text(existing.content_hash) !== contentHash) {
          // Body changed under the same URL: drop stale auto drafts so re-tagging runs.
          const articleId = text(existing.id)
          dropMatches.run(articleId)
          dropTags.run(articleId)
          dropIdeology.run(articleId)
        }
        const result = stmt.run(
          article.id,
          article.source,
          article.source_id,
          article.title,
          article.url,
          article.author,
          article.published_at,
          article.summary,
          article.content,
          article.content_status,
          article.rights,
          article.fetched_at,
          contentHash,
        )
        changed += Number(result.changes)
      }
    })
    return changed
  }

  /** Record that the article's whole-library auto tagging ran against its current text. */
  markNewsTagged(articleId: string): void {
    const row = this.db.prepare('SELECT content FROM news_articles WHERE id=?').get(articleId) as Row | undefined
    if (!row) return
    const contentHash = createHash('sha256').update(text(row.content)).digest('hex')
    this.db
      .prepare('UPDATE news_articles SET content_hash=?, tag_content_hash=? WHERE id=?')
      .run(contentHash, contentHash, articleId)
  }

  /** Articles whose current text has never been auto-tagged (or changed since). */
  listNewsNeedingTags(limit = 20): NewsArticle[] {
    const bounded = Math.min(Math.max(limit, 1), 500)
    return this.db
      .prepare(
        `SELECT * FROM news_articles
         WHERE (tag_content_hash = '' OR content_hash <> tag_content_hash) AND length(content) >= 300
         ORDER BY published_at DESC LIMIT ?`,
      )
      .all(bounded)
      .map((row) => newsFromRow(row as Row))
  }

  listNews(opts: { source?: string; since?: string; limit?: number } = {}): NewsArticle[] {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 500)
    const clauses: string[] = []
    const args: (string | number)[] = []
    if (opts.source) {
      clauses.push('source=?')
      args.push(opts.source)
    }
    if (opts.since) {
      clauses.push('published_at>=?')
      args.push(opts.since)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    args.push(limit)
    return this.db
      .prepare(`SELECT * FROM news_articles ${where} ORDER BY published_at DESC LIMIT ?`)
      .all(...args)
      .map((row) => newsFromRow(row as Row))
  }

  getNews(id: string): NewsArticle | undefined {
    const row = this.db.prepare('SELECT * FROM news_articles WHERE id=?').get(id) as Row | undefined
    return row ? newsFromRow(row) : undefined
  }

  newestNewsFetchedAt(): string | undefined {
    const row = this.db.prepare('SELECT MAX(fetched_at) AS value FROM news_articles').get() as Row | undefined
    return row?.value === null || row?.value === undefined ? undefined : text(row.value)
  }

  countNews(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS value FROM news_articles').get() as Row | undefined
    return number(row?.value)
  }

  newsAudit(): Array<{ source: string; content_status: string; count: number }> {
    return this.db
      .prepare(
        `SELECT source, content_status, COUNT(*) AS count
         FROM news_articles GROUP BY source, content_status ORDER BY source, content_status`,
      )
      .all()
      .map((row) => {
        const r = row as Row
        return {
          source: text(r.source),
          content_status: text(r.content_status),
          count: number(r.count),
        }
      })
  }

  upsertMatches(
    articleId: string,
    matches: CaseMatch[],
    ideology: IdeologyMatch[],
    opts: { chapterId?: string } = {},
  ): void {
    // Refreshes replace drafts only; human rows (incl. rejected tombstones) survive.
    // A chapter-scoped refresh clears just that chapter's drafts, so matching one
    // chapter cannot wipe another chapter's candidates for the same article.
    const chapterId = opts.chapterId
    const delMatches = this.db.prepare(
      chapterId
        ? `DELETE FROM case_matches WHERE article_id=? AND review_status='draft'
           AND kp_id IN (SELECT id FROM knowledge_points WHERE chapter_id=?)`
        : "DELETE FROM case_matches WHERE article_id=? AND review_status='draft'",
    )
    const delTags = this.db.prepare(
      chapterId
        ? `DELETE FROM news_tags WHERE article_id=? AND review_status='draft' AND tag_type='knowledge_point'
           AND tag_key IN (SELECT id FROM knowledge_points WHERE chapter_id=?)`
        : "DELETE FROM news_tags WHERE article_id=? AND review_status='draft'",
    )
    const delIdeology = this.db.prepare(
      "DELETE FROM ideology_tags WHERE target_type='news_article' AND target_id=? AND review_status='draft'",
    )
    const humanMatch = this.db.prepare(
      `SELECT 1 AS hit FROM case_matches
       WHERE article_id=? AND kp_id=?
         AND review_status IN ('reviewed','adjudicated','published','rejected') LIMIT 1`,
    )
    const humanTag = this.db.prepare(
      `SELECT 1 AS hit FROM news_tags
       WHERE article_id=? AND tag_type='knowledge_point' AND tag_key=?
         AND review_status IN ('reviewed','adjudicated','published','rejected') LIMIT 1`,
    )
    const humanIdeology = this.db.prepare(
      `SELECT 1 AS hit FROM ideology_tags
       WHERE target_type='news_article' AND target_id=? AND ideology_id=?
         AND review_status IN ('reviewed','adjudicated','published','rejected') LIMIT 1`,
    )
    const insertMatch = this.db.prepare(
      `INSERT OR IGNORE INTO case_matches (
        id, article_id, kp_id, score, confidence, tag_role, evidence_span,
        evidence_start, evidence_end, rationale, method, created_at,
        review_status, evidence_level, version, reviewer_id, reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertTag = this.db.prepare(
      `INSERT OR IGNORE INTO news_tags (
        id, article_id, tag_type, tag_key, tag_role, confidence, method,
        evidence_span, evidence_start, evidence_end,
        review_status, evidence_level, version, reviewer_id, reviewed_at
      ) VALUES (?, ?, 'knowledge_point', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertIdeology = this.db.prepare(
      `INSERT OR IGNORE INTO ideology_tags (
        id, target_type, target_id, ideology_id, confidence, evidence_span, rationale,
        review_status, evidence_level, version, reviewer_id, reviewed_at
      ) VALUES (?, 'news_article', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const createdAt = new Date().toISOString()
    this.transaction(() => {
      if (chapterId) {
        delMatches.run(articleId, chapterId)
        delTags.run(articleId, chapterId)
      } else {
        delMatches.run(articleId)
        delTags.run(articleId)
        delIdeology.run(articleId)
      }
      for (const match of matches) {
        const incomingHuman = HUMAN_REVIEW_STATUS[match.review_status] === true
        if (!incomingHuman
          && (humanMatch.get(articleId, match.kp_id) || humanTag.get(articleId, match.kp_id))) {
          continue
        }
        insertMatch.run(
          `${articleId}:${match.kp_id}`,
          articleId,
          match.kp_id,
          match.score,
          match.confidence,
          match.tag_role,
          match.evidence_span,
          match.evidence_start ?? null,
          match.evidence_end ?? null,
          match.rationale,
          match.method,
          createdAt,
          match.review_status,
          match.evidence_level,
          match.version,
          match.reviewer_id,
          match.reviewed_at,
        )
        insertTag.run(
          `${articleId}:${match.kp_id}`,
          articleId,
          match.kp_id,
          match.tag_role,
          match.confidence,
          match.method,
          match.evidence_span,
          match.evidence_start ?? null,
          match.evidence_end ?? null,
          match.review_status,
          match.evidence_level,
          match.version,
          match.reviewer_id,
          match.reviewed_at,
        )
      }
      for (const item of ideology) {
        const incomingHuman = HUMAN_REVIEW_STATUS[item.review_status] === true
        if (!incomingHuman && humanIdeology.get(articleId, item.ideology_id)) continue
        insertIdeology.run(
          `${articleId}:${item.ideology_id}`,
          articleId,
          item.ideology_id,
          item.confidence,
          item.evidence_span,
          item.rationale,
          item.review_status,
          item.evidence_level,
          item.version,
          item.reviewer_id,
          item.reviewed_at,
        )
      }
    })
    // Only a whole-library pass marks the article tagged, so a chapter-scoped pass
    // leaves other chapters to the backfill; an empty result also counts as attempted.
    if (!chapterId) this.markNewsTagged(articleId)
  }

  getMatches(articleId: string): CaseMatch[] {
    return this.db
      .prepare("SELECT * FROM case_matches WHERE article_id=? AND rationale NOT LIKE '%mock evidence%' ORDER BY confidence DESC")
      .all(articleId)
      .map((row) => caseMatchFromRow(row as Row))
  }

  listCaseMatches(opts: {
    chapterId?: string
    reviewStatus?: ReviewStatus
    evidenceLevel?: EvidenceLevel
    limit?: number
  } = {}): CaseMatch[] {
    const clauses: string[] = ["matches.rationale NOT LIKE '%mock evidence%'"]
    const args: Array<string | number> = []
    if (opts.chapterId) {
      clauses.push('kps.chapter_id=?')
      args.push(opts.chapterId)
    }
    if (opts.reviewStatus) {
      clauses.push('matches.review_status=?')
      args.push(opts.reviewStatus)
    }
    if (opts.evidenceLevel) {
      clauses.push('matches.evidence_level=?')
      args.push(opts.evidenceLevel)
    }
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 100000)
    args.push(limit)
    return this.db
      .prepare(
        `SELECT matches.* FROM case_matches AS matches
         JOIN knowledge_points AS kps ON kps.id=matches.kp_id
         ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY matches.confidence DESC LIMIT ?`,
      )
      .all(...args)
      .map((row) => caseMatchFromRow(row as Row))
  }

  getMatchCandidates(
    articleId: string,
    opts: { topK?: number; reviewStatus?: ReviewStatus[]; chapterId?: string } = {},
  ): MatchCandidate[] {
    const limit = Math.min(Math.max(opts.topK ?? 5, 1), 50)
    const scoped = opts.chapterId ? ' AND kps.chapter_id=?' : ''
    const rows = this.db
      .prepare(
        `SELECT matches.*, kps.name AS kp_name
         FROM case_matches AS matches
         JOIN knowledge_points AS kps ON kps.id=matches.kp_id
         WHERE matches.article_id=? AND matches.rationale NOT LIKE '%mock evidence%'${scoped}
         ORDER BY matches.confidence DESC LIMIT ?`,
      )
      .all(...(opts.chapterId ? [articleId, opts.chapterId, limit * 3] : [articleId, limit * 3])) as Row[]
    const allowed = opts.reviewStatus ? new Set(opts.reviewStatus) : undefined
    const roleLabel: Record<CaseMatch['tag_role'], string> = { core: '核心', example: '例证', mention: '提及' }
    return rows
      .map((row) => {
        const match = caseMatchFromRow(row)
        return {
          articleId: match.article_id,
          kpId: match.kp_id,
          kpName: text(row.kp_name),
          tagRole: match.tag_role,
          roleLabel: roleLabel[match.tag_role],
          confidence: match.confidence,
          evidenceSpan: match.evidence_span,
          evidenceStart: match.evidence_start,
          evidenceEnd: match.evidence_end,
          rationale: match.rationale,
          method: match.method,
          reviewStatus: match.review_status,
          evidenceLevel: match.evidence_level,
          version: match.version,
        }
      })
      .filter((candidate) => !allowed || allowed.has(candidate.reviewStatus))
      .slice(0, limit)
  }

  reviewCaseMatch(
    articleId: string,
    kpId: string,
    input: { status: ReviewStatus; evidenceLevel: EvidenceLevel; reviewerId: string; version?: string },
  ): boolean {
    if (!input.reviewerId.trim()) throw new Error('reviewerId is required for match review')
    const timestamp = new Date().toISOString()
    const result = this.db
      .prepare(
        `UPDATE case_matches SET review_status=?, evidence_level=?, version=?, reviewer_id=?, reviewed_at=?,
           method=CASE WHEN method='human' THEN 'human' ELSE 'hybrid' END
         WHERE article_id=? AND kp_id=?`,
      )
      .run(input.status, input.evidenceLevel, input.version ?? 'v0.1', input.reviewerId, timestamp, articleId, kpId)
    this.db
      .prepare(
        `UPDATE news_tags SET review_status=?, evidence_level=?, version=?, reviewer_id=?, reviewed_at=?
         WHERE article_id=? AND tag_type='knowledge_point' AND tag_key=?`,
      )
      .run(input.status, input.evidenceLevel, input.version ?? 'v0.1', input.reviewerId, timestamp, articleId, kpId)
    return Number(result.changes) > 0
  }

  getIdeologyMatches(articleId: string): IdeologyMatch[] {
    return this.db
      .prepare("SELECT * FROM ideology_tags WHERE target_type='news_article' AND target_id=? ORDER BY confidence DESC")
      .all(articleId)
      .map((row) => ideologyMatchFromRow(row as Row))
  }

  insertQuestions(questions: Question[]): number {
    const insert = this.db.prepare(
      `INSERT INTO questions (
        id, source_type, source_id, type, stem, options_json, answer, explanation,
        difficulty, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_type=excluded.source_type, source_id=excluded.source_id, type=excluded.type,
        stem=excluded.stem, options_json=excluded.options_json, answer=excluded.answer,
        explanation=excluded.explanation, difficulty=excluded.difficulty, status=excluded.status`,
    )
    const clearKps = this.db.prepare('DELETE FROM question_kps WHERE question_id=?')
    const clearIdeology = this.db.prepare('DELETE FROM question_ideology WHERE question_id=?')
    const insertKp = this.db.prepare('INSERT OR IGNORE INTO question_kps (question_id, kp_id) VALUES (?, ?)')
    const insertIdeology = this.db.prepare(
      'INSERT OR IGNORE INTO question_ideology (question_id, ideology_id) VALUES (?, ?)',
    )
    const createdAt = new Date().toISOString()
    let inserted = 0
    this.transaction(() => {
      for (const question of questions) {
        const result = insert.run(
          question.id,
          question.source_type,
          question.source_id,
          question.type,
          question.stem,
          toJson(question.options),
          question.answer,
          question.explanation,
          question.difficulty,
          question.status,
          createdAt,
        )
        if (Number(result.changes) === 0) continue
        inserted += 1
        clearKps.run(question.id)
        clearIdeology.run(question.id)
        for (const kpId of question.kp_ids) insertKp.run(question.id, kpId)
        for (const ideologyId of question.ideology_ids) insertIdeology.run(question.id, ideologyId)
      }
    })
    return inserted
  }

  private kpIdsForQuestion(questionId: string): string[] {
    return this.db
      .prepare('SELECT kp_id FROM question_kps WHERE question_id=? ORDER BY kp_id')
      .all(questionId)
      .map((row) => text((row as Row).kp_id))
  }

  private ideologyIdsForQuestion(questionId: string): string[] {
    return this.db
      .prepare('SELECT ideology_id FROM question_ideology WHERE question_id=? ORDER BY ideology_id')
      .all(questionId)
      .map((row) => text((row as Row).ideology_id))
  }

  listQuestions(opts: { kpId?: string; type?: string; limit?: number } = {}): Question[] {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200)
    const rows = opts.kpId
      ? this.db
          .prepare(
            `SELECT q.* FROM questions q
             JOIN question_kps qk ON qk.question_id=q.id
             WHERE qk.kp_id=? ${opts.type ? 'AND q.type=?' : ''}
             ORDER BY q.created_at DESC LIMIT ?`,
          )
          .all(...(opts.type ? [opts.kpId, opts.type, limit] : [opts.kpId, limit]))
      : this.db
          .prepare(
            `SELECT * FROM questions ${opts.type ? 'WHERE type=?' : ''}
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(...(opts.type ? [opts.type, limit] : [limit]))
    return rows.map((row) => {
      const r = row as Row
      const id = text(r.id)
      return questionFromRow(r, this.kpIdsForQuestion(id), this.ideologyIdsForQuestion(id))
    })
  }

  getQuestion(id: string): Question | undefined {
    const row = this.db.prepare('SELECT * FROM questions WHERE id=?').get(id) as Row | undefined
    if (!row) return undefined
    return questionFromRow(row, this.kpIdsForQuestion(id), this.ideologyIdsForQuestion(id))
  }

  createResearchProject(input: { studentId: string; brief: string }): string {
    const id = `research_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const timestamp = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO research_projects (id, student_id, brief, status, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', ?, ?)`,
      )
      .run(id, input.studentId, input.brief, timestamp, timestamp)
    return id
  }

  getResearchProject(id: string): ResearchProject | undefined {
    const row = this.db.prepare('SELECT * FROM research_projects WHERE id=?').get(id) as Row | undefined
    if (!row) return undefined
    return {
      id: text(row.id),
      student_id: text(row.student_id),
      brief: text(row.brief),
      status: text(row.status),
      created_at: text(row.created_at),
      updated_at: text(row.updated_at),
    }
  }

  listResearchProjects(studentId?: string): ResearchProject[] {
    const rows = studentId
      ? this.db.prepare('SELECT * FROM research_projects WHERE student_id=? ORDER BY updated_at DESC').all(studentId)
      : this.db.prepare('SELECT * FROM research_projects ORDER BY updated_at DESC').all()
    return rows.map((row) => {
      const r = row as Row
      return {
        id: text(r.id),
        student_id: text(r.student_id),
        brief: text(r.brief),
        status: text(r.status),
        created_at: text(r.created_at),
        updated_at: text(r.updated_at),
      }
    })
  }

  upsertResearchArtifact(projectId: string, step: string, content: unknown): void {
    const id = `${projectId}:${step}`
    this.db
      .prepare(
        `INSERT INTO research_artifacts (id, project_id, step, content_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content_json=excluded.content_json, created_at=excluded.created_at`,
      )
      .run(id, projectId, step, toJson(content), new Date().toISOString())
    this.db.prepare('UPDATE research_projects SET updated_at=? WHERE id=?').run(new Date().toISOString(), projectId)
  }

  getResearchArtifacts(projectId: string): ResearchArtifact[] {
    return this.db
      .prepare('SELECT * FROM research_artifacts WHERE project_id=? ORDER BY created_at')
      .all(projectId)
      .map((row) => {
        const r = row as Row
        return {
          id: text(r.id),
          project_id: text(r.project_id),
          step: text(r.step),
          content: parseJson(r.content_json, null),
          created_at: text(r.created_at),
        }
      })
  }

  createBpProject(input: { studentId: string; idea: string }): string {
    const id = `bp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const timestamp = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO bp_projects (id, student_id, idea, status, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', ?, ?)`,
      )
      .run(id, input.studentId, input.idea, timestamp, timestamp)
    return id
  }

  getBpProject(id: string): BpProject | undefined {
    const row = this.db.prepare('SELECT * FROM bp_projects WHERE id=?').get(id) as Row | undefined
    if (!row) return undefined
    return {
      id: text(row.id),
      student_id: text(row.student_id),
      idea: text(row.idea),
      status: text(row.status),
      created_at: text(row.created_at),
      updated_at: text(row.updated_at),
    }
  }

  listBpProjects(studentId?: string): BpProject[] {
    const rows = studentId
      ? this.db.prepare('SELECT * FROM bp_projects WHERE student_id=? ORDER BY updated_at DESC').all(studentId)
      : this.db.prepare('SELECT * FROM bp_projects ORDER BY updated_at DESC').all()
    return rows.map((row) => {
      const r = row as Row
      return {
        id: text(r.id),
        student_id: text(r.student_id),
        idea: text(r.idea),
        status: text(r.status),
        created_at: text(r.created_at),
        updated_at: text(r.updated_at),
      }
    })
  }

  upsertBpSection(projectId: string, section: string, content: string, evidence: unknown): void {
    const id = `${projectId}:${section}`
    const timestamp = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO bp_sections (id, project_id, section, content, evidence_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content=excluded.content, evidence_json=excluded.evidence_json,
           updated_at=excluded.updated_at`,
      )
      .run(id, projectId, section, content, toJson(evidence), timestamp)
    this.db.prepare('UPDATE bp_projects SET updated_at=? WHERE id=?').run(timestamp, projectId)
  }

  listBpSections(projectId: string): BpSection[] {
    return this.db
      .prepare('SELECT * FROM bp_sections WHERE project_id=? ORDER BY section')
      .all(projectId)
      .map((row) => {
        const r = row as Row
        return {
          id: text(r.id),
          project_id: text(r.project_id),
          section: text(r.section),
          content: text(r.content),
          evidence: parseJson(r.evidence_json, []),
          updated_at: text(r.updated_at),
        }
      })
  }

  recordAttempt(input: {
    questionId: string
    studentId: string
    answer: string
    feedback: unknown
    score: number
  }): string {
    const id = `attempt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    this.db
      .prepare(
        `INSERT INTO question_attempts (id, question_id, student_id, answer, feedback_json, score, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.questionId, input.studentId, input.answer, toJson(input.feedback), input.score, new Date().toISOString())
    return id
  }

  listAttempts(input: { studentId: string; questionIds?: string[]; limit?: number }): QuestionAttempt[] {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500)
    if (input.questionIds && input.questionIds.length > 0) {
      const placeholders = input.questionIds.map(() => '?').join(',')
      return this.db
        .prepare(
          `SELECT * FROM question_attempts
           WHERE student_id=? AND question_id IN (${placeholders})
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(input.studentId, ...input.questionIds, limit)
        .map((row) => {
          const r = row as Row
          return {
            id: text(r.id),
            question_id: text(r.question_id),
            student_id: text(r.student_id),
            answer: text(r.answer),
            feedback_json: parseJson(r.feedback_json, {}),
            score: number(r.score),
            created_at: text(r.created_at),
          }
        })
    }
    return this.db
      .prepare('SELECT * FROM question_attempts WHERE student_id=? ORDER BY created_at DESC LIMIT ?')
      .all(input.studentId, limit)
      .map((row) => {
        const r = row as Row
        return {
          id: text(r.id),
          question_id: text(r.question_id),
          student_id: text(r.student_id),
          answer: text(r.answer),
          feedback_json: parseJson(r.feedback_json, {}),
          score: number(r.score),
          created_at: text(r.created_at),
        }
      })
  }

  insertQuestionBank(entry: QuestionBankEntry): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO question_bank (
          question_id, stem_hash, stem, chapter_id, kp_ids_json, type,
          difficulty, source, usage_count, created_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.question_id,
        entry.stem_hash,
        entry.stem,
        entry.chapter_id,
        toJson(entry.kp_ids),
        entry.type,
        entry.difficulty,
        entry.source,
        entry.usage_count,
        entry.created_at,
        entry.last_used_at,
      )
    return Number(result.changes) > 0
  }

  getQuestionBankByHash(stemHash: string): QuestionBankEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM question_bank WHERE stem_hash=?')
      .get(stemHash) as Row | undefined
    return row ? questionBankFromRow(row) : undefined
  }

  countQuestionBank(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS value FROM question_bank').get() as Row | undefined
    return number(row?.value)
  }

  listQuestionBank(limit = 50): QuestionBankEntry[] {
    return this.db
      .prepare('SELECT * FROM question_bank ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 200))
      .map((row) => questionBankFromRow(row as Row))
  }

  listGrowth(studentId: string): GrowthRecord[] {
    return this.db
      .prepare('SELECT * FROM growth_records WHERE student_id=? ORDER BY created_at DESC')
      .all(studentId)
      .map((row) => {
        const r = row as Row
        return {
          id: text(r.id),
          student_id: text(r.student_id),
          competency: text(r.competency),
          level: text(r.level),
          evidence: parseJson(r.evidence_json, []),
          created_at: text(r.created_at),
        }
      })
  }

  addGrowth(input: { studentId: string; competency: string; level: string; evidence: unknown }): void {
    const id = `growth_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    this.db
      .prepare(
        `INSERT INTO growth_records (id, student_id, competency, level, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.studentId, input.competency, input.level, toJson(input.evidence), new Date().toISOString())
  }

  startIngestRun(source: string): string {
    const id = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    this.db
      .prepare('INSERT INTO ingest_runs (id, source, started_at, status, stats_json) VALUES (?, ?, ?, ?, ?)')
      .run(id, source, new Date().toISOString(), 'running', '{}')
    return id
  }

  finishIngestRun(id: string, status: string, stats: unknown): void {
    this.db
      .prepare('UPDATE ingest_runs SET finished_at=?, status=?, stats_json=? WHERE id=?')
      .run(new Date().toISOString(), status, toJson(stats), id)
  }

  setState(pluginId: string, key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO plugin_state (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(plugin_id, key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
      )
      .run(pluginId, key, toJson(value), new Date().toISOString())
  }

  getState<T = unknown>(pluginId: string, key: string): T | undefined {
    const row = this.db
      .prepare('SELECT value_json FROM plugin_state WHERE plugin_id=? AND key=?')
      .get(pluginId, key) as Row | undefined
    return row ? parseJson<T>(row.value_json, undefined as T) : undefined
  }

  countContentTags(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS value FROM content_tags').get() as Row | undefined
    return number(row?.value)
  }

  countNewsTags(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS value FROM news_tags').get() as Row | undefined
    return number(row?.value)
  }

  countCaseMatches(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS value FROM case_matches').get() as Row | undefined
    return number(row?.value)
  }

  countQuestions(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS value FROM questions').get() as Row | undefined
    return number(row?.value)
  }

  countMockMatches(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS value FROM case_matches WHERE rationale LIKE '%mock evidence%'")
      .get() as Row | undefined
    return number(row?.value)
  }

  countTestQuestions(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS value FROM questions WHERE stem LIKE '%（测试 %' OR stem LIKE '%(测试 %'")
      .get() as Row | undefined
    return number(row?.value)
  }

  countSyntheticEvidence(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS value FROM evidence WHERE json_extract(metadata_json, '$.synthetic') = 1")
      .get() as Row | undefined
    return number(row?.value)
  }

  contentTagAudit(): Array<{
    tag_type: string
    method: string
    review_status: string
    evidence_level: string
    version: string
    count: number
  }> {
    return this.db
      .prepare(
        `SELECT tag_type, method, review_status, evidence_level, version, COUNT(*) AS count
         FROM content_tags GROUP BY tag_type, method, review_status, evidence_level, version
         ORDER BY tag_type, method, review_status`,
      )
      .all()
      .map((row) => {
        const r = row as Row
        return {
          tag_type: text(r.tag_type),
          method: text(r.method),
          review_status: text(r.review_status),
          evidence_level: text(r.evidence_level),
          version: text(r.version),
          count: number(r.count),
        }
      })
  }

  matchAudit(): Array<{
    method: string
    review_status: string
    evidence_level: string
    version: string
    count: number
  }> {
    return this.db
      .prepare(
        `SELECT method, review_status, evidence_level, version, COUNT(*) AS count
         FROM case_matches GROUP BY method, review_status, evidence_level, version
         ORDER BY method, review_status`,
      )
      .all()
      .map((row) => {
        const r = row as Row
        return {
          method: text(r.method),
          review_status: text(r.review_status),
          evidence_level: text(r.evidence_level),
          version: text(r.version),
          count: number(r.count),
        }
      })
  }

  /** Remove only the mock rows written by the LLM plumbing test; never touches user data. */
  cleanMockPollution(): { matches: number; tags: number; cache: number } {
    let matches = 0
    let tags = 0
    let cache = 0
    this.transaction(() => {
      const rows = this.db
        .prepare("SELECT article_id, kp_id, id FROM case_matches WHERE rationale LIKE '%mock evidence%'")
        .all() as Row[]
      const delMatch = this.db.prepare('DELETE FROM case_matches WHERE id=?')
      const delTag = this.db.prepare('DELETE FROM news_tags WHERE id=?')
      for (const row of rows) {
        delMatch.run(text(row.id))
        const tagResult = delTag.run(text(row.id))
        tags += Number(tagResult.changes)
        matches += 1
      }
      const cacheResult = this.db.prepare("DELETE FROM plugin_state WHERE plugin_id='matcher'").run()
      cache = Number(cacheResult.changes)
    })
    return { matches, tags, cache }
  }

  /** Delete only never-attempted questions tagged `（测试 <n>）` by the plumbing test. */
  cleanTestQuestions(): number {
    let deleted = 0
    this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id FROM questions
           WHERE (stem LIKE '%（测试 %' OR stem LIKE '%(测试 %')
             AND id NOT IN (SELECT question_id FROM question_attempts)`,
        )
        .all() as Row[]
      for (const row of rows) {
        const id = text(row.id)
        this.db.prepare('DELETE FROM question_kps WHERE question_id=?').run(id)
        this.db.prepare('DELETE FROM question_ideology WHERE question_id=?').run(id)
        this.db.prepare('DELETE FROM question_bank WHERE question_id=?').run(id)
        deleted += Number(this.db.prepare('DELETE FROM questions WHERE id=?').run(id).changes)
      }
    })
    return deleted
  }

  private transaction(run: () => void): void {
    this.db.exec('BEGIN')
    try {
      run()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
