import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { hashPassword, verifyPassword } from './passwords.js'

export interface AuthStudent {
  student_id: string
  name: string
  cohort: string
  created_at: string
}

export interface AuthSession {
  studentId: string
  name: string
  cohort: string
  expiresAt: string
}

const DAY_MS = 24 * 60 * 60 * 1000

function now(): string {
  return new Date().toISOString()
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * The auth database is deliberately separate from learning.db: deleting学习数据
 * must not delete account credentials, and vice versa.
 */
export class AuthStore {
  private readonly db: DatabaseSync

  constructor(readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(`CREATE TABLE IF NOT EXISTS auth_students (
      student_id TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      cohort TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    ) STRICT`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (student_id) REFERENCES auth_students(student_id)
    ) STRICT`)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_auth_tokens_student ON auth_tokens(student_id)')
    try {
      chmodSync(dbPath, 0o600)
    } catch {
      // Windows: ACLs already inherit the user profile; chmod is best effort.
    }
  }

  upsertStudent(input: { studentId: string; password: string; name?: string; cohort?: string }): AuthStudent {
    const existing = this.getStudent(input.studentId)
    const createdAt = existing?.created_at ?? now()
    const passwordHash = hashPassword(input.password)
    this.db
      .prepare(`INSERT INTO auth_students (student_id, password_hash, name, cohort, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(student_id) DO UPDATE SET
          password_hash = excluded.password_hash,
          name = excluded.name,
          cohort = excluded.cohort`)
      .run(input.studentId, passwordHash, input.name ?? '', input.cohort ?? '', createdAt)
    return {
      student_id: input.studentId,
      name: input.name ?? '',
      cohort: input.cohort ?? '',
      created_at: createdAt,
    }
  }

  getStudent(studentId: string): AuthStudent | undefined {
    const row = this.db
      .prepare('SELECT student_id, name, cohort, created_at FROM auth_students WHERE student_id = ?')
      .get(studentId) as AuthStudent | undefined
    return row
  }

  verifyCredentials(studentId: string, password: string): AuthStudent | undefined {
    const row = this.db
      .prepare('SELECT student_id, password_hash, name, cohort, created_at FROM auth_students WHERE student_id = ?')
      .get(studentId) as (AuthStudent & { password_hash: string }) | undefined
    if (!row) return undefined
    if (!verifyPassword(password, row.password_hash)) return undefined
    return {
      student_id: row.student_id,
      name: row.name,
      cohort: row.cohort,
      created_at: row.created_at,
    }
  }

  issueToken(studentId: string, ttlDays: number): { token: string; expiresAt: string } {
    const token = randomBytes(32).toString('base64url')
    const createdAt = now()
    const expiresAt = new Date(Date.now() + ttlDays * DAY_MS).toISOString()
    this.db
      .prepare('INSERT INTO auth_tokens (token_hash, student_id, issued_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)')
      .run(tokenHash(token), studentId, createdAt, expiresAt, null)
    return { token, expiresAt }
  }

  verifyToken(token: string): AuthSession | undefined {
    const row = this.db
      .prepare(`SELECT t.token_hash, t.student_id, t.expires_at, t.revoked_at, s.name, s.cohort
        FROM auth_tokens t JOIN auth_students s ON s.student_id = t.student_id
        WHERE t.token_hash = ?`)
      .get(tokenHash(token)) as
      | { student_id: string; expires_at: string; revoked_at: string | null; name: string; cohort: string }
      | undefined
    if (!row) return undefined
    if (row.revoked_at !== null && row.revoked_at.length > 0) return undefined
    if (Date.parse(row.expires_at) <= Date.now()) return undefined
    return {
      studentId: row.student_id,
      name: row.name,
      cohort: row.cohort,
      expiresAt: row.expires_at,
    }
  }

  revokeToken(token: string): void {
    this.db
      .prepare('UPDATE auth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(now(), tokenHash(token))
  }

  close(): void {
    this.db.close()
  }
}
