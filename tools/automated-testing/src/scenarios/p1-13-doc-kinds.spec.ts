import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/test.js'

/**
 * 依赖：UI-07（右侧工作区面板）、UI-08（工作区标签页栏）、FLOW-08（标签开/关/切）、IPC-19（artifacts.list）、LEG-30（历史日志覆盖面板清单参考）。
 *
 * DocKind 九种：artifact、overview、artifacts、evidence、process、files、file、news、source。
 * 逐一打开可脚本化的八种；file 入口是原生打开对话框（tab-menu-open-local → files.openDialog），
 * 无法脚本化选择文件，标注为人工项，不静默跳过。
 *
 * 全程收集 pageerror 与 console error，末尾断言为空。
 */
test('TC-P1-13 九种 DocKind 标签逐一打开', async ({ app, client, ui }, testInfo) => {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  app.page.on('pageerror', (error) => pageErrors.push(error instanceof Error ? error.message : String(error)))
  app.page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  const openedKinds: string[] = []
  const manualItems: string[] = []

  // 1. 五个列表驱动的 kind：overview / artifacts / evidence / process / files。
  const listKinds = ['overview', 'artifacts', 'evidence', 'process', 'files'] as const
  for (const kind of listKinds) {
    await ui.openKind(kind)
    await ui.waitForTabId(kind)
    expect(await ui.tabIds()).toContain(kind)
    openedKinds.push(kind)
  }

  // 2. artifact：artifacts.list 取首个产物 id，经产物入口打开。
  const artifacts = await client.artifactsList()
  expect(artifacts.length).toBeGreaterThan(0)
  const firstArtifact = artifacts[0]!
  await ui.openArtifact(firstArtifact.id)
  const artifactTabId = `artifact:${firstArtifact.id}`
  await ui.waitForTabId(artifactTabId)
  expect(await ui.tabIds()).toContain(artifactTabId)
  openedKinds.push('artifact')

  // 3. news / source：切到 seed 目标会话。loadSession 会清空既有标签，先重新挂载 evidence 面板再取引用。
  await ui.openSession('chat_mvfao3ns_w1g7v6')
  await ui.openKind('evidence')
  // 等本轮引用加载完成（信号：依据条目出现，不做固定延时等待）。
  await expect
    .poll(async () => (await ui.citations()).length, { timeout: 15000 })
    .toBeGreaterThan(0)
  const refs = await ui.citations()

  const newsRef = refs.find((ref) => ref.type === 'news')
  expect(newsRef, 'seed 目标会话最新一轮应带 news 引用').toBeTruthy()
  await ui.openCitationByType('news', newsRef!.index)
  const idsAfterNews = await ui.tabIds()
  const newsTabId = idsAfterNews.find((id) => id.startsWith('news:'))
  expect(newsTabId, 'news 引用应开出 news 标签').toBeTruthy()
  await ui.waitForTabId(newsTabId!)
  openedKinds.push('news')

  // source（textbook/resource）：seed 证据面板只挂最新一轮引用；若本轮列表里没有则记为未观测，不臆造。
  const sourceRef = refs.find((ref) => ref.type === 'textbook' || ref.type === 'resource')
  let sourceObservation: Record<string, unknown>
  if (sourceRef) {
    await ui.openCitationByType(sourceRef.type, sourceRef.index)
    const idsAfterSource = await ui.tabIds()
    const sourceTabId = idsAfterSource.find((id) => id.startsWith('source:'))
    expect(sourceTabId, 'source 引用应开出 source 标签').toBeTruthy()
    await ui.waitForTabId(sourceTabId!)
    openedKinds.push('source')
    sourceObservation = { observed: true, type: sourceRef.type, tabId: sourceTabId }
  } else {
    const reason =
      'seed 目标会话最新一轮引用仅 news；textbook 引用属于更早一轮，证据面板（App.tsx 仅取最新一轮 citations）不展示；seed 库亦无 resource 类型引用。'
    testInfo.annotations.push({ type: 'manual', description: `source（textbook/resource）入口本轮未观测到：${reason}` })
    manualItems.push(`source 标签人工验收：${reason}`)
    sourceObservation = { observed: false, reason }
  }

  // 4. file：原生打开对话框，不可脚本化。显式标注人工项，不静默跳过。
  testInfo.annotations.push({
    type: 'manual',
    description: 'file 标签入口为原生打开对话框（tab-menu-open-local → files.openDialog），需人工在桌面端选择本地文件后观测 FilePreviewView 分支',
  })
  manualItems.push('file 标签人工验收：原生对话框选择本地文件，核对 markdown/html/text/image/pdf/unsupported 六分支')

  // 页面错误收集：全程不得出现 pageerror 或 console error。
  expect(pageErrors, '渲染层 pageerror 列表').toEqual([])
  expect(consoleErrors, '渲染层 console error 列表').toEqual([])

  // 5. 关闭一个标签：数量减少，剩余标签仍可访问。
  const beforeClose = await ui.tabIds()
  expect(beforeClose.length).toBeGreaterThan(1)
  const targetTab = beforeClose[0]!
  await ui.closeTab(targetTab)
  const afterClose = await ui.tabIds()
  expect(afterClose).toHaveLength(beforeClose.length - 1)
  const remainingTab = afterClose[0]!
  const remainingLocator = await ui.tabById(remainingTab)
  await expect(remainingLocator).toBeVisible()

  mkdirSync(testInfo.outputDir, { recursive: true })
  writeFileSync(
    join(testInfo.outputDir, 'doc-kinds.json'),
    JSON.stringify(
      {
        openedKinds,
        citations: refs,
        source: sourceObservation,
        manualItems,
        pageErrors,
        consoleErrors,
        tabsAfterClose: afterClose,
      },
      null,
      2,
    ),
    'utf8',
  )
})
