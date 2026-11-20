#!/usr/bin/env node
/**
 * tools/loadtest/scenario.mjs — F 轮压测 CLI 入口。
 * 职责：解析参数与配置 → 选目标（stub/http）→ 预检 → 抓起始指标快照 → 跑 VU → 抓结束快照 → 汇总 → 落 md/json 报告 → 退出码。
 * 不做 HTTP 细节、不算分位数、不渲染报告：这些分别归 src/client.mjs、src/summarize.mjs、src/report.mjs。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { createStubServer } from './src/stub.mjs'
import { analyzeSnapshot, diffSnapshots } from './src/metrics.mjs'
import { YxsClient } from './src/client.mjs'
import { runVus, buildStudentIds } from './src/scenario.mjs'
import { buildReportData } from './src/summarize.mjs'
import { writeReport } from './src/report.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const SCOPED_ROOT = path.join(REPO_ROOT, '.scratch', 'run', 'F')

const TOOL_VERSION = '0.1.0'

/**
 * 默认值表；命令行优先于 --config 指定的配置文件。
 * 键名与 CLI 参数名（kebab-case）一致，`pick()` 用它做默认值兜底；
 * 配置文件里的 camelCase 键名由 `pick` 的第三个参数单独映射。
 */
const DEFAULTS = {
  target: 'stub',
  'base-url': 'http://127.0.0.1:18080',
  students: 40,
  'ramp-up': 5,
  iterations: 1,
  scenario: 'full',
  llm: '',
  home: '.scratch/run/F/home',
  out: '.scratch/run/F/report',
  'token-quota': 200000,
  'metrics-token': '',
  'client-ips': 'distinct',
  password: 'yxs-loadtest',
  config: 'tools/loadtest/config/loadtest.example.json',
  'stub-mutations': ''
}
const ENUM = {
  target: ['stub', 'http'],
  scenario: ['full', 'login', 'ask', 'answer', 'submit'],
  llm: ['mock', 'real'],
  clientIps: ['distinct', 'shared']
}

const HELP = `
tools/loadtest — 营小商服务端压测（F 轮）

用法： node tools/loadtest/scenario.mjs [选项]

选项
  --target <stub|http>        目标类型；stub = 内置内存桩，http = 连 --base-url（默认 stub）
  --base-url <url>            被测服务端根地址（默认 http://127.0.0.1:18080）
  --students <n>              并发虚拟学生数，1..200（默认 40）
  --ramp-up <seconds>         从 0 爬到 --students 的时长，0..300（默认 5）
  --iterations <n>            每个学生重复完整场景的次数，1..20（默认 1）
  --scenario <full|login|ask|answer|submit>   场景裁剪（默认 full）
  --llm <mock|real>           仅记录到报告 meta.llmMode；默认读 YXS_LLM，再退 mock
  --home <dir>                被测实例的 LEARNING_AGENT_HOME，必须在 .scratch/run/F/ 下
  --out <dir>                 报告落点；已存在报告时另起时间戳子目录
  --token-quota <n>           替代 yxs_token_quota 的固定配额，1..10000000（默认 200000）
  --metrics-token <token>     抓 /metrics 用的 Bearer（对应 YXS_METRICS_TOKEN）
  --config <file>             补充配置文件（默认 config/loadtest.example.json）
  --stub-mutations <csv>      仅自检用：M1(首帧 500ms) / M2(不发 done) / M3(缺 30 桶) / M4(改坏 errors 指标名)
  --client-ips <distinct|shared>  登录限流适配（默认 distinct）
                              distinct = 每个 VU 用独立 X-Forwarded-For（服务端按 IP 限流 5 次/分钟）
                              shared   = 全部 VU 共用本机 IP，>5 个学生必然 429（仅用于复现限流）
  --help                      打印本表

退出码  0 = green，1 = 基础设施失败，2 = 阈值越线，3 = 无法判定
`

/** 一次压测的唯一 runId：run_ + 12 位 base36。 */
function newRunId() {
  const n = BigInt('0x' + crypto.randomBytes(8).toString('hex'))
  return 'run_' + n.toString(36).padStart(12, '0').slice(-12)
}

