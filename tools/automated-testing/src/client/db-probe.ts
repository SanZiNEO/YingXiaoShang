import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'

export interface DbCounts {
  chapters: number
  knowledgePoints: number
  newsArticles: number
  artifacts: number
  questions: number
  attempts: number
  evidence: number
  ledger: number
  sessions: number
  messages: number
  turns: number
}

const COUNT_SQL: Record<keyof DbCounts, string> = {
  chapters: 'select count(*) as c from chapters',
  knowledgePoints: 'select count(*) as c from knowledge_points',
  newsArticles: 'select count(*) as c from news_articles',
  artifacts: 'select count(*) as c from artifacts',
  questions: 'select count(*) as c from questions',
  attempts: 'select count(*) as c from question_attempts',
  evidence: 'select count(*) as c from evidence',
  ledger: 'select count(*) as c from summary_ledger',
  sessions: 'select count(*) as c from chat_sessions',
  messages: 'select count(*) as c from chat_messages',
  turns: 'select count(*) as c from turns',
}

function openReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

export function queryRows<T = Record<string, unknown>>(path: string, sql: string, ...params: unknown[]): T[] {
  if (!existsSync(path)) throw new Error(`数据库不存在：${path}`)
  const db = openReadOnly(path)
  try {
    return db.prepare(sql).all(...(params as never[])) as T[]
  } finally {
    db.close()
  }
}

export function pragma(path: string, name: 'user_version' | 'application_id'): number {
  if (!existsSync(path)) throw new Error(`数据库不存在：${path}`)
  const db = openReadOnly(path)
  try {
    const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined
    const value = row ? Object.values(row)[0] : undefined
    return typeof value === 'number' ? value : Number(value ?? -1)
  } finally {
    db.close()
  }
}

export function readCounts(path: string): DbCounts {
  if (!existsSync(path)) throw new Error(`数据库不存在：${path}`)
  const db = openReadOnly(path)
  try {
    const counts = {} as DbCounts
    for (const [key, sql] of Object.entries(COUNT_SQL) as Array<[keyof DbCounts, string]>) {
      const row = db.prepare(sql).get() as { c?: number } | undefined
      counts[key] = Number(row?.c ?? 0)
    }
    return counts
  } finally {
    db.close()
  }
}

export interface DbFileInfo {
  exists: boolean
  size: number
  walSize: number
  shmSize: number
}

export function fileInfo(path: string): DbFileInfo {
  const stat = (suffix: string): number => {
    const file = `${path}${suffix}`
    return existsSync(file) ? statSync(file).size : 0
  }
  return {
    exists: existsSync(path),
    size: stat(''),
    walSize: stat('-wal'),
    shmSize: stat('-shm'),
  }
}

export interface DbSnapshot {
  path: string
  file: DbFileInfo
  userVersion: number
  applicationId: number
  counts: DbCounts
  artifacts: Array<Record<string, unknown>>
  sessions: Array<Record<string, unknown>>
  ledger: Array<Record<string, unknown>>
}

export function snapshot(path: string): DbSnapshot {
  return {
    path,
    file: fileInfo(path),
    userVersion: pragma(path, 'user_version'),
    applicationId: pragma(path, 'application_id'),
    counts: readCounts(path),
    artifacts: queryRows(
      path,
      'select id, type, title, format, status, version, created_at from artifacts order by created_at',
    ),
    sessions: queryRows(path, 'select id, title, chapter_id, updated_at from chat_sessions order by updated_at'),
    ledger: queryRows(
      path,
      'select source_type, source_id, status, attempts, summarized_seq, updated_at from summary_ledger order by updated_at',
    ),
  }
}
