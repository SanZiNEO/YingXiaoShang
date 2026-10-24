import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 读 .env 补进 process.env。Electron 启动时不自动加载 .env；已存在的变量优先。
 */
export function loadDotEnv(roots: string[]): void {
  for (const root of roots) {
    const file = join(root, '.env')
    if (!existsSync(file)) continue
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue
      const at = trimmed.indexOf('=')
      if (at <= 0) continue
      const key = trimmed.slice(0, at).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
      const value = trimmed.slice(at + 1).trim().replace(/^["']|["']$/g, '')
      if (value.length === 0) continue
      if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value
    }
  }
}
