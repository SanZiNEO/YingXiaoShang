// @yxs/migrate-pg · 38 表注册表（SQLite learning.db → PostgreSQL 16 唯一表结构真相源）
//
// 口径来源：plans/server-client-split/D-pg-migration/02-contract.md §3.1/§3.2；
// 逐列事实以 .scratch/run/D/work/schema-facts.json（PRAGMA table_info / foreign_key_list /
// index_list，user_version=7）与 sqlite-schema.txt 为准。
//
// 类型映射硬规则（02-contract §3.1）：
//   TEXT 普通列            → text
//   TEXT 列名后缀 _json（或 value_json/state_json/plan_json/record_json/payload_json/
//                         content_json/profile_json/metadata_json/input_schema_json）→ jsonb
//   TEXT 列名后缀 _at      → timestamptz
//   INTEGER                → bigint（唯一例外：skills.enabled → boolean）
//   REAL                   → double precision
//
// nullable 例外（本文件唯一允许偏离「NOT NULL 逐列保留」的地方）：
//   时间戳列即使源库为 NOT NULL DEFAULT ''，PG 侧也必须允许 NULL —— 空串 '' 仅表示
//   「未发生」的空值标记，装载时归一为 SQL NULL（02-contract §3.1 时间戳行）；其 DEFAULT ''
//   同样不翻译成 PG 默认值。其余列严格保留源库 NOT NULL。
//
// DEFAULT 字面量约定：columns[].default 可直接拼进 PG DDL（DEFAULT <default>）：
//   文本保留带引号字面量（'draft' / ''）；jsonb 加 ::jsonb 转换（'[]'::jsonb / '{}'::jsonb）；
//   数值为裸字面量（2 / 0 / 1 / 0.7）；boolean 为 true/false；无默认值为 null。
//
// 不新增源库没有的约束/索引/视图/触发器/GIN 索引；STRICT 与 WITHOUT ROWID 子句丢弃。
// uniques 中 constraint: true 表示源库表内 UNIQUE(...) 约束（PG 建成表级唯一约束），
// 其余为源库 CREATE UNIQUE INDEX（同名保留）。

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const TABLES = [
  {
    name: "chapters",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "number", src: "INTEGER", pg: "bigint", nullable: false, default: null },
    { name: "title", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "source_path", src: "TEXT", pg: "text", nullable: false, default: null },
    ],
    fks: [
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "sections",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "chapter_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "number", src: "INTEGER", pg: "bigint", nullable: false, default: null },
    { name: "title", src: "TEXT", pg: "text", nullable: false, default: null },
    ],
    fks: [
    { columns: ["chapter_id"], refTable: "chapters", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "knowledge_points",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "chapter_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "section_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "name", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "name_en", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "definition", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "keywords_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "examples_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "non_examples_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "aliases_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "difficulty", src: "INTEGER", pg: "bigint", nullable: false, default: "2" },
    { name: "competencies_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "decisions_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "source", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "status", src: "TEXT", pg: "text", nullable: false, default: "'draft'" },
    { name: "parent_id", src: "TEXT", pg: "text", nullable: true, default: null },
    ],
    fks: [
    { columns: ["section_id"], refTable: "sections", refColumns: ["id"], onDelete: 'CASCADE' },
    { columns: ["chapter_id"], refTable: "chapters", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "content_blocks",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "chapter_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "section_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "block_type", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "text", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "page", src: "INTEGER", pg: "bigint", nullable: true, default: null },
    { name: "source", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "rights", src: "TEXT", pg: "text", nullable: false, default: null },
    ],
    fks: [
    { columns: ["chapter_id"], refTable: "chapters", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "content_tags",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "block_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "tag_type", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "tag_key", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "tag_role", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "confidence", src: "REAL", pg: "double precision", nullable: false, default: null },
    { name: "method", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "evidence_span", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "evidence_start", src: "INTEGER", pg: "bigint", nullable: true, default: null },
    { name: "evidence_end", src: "INTEGER", pg: "bigint", nullable: true, default: null },
    { name: "review_status", src: "TEXT", pg: "text", nullable: false, default: "'draft'" },
    { name: "evidence_level", src: "TEXT", pg: "text", nullable: false, default: "'auto'" },
    { name: "version", src: "TEXT", pg: "text", nullable: false, default: "'v0.1'" },
    { name: "reviewer_id", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "reviewed_at", src: "TEXT", pg: "timestamptz", nullable: true, default: null },
    ],
    fks: [
    { columns: ["block_id"], refTable: "content_blocks", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    { name: "content_tags_by_review", columns: ["review_status", "evidence_level"] },
    { name: "content_tags_by_key", columns: ["tag_type", "tag_key"] },
    ],
  },
  {
    name: "ideology_points",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "name", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "definition", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "examples_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "non_examples_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "related_kp_ids_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "source", src: "TEXT", pg: "text", nullable: false, default: null },
    ],
    fks: [
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "ideology_tags",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "target_type", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "target_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "ideology_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "confidence", src: "REAL", pg: "double precision", nullable: false, default: null },
    { name: "evidence_span", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "rationale", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "review_status", src: "TEXT", pg: "text", nullable: false, default: "'draft'" },
    { name: "evidence_level", src: "TEXT", pg: "text", nullable: false, default: "'auto'" },
    { name: "version", src: "TEXT", pg: "text", nullable: false, default: "'v0.1'" },
    { name: "reviewer_id", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "reviewed_at", src: "TEXT", pg: "timestamptz", nullable: true, default: null },
    ],
    fks: [
    { columns: ["ideology_id"], refTable: "ideology_points", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    { name: "ideology_tags_by_target", columns: ["target_type", "target_id"] },
    ],
  },
  {
    name: "news_articles",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "source", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "source_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "title", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "url", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "author", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "published_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    { name: "summary", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "content", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "content_status", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "rights", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "fetched_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    { name: "content_hash", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "tag_content_hash", src: "TEXT", pg: "text", nullable: false, default: "''" },
    ],
    fks: [
    ],
    uniques: [
    { name: "news_articles_by_url", columns: ["url"] },
    ],
    indexes: [
    { name: "news_articles_by_tag_hash", columns: ["tag_content_hash"] },
    { name: "news_articles_by_published", columns: ["published_at"] },
    ],
  },
  {
    name: "news_tags",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "article_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "tag_type", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "tag_key", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "tag_role", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "confidence", src: "REAL", pg: "double precision", nullable: false, default: null },
    { name: "method", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "evidence_span", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "evidence_start", src: "INTEGER", pg: "bigint", nullable: true, default: null },
    { name: "evidence_end", src: "INTEGER", pg: "bigint", nullable: true, default: null },
    { name: "review_status", src: "TEXT", pg: "text", nullable: false, default: "'draft'" },
    { name: "evidence_level", src: "TEXT", pg: "text", nullable: false, default: "'auto'" },
    { name: "version", src: "TEXT", pg: "text", nullable: false, default: "'v0.1'" },
    { name: "reviewer_id", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "reviewed_at", src: "TEXT", pg: "timestamptz", nullable: true, default: null },
    ],
    fks: [
    { columns: ["article_id"], refTable: "news_articles", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    { name: "news_tags_by_key", columns: ["tag_type", "tag_key"] },
    ],
  },
  {
    name: "case_matches",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "article_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "kp_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "score", src: "REAL", pg: "double precision", nullable: false, default: null },
    { name: "confidence", src: "REAL", pg: "double precision", nullable: false, default: null },
    { name: "tag_role", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "evidence_span", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "evidence_start", src: "INTEGER", pg: "bigint", nullable: true, default: null },
    { name: "evidence_end", src: "INTEGER", pg: "bigint", nullable: true, default: null },
    { name: "rationale", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "method", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    { name: "review_status", src: "TEXT", pg: "text", nullable: false, default: "'draft'" },
    { name: "evidence_level", src: "TEXT", pg: "text", nullable: false, default: "'auto'" },
    { name: "version", src: "TEXT", pg: "text", nullable: false, default: "'v0.1'" },
    { name: "reviewer_id", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "reviewed_at", src: "TEXT", pg: "timestamptz", nullable: true, default: null },
    ],
    fks: [
    { columns: ["kp_id"], refTable: "knowledge_points", refColumns: ["id"], onDelete: 'CASCADE' },
    { columns: ["article_id"], refTable: "news_articles", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    { name: "case_matches_by_review", columns: ["review_status", "evidence_level"] },
    { name: "case_matches_by_kp", columns: ["kp_id"] },
    { name: "case_matches_by_article", columns: ["article_id"] },
    ],
  },
  {
    name: "questions",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "source_type", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "source_id", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "type", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "stem", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "options_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "answer", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "explanation", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "difficulty", src: "INTEGER", pg: "bigint", nullable: false, default: null },
    { name: "status", src: "TEXT", pg: "text", nullable: false, default: "'draft'" },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "question_kps",
    pk: ["question_id", "kp_id"],
    columns: [
    { name: "question_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "kp_id", src: "TEXT", pg: "text", nullable: false, default: null },
    ],
    fks: [
    { columns: ["kp_id"], refTable: "knowledge_points", refColumns: ["id"], onDelete: 'CASCADE' },
    { columns: ["question_id"], refTable: "questions", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    { name: "question_kps_by_kp", columns: ["kp_id"] },
    ],
  },
  {
    name: "question_ideology",
    pk: ["question_id", "ideology_id"],
    columns: [
    { name: "question_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "ideology_id", src: "TEXT", pg: "text", nullable: false, default: null },
    ],
    fks: [
    { columns: ["ideology_id"], refTable: "ideology_points", refColumns: ["id"], onDelete: 'CASCADE' },
    { columns: ["question_id"], refTable: "questions", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "question_attempts",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "question_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "student_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "answer", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "feedback_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'{}'::jsonb" },
    { name: "score", src: "REAL", pg: "double precision", nullable: false, default: null },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    { columns: ["question_id"], refTable: "questions", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "research_projects",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "student_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "brief", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "status", src: "TEXT", pg: "text", nullable: false, default: "'draft'" },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    { name: "updated_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "research_artifacts",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "project_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "step", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "content_json", src: "TEXT", pg: "jsonb", nullable: false, default: null },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    { columns: ["project_id"], refTable: "research_projects", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "bp_projects",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "student_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "idea", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "status", src: "TEXT", pg: "text", nullable: false, default: "'draft'" },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    { name: "updated_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "bp_sections",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "project_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "section", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "content", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "evidence_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "updated_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    { columns: ["project_id"], refTable: "bp_projects", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "student_profiles",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "name", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "cohort", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    { name: "profile_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'{}'::jsonb" },
    { name: "updated_at", src: "TEXT", pg: "timestamptz", nullable: true, default: null },
    ],
    fks: [
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "growth_records",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "student_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "competency", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "level", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "evidence_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    { columns: ["student_id"], refTable: "student_profiles", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "ingest_runs",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "source", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "started_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    { name: "finished_at", src: "TEXT", pg: "timestamptz", nullable: true, default: null },
    { name: "status", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "stats_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'{}'::jsonb" },
    ],
    fks: [
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "plugin_state",
    pk: ["plugin_id", "key"],
    columns: [
    { name: "plugin_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "key", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "value_json", src: "TEXT", pg: "jsonb", nullable: false, default: null },
    { name: "updated_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "competencies",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "name", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "definition", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "levels_json", src: "TEXT", pg: "jsonb", nullable: false, default: null },
    { name: "observable_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "version", src: "TEXT", pg: "text", nullable: false, default: "'v0.1'" },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "evidence",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "student_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "competency_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "level", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "strength", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "evidence_type", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "source_type", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "source_id", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "chapter_id", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "session_id", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "excerpt", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "rationale", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "confidence", src: "REAL", pg: "double precision", nullable: false, default: null },
    { name: "method", src: "TEXT", pg: "text", nullable: false, default: "'llm'" },
    { name: "review_status", src: "TEXT", pg: "text", nullable: false, default: "'draft'" },
    { name: "review_note", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "occurred_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    { name: "metadata_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'{}'::jsonb" },
    ],
    fks: [
    { columns: ["competency_id"], refTable: "competencies", refColumns: ["id"], onDelete: 'CASCADE' },
    { columns: ["student_id"], refTable: "student_profiles", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    { name: "evidence_by_chapter", columns: ["student_id", "chapter_id"] },
    { name: "evidence_by_competency", columns: ["student_id", "competency_id"] },
    { name: "evidence_by_student", columns: ["student_id", "occurred_at"] },
    ],
  },
  {
    name: "growth_snapshots",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "student_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "chapter_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "checkpoint", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "competency_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "level", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "confidence", src: "REAL", pg: "double precision", nullable: false, default: null },
    { name: "evidence_count", src: "INTEGER", pg: "bigint", nullable: false, default: null },
    { name: "summary", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    { columns: ["competency_id"], refTable: "competencies", refColumns: ["id"], onDelete: 'CASCADE' },
    { columns: ["student_id"], refTable: "student_profiles", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    { name: "snapshots_by_student", columns: ["student_id", "chapter_id"] },
    ],
  },
  {
    name: "learning_plan",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "student_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "chapter_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "phase", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "title", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "tasks_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "status", src: "TEXT", pg: "text", nullable: false, default: "'pending'" },
    { name: "due_at", src: "TEXT", pg: "timestamptz", nullable: true, default: null },
    { name: "updated_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    { columns: ["student_id"], refTable: "student_profiles", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    { name: "plan_by_student", columns: ["student_id", "chapter_id"] },
    ],
  },
  {
    name: "chat_sessions",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "student_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "chapter_id", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "title", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    { name: "updated_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    { columns: ["student_id"], refTable: "student_profiles", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    { name: "chat_sessions_by_student", columns: ["student_id", "updated_at"] },
    ],
  },
  {
    name: "chat_messages",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "session_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "role", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "content", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "evidence_count", src: "INTEGER", pg: "bigint", nullable: false, default: "0" },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    { name: "seq", src: "INTEGER", pg: "bigint", nullable: false, default: "0" },
    { name: "turn_id", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "kind", src: "TEXT", pg: "text", nullable: false, default: "'message'" },
    { name: "payload_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'{}'::jsonb" },
    ],
    fks: [
    { columns: ["session_id"], refTable: "chat_sessions", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    { name: "chat_messages_seq", columns: ["session_id", "seq"] },
    ],
    indexes: [
    { name: "chat_messages_by_session", columns: ["session_id", "created_at"] },
    ],
  },
  {
    name: "memory_facts",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "student_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "kind", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "key", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "value_json", src: "TEXT", pg: "jsonb", nullable: false, default: null },
    { name: "confidence", src: "REAL", pg: "double precision", nullable: false, default: "0.7" },
    { name: "source", src: "TEXT", pg: "text", nullable: false, default: "'chat'" },
    { name: "updated_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    { columns: ["student_id"], refTable: "student_profiles", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    { name: "memory_facts_by_student", columns: ["student_id", "kind"] },
    ],
  },
  {
    name: "memory_episodes",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "student_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "session_id", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "summary", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "decisions_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "open_questions_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    { columns: ["student_id"], refTable: "student_profiles", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    { name: "memory_episodes_by_student", columns: ["student_id", "created_at"] },
    ],
  },
  {
    name: "artifacts",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "student_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "session_id", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "skill_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "template_id", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "type", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "title", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "format", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "path", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "content", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "evidence_ids_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    { name: "content_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'{}'::jsonb" },
    { name: "schema_version", src: "TEXT", pg: "text", nullable: false, default: "'Markdown@1'" },
    { name: "version", src: "INTEGER", pg: "bigint", nullable: false, default: "1" },
    { name: "status", src: "TEXT", pg: "text", nullable: false, default: "'ready'" },
    { name: "source_refs_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    ],
    fks: [
    { columns: ["student_id"], refTable: "student_profiles", refColumns: ["id"], onDelete: 'CASCADE' },
    ],
    uniques: [
    ],
    indexes: [
    { name: "artifacts_by_student", columns: ["student_id", "created_at"] },
    ],
  },
  {
    name: "skills",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "expert_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "name", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "description", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "input_schema_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'{}'::jsonb" },
    { name: "template_id", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "enabled", src: "INTEGER", pg: "boolean", nullable: false, default: "true" },
    { name: "updated_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "turns",
    pk: ["id"],
    columns: [
    { name: "id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "session_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "turn_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "status", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "plan_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'{}'::jsonb" },
    { name: "record_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'{}'::jsonb" },
    { name: "seq_start", src: "INTEGER", pg: "bigint", nullable: false, default: "0" },
    { name: "seq_end", src: "INTEGER", pg: "bigint", nullable: false, default: "0" },
    { name: "started_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    { name: "finished_at", src: "TEXT", pg: "timestamptz", nullable: true, default: null },
    ],
    fks: [
    ],
    uniques: [
    { name: "turns_session_id_turn_id", columns: ["session_id", "turn_id"], constraint: true },
    ],
    indexes: [
    { name: "turns_by_session", columns: ["session_id", "started_at"] },
    ],
  },
  {
    name: "learning_states",
    pk: ["student_id", "chapter_id"],
    columns: [
    { name: "student_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "chapter_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "phase", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "state_json", src: "TEXT", pg: "jsonb", nullable: false, default: null },
    { name: "updated_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    ],
    uniques: [
    ],
    indexes: [
    ],
  },
  {
    name: "summary_ledger",
    pk: ["source_type", "source_id"],
    columns: [
    { name: "source_type", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "source_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "source_seq", src: "INTEGER", pg: "bigint", nullable: false, default: null },
    { name: "summarized_seq", src: "INTEGER", pg: "bigint", nullable: false, default: "0" },
    { name: "source_hash", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "status", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "summary_id", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "attempts", src: "INTEGER", pg: "bigint", nullable: false, default: "0" },
    { name: "last_error", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "updated_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    ],
    uniques: [
    ],
    indexes: [
    { name: "ledger_by_status", columns: ["status", "updated_at"] },
    ],
  },
  {
    name: "question_bank",
    pk: ["question_id"],
    columns: [
    { name: "question_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "stem_hash", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "stem", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "chapter_id", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "kp_ids_json", src: "TEXT", pg: "jsonb", nullable: false, default: "'[]'::jsonb" },
    { name: "type", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "difficulty", src: "INTEGER", pg: "bigint", nullable: false, default: null },
    { name: "source", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "usage_count", src: "INTEGER", pg: "bigint", nullable: false, default: "0" },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    { name: "last_used_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    ],
    uniques: [
    { name: "question_bank_stem", columns: ["stem_hash"] },
    ],
    indexes: [
    ],
  },
  {
    name: "kp_canonical_map",
    pk: ["old_id"],
    columns: [
    { name: "old_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "canonical_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "name", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    ],
    uniques: [
    ],
    indexes: [
    { name: "kp_canonical_map_by_canonical", columns: ["canonical_id"] },
    ],
  },
  {
    name: "block_canonical_map",
    pk: ["old_id"],
    columns: [
    { name: "old_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "canonical_id", src: "TEXT", pg: "text", nullable: false, default: null },
    { name: "reason", src: "TEXT", pg: "text", nullable: false, default: "''" },
    { name: "created_at", src: "TEXT", pg: "timestamptz", nullable: false, default: null },
    ],
    fks: [
    ],
    uniques: [
    ],
    indexes: [
    { name: "block_canonical_map_by_canonical", columns: ["canonical_id"] },
    ],
  },
]

export const TABLE_BY_NAME = Object.fromEntries(TABLES.map((t) => [t.name, t]))

export const TABLE_NAMES = TABLES.map((t) => t.name)

// 外键图拓扑排序：父表在子表之前；同层按注册表顺序稳定排列。
function topologicalOrder() {
  const indegree = new Map(TABLE_NAMES.map((n) => [n, 0]))
  const children = new Map(TABLE_NAMES.map((n) => [n, []]))
  for (const t of TABLES) {
    for (const fk of t.fks) {
      for (const ref of fk.refTable ? [fk.refTable] : []) {
        if (!TABLE_BY_NAME[ref]) continue
        children.get(ref).push(t.name)
        indegree.set(t.name, indegree.get(t.name) + 1)
      }
    }
  }
  const queue = TABLE_NAMES.filter((n) => indegree.get(n) === 0)
  const order = []
  while (queue.length) {
    const name = queue.shift()
    order.push(name)
    for (const child of children.get(name)) {
      indegree.set(child, indegree.get(child) - 1)
      if (indegree.get(child) === 0) queue.push(child)
    }
  }
  if (order.length !== TABLE_NAMES.length) {
    throw new Error('外键图存在环，无法拓扑排序')
  }
  return order
}

export const CREATE_ORDER = topologicalOrder()
export const DROP_ORDER = [...CREATE_ORDER].reverse()

function quoteCol(name) {
  return '"' + name + '"'
}

// 生成 PG DDL：先按 CREATE_ORDER 逐表 CREATE TABLE IF NOT EXISTS，
// 随后是唯一约束/索引与非唯一索引（索引名与源库同名）。
export function buildDdl() {
  const statements = []
  for (const name of CREATE_ORDER) {
    const t = TABLE_BY_NAME[name]
    const lines = []
    for (const c of t.columns) {
      let line = `  ${quoteCol(c.name)} ${c.pg}`
      if (!c.nullable) line += ' NOT NULL'
      if (c.default !== null) line += ` DEFAULT ${c.default}`
      lines.push(line)
    }
    if (t.pk.length) {
      lines.push('  PRIMARY KEY (' + t.pk.map(quoteCol).join(', ') + ')')
    }
    for (const fk of t.fks) {
      lines.push(
        '  FOREIGN KEY (' + fk.columns.map(quoteCol).join(', ') + ') REFERENCES ' +
        fk.refTable + ' (' + fk.refColumns.map(quoteCol).join(', ') + ') ON DELETE ' + fk.onDelete,
      )
    }
    for (const u of t.uniques) {
      if (u.constraint) {
        lines.push('  UNIQUE (' + u.columns.map(quoteCol).join(', ') + ')')
      }
    }
    statements.push(
      'CREATE TABLE IF NOT EXISTS ' + name + ' (\n' + lines.join(',\n') + '\n);',
    )
  }
  for (const name of CREATE_ORDER) {
    const t = TABLE_BY_NAME[name]
    for (const u of t.uniques) {
      if (u.constraint) continue
      statements.push(
        'CREATE UNIQUE INDEX IF NOT EXISTS ' + u.name + ' ON ' + name +
        ' (' + u.columns.map(quoteCol).join(', ') + ');',
      )
    }
    for (const ix of t.indexes) {
      statements.push(
        'CREATE INDEX IF NOT EXISTS ' + ix.name + ' ON ' + name +
        ' (' + ix.columns.map(quoteCol).join(', ') + ');',
      )
    }
  }
  return statements
}

// 从 packages/db/src/index.ts 文本抽取表名与列名（仅结构核对，不做方言翻译）。
// 覆盖基线 SCHEMA 段的 CREATE TABLE，以及 MIGRATION_2..7 的 ALTER TABLE ADD COLUMN。
function matchParen(src, openIdx) {
  let depth = 0
  let inStr = null
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]
    if (inStr) {
      if (ch === inStr && src[i - 1] !== '\\') inStr = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === String.fromCharCode(96)) { inStr = ch; continue }
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) return src.slice(openIdx + 1, i) }
  }
  throw new Error('括号未闭合')
}

function splitTopLevel(body) {
  const parts = []
  let depth = 0
  let inStr = null
  let cur = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (inStr) {
      cur += ch
      if (ch === inStr && body[i - 1] !== '\\') inStr = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === String.fromCharCode(96)) { inStr = ch; cur += ch; continue }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
  }
  if (cur.trim()) parts.push(cur)
  return parts
}

const TABLE_ENTRY = /^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CONSTRAINT|CHECK)\b/i

// 列定义里紧跟类型之后的关键字；遇到它们即表示类型段结束。
const COL_KEYWORD = /\b(PRIMARY\s+KEY|NOT\s+NULL|DEFAULT|REFERENCES|UNIQUE|CHECK|COLLATE|GENERATED)\b/i

// 单条列定义 → { name, type, notnull, defaultLit, pk, ref, unique }。
// 只覆盖 packages/db 实际用到的 SQLite 语法子集；遇到不认识的写法抛错，不静默跳过。
function parseColumnDef(def) {
  const text = def.trim()
  const nameMatch = /^([A-Za-z_]\w*|"[^"]+"|`[^`]+`|\[[^\]]+\])\s+([\s\S]+)$/.exec(text)
  if (!nameMatch) throw new Error(`无法解析列定义：${text}`)
  const name = nameMatch[1].replace(/["'`[\]]/g, '')
  const rest = nameMatch[2]

  const kwMatch = COL_KEYWORD.exec(rest)
  const type = (kwMatch ? rest.slice(0, kwMatch.index) : rest).trim().toUpperCase()
  const tail = kwMatch ? rest.slice(kwMatch.index) : ''

  const defaultMatch = /DEFAULT\s+('(?:[^']|'')*'|[^\s,]+)/i.exec(tail)
  const refMatch = /REFERENCES\s+([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*)\s*\)(?:\s+ON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION))?/i.exec(tail)

  return {
    name,
    type,
    notnull: /\bNOT\s+NULL\b/i.test(tail),
    defaultLit: defaultMatch ? defaultMatch[1] : null,
    pk: /\bPRIMARY\s+KEY\b/i.test(tail),
    unique: /\bUNIQUE\b/i.test(tail),
    ref: refMatch
      ? {
          columns: [name],
          refTable: refMatch[1],
          refColumns: [refMatch[2]],
          onDelete: (refMatch[3] || 'NO ACTION').toUpperCase().replace(/\s+/g, ' '),
        }
      : null,
  }
}

// 从 packages/db/src/index.ts 抽取结构事实：表、列（类型/可空/默认/主键/外键）、
// 表级 UNIQUE、CREATE [UNIQUE] INDEX。覆盖基线 SCHEMA 段的 CREATE TABLE 与
// MIGRATION_2..7 的 ALTER TABLE ADD COLUMN。只做结构核对，不做方言翻译。
export function parseSourceIndex(srcText) {
  const tables = []
  const byName = new Map()

  function ensure(name) {
    if (!byName.has(name)) {
      const t = { name, columns: [], pk: [], uniques: [], fks: [] }
      byName.set(name, t)
      tables.push(t)
    }
    return byName.get(name)
  }

  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_]\w*)\s*\(/gi
  let m
  while ((m = createRe.exec(srcText))) {
    const table = ensure(m[1])
    const body = matchParen(srcText, createRe.lastIndex - 1)
    for (const rawEntry of splitTopLevel(body)) {
      const entry = rawEntry.trim()
      if (!entry) continue
      if (!TABLE_ENTRY.test(entry)) {
        const col = parseColumnDef(entry)
        table.columns.push(col)
        if (col.pk) table.pk.push(col.name)
        if (col.ref) table.fks.push(col.ref)
        if (col.unique) table.uniques.push([col.name])
        continue
      }
      const pkMatch = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(entry)
      if (pkMatch) {
        table.pk = pkMatch[1].split(',').map((s) => s.trim().replace(/["'`[\]]/g, '')).filter(Boolean)
        continue
      }
      const uniqueMatch = /^UNIQUE\s*\(([^)]*)\)/i.exec(entry)
      if (uniqueMatch) {
        table.uniques.push(
          uniqueMatch[1].split(',').map((s) => s.trim().replace(/["'`[\]]/g, '')).filter(Boolean),
        )
        continue
      }
      const fkMatch = /^FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([A-Za-z_]\w*)\s*\(([^)]*)\)(?:\s+ON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION))?/i.exec(entry)
      if (fkMatch) {
        table.fks.push({
          columns: fkMatch[1].split(',').map((s) => s.trim().replace(/["'`[\]]/g, '')).filter(Boolean),
          refTable: fkMatch[2],
          refColumns: fkMatch[3].split(',').map((s) => s.trim().replace(/["'`[\]]/g, '')).filter(Boolean),
          onDelete: (fkMatch[4] || 'NO ACTION').toUpperCase().replace(/\s+/g, ' '),
        })
        continue
      }
      throw new Error(`无法解析表级约束：${entry}`)
    }
  }

  const alterRe = /ALTER\s+TABLE\s+([A-Za-z_]\w*)\s+ADD\s+COLUMN\s+([^;]+);/gi
  while ((m = alterRe.exec(srcText))) {
    const table = ensure(m[1])
    const col = parseColumnDef(m[2])
    table.columns.push(col)
    if (col.ref) table.fks.push(col.ref)
    if (col.unique) table.uniques.push([col.name])
  }

  const indexes = []
  const indexRe = /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_]\w*)\s+ON\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gi
  while ((m = indexRe.exec(srcText))) {
    indexes.push({
      name: m[2],
      table: m[3],
      unique: !!m[1],
      columns: m[4].split(',').map((s) => s.trim().replace(/["'`[\]]/g, '')).filter(Boolean),
    })
  }

  return { tables, indexes }
}

// 源库 SQLite 默认字面量 → 注册表里应出现的 PG 默认字面量。
// 规则与 03-implementation 的生成器一致：时间戳的空串默认值是 NULL 占位，PG 侧不保留；
// jsonb 追加 ::jsonb；boolean 的 0/1 写成 false/true；其余原样。
function expectedPgDefault(pgType, defaultLit) {
  if (defaultLit === null) return null
  if (pgType === 'timestamptz' && defaultLit === "''") return null
  if (pgType === 'jsonb') {
    if (defaultLit === "'[]'") return "'[]'::jsonb"
    if (defaultLit === "'{}'") return "'{}'::jsonb"
    return defaultLit
  }
  if (pgType === 'boolean') {
    if (defaultLit === '1') return 'true'
    if (defaultLit === '0') return 'false'
    return defaultLit
  }
  return defaultLit
}

function keyOfList(cols) {
  return cols.join(',')
}

// 注册表与源码双向漂移核对：表、列、类型、可空、默认值、主键、外键、唯一约束/索引、
// 普通索引逐项比对。只比名字的核对会让「INTEGER 改 REAL」「默认值被改」「唯一索引被删」
// 全部漏过，因此这里必须落到列属性级。无漂移时所有数组为空。
export function diffAgainstSource(srcText) {
  const { tables: parsed, indexes: parsedIndexes } = parseSourceIndex(srcText)
  const parsedMap = new Map(parsed.map((t) => [t.name, t]))

  const missingTables = [...parsedMap.keys()].filter((n) => !TABLE_BY_NAME[n])
  const extraTables = TABLE_NAMES.filter((n) => !parsedMap.has(n))

  const missingColumns = []
  const extraColumns = []
  const typeDrift = []
  const nullableDrift = []
  const defaultDrift = []
  const pkDrift = []
  const foreignKeyDrift = []
  const uniqueDrift = []

  for (const t of TABLES) {
    const p = parsedMap.get(t.name)
    if (!p) continue
    const parsedCols = new Map(p.columns.map((c) => [c.name, c]))

    for (const c of t.columns) {
      const pc = parsedCols.get(c.name)
      if (!pc) {
        missingColumns.push({ table: t.name, column: c.name })
        continue
      }
      if (pc.type !== c.src) {
        typeDrift.push({ table: t.name, column: c.name, source: pc.type, registry: c.src })
      }
      // 时间戳列的空串默认值是「未发生」占位，注册表按契约放宽为可空且不带默认值。
      const nullableByContract = c.pg === 'timestamptz' && pc.defaultLit === "''"
      // SQLite 的 PRIMARY KEY 隐含 NOT NULL（WITHOUT ROWID 表同样如此），不能只看 NOT NULL 字样。
      const expectedNullable = !(pc.notnull || pc.pk) || nullableByContract
      if (expectedNullable !== c.nullable) {
        nullableDrift.push({
          table: t.name,
          column: c.name,
          source: expectedNullable,
          registry: c.nullable,
        })
      }
      const expectedDefault = expectedPgDefault(c.pg, pc.defaultLit)
      if (expectedDefault !== c.default) {
        defaultDrift.push({
          table: t.name,
          column: c.name,
          source: expectedDefault,
          registry: c.default,
        })
      }
    }
    for (const pc of p.columns) {
      if (!t.columns.some((x) => x.name === pc.name)) {
        extraColumns.push({ table: t.name, column: pc.name })
      }
    }

    if (keyOfList(p.pk) !== keyOfList(t.pk)) {
      pkDrift.push({ table: t.name, source: p.pk, registry: t.pk })
    }

    const fkKey = (fk) => `${keyOfList(fk.columns)}->${fk.refTable}(${keyOfList(fk.refColumns)}) ON DELETE ${fk.onDelete}`
    const srcFks = new Set(p.fks.map(fkKey))
    const regFks = new Set(t.fks.map(fkKey))
    for (const fk of srcFks) if (!regFks.has(fk)) foreignKeyDrift.push({ table: t.name, fk, side: 'source' })
    for (const fk of regFks) if (!srcFks.has(fk)) foreignKeyDrift.push({ table: t.name, fk, side: 'registry' })

    // 表内 UNIQUE(...) 与 CREATE UNIQUE INDEX 在注册表里分成两处：constraint: true 才是表级
    // 唯一约束，其余唯一索引进 indexDrift 比对，避免同一份事实被两处重复判一次。
    const srcUniques = new Set(p.uniques.map(keyOfList))
    const regUniques = new Set(t.uniques.filter((u) => u.constraint).map((u) => keyOfList(u.columns)))
    for (const u of srcUniques) if (!regUniques.has(u)) uniqueDrift.push({ table: t.name, unique: u, side: 'source' })
    for (const u of regUniques) if (!srcUniques.has(u)) uniqueDrift.push({ table: t.name, unique: u, side: 'registry' })
  }

  const indexDrift = []
  const parsedIndexByKey = new Map(parsedIndexes.map((ix) => [`${ix.table}(${keyOfList(ix.columns)})`, ix]))
  const regIndexByKey = new Map()
  for (const t of TABLES) {
    for (const u of t.uniques) {
      if (u.constraint) continue
      regIndexByKey.set(`${t.name}(${keyOfList(u.columns)})`, { name: u.name, table: t.name, unique: true })
    }
    for (const ix of t.indexes) {
      regIndexByKey.set(`${t.name}(${keyOfList(ix.columns)})`, { name: ix.name, table: t.name, unique: false })
    }
  }
  for (const [key, ix] of parsedIndexByKey) {
    const reg = regIndexByKey.get(key)
    if (!reg) indexDrift.push({ index: key, name: ix.name, side: 'source', unique: ix.unique })
    else if (reg.unique !== ix.unique) {
      indexDrift.push({ index: key, name: ix.name, side: 'uniqueness', unique: ix.unique })
    } else if (reg.name !== ix.name) {
      indexDrift.push({ index: key, name: ix.name, side: 'name', registry: reg.name })
    }
  }
  for (const [key, reg] of regIndexByKey) {
    if (!parsedIndexByKey.has(key)) indexDrift.push({ index: key, name: reg.name, side: 'registry' })
  }

  return {
    missingTables,
    extraTables,
    missingColumns,
    extraColumns,
    typeDrift,
    nullableDrift,
    defaultDrift,
    pkDrift,
    foreignKeyDrift,
    uniqueDrift,
    indexDrift,
  }
}

// 漂移清单是否为空（migrate.js 与 --check 共用同一判据，避免两处口径分叉）。
export function isDriftFree(diff) {
  return Object.values(diff).every((list) => list.length === 0)
}

// 把漂移清单渲染成中文问题行，供 CLI 与 migrate 统一输出。
export function describeDrift(diff) {
  const problems = []
  const fmt = (v) => (v === null || v === undefined ? '无' : JSON.stringify(v))
  if (diff.missingTables.length) problems.push(`缺少表：${diff.missingTables.join(', ')}`)
  if (diff.extraTables.length) problems.push(`多余表：${diff.extraTables.join(', ')}`)
  if (diff.missingColumns.length) {
    problems.push(`缺少列：${diff.missingColumns.map((c) => `${c.table}.${c.column}`).join(', ')}`)
  }
  if (diff.extraColumns.length) {
    problems.push(`多余列：${diff.extraColumns.map((c) => `${c.table}.${c.column}`).join(', ')}`)
  }
  if (diff.typeDrift.length) {
    problems.push(
      `列类型不一致：${diff.typeDrift.map((d) => `${d.table}.${d.column} 源 ${d.source} / 注册表 ${d.registry}`).join('；')}`,
    )
  }
  if (diff.nullableDrift.length) {
    problems.push(
      `列可空性不一致：${diff.nullableDrift.map((d) => `${d.table}.${d.column} 源 ${d.source ? '可空' : 'NOT NULL'} / 注册表 ${d.registry ? '可空' : 'NOT NULL'}`).join('；')}`,
    )
  }
  if (diff.defaultDrift.length) {
    problems.push(
      `列默认值不一致：${diff.defaultDrift.map((d) => `${d.table}.${d.column} 源 ${fmt(d.source)} / 注册表 ${fmt(d.registry)}`).join('；')}`,
    )
  }
  if (diff.pkDrift.length) {
    problems.push(
      `主键不一致：${diff.pkDrift.map((d) => `${d.table} 源 (${d.source.join(', ')}) / 注册表 (${d.registry.join(', ')})`).join('；')}`,
    )
  }
  if (diff.foreignKeyDrift.length) {
    problems.push(
      `外键不一致：${diff.foreignKeyDrift.map((d) => `${d.table} ${d.side === 'source' ? '源码独有' : '注册表独有'} ${d.fk}`).join('；')}`,
    )
  }
  if (diff.uniqueDrift.length) {
    problems.push(
      `唯一约束不一致：${diff.uniqueDrift.map((d) => `${d.table}(${d.unique}) ${d.side === 'source' ? '源码独有' : '注册表独有'}`).join('；')}`,
    )
  }
  if (diff.indexDrift.length) {
    problems.push(
      `索引不一致：${diff.indexDrift.map((d) => {
        if (d.side === 'source') return `${d.index} 源码独有（${d.name}）`
        if (d.side === 'registry') return `${d.index} 注册表独有（${d.name}）`
        if (d.side === 'uniqueness') return `${d.index} 唯一性与源码不符（${d.name}）`
        return `${d.index} 索引名不一致（源码 ${d.name} / 注册表 ${d.registry}）`
      }).join('；')}`,
    )
  }
  return problems
}

function readSourceText() {
  // src/ 到仓库根是三级；按本文件位置推导，不依赖当前工作目录。
  const srcPath = path.join(__dirname, '..', '..', '..', 'packages', 'db', 'src', 'index.ts')
  return fs.readFileSync(srcPath, 'utf8')
}

const IS_ENTRY = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

// CLI: node tools/migrate-pg/src/schema-map.js --check
if (IS_ENTRY && process.argv[2] === '--check') {
  const colCount = TABLES.reduce((s, t) => s + t.columns.length, 0)
  const indexCount = TABLES.reduce(
    (s, t) => s + t.indexes.length + t.uniques.filter((u) => !u.constraint).length,
    0,
  )
  let srcText
  try {
    srcText = readSourceText()
  } catch (err) {
    console.error(`无法读取源码结构核对文件：${err.message}。`)
    process.exit(2)
  }
  const diff = diffAgainstSource(srcText)
  if (!isDriftFree(diff)) {
    for (const line of describeDrift(diff)) console.error(line)
    process.exit(1)
  }
  console.log(`[schema] ok: ${TABLES.length} tables, ${colCount} columns, ${indexCount} indexes`)
  process.exit(0)
}
