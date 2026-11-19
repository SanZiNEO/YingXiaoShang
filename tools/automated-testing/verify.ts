/**
 * 测试模块自身的静态自检（tsx 直接运行，无第三方依赖）：
 *  1. 用例唯一性：台账 ALL_TCS 与 src/scenarios/*.spec.ts 的 test 标题一一对应；
 *     每条 TC 恰好落在一个文件里，且该文件只含一条 TC；多余 / 缺失 / 重复都报错。
 *  2. 结构与规范：spec 必须从 ../fixtures/test.js 取 test/expect；
 *     禁止 waitForTimeout / setTimeout 等待 / sleep / _electron / 直接 import @playwright/test；
 *     test.describe.skip / test.skip 无注解视为违例，有注解的显式阻塞放行但列出。
 *  3. 依赖台账：每条 TC 至少在注释或断言文本中引用 depsOf(tc) 中的一个实现侧 ID。
 *  4. 证据链：playwright.config.ts 的 reporter 含 ./src/evidence/reporter.ts；
 *     evidence.ts 存在 index.jsonl 追加索引机制。
 *  5. stdout 输出 TC → 文件 → 依赖 ID → 结果对齐表；任一硬性检查失败退出码非 0。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_TCS, depsOf } from './src/scenarios/dependencies.js'

const here = dirname(fileURLToPath(import.meta.url))
const scenariosDir = join(here, 'src', 'scenarios')
const configPath = join(here, 'playwright.config.ts')
const evidencePath = join(here, 'src', 'evidence', 'evidence.ts')

const TC_RE = /TC-(P0|P1)-\d{2}/g
const TITLE_RE = /test\(\s*['"`]([^'"`]*)['"`]/g
const FIXTURES_IMPORT_RE = /from\s+['"]\.\.\/fixtures\/test\.js['"]/

const FORBIDDEN_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /waitForTimeout/, label: 'waitForTimeout 固定等待' },
  { re: /setTimeout/, label: 'setTimeout 等待' },
  { re: /\bsleep\b/, label: 'sleep 等待' },
  { re: /_electron/, label: '直接使用 _electron 启动 Electron' },
  { re: /from\s+['"]@playwright\/test['"]/, label: '直接 import @playwright/test' },
]

const DEP_PREFIX = '(?:BOOT|CH|DATA|SVC|LEG|WIN|UI|IPC|FLOW|EVT|EXT|PKG)'
const DEP_FULL_RE = new RegExp(`\\b${DEP_PREFIX}-\\d+[a-z]?\\b`, 'g')
// 缩写组：UI-07/08/09、DATA-12b/12d、PKG-03/04/06、DATA-06/07
const DEP_GROUP_RE = new RegExp(`\\b(${DEP_PREFIX})-(\\d{2})([a-z]?)((?:\\/\\d{2}[a-z]?)*)`, 'g')

interface SpecRecord {
  rel: string
  text: string
  titles: string[]
  tcs: string[]
}

interface Finding {
  scope: string
  ok: boolean
  message: string
}

function readSpecs(): SpecRecord[] {
  const entries = readdirSync(scenariosDir).filter((name) => /\.spec\.ts$/.test(name))
  return entries.map((name) => {
    const rel = join('src', 'scenarios', name)
    const text = readFileSync(join(scenariosDir, name), 'utf8')
    const titles: string[] = []
    for (const match of text.matchAll(TITLE_RE)) titles.push(match[1] ?? '')
    const tcs: string[] = []
    for (const title of titles) {
      for (const match of title.matchAll(TC_RE)) tcs.push(match[0])
    }
    return { rel, text, titles, tcs }
  })
}

/** 从 spec 文本中提取出现过的实现侧 ID（含缩写组展开）。 */
function extractDepIds(text: string): Set<string> {
  const ids = new Set<string>()
  for (const match of text.matchAll(DEP_FULL_RE)) ids.add(match[0])
  for (const match of text.matchAll(DEP_GROUP_RE)) {
    const prefix = match[1] ?? ''
    const first = match[2] ?? ''
    const letter = match[3] ?? ''
    ids.add(`${prefix}-${first}${letter}`)
    const rest = (match[4] ?? '').split('/').filter((part) => part.length > 0)
    for (const part of rest) ids.add(`${prefix}-${part}`)
  }
  return ids
}

/** 判断一处 test.skip / describe.skip 是否带注解（理由字符串或相邻注释）。 */
function skipIsAnnotated(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index) + 1
  const lineEnd = text.indexOf('\n', index)
  const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
  if (/['"][^'"]{2,}['"]/.test(line)) return true
  const before = text.slice(Math.max(0, lineStart - 240), lineStart)
  if (/\/\/.*(阻塞|跳过|跳过原因|blocked|skip|reason|FIXME|待办)/.test(before)) return true
  return false
}

