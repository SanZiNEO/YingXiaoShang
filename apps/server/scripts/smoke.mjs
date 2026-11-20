/**
 * Five-step smoke test against a running server (AC-A-20, AC-A-21).
 *
 *   1. login            学号 + 口令换 token
 *   2. chat.stream      发「你好」：首帧 session、末帧 done、text ≥ 3 帧
 *   3. question set     发「出两道题练习一下」，从 done.artifacts 读 question_set，
 *                        题目 id 取自 artifact.content_json.questions[].id（真实 id 形如 q_<hash>，不硬编码）
 *   4. answer-set       用上一步读出的 id 交卷，断言 status=completed
 *   5. readback         questions.attempts 回读这些题；profile.get / memory.facts 查档案
 *
 * Usage:
 *   node scripts/smoke.mjs
 *   YXS_BASE_URL=http://127.0.0.1:8080 YXS_SMOKE_STUDENT=20230001 YXS_SMOKE_PASSWORD=abc12345 node scripts/smoke.mjs
 *
 * Every step prints `PASS step-name` or `FAIL step-name: 原因`; the process
 * exits non-zero on the first failure. No network is required beyond the local
 * server when YXS_LLM=mock.
 */

const base = (process.env.YXS_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '')
const studentId = process.env.YXS_SMOKE_STUDENT ?? '20230001'
const password = process.env.YXS_SMOKE_PASSWORD ?? 'abc12345'

let failed = false

function pass(name) {
  console.log(`PASS ${name}`)
}

function fail(name, reason) {
  failed = true
  // Steps `return fail(...)` early, so the exit code must be set here rather
  // than at the end of main: a failed step has to fail the process.
  process.exitCode = 1
  console.log(`FAIL ${name}: ${reason}`)
}

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json; charset=utf-8' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try {
    json = text.length > 0 ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: response.status, text, json }
}

async function rpc(token, method, params = {}) {
  const result = await request('/api/v1/rpc', {
    method: 'POST',
    token,
    body: { method, params, requestId: `req_smoke${Date.now().toString(36)}` },
  })
  if (result.status !== 200 || result.json?.ok !== true) {
    const message = result.json?.error?.message ?? `HTTP ${result.status}`
    throw new Error(`${method}: ${message}`)
  }
  return result.json.result
}

async function post(token, path, body) {
  const result = await request(path, { method: 'POST', token, body })
  if (result.status !== 200 || result.json?.ok !== true) {
    const message = result.json?.error?.message ?? `HTTP ${result.status}`
    throw new Error(`${path}: ${message}`)
  }
  return result.json.result
}

/** Parse a completed SSE stream into ordered { id, event, data } frames. */
function parseSse(buffer) {
  const frames = []
  for (const block of buffer.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue
    let event = 'message'
    let id
    const dataLines = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue // heartbeat comment
      if (line.startsWith('id:')) id = line.slice(3).trim()
      else if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    const raw = dataLines.join('\n')
    let data = null
    if (raw) {
      try {
        data = JSON.parse(raw)
      } catch {
        data = raw
      }
    }
    frames.push({ id, event, data })
  }
  return frames
}

async function streamChat(token, message, sessionId) {
  const response = await fetch(`${base}/api/v1/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      message,
      requestId: `req_smoke${Date.now().toString(36)}`,
      ...(sessionId ? { sessionId } : {}),
    }),
  })
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    throw new Error(`chat/stream HTTP ${response.status}: ${text.slice(0, 200)}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
  }
  return parseSse(buffer)
}

function decodeContentJson(artifact) {
  const raw = artifact.content_json ?? artifact.contentJson ?? null
  if (raw === null || raw === undefined) return {}
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return raw
}

