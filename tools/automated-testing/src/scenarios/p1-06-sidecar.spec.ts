import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/test.js'
import { isPortFree } from '../driver/ports.js'
import { killTree, listProcesses, type ProcessRow, isAlive } from '../driver/processes.js'

/**
 * 依赖：EXT-07（sidecar 崩溃/退出不自动重建）、SVC-19（news 后台通道与健康检查）、
 * EXT-12（隔离 home 上的共享 seed 库并发观测）。
 *
 * 前置：fixture 放开 autostartSidecar 让主进程拉起 Python 侧车；同时清掉 harness 默认注入的
 * NEWS_CRAWLER_URL（源码事实：该变量非空时 startNewsBackend 跳过 spawn，仅做体检）。
 * 先经 /health 确认真实监听并记录 db_path，再按“端口号 + news-crawler 命令行”双特征定位 PID，
 * killTree 后断言不重建、主进程与本地读取仍存活，最后观察 news.refresh 的失败形态。
 */
test.use({
  autostartSidecar: true,
  extraEnv: { NEWS_CRAWLER_URL: undefined },
})

interface HealthProbe {
  status: number
  body: unknown
}

/** 探一次侧车 /health；不可达返回 undefined。等待策略只走探测与轮询，不用固定延时。 */
async function probeHealth(port: number): Promise<HealthProbe | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_500),
    })
    const text = await response.text()
    let body: unknown
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      body = text
    }
    return { status: response.status, body }
  } catch {
    return undefined
  }
}

/** 双特征核对：命令行必须含本用例端口，且命令行匹配 news-crawler 侧车可执行文件/模块。 */
function matchSidecar(portFragment: string, row: ProcessRow): boolean {
  const cmd = row.commandLine
  return cmd.includes(`--port ${portFragment}`) && /news[-_ ]crawler/i.test(cmd)
}

