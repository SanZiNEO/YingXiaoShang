import { test, expect } from '../fixtures/test.js'

/**
 * 依赖：WIN-01（最小尺寸）、UI-01（根三栏）、CH-01（invoke 通道）、IPC-01（student.current）、DATA-14a（seed fixture）。
 */
test('TC-P0-02 首窗出现、preload 桥与学生身份可用', async ({ app, client, ui }) => {
  expect(app.health.ok).toBe(true)

  const keys = await ui.bridgeKeys()
  expect(keys.sort()).toEqual(
    ['answer', 'answerSet', 'cancel', 'capabilities', 'chat', 'health', 'invoke', 'onChatEvent', 'settings'].sort(),
  )

  const capabilities = await app.page.evaluate(() => {
    const api = (window as unknown as { learning: { capabilities: Record<string, unknown> } }).learning
    return api.capabilities
  })
  expect(typeof capabilities.localFiles).toBe('boolean')
  expect(typeof capabilities.revealFiles).toBe('boolean')
  expect(capabilities.downloadArtifacts).toBe('desktop')
  // env.d.ts 里的 downloadArtifact 没有暴露，不能误断言。
  expect(keys.includes('downloadArtifact')).toBe(false)

  const student = await client.studentCurrent()
  expect(student.studentId).toBe('student_demo')
  expect(typeof student.name).toBe('string')
  expect(student.name.length).toBeGreaterThan(0)
  expect(typeof student.cohort).toBe('string')

  const layout = await app.page.evaluate(() => ({
    asides: document.querySelectorAll('aside').length,
    mains: document.querySelectorAll('main').length,
    composer: document.querySelectorAll('[data-testid="composer-input"]').length,
  }))
  expect(layout.asides).toBeGreaterThanOrEqual(1)
  expect(layout.mains).toBe(1)
  expect(layout.composer).toBe(1)

  const minimum = await app.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return window ? window.getMinimumSize() : []
  })
  expect(minimum).toEqual([760, 560])

  const windows = await app.windows()
  expect(windows).toHaveLength(1)
  expect(windows[0]?.title).toContain('营小商')
  expect(app.page.url()).toContain('/out/renderer/index.html')
})