function collectSkipFindings(spec: SpecRecord, findings: Finding[]): void {
  const skipRe = /test\.(describe\.)?skip\(/g
  for (const match of spec.text.matchAll(skipRe)) {
    const annotated = skipIsAnnotated(spec.text, match.index ?? 0)
    findings.push({
      scope: spec.rel,
      ok: annotated,
      message: annotated
        ? `已注解显式阻塞：${match[0].trim()}（放行，仅列出）`
        : `无注解的 ${match[0].trim()}（必须补充阻塞理由 annotation）`,
    })
  }
}

function main(): number {
  const findings: Finding[] = []
  const specs = readSpecs()

  // TC → 出现的文件列表
  const tcToFiles = new Map<string, string[]>()
  const fileTcCounts = new Map<string, number>()
  for (const spec of specs) {
    fileTcCounts.set(spec.rel, spec.tcs.length)
    for (const tc of spec.tcs) {
      const list = tcToFiles.get(tc) ?? []
      list.push(spec.rel)
      tcToFiles.set(tc, list)
    }
  }

  // 1. 唯一性 / 缺失 / 重复 / 多余
  const known = new Set(ALL_TCS)
  for (const tc of ALL_TCS) {
    const files = tcToFiles.get(tc) ?? []
    if (files.length === 0) {
      findings.push({ scope: tc, ok: false, message: '台账有登记但没有任何 spec 覆盖（缺失）' })
    } else if (files.length > 1) {
      findings.push({ scope: tc, ok: false, message: `重复出现在多个文件：${files.join('、')}` })
    } else {
      const file = files[0]!
      const count = fileTcCounts.get(file) ?? 0
      if (count > 1) {
        findings.push({ scope: tc, ok: false, message: `文件 ${file} 含 ${count} 条 TC，违反“一条 TC 一个文件”` })
      }
    }
  }
  for (const [tc, files] of tcToFiles) {
    if (!known.has(tc)) {
      findings.push({ scope: tc, ok: false, message: `台账外的多余 TC，出现在：${files.join('、')}` })
    }
  }

  // 2. 结构与规范（逐文件）
  for (const spec of specs) {
    if (!FIXTURES_IMPORT_RE.test(spec.text)) {
      findings.push({ scope: spec.rel, ok: false, message: '未从 ../fixtures/test.js 导入 test/expect' })
    }
    for (const forbidden of FORBIDDEN_PATTERNS) {
      if (forbidden.re.test(spec.text)) {
        findings.push({ scope: spec.rel, ok: false, message: `禁用模式：${forbidden.label}` })
      }
    }
    collectSkipFindings(spec, findings)
  }

  // 3. 依赖台账（逐 TC，文本取其所属文件全文）
  const rows = ALL_TCS.map((tc) => {
    const files = tcToFiles.get(tc) ?? []
    const rel = files.length === 1 ? files[0]! : files.join('、')
    const spec = specs.find((item) => item.rel === rel)
    const referenced = spec ? extractDepIds(spec.text) : new Set<string>()
    const expected = depsOf(tc)
    const hit = expected.filter((id) => referenced.has(id))
    const missingDeps = files.length > 0 && hit.length === 0
    if (missingDeps) {
      findings.push({
        scope: tc,
        ok: false,
        message: `注释/断言中未引用台账依赖 ID（台账：${expected.join(', ')}）`,
      })
    }
    return { tc, rel: rel || '—', expected, hit, missingDeps, files }
  })

  // 4. 证据链
  if (!existsSync(configPath)) {
    findings.push({ scope: 'playwright.config.ts', ok: false, message: '配置文件不存在' })
  } else {
    const configText = readFileSync(configPath, 'utf8')
    if (!configText.includes('./src/evidence/reporter.ts')) {
      findings.push({ scope: 'playwright.config.ts', ok: false, message: "reporter 未包含 './src/evidence/reporter.ts'" })
    }
  }
  if (!existsSync(evidencePath)) {
    findings.push({ scope: 'src/evidence/evidence.ts', ok: false, message: '证据模块不存在' })
  } else {
    const evidenceText = readFileSync(evidencePath, 'utf8')
    if (!evidenceText.includes('index.jsonl')) {
      findings.push({ scope: 'src/evidence/evidence.ts', ok: false, message: '缺少 index.jsonl 索引机制' })
    }
    if (!/appendFileSync/.test(evidenceText)) {
      findings.push({ scope: 'src/evidence/evidence.ts', ok: false, message: 'index.jsonl 缺少追加写入（appendFileSync）' })
    }
  }

  // 5. 输出对齐表
  const failFindings = findings.filter((item) => !item.ok)
  const noteFindings = findings.filter((item) => item.ok)

  console.log('# 测试模块静态自检对齐表')
  console.log('')
  console.log('| TC | 文件 | 台账依赖 ID | 文本中命中的依赖 | 结果 |')
  console.log('|---|---|---|---|---|')
  for (const row of rows) {
    const result = row.missingDeps || row.files.length !== 1
      ? '❌ 未通过'
      : '✅ 通过'
    console.log(
      `| ${row.tc} | ${row.rel} | ${row.expected.join(', ') || '—'} | ${row.hit.join(', ') || '—'} | ${result} |`,
    )
  }
  // 台账外多余 TC 也进表
  for (const [tc, files] of tcToFiles) {
    if (!known.has(tc)) {
      console.log(`| ${tc} | ${files.join('、')} | — | — | ❌ 台账外多余 |`)
    }
  }

  console.log('')
  console.log(`## 硬性违例汇总（${failFindings.length} 项）`)
  console.log('')
  if (failFindings.length === 0) {
    console.log('- 无')
  } else {
    for (const item of failFindings) console.log(`- [${item.scope}] ${item.message}`)
  }

  if (noteFindings.length > 0) {
    console.log('')
    console.log('## 已注解 / 放行项')
    console.log('')
    for (const item of noteFindings) console.log(`- [${item.scope}] ${item.message}`)
  }

  console.log('')
  console.log(`自检结论：${failFindings.length === 0 ? '全部硬性检查通过' : `${failFindings.length} 项硬性检查未通过`}`)
  return failFindings.length === 0 ? 0 : 1
}

process.exit(main())
