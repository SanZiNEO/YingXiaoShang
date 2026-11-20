import type LearningDb from '@learning-agent/db'
import type { Artifact, ChatSession, Evidence, MemoryFact } from '@learning-agent/shared'
import { ApiError } from './errors.js'

/** Frozen copy: one FORBIDDEN sentence for every ownership failure. */
const FORBIDDEN_MESSAGE = '这个资源不属于当前学号，换回自己的账号再试。'
/** Frozen copy: one NOT_FOUND sentence for every missing record. */
const NOT_FOUND_MESSAGE = '没有找到这条记录，可能已被删除。'

export function requireSession(db: LearningDb, sessionId: string, studentId: string): ChatSession {
  const session = db.getChatSession(sessionId)
  if (!session) throw new ApiError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE)
  if (session.student_id !== studentId) {
    throw new ApiError(403, 'FORBIDDEN', FORBIDDEN_MESSAGE)
  }
  return session
}

export function optionalSession(db: LearningDb, sessionId: string | undefined, studentId: string): ChatSession | undefined {
  if (sessionId === undefined || sessionId.length === 0) return undefined
  return requireSession(db, sessionId, studentId)
}

export function requireArtifact(db: LearningDb, artifactId: string, studentId: string): Artifact {
  const artifact = db.getArtifact(artifactId)
  if (!artifact) throw new ApiError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE)
  if (artifact.student_id !== studentId) {
    throw new ApiError(403, 'FORBIDDEN', FORBIDDEN_MESSAGE)
  }
  return artifact
}

/**
 * Evidence has no by-id getter in LearningDb. Looking it up through the student's
 * own list keeps the same non-enumerating 403 semantics as the contract asked.
 */
export function requireEvidence(db: LearningDb, evidenceId: string, studentId: string): Evidence {
  const evidence = db.listEvidence({ studentId, limit: 500 }).find((item) => item.id === evidenceId)
  if (!evidence) throw new ApiError(403, 'FORBIDDEN', FORBIDDEN_MESSAGE)
  return evidence
}

export function requireMemoryFact(db: LearningDb, factId: string, studentId: string): MemoryFact {
  const fact = db.listMemoryFacts(studentId).find((item) => item.id === factId)
  if (!fact) throw new ApiError(403, 'FORBIDDEN', FORBIDDEN_MESSAGE)
  return fact
}
