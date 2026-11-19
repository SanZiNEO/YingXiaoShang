import { test, expect } from '../fixtures/test.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchElectron } from '../driver/electron-driver.js'
import { allocatePort } from '../driver/ports.js'

/**
 * 依赖：BOOT-05（状态持久化）、WIN-02（bounds/最大化）、DATA-11（window-state.json 结构）。
 */
test('TC-P0-12 窗口尺寸/位置持久化一轮', async ({ app, home, evidence }) => {
  const first = (await app.windows())[0]
  expect(first, '首窗必须存在').toBeTruthy()
  expect(first?.bounds.width).toBeGreaterThanOrEqual(760)
  expect(first?.bounds.height).toBeGreaterThanOrEqual(560)

  await app.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.setBounds({ x: 140, y: 90, width: 920, height: 640 })
  })

  const statePath = join(home.home, 'window-state.json')
  await expect
    .poll(() => {
      if (!existsSync(statePath)) return 'missing'
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as { width?: number; height?: number }
      return `${state.width}x${state.height}`
    }, { timeout: 10000, intervals: [200, 400] })
    .toBe('920x640')

  const closed = await app.close()
  expect(closed.exitCode).toBe(0)
  expect(closed.forced).toBe(false)

  const saved = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
  expect(saved.width).toBe(920)
  expect(saved.height).toBe(640)
  expect(saved.x).toBe(140)
  expect(saved.y).toBe(90)
  expect(saved.maximized).toBe(false)

  const second = await launchElectron({
    kind: 'out',
    home: home.home,
    userDataDir: home.userDataDir,
    newsPort: await allocatePort(),
  })
  evidence.bind(second)
  try {
    const restored = (await second.windows())[0]
    expect(restored, '重启后必须出现窗口').toBeTruthy()
    expect(Math.abs((restored?.bounds.width ?? 0) - 920)).toBeLessThanOrEqual(2)
    expect(Math.abs((restored?.bounds.height ?? 0) - 640)).toBeLessThanOrEqual(2)
    expect(restored?.maximized).toBe(false)
    expect(restored?.visible).toBe(true)
  } finally {
    const report = await second.close()
    expect(report.exitCode).toBe(0)
  }
})
