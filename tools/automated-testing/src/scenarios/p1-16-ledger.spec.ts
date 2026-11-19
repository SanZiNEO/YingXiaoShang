import { test, expect } from '../fixtures/test.js'
import { queryRows } from '../client/db-probe.js'

/**
 * 依赖：IPC-31（agent.turns）、IPC-32（agent.ledger）、IPC-33（agent.retry）、SVC-20（账本/轮次投影高确定性）。
 *
 * 源码口径（apps/desktop/src/main/index.ts + packages/agent/src/recorder.ts）：
 * - agent.turns 入参 { sessionId, limit }，按会话隔离；行含 status、plan_json、record_json；
 * - agent.ledger 返回 { items, counts:{ summarized, pending, stale, failed } }，counts 与 items 状态一致；
 *   列表经 chat_sessions JOIN 按学生过滤，无会话归属的孤儿账本行不出现在 IPC 投影里；
 * - agent.retry 入参 { sourceId }（定位 ledger.source_id）：先重置 attempts=0 / status=pending / last_error=''，
 *   再触发处理；通道返回重试后的最新账本投影。本用例不等后台重试完成，不断言间接 LLM 链路。
 * seed 基线：turns 4 行（chat_mvfao3ns_w1g7v6 3 行、chat_mvfa87gk_5xm63j 1 行）；summary_ledger 原始 3 行全 pending。
 */

interface TurnRow {
  id: string
  session_id: string
  turn_id: string
  status: string
  plan_json: Record<string, unknown> | null
  record_json: Record<string, unknown> | null
}

interface LedgerItem {
  source_type: string
  source_id: string
  status: string
  attempts: number
  last_error: string
  [key: string]: unknown
}

interface LedgerStatus {
  items: LedgerItem[]
  counts: { summarized: number; pending: number; stale: number; failed: number }
}

const SESSION_WITH_3 = 'chat_mvfao3ns_w1g7v6'
const SESSION_WITH_1 = 'chat_mvfa87gk_5xm63j'
const LEDGER_STATUS_ENUM = ['summarized', 'pending', 'stale', 'failed']
const DEMO_STUDENT_ID = 'student_demo'

test('TC-P1-16 过程轮次/账本投影一致性与 pending 行重试受理', async ({ client, home }) => {
  // 轮次按会话隔离。
  const turnsMain = (await client.agentTurns(SESSION_WITH_3)) as unknown as TurnRow[]
  expect(turnsMain).toHaveLength(3)
  for (const row of turnsMain) {
    expect(typeof row.status).toBe('string')
    expect(row.status.length).toBeGreaterThan(0)
    expect(row.session_id).toBe(SESSION_WITH_3)
    const hasPlan = row.plan_json !== null && typeof row.plan_json === 'object'
    const hasRecord = row.record_json !== null && typeof row.record_json === 'object'
    expect(hasPlan || hasRecord).toBe(true)
  }

  const turnsOther = (await client.agentTurns(SESSION_WITH_1)) as unknown as TurnRow[]
  expect(turnsOther).toHaveLength(1)
  expect(turnsOther[0]?.session_id).toBe(SESSION_WITH_1)
  expect(turnsOther.every((row) => row.session_id !== SESSION_WITH_3)).toBe(true)

  // 账本投影：IPC 可见集与 DB JOIN 口径一致，counts 与 items 状态自洽。
  const ledger = (await client.agentLedger()) as LedgerStatus
  const dbJoined = queryRows<{ source_id: string; status: string }>(
    home.dbPath,
    `SELECT ledger.source_id, ledger.status FROM summary_ledger AS ledger
     JOIN chat_sessions AS session
       ON ledger.source_type='session' AND session.id=ledger.source_id
     WHERE session.student_id = ?`,
    DEMO_STUDENT_ID,
  )
  expect(ledger.items).toHaveLength(dbJoined.length)
  for (const count of [ledger.counts.summarized, ledger.counts.pending, ledger.counts.stale, ledger.counts.failed]) {
    expect(count).toBeGreaterThanOrEqual(0)
  }
  const pendingItems = ledger.items.filter((item) => item.status === 'pending')
  expect(ledger.counts.pending).toBe(pendingItems.length)
  const countSum = ledger.counts.summarized + ledger.counts.pending + ledger.counts.stale + ledger.counts.failed
  expect(countSum).toBe(ledger.items.length)

  // 对一条 pending 行发起 retry：通道本身不抛错，返回最新账本投影。
  const target = pendingItems[0]
  expect(target, 'seed 基线至少有一条 pending 账本行').toBeTruthy()
  const retried = (await client.agentRetry({ sourceId: target.source_id })) as LedgerStatus
  expect(Array.isArray(retried.items)).toBe(true)
  expect(retried.counts).toBeDefined()

  // 回读：目标行仍在；状态落在合法枚举；retry 受理后 attempts/last_error 已被重置。
  const after = (await client.agentLedger()) as LedgerStatus
  const targetAfter = after.items.find((item) => item.source_id === target.source_id)
  expect(targetAfter).toBeDefined()
  expect(LEDGER_STATUS_ENUM).toContain(targetAfter?.status)
  expect(targetAfter?.attempts).toBe(0)
  expect(targetAfter?.last_error).toBe('')

  // 重试后 counts 仍与 items 自洽；不等待后台处理完成，不断言间接 LLM 结果。
  const pendingAfter = after.items.filter((item) => item.status === 'pending')
  expect(after.counts.pending).toBe(pendingAfter.length)
  const sumAfter = after.counts.summarized + after.counts.pending + after.counts.stale + after.counts.failed
  expect(sumAfter).toBe(after.items.length)
})
