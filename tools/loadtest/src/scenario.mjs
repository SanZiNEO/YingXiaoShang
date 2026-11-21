/**
 * tools/loadtest/src/scenario.mjs — F 轮压测 VU 编排层。
 * 职责：持有 VU 生命周期、ramp-up 启动、硬截止与场景裁剪；决定一个学生走哪几步、
 * 顺序与复用哪条会话。不发裸 HTTP（一律经 src/client.mjs），不算汇总分位数。
 */
import { newRequestId } from './client.mjs'

const ASK_MESSAGES = ['帮我梳理一下这章的重点', '给我出两道练习题']
const FALLBACK_QUESTION_COUNT = 2

/** 延时 Promise；ramp-up 调度用。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 顺序生成压测学号：2023F001、2023F002 …
 * @param {number} count
 * @returns {string[]}
 */
export function buildStudentIds(count) {
  const out = []
  const n = Number(count) || 0
  for (let i = 0; i < n; i += 1) {
    out.push('2023F' + String(i + 1).padStart(3, '0'))
  }
  return out
}

/**
 * 从出题 done 事件的 artifacts 中提取题目 ID 列表。
 *
 * 真实 `HandleTurnOutput.artifacts` 是 `ArtifactSchema[]`（packages/shared/src/index.ts:446），
 * 题目 ID 在 `content_json.questions[].id`，与 packages/agent/src/index.ts:1085 的
 * `questionIdsOf` 完全一致；`questionIds` 不是该 schema 的字段，照它取会恒为空。
 * @param {object|null} event done 事件
 * @returns {string[]}
 */
function extractQuestionIds(event) {
  const artifacts = event && Array.isArray(event.artifacts) ? event.artifacts : []
  const ids = []
  for (const art of artifacts) {
    const content = art && typeof art === 'object' ? art.content_json : null
    const questions = content && Array.isArray(content.questions) ? content.questions : []
    for (const question of questions) {
      if (question && typeof question.id === 'string' && question.id) ids.push(question.id)
    }
  }
  return ids
}

/**
 * 取本轮题目集产物的 id（交卷与单题作答都要带它，服务端据此校验题目归属）。
 * @param {object|null} event done 事件
 * @returns {string|null}
 */
function extractArtifactId(event) {
  const artifacts = event && Array.isArray(event.artifacts) ? event.artifacts : []
  for (const art of artifacts) {
    if (!art || typeof art !== 'object') continue
    if (art.type !== undefined && art.type !== 'question_set') continue
    if (typeof art.id === 'string' && art.id) return art.id
  }
  return null
}

/**
 * 跑全部虚拟学生；每生一个 async worker，worker 内串行，学生间不共享连接状态。
 * @param {{client:import('./client.mjs').YxsClient, studentIds:string[], iterations:number,
 *   rampUpSec:number, scenario:string, password:string, deadlineAt?:number,
 *   onSample?:(sample:object)=>void, onLog?:(entry:object)=>void}} options
 * @returns {Promise<{samples:object[], blocked:string[], sseActivePeak:number,
 *   preflight:{ok:boolean, warnings:string[], notices:string[]}}>}
 */
export async function runVus(options) {
  const {
    client,
    studentIds = [],
    iterations = 1,
    rampUpSec = 0,
    scenario = 'full',
    password = '',
    deadlineAt = Number.POSITIVE_INFINITY,
    onSample = null,
    onLog = null
  } = options

  const samples = []
  const warnings = []
  const blocked = []

  const emitSample = (sample) => {
    samples.push(sample)
    if (typeof onSample === 'function') onSample(sample)
  }
  const emitLog = (entry) => {
    if (typeof onLog === 'function') onLog(entry)
  }

  // 全局预检：counted:false，不进请求分母；失败则全部学生 blocked。
  const health = await client.health()
  emitSample(health.sample)
  const healthData = health.data
  const result = healthData && typeof healthData === 'object' ? healthData.result : null
  const preflightOk = Boolean(health.sample.ok && healthData && healthData.ok !== false)
  const preflight = {
    ok: preflightOk,
    warnings: Array.isArray(result?.warnings) ? result.warnings : Array.isArray(healthData?.warnings) ? healthData.warnings : [],
    notices: Array.isArray(result?.notices) ? result.notices : Array.isArray(healthData?.notices) ? healthData.notices : []
  }

  if (!preflightOk) {
    blocked.push(...studentIds)
    return { samples, blocked, sseActivePeak: client.activePeak, preflight }
  }

  const total = studentIds.length
  const rampMsPerWorker = total > 0 ? (Number(rampUpSec) * 1000) / total : 0

  const workers = studentIds.map((studentId, index) => {
    const delayMs = Number(rampUpSec) > 0 ? rampMsPerWorker * index : 0
    return runWorker({
      studentId,
      index,
      delayMs,
      client,
      iterations,
      scenario,
      password,
      deadlineAt,
      emitSample,
      emitLog,
      warnings
    })
  })

  await Promise.all(workers)

  return {
    samples,
    blocked,
    sseActivePeak: client.activePeak,
    preflight: { ok: preflight.ok, warnings, notices: preflight.notices }
  }
}

/** 单个虚拟学生的串行场景脚本。 */
async function runWorker(ctx) {
  const { studentId, delayMs, client, iterations, scenario, password, deadlineAt, emitSample, emitLog, warnings } = ctx
  try {
    await runWorkerBody(ctx)
  } catch (err) {
    // 传输层异常已由 client 落样本；这里只兜未预期的脚本异常，登记进 warnings，不静默吞掉。
    const code = err && (err.code || err.name) ? String(err.code || err.name) : 'UNKNOWN'
    warnings.push(`学生 ${studentId} 场景异常：${code}`)
    emitLog({
      studentId,
      scenario: 'worker',
      requestId: null,
      durationMs: 0,
      errorClass: 'networkAbort',
      code
    })
  }
}

