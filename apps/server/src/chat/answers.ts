import type { IncomingMessage, ServerResponse } from 'node:http'
import { ApiError, friendlyError } from '../errors.js'
import { readJson } from '../http/read-json.js'
import { sendOk } from '../http/respond.js'
import { requireStudent } from '../auth/bearer.js'
import { withStudent } from '../llm/metered.js'
import type { Services } from '../services.js'

interface AnswerMeta {
  requestId: string
  startedAt: number
}

function requiredString(body: Record<string, unknown>, key: string, message: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', message, key)
  }
  return value.trim()
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ApiError(400, 'BAD_REQUEST', `${key} 必须是字符串。`, key)
  return value.trim()
}

/** Wrap a runtime failure in the answer-domain Chinese copy (retry hint included). */
function failAnswer(error: unknown): never {
  const friendly = friendlyError(error, { context: 'answer' })
  throw new ApiError(400, 'BAD_REQUEST', friendly.message, undefined, 'answer')
}

/** `POST /api/v1/answer`: grade one question. */
export async function handleAnswer(
  req: IncomingMessage,
  res: ServerResponse,
  services: Services,
  meta: AnswerMeta,
): Promise<void> {
  const student = requireStudent(req, services.auth)
  const body = await readJson(req)

  const sessionId = requiredString(body, 'sessionId', 'sessionId 不能为空。')
  const questionId = requiredString(body, 'questionId', 'questionId 不能为空。')
  const answer = requiredString(body, 'answer', 'answer 不能为空。')
  const artifactId = optionalString(body, 'artifactId')
  const chapterId = optionalString(body, 'chapterId')

  try {
    const result = await withStudent(student.studentId, () => services.agent.answerQuestion({
      studentId: student.studentId,
      sessionId,
      questionId,
      answer,
      artifactId,
      chapterId,
    }))
    sendOk(res, result, meta)
  } catch (error) {
    failAnswer(error)
  }
}

/** `POST /api/v1/answer-set`: submit a whole question set for grading. */
export async function handleAnswerSet(
  req: IncomingMessage,
  res: ServerResponse,
  services: Services,
  meta: AnswerMeta,
): Promise<void> {
  const student = requireStudent(req, services.auth)
  const body = await readJson(req)

  const sessionId = requiredString(body, 'sessionId', 'sessionId 不能为空。')
  const artifactId = requiredString(body, 'artifactId', 'artifactId 不能为空。')
  const chapterId = optionalString(body, 'chapterId')

  const answersRaw = body.answers
  if (!Array.isArray(answersRaw) || answersRaw.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', '这一卷还没有作答，先答一题再交。', 'answers')
  }
  const answers = answersRaw.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new ApiError(400, 'BAD_REQUEST', `第 ${index + 1} 题格式无效，没有写入任何答题记录。`, 'answers')
    }
    const record = item as Record<string, unknown>
    const questionId = record.questionId
    const answer = record.answer
    if (
      typeof questionId !== 'string' || questionId.trim().length === 0
      || typeof answer !== 'string' || answer.trim().length === 0
    ) {
      throw new ApiError(400, 'BAD_REQUEST', `第 ${index + 1} 题格式无效，没有写入任何答题记录。`, 'answers')
    }
    return { questionId: questionId.trim(), answer: answer.trim() }
  })

  try {
    const result = await withStudent(student.studentId, () => services.agent.answerQuestionSet({
      studentId: student.studentId,
      sessionId,
      artifactId,
      chapterId,
      answers,
    }))
    sendOk(res, result, meta)
  } catch (error) {
    failAnswer(error)
  }
}
