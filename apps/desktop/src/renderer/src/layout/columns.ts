export interface Columns {
  sidebar: number
  center: number
  workspace: number
}

export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 320
export const SIDEBAR_DEFAULT = 240
export const SIDEBAR_AUTO_COLLAPSE = 900
export const WORKSPACE_MIN = 360
export const WORKSPACE_MAX_RATIO = 0.62
export const WORKSPACE_DEFAULT_RATIO = 0.42
export const CENTER_MIN = 480

/** 把任意输入收敛到 [min, max]；上下界颠倒时以 min 为准。 */
export function clampWidth(px: number, min: number, max: number): number {
  if (!Number.isFinite(px)) return min
  const upper = Math.max(min, max)
  return Math.min(Math.max(px, min), upper)
}

/**
 * 三列宽度。sidebar 传 0 表示收起，workspace 传 0 表示无轨道。
 * 空间不足时先让 workspace 归零，center 才允许跌破 CENTER_MIN。
 */
export function computeColumns(viewport: number, sidebar: number, workspace: number): Columns {
  const width = Number.isFinite(viewport) ? Math.max(0, viewport) : 0
  const s = sidebar === 0 ? 0 : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const available = width - s - CENTER_MIN
  const w = workspace === 0 || available < WORKSPACE_MIN
    ? 0
    : Math.min(available, clampWidth(workspace, WORKSPACE_MIN, width * WORKSPACE_MAX_RATIO))
  const center = Math.max(0, width - s - w)
  return { sidebar: s, center, workspace: w }
}
