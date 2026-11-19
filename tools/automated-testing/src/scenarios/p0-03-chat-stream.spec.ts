import { test, expect } from '../fixtures/test.js'

/**
 * 依赖：FLOW-01（发送）、FLOW-02（流式/取消）、CH-03（chat）、CH-09（事件推送）、
 * EVT-01（session）、EVT-03（text）、SVC-21（输出结构）。真实模型，不做文案断言。
 */
test('TC-P0-03 一轮完整对话：流式事件序列 + chat resolve', async ({ app, client, ui }) => {
  client.events.clear()

  await ui.sendMessage('用一句话解释消费者市场和组织市场的区别。')

  // 先等流式气泡真的出现，再等它收口；只等消息数增加会把“用户消息已落库、模型还没回”误判成完成。
  const streaming = app.page.locator('[data-streaming="true"]')
  await expect(streaming.first()).toBeVisible({ timeout: 60000 })
  await expect(streaming).toHaveCount(0, { timeout: 120000 })

  const uiMessages = await ui.messages()
  const assistantBubbles = uiMessages.filter((message) => message.role === 'assistant')
  expect(assistantBubbles.length).toBeGreaterThan(0)
  expect(assistantBubbles.some((message) => message.text.trim().length > 0)).toBe(true)

  const collected = client.events.events.map((item) => item.event)
  const sessionEvent = collected.find((event) => event.type === 'session')
  expect(sessionEvent, '必须收到 session 事件').toBeTruthy()
  expect(typeof sessionEvent?.sessionId).toBe('string')
  expect((sessionEvent?.sessionId ?? '').length).toBeGreaterThan(0)
  expect(sessionEvent?.requestId.length).toBeGreaterThan(0)

  const textEvents = collected.filter((event) => event.type === 'text' && event.agent === 'lead')
  expect(textEvents.length).toBeGreaterThan(0)
  expect(textEvents.map((event) => event.text ?? '').join('').trim().length).toBeGreaterThan(0)

  const sessionId = sessionEvent?.sessionId ?? ''
  const sessions = await client.sessions()
  expect(sessions.some((session) => session.id === sessionId)).toBe(true)

  const messages = await client.messages(sessionId)
  expect(messages.length).toBeGreaterThanOrEqual(2)
  expect(messages.some((message) => message.role === 'user')).toBe(true)
  expect(messages.some((message) => message.role === 'assistant')).toBe(true)
  expect(messages.every((message, index) => index === 0 || message.seq > (messages[index - 1]?.seq ?? 0))).toBe(true)

  const assistantMessage = messages.find((message) => message.role === 'assistant')
  expect(assistantMessage?.kind).toBe('assistant_message')

  // 直接走 chat 通道拿一次完整 resolve 结构；提示固定为最短输出，避免依赖模型文案。
  client.events.clear()
  const requestId = client.newRequestId('p0-03')
  const turn = await client.chat({ message: '只回复两个字：收到。', requestId })
  for (const key of [
    'sessionId',
    'turnId',
    'text',
    'artifacts',
    'citations',
    'plan',
    'asks',
    'evidence',
    'ledger',
    'snapshot',
    'warnings',
  ]) {
    expect(Object.keys(turn)).toContain(key)
  }
  expect(turn.sessionId.length).toBeGreaterThan(0)
  expect(turn.turnId.length).toBeGreaterThan(0)
  expect(turn.text.length).toBeGreaterThan(0)
  expect(Array.isArray(turn.artifacts)).toBe(true)
  expect(Array.isArray(turn.citations)).toBe(true)
  expect(Array.isArray(turn.asks)).toBe(true)
  expect(Array.isArray(turn.warnings)).toBe(true)

  const turnEvents = client.events.forRequest(requestId).map((item) => item.event)
  expect(turnEvents.some((event) => event.type === 'session')).toBe(true)
  expect(turnEvents.some((event) => event.type === 'text' && (event.text ?? '').length > 0)).toBe(true)
  for (const citation of turn.citations) {
    expect(typeof citation.sourceId).toBe('string')
    expect(citation.sourceId.length).toBeGreaterThan(0)
    expect(['kp', 'textbook', 'resource', 'news']).toContain(citation.sourceType)
  }
})
