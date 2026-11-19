import { test, expect } from '../fixtures/test.js'
import { isPortFree } from '../driver/electron-driver.js'

/**
 * 依赖：IPC-10（news.refresh）、EXT-06（侧车不可用）、EXT-10（离线失败分支）、SVC-19（显式失败语义）。
 * 补充：SVC-26（news.refresh 失败语义）、BOOT-11（侧车端口）、DATA-11（新闻表不被写脏）。
 * 本条在无侧车环境执行：刷新必须显式失败，且本地新闻数与内容保持不变。
 */
test('TC-P1-05 新闻刷新在无侧车时显式失败且不写脏数据', async ({ client, app }) => {
  const before = await client.newsStatus()
  expect(before.count).toBe(134)
  const beforeIds = (await client.newsList({ limit: 500 })).map((article) => article.id).sort()
  expect(beforeIds).toHaveLength(134)
  expect(await isPortFree(app.newsPort)).toBe(true)

  const error = await client.invoke('news.refresh', { sources: [] }).then(
    () => undefined,
    (reason: Error) => reason,
  )
  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  expect(message.length).toBeGreaterThan(0)
  expect(message).toMatch(/连不上|ECONNREFUSED|fetch failed|news service|sidecar|unavailable/i)

  const after = await client.newsStatus()
  expect(after.count).toBe(before.count)
  expect(after.newestFetchedAt).toBe(before.newestFetchedAt)

  const list = await client.newsList({ limit: 500 })
  expect(list).toHaveLength(134)
  expect(list.map((article) => article.id).sort()).toEqual(beforeIds)
})
