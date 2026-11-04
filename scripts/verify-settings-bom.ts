/**
 * 自查：配置文件带 BOM 时还能不能读到 API Key。
 *
 * 背景（issue #18）：PowerShell 的 `Set-Content -Encoding utf8` 会写 BOM，
 * Node 的 `JSON.parse` 遇到 BOM 直接抛错，旧代码 `catch { return {} }` 把它
 * 当成「没配置」，于是软件报 `DEEPSEEK_API_KEY is not configured`，而文件里
 * 明明有 Key。老师用 bat 配环境最容易踩这个坑。
 *
 * 跑法：pnpm exec tsx scripts/verify-settings-bom.ts
 * 退出码 0 = 全过。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore } from '../apps/desktop/src/main/settings.js'

const dir = mkdtempSync(join(tmpdir(), 'yx-settings-'))
let failed = 0

function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failed += 1
}

const KEY = 'sk-test-0000000000000000000000000000'

try {
  // 1. 带 BOM 的合法 JSON：必须读出来
  const bomPath = join(dir, 'bom.json')
  writeFileSync(bomPath, `\uFEFF${JSON.stringify({ apiKey: KEY, model: 'deepseek-chat' })}`, 'utf8')
  const bomStore = new SettingsStore(bomPath)
  check('带 BOM 的配置能读出 apiKey', bomStore.read().apiKey === KEY, bomStore.read().apiKey || '(空)')
  check('带 BOM 时不报 configError', bomStore.readPublic().configError === undefined)

  // 2. 不带 BOM：老行为不能坏
  const plainPath = join(dir, 'plain.json')
  writeFileSync(plainPath, JSON.stringify({ apiKey: KEY }), 'utf8')
  check('不带 BOM 的配置照常读取', new SettingsStore(plainPath).read().apiKey === KEY)

  // 3. 文件不存在：等于没配置，且不算错误
  const missing = new SettingsStore(join(dir, 'nope.json')).readPublic()
  check('文件不存在时不报 configError', missing.configError === undefined)
  check('文件不存在时 hasApiKey=false', missing.hasApiKey === false)

  // 4. 文件存在但内容坏了：要能区分出「配置坏了」
  const badPath = join(dir, 'bad.json')
  writeFileSync(badPath, '{ "apiKey": "sk-xxx"', 'utf8')
  const bad = new SettingsStore(badPath).readPublic()
  check('坏 JSON 会给出 configError', typeof bad.configError === 'string', bad.configError ?? '(无)')
  check('坏 JSON 时 hasApiKey=false', bad.hasApiKey === false)

  // 5. 写回时修复：写一次之后 BOM 消失，configError 清空
  const repairPath = join(dir, 'repair.json')
  writeFileSync(repairPath, `\uFEFF${JSON.stringify({ apiKey: KEY })}`, 'utf8')
  const repair = new SettingsStore(repairPath)
  repair.write({ model: 'deepseek-chat' })
  check('写回后 Key 保留', repair.read().apiKey === KEY)
  const raw = (await import('node:fs')).readFileSync(repairPath, 'utf8')
  check('写回后文件不再有 BOM', raw.charCodeAt(0) !== 0xfeff)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
