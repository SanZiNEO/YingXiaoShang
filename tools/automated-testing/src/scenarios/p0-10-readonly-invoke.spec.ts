import { test, expect } from '../fixtures/test.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../client/learning-client.js'
import { launchElectron } from '../driver/electron-driver.js'
import { allocatePort } from '../driver/ports.js'
import { readCounts } from '../client/db-probe.js'

/**
 * 依赖：IPC-01/02/03/09（student/chapters/kps/news.status）、SVC-02（只读投影）、
 * DATA-04（表结构）、CH-01（invoke 通道）。
 */
test('TC-P0-10 只读 invoke 方法契约往返快照', async ({ client, home }) => {
  const counts = readCounts(home.dbPath)

  const student = await client.studentCurrent()
  expect(student.studentId).toBe('student_demo')
  expect(student.name.length).toBeGreaterThan(0)
  expect(typeof student.cohort).toBe('string')

  const chapters = await client.chapters()
  expect(chapters).toHaveLength(13)
  expect(chapters).toHaveLength(counts.chapters)
  for (const chapter of chapters) {
    expect(typeof chapter.id).toBe('string')
    expect(chapter.id.length).toBeGreaterThan(0)
    expect(typeof chapter.title).toBe('string')
  }

  // kps.list 单次最多返回 200 条（源码 searchKps 上限），按章节逐页读全后与 DB 对齐。
  const kps: Array<Record<string, unknown>> = []
  for (const chapter of chapters) {
    kps.push(...await client.kps(chapter.id))
  }
  expect(kps).toHaveLength(228)
  expect(kps).toHaveLength(counts.knowledgePoints)
  expect(new Set(kps.map((kp) => kp.id)).size).toBe(228)
  for (const kp of kps) {
    expect(typeof kp.id).toBe('string')
    expect(typeof kp.name).toBe('string')
    expect(typeof kp.chapter_id).toBe('string')
  }

  const status = await client.newsStatus()
  expect(status.count).toBe(134)
  expect(status.count).toBe(counts.newsArticles)
  expect(typeof status.newestFetchedAt).toBe('string')
  expect((status.newestFetchedAt as string).length).toBeGreaterThan(0)

  // 空库分叉：不 reject，返回 [] / 0，不依赖种子数据。
  const emptyRoot = mkdtempSync(join(tmpdir(), 'yxs-empty-'))
  const emptyHome = join(emptyRoot, 'home')
  const emptyUserData = join(emptyRoot, 'userdata')
  mkdirSync(join(emptyHome, 'data'), { recursive: true })
  mkdirSync(emptyUserData, { recursive: true })
  writeFileSync(join(emptyUserData, 'settings.json'), '{}\n', 'utf8')
  const emptyApp = await launchElectron({
    kind: 'out',
    home: emptyHome,
    userDataDir: emptyUserData,
    newsPort: await allocatePort(),
  })
  try {
    const emptyClient = await createClient(emptyApp.page)
    expect(await emptyClient.chapters()).toEqual([])
    expect(await emptyClient.invoke('kps.list', { limit: 1000 })).toEqual([])
    const emptyStatus = await emptyClient.newsStatus()
    expect(emptyStatus.count).toBe(0)
    expect(emptyStatus.newestFetchedAt).toBe('')
  } finally {
    await emptyApp.close()
    rmSync(emptyRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