/** 报告子目录名用的时间戳（本地时间，秒级）。 */
function timestampId(date = new Date()) {
  const p = (v, w = 2) => String(v).padStart(w, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

class InfraError extends Error {}

function fail(message) {
  throw new InfraError(message)
}

/** 解析 `--key value` 形式的命令行参数。 */
function parseArgv(argv) {
  const out = {}
  const known = new Set([
    'target', 'base-url', 'students', 'ramp-up', 'iterations', 'scenario', 'llm',
    'home', 'out', 'token-quota', 'metrics-token', 'config', 'stub-mutations', 'client-ips'
  ])
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--help' || token === '-h') {
      out.help = true
      continue
    }
    if (!token.startsWith('--')) fail(`参数 ${token} 非法：只接受 --key value 形式，--help 查看参数表。`)
    const key = token.slice(2)
    if (!known.has(key)) fail(`参数 --${key} 非法：没有这个参数，--help 查看参数表。`)
    if (i + 1 >= argv.length) fail(`参数 --${key} 非法：后面缺少取值。`)
    out[key] = argv[i + 1]
    i += 1
  }
  return out
}

function readConfigFile(configPath, explicit) {
  const abs = path.isAbsolute(configPath) ? configPath : path.join(REPO_ROOT, configPath)
  if (!fs.existsSync(abs)) {
    if (explicit) fail(`参数 --config 非法：配置文件不存在（${configPath}）。`)
    return {}
  }
  let text
  try {
    text = fs.readFileSync(abs, 'utf8')
  } catch (error) {
    fail(`参数 --config 非法：配置读取失败（${configPath}）：${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(`参数 --config 非法：${configPath} 不是合法 JSON（${error.message}）。`)
  }
}

function asInteger(name, raw, min, max) {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    fail(`参数 --${name} 非法：必须是 ${min} 到 ${max} 的整数，收到「${raw}」。`)
  }
  return n
}

function asNumber(name, raw, min, max) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || n > max) {
    fail(`参数 --${name} 非法：必须是 ${min} 到 ${max} 的数字，收到「${raw}」。`)
  }
  return n
}

function asEnum(name, raw, values) {
  if (!values.includes(raw)) fail(`参数 --${name} 非法：只能是 ${values.join(' / ')} 之一，收到「${raw}」。`)
  return raw
}

/** 目录必须在 .scratch/run/F/ 内，禁止指向真实数据目录。 */
function assertScopedDir(name, dir) {
  const abs = path.resolve(REPO_ROOT, dir)
  const rel = path.relative(SCOPED_ROOT, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    fail(`参数 --${name} 非法：只允许落在 .scratch/run/F/ 下，收到「${dir}」。`)
  }
  return abs
}

function normalizeBaseUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    fail(`参数 --base-url 非法：不是合法 URL（${raw}）；必须以 http:// 或 https:// 开头。`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(`参数 --base-url 非法：必须以 http:// 或 https:// 开头，收到「${raw}」。`)
  }
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''))
}

/** 把 --stub-mutations 的 M1..M4 映射成 stub 的 mutations 开关。 */
function parseStubMutations(csv) {
  if (!csv) return {}
  const mutations = {}
  for (const raw of csv.split(',').map((s) => s.trim()).filter(Boolean)) {
    const key = raw.toUpperCase()
    if (key === 'M1') mutations.firstTokenDelayMs = 500
    else if (key === 'M2') mutations.dropDoneAfterTextFrames = 3
    else if (key === 'M3') mutations.missingBuckets = ['30']
    else if (key === 'M4') mutations.renameErrorsMetric = true
    else fail(`参数 --stub-mutations 非法：只接受 M1 / M2 / M3 / M4，收到「${raw}」。`)
  }
  return mutations
}

