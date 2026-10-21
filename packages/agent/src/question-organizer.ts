import type { Context } from '@deepseek-ai/cordis'
import type { Question } from '@learning-agent/shared'
import { stableId } from '@learning-agent/shared'
import type {} from '@learning-agent/db'

export interface OrganizeResult {
  inserted: number
  skipped: number
}

function normalizeStem(value: string): string {
  return value
    .toLowerCase()
    .replace(/[（(]情境\s*\d+[）)]/g, '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。！？；：、,.!?;:'"“”‘’（）()【】\[\]《》<>—\-_/\\]/g, '')
}

/**
 * Non-speaking organizer: dedupe generated questions into the reusable bank.
 * It never creates an artifact and never talks to the student.
 */
export class QuestionOrganizer {
  constructor(private readonly ctx: Context) {}

  organize(questions: Question[], chapterId: string, source: string): OrganizeResult {
    let inserted = 0
    let skipped = 0
    const now = new Date().toISOString()
    for (const question of questions) {
      if (question.stem.trim().length === 0) {
        skipped += 1
        continue
      }
      const stemHash = stableId('qh', normalizeStem(question.stem))
      if (this.ctx.learningDb.getQuestionBankByHash(stemHash)) {
        skipped += 1
        continue
      }
      const ok = this.ctx.learningDb.insertQuestionBank({
        question_id: question.id,
        stem_hash: stemHash,
        stem: question.stem,
        chapter_id: chapterId,
        kp_ids: question.kp_ids,
        type: question.type,
        difficulty: question.difficulty,
        source,
        usage_count: 0,
        created_at: now,
        last_used_at: now,
      })
      if (ok) inserted += 1
      else skipped += 1
    }
    return { inserted, skipped }
  }
}