/** 单学生场景主体；与 runWorker 的兜底catch 分离。 */
async function runWorkerBody(ctx) {
  const { studentId, delayMs, client, iterations, scenario, password, deadlineAt, emitSample, emitLog, warnings } = ctx
  if (delayMs > 0) await sleep(delayMs)

  const state = { token: null, sessionId: null, turns: 0, answers: [] }

  const stopped = () => Date.now() > deadlineAt

  for (let iter = 1; iter <= iterations; iter += 1) {
    if (stopped()) break
    state.answers = []

    // 1) 登录
    const login = await client.login(studentId, password)
    emitSample(login.sample)
    emitLog({
      studentId,
      scenario: login.sample.scenario,
      requestId: login.sample.requestId,
      durationMs: login.sample.durationMs,
      status: login.sample.status,
      errorClass: login.sample.errorClass
    })
    if (!login.sample.ok || !login.data || !login.data.token) break
    state.token = login.data.token

    if (scenario === 'login') continue

    // 2) 两次提问（ask 场景到此为止）
    let lastAskEvent = null
    for (let askIdx = 0; askIdx < ASK_MESSAGES.length; askIdx += 1) {
      if (stopped()) break
      const requestId = newRequestId()
      const stream = await client.chatStream({
        studentId,
        token: state.token,
        message: ASK_MESSAGES[askIdx],
        sessionId: state.sessionId,
        iteration: iter,
        requestId
      })
      emitSample(stream.sample)
      emitLog({
        studentId,
        scenario: stream.sample.scenario,
        requestId: stream.sample.requestId,
        durationMs: stream.sample.durationMs,
        status: stream.sample.status,
        errorClass: stream.sample.errorClass,
        firstTokenMs: stream.sample.firstTokenMs
      })
      if (stream.event.sessionId) state.sessionId = stream.event.sessionId
      if (stream.event.done) state.turns += 1
      lastAskEvent = stream.event
    }

    if (scenario === 'ask') continue

    // 3) 逐题作答（answer / full）
    const artifactId = extractArtifactId(lastAskEvent)
    if (scenario === 'answer' || scenario === 'full') {
      const questionIds = extractQuestionIds(lastAskEvent)
      let fallback = false
      if (questionIds.length === 0) {
        fallback = true
        for (let q = 1; q <= FALLBACK_QUESTION_COUNT; q += 1) questionIds.push(`q${q}`)
        warnings.push(
          `学生 ${studentId} 出题产物没有 content_json.questions[].id，按 q1..q${FALLBACK_QUESTION_COUNT} 兜底作答（服务端会拒收，属预期）。`
        )
      }
      for (const questionId of questionIds) {
        if (stopped()) break
        const payload = { sessionId: state.sessionId, questionId, answer: `压测作答 ${questionId}` }
        // artifactId 不是可选装饰：服务端用它校验「这题属于这份题目集」，缺了会 400。
        if (artifactId) payload.artifactId = artifactId
        const ans = await client.answer(payload, { studentId, token: state.token, iteration: iter })
        if (fallback) {
          ans.sample.meta = {
            ...(ans.sample.meta ?? {}),
            fallbackQuestionIds: true,
            questionCount: questionIds.length
          }
        }
        emitSample(ans.sample)
        emitLog({
          studentId,
          scenario: ans.sample.scenario,
          requestId: ans.sample.requestId,
          durationMs: ans.sample.durationMs,
          status: ans.sample.status,
          errorClass: ans.sample.errorClass
        })
        if (ans.sample.ok) state.answers.push({ questionId, answer: payload.answer })
      }
    }

    // 4) 交卷（submit / full）
    if (scenario === 'submit' || scenario === 'full') {
      if (stopped()) break
      if (state.answers.length === 0) {
        // 交卷端点要求 answers 非空且 artifactId 必填；submit 场景此前不做作答，
        // 直接交卷必然 400。这里先按题目集把答案补齐，让 submit 场景真正压到落库路径。
        const questionIds = extractQuestionIds(lastAskEvent)
        for (const questionId of questionIds) state.answers.push({ questionId, answer: `压测作答 ${questionId}` })
      }
      if (!artifactId || state.answers.length === 0) {
        warnings.push(
          `学生 ${studentId} 跳过交卷：${artifactId ? '本轮没有可提交的作答' : '本轮出题产物没有题目集 id'}（服务端会 400，不制造假样本）。`
        )
      } else {
        const payload = { sessionId: state.sessionId, artifactId, answers: state.answers }
        const submitted = await client.answerSet(payload, { studentId, token: state.token, iteration: iter })
        emitSample(submitted.sample)
        emitLog({
          studentId,
          scenario: submitted.sample.scenario,
          requestId: submitted.sample.requestId,
          durationMs: submitted.sample.durationMs,
          status: submitted.sample.status,
          errorClass: submitted.sample.errorClass
        })
      }
    }

    // 5) 回读本轮 turns（full）
    if (scenario === 'full') {
      if (stopped()) break
      const readback = await client.rpc('agent.turns', { sessionId: state.sessionId }, {
        studentId,
        token: state.token,
        iteration: iter
      })
      const turnsReadback = Array.isArray(readback.data) ? readback.data.length : null
      readback.sample.meta = { ...(readback.sample.meta ?? {}), turnsReadback }
      emitSample(readback.sample)
      emitLog({
        studentId,
        scenario: readback.sample.scenario,
        requestId: readback.sample.requestId,
        durationMs: readback.sample.durationMs,
        status: readback.sample.status,
        errorClass: readback.sample.errorClass
      })
    }
  }
}