test('TC-P1-06 sidecar 退出后不重建、后续网络调用失败', async ({ app, client, home }, testInfo) => {
  const portFragment = String(app.newsPort)

  // 步骤一：等真实侧车 /health 返回 200，记录健康载荷与 db_path。
  await expect
    .poll(async () => probeHealth(app.newsPort), { timeout: 15_000, intervals: [150] })
    .toMatchObject({ status: 200 })
  const healthBefore = await probeHealth(app.newsPort)
  const healthBody = (healthBefore?.body ?? {}) as Record<string, unknown>
  const dbPath = typeof healthBody.db_path === 'string' ? healthBody.db_path : undefined

  // 步骤二：按端口号 + news-crawler 命令行双特征定位侧车进程树。venv 控制台脚本会拉起
  // “exe 启动器 → venv python → 解释器”三层进程，命令行都带同一端口；根节点是不含 python.exe 的启动器，
  // killTree 从根节点向下 /T /F 收束整棵树。
  const beforeRows = listProcesses(portFragment)
  const sidecarBefore = beforeRows.filter((row) => matchSidecar(portFragment, row))
  expect(sidecarBefore.length, `至少定位到一个本端口的 news-crawler 侧车进程：${JSON.stringify(beforeRows)}`).toBeGreaterThanOrEqual(1)
  const rootCandidate = sidecarBefore.find((row) => !/python\.exe/i.test(row.commandLine)) ?? sidecarBefore[0]!
  const sidecarPid = rootCandidate.pid

  // 步骤三：杀掉侧车；之后 /health 转为不可达且端口空闲——主进程不会自动重建。
  killTree(sidecarPid)
  await expect
    .poll(async () => probeHealth(app.newsPort), { timeout: 8_000, intervals: [150] })
    .toBeUndefined()
  const portFreeAfterKill = await isPortFree(app.newsPort)
  expect(portFreeAfterKill).toBe(true)
  const rowsAfterKill = listProcesses(portFragment)
  expect(rowsAfterKill.filter((row) => matchSidecar(portFragment, row))).toEqual([])

  // 步骤四：主进程存活、窗口数为 1、本地 health 通道仍 ok（降级不拖垮壳）。
  expect(isAlive(app.mainPid)).toBe(true)
  const windowsAfterKill = await app.windows()
  expect(windowsAfterKill).toHaveLength(1)
  const healthAfterKill = await client.health()
  expect(healthAfterKill.ok).toBe(true)

  // 步骤五：本地新闻读取不经过侧车，仍然可读。
  const localList = await client.newsList({ limit: 500 })
  expect(localList.length).toBeGreaterThan(0)
  const firstArticleId = localList[0]?.id ?? ''
  expect(typeof firstArticleId).toBe('string')
  expect(firstArticleId.length).toBeGreaterThan(0)
  const localDetail = await client.invoke<{ article: Record<string, unknown>; matches: unknown[]; ideology: unknown[] }>(
    'news.get',
    { articleId: firstArticleId },
  )
  expect(localDetail.article).toBeTruthy()
  expect(Array.isArray(localDetail.matches)).toBe(true)
  expect(Array.isArray(localDetail.ideology)).toBe(true)

  // 步骤六：触发一次 news.refresh；侧车不可达时必须 reject（或返回可识别失败结构），
  // 失败字样覆盖 ECONNREFUSED / fetch failed / 连接 / 超时 / 侧车不可用等形态。
  const refreshInput = { sources: [] as string[] }
  let refreshError: Error | undefined
  let refreshOutcome: unknown
  try {
    refreshOutcome = await client.invoke<unknown>('news.refresh', refreshInput)
  } catch (error) {
    refreshError = error instanceof Error ? error : new Error(String(error))
  }
  const refreshMessage = refreshError?.message ?? JSON.stringify(refreshOutcome)
  expect(refreshMessage).toMatch(
    /ECONNREFUSED|fetch failed|连不上|connect|timeout|timed out|超时|unavailable|news backend|sidecar/i,
  )

  // 事后端口仍空闲、没有新侧车进程被拉起。
  const portFreeAfterRefresh = await isPortFree(app.newsPort)
  expect(portFreeAfterRefresh).toBe(true)
  const rowsAfterRefresh = listProcesses(portFragment)
  expect(rowsAfterRefresh.filter((row) => matchSidecar(portFragment, row))).toEqual([])

  // 证据落盘：前后 health 载荷、PID/命令行、主进程日志、调用 payload。
  const evidence = {
    at: new Date().toISOString(),
    newsPort: app.newsPort,
    home: home.home,
    dbPath,
    beforeHealth: healthBefore,
    sidecarProcess: {
      rootPid: sidecarPid,
      rootCommandLine: rootCandidate.commandLine,
      allPids: sidecarBefore.map((row) => row.pid),
      allCommandLines: sidecarBefore.map((row) => row.commandLine),
    },
    processesBeforeKill: beforeRows.map((row) => ({ pid: row.pid, commandLine: row.commandLine })),
    afterKill: {
      reachable: false,
      portFree: portFreeAfterKill,
      sidecarPids: rowsAfterKill.filter((row) => matchSidecar(portFragment, row)).map((row) => row.pid),
      allRows: rowsAfterKill.map((row) => ({ pid: row.pid, commandLine: row.commandLine })),
    },
    main: {
      mainPid: app.mainPid,
      alive: isAlive(app.mainPid),
      windowCount: windowsAfterKill.length,
      health: healthAfterKill,
    },
    localRead: {
      listCount: localList.length,
      firstArticleId,
      detailKeys: Object.keys(localDetail).sort(),
    },
    refresh: {
      input: refreshInput,
      rejected: refreshError !== undefined,
      errorName: refreshError?.name ?? null,
      message: refreshMessage,
      outcome: refreshOutcome ?? null,
    },
    afterRefresh: {
      portFree: portFreeAfterRefresh,
      sidecarPids: rowsAfterRefresh.filter((row) => matchSidecar(portFragment, row)).map((row) => row.pid),
    },
  }
  mkdirSync(testInfo.outputDir, { recursive: true })
  writeFileSync(join(testInfo.outputDir, 'p1-06-sidecar-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  writeFileSync(join(testInfo.outputDir, 'p1-06-main.log'), app.logs.text(), 'utf8')
})
