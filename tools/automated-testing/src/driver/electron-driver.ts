import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { buildEnv } from './env.js'
import { ProcessLog } from './log.js'
import { resolveTarget, type TargetKind } from './paths.js'
import { delay, isPortFree, waitPortFree } from './ports.js'
import { isAlive, killTree, listProcesses, waitProcessGone, type ProcessRow } from './processes.js'

async function waitProcessesGone(fragment: string, timeoutMs: number): Promise<ProcessRow[]> {
  const deadline = Date.now() + timeoutMs
  let rows = listProcesses(fragment)
  while (rows.length > 0 && Date.now() < deadline) {
    await delay(150)
    rows = listProcesses(fragment)
  }
  return rows
}

export interface LaunchOptions {
  kind: TargetKind
  home: string
  userDataDir: string
  newsPort: number
  autostartSidecar?: boolean
  extraEnv?: Record<string, string | undefined>
  launchTimeoutMs?: number
  readyTimeoutMs?: number
}

export interface WindowInfo {
  id: number
  title: string
  bounds: { x: number; y: number; width: number; height: number }
  minimized: boolean
  maximized: boolean
  visible: boolean
}

export interface CloseReport {
  exitCode: number | null
  forced: boolean
  durationMs: number
  remainingPids: number[]
  portFree: boolean
  dbDeletable: boolean
}

export interface HealthSnapshot {
  ok: boolean
  warnings: string[]
  notices: string[]
  appHome: string
}

export interface DriverHandle {
  readonly kind: TargetKind
  readonly app: ElectronApplication
  readonly page: Page
  readonly home: string
  readonly userDataDir: string
  readonly newsPort: number
  readonly logs: ProcessLog
  readonly health: HealthSnapshot
  readonly mainPid: number
  windows(): Promise<WindowInfo[]>
  close(): Promise<CloseReport>
}

function tryRenameProbe(path: string): boolean {
  if (!existsSync(path)) return true
  const probe = `${path}.free-probe`
  try {
    renameSync(path, probe)
    renameSync(probe, path)
    return true
  } catch {
    return false
  }
}

export async function launchElectron(options: LaunchOptions): Promise<DriverHandle> {
  const target = resolveTarget(options.kind, options.userDataDir)
  const env = buildEnv({
    home: options.home,
    userDataDir: options.userDataDir,
    newsPort: options.newsPort,
    autostartSidecar: options.autostartSidecar ?? false,
    extraEnv: options.extraEnv,
  })
  const logs = new ProcessLog()
  const app = await electron.launch({
    executablePath: target.executablePath,
    args: target.args,
    cwd: target.cwd,
    env,
    timeout: options.launchTimeoutMs ?? 60000,
  })
  const mainPid = app.process().pid ?? -1
  const childProcess = app.process()
  logs.attachProcess(childProcess)

  const page = await app.firstWindow({ timeout: options.readyTimeoutMs ?? 45000 })
  logs.attachPage(page)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => {
    const api = (window as unknown as { learning?: { health?: unknown } }).learning
    return Boolean(api && typeof api.health === 'function')
  }, undefined, { timeout: 20000 })

  const health = (await page.evaluate(async () => {
    const api = (window as unknown as { learning: { health: () => Promise<unknown> } }).learning
    return await api.health()
  })) as HealthSnapshot

  let closeReport: CloseReport | undefined

  const handle: DriverHandle = {
    kind: options.kind,
    app,
    page,
    home: options.home,
    userDataDir: options.userDataDir,
    newsPort: options.newsPort,
    logs,
    health,
    mainPid,
    async windows(): Promise<WindowInfo[]> {
      return await app.evaluate(async ({ BrowserWindow }) => {
        return BrowserWindow.getAllWindows().map((window) => ({
          id: window.id,
          title: window.getTitle(),
          bounds: window.getBounds(),
          minimized: window.isMinimized(),
          maximized: window.isMaximized(),
          visible: window.isVisible(),
        }))
      })
    },
    async close(): Promise<CloseReport> {
      if (closeReport) return closeReport
      const started = Date.now()
      let forced = false
      try {
        await Promise.race([
          app.close(),
          delay(12000).then(() => {
            throw new Error('app.close() 超时')
          }),
        ])
      } catch {
        forced = true
      }
      if (mainPid > 0 && !(await waitProcessGone(mainPid, 8000))) {
        forced = true
        killTree(mainPid)
        await waitProcessGone(mainPid, 5000)
      }
      // 主进程退出后子进程（GPU/crashpad）可能还在收尾，先给一段自然退出窗口。
      let remainingPids = (await waitProcessesGone(options.userDataDir, 5000)).map((row) => row.pid)
      if (remainingPids.length > 0) {
        forced = true
        for (const pid of remainingPids) {
          if (pid !== process.pid) killTree(pid)
        }
        await delay(300)
        remainingPids = listProcesses(options.userDataDir).map((row) => row.pid)
      }
      const portFree = await waitPortFree(options.newsPort, 5000)
      const dbDeletable = tryRenameProbe(join(options.home, 'data', 'learning.db'))
      closeReport = {
        exitCode: childProcess.exitCode,
        forced,
        durationMs: Date.now() - started,
        remainingPids,
        portFree,
        dbDeletable,
      }
      return closeReport
    },
  }
  return handle
}

export { isAlive, isPortFree }
