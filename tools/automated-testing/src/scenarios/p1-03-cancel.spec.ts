import { test, expect } from '../fixtures/test.js'
import type { TurnResponse } from '../client/types.js'

/**
 * 依赖：FLOW-02（对话流程）、CH-02（取消）、EVT-01（流式事件）、LEG-01/LEG-02（取消语义与落库约束）。
 * 补充：CH-15（chat）、CH-16（cancel）、EVT-05（停止后不再产出）、SVC-12（取消语义）。
 */
test('TC-P1-03 取消进行中的回答', async ({ client, app }) => {
  const requestId = client.newRequestId('p1-cancel')
  const pending = client.chat({
    requestId,
    message: '请从 1 数到 200，每个数字单独一行，不要解释。',
  })

  let result: TurnResponse | Error | undefined
  const settled = pending.then(
    (value) => (result = value),
    (error: Error) => (result = error),
  )

  await client.events.waitFor(
    (event) => event.requestId === requestId && event.type === 'text' && (event.text ?? '').trim().length > 0,
    60000,
  )
  const cancelled = await client.cancel(requestId)
  expect(cancelled.cancelled).toBe(true)

  // 取消后事件流必须静默：不允许继续吐字，也不允许后台悄悄补完。
  const textBeforeQuiet = client.events.textOf(requestId).length
  await client.events.waitQuiet(requestId, 1800, 20000)
  expect(client.events.textOf(requestId).length).toBe(textBeforeQuiet)

  await settled
  expect(result).toBeInstanceOf(Error)
  // 源码事实：取消会 abort 在途 fetch，errors.ts 先把 aborted 归到“等太久”；
  // 只有 tool-loop 在两次模型调用之间观察到 signal 时才抛“已停止”。两种都是真实取消路径。
  expect((result as Error).message).toMatch(/已停止|等太久/)

  // 取消的一轮不能留下产物，也不能把半截回答当成结果落库。
  const artifacts = await client.artifactsList()
  expect(artifacts).toHaveLength(4)
  await expect(app.page.locator('[data-streaming="true"]')).toHaveCount(0)
})
