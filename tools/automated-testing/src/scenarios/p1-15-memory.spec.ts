import { test, expect } from '../fixtures/test.js'

/**
 * 依赖：IPC-22（memory.facts）、IPC-25（memory.upsert）、IPC-26（memory.delete）、SVC-14（记忆增删高确定性）。
 *
 * 源码口径（apps/desktop/src/main/index.ts memory.upsert/delete）：
 * - kind 仅认 goal/preference/constraint/background/self_assessment/open_question，非法值归一为 'goal'；
 * - 同一 studentId + kind + key 走 upsert 覆盖，不新增行；返回落库后的完整记录（含 id/updated_at/value）；
 * - memory.delete 入参 factId；ID 为空或不存在时 DELETE 0 行，不抛错，返回 { ok: true }；
 * - 列表回读的 value 是反序列化后的 JSON 对象。
 * seed 基线：memory_facts 10 行，全部归属 student_demo。
 */

interface MemoryFactRow {
  id: string
  student_id: string
  kind: string
  key: string
  value: unknown
  confidence: number
  source: string
  updated_at: string
}

const PROBE_KEY = 'p1-autotest-key'
const KIND_PROBE_KEY = 'p1-autotest-kind'

test('TC-P1-15 记忆事实 upsert/delete 往返与非法 kind 归一', async ({ client }) => {
  const before = await client.memoryFacts()
  expect(before).toHaveLength(10)

  // 首次写入：返回完整记录，value 是对象而非字符串。
  const first = (await client.memoryUpsert({
    kind: 'goal',
    key: PROBE_KEY,
    value: { level: 'ok', n: 1 },
  })) as unknown as MemoryFactRow
  expect(typeof first.id).toBe('string')
  expect(first.id.length).toBeGreaterThan(0)
  expect(typeof first.updated_at).toBe('string')
  expect(first.updated_at.length).toBeGreaterThan(0)
  expect(first.kind).toBe('goal')
  expect(typeof first.value).toBe('object')
  expect(Array.isArray(first.value)).toBe(false)
  expect((first.value as { n: number }).n).toBe(1)

  let afterFirst = await client.memoryFacts()
  expect(afterFirst).toHaveLength(11)
  const firstRow = afterFirst.find((fact) => fact.key === PROBE_KEY)
  expect(firstRow?.id).toBe(first.id)

  // 同 key 二次 upsert：id 不变、条数不增、value 被覆盖。
  const second = (await client.memoryUpsert({
    kind: 'goal',
    key: PROBE_KEY,
    value: { level: 'ok', n: 2 },
  })) as unknown as MemoryFactRow
  expect(second.id).toBe(first.id)

  const afterSecond = await client.memoryFacts()
  expect(afterSecond).toHaveLength(11)
  const secondRow = afterSecond.find((fact) => fact.key === PROBE_KEY)
  expect(secondRow?.id).toBe(first.id)
  expect((secondRow?.value as { n: number }).n).toBe(2)

  // 非法 kind：归一为 goal，不落到枚举外取值域。
  const kindProbe = (await client.memoryUpsert({
    kind: 'not-a-kind',
    key: KIND_PROBE_KEY,
    value: { probe: true },
  })) as unknown as MemoryFactRow
  expect(kindProbe.kind).toBe('goal')

  const afterKind = await client.memoryFacts()
  expect(afterKind).toHaveLength(12)

  // 删除目标 id：回读列表不再含该 id。
  await client.memoryDelete(first.id)
  const afterDelete = await client.memoryFacts()
  expect(afterDelete.some((fact) => fact.id === first.id)).toBe(false)
  expect(afterDelete).toHaveLength(11)

  // 不存在 id：不抛错，返回 { ok: true }。
  const missing = await client.memoryDelete('fact-does-not-exist')
  expect(missing).toEqual({ ok: true })

  // 清理 kind 探针，基线回到 10 条。
  await client.memoryDelete(kindProbe.id)
  const final = await client.memoryFacts()
  expect(final).toHaveLength(10)
  expect(final.some((fact) => fact.key === PROBE_KEY || fact.key === KIND_PROBE_KEY)).toBe(false)
})
