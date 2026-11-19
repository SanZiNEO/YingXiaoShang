import { test, expect } from '../fixtures/test.js'
import { resolve } from 'node:path'

/**
 * 依赖：UI-07/08/09（工作区/标签/产物分派）、FLOW-08（标签开合）、IPC-19/20（list/get）、
 * DATA-13a（产物目录）、SVC-16（产物读取与路径校验）。
 */
test('TC-P0-05 打开一个产物/文档标签', async ({ app, client, ui, home }) => {
  const artifacts = await client.artifactsList()
  expect(artifacts.length).toBe(4)
  for (const artifact of artifacts) {
    expect(typeof artifact.id).toBe('string')
    expect(typeof artifact.title).toBe('string')
    expect(['question_set', 'case_study', 'case_analysis']).toContain(artifact.type)
  }

  const questionSet = artifacts.find((artifact) => artifact.type === 'question_set')
  expect(questionSet, 'seed 库必须带一份题目集产物').toBeTruthy()
  const artifactId = questionSet?.id ?? ''

  const detail = await client.artifactGet(artifactId)
  expect(detail.id).toBe(artifactId)
  expect(detail.type).toBe('question_set')
  expect(detail.status).toBe('ready')
  expect(detail.format).toBe('docx')
  expect(detail.version).toBe(1)
  expect(detail.schema_version).toBe('QuestionSet@1')
  expect(detail.title.length).toBeGreaterThan(0)
  expect(detail.content_json).toBeTruthy()

  const artifactPath = resolve(detail.path)
  expect(artifactPath.toLowerCase().startsWith(resolve(home.home).toLowerCase())).toBe(true)
  expect(artifactPath.toLowerCase()).toContain(`${resolve(home.home, 'artifacts').toLowerCase()}`)

  // 题目集读取侧脱敏：只给题面与选项，不夹带答案段。
  expect(detail.content).toContain('不包含参考答案')
  expect(detail.content).not.toContain('参考答案：')
  expect(detail.content).not.toContain('解析：')

  await ui.openArtifact(artifactId)
  // 源码事实：产物标签 id 是 `artifact:<artifactId>`，不是裸产物 id。
  const tabId = `artifact:${artifactId}`
  await expect(app.page.locator(`[data-tab-id="${tabId}"]`)).toBeVisible()
  expect(await ui.tabIds()).toContain(tabId)

  const questionSetView = app.page.locator('[data-testid="question-set"]')
  await expect(questionSetView).toBeVisible()
  await expect(questionSetView).toHaveAttribute('data-submitted', 'false')
  await expect(questionSetView.locator('section[data-question-id]')).toHaveCount(20)
})
