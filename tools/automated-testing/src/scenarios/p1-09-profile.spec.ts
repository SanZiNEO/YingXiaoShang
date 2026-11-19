import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/test.js'
import { queryRows } from '../client/db-probe.js'

/**
 * 依赖：FLOW-07（档案证据复核与快照）、UI-04（学习档案视图）、IPC-14（profile.get）、
 *       IPC-16（profile.evidence）、IPC-17（profile.snapshot）、IPC-18（profile.review）、SVC-14（画像/快照高确定性）。
 *
 * seed 基线：evidence 9 行、growth_snapshots 8 行（pre/post 各 4）、user_version=7。
 * 注意（代码口径）：合成证据（ev_demo_ 前缀 / metadata.synthetic）在 profile.evidence 与档案视图中被过滤，
 * 复核写路径用 DB 回读校验；不存在的 evidenceId 按 IPC-18 行为约束仍返回 { ok: true }。
 * 不断言成长等级文案。等待只走 IPC resolve / DB 回读，不使用固定等待。
 */
test('TC-P1-09 档案证据复核与前后测快照', async ({ client, ui, home }, testInfo) => {
  // 1. IPC 证据列表：结构字段齐全（id / student_id / competency_id）。
  const evidenceList = await client.profileEvidence()
  expect(Array.isArray(evidenceList)).toBe(true)
  for (const item of evidenceList) {
    expect(typeof item.id).toBe('string')
    expect(item.id.length).toBeGreaterThan(0)
    expect(typeof item.student_id).toBe('string')
    expect(item.student_id.length).toBeGreaterThan(0)
    expect(typeof item.competency_id).toBe('string')
    expect(item.competency_id.length).toBeGreaterThan(0)
  }

  // 2. 打开档案视图：DOM 证据条目必须是 IPC 列表的子集。
  await ui.openProfile()
  const domEvidenceIds = await ui.evidenceIds()
  const ipcEvidenceIds = new Set(evidenceList.map((item) => item.id))
  for (const domId of domEvidenceIds) {
    expect(ipcEvidenceIds.has(domId), `DOM 证据 ${domId} 必须出现在 IPC 列表中`).toBe(true)
  }

  // 3. 复核写路径：优先取 IPC 列表条目；seed 合成证据被过滤时回查 DB 行定位可复核记录。
  const dbEvidenceRows = queryRows<{ id: string; review_status: string }>(
    home.dbPath,
    'select id, review_status from evidence order by occurred_at',
  )
  const reviewTarget: string | undefined =
    evidenceList[0]?.id ?? dbEvidenceRows[0]?.id
  expect(reviewTarget, '至少存在一条可复核证据（IPC 或 DB）').toBeTruthy()

  const reviewed = await client.profileReview(reviewTarget!, 'reviewed', '自动化复核')
  expect(reviewed.ok).toBe(true)
  let readback = queryRows<{ review_status: string; review_note: string }>(
    home.dbPath,
    'select review_status, review_note from evidence where id = ?',
    reviewTarget,
  )
  expect(readback).toHaveLength(1)
  expect(readback[0]?.review_status).toBe('reviewed')
  expect(readback[0]?.review_note).toBe('自动化复核')

  // 再次复核为 rejected：状态必须可被覆盖。
  const rejected = await client.profileReview(reviewTarget!, 'rejected', '自动化复核-驳回覆盖')
  expect(rejected.ok).toBe(true)
  readback = queryRows<{ review_status: string; review_note: string }>(
    home.dbPath,
    'select review_status, review_note from evidence where id = ?',
    reviewTarget,
  )
  expect(readback[0]?.review_status).toBe('rejected')

  // IPC-18 行为约束：不存在的 evidenceId 不做存在性校验，UPDATE 0 行仍返回 { ok: true }。
  const missing = await client.profileReview('ev_not_exists_p109_0001', 'reviewed', '不存在 ID 仍返回 ok')
  expect(missing.ok).toBe(true)

  // 4. 前测 / 后测快照：回读 growth_snapshots，行数不减少，新增行 checkpoint 属于合法域。
  const beforeSnapshots = queryRows<{ id: string; checkpoint: string }>(
    home.dbPath,
    'select id, checkpoint from growth_snapshots',
  )
  const preResult = (await client.profileSnapshot({ checkpoint: 'pre' })) as unknown as Array<{ checkpoint: string }>
  const postResult = (await client.profileSnapshot({ checkpoint: 'post' })) as unknown as Array<{ checkpoint: string }>
  const afterSnapshots = queryRows<{ id: string; checkpoint: string }>(
    home.dbPath,
    'select id, checkpoint from growth_snapshots',
  )

  for (const snapshot of [...preResult, ...postResult]) {
    expect(['pre', 'post']).toContain(snapshot.checkpoint)
  }
  expect(afterSnapshots.length).toBeGreaterThanOrEqual(beforeSnapshots.length)
  const beforeSnapshotIds = new Set(beforeSnapshots.map((row) => row.id))
  const addedSnapshots = afterSnapshots.filter((row) => !beforeSnapshotIds.has(row.id))
  for (const row of addedSnapshots) {
    expect(['pre', 'post']).toContain(row.checkpoint)
  }

  // 观测值落盘证据：IPC/DB 证据条数、快照前后行数与新增行。
  const observation = {
    ipcEvidenceCount: evidenceList.length,
    domEvidenceCount: domEvidenceIds.length,
    dbEvidenceCount: dbEvidenceRows.length,
    reviewTarget,
    snapshotsBefore: beforeSnapshots.length,
    snapshotsAfter: afterSnapshots.length,
    addedSnapshots: addedSnapshots.map((row) => ({ id: row.id, checkpoint: row.checkpoint })),
  }
  mkdirSync(testInfo.outputDir, { recursive: true })
  writeFileSync(
    join(testInfo.outputDir, 'p1-09-observation.json'),
    `${JSON.stringify(observation, null, 2)}\n`,
    'utf8',
  )
})
