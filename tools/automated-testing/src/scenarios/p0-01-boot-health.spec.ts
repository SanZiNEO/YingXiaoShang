import { test, expect } from '../fixtures/test.js'
import { fileInfo, pragma, readCounts } from '../client/db-probe.js'

/**
 * 依赖：BOOT-01（启动就绪）、CH-06（health 通道）、DATA-01/DATA-02（库路径与 PRAGMA 基线）、
 * SVC-01（DB 构造与版本）、LEG-13（体检规则）。
 */
test('TC-P0-01 隔离 home 启动并通过 health 自检', async ({ app, client, home }) => {
  expect(home.seedMode).toBe('seed')

  const health = await client.health()
  expect(health.ok).toBe(true)
  expect(health.appHome).toBe(home.home)
  expect(health.warnings).toEqual([])
  // 种子库带 134 条新闻，不应出现“本地新闻库为空”的提示。
  expect(health.notices).toEqual([])

  // driver 在窗口就绪时也取过一次 health，两处必须指向同一个 home。
  expect(app.health.appHome).toBe(home.home)
  expect(app.health.ok).toBe(true)

  const file = fileInfo(home.dbPath)
  expect(file.exists).toBe(true)
  expect(file.size).toBeGreaterThan(0)
  expect(pragma(home.dbPath, 'user_version')).toBe(7)
  expect(pragma(home.dbPath, 'application_id')).toBe(1280201284)

  const counts = readCounts(home.dbPath)
  expect(counts.chapters).toBe(13)
  expect(counts.knowledgePoints).toBe(228)
  expect(counts.newsArticles).toBe(134)
  expect(counts.artifacts).toBe(4)
  expect(counts.sessions).toBe(2)
  expect(counts.messages).toBe(8)
  expect(counts.turns).toBe(4)

  const windows = await app.windows()
  expect(windows).toHaveLength(1)
  expect(windows[0]?.title).toContain('营小商')
  expect(windows[0]?.visible).toBe(true)
  expect(windows[0]?.bounds.width).toBeGreaterThanOrEqual(760)
  expect(windows[0]?.bounds.height).toBeGreaterThanOrEqual(560)

  // 隔离生效：真实用户目录没有被写成这个测试 home。
  expect(home.home.includes('yingxiaoshang-tests')).toBe(true)
})