/** 合并配置：默认值 < --config 同名项 < 命令行。 */
function resolveOptions(argv) {
  const cli = parseArgv(argv)
  if (cli.help) return { help: true }

  const configPath = cli.config || DEFAULTS.config
  const config = readConfigFile(configPath, Boolean(cli.config))

  const pick = (key, cliKey = key, cfgKey = key) => {
    if (cli[cliKey] !== undefined) return cli[cliKey]
    if (config[cfgKey] !== undefined) return config[cfgKey]
    return DEFAULTS[key]
  }

  const target = asEnum('target', String(pick('target')), ENUM.target)
  const baseUrl = normalizeBaseUrl(String(pick('base-url', 'base-url', 'baseUrl')))
  const students = asInteger('students', pick('students'), 1, 200)
  const rampUpSec = asNumber('ramp-up', pick('ramp-up', 'ramp-up', 'rampUpSec'), 0, 300)
  const iterations = asInteger('iterations', pick('iterations'), 1, 20)
  const scenario = asEnum('scenario', String(pick('scenario')), ENUM.scenario)
  const llm = String(pick('llm') ?? '')
  if (llm !== '' && !ENUM.llm.includes(llm)) {
    fail(`参数 --llm 非法：只能是 mock / real 之一，收到「${llm}」。`)
  }
  const home = assertScopedDir('home', String(pick('home')))
  const outRaw = String(pick('out'))
  const outExplicit = cli.out !== undefined || config.out !== undefined
  const out = assertScopedDir('out', outRaw)
  const tokenQuota = asInteger('token-quota', pick('token-quota', 'token-quota', 'tokenQuota'), 1, 10000000)
  const metricsToken = String(pick('metrics-token', 'metrics-token', 'metricsToken') ?? '')
    || String(process.env.YXS_METRICS_TOKEN ?? '')
  const password = String(config.password ?? DEFAULTS.password)
  const stubMutationsCsv = String(cli['stub-mutations'] ?? '')
  const stubMutations = parseStubMutations(stubMutationsCsv)
  const stubFromConfig = config.stub && typeof config.stub === 'object' ? config.stub : {}
  const clientIps = asEnum('client-ips', String(pick('client-ips', 'client-ips', 'clientIps')), ENUM.clientIps)

  const llmMode = llm || process.env.YXS_LLM || 'mock'
  if (!ENUM.llm.includes(llmMode)) {
    fail(`环境变量 YXS_LLM 非法：只能是 mock / real，收到「${llmMode}」。`)
  }

  return {
    target,
    baseUrl,
    students,
    rampUpSec,
    iterations,
    scenario,
    llmMode,
    home,
    homeRaw: String(pick('home')),
    out,
    outExplicit,
    tokenQuota,
    metricsToken,
    password,
    clientIps,
    stubMutations: { ...stubFromConfig, ...stubMutations }
  }
}

/**
 * 端口被占时按 +100 退避（18080 → 18180 → 18280），不 kill 不明进程。
 * 起始端口取自 `--base-url` 的端口，所以换端口只需改 `--base-url`，代码里不留死端口。
 * @param {object} stubOptions
 * @param {number} [preferredPort] 首选端口（默认取 --base-url 的端口）
 */
async function startStubAtFreePort(stubOptions, preferredPort) {
  const base = Number.isInteger(preferredPort) && preferredPort > 0 ? preferredPort : 18080
  const candidates = [base, base + 100, base + 200].filter((p) => p > 0 && p <= 65535)
  const tried = []
  for (const port of candidates) {
    try {
      const stub = await createStubServer({ ...stubOptions, port })
      return { stub, port: stub.port ?? port, tried }
    } catch (error) {
      tried.push(port)
      if (error && (error.code === 'EADDRINUSE' || /EADDRINUSE/.test(String(error.message)))) continue
      fail(`stub 启动失败（端口 ${port}）：${error.message}`)
    }
  }
  fail(`stub 启动失败：端口 ${tried.join('/')} 都被占用，请先释放 ${base} 或改用 --target http。`)
}

/** 报告目录：显式 --out 且为空时直接用；已有报告则另起时间戳子目录，保证复跑不覆盖证据。 */
function resolveReportDir(outDir, explicit) {
  const stamp = timestampId()
  if (!explicit) return path.join(outDir, stamp)
  if (fs.existsSync(path.join(outDir, 'loadtest-report.json'))) return path.join(outDir, stamp)
  return outDir
}

function createRunLog(filePath) {
  const stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' })
  return {
    write(entry) {
      stream.write(JSON.stringify(entry) + '\n')
    },
    close() {
      return new Promise((resolve) => stream.end(resolve))
    }
  }
}

function logLine(entry) {
  // 每请求一行 JSON；只放分类与耗时，不放 token / 口令 / 消息正文 / Authorization。
  return {
    ts: new Date().toISOString(),
    studentId: entry.studentId,
    iteration: entry.iteration,
    scenario: entry.scenario,
    method: entry.method,
    status: entry.status,
    code: entry.code,
    errorClass: entry.errorClass,
    durationMs: entry.durationMs,
    firstTokenMs: entry.firstTokenMs,
    requestId: entry.requestId
  }
}

