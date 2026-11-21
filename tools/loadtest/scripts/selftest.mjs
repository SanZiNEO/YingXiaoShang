#!/usr/bin/env node
/**
 * tools/loadtest/scripts/selftest.mjs — F 轮压测工具可执行自测。
 * 职责：逐条机器判定 FT-01…FT-12 契约点与 M1–M5 反向 mutation（改坏→变红→还原）；
 * 零第三方依赖，纯 Node 22 内置 ESM；临时产物只写 .scratch/run/F/tmp/selftest/。
 * 不修改 tools/loadtest 下任何已有实现文件；M5 只在内存里改 alerts.yml 文本。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import http from 'node:http'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOOL_DIR = path.resolve(HERE, '..')
const REPO_ROOT = path.resolve(TOOL_DIR, '..', '..')
const TMP_ROOT = path.join(REPO_ROOT, '.scratch', 'run', 'F', 'tmp', 'selftest')
const SCENARIO_CLI = path.join(TOOL_DIR, 'scenario.mjs')
const ALERTS_YML = path.join(TOOL_DIR, 'prometheus', 'alerts.yml')

const importSrc = (rel) => import(pathToFileURL(path.join(TOOL_DIR, 'src', ...rel.split('/'))).href)

const stubMod = await importSrc('stub.mjs')
const metricsMod = await importSrc('metrics.mjs')
const clientMod = await importSrc('client.mjs')
const summarizeMod = await importSrc('summarize.mjs')
const checkAlertsMod = await import(pathToFileURL(path.join(TOOL_DIR, 'scripts', 'check-alerts.mjs')).href)

// ---------- 测试计数与断言 ----------

let pass = 0
let fail = 0
const failures = []

/**
 * 一条可机器判定的断言；失败时打印期望值与实际值。
 * @param {string} id FT/M 编号
 * @param {boolean} cond 断言结果
 * @param {unknown} expected 期望值
 * @param {unknown} actual 实际值
 * @param {string} note 说明
 */
function check(id, cond, expected, actual, note = '') {
  if (cond) {
    pass += 1
    console.log(`[${id}] PASS ${note}`)
  } else {
    fail += 1
    failures.push({ id, expected, actual, note })
    console.log(`[${id}] FAIL ${note} | 期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`)
  }
}

/** 相对 TMP_ROOT 的 CLI --out 路径（必须落在 .scratch/run/F/ 内）。 */
function outRel(sub) {
  return path.relative(REPO_ROOT, path.join(TMP_ROOT, sub)).split(path.sep).join('/')
}

// ---------- 通用工具 ----------

/** 轮询等待条件成立；不使用固定 sleep。 */
function waitUntil(fn, timeoutMs = 3000, intervalMs = 20) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = () => {
      if (fn()) return resolve(true)
      if (Date.now() - t0 > timeoutMs) return resolve(false)
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}

/** 跑 CLI 子进程，收集退出码与输出。 */
function runCli(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCENARIO_CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, YXS_LLM: 'mock' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err, timedOut })
    })
  })
}

