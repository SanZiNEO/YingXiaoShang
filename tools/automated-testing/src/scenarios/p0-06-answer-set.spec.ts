import { test, expect } from '../fixtures/test.js'
import { queryRows } from '../client/db-probe.js'

/**
 * 依赖：FLOW-03（作答/交卷/重试）、UI-10（题目集渲染）、CH-05（answer-set）、
 * IPC-13（questions.attempts）、SVC-21（答题输出结构）、LEG-08（attempts 落库）。
 * 判分走 FeedbackAgent 规则链，不依赖模型。
 */
test('TC-P0-06 一次答题/交卷并回读判分记录', async ({ app, client, ui, home }) => {
  const artifacts = await client.artifactsList()
  const questionSet = artifacts.find((artifact) => artifact.type === 'question_set')
  expect(questionSet, 'seed 库必须带一份题目集产物').toBeTruthy()
  expect((questionSet?.session_id ?? '').length).toBeGreaterThan(0)

  // 交卷需要 renderer 处于该题目集所属会话内，否则 handleAnswerSet 会直接返回 failed。
  await ui.openSession(questionSet?.session_id ?? '')
  await expect(app.page.locator('[data-message-role]').first()).toBeVisible()

  await ui.openArtifact(questionSet?.id ?? '')
  const set = app.page.locator('[data-testid="question-set"]')
  await expect(set).toBeVisible()
  await expect(set).toHaveAttribute('data-submitted', 'false')
  const sections = set.locator('section[data-question-id]')
  await expect(sections).toHaveCount(20)

  const answers = await ui.answerAllQuestions()
  expect(answers).toHaveLength(20)
  expect(answers.every((answer) => answer.questionId.length > 0 && answer.answer.length > 0)).toBe(true)

  const submit = app.page.locator('[data-testid="question-submit"]')
  await expect(submit).toBeEnabled()
  await ui.submitQuestions()
  await expect(set).toHaveAttribute('data-submitted', 'true', { timeout: 120000 })

  // UI 逐题展示判分结果（答对/答错标签），且所有作答入口锁定。
  await expect(sections.filter({ hasText: /答对|答错/ })).toHaveCount(20)
  await expect(sections.locator('[data-testid="answer-option"]:not([disabled])')).toHaveCount(0)

  const expectedIds = queryRows<{ id: string }>(
    home.dbPath,
    `select id from questions where id in (${answers.map(() => '?').join(',')}) order by id`,
    ...answers.map((answer) => answer.questionId),
  ).map((row) => row.id)
  expect(expectedIds).toHaveLength(20)

  const attempts = queryRows<{ question_id: string; score: number; feedback_json: string }>(
    home.dbPath,
    'select question_id, score, feedback_json from question_attempts order by created_at',
  )
  expect(attempts).toHaveLength(20)
  expect(attempts.map((attempt) => attempt.question_id).sort()).toEqual(expectedIds.sort())
  for (const attempt of attempts) {
    expect(attempt.score).toBeGreaterThanOrEqual(0)
    expect(attempt.score).toBeLessThanOrEqual(1)
    const feedback = JSON.parse(attempt.feedback_json) as Record<string, unknown>
    // 判分结果落在 feedback_json（表结构没有独立 correct 列）。
    expect(typeof feedback.correct).toBe('boolean')
    expect(typeof feedback.score).toBe('number')
    expect(Number(feedback.score)).toBeCloseTo(Number(attempt.score), 6)
  }

  const readBack = await client.invoke<Array<Record<string, unknown>>>('questions.attempts', {
    questionIds: answers.map((answer) => answer.questionId),
    limit: 100,
  })
  expect(readBack).toHaveLength(20)
  expect(readBack.every((row) => typeof row.score === 'number')).toBe(true)

  // 已完成的交卷再次调用会返回缓存输出，不重复记分；用它核对 AnswerSetResponse 结构。
  const result = await client.answerSet({
    studentId: 'student_demo',
    sessionId: questionSet?.session_id ?? '',
    artifactId: questionSet?.id ?? '',
    answers,
  })
  expect(['completed', 'partial', 'failed']).toContain(result.status)
  expect(result.status).toBe('completed')
  expect(result.turnId.length).toBeGreaterThan(0)
  expect(result.text.length).toBeGreaterThan(0)
  expect(Array.isArray(result.results)).toBe(true)
  expect(result.results).toHaveLength(20)
  for (const item of result.results as Array<Record<string, unknown>>) {
    expect(typeof item.questionId).toBe('string')
    expect(typeof item.score).toBe('number')
  }
})