function printSummary(data, reportPaths) {
   const lines = []
  lines.push(`压测完成：runId=${data.meta.runId}  target=${data.meta.target.type}:${data.meta.target.port}  students=${data.meta.config.students}  llm=${data.meta.llmMode}`)
  lines.push(`请求：total=${data.summary.requestsTotal} ok=${data.summary.requestsOk} failed=${data.summary.requestsFailed} errorRate=${data.summary.errorRate}`)
  lines.push(`延迟：p50=${data.summary.latency.p50}ms p95=${data.summary.latency.p95}ms p99=${data.summary.latency.p99}ms（样本 ${data.summary.latency.sampleCount}）`)
  lines.push(`首 token：p50=${data.summary.firstToken.p50}ms p95=${data.summary.firstToken.p95}ms p99=${data.summary.firstToken.p99}ms（样本 ${data.summary.firstToken.sampleCount}）`)
  lines.push(`SQLITE_BUSY 增量：${data.summary.sqliteBusyTotal}  指标缺失：${data.metricsScrape.missing.length} 项`)
  lines.push(`verdict=${data.verdicts.overall}  退出码=${data.verdicts.overall === 'green' ? 0 : data.verdicts.overall === 'red' ? 2 : 3}`)
  lines.push(`报告：${reportPaths.mdPath}`)
  console.log(lines.join('\n'))
}

