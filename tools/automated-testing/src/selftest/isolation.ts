/**
 * 双实例隔离自检（tsx 直接运行，不经过 Playwright TestInfo）。
 *
 * 用 driver 唯一入口 launchElectron 并行拉起两个完全隔离的实例：
 *  - 各自独立 tmp home + userDataDir；seed 模式复制 release/win-unpacked/resources/seed/learning.db；
 *  - 各自由 allocatePort 分配一个端口，均不启用 Python 侧车；
 *  - 断言：health.ok、appHome 各自指向自身 home 且互不相同、各 1 个窗口、
 *    端口互不相同且空闲、两份 DB 路径独立；
 *  - 关闭后复查 CloseReport（remainingPids 为空、portFree 为 true），
 *    再按 userDataDir 片段与 services/news-crawler-py 片段复查无残留进程。
 *
 * 超时保护：单实例启动 60s，整体不超过 180s。除 launchElectron 外不出现任何 Electron 直接 spawn。
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { launchElectron, type DriverHandle } from '../driver/electron-driver.js'
import { allocatePort, isPortFree } from '../driver/ports.js'
import { listProcesses } from '../driver/processes.js'
import { packagedSeedPath } from '../driver/paths.js'

const LAUNCH_TIMEOUT_MS = 60_000
const OVERALL_TIMEOUT_MS = 180_000
const SIDECAR_FRAGMENT = 'services/news-crawler-py'

interface InstanceHome {
  tag: string
  root: string
  home: string
  userDataDir: string
  dbPath: string
  newsPort: number
}

interface Check {
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []
const retainedHomes: string[] = []

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
}

function prepareHome(tag: string): InstanceHome {
  const root = join(
    tmpdir(),
    'yingxiaoshang-isolation',
    `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  )
  const home = join(root, 'home')
  const userDataDir = join(root, 'userdata')
  const dbPath = join(home, 'data', 'learning.db')
  mkdirSync(join(home, 'data'), { recursive: true })
  mkdirSync(join(home, 'artifacts'), { recursive: true })
  mkdirSync(join(home, 'exports'), { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, 'settings.json'), '{}\n', 'utf8')

  const seedDb = packagedSeedPath()
  if (!existsSync(seedDb)) throw new Error(`种子库不存在：${seedDb}`)
  copyFileSync(seedDb, dbPath)

  return { tag, root, home, userDataDir, dbPath, newsPort: 0 }
}

function chaptersCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const row = db.prepare('select count(*) as c from chapters').get() as { c?: number }
    return Number(row?.c ?? 0)
  } finally {
    db.close()
  }
}

async function run(): Promise<number> {
  const homeA = prepareHome('a')
  const homeB = prepareHome('b')
  let appA: DriverHandle | undefined
  let appB: DriverHandle | undefined

  try {
    const [portA, portB] = await Promise.all([allocatePort(), allocatePort()])
    homeA.newsPort = portA
    homeB.newsPort = portB

    // 并行拉起；唯一 Electron 启动入口是 launchElectron。
    const launched = await Promise.all([
      launchElectron({
        kind: 'out',
        home: homeA.home,
        userDataDir: homeA.userDataDir,
        newsPort: portA,
        autostartSidecar: false,
        launchTimeoutMs: LAUNCH_TIMEOUT_MS,
      }),
      launchElectron({
        kind: 'out',
        home: homeB.home,
        userDataDir: homeB.userDataDir,
        newsPort: portB,
        autostartSidecar: false,
        launchTimeoutMs: LAUNCH_TIMEOUT_MS,
      }),
    ])
    const mainA = launched[0]
    const mainB = launched[1]
    appA = mainA
    appB = mainB

    // health
    record('A health.ok', mainA.health.ok === true, `ok=${mainA.health.ok} appHome=${mainA.health.appHome}`)
    record('B health.ok', mainB.health.ok === true, `ok=${mainB.health.ok} appHome=${mainB.health.appHome}`)

    // appHome 各自等于自己的 home，且互不相同
    record('A appHome 指向自身 home', mainA.health.appHome === homeA.home, `appHome=${mainA.health.appHome} home=${homeA.home}`)
    record('B appHome 指向自身 home', mainB.health.appHome === homeB.home, `appHome=${mainB.health.appHome} home=${homeB.home}`)
    record('两个 appHome 互不相同', mainA.health.appHome !== mainB.health.appHome, `A=${mainA.health.appHome} B=${mainB.health.appHome}`)

    // 窗口数量
    const windowsA = await mainA.windows()
    const windowsB = await mainB.windows()
    record('A 恰好 1 个窗口', windowsA.length === 1, `windows=${windowsA.length}`)
    record('B 恰好 1 个窗口', windowsB.length === 1, `windows=${windowsB.length}`)

    // 端口：互不相同；未启侧车，端口必须空闲
    record('两个端口互不相同', portA !== portB, `A=${portA} B=${portB}`)
    const freeA = await isPortFree(portA)
    const freeB = await isPortFree(portB)
    record('A 侧车端口空闲（未启侧车）', freeA, `port=${portA} free=${freeA}`)
    record('B 侧车端口空闲（未启侧车）', freeB, `port=${portB} free=${freeB}`)

    // DB 文件各自独立
    const dbAExists = existsSync(homeA.dbPath)
    const dbBExists = existsSync(homeB.dbPath)
    record('A 数据库文件存在', dbAExists, homeA.dbPath)
    record('B 数据库文件存在', dbBExists, homeB.dbPath)
    record('两个 DB 路径互不相同', homeA.dbPath !== homeB.dbPath, `A=${homeA.dbPath} B=${homeB.dbPath}`)
    if (dbAExists && dbBExists) {
      const chaptersA = chaptersCount(homeA.dbPath)
      const chaptersB = chaptersCount(homeB.dbPath)
      record('两份 DB 均可独立打开', true, `A chapters=${chaptersA} B chapters=${chaptersB}`)
    }

    // 关闭两个实例
    const reportA = await mainA.close()
    const reportB = await mainB.close()
    record(
      'A 关闭后无残留 PID',
      reportA.remainingPids.length === 0,
      `remainingPids=[${reportA.remainingPids.join(',')}] forced=${reportA.forced} exitCode=${reportA.exitCode}`,
    )
    record(
      'B 关闭后无残留 PID',
      reportB.remainingPids.length === 0,
      `remainingPids=[${reportB.remainingPids.join(',')}] forced=${reportB.forced} exitCode=${reportB.exitCode}`,
    )
    record('A 端口已释放', reportA.portFree, `port=${portA} portFree=${reportA.portFree}`)
    record('B 端口已释放', reportB.portFree, `port=${portB} portFree=${reportB.portFree}`)

    // 进程表复查：按 userDataDir 片段查 Electron 残留，按侧车片段查 Python 残留
    const procA = listProcesses(homeA.userDataDir)
    const procB = listProcesses(homeB.userDataDir)
    record('A userData 无残留 Electron 进程', procA.length === 0, `rows=${procA.length}${procA.length > 0 ? `：${procA.map((row) => row.pid).join(',')}` : ''}`)
    record('B userData 无残留 Electron 进程', procB.length === 0, `rows=${procB.length}${procB.length > 0 ? `：${procB.map((row) => row.pid).join(',')}` : ''}`)
    const sidecarRows = listProcesses(SIDECAR_FRAGMENT)
    record('无残留 Python 侧车进程', sidecarRows.length === 0, `rows=${sidecarRows.length}`)

    const failed = checks.filter((item) => !item.ok)
    if (failed.length > 0) retainedHomes.push(homeA.root, homeB.root)
    return failed.length === 0 ? 0 : 1
  } finally {
    await appA?.close().catch(() => undefined)
    await appB?.close().catch(() => undefined)
    for (const root of [homeA.root, homeB.root]) {
      if (retainedHomes.includes(root)) continue
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
}

async function main(): Promise<void> {
  let exitCode = 1
  try {
    exitCode = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`整体超时（超过 ${OVERALL_TIMEOUT_MS}ms）`)), OVERALL_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    record('执行未抛错', false, error instanceof Error ? error.message : String(error))
  }

  for (const check of checks) {
    console.log(`${check.ok ? '[PASS]' : '[FAIL]'} ${check.name} — ${check.detail}`)
  }

  const failed = checks.filter((item) => !item.ok)
  if (retainedHomes.length > 0) {
    console.log(`失败现场目录（已保留）：${retainedHomes.join('、')}`)
  }
  if (exitCode === 0 && failed.length === 0) {
    console.log('2 实例隔离自检通过')
    process.exit(0)
  }
  console.log(`隔离自检失败：${failed.length} 项未通过`)
  process.exit(1)
}

void main()
