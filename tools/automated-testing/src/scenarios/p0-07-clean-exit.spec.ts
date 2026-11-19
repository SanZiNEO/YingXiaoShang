import { test, expect } from '../fixtures/test.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPortFree } from '../driver/ports.js'
import { listProcesses } from '../driver/processes.js'

/**
 * 依赖：BOOT-07（退出清理）、DATA-12b/12d（三件套快照与清理）、SVC-01（连接关闭基线）。
 */
test('TC-P0-07 干净退出：定时器/子进程清理、句柄释放', async ({ app, client, home }) => {
  await client.health()
  expect((await app.windows())).toHaveLength(1)
  expect(listProcesses(home.userDataDir).length).toBeGreaterThan(0)

  const report = await app.close()
  expect(report.forced).toBe(false)
  expect(report.exitCode).toBe(0)
  expect(report.remainingPids).toEqual([])
  expect(report.portFree).toBe(true)
  expect(report.dbDeletable).toBe(true)
  expect(report.durationMs).toBeGreaterThan(0)

  // 8799/8788 都未监听：本轮 sidecar 关闭，且端口由 fixture 动态分配。
  expect(await isPortFree(app.newsPort)).toBe(true)
  expect(listProcesses('news-crawler').length).toBe(0)
  expect(listProcesses(home.userDataDir).length).toBe(0)

  const statePath = join(home.home, 'window-state.json')
  expect(existsSync(statePath)).toBe(true)
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
  for (const field of ['x', 'y', 'width', 'height']) {
    expect(typeof state[field]).toBe('number')
    expect(Number.isFinite(state[field])).toBe(true)
  }
  expect(Number(state.width)).toBeGreaterThanOrEqual(760)
  expect(Number(state.height)).toBeGreaterThanOrEqual(560)
  expect(typeof state.maximized).toBe('boolean')
})
