/**
 * 题目集的登记：把 artifacts 里的结构化题目落进 `questions` 表。
 *
 * 为什么必须有这一步：`question_attempts.question_id` 外键指向 `questions`，
 * 而判题（feedback 子代理）也是按 id 从表里取题。之前生成的题目只存在于
 * artifact 的 content_json 里，结果学生一交卷就报「题目数据缺失」——
 * 一道题也判不了（本机 question_attempts 长期为 0 行就是这个原因）。
 */
import { createHash } from 'node:crypto'
import { normalizeQuestionType, type Question, type QuestionType } from '@learning-agent/shared'

export interface ArtifactQuestionLike {
  id?: unknown
  type?: unknown
  stem?: unknown
  options?: unknown
  answer?: unknown
  explanation?: unknown
  kpIds?: unknown
  difficulty?: unknown
}

export interface NormalizedArtifactQuestion {
  id: string
  type: QuestionType
  stem: string
  options: string[]
  answer: string
  explanation: string
  kpIds: string[]
  difficulty: number
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function textList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item.length > 0)
    : []
}

/**
 * 题目 id 必须全局唯一（跨题目集也不能撞）。q1 / q2 这种本地编号在多份题目集里
 * 会重复，所以这里按「产物 id + 题干」算一个稳定 id；同一份题重复登记结果不变。
 */
export function globalQuestionId(artifactId: string, question: ArtifactQuestionLike, index: number): string {
  const stem = text(question.stem)
  const seed = stem.length > 0 ? `${artifactId}:${stem.replace(/\s+/g, '')}` : `${artifactId}:#${index + 1}`
  const digest = createHash('sha1').update(seed).digest('hex').slice(0, 12)
  return `q_${digest}`
}

export function normalizeArtifactQuestion(
  artifactId: string,
  question: ArtifactQuestionLike,
  index: number,
  kpIdOf?: (name: string) => string | undefined,
): NormalizedArtifactQuestion {
  const options = textList(question.options)
  const difficulty = Number(question.difficulty)
  const kpNames = textList(question.kpIds)
  const kpIds = kpNames
    .map((name) => (kpIdOf ? kpIdOf(name) : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  return {
    // 保留内容里的原题号（q1/q2）；需要全局化时由调用方决定。
    id: text(question.id) || globalQuestionId(artifactId, question, index),
    type: normalizeQuestionType(question.type, options.length > 0 ? '单选' : '简答'),
    stem: text(question.stem),
    options,
    answer: text(question.answer),
    explanation: text(question.explanation),
    kpIds,
    difficulty: Number.isFinite(difficulty) && difficulty >= 1 ? Math.min(3, Math.round(difficulty)) : 2,
  }
}

/** 登记结果：改写后的 questions（id 已全局化）与已落库的行。 */
export interface RegistryResult {
  questions: NormalizedArtifactQuestion[]
  rows: Question[]
}

export function toQuestionRows(input: {
  artifactId: string
  studentId: string
  chapterId: string
  questions: NormalizedArtifactQuestion[]
}): Question[] {
  return input.questions
    .filter((question) => question.stem.length > 0)
    .map((question) => ({
      id: question.id,
      // 生成的题目来自课程材料，来源类型统一记 kp；具体章节放在 source_id。
      source_type: 'kp' as const,
      source_id: input.chapterId || input.artifactId,
      type: question.type,
      stem: question.stem,
      options: question.options,
      answer: question.answer,
      explanation: question.explanation,
      difficulty: question.difficulty,
      kp_ids: question.kpIds,
      ideology_ids: [],
      status: 'draft' as const,
    }))
}

interface DbLike {
  getQuestion(id: string): { id: string; stem: string } | undefined
  insertQuestions(questions: Question[]): number
  listKpsByChapter(chapterId: string): Array<{ id: string; name: string }>
}

export interface RegisterInput {
  db: DbLike
  artifact: {
    id: string
    type: string
    content_json: unknown
  }
  chapterId?: string
  /**
   * 新产物用全局 id（跨题目集不撞）；老产物沿用内容里的 id（q1/q2），
   * 否则界面已经渲染的题目 id 会对不上、交卷被当成「不属于这份题目集」。
   */
  preferGlobalIds?: boolean
}

export interface RegisterOutput {
  contentJson: unknown
  registered: number
}

export function registerArtifactQuestions(input: RegisterInput): RegisterOutput {
  const content = input.artifact.content_json
  if (input.artifact.type !== 'question_set' || !content || typeof content !== 'object') {
    return { contentJson: content, registered: 0 }
  }
  const record = content as Record<string, unknown>
  const rawQuestions = Array.isArray(record.questions) ? record.questions : []
  if (rawQuestions.length === 0) return { contentJson: content, registered: 0 }

  const chapterId = input.chapterId ?? ''
  const kpByName = new Map(
    (chapterId ? input.db.listKpsByChapter(chapterId) : []).map((kp) => [kp.name.trim(), kp.id]),
  )

  const normalized = rawQuestions.map((item, index) =>
    normalizeArtifactQuestion(input.artifact.id, (item ?? {}) as ArtifactQuestionLike, index, (name) => kpByName.get(name)))

  // 同一个 id 已经属于别的题干（跨题目集撞号）时，改用全局 id。
  const final = normalized.map((question, index) => {
    const existing = input.db.getQuestion(question.id)
    const wantsGlobal = input.preferGlobalIds === true
    if (wantsGlobal || (existing && existing.stem.trim() !== question.stem.trim())) {
      return { ...question, id: globalQuestionId(input.artifact.id, rawQuestions[index] as ArtifactQuestionLike, index) }
    }
    if (existing && existing.stem.trim() === question.stem.trim()) {
      return { ...question, id: question.id }
    }
    return question
  })

  const rows = toQuestionRows({
    artifactId: input.artifact.id,
    studentId: '',
    chapterId,
    questions: final,
  })
  input.db.insertQuestions(rows)

  const rewritten = rawQuestions.map((item, index) => {
    const question = (item ?? {}) as Record<string, unknown>
    const target = final[index]!
    return {
      ...question,
      id: target.id,
      type: target.type,
      stem: target.stem,
      options: target.options,
      answer: target.answer,
      explanation: target.explanation,
      kpIds: target.kpIds.length > 0 ? target.kpIds : (question.kpIds ?? []),
      difficulty: target.difficulty,
    }
  })

  return {
    contentJson: { ...record, questions: rewritten },
    registered: rows.length,
  }
}
