import { test, expect } from '../fixtures/test.js'
import { queryRows, readCounts } from '../client/db-probe.js'

/**
 * 依赖：IPC-27（chat.sessions）、IPC-28（chat.messages）、DATA-04（表结构）、SVC-20（快照/消息投影）。
 * 不发起新对话：用 seed 自带会话验证读回口径与 DB 一致性。
 */
test('TC-P0-04 对话落库：会话/消息/轮次可回查', async ({ client, home }) => {
  const sessions = await client.sessions()
  const counts = readCounts(home.dbPath)
  expect(sessions.length).toBe(counts.sessions)
  expect(sessions.length).toBeGreaterThanOrEqual(2)

  const dbSessions = queryRows<{ id: string; title: string }>(
    home.dbPath,
    'select id, title from chat_sessions order by updated_at',
  )
  expect(sessions.map((session) => session.id).sort()).toEqual(dbSessions.map((row) => row.id).sort())

  let checkedMessages = 0
  for (const session of sessions) {
    const messages = await client.messages(session.id)
    const dbMessages = queryRows<{ seq: number; role: string; kind: string }>(
      home.dbPath,
      'select seq, role, kind from chat_messages where session_id = ? order by seq',
      session.id,
    )
    expect(messages.length).toBe(dbMessages.length)
    expect(messages.map((message) => message.seq)).toEqual(dbMessages.map((row) => row.seq))
    for (const message of messages) {
      expect(['user', 'assistant']).toContain(message.role)
      expect(['user_message', 'assistant_message', 'answer_submitted']).toContain(message.kind)
    }
    if (messages.length >= 2) {
      expect(messages.some((message) => message.role === 'user')).toBe(true)
      expect(messages.some((message) => message.role === 'assistant')).toBe(true)
    }
    checkedMessages += messages.length
  }
  expect(checkedMessages).toBe(counts.messages)

  // 轮次投影也必须能按会话读回，且状态是非空字符串。
  let checkedTurns = 0
  for (const session of sessions) {
    const turns = await client.invoke<Array<Record<string, unknown>>>('agent.turns', { sessionId: session.id })
    const dbTurns = queryRows<{ turn_id: string; status: string }>(
      home.dbPath,
      'select turn_id, status from turns where session_id = ? order by started_at',
      session.id,
    )
    expect(turns.length).toBe(dbTurns.length)
    for (const turn of turns) {
      expect(typeof turn.status).toBe('string')
      expect((turn.status as string).length).toBeGreaterThan(0)
      expect(typeof turn.session_id).toBe('string')
    }
    checkedTurns += turns.length
  }
  expect(checkedTurns).toBe(counts.turns)
})
