import { test, expect } from '../fixtures/test.js'
import { cpSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packagedSeedPath, repoRoot } from '../driver/paths.js'
import { fileInfo, pragma, readCounts } from '../client/db-probe.js'

/**
 * 依赖：PKG-03（packaged 首启自举）、PKG-04（resources/seed 复制）、DATA-06（种子表结构）、
 * DATA-07（基线行数）、DATA-12b（首启落库）。
 * 使用 release/win-unpacked 的临时拷贝，避免污染原产物。
 */
test.use({ target: 'packaged', seedMode: 'empty' })

let packagedDir = ''
let copyRoot = ''

test.beforeAll(() => {
  copyRoot = mkdtempSync(join(tmpdir(), 'yxs-packaged-seed-'))
  packagedDir = join(copyRoot, 'win-unpacked')
  cpSync(join(repoRoot, 'release', 'win-unpacked'), packagedDir, { recursive: true })
  process.env.YXS_PACKAGED_DIR = packagedDir
})

test.afterAll(() => {
  delete process.env.YXS_PACKAGED_DIR
  rmSync(copyRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('TC-P0-09 packaged 首启种子库自举落库（packaged 路径 ②）', async ({ app, home }) => {
  // fixture 明确没有预放数据库，库只能由 packaged 首启自举产生。
  expect(home.seedMode).toBe('empty')
  expect(app.kind).toBe('packaged')

  const file = fileInfo(home.dbPath)
  expect(file.exists).toBe(true)
  expect(file.size).toBeGreaterThan(0)
  expect(pragma(home.dbPath, 'user_version')).toBe(7)
  expect(pragma(home.dbPath, 'application_id')).toBe(1280201284)

  const bootCounts = readCounts(home.dbPath)
  expect(bootCounts.chapters).toBe(13)
  expect(bootCounts.knowledgePoints).toBe(228)
  expect(bootCounts.newsArticles).toBe(134)
  expect(bootCounts.artifacts).toBe(4)

  // 与 resources/seed 源库逐表对齐（复制而非重建）。
  const seedCounts = readCounts(packagedSeedPath())
  expect(bootCounts).toEqual(seedCounts)

  const runtime = await app.app.evaluate(({ app: electronApp }) => ({
    appPath: electronApp.getAppPath(),
    resourcesPath: process.resourcesPath,
  }))
  expect(runtime.appPath).toContain('app.asar')
  expect(decodeURIComponent(app.page.url())).toContain('app.asar')
  expect(statSync(join(packagedDir, 'resources', 'seed', 'learning.db')).isFile()).toBe(true)
})
