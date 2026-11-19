import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/test.js'
import { createHome, removeHome, type HomeContext } from '../fixtures/home.js'
import { launchElectron, isPortFree, type DriverHandle } from '../driver/electron-driver.js'
import { allocatePort } from '../driver/ports.js'
import { createClient } from '../client/learning-client.js'

/**
 * 依赖：BOOT-04（双开表现观测，源码层未实现 requestSingleInstanceLock）、WIN-01（窗口枚举基线）、LEG-18（dev/out 启动参数参考）。
 *
 * 口径：本用例不断言「应当单例」，只记录两个实例的实际表现——窗口数、health、home/userData/DB 路径隔离、
 * 端口占用、IPC 可用性，以及第二实例的焦点/可见性事实。取不到的事实记为未观测，不臆造。
 */
test('TC-P1-12 双实例行为观察（单例缺失）', async ({ app, client }, testInfo) => {
  const secondHome: HomeContext = createHome(testInfo, 'seed')
  const secondPort = await allocatePort()
  let second: DriverHandle | undefined

  interface InstanceObs {
    home: string
    userDataDir: string
    newsPort: number
    [key: string]: unknown
  }
  const observation: { first: InstanceObs; second: InstanceObs } = {
    first: { home: app.home, userDataDir: app.userDataDir, newsPort: app.newsPort },
    second: { home: secondHome.home, userDataDir: secondHome.userDataDir, newsPort: secondPort },
  }

  try {
    second = await launchElectron({
      kind: 'out',
      home: secondHome.home,
      userDataDir: secondHome.userDataDir,
      newsPort: secondPort,
      autostartSidecar: false,
    })

    // 窗口枚举：两个实例各自一个窗口。
    const firstWindows = await app.windows()
    const secondWindows = await second.windows()
    observation.first.windows = firstWindows
    observation.second.windows = secondWindows
    expect(firstWindows).toHaveLength(1)
    expect(secondWindows).toHaveLength(1)

    // health 各自通过，appHome 指向自己的隔离 home，互不相同。
    expect(app.health.ok).toBe(true)
    expect(second.health.ok).toBe(true)
    expect(app.health.appHome).toBe(app.home)
    expect(second.health.appHome).toBe(secondHome.home)
    expect(app.health.appHome).not.toBe(secondHome.home)

    // userDataDir 与 DB 路径互不相同，且两份 DB 都已落盘。
    expect(app.userDataDir).not.toBe(secondHome.userDataDir)
    const firstDb = join(app.home, 'data', 'learning.db')
    const secondDb = join(secondHome.home, 'data', 'learning.db')
    expect(existsSync(firstDb)).toBe(true)
    expect(existsSync(secondDb)).toBe(true)
    expect(firstDb).not.toBe(secondDb)
    observation.first.dbPath = firstDb
    observation.second.dbPath = secondDb

    // 端口互不相同；无侧车，两个端口都应空闲。
    expect(app.newsPort).not.toBe(secondPort)
    expect(await isPortFree(app.newsPort)).toBe(true)
    expect(await isPortFree(secondPort)).toBe(true)

    // 两实例都能正常走客户端 IPC（student.current）。
    const firstStudent = await client.studentCurrent()
    expect(firstStudent).toBeTruthy()
    const secondClient = await createClient(second.page)
    const secondStudent = await secondClient.studentCurrent()
    expect(secondStudent).toBeTruthy()
    observation.first.student = { id: firstStudent.studentId, name: firstStudent.name }
    observation.second.student = { id: secondStudent.studentId, name: secondStudent.name }

    // 第二实例焦点/可见性事实：能取到就记录，取不到记未观测。
    try {
      const focus = await second.page.evaluate(() => ({
        visibility: document.visibilityState,
        focused: document.hasFocus(),
      }))
      observation.second.focus = focus
    } catch (error) {
      observation.second.focus = { observed: false, reason: error instanceof Error ? error.message : String(error) }
    }
  } finally {
    if (second) await second.close()
    removeHome(secondHome)
  }

  mkdirSync(testInfo.outputDir, { recursive: true })
  writeFileSync(
    join(testInfo.outputDir, 'dual-instance.json'),
    JSON.stringify(observation, null, 2),
    'utf8',
  )
})
