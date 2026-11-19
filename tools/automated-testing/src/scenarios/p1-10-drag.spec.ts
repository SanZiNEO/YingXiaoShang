import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/test.js'

/**
 * 依赖：FLOW-09（分栏拖拽 / 复位 / 键盘序列）、UI-14（侧栏手柄）、UI-15（工作区手柄）、WIN-01（最小尺寸约束联动）。
 *
 * 键盘路径优先：聚焦手柄后方向键步进 16px；不做指针拖拽，不做像素级等值断言。
 * localStorage：sidebar 键为纯数字字符串，workspace 键为 JSON（{px} 优先，其次 {ratio}）。
 * 侧栏缺省宽度 240 来自 layout/columns.ts 的 SIDEBAR_DEFAULT；存储键缺失时按该缺省值对照步进。
 * 等待只走 DOM 状态 / 渲染回读 / localStorage 回读，不使用固定等待。
 */
const SIDEBAR_DEFAULT = 240

test('TC-P1-10 分栏拖拽键盘步进与布局持久化', async ({ app, ui }, testInfo) => {
  // 1. 宽视图前置：视口宽度不小于 900，等待 ResizeObserver 回读完成。
  await app.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setSize(1280, 760)
  })
  await expect
    .poll(async () => await app.page.evaluate(() => window.innerWidth), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(900)
  const innerWidth = await app.page.evaluate(() => window.innerWidth)

  // 工作区挂起标签，满足 workspace 手柄挂载条件（workspaceOpen && cols.workspace > 0）。
  await ui.ensureWorkspace()

  const sidebarHandle = ui.dragHandle('sidebar')
  const workspaceHandle = ui.dragHandle('workspace')
  await sidebarHandle.waitFor({ state: 'visible', timeout: 10_000 })
  await workspaceHandle.waitFor({ state: 'visible', timeout: 10_000 })

  // 2. 手柄 ARIA 契约：role=separator，data-side 与所属侧一致。
  expect(await sidebarHandle.getAttribute('role')).toBe('separator')
  expect(await sidebarHandle.getAttribute('data-side')).toBe('sidebar')
  expect(await workspaceHandle.getAttribute('role')).toBe('separator')
  expect(await workspaceHandle.getAttribute('data-side')).toBe('workspace')

  // 3. 侧栏键盘右移三次（每次 16px），记录步进前后的持久化数值与渲染宽度。
  const initialNumber = await ui.layoutNumber('sidebar')
  const initialWidth = await ui.columnWidth('sidebar')
  const effectiveInitial = initialNumber ?? SIDEBAR_DEFAULT

  for (let step = 0; step < 3; step += 1) {
    await ui.resizeColumn('sidebar', 'right')
  }
  const afterNumber = await ui.layoutNumber('sidebar')
  const afterWidth = await ui.columnWidth('sidebar')

  if (afterNumber !== undefined) {
    // 被 clamp 收敛时增量允许更小，但必须严格大于初值（缺省键按 SIDEBAR_DEFAULT 对照）。
    expect(afterNumber).toBeGreaterThan(effectiveInitial)
    expect(afterNumber - effectiveInitial).toBeLessThanOrEqual(48 + 1)
  }
  if (initialWidth !== undefined && afterWidth !== undefined) {
    // 宽度变化方向与数值一致（收敛到上界时允许持平）。
    expect(afterWidth).toBeGreaterThanOrEqual(initialWidth)
  }

  // 4. 工作区手柄按一次 ArrowLeft：workspace 键出现且 JSON 可解析（px 或 ratio 数值）。
  await ui.resizeColumn('workspace', 'left')
  const workspaceRaw = await ui.page.evaluate(() => window.localStorage.getItem('yingxiaoshang.layout.workspace'))
  expect(workspaceRaw, 'workspace 布局键必须写入').not.toBeNull()
  const workspaceParsed = JSON.parse(workspaceRaw ?? '') as Record<string, unknown>
  expect(typeof workspaceParsed).toBe('object')
  expect(workspaceParsed).not.toBeNull()
  const hasPx = typeof workspaceParsed?.px === 'number'
  const hasRatio = typeof workspaceParsed?.ratio === 'number'
  expect(hasPx || hasRatio, 'workspace 偏好必须含 px 或 ratio 数值').toBe(true)

  // sidebar 键为纯数字字符串。
  const sidebarRaw = await ui.page.evaluate(() => window.localStorage.getItem('yingxiaoshang.layout.sidebar'))
  expect(sidebarRaw, 'sidebar 布局键必须写入').not.toBeNull()
  expect(Number.isFinite(Number(sidebarRaw))).toBe(true)

  // 5. 双击复位侧栏：宽度回到初值（允许 1px 误差），或持久化数值回到初值。
  await ui.resetColumn('sidebar')
  const resetNumber = await ui.layoutNumber('sidebar')
  const resetWidth = await ui.columnWidth('sidebar')
  const widthRestored =
    initialWidth !== undefined && resetWidth !== undefined && Math.abs(resetWidth - initialWidth) <= 1
  const numberRestored =
    afterNumber !== undefined && resetNumber !== undefined && resetNumber === effectiveInitial
  expect(widthRestored || numberRestored, '双击复位后侧栏宽度应回到初值').toBe(true)

  // 观测值落盘证据：步进前后数值 / 宽度 / localStorage 原始串。
  const observation = {
    innerWidth,
    initialNumber,
    effectiveInitial,
    initialWidth,
    afterNumber,
    afterWidth,
    resetNumber,
    resetWidth,
    sidebarRaw,
    workspaceRaw,
  }
  mkdirSync(testInfo.outputDir, { recursive: true })
  writeFileSync(
    join(testInfo.outputDir, 'p1-10-observation.json'),
    `${JSON.stringify(observation, null, 2)}\n`,
    'utf8',
  )
})
