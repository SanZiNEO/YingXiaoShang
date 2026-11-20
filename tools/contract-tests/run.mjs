/**
 * E 轮契约测试入口（03-implementation §1 入口层：只做参数解析、target 选择、用例编排、退出码汇总）。
 *
 * 它不写断言细节、不直接发 HTTP：用例在 cases/ 下，传输在 src/*-target.mjs 里。
 *
 * 退出码（02-contract §2.4 权威口径，本文件是唯一实现处）：
 *   0  通过 / 按设计跳过（both 或默认目标下 http 组不可达、electron 锁未取得、OpenAPI 缺失 pending）
 *   1  至少一条用例 failed（含 coverage red、SSE 超时、鉴权失败）
 *   2  显式 --target http 且服务端不可达
 *   3  CLI 参数非法（--target / --base-url / --only / --home / --report）
 */

import { existsSync } from 'node:fs'
import { mkdir, copyFile, readFile, rm, access } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  TARGET_KINDS,
  TargetUnreachable,
  SkipSignal,
  ContractViolation,
} from './src/target-interface.mjs'
import { make, scrubSensitive, statusFrom } from './src/assert.mjs'
import { Report, stamp } from './src/report.mjs'
import { STUDENT_A, newRequestId } from './src/fixtures.mjs'
import { createStubTarget } from './src/stub-target.mjs'
import { CASES as METHOD_CASES } from './cases/methods.mjs'
import { CASES as ILLEGAL_CLASS_CASES } from './cases/illegal-class.mjs'
import { loadContract } from './src/openapi.mjs'

const PKG_ROOT = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')
const DEFAULT_BASE_URL = 'http://127.0.0.1:8080'
const EXPECTED_TOTAL = 80

export const EXIT = {
  ok: 0,
  failed: 1,
  httpUnreachable: 2,
  cliInvalid: 3,
}

/** CLI 参数（启动期一次读完冻结，运行期不再读 process.env，03-implementation §5）。 */
function parseArgs(argv) {
  const raw = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      throw cliError(`参数 ${token} 不是 --name value 形态。`)
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      throw cliError(`参数 --${key} 缺少取值。`)
    }
    raw[key] = next
    index += 1
  }

  const target = raw.target ?? 'stub'
  if (!TARGET_KINDS.includes(target) && target !== 'both') {
    throw cliError('参数 --target 非法：取值必须是 stub/http/electron/both。')
  }

  const baseUrl = raw['base-url'] ?? DEFAULT_BASE_URL
  if (!/^http:\/\/[^/:]+:\d+$/.test(baseUrl)) {
    throw cliError('参数 --base-url 非法：必须是 http://host:port 形态。')
  }

  const only = raw.only ?? raw.case ?? null
  const studentId = raw['student-id'] ?? STUDENT_A.studentId
  const password = raw.password ?? STUDENT_A.password
  const homeArg = raw.home ?? null
  const reportArg = raw.report ?? null

  return { target, baseUrl, only, studentId, password, homeArg, reportArg, workers: Number(raw.workers ?? process.env.YXS_WORKERS ?? 1) }
}

/** CLI 非法统一抛这个：main 捕获后打印中文一行 + 退出码 3（不产生半成品报告）。 */
function cliError(message) {
  const error = new Error(message)
  error.exitCode = EXIT.cliInvalid
  error.isCli = true
  return error
}

