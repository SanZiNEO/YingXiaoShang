import { test, expect } from '../fixtures/test.js'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packagedSeedPath, repoRoot } from '../driver/paths.js'
import { fileInfo, pragma } from '../client/db-probe.js'

/**
 * 依赖：PKG-03（packaged 入口路径）、PKG-06（asar/resources 路径）、BOOT-01（首窗）、
 * DATA-06（种子随包）、LEG-22（打包产物真实性）。
 * 使用 release/win-unpacked 的临时拷贝，避免污染原产物。
 */
test.use({ target: 'packaged', seedMode: 'empty' })

let packagedDir = ''
let copyRoot = ''

test.beforeAll(() => {
  copyRoot = mkdtempSync(join(tmpdir(), 'yxs-packaged-boot-'))
  packagedDir = join(copyRoot, 'win-unpacked')
  cpSync(join(repoRoot, 'release', 'win-unpacked'), packagedDir, { recursive: true })
  process.env.YXS_PACKAGED_DIR = packagedDir
})

test.afterAll(() => {
  delete process.env.YXS_PACKAGED_DIR
  rmSync(copyRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('TC-P0-08 packaged 产物启动首窗 + health（packaged 路径 ①）', async ({ app, client, home }) => {
  expect(app.kind).toBe('packaged')
  expect(app.health.ok).toBe(true)
  expect(app.health.appHome).toBe(home.home)
  expect(existsSync(join(packagedDir, 'resources', 'seed', 'learning.db'))).toBe(true)

  const windows = await app.windows()
  expect(windows).toHaveLength(1)
  expect(windows[0]?.title).toContain('营小商')
  expect(windows[0]?.visible).toBe(true)

  const pageUrl = decodeURIComponent(app.page.url()).toLowerCase()
  expect(pageUrl.startsWith('file://')).toBe(true)
  expect(pageUrl).toContain(packagedDir.replaceAll('\\', '/').toLowerCase())
  expect(pageUrl).toContain('app.asar')

  const runtime = await app.app.evaluate(({ app: electronApp }) => ({
    appPath: electronApp.getAppPath(),
    resourcesPath: process.resourcesPath,
  }))
  expect(runtime.appPath).toContain('app.asar')
  expect(runtime.resourcesPath.toLowerCase()).toContain(packagedDir.toLowerCase())

  const seed = fileInfo(packagedSeedPath())
  expect(seed.exists).toBe(true)
  expect(seed.size).toBeGreaterThan(0)
  expect(pragma(packagedSeedPath(), 'user_version')).toBe(7)

  // 空 home 首启会复制种子，health 才有章节可读。
  const health = await client.health()
  expect(health.ok).toBe(true)
  expect(health.appHome).toBe(home.home)
})