async function main(argv) {
  const options = resolveOptions(argv)
  if (options.help) {
    console.log(HELP.trim())
    return 0
  }

  const startedAtDate = new Date()
  const runId = newRunId()
  const studentIds = buildStudentIds(options.students)
  const sseTimeoutMs = Number(process.env.YXS_SSE_TIMEOUT_MS || 60000)
  if (!Number.isFinite(sseTimeoutMs) || sseTimeoutMs <= 0) {
    fail(`环境变量 YXS_SSE_TIMEOUT_MS 非法：必须是正整数毫秒，收到「${process.env.YXS_SSE_TIMEOUT_MS}」。`)
  }

  if (options.llmMode === 'real' && !process.env.DEEPSEEK_API_KEY) {
    fail('real 模式缺少 DEEPSEEK_API_KEY：请配置环境变量后再加跑，或改回 --llm mock。')
  }

  const deadlineMs = Number(process.env.YXS_LOADTEST_DEADLINE_MS || Math.max(90000, options.students * options.iterations * 500))

  let stub = null
  let baseUrl = options.baseUrl
  let actualPort = Number(new URL(options.baseUrl).port || (new URL(options.baseUrl).protocol === 'https:' ? 443 : 80))
  let stubTried = []

  // --home 此前只做路径校验就丢掉了：既没写进 process.env，也没传给 stub。
  // 压测与被测实例必须共用同一个隔离 home，否则「报告里的 home」和「实际跑的 home」是两回事。
  await fsp.mkdir(options.home, { recursive: true })
  process.env.LEARNING_AGENT_HOME = options.home

  if (options.target === 'stub') {
    const started = await startStubAtFreePort({
      students: studentIds,
      password: options.password,
      home: options.home,
      mutations: options.stubMutations
    }, actualPort)
    stub = started.stub
    stubTried = started.tried
    const url = new URL(stub.url)
    actualPort = Number(url.port)
    baseUrl = url.origin
  }

  const reportDir = resolveReportDir(options.out, options.outExplicit)
  await fsp.mkdir(reportDir, { recursive: true })
  const runLog = createRunLog(path.join(reportDir, 'run.log'))

  const client = new YxsClient({
    baseUrl,
    timeoutMs: sseTimeoutMs,
    metricsToken: options.metricsToken,
    distinctClientIps: options.clientIps === 'distinct'
  })

  let beforeText = ''
  let afterText = ''
  let samples = []
  let blocked = []
  let preflight = { ok: true, warnings: [], notices: [] }
  let sseActivePeak = 0
  const rssStart = process.memoryUsage().rss
  const cpuStart = process.cpuUsage()

  try {
    // 1) 预检：目标不可达 / 健康检查不过 → 基础设施失败。
    const healthResult = await client.health()
    const healthData = healthResult.data
    preflight = {
      ok: Boolean(healthResult.sample.ok && healthData && healthData.ok !== false),
      warnings: Array.isArray(healthData && healthData.warnings) ? healthData.warnings : [],
      notices: Array.isArray(healthData && healthData.notices) ? healthData.notices : []
    }
    if (!preflight.ok) {
      const detail = healthResult.sample.status === null
        ? `连接失败（${healthResult.sample.errorClass || 'networkAbort'}）`
        : (healthResult.sample.message || healthResult.sample.code || `HTTP ${healthResult.sample.status}`)
      fail(`被测服务不可达（${baseUrl}）：${detail}。请先启动 apps/server（YXS_LLM=mock，端口 18080），或用 --target stub 跑自洽演练。`)
    }

    // 2) 起始指标快照
    const before = await client.scrapeMetrics()
    if (!before.ok) {
      if (before.status === 401) {
        fail('/metrics 返回 401：请设置 YXS_METRICS_TOKEN（或 --metrics-token）与被测服务一致；指标快照缺失，无法判定。')
      }
      fail(`/metrics 抓取失败（HTTP ${before.status}）：被测服务不可达或未暴露指标端点。`)
    }
    beforeText = before.text
    const beforeAnalysis = analyzeSnapshot(beforeText)

    // 3) 跑 VU
    const result = await runVus({
      client,
      studentIds,
      iterations: options.iterations,
      rampUpSec: options.rampUpSec,
      scenario: options.scenario,
      password: options.password,
      deadlineAt: Date.now() + deadlineMs,
      onSample: (sample) => runLog.write(logLine(sample)),
      onLog: () => {}
    })
    samples = result.samples
    blocked = result.blocked
    sseActivePeak = result.sseActivePeak
    if (result.preflight && result.preflight.warnings) {
      preflight.warnings = [...new Set([...preflight.warnings, ...result.preflight.warnings])]
    }

    const loginSamples = samples.filter((s) => s.scenario === 'login' && s.counted)
    if (loginSamples.length > 0 && loginSamples.every((s) => !s.ok)) {
      const first = loginSamples[0]
      fail(`登录失败（${first.studentId}）：学号或口令不对，请检查隔离 home 中的测试学生是否已建好。${first.message || ''}`)
    }

    // 4) 结束指标快照
    const after = await client.scrapeMetrics()
    if (!after.ok) {
      if (after.status === 401) {
        fail('/metrics 返回 401：请设置 YXS_METRICS_TOKEN（或 --metrics-token）与被测服务一致；指标快照缺失，无法判定。')
      }
      fail(`/metrics 抓取失败（HTTP ${after.status}）：结束快照拿不到，本轮无法判定。`)
    }
    afterText = after.text
    const afterAnalysis = analyzeSnapshot(afterText)
    const metricDiff = diffSnapshots(beforeAnalysis, afterAnalysis)

    // 5) 汇总与落盘
    const endedAtDate = new Date()
    const cpuEnd = process.cpuUsage(cpuStart)
    const cpuSec = (cpuEnd.user + cpuEnd.system) / 1e6
    const reportData = buildReportData({
      runId,
      startedAt: startedAtDate.toISOString(),
      endedAt: endedAtDate.toISOString(),
      toolVersion: TOOL_VERSION,
      target: { type: options.target, baseUrl, port: actualPort },
      llmMode: options.llmMode,
      config: {
        students: options.students,
        rampUpSec: options.rampUpSec,
        iterations: options.iterations,
        scenario: options.scenario,
        tokenQuota: options.tokenQuota,
        home: options.homeRaw
      },
      samples,
      studentIds,
      beforeAnalysis,
      afterAnalysis,
      metricDiff,
      beforeText,
      afterText,
      rawSnapshotPath: 'metrics-after.txt',
      clientStats: {
        rssMbStart: Number((rssStart / 1024 / 1024).toFixed(1)),
        rssMbPeak: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
        cpuSec: Number(cpuSec.toFixed(2))
      },
      sseActivePeak,
      warnings: [],
      blocked,
      preflight,
      stubTried
    })

    const failedFrames = samples
      .filter((s) => s.rawFrames)
      .map((s) => ({ requestId: s.requestId, text: s.rawFrames }))

    const reportPaths = await writeReport(reportData, reportDir, {
      beforeText,
      afterText,
      failedFrames
    })

    printSummary(reportData, reportPaths)

    if (reportData.verdicts.overall === 'green') return 0
    if (reportData.verdicts.overall === 'red') return 2
    return 3
  } finally {
    await runLog.close()
    if (stub) await stub.close()
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    if (error instanceof InfraError) {
      console.error(error.message)
    } else {
      console.error(`基础设施失败：${error && error.message ? error.message : error}`)
      if (error && error.stack) console.error(error.stack)
    }
    process.exitCode = 1
  })
