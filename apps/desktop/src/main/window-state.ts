import { screen, type BrowserWindow, type Rectangle } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 小屏笔记本上也要能缩到这个尺寸。 */
export const MIN_WINDOW_WIDTH = 760
export const MIN_WINDOW_HEIGHT = 560

const DEFAULT_MAX_WIDTH = 1600
const DEFAULT_MAX_HEIGHT = 1000
const DEFAULT_WORK_AREA_RATIO = 0.9
const SAVE_DEBOUNCE_MS = 300

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

/** 数据目录：LEARNING_AGENT_HOME 优先，否则 ~/.learning-agent。 */
export function resolveAppHome(): string {
  return process.env.LEARNING_AGENT_HOME || join(homedir(), '.learning-agent')
}

/** 首次启动：工作区的 90%，上限 1600×1000，居中。 */
export function defaultBounds(): Rectangle {
  const { workArea } = screen.getPrimaryDisplay()
  const width = Math.min(DEFAULT_MAX_WIDTH, Math.round(workArea.width * DEFAULT_WORK_AREA_RATIO))
  const height = Math.min(DEFAULT_MAX_HEIGHT, Math.round(workArea.height * DEFAULT_WORK_AREA_RATIO))
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  }
}

function overlaps(a: Rectangle, b: Rectangle): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  )
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 读取上次的窗口位置。显示器被拔掉、文件损坏、尺寸不合法都返回 undefined，
 * 由调用方回退到 defaultBounds()，避免把窗口开到看不见的地方。
 */
export function readWindowState(): WindowState | undefined {
  try {
    const file = join(resolveAppHome(), 'window-state.json')
    if (!existsSync(file)) return undefined
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') return undefined
    const value = raw as Record<string, unknown>
    const x = finiteNumber(value.x)
    const y = finiteNumber(value.y)
    const width = finiteNumber(value.width)
    const height = finiteNumber(value.height)
    if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
    const rect: Rectangle = {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(MIN_WINDOW_WIDTH, Math.round(width)),
      height: Math.max(MIN_WINDOW_HEIGHT, Math.round(height)),
    }
    if (!screen.getAllDisplays().some((display) => overlaps(rect, display.workArea))) return undefined
    return { ...rect, maximized: value.maximized === true }
  } catch {
    return undefined
  }
}

/** 写失败就放弃：记录窗口位置不能影响启动或退出。 */
export function writeWindowState(state: WindowState): void {
  try {
    const file = join(resolveAppHome(), 'window-state.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    // 忽略：位置记录失败不影响启动或退出
  }
}

/**
 * 持续记录窗口状态。最大化时 bounds 会变成整个屏幕，所以额外记住还原后的
 * normal bounds；否则下次启动会拿最大化尺寸当默认尺寸。
 */
export function trackWindowState(win: BrowserWindow): void {
  let normal: Rectangle = win.getBounds()
  let timer: NodeJS.Timeout | undefined

  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const save = (): void => {
    if (win.isDestroyed()) return
    const maximized = win.isMaximized()
    const bounds = maximized ? normal : win.getBounds()
    writeWindowState({ ...bounds, maximized })
  }

  const schedule = (): void => {
    cancel()
    timer = setTimeout(() => {
      timer = undefined
      save()
    }, SAVE_DEBOUNCE_MS)
    timer.unref?.()
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', () => {
    cancel()
    // 必须先取 normal bounds：此刻 getBounds() 已经是最大化后的矩形。
    normal = win.getNormalBounds()
    save()
  })
  win.on('unmaximize', () => {
    cancel()
    // 用 normal bounds 而不是 getBounds()：某些平台上事件早于系统还原。
    normal = win.getNormalBounds()
    save()
  })
  win.on('close', () => {
    cancel()
    save()
  })
}