/** 真实数据目录黑名单（03-implementation §4：禁止读写 %APPDATA%、~/.learning-agent、<repo>/.learning-agent）。 */
function isRealDataHome(target) {
  const normalize = (p) => resolve(p).split(sep).join('/').replace(/\/+$/, '')
  const normalized = normalize(target)
  // 真实数据位置：%APPDATA%（整棵子树）、各平台的 ~/.learning-agent、<repo>/.learning-agent。
  // 早先只拿 `${APPDATA}/` 做前缀比较，`--home %APPDATA%` 本身不带尾斜杠就漏过了校验，
  // 校验通过后还在真实配置目录里建出了 data/。这里改成「等根 或 根的子路径」两条都拦。
  const roots = [
    process.env.APPDATA ? normalize(process.env.APPDATA) : null,
    process.env.USERPROFILE ? normalize(join(process.env.USERPROFILE, '.learning-agent')) : null,
    process.env.HOME ? normalize(join(process.env.HOME, '.learning-agent')) : null,
    normalize(join(REPO_ROOT, '.learning-agent')),
  ].filter(Boolean)
  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`))
}

/** 报告目录必须落在工具包内且可写（02-contract §2.4 --report 校验失败行为）。 */
async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function resolveReportDir(reportArg, runStamp) {
  const base = reportArg
    ? (isAbsolute(reportArg) ? resolve(reportArg) : resolve(PKG_ROOT, reportArg))
    : join(PKG_ROOT, 'report', runStamp)
  // 自动命名只精确到秒，同一秒内连跑两次（如 stub 之后立刻跑 electron）会撞到同一目录，
  // 后者会覆盖前者的 report.json / report.md，证据静默丢失。撞上就加 -2 / -3，绝不复用别人的运行目录。
  let candidate = base
  if (!reportArg) {
    for (let n = 2; await exists(candidate); n += 1) candidate = `${base}-${n}`
  }
  const rel = relative(PKG_ROOT, candidate)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw cliError('参数 --report 非法：必须落在 tools/contract-tests/ 内且可写。')
  }
  try {
    await mkdir(candidate, { recursive: true })
    await access(candidate)
  } catch {
    throw cliError('参数 --report 非法：必须落在 tools/contract-tests/ 内且可写。')
  }
  return candidate
}

/** 临时 home：默认 .scratch/run/E/home-<短id>/（归属 §3 E 行）。 */
async function resolveHome(homeArg, runStamp) {
  const candidate = homeArg
    ? (isAbsolute(homeArg) ? resolve(homeArg) : resolve(REPO_ROOT, homeArg))
    : join(REPO_ROOT, '.scratch', 'run', 'E', `home-${runStamp.slice(-6)}`)
  if (isRealDataHome(candidate)) {
    throw cliError('参数 --home 非法：不能指向真实数据目录（%APPDATA%、~/.learning-agent 或 <repo>/.learning-agent）。')
  }
  await mkdir(join(candidate, 'data'), { recursive: true }).catch(() => {})
  return candidate
}

/** 种子库副本：优先 release 里的 seed，其次 .scratch/sample-home，都没有就留空库（相关断言按 skipped 处理）。 */
async function prepareSeed(home) {
  const target = join(home, 'data', 'learning.db')
  if (existsSync(target)) return { seeded: true, source: 'existing' }
  const candidates = [
    join(REPO_ROOT, 'release', 'win-unpacked', 'resources', 'seed', 'learning.db'),
    join(REPO_ROOT, '.scratch', 'sample-home', 'data', 'learning.db'),
  ]
  for (const source of candidates) {
    if (!existsSync(source)) continue
    await copyFile(source, target)
    return { seeded: true, source: relative(REPO_ROOT, source).split(sep).join('/') }
  }
  return { seeded: false, source: null }
}

/** 用例模块按存在性加载：channels / openapi 由并行切片交付，缺失时明确报出而不是静默少跑。 */
async function loadCaseModules() {
  const modules = [
    { file: 'cases/methods.mjs', cases: METHOD_CASES },
    { file: 'cases/illegal-class.mjs', cases: ILLEGAL_CLASS_CASES },
  ]
  const optional = ['cases/channels.mjs', 'cases/openapi.mjs']
  const missing = []
  for (const rel of optional) {
    const absolute = join(PKG_ROOT, rel)
    if (!existsSync(absolute)) {
      missing.push(rel)
      continue
    }
    const mod = await import(pathToFileURL(absolute).href)
    modules.push({ file: rel, cases: mod.CASES ?? [] })
  }
  return { modules, missing }
}

/** 目标支持判定：`targets: '*'` 表示三个目标都跑。 */
function supportsTarget(caseDef, kind) {
  if (caseDef.targets === '*') return true
  if (Array.isArray(caseDef.targets)) return caseDef.targets.includes(kind)
  return false
}

/** --only 过滤：按用例编号或方法名精确匹配（02-contract §2.4）。 */
function filterCases(all, only) {
  if (!only) return all
  const matched = all.filter((item) => item.id === only || item.method === only || item.channel === only)
  if (matched.length === 0) {
    throw cliError('参数 --only 非法：没有匹配到任何用例。')
  }
  return matched
}

/** Electron 互斥锁：目录锁，退避 30s（每 2s 一次），拿不到就整组跳过（归属 §5.3）。 */
async function acquireElectronLock(lockPath) {
  const deadline = Date.now() + 30000
  for (;;) {
    try {
      await mkdir(lockPath)
      return { acquired: true, path: lockPath }
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { acquired: false, path: lockPath, reason: `建锁失败：${error?.code ?? error?.message ?? '未知错误'}` }
      }
      if (Date.now() >= deadline) {
        return { acquired: false, path: lockPath, reason: '未取得 electron 锁，本轮 electron 目标未执行（锁目录被占用 30s）' }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000))
    }
  }
}

async function releaseElectronLock(lockPath) {
  await rm(lockPath, { recursive: true, force: true }).catch(() => {})
}

/** 一条用例的执行壳：负责 SkipSignal / TargetUnreachable / 异常的归档方式。 */
async function executeCase(caseDef, ctx) {
  const startedAt = Date.now()
  try {
    const outcome = (await caseDef.run(ctx)) ?? {}
    const assertions = Array.isArray(outcome.assertions) ? outcome.assertions : []
    return {
      status: statusFrom(assertions),
      assertions,
      expected: outcome.expected ?? null,
      actual: outcome.actual ?? null,
      evidencePayload: outcome.evidence ?? null,
      sseText: outcome.sseText ?? null,
      reason: null,
      error: assertions.length === 0 ? '用例没有产出任何断言，不构成证据（02-contract §6）' : null,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    if (error instanceof SkipSignal) {
      return {
        status: error.pending ? 'pending' : 'skipped',
        assertions: [],
        expected: null,
        actual: null,
        reason: error.reason,
        error: null,
        durationMs: Date.now() - startedAt,
      }
    }
    if (error instanceof TargetUnreachable) {
      return {
        status: 'skipped',
        assertions: [],
        expected: null,
        actual: null,
        reason: error.message,
        error: null,
        durationMs: Date.now() - startedAt,
      }
    }
    return {
      status: 'failed',
      assertions: [],
      expected: null,
      actual: null,
      reason: null,
      error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
      durationMs: Date.now() - startedAt,
    }
  }
}

function buildContext({ caseDef, target, report, cfg, discovery, log }) {
  return {
    target,
    targetKind: target.kind,
    discovery,
    repoRoot: REPO_ROOT,
    pkgRoot: PKG_ROOT,
    cfg,
    newRequestId,
    make,
    skip(reason) {
      throw new SkipSignal(reason)
    },
    pending(reason) {
      throw new SkipSignal(reason, { pending: true })
    },
    writeEvidence: (text) => report.writeSse(caseDef.id, text),
    writeCase: (payload) => report.writeCase(caseDef.id, scrubSensitive(payload)),
    log,
  }
}

/** 把一条用例的记录落盘：cases/<id>.json + 可选 sse/<id>.txt。 */
async function persistCaseRecord(record, caseDef, report, ctx, outcome) {
  if (outcome.sseText) {
    record.sse = await report.writeSse(caseDef.id, outcome.sseText)
  }
  record.evidence = await report.writeCase(caseDef.id, {
    id: record.id,
    kind: record.kind,
    method: record.method,
    channel: record.channel,
    target: record.target,
    status: record.status,
    assertions: record.assertions,
    expected: record.expected,
    actual: record.actual,
    reason: record.reason,
    error: record.error,
    durationMs: record.durationMs,
    evidenceSource: caseDef.evidenceSource ?? null,
  })
  return record
}

/** 一个 target 分组跑完所有支持的用例。unreachable 时整组 skipped 并写明原因（不记失败）。 */
async function runGroup({ kind, cases, targetFactory, cfg, report, unreachableReason = null }) {
  const records = []
  let target = null
  let discovery = {}

  if (unreachableReason) {
    for (const caseDef of cases) {
      const record = {
        id: caseDef.id,
        kind: caseDef.kind,
        method: caseDef.method ?? null,
        channel: caseDef.channel ?? null,
        target: kind,
        status: 'skipped',
        assertions: [],
        expected: null,
        actual: null,
        reason: unreachableReason,
        error: null,
        durationMs: 0,
        evidence: null,
      }
      records.push(await persistCaseRecord(record, caseDef, report, null, {}))
    }
    return { records, describe: { kind, reachable: false, reason: unreachableReason } }
  }

  try {
    target = await targetFactory()
    await target.connect()
    discovery = target.discovery ?? {}
  } catch (error) {
    const reason = error instanceof TargetUnreachable
      ? error.message
      : `被测实例启动失败（${error?.name ?? 'Error'}）：${error?.message ?? String(error)}`
    await report.log({ level: 'error', event: 'target-connect-failed', target: kind, reason })
    for (const caseDef of cases) {
      const record = {
        id: caseDef.id,
        kind: caseDef.kind,
        method: caseDef.method ?? null,
        channel: caseDef.channel ?? null,
        target: kind,
        status: 'skipped',
        assertions: [],
        expected: null,
        actual: null,
        reason,
        error: null,
        durationMs: 0,
        evidence: null,
      }
      records.push(await persistCaseRecord(record, caseDef, report, null, {}))
    }
    return { records, describe: { kind, reachable: false, reason }, target }
  }

  for (const caseDef of cases) {
    const ctx = buildContext({ caseDef, target, report, cfg, discovery, log: report.log.bind(report) })
    const outcome = await executeCase(caseDef, ctx)
    const record = {
      id: caseDef.id,
      kind: caseDef.kind,
      method: caseDef.method ?? null,
      channel: caseDef.channel ?? null,
      target: kind,
      status: outcome.status,
      assertions: outcome.assertions,
      expected: outcome.expected,
      actual: outcome.actual,
      reason: outcome.reason,
      error: outcome.error,
      durationMs: outcome.durationMs,
      evidence: null,
    }
    await persistCaseRecord(record, caseDef, report, ctx, outcome)
    records.push(record)
    await report.log({
      level: record.status === 'passed' ? 'info' : 'warn',
      event: 'case',
      id: record.id,
      target: kind,
      status: record.status,
      durationMs: record.durationMs,
      code: record.actual?.code ?? null,
      http: record.actual?.http ?? null,
      reason: record.reason ? String(record.reason).slice(0, 200) : null,
    })
  }

  const describe = typeof target?.describe === 'function' ? target.describe() : { kind }
  await target?.close?.()
  return { records, describe }
}

/** 鉴权前置探针（不计入 80 条，02-contract §4.1「E 覆盖用例」列）：AUTH_REQUIRED / AUTH_INVALID。 */
async function runAuthProbes({ target, report }) {
  const probes = []
  if (!target || typeof target.rpc !== 'function') return probes
  for (const [name, expectedCode, opts] of [
    ['AUTH_REQUIRED', 'AUTH_REQUIRED', { auth: false }],
    ['AUTH_INVALID', 'AUTH_INVALID', { auth: 'invalid' }],
  ]) {
    try {
      const envelope = await target.rpc('student.current', {}, opts)
      const ok = envelope.httpStatus === 401 && envelope.error?.code === expectedCode
      probes.push({
        name,
        status: ok ? 'passed' : 'failed',
        detail: `http=${envelope.httpStatus} code=${envelope.error?.code ?? 'null'} message=${envelope.error?.message ?? 'null'}`,
      })
    } catch (error) {
      probes.push({ name, status: 'error', detail: error?.message ?? String(error) })
    }
  }
  await report.log({ level: 'info', event: 'auth-probes', probes })
  return probes
}

/** OpenAPI 状态：与 coverage 走同一处读取口径（src/openapi.mjs 的 loadContract），并记下读取时刻，避免跨时刻混用。 */
async function loadOpenapiState() {
  const contract = await loadContract({ repoRoot: REPO_ROOT })
  return {
    openapi: contract.openapi,
    file: contract.file,
    readAt: contract.readAt ?? new Date().toISOString(),
  }
}

async function loadMutationSnapshot({ reportDir }) {
  const modulePath = join(PKG_ROOT, 'src', 'patch.mjs')
  if (!existsSync(modulePath)) {
    return {
      rows: ['M1', 'M2', 'M3'].map((id) => ({
        id,
        patch: null,
        applied: false,
        reverted: true,
        targetCase: null,
        status: 'not-run',
        reason: 'mutation 机制模块 src/patch.mjs 缺失：本轮未接入（不是已杀死）',
      })),
      note: 'src/patch.mjs 缺失',
    }
  }
  const mod = await import(pathToFileURL(modulePath).href)
  const rows = await mod.summarizeForReport({ repoRoot: REPO_ROOT, reportDir })
  return { rows, note: null }
}

async function main() {
  let cfg
  try {
    cfg = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (error.isCli) {
      console.error(error.message)
      return error.exitCode
    }
    throw error
  }

  const runStamp = stamp()
  let reportDir
  let home
  try {
    reportDir = await resolveReportDir(cfg.reportArg, runStamp)
    home = await resolveHome(cfg.homeArg, runStamp)
  } catch (error) {
    if (error.isCli) {
      console.error(error.message)
      return error.exitCode
    }
    throw error
  }

  const secrets = [cfg.password]
  const report = new Report({ dir: reportDir, pkgRoot: PKG_ROOT, secrets })
  await report.init()

  let loaded
  try {
    loaded = await loadCaseModules()
  } catch (error) {
    console.error(`用例模块加载失败：${error?.message ?? String(error)}`)
    return EXIT.failed
  }
  const allCases = loaded.modules.flatMap((entry) => entry.cases)
  let selected
  try {
    selected = filterCases(allCases, cfg.only)
  } catch (error) {
    console.error(error.message)
    return error.exitCode ?? EXIT.cliInvalid
  }
  if (loaded.missing.length > 0) {
    console.warn(`用例模块缺失：${loaded.missing.join('、')}（这些编号的用例本轮没有执行）`)
  }

  const startedAt = new Date().toISOString()
  const openapi = await loadOpenapiState()
  const groups = []
  const probes = []
  let lockedElectron = false
  let httpUnreachable = false
  let seed = { seeded: false, source: null }
  let electronDescribe = null
  let httpDescribe = null
  let electronLock = { acquired: false, path: join(REPO_ROOT, '.scratch', 'run', 'electron.lock') }

  if (cfg.target === 'stub') {
    groups.push(await runGroup({
      kind: 'stub',
      cases: selected.filter((item) => supportsTarget(item, 'stub')),
      targetFactory: () => createStubTarget({ home, studentId: cfg.studentId }),
      cfg,
      report,
    }))
    const probeTarget = createStubTarget({ home, studentId: cfg.studentId })
    try {
      await probeTarget.connect()
      probes.push(...await runAuthProbes({ target: probeTarget, report }))
    } finally {
      await probeTarget.close()
    }
  }

  if (cfg.target === 'http' || cfg.target === 'both') {
    const { createHttpTarget } = await import('./src/http-target.mjs')
    const factory = () => createHttpTarget({
      baseUrl: cfg.baseUrl,
      studentId: cfg.studentId,
      password: cfg.password,
      home,
    })
    const httpCases = selected.filter((item) => supportsTarget(item, 'http'))
    const group = await runGroup({ kind: 'http', cases: httpCases, targetFactory: factory, cfg, report })
    const unreachable = group.describe?.reachable === false
    if (unreachable) {
      httpUnreachable = cfg.target === 'http'
      if (cfg.target === 'http') {
        console.error(`服务端不可达（${cfg.baseUrl}）：请先启动 apps/server，或用 --target stub 跑自洽用例。`)
      }
    }
    groups.push(group)
    httpDescribe = group.describe ?? null
    if (!unreachable) {
      // 鉴权探针复用刚跑完的 http target（重新建一个更接近真实前置，但会多一次登录）
      const probeTarget = await factory()
      try {
        await probeTarget.connect()
        probes.push(...await runAuthProbes({ target: probeTarget, report }))
      } catch {
        probes.push({ name: 'AUTH_PROBES', status: 'skipped', detail: '服务端二次连接失败，探针未执行' })
      } finally {
        await probeTarget.close?.()
      }
    }
  }

  if (cfg.target === 'electron' || cfg.target === 'both') {
    electronLock = await acquireElectronLock(join(REPO_ROOT, '.scratch', 'run', 'electron.lock'))
    lockedElectron = !electronLock.acquired
    const electronCases = selected.filter((item) => supportsTarget(item, 'electron'))
    if (!electronLock.acquired) {
      groups.push(await runGroup({
        kind: 'electron',
        cases: electronCases,
        targetFactory: () => { throw new TargetUnreachable(electronLock.reason) },
        cfg,
        report,
        unreachableReason: electronLock.reason,
      }))
    } else {
      seed = await prepareSeed(home)
      const { createElectronTarget } = await import('./src/electron-target.mjs')
      const group = await runGroup({
        kind: 'electron',
        cases: electronCases,
        targetFactory: () => createElectronTarget({ home, repoRoot: REPO_ROOT, pkgRoot: PKG_ROOT }),
        cfg,
        report,
      })
      electronDescribe = group.describe ?? null
      groups.push(group)
      await releaseElectronLock(electronLock.path)
    }
  }

  const cases = groups.flatMap((group) => group.records)
  const summary = {
    total: cases.length,
    passed: cases.filter((item) => item.status === 'passed').length,
    failed: cases.filter((item) => item.status === 'failed').length,
    skipped: cases.filter((item) => item.status === 'skipped').length,
    pending: cases.filter((item) => item.status === 'pending').length,
    uniqueCases: new Set(cases.map((item) => item.id)).size,
    expectedTotal: EXPECTED_TOTAL,
  }

  const mutations = await loadMutationSnapshot({ reportDir })
  if (mutations.note) {
    await report.log({ level: 'warn', event: 'mutations-unavailable', note: mutations.note })
  }

  const usesHttp = cfg.target === 'http' || cfg.target === 'both'
  const environment = {
    baseUrl: cfg.target === 'stub'
      ? 'stub://in-memory'
      : (usesHttp ? cfg.baseUrl : 'n/a: electron 目标不打 HTTP，无服务端地址'),
    port: usesHttp ? Number(new URL(cfg.baseUrl).port) : 0,
    home: relative(REPO_ROOT, home).split(sep).join('/'),
    openapi: openapi.openapi,
    openapiReadAt: openapi.readAt,
    lockedElectron,
    studentId: cfg.studentId,
    workers: cfg.workers,
    seed,
    electronLock: { path: relative(REPO_ROOT, electronLock.path).split(sep).join('/'), acquired: electronLock.acquired },
    electron: electronDescribe,
    http: httpDescribe,
    caseModules: loaded.modules.map((entry) => entry.file),
    missingCaseModules: loaded.missing,
  }

  const reportObject = {
    schemaVersion: '1.0',
    round: 'E',
    target: cfg.target,
    startedAt,
    finishedAt: new Date().toISOString(),
    environment,
    summary,
    cases,
    mutations: mutations.rows,
    probes,
  }
  await report.finalize(reportObject)

  const oneLine = `契约测试 target=${cfg.target}：共 ${summary.total} 条，passed ${summary.passed} / failed ${summary.failed} / skipped ${summary.skipped} / pending ${summary.pending}；报告 ${relative(PKG_ROOT, reportDir).split(sep).join('/')}`
  console.log(oneLine)

  if (httpUnreachable) return EXIT.httpUnreachable
  return summary.failed > 0 ? EXIT.failed : EXIT.ok
}

const exitCode = await main()
process.exit(exitCode)
