import { test, expect } from '../fixtures/test.js'
import { isPortFree } from '../driver/electron-driver.js'

/**
 * 依赖：IPC-08（news.list）、IPC-09（news.get）、IPC-11（news.status）、SVC-18（离线读取）、EXT-10（离线过滤）。
 * 补充：SVC-23/24（news 过滤与详情）、DATA-11（新闻/匹配/意识形态表）、BOOT-11（侧车端口）。
 * 离线基线：不启动侧车，所以不能出现任何 HTTP 抓取；本地库仍然可读。
 */
test('TC-P1-04 本地新闻查询与筛选不依赖网络', async ({ client, app }) => {
  const all = await client.newsList({ limit: 500 })
  expect(all).toHaveLength(134)
  const sources = Array.from(new Set(all.map((article) => String(article.source ?? '')).filter((value) => value.length > 0)))
  expect(sources.length).toBeGreaterThan(1)

  const selected = await client.newsList({ source: sources[0]!, limit: 500 })
  expect(selected.length).toBeGreaterThan(0)
  expect(selected.every((article) => article.source === sources[0])).toBe(true)

  const limited = await client.newsList({ limit: 3 })
  expect(limited).toHaveLength(3)
  expect(limited[0]?.id).toBe(all[0]?.id)

  const withMatches = all.find((article) => Number(article.matches_count ?? 0) > 0) ?? all[0]!
  const detail = await client.invoke<{
    article: Record<string, unknown>
    matches: Array<Record<string, unknown>>
    ideology: Array<Record<string, unknown>>
  }>('news.get', { articleId: withMatches.id })
  expect(detail).toBeDefined()
  expect(Object.keys(detail).sort()).toEqual(['article', 'ideology', 'matches'])
  expect(detail.article.id).toBe(withMatches.id)
  expect(Array.isArray(detail.matches)).toBe(true)

  for (const match of detail.matches.slice(0, 3)) {
    const kpId = String(match.kp_id ?? '')
    expect(kpId.length).toBeGreaterThan(0)
    const kp = await client.invoke<{ id?: string; name?: string } | undefined>('getKp', { kpId })
    expect(kp?.id ?? kp?.name).toBeTruthy()
  }

  expect(await client.invoke('news.get', { articleId: 'news_does_not_exist' })).toBeUndefined()

  // 没有侧车：新闻端口必须是空闲的，进程表里也不能出现 python sidecar。
  expect(await isPortFree(app.newsPort)).toBe(true)
  const windows = await app.windows()
  expect(windows).toHaveLength(1)
  expect((await client.health()).ok).toBe(true)
})
