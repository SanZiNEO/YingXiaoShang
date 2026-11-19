import { test, expect } from '../fixtures/test.js'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { emptyQuestionSetAction } from '../../../../apps/desktop/src/renderer/src/question-set.js'

/**
 * 依赖：UI-12（题目集渲染）、SVC-25（题目集内容重建）、LEG-03（渲染前判定纯函数）。
 * 说明：服务层 artifacts.get 对空题集总会返回非空兜底文案，所以 UI 走 MarkdownView；
 * retry 分支用纯函数直接断言，避免把不可达 UI 当成已覆盖。
 */
test('TC-P1-02 空题目集不出现死胡同', async ({ app, client, ui, home }) => {
  expect(emptyQuestionSetAction({ content: '有内容' })).toBe('markdown')
  expect(emptyQuestionSetAction({ content: '   ' })).toBe('retry')

  const artifactId = 'art_p1_empty_1'
  const db = new DatabaseSync(home.dbPath)
  try {
    db.prepare(`INSERT INTO artifacts (
      id, student_id, session_id, skill_id, template_id, type, title, format,
      path, content, evidence_ids_json, created_at,
      content_json, schema_version, version, status, source_refs_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      artifactId,
      'student_demo',
      'chat_mvfao3ns_w1g7v6',
      'agent.team',
      'question_set',
      'question_set',
      '空题目集',
      'md',
      join(home.home, 'artifacts', 'student_demo', '2026-11', `${artifactId}.md`),
      '',
      '[]',
      '2026-11-19T00:00:00.000Z',
      JSON.stringify({ intro: '', questions: [] }),
      'v1',
      1,
      'draft',
      '[]',
    )
  } finally {
    db.close()
  }

  const artifact = await client.artifactGet(artifactId)
  expect(artifact.type).toBe('question_set')
  expect(artifact.content).toContain('题目集暂时无法预览')
  expect(artifact.content).toContain('参考答案仅在交卷后显示')

  // 产物是在应用启动后直接写入库的，渲染层内存里的产物列表不会自动刷新；
  // reload 让 renderer 重新从主进程取一次列表，模拟真实的“重新打开工作区”。
  await app.page.reload()
  await ui.waitReady()
  await ui.ensureWorkspace()
  await ui.openArtifact(artifactId)
  await expect(app.page.locator('[data-tab-id="artifact:' + artifactId + '"]')).toBeVisible()

  // 空题集不能把页面打崩；当前实现以 MarkdownView 展示兜底说明。
  await expect(app.page.getByText('题目集暂时无法预览').first()).toBeVisible()
  await expect(app.page.locator('[data-testid="question-set"]')).toHaveCount(0)
  await expect(app.page.locator('[data-testid="question-submit"]')).toHaveCount(0)
})
