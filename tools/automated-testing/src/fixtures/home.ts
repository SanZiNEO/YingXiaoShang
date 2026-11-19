import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { TestInfo } from '@playwright/test'
import { packagedSeedPath } from '../driver/paths.js'

export type SeedMode = 'seed' | 'empty'

export interface HomeContext {
  root: string
  home: string
  userDataDir: string
  dbPath: string
  settingsPath: string
  seedMode: SeedMode
}

const RUN_TAG = process.env.YXS_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-')

function slug(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '')
  return (cleaned.length > 40 ? cleaned.slice(0, 40) : cleaned) || 'case'
}

/**
 * 种子库里的 `artifacts.path` 是生成机器上的绝对路径（如 `E:\...\learning-agent\.scratch\...`），
 * 复制到隔离 home 后仍在 appHome 之外，`ArtifactService.export` 会直接抛 PATH_OUTSIDE_APP。
 * 这是被测数据可移植性的真实缺口；fixture 在启动前把路径重映射到隔离 home 的产物目录，
 * 只改 `path` 列，不改内容，也不伪造导出文件。
 */
function rehomeSeedArtifacts(home: string, dbPath: string): void {
  const db = new DatabaseSync(dbPath)
  try {
    const rows = db.prepare('select id, student_id, format, created_at from artifacts').all() as Array<{
      id: string
      student_id: string
      format: string
      created_at: string
    }>
    const update = db.prepare('update artifacts set path = ? where id = ?')
    for (const row of rows) {
      const extension = row.format === 'html' ? 'html' : row.format === 'docx' ? 'docx' : 'md'
      const month = row.created_at.slice(0, 7)
      update.run(join(home, 'artifacts', row.student_id, month, `${row.id}.${extension}`), row.id)
    }
  } finally {
    db.close()
  }
}

/**
 * 每个用例一份完全独立的 home：
 * - `LEARNING_AGENT_HOME` 指向 `root/home`（db / window-state / artifacts / exports 都在里面）
 * - `--user-data-dir` 指向 `root/userdata`（settings.json 在这里）
 * - 预写一份 `{}` 的 settings.json，阻断主进程从真实 `%APPDATA%` 复制旧配置
 */
export function createHome(testInfo: TestInfo, seedMode: SeedMode): HomeContext {
  const root = resolve(
    tmpdir(),
    'yingxiaoshang-tests',
    RUN_TAG,
    `${slug(testInfo.title)}-w${testInfo.workerIndex}-r${testInfo.retry}-${Math.random().toString(36).slice(2, 6)}`,
  )
  const home = join(root, 'home')
  const userDataDir = join(root, 'userdata')
  const dbPath = join(home, 'data', 'learning.db')
  mkdirSync(join(home, 'data'), { recursive: true })
  mkdirSync(join(home, 'artifacts'), { recursive: true })
  mkdirSync(join(home, 'exports'), { recursive: true })
  mkdirSync(userDataDir, { recursive: true })

  const settingsPath = join(userDataDir, 'settings.json')
  if (!existsSync(settingsPath)) writeFileSync(settingsPath, '{}\n', 'utf8')

  if (seedMode === 'seed') {
    const seedDb = packagedSeedPath()
    if (!existsSync(seedDb)) {
      throw new Error(`种子库不存在：${seedDb}（先用 pnpm package:desktop 产出带 seed 的产物）`)
    }
    copyFileSync(seedDb, dbPath)
    rehomeSeedArtifacts(home, dbPath)
  }

  return { root, home, userDataDir, dbPath, settingsPath, seedMode }
}

export function removeHome(home: HomeContext): void {
  if (process.env.YXS_KEEP_HOMES === '1') return
  rmSync(home.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
