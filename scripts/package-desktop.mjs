#!/usr/bin/env node
/**
 * Build the Windows installer + unpacked app; artifacts land in `release/`.
 * electron-builder collects the dependency tree, packs the asar and emits NSIS;
 * this script only builds the runtime workspace packages, seeds the DB, cleans up.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = join(repoRoot, 'apps', 'desktop')
const require = createRequire(import.meta.url)
const seedHome = join(repoRoot, '.scratch', 'package-seed-home')
const seedTarget = join(desktopDir, 'seed', 'learning.db')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...options.env },
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`)
  }
}

function buildSeedDatabase() {
  // Prefer a recorded sample home; otherwise seed fresh (no sample conversations).
  const recordedHome = process.env.LEARNING_AGENT_SAMPLE_HOME ?? join(repoRoot, '.scratch', 'sample-home')
  const recordedDb = join(recordedHome, 'data', 'learning.db')
  let source
  let cleanup
  if (existsSync(recordedDb)) {
    source = recordedDb
    console.log(`[package] 使用已录制的示例库：${recordedDb}`)
  } else {
    rmSync(seedHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    run('pnpm', ['db:seed'], { env: { LEARNING_AGENT_HOME: seedHome } })
    run('pnpm', ['db:seed:student'], { env: { LEARNING_AGENT_HOME: seedHome } })
    source = join(seedHome, 'data', 'learning.db')
    cleanup = seedHome
    console.warn('[package] 没有录制好的示例库，种子库不含示例对话')
  }
  if (!existsSync(source)) throw new Error(`seed run produced no database at ${source}`)
  mkdirSync(dirname(seedTarget), { recursive: true })
  rmSync(seedTarget, { force: true })
  // VACUUM INTO writes a consistent copy without the WAL sidecar. The handle
  // must be closed before the temp home can be removed on Windows.
  const sourceDb = new DatabaseSync(source)
  try {
    sourceDb.exec(`VACUUM INTO '${seedTarget.replaceAll('\\', '/')}'`)
  } finally {
    sourceDb.close()
  }
  if (cleanup) rmSync(cleanup, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

/**
 * Reuse the Electron zip the devDependency already unpacked: no download, so
 * packaging works offline and cannot hang on a blocked release host.
 */
function electronDistArg() {
  try {
    const electronDir = dirname(require.resolve('electron/package.json', { paths: [desktopDir] }))
    const dist = join(electronDir, 'dist')
    const marker = process.platform === 'win32' ? 'electron.exe' : 'electron'
    return existsSync(join(dist, marker)) ? [`-c.electronDist=${dist}`] : []
  } catch {
    return []
  }
}

function main() {
  // The main process imports the workspace packages from their built `lib/`,
  // so they must exist before electron-builder collects the dependency tree.
  run('pnpm', ['build'])
  buildSeedDatabase()
  run('pnpm', ['exec', 'electron-builder', '--win', 'nsis', '--publish', 'never', ...electronDistArg()], { cwd: desktopDir })
  rmSync(join(desktopDir, 'seed'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  console.log(JSON.stringify({ output: join(repoRoot, 'release') }, null, 2))
}

main()