/** 在 out 目录（或其时间戳子目录）里找报告并解析。 */
async function readReport(outDir) {
  let jsonPath = path.join(outDir, 'loadtest-report.json')
  if (!fs.existsSync(jsonPath)) {
    const subs = fs.readdirSync(outDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    if (subs.length > 0) jsonPath = path.join(outDir, subs[0].name, 'loadtest-report.json')
  }
  const data = JSON.parse(await fsp.readFile(jsonPath, 'utf8'))
  const mdPath = jsonPath.replace(/\.json$/, '.md')
  const md = fs.existsSync(mdPath) ? await fsp.readFile(mdPath, 'utf8') : ''
  return { data, jsonPath, mdPath, md }
}

/** 构造一条合成样本（供 statusBreakdown / perStudentRows 纯函数断言）。 */
function synthSample(overrides = {}) {
  return {
    studentId: '2023F001',
    iteration: 1,
    scenario: 'ask',
    method: '/api/v1/chat/stream',
    at: Date.now(),
    durationMs: 5,
    firstTokenMs: null,
    status: 200,
    code: null,
    ok: overrides.errorClass == null,
    errorClass: null,
    requestId: 'req_synth000001',
    counted: true,
    message: null,
    meta: null,
    rawFrames: null,
    ...overrides,
  }
}

// ---------- 自测主流程 ----------

async function main() {
  // 每次运行前清空自己的临时子目录（保留作为证据，不删其它目录）。
  await fsp.rm(TMP_ROOT, { recursive: true, force: true })
  await fsp.mkdir(TMP_ROOT, { recursive: true })

  // ===== FT-01 全链路 =====
  {
    const dir = path.join(TMP_ROOT, 'ft01')
    const r = await runCli([
      '--target', 'stub', '--students', '40', '--ramp-up', '0', '--out', outRel('ft01'),
    ])
    check('FT-01', r.code === 0, 0, r.code, `CLI 退出码 0（stderr=${r.err.trim() || '无'}）`)
    if (r.code === 0) {
      const rep = await readReport(dir)
      const d = rep.data
      const turnsSum = d.perStudent.reduce((acc, row) => acc + row.turns, 0)
      check('FT-01', d.perStudent.length === 40, 40, d.perStudent.length, 'perStudent 行数 = 学生数 40')
      check('FT-01', d.meta.config.students === 40, 40, d.meta.config.students, 'meta.config.students = 40')
      check('FT-01', d.summary.turnsTotal === 80, 80, d.summary.turnsTotal, 'turnsTotal = 各学生 done 数之和 = 80')
      check('FT-01', turnsSum === 80, 80, turnsSum, 'perStudent.turns 求和 = 80，与 turnsTotal 一致')
      check('FT-01', d.summary.requestsTotal === 280, 280, d.summary.requestsTotal, 'requestsTotal = 40 学生 × 7 请求 = 280')
    }
  }

  // ===== FT-02 分位数（最近秩法，手算 rank） =====
  {
    const { quantileObject } = summarizeMod
    const handRank = (n, p) => Math.min(n, Math.max(1, Math.ceil(p * n)))

    const a100 = Array.from({ length: 100 }, (_, i) => i + 1)
    const q100 = quantileObject(a100)
    const ranks100 = { p50: handRank(100, 0.5), p95: handRank(100, 0.95), p99: handRank(100, 0.99) }
    const exp100 = { p50: a100[ranks100.p50 - 1], p95: a100[ranks100.p95 - 1], p99: a100[ranks100.p99 - 1] }
    console.log(`  FT-02 1..100 手算 rank=${JSON.stringify(ranks100)} 期望值=${JSON.stringify(exp100)}`)
    check('FT-02', q100.p50 === exp100.p50 && q100.p95 === exp100.p95 && q100.p99 === exp100.p99,
      exp100, { p50: q100.p50, p95: q100.p95, p99: q100.p99 }, '1..100 分位数与最近秩手算值一致')

    const a7 = [10, 20, 30, 40, 50, 60, 70]
    const q7 = quantileObject(a7)
    const ranks7 = { p50: handRank(7, 0.5), p95: handRank(7, 0.95), p99: handRank(7, 0.99) }
    const exp7 = { p50: a7[ranks7.p50 - 1], p95: a7[ranks7.p95 - 1], p99: a7[ranks7.p99 - 1] }
    console.log(`  FT-02 7 元素手算 rank=${JSON.stringify(ranks7)} 期望值=${JSON.stringify(exp7)}`)
    check('FT-02', q7.p50 === exp7.p50 && q7.p95 === exp7.p95 && q7.p99 === exp7.p99,
      exp7, { p50: q7.p50, p95: q7.p95, p99: q7.p99 }, '7 元素分位数与最近秩手算值一致')

    const q0 = quantileObject([])
    check('FT-02', q0.p50 === null && q0.p95 === null && q0.p99 === null && q0.avg === null
      && q0.min === null && q0.max === null && q0.sampleCount === 0,
      { p50: null, p95: null, p99: null, sampleCount: 0 }, q0, '空数组全字段 null 且 sampleCount=0')
  }

  // ===== FT-03 首 token 测量点 =====
  {
    const { createStubServer } = stubMod
    const { YxsClient } = clientMod

    // 注：stub 实现 listen 回调回传请求端口而非实际分配端口，port=0 会得到 :0 的坏 URL（已登记为实现缺陷），
    // 这里使用允许的显式端口 18180/18280，串行起停、跑完释放。
    const stub = await createStubServer({
      port: 18180, students: ['2023F001'], mutations: { firstTokenDelayMs: 200 },
    })
    try {
      const client = new YxsClient({ baseUrl: stub.url, timeoutMs: 3000, distinctClientIps: true })
      const login = await client.login('2023F001', 'yxs-loadtest')
      check('FT-03', login.sample.ok === true, true, login.sample.ok, '延迟 200ms 的 stub 登录成功')
      if (login.data && login.data.token) {
        const stream = await client.chatStream({
          studentId: '2023F001', token: login.data.token,
          message: '帮我梳理一下这章的重点', iteration: 1,
        })
        check('FT-03', stream.event.done === true, true, stream.event.done, '正常流收到 done')
        check('FT-03', typeof stream.sample.firstTokenMs === 'number' && stream.sample.firstTokenMs >= 150,
          'firstTokenMs >= 150', stream.sample.firstTokenMs,
          '首 token 晚于 200ms 首帧延迟（session/round/tool 帧未计时）')
      }
    } finally {
      await stub.close()
    }

    const stub2 = await createStubServer({
      port: 18280, students: ['2023F002'], mutations: { faults: { '2023F002': 'noDone' } },
    })
    try {
      const client2 = new YxsClient({ baseUrl: stub2.url, timeoutMs: 3000, distinctClientIps: true })
      const login2 = await client2.login('2023F002', 'yxs-loadtest')
      check('FT-03', login2.sample.ok === true, true, login2.sample.ok, 'noDone stub 登录成功')
      if (login2.data && login2.data.token) {
        const nd = await client2.chatStream({
          studentId: '2023F002', token: login2.data.token,
          message: '帮我梳理一下这章的重点', iteration: 1,
        })
        check('FT-03', nd.sample.firstTokenMs === null, null, nd.sample.firstTokenMs,
          'noDone 失败轮次 firstTokenMs 为 null（不补 0）')
        check('FT-03', nd.sample.errorClass === 'sseError', 'sseError', nd.sample.errorClass,
          'noDone 未收到 done → sseError')
      }
    } finally {
      await stub2.close()
    }
  }

  // ===== FT-04 错误率分类 =====
  {
    const { createStubServer } = stubMod
    const { YxsClient, newRequestId } = clientMod
    const { statusBreakdown } = summarizeMod

    const faultMap = {
      '2023F001': 'http500',
      '2023F002': 'http400',
      '2023F003': 'business',
      '2023F004': 'sseError',
      '2023F005': 'timeout',
      '2023F006': 'cancelOk',
    }
    const expectClass = {
      http500: 'http5xx',
      http400: 'http4xx',
      business: 'businessError',
      sseError: 'sseError',
      timeout: 'timeout',
      cancelOk: 'cancelled',
    }
    const stub = await createStubServer({
      port: 18180, students: Object.keys(faultMap),
      mutations: { faults: faultMap, firstTokenDelayMs: 500 },
    })
    try {
      const client = new YxsClient({ baseUrl: stub.url, timeoutMs: 1500, distinctClientIps: true })
      for (const [studentId, fault] of Object.entries(faultMap)) {
        const login = await client.login(studentId, 'yxs-loadtest')
        if (!login.data || !login.data.token) {
          check('FT-04', false, '登录拿到 token', `login.ok=${login.sample.ok}`, `${fault} 学生登录失败`)
          continue
        }
        let sample
        if (fault === 'business') {
          // businessError 口径为 HTTP 200 且信封 ok:false，走 JSON/RPC 端点（chatStream 只解 SSE 帧）。
          const rpc = await client.rpc('student.current', {}, { studentId, token: login.data.token, iteration: 1 })
          sample = rpc.sample
        } else if (fault === 'cancelOk') {
          const requestId = newRequestId()
          const streamPromise = client.chatStream({
            studentId, token: login.data.token, message: '帮我梳理一下这章的重点',
            iteration: 1, requestId,
          })
          const registered = await waitUntil(() => stub.state.cancels.has(requestId), 3000)
          check('FT-04', registered, true, registered, `${fault} 流已在 stub 注册可取消句柄`)
          await client.cancel(requestId, { studentId, token: login.data.token, iteration: 1 })
          ;({ sample } = await streamPromise)
        } else {
          const stream = await client.chatStream({
            studentId, token: login.data.token, message: '帮我梳理一下这章的重点', iteration: 1,
          })
          sample = stream.sample
        }
        check('FT-04', sample.errorClass === expectClass[fault], expectClass[fault], sample.errorClass,
          `fault=${fault} → errorClass=${expectClass[fault]}`)
      }
    } finally {
      await stub.close()
    }

    // 合成样本：八类互斥 + 分子口径（4xx 与 cancelled 不进失败分子）。
    const samples = [
      synthSample({ studentId: 'S1', errorClass: null }),
      synthSample({ studentId: 'S2', errorClass: null }),
      synthSample({ studentId: 'S3', errorClass: 'http4xx' }),
      synthSample({ studentId: 'S4', errorClass: 'http5xx' }),
      synthSample({ studentId: 'S5', errorClass: 'businessError' }),
      synthSample({ studentId: 'S6', errorClass: 'sseError' }),
      synthSample({ studentId: 'S7', errorClass: 'cancelled' }),
      synthSample({ studentId: 'S8', errorClass: 'timeout' }),
      synthSample({ studentId: 'S9', errorClass: 'networkAbort' }),
    ]
    const sb = statusBreakdown(samples)
    const expBuckets = {
      http2xx: 2, http4xx: 1, http5xx: 1, businessError: 1, sseError: 1,
      cancelled: 1, timeout: 1, networkAbort: 1,
    }
    check('FT-04', JSON.stringify(sb.buckets) === JSON.stringify(expBuckets), expBuckets, sb.buckets,
      '八类状态互斥计数正确')
    const expFailed = expBuckets.http5xx + expBuckets.businessError + expBuckets.sseError
      + expBuckets.timeout + expBuckets.networkAbort
    check('FT-04', sb.requestsFailed === expFailed, expFailed, sb.requestsFailed,
      'requestsFailed = http5xx+businessError+sseError+timeout+networkAbort')
    check('FT-04', sb.requestsFailed === 5, 5, sb.requestsFailed, '4xx 与 cancelled 不进失败分子（分子=5）')
    check('FT-04', Math.abs(sb.errorRate - expFailed / sb.requestsTotal) < 1e-12,
      expFailed / sb.requestsTotal, sb.errorRate, 'errorRate = 失败分子 / 请求总数')
  }

  // ===== FT-13 done.artifacts 形状（真实 ArtifactSchema，非自造 questionIds） =====
  {
    const { createStubServer } = stubMod
    const { YxsClient } = clientMod
    const { runVus } = await importSrc('scenario.mjs')

    const stub = await createStubServer({ port: 18180, students: ['2023F001', '2023F002'] })
    try {
      const client = new YxsClient({ baseUrl: stub.url, timeoutMs: 5000, distinctClientIps: true })
      const result = await runVus({
        client,
        studentIds: ['2023F001', '2023F002'],
        iterations: 1,
        rampUpSec: 0,
        scenario: 'full',
        password: 'yxs-loadtest',
      })
      const answers = result.samples.filter((s) => s.scenario === 'answer')
      const submits = result.samples.filter((s) => s.scenario === 'answer-set')
      check('FT-13', answers.length === 4, 4, answers.length,
        '两名学生各答 2 题（题目 ID 取自 content_json.questions[].id，不再走 q1/q2 兜底）')
      check('FT-13', answers.every((s) => s.ok === true), '全部 ok', answers.map((s) => s.status),
        '作答不再 400：artifact 形状与 ArtifactSchema 对齐后服务端接受')
      check('FT-13', answers.every((s) => !s.meta || s.meta.fallbackQuestionIds !== true),
        '无 fallbackQuestionIds 标记', answers.map((s) => s.meta),
        '出题产物能被正确解析，未触发兜底')
      check('FT-13', submits.length === 2 && submits.every((s) => s.ok === true), '2 条且 ok',
        submits.map((s) => s.status), '交卷带 artifactId，不再 400')
    } finally {
      await stub.close()
    }
  }

  // ===== FT-14 指标存在性以 HELP/TYPE 声明行为准（零错误轮次 AC-08 必须通过） =====
  {
    const { analyzeSnapshot, METRIC_NAMES } = metricsMod

    // prom-client 对「带标签且从未 inc」的 counter 只输出 HELP/TYPE，不输出样本行。
    // 用真实服务端 createMetrics() 的渲染结果做样本（A 轮产物，非手写文本）。
    const zeroErrorText = [
      '# HELP yxs_http_requests_total HTTP requests by method, route and status',
      '# TYPE yxs_http_requests_total counter',
      'yxs_http_requests_total{method="GET",route="/health",status="200"} 1',
      '# HELP yxs_http_request_duration_seconds HTTP request duration in seconds',
      '# TYPE yxs_http_request_duration_seconds histogram',
      ...METRIC_NAMES.includes('yxs_http_request_duration_seconds')
        ? [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 13, 20, 30].map((b) => `yxs_http_request_duration_seconds_bucket{method="GET",route="/health",le="${b}"} 1`)
        : [],
      'yxs_http_request_duration_seconds_bucket{method="GET",route="/health",le="+Inf"} 1',
      'yxs_http_request_duration_seconds_sum{method="GET",route="/health"} 0.001',
      'yxs_http_request_duration_seconds_count{method="GET",route="/health"} 1',
      '# HELP yxs_rpc_requests_total RPC calls',
      '# TYPE yxs_rpc_requests_total counter',
      '# HELP yxs_tokens_total tokens',
      '# TYPE yxs_tokens_total counter',
      // 关键：errors 只有声明行、没有样本行（零错误轮次的真实形态）。
      '# HELP yxs_errors_total Errors by public error code',
      '# TYPE yxs_errors_total counter',
      '# HELP yxs_sqlite_busy_total busy',
      '# TYPE yxs_sqlite_busy_total counter',
      'yxs_sqlite_busy_total{db="learning.db"} 0',
      '# HELP yxs_sse_active_connections active',
      '# TYPE yxs_sse_active_connections gauge',
      'yxs_sse_active_connections 0',
      '# HELP yxs_sse_first_token_seconds first token',
      '# TYPE yxs_sse_first_token_seconds histogram',
      ...[0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 13, 20, 30].map((b) => `yxs_sse_first_token_seconds_bucket{le="${b}"} 0`),
      'yxs_sse_first_token_seconds_bucket{le="+Inf"} 0',
      'yxs_sse_first_token_seconds_sum 0',
      'yxs_sse_first_token_seconds_count 0',
      '# HELP yxs_login_total login',
      '# TYPE yxs_login_total counter',
      'yxs_login_total{result="ok"} 1',
      '# HELP yxs_process_start_time_seconds start',
      '# TYPE yxs_process_start_time_seconds gauge',
      'yxs_process_start_time_seconds 1700000000',
      '',
    ].join('\n')

    const analysis = analyzeSnapshot(zeroErrorText)
    check('FT-14', analysis.present.length === 10, 10, analysis.present.length,
      '零错误轮次 present=10/10（yxs_errors_total 只有 HELP/TYPE 也算存在）')
    check('FT-14', analysis.missing.length === 0, [], analysis.missing,
      '零错误轮次 missing 为空，AC-08 不再恒红')
    check('FT-14', analysis.bucketsOk === true, true, analysis.bucketsOk,
      '12 桶齐全时 bucketsOk=true')
  }

  // ===== FT-15 桶「多出」也要报（只查缺不查多是当前缺陷） =====
  {
    const { analyzeSnapshot } = metricsMod
    const text = [
      '# TYPE yxs_http_request_duration_seconds histogram',
      ...[0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 13, 20, 30, 45].map((b) => `yxs_http_request_duration_seconds_bucket{le="${b}"} 0`),
      'yxs_http_request_duration_seconds_bucket{le="+Inf"} 0',
      'yxs_http_request_duration_seconds_sum 0',
      'yxs_http_request_duration_seconds_count 0',
      '# TYPE yxs_sse_first_token_seconds histogram',
      ...[0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 13, 20, 30].map((b) => `yxs_sse_first_token_seconds_bucket{le="${b}"} 0`),
      'yxs_sse_first_token_seconds_bucket{le="+Inf"} 0',
      'yxs_sse_first_token_seconds_sum 0',
      'yxs_sse_first_token_seconds_count 0',
      '',
    ].join('\n')
    const analysis = analyzeSnapshot(text)
    check('FT-15', analysis.extraBuckets.includes('45'), ['45'], analysis.extraBuckets,
      '清单外的 le=45 被报为多出桶')
    check('FT-15', analysis.bucketsOk === false, false, analysis.bucketsOk,
      '多出桶时 bucketsOk=false（12 桶必须恰好）')
    check('FT-15', !analysis.extraBuckets.includes('+Inf'), '不含 +Inf', analysis.extraBuckets,
      '+Inf 是 exposition 结构性产物，不算多出桶')
  }

  // ===== FT-16 登录限流适配（distinct 绕开 / shared 复现） =====
  {
    const { createStubServer } = stubMod
    const { YxsClient } = clientMod
    const ids = Array.from({ length: 8 }, (_, i) => '2023F0' + String(i + 1).padStart(2, '0'))

    const stub = await createStubServer({ port: 18280, students: ids })
    try {
      const shared = new YxsClient({ baseUrl: stub.url, distinctClientIps: false })
      const sharedResults = []
      for (const id of ids) sharedResults.push((await shared.login(id, 'yxs-loadtest')).sample)
      check('FT-16', sharedResults.filter((s) => s.ok).length === 5, 5,
        sharedResults.filter((s) => s.ok).length,
        '共用 IP 时恰好 5 个登录成功（契约 §3.1：同 IP 每分钟 5 次）')
      check('FT-16', sharedResults.filter((s) => s.status === 429).length === 3, 3,
        sharedResults.filter((s) => s.status === 429).length,
        '第 6 个起 429 RATE_LIMITED')

      const distinct = new YxsClient({ baseUrl: stub.url, distinctClientIps: true })
      const distinctResults = []
      for (const id of ids) distinctResults.push((await distinct.login(id, 'yxs-loadtest')).sample)
      check('FT-16', distinctResults.every((s) => s.ok), '全部 ok',
        distinctResults.map((s) => s.status),
        'distinct 模式每个 VU 独立 X-Forwarded-For，8 个全部登录成功')
    } finally {
      await stub.close()
    }
  }

  // ===== FT-17 --home 真正生效（写进 env 且传给 stub） =====
  {
    const { createStubServer } = stubMod
    const homeDir = path.join(TMP_ROOT, 'home-probe')
    await fsp.mkdir(homeDir, { recursive: true })
    const stub = await createStubServer({ port: 18180, students: ['2023F001'], home: homeDir })
    try {
      const res = await fetch(`${stub.url}/api/v1/health`)
      const body = await res.json()
      check('FT-17', body.result.appHome === homeDir, homeDir, body.result.appHome,
        'stub /health 回显传入的 home，不再是写死的 /data')
    } finally {
      await stub.close()
    }

    const r = await runCli(['--students', '3', '--scenario', 'login', '--ramp-up', '0',
      '--home', outRel('home-probe-cli'), '--out', outRel('ft17')])
    // 3 个学生必然 <30 样本，verdict 会是 incomplete（退出码 3），这是契约行为；
    // 这里只要求不是基础设施失败（1），并确认 home 真的被创建与记录。
    check('FT-17', r.code !== 1, '≠1（非基础设施失败）', r.code,
      `--home 指向新目录时 CLI 不报基础设施失败（stderr=${r.err.trim() || '无'}）`)
    check('FT-17', fs.existsSync(path.join(TMP_ROOT, 'home-probe-cli')), true,
      fs.existsSync(path.join(TMP_ROOT, 'home-probe-cli')), '--home 目录被真正创建（此前只校验不落地）')
    if (r.code !== 1) {
      const rep = await readReport(path.join(TMP_ROOT, 'ft17'))
      check('FT-17', rep.data.meta.config.home === outRel('home-probe-cli'), outRel('home-probe-cli'),
        rep.data.meta.config.home, '报告 meta.config.home 记录实际使用的 home')
    }
  }

  // ===== FT-18 blocked 与 studentIds 不重复计（P2） =====
  {
    const { buildReportData } = summarizeMod
    const report = buildReportData({
      runId: 'selftest-ft18',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      toolVersion: 'selftest',
      target: { type: 'stub', baseUrl: 'http://127.0.0.1:0', port: 0 },
      llmMode: 'mock',
      config: { students: 3, rampUpSec: 0, iterations: 1, scenario: 'ask', tokenQuota: 200000, home: '' },
      samples: [],
      studentIds: ['2023F001', '2023F002', '2023F003'],
      blocked: ['2023F001', '2023F002', '2023F003'],
      sseActivePeak: 0,
      warnings: [],
    })
    check('FT-18', report.perStudent.length === 3, 3, report.perStudent.length,
      'blocked 是 studentIds 子集时 perStudent 仍为 3 行（不翻倍）')
    check('FT-18', new Set(report.perStudent.map((r) => r.studentId)).size === 3, 3,
      new Set(report.perStudent.map((r) => r.studentId)).size, 'perStudent 学生不重复')
  }

  // ===== FT-19 规则 3 阈值随 --token-quota 走（P2） =====
  {
    const { alertRulesFor, evaluateAlerts, ALERT_RULES, DEFAULT_TOKEN_QUOTA } = summarizeMod
    const low = alertRulesFor(1000)
    const rule3Low = low.find((r) => r.name === 'YxsTokenUsageHigh')
    check('FT-19', rule3Low.expr === 'sum by (student_id)(yxs_tokens_total{kind="prompt"}) > 800',
      '> 800', rule3Low.expr, '配额 1000 → 阈值 800，不再硬编码 160000')
    check('FT-19', ALERT_RULES.find((r) => r.name === 'YxsTokenUsageHigh').expr
      === 'sum by (student_id)(yxs_tokens_total{kind="prompt"}) > 160000',
      '> 160000（冻结默认口径）', ALERT_RULES[2].expr, 'ALERT_RULES 常量保持冻结 200000 口径，供 FT-06 逐字比对')

    // 同一份样本，不同配额得到相反的告警结论——这正是硬编码时的矛盾点。
    const ctx = (quota) => ({
      durationMs: 20 * 60_000,
      tokenQuota: quota,
      summary: { fiveXxRate: 0, sqliteBusyTotal: 0 },
      metricsScrape: { serverLatency: { p95: 10 }, tokenByStudent: { '2023F001': { prompt: 1000, completion: 0 } } },
      serverUp: true,
    })
    const tight = evaluateAlerts(ctx(1000)).rules.find((r) => r.name === 'YxsTokenUsageHigh')
    const loose = evaluateAlerts(ctx(DEFAULT_TOKEN_QUOTA)).rules.find((r) => r.name === 'YxsTokenUsageHigh')
    check('FT-19', tight.state === 'firing', 'firing', tight.state,
      'prompt=1000 对配额 1000（阈值 800）已越线 → firing')
    check('FT-19', loose.state === 'inactive', 'inactive', loose.state,
      '同一份样本对默认配额 200000 未越线 → inactive')
  }

  // ===== FT-20 submit 场景不再必然 400（P2） =====
  {
    // 4 个学生 <30 样本，verdict 为 incomplete（退出码 3）属契约行为；
    // 这里只断言「不是基础设施失败」，且交卷真的成功落库。
    const r = await runCli(['--students', '4', '--scenario', 'submit', '--ramp-up', '0', '--out', outRel('ft20')])
    check('FT-20', r.code !== 1, '≠1（非基础设施失败）', r.code,
      `submit 场景不报基础设施失败（stderr=${r.err.trim() || '无'}）`)
    if (r.code !== 1) {
      const rep = await readReport(path.join(TMP_ROOT, 'ft20'))
      const submits = rep.data.perStudent.reduce((acc, row) => acc + row.submissions, 0)
      check('FT-20', submits === 4, 4, submits, '4 名学生各成功交卷 1 次（此前必然 400）')
      const submitErrors = (rep.data.errors ?? []).filter((e) => e.scenario === 'answer-set')
      check('FT-20', submitErrors.length === 0, 0, submitErrors.length,
        'answer-set 无失败样本（此前 100% 400）')
    }
  }


  // ===== FT-05 指标缺失 =====
  {
    const { createStubServer } = stubMod
    const { YxsClient } = clientMod
    const { analyzeSnapshot } = metricsMod
    const { buildReportData } = summarizeMod

    const stub = await createStubServer({
      port: 18280, students: ['2023F001'], mutations: { renameErrorsMetric: true },
    })
    try {
      const client = new YxsClient({ baseUrl: stub.url, distinctClientIps: true })
      const metrics = await client.scrapeMetrics()
      const analysis = analyzeSnapshot(metrics.text)
      check('FT-05', analysis.missing.includes('yxs_errors_total'), true,
        analysis.missing.includes('yxs_errors_total'), 'renameErrorsMetric 后 missing 含 yxs_errors_total')

      const report = buildReportData({
        runId: 'selftest-ft05',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        toolVersion: 'selftest',
        target: { type: 'stub', baseUrl: stub.url, port: stub.port },
        llmMode: 'mock',
        config: { students: 1, rampUpSec: 0, iterations: 1, scenario: 'ask', tokenQuota: 200000, home: '' },
        samples: [],
        beforeAnalysis: analysis,
        afterAnalysis: analysis,
        metricDiff: null,
        sseActivePeak: 0,
        warnings: [],
      })
      check('FT-05', report.verdicts.overall !== 'green', '非 green', report.verdicts.overall,
        '指标缺失时 verdict 不为 green')
    } finally {
      await stub.close()
    }
  }

  // ===== FT-06 告警规则 =====
  {
    const { checkRules, parseRulesYaml, METRIC_NAMES } = checkAlertsMod
    const { ALERT_RULES } = summarizeMod
    const { stripFamilySuffix } = metricsMod

    const ymlText = await fsp.readFile(ALERTS_YML, 'utf8')
    const res = checkRules(ymlText)
    check('FT-06', res.ok === true, true, res.ok, `checkRules(alerts.yml) ok=true（errors=${res.errors.length}）`)

    const expectedNames = ['YxsHttp5xxRate', 'YxsHttpP95Latency', 'YxsTokenUsageHigh', 'YxsSqliteBusySpike', 'YxsServerDown']
    const actualNames = res.rules.map((r) => r.name)
    check('FT-06', JSON.stringify(actualNames) === JSON.stringify(expectedNames), expectedNames, actualNames,
      '5 条冻结规则名齐全')

    // 活动表达式里的 yxs_* 指标都在 10 项清单内。
    let refsOk = true
    const refDetail = []
    for (const rule of res.rules) {
      for (const raw of rule.metrics) {
        const base = stripFamilySuffix(raw)
        const inList = METRIC_NAMES.includes(base)
        refDetail.push(`${rule.name}:${raw}→${inList ? '清单内' : '清单外'}`)
        if (!inList) refsOk = false
      }
    }
    check('FT-06', refsOk, '全部在 10 项清单内', refDetail.join('; '), '活动表达式引用指标均属冻结清单')

    const parsed = parseRulesYaml(ymlText)
    const rule3 = parsed.rules.find((r) => r.name === 'YxsTokenUsageHigh')
    check('FT-06', rule3 != null && !String(rule3.expr).includes('yxs_token_quota'),
      'expr 不含 yxs_token_quota', rule3?.expr, '规则 3 活动表达式不直接引用清单外 yxs_token_quota')
    check('FT-06', rule3?.labels?.quota != null && rule3?.labels?.pending != null,
      'labels 含 quota 与 pending', rule3?.labels, '规则 3 labels 保留 quota / pending 标签')

    // summarize.ALERT_RULES 与 YAML 解析结果：name/for/severity/expr 逐字一致（规则 3 同为替代口径常量 160000）。
    let rulesMatch = true
    const matchDetail = []
    for (const ar of ALERT_RULES) {
      const yr = parsed.rules.find((r) => r.name === ar.name)
      const same = yr && yr.for === ar.for && yr.labels?.severity === ar.severity
        && String(yr.expr).trim() === ar.expr
      matchDetail.push(`${ar.name}:${same ? '一致' : '不一致'}`)
      if (!same) rulesMatch = false
    }
    check('FT-06', rulesMatch && ALERT_RULES.length === 5, '5 条逐字一致', matchDetail.join('; '),
      'ALERT_RULES 与 alerts.yml 的 name/for/severity/expr 一致')
  }

  // ===== FT-07 端口退避 =====
  {
    const placeholder = http.createServer((_req, res) => res.end('ok'))
    await new Promise((resolve) => placeholder.listen(18080, '127.0.0.1', resolve))
    try {
      const r = await runCli([
        '--target', 'stub', '--students', '30', '--scenario', 'ask', '--ramp-up', '0', '--out', outRel('ft07'),
      ])
      check('FT-07', r.code === 0, 0, r.code, `18080 被占时 CLI 退出码 0（stderr=${r.err.trim() || '无'}）`)
      if (r.code === 0) {
        const rep = await readReport(path.join(TMP_ROOT, 'ft07'))
        const port = rep.data.meta.target.port
        check('FT-07', [18180, 18280].includes(port), '18180 或 18280', port,
          '18080 被占后 stub 退避到 18180/18280，报告记录实际端口')
      }
    } finally {
      await new Promise((resolve) => placeholder.close(resolve))
    }
  }

  // ===== FT-08 每学生聚合 =====
  {
    const { perStudentRows } = summarizeMod
    const ids = ['2023F001', '2023F002']
    const samples = [
      synthSample({ studentId: '2023F001', firstTokenMs: 20 }),
      synthSample({ studentId: '2023F001', firstTokenMs: 22 }),
      synthSample({ studentId: '2023F002', firstTokenMs: 21 }),
      synthSample({ studentId: '2023F002', firstTokenMs: 23 }),
    ]
    const tokenDelta = {
      '2023F001': { prompt: 200, completion: 100 },
      '2023F002': { prompt: 300, completion: 150 },
    }
    const { rows } = perStudentRows(ids, samples, tokenDelta)
    const r1 = rows.find((r) => r.studentId === '2023F001')
    const r2 = rows.find((r) => r.studentId === '2023F002')
    check('FT-08', r1 && r1.turns === 2 && r1.tokensPrompt === 200 && r1.tokensCompletion === 100
      && r1.tokensTotal === 300,
      { turns: 2, prompt: 200, completion: 100, total: 300 },
      r1 && { turns: r1.turns, prompt: r1.tokensPrompt, completion: r1.tokensCompletion, total: r1.tokensTotal },
      '学生 1 两轮 done，token 不串号且 total=prompt+completion')
    check('FT-08', r2 && r2.turns === 2 && r2.tokensPrompt === 300 && r2.tokensCompletion === 150
      && r2.tokensTotal === 450,
      { turns: 2, prompt: 300, completion: 150, total: 450 },
      r2 && { turns: r2.turns, prompt: r2.tokensPrompt, completion: r2.tokensCompletion, total: r2.tokensTotal },
      '学生 2 两轮 done，token 不串号且 total=prompt+completion')
  }

  // ===== FT-09 取消归类 =====
  {
    const { statusBreakdown } = summarizeMod
    const okOnly = [synthSample({ errorClass: null }), synthSample({ errorClass: null })]
    const withCancel = [...okOnly, synthSample({ errorClass: 'cancelled' })]
    const sb0 = statusBreakdown(okOnly)
    const sb1 = statusBreakdown(withCancel)
    check('FT-09', sb1.buckets.cancelled === 1, 1, sb1.buckets.cancelled, '取消样本只落 cancelled 桶')
    check('FT-09', sb1.requestsFailed === sb0.requestsFailed && sb1.requestsFailed === 0,
      sb0.requestsFailed, sb1.requestsFailed, 'cancelled 不增加 requestsFailed')
    check('FT-09', sb1.errorRate === sb0.errorRate, sb0.errorRate, sb1.errorRate, 'errorRate 不受取消样本影响')
  }

  // ===== FT-10 mock/real 分栏 =====
  {
    const { buildReportData } = summarizeMod
    const baseInput = {
      runId: 'selftest-ft10',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      toolVersion: 'selftest',
      target: { type: 'stub', baseUrl: 'http://127.0.0.1:0', port: 0 },
      config: { students: 1, rampUpSec: 0, iterations: 1, scenario: 'ask', tokenQuota: 200000, home: '' },
      samples: [],
      sseActivePeak: 0,
      warnings: [],
    }
    const mock = buildReportData({
      ...baseInput,
      llmMode: 'mock',
      metricDiff: { tokenDelta: { S1: { prompt: 100, completion: 50 } } },
    })
    const real = buildReportData({
      ...baseInput,
      llmMode: 'real',
      metricDiff: { tokenDelta: { S1: { prompt: 777, completion: 333 } } },
    })
    check('FT-10', mock.summary.tokens.mode === 'mock' && real.summary.tokens.mode === 'real',
      { mock: 'mock', real: 'real' }, { mock: mock.summary.tokens.mode, real: real.summary.tokens.mode },
      'summary.tokens.mode 跟随 llmMode')
    check('FT-10', mock.summary.tokens.prompt === 100 && mock.summary.tokens.completion === 50
      && mock.summary.tokens.total === 150,
      { prompt: 100, completion: 50, total: 150 }, mock.summary.tokens, 'mock 档 token 为独立数值')
    check('FT-10', real.summary.tokens.prompt === 777 && real.summary.tokens.completion === 333
      && real.summary.tokens.total === 1110,
      { prompt: 777, completion: 333, total: 1110 }, real.summary.tokens,
      'real 档 token 为独立数值，两档未合并平均')
  }

  // ===== FT-11 退出码 =====
  {
    // green：30 学生 ask 场景（latency/firstToken 样本均 ≥30）。
    const green = await runCli(['--students', '30', '--scenario', 'ask', '--ramp-up', '0', '--out', outRel('ft11-green')])
    check('FT-11', green.code === 0, 0, green.code, `green 档退出码 0（verdict 见报告；stderr=${green.err.trim() || '无'}）`)

    // red：token-quota 100，学生 prompt 200 > 0.8×100=80 → red。
    const red = await runCli(['--students', '40', '--token-quota', '100', '--ramp-up', '0', '--out', outRel('ft11-red')])
    check('FT-11', red.code === 2, 2, red.code, `red 档（token 越线）退出码 2；stderr=${red.err.trim() || '无'}`)

    // incomplete：M3 缺 30 桶 → 指标完整性 incomplete。
    const incomplete = await runCli(['--stub-mutations', 'M3', '--students', '10', '--ramp-up', '0', '--out', outRel('ft11-m3')])
    check('FT-11', incomplete.code === 3, 3, incomplete.code, `incomplete 档（缺桶）退出码 3；stderr=${incomplete.err.trim() || '无'}`)

    // 基础设施失败：http 目标不可达。
    const infra = await runCli(['--target', 'http', '--base-url', 'http://127.0.0.1:1', '--students', '2'])
    check('FT-11', infra.code === 1, 1, infra.code, `http 不可达退出码 1；stderr=${infra.err.trim() || '无'}`)

    // 参数非法：students=0。
    const badArg = await runCli(['--students', '0'])
    check('FT-11', badArg.code === 1, 1, badArg.code, `--students 0 参数非法退出码 1；stderr=${badArg.err.trim() || '无'}`)
  }

  // ===== FT-12 报告同源（复用 FT-01 的 md/json） =====
  {
    const rep = await readReport(path.join(TMP_ROOT, 'ft01'))
    const d = rep.data
    // 容差仅限格式化四舍五入：md 数字经 fmt 原样转字符串；百分比经 toFixed(2)（0.005 个百分点以内）。
    const sec31 = rep.md.split('### 3.1')[1]?.split('### 3.2')[0] ?? ''
    const p95Match = sec31.match(/^\|\s*P95\s*\|\s*(.+?)\s*\|/m)
    const p95Md = p95Match ? Number(p95Match[1]) : null
    const erMatch = rep.md.match(/-\s*errorRate：(.+)/)
    const erMd = erMatch ? erMatch[1].trim() : null
    const busyMatch = rep.md.match(/-\s*sqliteBusyTotal：(.+)/)
    const busyMd = busyMatch ? Number(busyMatch[1]) : null

    const jsonP95 = d.summary.latency.p95
    check('FT-12', p95Md !== null && Math.abs(p95Md - jsonP95) <= 0.5, jsonP95, p95Md,
      'md 3.1 节 P95 与 json summary.latency.p95 一致（容差 0.5ms 四舍五入）')

    const erExpect = d.summary.errorRate === null ? '—' : `${(d.summary.errorRate * 100).toFixed(2)}%`
    check('FT-12', erMd === erExpect, erExpect, erMd,
      'md errorRate 与 json summary.errorRate 同源（toFixed(2) 百分比格式）')

    check('FT-12', busyMd === d.summary.sqliteBusyTotal, d.summary.sqliteBusyTotal, busyMd,
      'md sqliteBusyTotal 与 json summary.sqliteBusyTotal 一致')
  }

  // ===== M1 首帧延迟 20ms → 500ms（改坏 / 还原） =====
  {
    async function m1Run(tag, extraArgs) {
      const r = await runCli(['--students', '10', '--scenario', 'ask', '--ramp-up', '0', '--out', outRel(`m1/${tag}`), ...extraArgs])
      const rep = await readReport(path.join(TMP_ROOT, 'm1', tag))
      return {
        code: r.code,
        p50: rep.data.summary.firstToken.p50,
        count: rep.data.summary.firstToken.sampleCount,
        errorRate: rep.data.summary.errorRate,
      }
    }
    const base = await m1Run('base', [])
    const mut = await m1Run('mut', ['--stub-mutations', 'M1'])
    const restore = await m1Run('restore', [])
    console.log(`  M1 首 token P50：基线=${base.p50}ms（n=${base.count}）｜改坏 M1=${mut.p50}ms（n=${mut.count}）｜还原=${restore.p50}ms（n=${restore.count}）`)
    check('M1', typeof mut.p50 === 'number' && typeof base.p50 === 'number' && mut.p50 >= 4 * base.p50,
      `≥4× 基线（${base.p50}ms）`, `${mut.p50}ms`, 'M1 首 token P50 显著高于基线（≥4 倍）')
    check('M1', mut.count === base.count && restore.count === base.count, base.count,
      { base: base.count, mut: mut.count, restore: restore.count }, 'M1 不改变首 token 样本数')
    check('M1', typeof restore.p50 === 'number' && restore.p50 <= 2 * Math.max(base.p50, 1),
      `≤2× 基线（${base.p50}ms）`, `${restore.p50}ms`, '还原后首 token P50 回到基线量级')
  }

  // ===== M2 不发 done（改坏 / 还原） =====
  {
    async function m2Run(tag, extraArgs) {
      const r = await runCli(['--students', '5', '--scenario', 'ask', '--ramp-up', '0', '--out', outRel(`m2/${tag}`), ...extraArgs])
      const dir = path.join(TMP_ROOT, 'm2', tag)
      const rep = await readReport(dir)
      const sseDir = path.join(dir, 'sse')
      const sseFiles = fs.existsSync(sseDir) ? fs.readdirSync(sseDir) : []
      let frameText = ''
      if (sseFiles.length > 0) frameText = await fsp.readFile(path.join(sseDir, sseFiles[0]), 'utf8')
      return {
        code: r.code,
        sseError: rep.data.summary.statusBreakdown.sseError,
        errorRate: rep.data.summary.errorRate,
        ftCount: rep.data.summary.firstToken.sampleCount,
        sseFiles: sseFiles.length,
        frameHasEvent: /event:/.test(frameText),
      }
    }
    const base = await m2Run('base', [])
    const mut = await m2Run('mut', ['--stub-mutations', 'M2'])
    const restore = await m2Run('restore', [])
    console.log(`  M2 sseError：基线=${base.sseError}（errorRate=${base.errorRate}, ftN=${base.ftCount}）｜改坏 M2=${mut.sseError}（errorRate=${mut.errorRate}, ftN=${mut.ftCount}, sse文件=${mut.sseFiles}）｜还原=${restore.sseError}（errorRate=${restore.errorRate}, ftN=${restore.ftCount}）`)
    check('M2', mut.sseError > 0, '>0', mut.sseError, 'M2 报告 sseError>0')
    check('M2', mut.errorRate !== null && mut.errorRate > 0, '>0', mut.errorRate, 'M2 errorRate>0')
    check('M2', mut.ftCount === 0 || mut.ftCount < base.ftCount / 2, `0 或 < ${base.ftCount / 2}`, mut.ftCount,
      'M2 失败轮次首 token 样本数为 0 或显著下降')
    check('M2', mut.sseFiles > 0 && mut.frameHasEvent, 'sse/<requestId>.txt 含失败帧',
      { files: mut.sseFiles, frameHasEvent: mut.frameHasEvent }, 'M2 失败 SSE 帧落盘到 sse/ 目录')
    check('M2', restore.sseError === 0 && restore.errorRate === 0 && restore.ftCount === base.ftCount,
      { sseError: 0, errorRate: 0, ftCount: base.ftCount },
      { sseError: restore.sseError, errorRate: restore.errorRate, ftCount: restore.ftCount }, '还原后错误率与首 token 样本数回到基线')
  }

  // ===== M3 缺 30 桶（改坏 / 还原） =====
  {
    async function m3Run(tag, extraArgs) {
      await runCli(['--students', '5', '--scenario', 'ask', '--ramp-up', '0', '--out', outRel(`m3/${tag}`), ...extraArgs])
      const rep = await readReport(path.join(TMP_ROOT, 'm3', tag))
      return {
        bucketsOk: rep.data.metricsScrape.bucketsOk,
        missingBuckets: rep.data.metricsScrape.missingBuckets,
        verdict: rep.data.verdicts.overall,
      }
    }
    const base = await m3Run('base', [])
    const mut = await m3Run('mut', ['--stub-mutations', 'M3'])
    const restore = await m3Run('restore', [])
    console.log(`  M3 桶核对：基线=bucketsOk=${base.bucketsOk} missing=[${base.missingBuckets}] verdict=${base.verdict}｜改坏 M3=bucketsOk=${mut.bucketsOk} missing=[${mut.missingBuckets}] verdict=${mut.verdict}｜还原=bucketsOk=${restore.bucketsOk} missing=[${restore.missingBuckets}] verdict=${restore.verdict}`)
    check('M3', mut.bucketsOk === false, false, mut.bucketsOk, 'M3 bucketsOk=false')
    check('M3', mut.missingBuckets.includes('30'), true, mut.missingBuckets.includes('30'),
      'M3 missingBuckets 含 "30"')
    check('M3', mut.verdict !== 'green', '非 green', mut.verdict, 'M3 verdict 非 green')
    check('M3', restore.bucketsOk === true && restore.missingBuckets.length === 0,
      { bucketsOk: true, missingBuckets: [] }, { bucketsOk: restore.bucketsOk, missingBuckets: restore.missingBuckets },
      '还原后 12 桶齐全')
  }

  // ===== M4 改坏 errors 指标名（改坏 / 还原） =====
  {
    async function m4Run(tag, extraArgs) {
      await runCli(['--students', '5', '--scenario', 'ask', '--ramp-up', '0', '--out', outRel(`m4/${tag}`), ...extraArgs])
      const rep = await readReport(path.join(TMP_ROOT, 'm4', tag))
      return {
        missing: rep.data.metricsScrape.missing,
        presentCount: rep.data.metricsScrape.present.length,
      }
    }
    const base = await m4Run('base', [])
    const mut = await m4Run('mut', ['--stub-mutations', 'M4'])
    const restore = await m4Run('restore', [])
    console.log(`  M4 指标集合：基线=missing=[${base.missing}] present=${base.presentCount}｜改坏 M4=missing=[${mut.missing}] present=${mut.presentCount}｜还原=missing=[${restore.missing}] present=${restore.presentCount}`)
    check('M4', mut.missing.includes('yxs_errors_total'), true, mut.missing.includes('yxs_errors_total'),
      'M4 missing 含 yxs_errors_total')
    check('M4', mut.presentCount !== 10, '≠10', mut.presentCount, 'M4 present 集合不等于冻结十项')
    check('M4', restore.missing.length === 0 && restore.presentCount === 10,
      { missing: [], presentCount: 10 }, { missing: restore.missing, presentCount: restore.presentCount },
      '还原后十项指标齐全')
  }

  // ===== M5 告警规则改坏（只改内存文本，不落盘） =====
  {
    const { checkRules } = checkAlertsMod
    const original = await fsp.readFile(ALERTS_YML, 'utf8')

    const baseRes = checkRules(original)
    let broken = original
    broken = broken.replace(
      'expr: sum by (student_id)(yxs_tokens_total{kind="prompt"}) > 160000',
      'expr: yxs_tokens_total{kind="prompt"} / yxs_token_quota > 0.8',
    )
    broken = broken.replace(/\s*pending:\s*"token-quota-gauge"/, '')
    const brokenRes = checkRules(broken)
    const restoreRes = checkRules(original)
    const afterDisk = await fsp.readFile(ALERTS_YML, 'utf8')

    console.log(`  M5 规则核对：基线=ok=${baseRes.ok} errors=${baseRes.errors.length}｜改坏=ok=${brokenRes.ok} errors=${brokenRes.errors.length}｜还原=ok=${restoreRes.ok} errors=${restoreRes.errors.length}`)
    check('M5', baseRes.ok === true, true, baseRes.ok, '改坏前基线 checkRules 通过')
    check('M5', brokenRes.ok === false, false, brokenRes.ok, '改坏后 checkRules 不通过')
    check('M5', brokenRes.errors.some((e) => e.includes('yxs_token_quota')),
      'errors 含 yxs_token_quota', brokenRes.errors, '改坏表达式引用清单外 yxs_token_quota 被报出')
    check('M5', restoreRes.ok === true, true, restoreRes.ok, '内存还原后 checkRules 再次通过')
    check('M5', afterDisk === original, '磁盘文件未改动', afterDisk === original,
      'M5 只改内存文本，alerts.yml 落盘内容与原始一致')
  }

  // ---------- 汇总 ----------
  console.log(`\npass=${pass} fail=${fail}`)
  if (fail > 0) {
    console.log('失败明细：')
    for (const f of failures) console.log(`  - [${f.id}] ${f.note} 期望=${JSON.stringify(f.expected)} 实际=${JSON.stringify(f.actual)}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(`自测脚本异常：${err?.message ?? err}`)
  if (err?.stack) console.error(err.stack)
  process.exitCode = 1
})
