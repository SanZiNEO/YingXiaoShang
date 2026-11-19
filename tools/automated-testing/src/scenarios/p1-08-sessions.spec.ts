import { test, expect } from '../fixtures/test.js'

/**
 * 依赖：FLOW-06（会话新建 / 历史切换）、IPC-27（chat.sessions）、IPC-34（agent.sessions 摘要）、SVC-20（会话投影高确定性）。
 *
 * seed 基线：chat_sessions 2 行；chat_mvfao3ns_w1g7v6 6 条消息，chat_mvfa87gk_5xm63j 2 条。
 * 断言口径：会话列表结构、消息按会话隔离、新对话清空消息区与标签；不断言会话标题文案。
 * 等待只走 IPC resolve / DOM 状态轮询，不使用固定等待。
 */
test('TC-P1-08 会话新建与历史切换', async ({ client, ui }) => {
  // 1. IPC 会话列表：2 条，且每条含 id / title / updated_at。
  const sessions = await client.sessions()
  expect(sessions).toHaveLength(2)
  for (const session of sessions) {
    expect(typeof session.id).toBe('string')
    expect(session.id.length).toBeGreaterThan(0)
    expect(typeof session.title).toBe('string')
    expect(typeof session.updated_at).toBe('string')
    expect(session.updated_at.length).toBeGreaterThan(0)
  }

  // IPC-34：摘要接口可调用（运行时可能回落空列表，不断言摘要文案）。
  const summaries = await client.invoke<Array<Record<string, unknown>>>('agent.sessions')
  expect(Array.isArray(summaries)).toBe(true)

  const targetId = 'chat_mvfao3ns_w1g7v6'
  const otherId = 'chat_mvfa87gk_5xm63j'
  const targetMessages = await client.messages(targetId)
  const otherMessages = await client.messages(otherId)
  // 两条会话消息数不同，后续隔离断言才有对照意义。
  expect(targetMessages).toHaveLength(6)
  expect(otherMessages).toHaveLength(2)
  expect(otherMessages.length).not.toBe(targetMessages.length)

  // 2. 切到 6 条消息的会话：DOM 消息条数与 IPC 按会话读回的条数一致。
  await ui.openSession(targetId)
  await expect
    .poll(async () => (await ui.messages()).length, { timeout: 15_000 })
    .toBe(targetMessages.length)
  const domAfterOpen = await ui.messages()
  expect(domAfterOpen).toHaveLength(targetMessages.length)

  // 3. 新对话：消息区清空（messageNodes 计数 0），会话列表仍是 2 条，标签被清空。
  await ui.startNewChat()
  await expect.poll(async () => ui.messageNodes.count(), { timeout: 15_000 }).toBe(0)
  expect(await ui.sessionIds()).toHaveLength(2)
  expect(await ui.tabIds()).toHaveLength(0)

  // 4. 再切回历史会话：消息恢复，条数与 IPC 一致（按会话隔离，不带入新对话空态）。
  await ui.openSession(targetId)
  await expect
    .poll(async () => (await ui.messages()).length, { timeout: 15_000 })
    .toBe(targetMessages.length)
  const domAfterRestore = await ui.messages()
  expect(domAfterRestore).toHaveLength(targetMessages.length)

  // 对照会话的 IPC 条数未被本次切换污染。
  expect((await client.messages(otherId))).toHaveLength(otherMessages.length)
})
