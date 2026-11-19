import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TestInfo, TestStatus } from '@playwright/test'
import { snapshot, type DbSnapshot } from '../client/db-probe.js'
import type { LearningClient } from '../client/learning-client.js'
import type { CloseReport, DriverHandle, WindowInfo } from '../driver/electron-driver.js'
import { artifactsRoot } from '../driver/paths.js'

export type CaseStatus = 'passed' | 'failed' | 'blocked'

export interface CaseMeta {
  tc: string
  title: string
  project: string
  status: TestStatus
  mappedStatus: CaseStatus
  durationMs: number
  error?: string
  annotations: Array<{ type: string; description?: string }>
  evidence: Record<string, string | undefined>
  home?: string
}

export function tcOf(title: string): string {
  const match = title.match(/TC-(P0|P1)-\d{2}/)
  return match ? match[0] : ''
}

function mapped(status: TestStatus | undefined): CaseStatus {
  if (status === 'passed') return 'passed'
  if (status === 'skipped') return 'blocked'
  return 'failed'
}

/**
 * 失败取证：截图只截应用窗口（page.screenshot），不截桌面。
 * 证据落在 Playwright 的 testInfo.outputDir，报告按 TC → 结果 → 证据目录索引。
 */
export class Evidence {
  private driver?: DriverHandle
  private client?: LearningClient
  private windows: WindowInfo[] | undefined
  private closeReport: CloseReport | undefined
  private liveCaptured = false
  private dbSnapshot: DbSnapshot | undefined
  private dbError: string | undefined

  constructor(private readonly info: TestInfo) {}

  bind(driver: DriverHandle): void {
    this.driver = driver
  }

  bindClient(client: LearningClient): void {
    this.client = client
  }

  /** 在 app 关闭前抓取只能在线拿到的东西：截图 / DOM / 窗口列表。 */
  async captureLive(): Promise<void> {
    if (this.liveCaptured || !this.driver) return
    this.liveCaptured = true
    const status = mapped(this.info.status)
    try {
      this.windows = await this.driver.windows()
    } catch {
      this.windows = undefined
    }
    if (status !== 'failed') return
    const page = this.driver.page
    if (page.isClosed()) return
    try {
      mkdirSync(this.info.outputDir, { recursive: true })
      await page.screenshot({ path: join(this.info.outputDir, 'failure.png'), fullPage: false })
    } catch {
      // 截图失败不掩盖原始断言错误。
    }
    try {
      writeFileSync(join(this.info.outputDir, 'dom.html'), await page.content(), 'utf8')
    } catch {
      // 页面可能已经在关闭。
    }
  }

  setCloseReport(report: CloseReport): void {
    this.closeReport = report
  }

  /** 必须在 home 被清理前调用（app fixture teardown 内）。 */
  captureDb(): void {
    if (!this.driver) return
    const dbPath = join(this.driver.home, 'data', 'learning.db')
    try {
      this.dbSnapshot = snapshot(dbPath)
    } catch (error) {
      this.dbError = error instanceof Error ? error.message : String(error)
    }
  }

  async finalize(status: TestStatus | undefined): Promise<void> {
    mkdirSync(this.info.outputDir, { recursive: true })
    const mappedStatus = mapped(status)
    const evidence: Record<string, string | undefined> = {}

    const write = (name: string, content: string): void => {
      try {
        writeFileSync(join(this.info.outputDir, name), content, 'utf8')
        evidence[name] = join(this.info.outputDir, name)
      } catch (error) {
        evidence[name] = `写入失败：${error instanceof Error ? error.message : String(error)}`
      }
    }

    if (this.driver) {
      write('main.log', `${this.driver.logs.text()}\n`)
      evidence.home = this.driver.home
    }
    if (this.client) {
      write('ipc.jsonl', `${this.client.calls.map((call) => JSON.stringify(call)).join('\n')}\n`)
    }
    if (this.windows) write('windows.json', `${JSON.stringify(this.windows, null, 2)}\n`)
    if (this.closeReport) write('close.json', `${JSON.stringify(this.closeReport, null, 2)}\n`)

    if (this.dbSnapshot) {
      write('db.json', `${JSON.stringify(this.dbSnapshot, null, 2)}\n`)
      evidence.db = join(this.info.outputDir, 'db.json')
    } else if (this.dbError) {
      evidence.db = `读取失败：${this.dbError}`
    }

    if (mappedStatus === 'failed') {
      evidence.screenshot = join(this.info.outputDir, 'failure.png')
      evidence.dom = join(this.info.outputDir, 'dom.html')
    }

    const meta: CaseMeta = {
      tc: tcOf(this.info.title),
      title: this.info.title,
      project: this.info.project.name,
      status: status ?? 'failed',
      mappedStatus,
      durationMs: this.info.duration,
      error: this.info.error?.message,
      annotations: this.info.annotations.map((annotation) => ({
        type: annotation.type,
        description: annotation.description,
      })),
      evidence,
      home: this.driver?.home,
    }
    write('meta.json', `${JSON.stringify(meta, null, 2)}\n`)
    try {
      mkdirSync(artifactsRoot, { recursive: true })
      appendFileSync(
        join(artifactsRoot, 'index.jsonl'),
        `${JSON.stringify({
          tc: meta.tc,
          title: meta.title,
          status: meta.status,
          mappedStatus,
          outputDir: this.info.outputDir,
          durationMs: meta.durationMs,
          error: meta.error,
          dependencies: meta.annotations.find((annotation) => annotation.type === 'deps')?.description,
        })}\n`,
        'utf8',
      )
    } catch {
      // 索引写不进去不影响单条证据本身。
    }
  }
}
