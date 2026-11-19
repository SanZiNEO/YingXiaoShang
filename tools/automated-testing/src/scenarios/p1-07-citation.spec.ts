import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/test.js'

/**
 * 依赖：FLOW-05（会话内引用溯源分派）、UI-11（news 标签）、UI-12（source 标签）、
 * IPC-11（news.get）、IPC-05（getBlock）、IPC-06（getResource）。
 *
 * DOM 只验容器与标签 id；正文/字段断言一律走 IPC，不断言 iframe 内部元素。
 * 面板缺哪种 citation 就不伪造点击，改对 seed 既有 id 直读对应 IPC，并把偏差记入证据。
 */
const TARGET_SESSION = 'chat_mvfao3ns_w1g7v6'

test('TC-P1-07 引用溯源分派到 news/source 标签并回读 IPC', async ({ client, ui }, testInfo) => {
  await ui.openSession(TARGET_SESSION)
  await ui.openKind('evidence')
  await expect
    .poll(async () => (await ui.citations()).length, { timeout: 5_000, intervals: [150] })
    .toBeGreaterThan(0)
  const items = await ui.citations()

  const newsItems = items.filter((citation) => citation.type === 'news')
  const textbookItems = items.filter((citation) => citation.type === 'textbook')
  const resourceItems = items.filter((citation) => citation.type === 'resource')

  const newsTrace: Array<{ index: number; sourceId: string; tabId: string }> = []
  const sourceTrace: Array<{ index: number; kind: string; sourceId: string; tabId: string }> = []
  const deviations: string[] = []

  // news 引用：点击后出现 `news:<sourceId>` 标签，news.get 回读 article/matches/ideology 三键。
  for (const item of newsItems) {
    const beforeIds = await ui.tabIds()
    await ui.openCitationByType('news', item.index)
    const ids = await ui.tabIds()
    const newsTab = ids.find((id) => !beforeIds.includes(id) && id.startsWith('news:'))
      ?? ids.find((id) => id.startsWith('news:'))
    expect(newsTab, `news 引用 #${item.index} 应打开 news:<sourceId> 标签`).toBeTruthy()
    const sourceId = newsTab!.slice('news:'.length)
    await expect(await ui.tabById(newsTab!)).toBeVisible()

    const detail = await client.invoke<{
      article: Record<string, unknown>
      matches: unknown[]
      ideology: unknown[]
    }>('news.get', { articleId: sourceId })
    expect(Object.keys(detail).sort()).toEqual(['article', 'ideology', 'matches'])
    expect(detail.article).toBeTruthy()
    expect(typeof (detail.article as { id?: unknown }).id).toBe('string')
    expect(Array.isArray(detail.matches)).toBe(true)
    expect(Array.isArray(detail.ideology)).toBe(true)
    newsTrace.push({ index: item.index, sourceId, tabId: newsTab! })
  }

  // textbook / resource 引用：点击后出现 `source:<kind>:<id>` 标签，getBlock/getResource 回读嵌套 chapter。
  for (const item of [...textbookItems, ...resourceItems]) {
    const beforeIds = await ui.tabIds()
    await ui.openCitationByType(item.type, item.index)
    const ids = await ui.tabIds()
    const sourceTab = ids.find((id) => !beforeIds.includes(id) && id.startsWith('source:'))
      ?? ids.find((id) => id.startsWith('source:'))
    expect(sourceTab, `${item.type} 引用 #${item.index} 应打开 source:<kind>:<id> 标签`).toBeTruthy()
    const segments = sourceTab!.split(':')
    const kind = segments[1] ?? ''
    const sourceId = segments.slice(2).join(':')
    await expect(await ui.tabById(sourceTab!)).toBeVisible()

    if (kind === 'textbook') {
      const block = await client.invoke<{
        block: Record<string, unknown>
        chapter: Record<string, unknown> | null
        section: Record<string, unknown> | null
      }>('getBlock', { blockId: sourceId })
      expect(block).toBeTruthy()
      expect(block.block).toBeTruthy()
      expect(block.chapter).toBeTruthy()
      expect(typeof (block.chapter as { id?: unknown }).id).toBe('string')
      expect(block.section).toBeTruthy()
      expect(typeof (block.section as { id?: unknown }).id).toBe('string')
    } else {
      const resource = await client.invoke<{
        guide: Record<string, unknown>
        chapter: Record<string, unknown> | null
      }>('getResource', { resourceId: sourceId })
      expect(resource).toBeTruthy()
      expect(resource.guide).toBeTruthy()
      expect(resource.chapter).toBeTruthy()
    }
    sourceTrace.push({ index: item.index, kind, sourceId, tabId: sourceTab! })
  }

  // 面板缺类型不伪造点击：改对 seed 既有 id 直读 IPC，仍覆盖 IPC-05 / IPC-06 契约。
  const ipcFallback: Record<string, unknown> = {}
  if (textbookItems.length === 0) {
    deviations.push(
      'evidence 面板只保留最近一条 assistant 消息的 citations，本轮面板未展示 textbook 引用；改用 seed 既有 blockId 直读 getBlock 覆盖 IPC-05。',
    )
    const block = await client.invoke<{
      block: Record<string, unknown>
      chapter: Record<string, unknown> | null
      section: Record<string, unknown> | null
    }>('getBlock', { blockId: 'cb_000f9544499f' })
    expect(block).toBeTruthy()
    expect(block.block).toBeTruthy()
    expect(block.chapter).toBeTruthy()
    expect((block.chapter as { id?: unknown }).id).toBe('ch04')
    expect(block.section).toBeTruthy()
    ipcFallback.textbook = {
      blockId: 'cb_000f9544499f',
      chapterId: block.chapter?.id,
      sectionId: block.section?.id,
    }
  }
  if (resourceItems.length === 0) {
    deviations.push('seed 会话消息中不存在 resource 类型引用；改用 seed 既有 guide/ch01 直读 getResource 覆盖 IPC-06。')
    const resource = await client.invoke<{
      guide: Record<string, unknown>
      chapter: Record<string, unknown> | null
    }>('getResource', { resourceId: 'ch01' })
    expect(resource).toBeTruthy()
    expect(resource.guide).toBeTruthy()
    expect(resource.chapter).toBeTruthy()
    ipcFallback.resource = { resourceId: 'ch01', chapterId: resource.chapter?.id }
  }

  mkdirSync(testInfo.outputDir, { recursive: true })
  writeFileSync(
    join(testInfo.outputDir, 'p1-07-citation-evidence.json'),
    JSON.stringify(
      {
        sessionId: TARGET_SESSION,
        panelTypes: { news: newsItems.length, textbook: textbookItems.length, resource: resourceItems.length },
        citations: items,
        newsTrace,
        sourceTrace,
        ipcFallback,
        deviations,
      },
      null,
      2,
    ),
    'utf8',
  )
})