async function main() {
  // Step 1 — login
  let token
  try {
    const login = await request('/api/v1/auth/login', {
      method: 'POST',
      body: { studentId, password },
    })
    if (login.status !== 200 || login.json?.ok !== true) {
      return fail('login', login.json?.error?.message ?? `HTTP ${login.status}`)
    }
    token = login.json.result.token
    if (typeof token !== 'string' || token.length !== 43) {
      return fail('login', `token 长度应为 43，实际 ${token?.length ?? 0}`)
    }
    if (!login.json.result.expiresAt) return fail('login', '缺少 expiresAt')
    pass('login')
  } catch (error) {
    return fail('login', error.message)
  }

  // Step 2 — greeting stream
  let sessionId
  try {
    const frames = await streamChat(token, '你好')
    if (frames.length === 0) return fail('chat-greeting', '没有收到任何 SSE 帧')
    const first = frames[0]
    if (first.event !== 'session' || !first.data?.sessionId) {
      return fail('chat-greeting', `首帧应为 session 且含 sessionId，实际 ${first.event}`)
    }
    sessionId = first.data.sessionId
    const textFrames = frames.filter((frame) => frame.event === 'text')
    if (textFrames.length < 3) {
      return fail('chat-greeting', `text 帧应 ≥3，实际 ${textFrames.length}`)
    }
    const doneFrames = frames.filter((frame) => frame.event === 'done')
    if (doneFrames.length !== 1) {
      return fail('chat-greeting', `done 帧应恰好 1 个，实际 ${doneFrames.length}`)
    }
    const done = doneFrames[0].data
    if (!done?.turnId || !done?.text || !done?.sessionId) {
      return fail('chat-greeting', 'done 帧缺少 turnId/text/sessionId')
    }
    pass('chat-greeting')
  } catch (error) {
    return fail('chat-greeting', error.message)
  }

  // Step 3 — request a question set, read real question ids from the artifact
  let artifactId
  let questionIds
  try {
    // Same session as the greeting: the artifact is owned by (student, session),
    // and answer-set checks both.
    const frames = await streamChat(token, '出两道题练习一下', sessionId)
    const doneFrames = frames.filter((frame) => frame.event === 'done')
    if (doneFrames.length !== 1) return fail('question-set', `done 帧数量 ${doneFrames.length}`)
    const done = doneFrames[0].data
    const artifacts = Array.isArray(done?.artifacts) ? done.artifacts : []
    const questionSet = artifacts.find((artifact) => artifact?.type === 'question_set' || artifact?.kind === 'question_set')
    if (!questionSet) return fail('question-set', 'done.artifacts 里没有 question_set')
    artifactId = questionSet.id
    const content = decodeContentJson(questionSet)
    const questions = Array.isArray(content.questions) ? content.questions : []
    questionIds = questions.map((question) => question?.id).filter(Boolean)
    if (questionIds.length === 0) return fail('question-set', '题目集 content_json.questions 里读不到题目 id')
    pass('question-set')
  } catch (error) {
    return fail('question-set', error.message)
  }

  // Step 4 — answer-set using the ids read above (never hardcoded q1/q2)
  try {
    const answers = questionIds.map((questionId) => ({ questionId, answer: '参考作答：结合课堂定义与案例说明。' }))
    // `answer-set` is one of the dedicated channels, not an RPC method.
    const result = await post(token, '/api/v1/answer-set', { sessionId, artifactId, answers })
    if (result?.status !== 'completed') {
      return fail('answer-set', `status 应为 completed，实际 ${String(result?.status)}`)
    }
    pass('answer-set')
  } catch (error) {
    return fail('answer-set', error.message)
  }

  // Step 5 — read back attempts and profile memory
  try {
    const attempts = await rpc(token, 'questions.attempts', { questionIds })
    if (!Array.isArray(attempts)) return fail('readback', 'attempts 不是数组')
    const found = questionIds.filter((questionId) => attempts.some((attempt) => attempt.question_id === questionId))
    if (found.length === 0) return fail('readback', `attempts 回读不到交卷题目：${questionIds.join(', ')}`)
    const profile = await rpc(token, 'profile.get')
    const facts = await rpc(token, 'memory.facts')
    const hasProfile = Boolean(profile?.profile) || Array.isArray(facts)
    if (!hasProfile) return fail('readback', 'profile.get 与 memory.facts 都查不到档案记录')
    pass('readback')
  } catch (error) {
    return fail('readback', error.message)
  }

  if (failed) process.exit(1)
}

main().catch((error) => {
  fail('smoke', error.message)
  process.exit(1)
})
