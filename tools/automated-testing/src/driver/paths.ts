import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 仓库根：tools/automated-testing/src/driver → 上四级。 */
export const repoRoot = resolve(here, '..', '..', '..', '..')
/** 本测试模块根。 */
export const moduleRoot = resolve(here, '..', '..')
export const desktopDir = join(repoRoot, 'apps', 'desktop')
export const outMain = join(desktopDir, 'out', 'main', 'index.js')
export const outRenderer = join(desktopDir, 'out', 'renderer', 'index.html')
/** 允许用 YXS_PACKAGED_DIR 指向 release/win-unpacked 的临时拷贝，打包用例各自隔离。 */
export function packagedAppDir(): string {
  const override = process.env.YXS_PACKAGED_DIR
  return override && override.length > 0 ? resolve(override) : join(repoRoot, 'release', 'win-unpacked')
}
export function packagedExePath(): string {
  return join(packagedAppDir(), '营小商.exe')
}
export function packagedSeedPath(): string {
  return join(packagedAppDir(), 'resources', 'seed', 'learning.db')
}
export const packagedExe = join(repoRoot, 'release', 'win-unpacked', '营小商.exe')
export const packagedSeedDb = join(repoRoot, 'release', 'win-unpacked', 'resources', 'seed', 'learning.db')
export const artifactsRoot = join(moduleRoot, '.artifacts')

/** 被测 Electron 可执行文件（devDependencies 里的 electron 包导出其路径）。 */
export function electronBinary(): string {
  const require = createRequire(join(desktopDir, 'package.json'))
  const resolved = require('electron') as unknown
  if (typeof resolved !== 'string' || !existsSync(resolved)) {
    throw new Error(`electron 包没有返回可执行文件路径：${String(resolved)}`)
  }
  return resolved
}

export type TargetKind = 'out' | 'packaged'

export interface LaunchTarget {
  kind: TargetKind
  executablePath: string
  cwd: string
  args: string[]
}

export function resolveTarget(kind: TargetKind, userDataDir: string): LaunchTarget {
  if (kind === 'packaged') {
    const appDir = packagedAppDir()
    const exe = join(appDir, '营小商.exe')
    if (!existsSync(exe)) throw new Error(`打包产物不存在：${exe}（先跑 pnpm package:desktop）`)
    return {
      kind,
      executablePath: exe,
      cwd: appDir,
      args: [`--user-data-dir=${userDataDir}`],
    }
  }
  if (!existsSync(outMain) || !existsSync(outRenderer)) {
    throw new Error(`out/ 构建产物不完整：${outMain}`)
  }
  return {
    kind,
    executablePath: electronBinary(),
    cwd: desktopDir,
    // Chromium 开关必须排在应用路径之前，Electron 才会把 userData 指到隔离目录。
    args: [`--user-data-dir=${userDataDir}`, '.'],
  }
}
