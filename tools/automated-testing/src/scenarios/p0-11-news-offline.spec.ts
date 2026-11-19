import { test, expect } from '../fixtures/test.js'
import { isPortFree } from '../driver/ports.js'
import { listProcesses } from '../driver/processes.js'

/**
 * 依赖：EXT-06（AUTOSTART=0）、IPC-08/09（news.list/status 纯本地）、SVC-18（本地读取）、BOOT-01。
 */
test('TC-P0-11 关闭 sidecar 下启动不阻塞、本地新闻可读', async ({ app, client, home }) => {
  // launch 阶段已经完成 health resolve；sidecar 不可达没有阻塞窗口出现。
  expect(app.health.ok).toBe(true)
  expect(app.health.appHome).toBe(home.home)

  const list = await client.newsList({ limit: 1000 })
  expect(list).toHaveLength(134)
  for (const article of list.slice(0, 5)) {
    expect(typeof article.id).toBe('string')
    expect(article.id.length).toBeGreaterThan(0)
    expect(typeof article.title).toBe('string')
  }

  const status = await client.newsStatus()
  expect(status.count).toBe(134)
  expect(list.length).toBe(status.count)
  expect((status.newestFetchedAt as string).length).toBeGreaterThan(0)

  const detail = await client.invoke<Record<string, unknown>>('news.get', { articleId: list[0]?.id })
  expect(Object.keys(detail).sort()).toEqual(['article', 'ideology', 'matches'])
  expect(detail.article).toBeTruthy()
  expect(Array.isArray(detail.matches)).toBe(true)

  expect(await isPortFree(app.newsPort)).toBe(true)
  expect(listProcesses('news-crawler').length).toBe(0)
})
