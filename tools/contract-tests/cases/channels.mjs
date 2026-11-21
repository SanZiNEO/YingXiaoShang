/**
 * 5 个专用通道用例（E-070..E-076）—— 02-contract §5 事件与通道序列契约是权威口径。
 *
 * 通道清单（冻结 §7 / src/frozen.mjs CHANNEL_CASES）：
 *   E-070  chat/stream 顺序        session → round/text/tool/... → done 恰好一次，中文不转义
 *   E-071  chat/stream 在途取消     首帧到达即 cancel，error(code=CANCELLED) 恰 1 个，其后不再出 text
 *   E-072  chat/cancel 未知 requestId 仍 200，result.cancelled === false，不是 404 / 错误
 *   E-073  answer 单题作答 + questions.attempts 回读
 *   E-074  answer-set 整卷交卷 + 回读两题
 *   E-075  answer-set answers: []   400 BAD_REQUEST + 逐字中文消息
 *   E-076  health 不带 Authorization 200，字段齐全，warnings/notices 为数组，appHome 为绝对路径
 *
 * 宿主注入 ctx（run.mjs buildContext）：ctx.target / ctx.targetKind / ctx.discovery /
 * ctx.newRequestId() / ctx.make(name, expected, actual, {ok}) / ctx.skip(reason) / ctx.pending(reason)。
 * 本文件不出现 fetch、IPC、_electron 等传输符号；证据帧文本经返回值 sseText 由宿主落盘。
 */

import {
  CHANNEL_CASES,
  SSE_EVENT_NAMES,
  SSE_DONE_FIELDS,
  ANSWER_RESULT_FIELDS,
  ANSWER_SET_RESULT_FIELDS,
  HEALTH_RESULT_FIELDS,
  MESSAGE_ANSWER_SET_EMPTY,
} from '../src/frozen.mjs'
import { make, hasFields } from '../src/assert.mjs'
import { renderFrames } from '../src/sse-client.mjs'

/**
 * Electron 桥接为一次性返回（IPC learning:chat 不是 SSE）：
 * 在途取消与通道回读在该目标上构造不出来，按环境限制显式 skip，不伪造成 passed。
 * 归属：01-scope §4 目标差异表 / 03-implementation §3.4。
 */
const ELECTRON_SKIP = 'electron 桥接为一次性返回（IPC learning:chat 不是 SSE），在途取消与通道回读构造不出来'

/** discovery 取不到真实 ID 时显式 skip（02-contract §3.1）：不编造 ID。 */
function requireDiscovery(ctx, caseId, keys) {
  for (const key of keys) {
    if (!ctx.discovery?.[key]) {
      ctx.skip(`取不到 ${key}（02-contract §3.1）：隔离副本里没有这类记录，${caseId} 依赖真实 ID，不编造 ID`)
    }
  }
}

/** 需要「两个不同题目」的用例（E-074）：题目集里不足两题时显式 skip，绝不复用同一个 id 造重复提交。 */
function requireDistinctQuestions(ctx, caseId, count = 2) {
  const ids = Array.isArray(ctx.discovery?.questionIds) ? ctx.discovery.questionIds : []
  if (ids.length < count) {
    ctx.skip(`取不到 ${count} 个不同题目（02-contract §3.1）：题目集里只有 ${ids.length} 道题，${caseId} 需要不同题号，不编造 ID`)
  }
  return ids.slice(0, count)
}

const META = Object.fromEntries(CHANNEL_CASES.map((row) => [row.id, row]))

/** 用例元数据组装：kind=channel，method 留空，channel 取冻结表。 */
function def(id, run) {
  const meta = META[id]
  return { id: meta.id, kind: 'channel', method: null, channel: meta.channel, name: meta.name, targets: '*', run }
}

/** E-070：chat/stream 帧序列顺序与终态契约（02-contract §5.1）。 */
const E070 = def('E-070', async function run(ctx) {
  const requestId = ctx.newRequestId()
  const message = '契约测试：请用一句话介绍你自己。'
  const collected = await ctx.target.stream(
    { sessionId: ctx.discovery?.sessionId ?? undefined, message, requestId },
  )
  const { events } = collected

  const assertions = []

  // ① 第一帧 event=session，data 含 requestId 与 sessionId；session 必须在任何可能失败的事件之前。
  const first = events[0]
  assertions.push(make('firstEventIsSession', 'session', first?.event))
  assertions.push(make('sessionRequestId', requestId, first?.data?.requestId))
  assertions.push(
    make('sessionSessionId', '非空字符串', first?.data?.sessionId, {
      ok: typeof first?.data?.sessionId === 'string' && first.data.sessionId.length > 0,
    }),
  )

  // ② 所有事件的 event 名都在 SSE_EVENT_NAMES 白名单内。
  const unknownEvents = events.map((event) => event.event).filter((name) => !SSE_EVENT_NAMES.includes(name))
  assertions.push(make('eventWhitelist', SSE_EVENT_NAMES, unknownEvents, { ok: unknownEvents.length === 0 }))

  // ③ 事件 id 从 1 开始严格递增；electron 非 SSE 桥接允许 id=null，stub/http 必须给出递增整数。
  const expectedIds = events.map((_, index) => index + 1)
  const actualIds = events.map((event) => event.id)
  if (ctx.targetKind === 'electron') {
    assertions.push(
      make('eventIdNullable', 'null 或整数', actualIds, {
        ok: actualIds.every((id) => id === null || (typeof id === 'number' && Number.isInteger(id))),
      }),
    )
  } else {
    assertions.push(make('eventIdSequence', expectedIds, actualIds))
  }

  // ④ doneCount === 1。
  assertions.push(make('doneCount', 1, collected.doneCount))

  // ⑤ done 帧 data 含 SSE_DONE_FIELDS 全部字段（trace? 可缺，不在清单内）。
  const doneFrame = events.find((event) => event.event === 'done')
  const missingDoneFields = SSE_DONE_FIELDS.filter((field) => !hasFields(doneFrame?.data ?? {}, [field]))
  assertions.push(make('doneFields', SSE_DONE_FIELDS, missingDoneFields, { ok: missingDoneFields.length === 0 }))

  // ⑥ done 之后不再有任何事件。
  const doneIndex = events.findIndex((event) => event.event === 'done')
  const trailingEvents = doneIndex >= 0 ? events.slice(doneIndex + 1) : events.slice()
  assertions.push(make('doneNoTrailingEvents', [], trailingEvents.map((event) => event.event)))

  // ⑦ 所有 text 帧拼接后非空，且 done.data.text 非空（text 为增量，done.text 为全量）。
  const joinedText = events.filter((event) => event.event === 'text').map((event) => event.data?.text ?? '').join('')
  assertions.push(make('textJoinedNonEmpty', '非空字符串', joinedText, { ok: joinedText.length > 0 }))
  assertions.push(
    make('doneTextNonEmpty', '非空字符串', doneFrame?.data?.text, {
      ok: typeof doneFrame?.data?.text === 'string' && doneFrame.data.text.length > 0,
    }),
  )

  // ⑧ 中文未被转义：原始帧文本里出现中文原文，而不是 \uXXXX。
  const rawAll = events.map((event) => event.raw ?? '').join('\n')
  const hasChinese = /[一-鿿]/.test(rawAll)
  const hasEscapedUnicode = /\\u[0-9a-fA-F]{4}/.test(rawAll)
  assertions.push(
    make('chineseUnescaped', '原始帧含中文原文且无 \\uXXXX 转义', { hasChinese, hasEscapedUnicode }, { ok: hasChinese && !hasEscapedUnicode }),
  )

  return {
    assertions,
    expected: { sequence: ['session', 'round', 'text', 'done'], doneFields: SSE_DONE_FIELDS },
    actual: { eventOrder: events.map((event) => event.event), doneCount: collected.doneCount },
    sseText: renderFrames(events),
  }
})

/** E-071：发起 stream，首帧 session 到达后立即 cancel；断言在途取消成立、停止出字（02-contract §5.1）。 */
const E071 = def('E-071', async function run(ctx) {
  if (ctx.targetKind === 'electron') ctx.skip(ELECTRON_SKIP)

  const requestId = ctx.newRequestId()
  const message = '契约测试：请用一句话介绍你自己。'

  // 用 Promise.race 配 10s 保护超时等首帧；禁止 sleep / waitForTimeout 凑时间（02-contract §5.1 第 3 条 [R36]）。
  let resolveFirstFrame
  const firstFramePromise = new Promise((resolve) => { resolveFirstFrame = resolve })
  const guardPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('等待首帧 session 超时（10s 保护）：E-071 不使用固定等待')), 10000)
  })

  const streamPromise = ctx.target.stream(
    { message, requestId },
    {
      onFrame: (event) => {
        if (event.event === 'session') resolveFirstFrame(event)
      },
    },
  )

  await Promise.race([firstFramePromise, guardPromise])
  const cancelRes = await ctx.target.cancel(requestId)
  const collected = await streamPromise
  const events = collected.events

  const assertions = []

  // cancel 返回 body.result.cancelled === true；通道仍 200，不是错误。
  assertions.push(make('cancelHttpStatus', 200, cancelRes.httpStatus))
  assertions.push(make('cancelled', true, cancelRes.body?.result?.cancelled))

  // error 帧恰好 1 个，data.code === 'CANCELLED'。
  const errorFrames = events.filter((event) => event.event === 'error')
  assertions.push(make('errorCount', 1, errorFrames.length))
  assertions.push(make('errorCode', 'CANCELLED', errorFrames[0]?.data?.code))

  // error 帧之后不再出现 text 帧。
  const errorIndex = events.findIndex((event) => event.event === 'error')
  const textAfterError = errorIndex >= 0
    ? events.slice(errorIndex + 1).filter((event) => event.event === 'text')
    : []
  assertions.push(make('noTextAfterError', [], textAfterError.map((event) => event.data?.text)))

  // 取消场景不产出 done 终态。
  assertions.push(make('doneCount', 0, collected.doneCount))

  return {
    assertions,
    expected: { cancelled: true, errorCode: 'CANCELLED', doneCount: 0 },
    actual: {
      cancelled: cancelRes.body?.result?.cancelled,
      errorCount: errorFrames.length,
      doneCount: collected.doneCount,
      eventOrder: events.map((event) => event.event),
    },
    sseText: renderFrames(events),
  }
})

/** E-072：cancel 未知（或已结束）的 requestId → 仍 200，cancelled=false，不是 404、不是错误（02-contract §5.2）。 */
const E072 = def('E-072', async function run(ctx) {
  if (ctx.targetKind === 'electron') ctx.skip(ELECTRON_SKIP)

  // 请求号必须合法（服务端正则 `^req_[a-z0-9]{1,24}$`，不含下划线），否则服务端会先报
  // 400 BAD_REQUEST 而根本走不到「未知 requestId 仍 200」这条契约。合法性由 ctx.newRequestId 保证，
  // 「未知」由「服务端从未见过这个号」保证——本用例不发起对应的 stream，因此必然不存在。
  const unknownRequestId = ctx.newRequestId()
  const cancelRes = await ctx.target.cancel(unknownRequestId)

  const assertions = [
    make('httpStatus', 200, cancelRes.httpStatus),
    make('cancelled', false, cancelRes.body?.result?.cancelled),
    make('notError', true, cancelRes.body?.ok === true),
  ]

  return {
    assertions,
    expected: { http: 200, cancelled: false, ok: true },
    actual: {
      http: cancelRes.httpStatus,
      cancelled: cancelRes.body?.result?.cancelled,
      ok: cancelRes.body?.ok,
      requestId: cancelRes.body?.requestId,
    },
  }
})

/** E-073：answer 单题作答成功后，questions.attempts 回读能查到该题（02-contract §5.3）。 */
const E073 = def('E-073', async function run(ctx) {
  if (ctx.targetKind === 'electron') ctx.skip(ELECTRON_SKIP)
  requireDiscovery(ctx, 'E-073', ['sessionId', 'questionId'])

  const { sessionId, questionId } = ctx.discovery
  const envelope = await ctx.target.answer({ sessionId, questionId, answer: '契约测试作答' })

  const assertions = [
    make('httpStatus', 200, envelope.httpStatus),
    make('ok', true, envelope.ok === true),
  ]
  const missingAnswerFields = ANSWER_RESULT_FIELDS.filter((field) => !hasFields(envelope.result ?? {}, [field]))
  assertions.push(make('answerResultFields', ANSWER_RESULT_FIELDS, missingAnswerFields, { ok: missingAnswerFields.length === 0 }))

  const readback = await ctx.target.rpc('questions.attempts', { questionIds: [questionId] })
  const attempts = Array.isArray(readback.result) ? readback.result : []
  const readbackQuestionIds = attempts.map((row) => row?.question_id)
  const found = readbackQuestionIds.includes(questionId)
  // 不允许空回读：查不到即 failed。
  assertions.push(make('readbackFoundQuestion', [questionId], readbackQuestionIds, { ok: found }))

  return {
    assertions,
    expected: { resultFields: ANSWER_RESULT_FIELDS, readback: questionId },
    actual: {
      http: envelope.httpStatus,
      found,
      readbackQuestionIds,
      answer: envelope.result?.answer ?? null,
    },
  }
})

/** E-074：answer-set 交卷成功后回读，两道题都能查到（02-contract §5.4）。 */
const E074 = def('E-074', async function run(ctx) {
  if (ctx.targetKind === 'electron') ctx.skip(ELECTRON_SKIP)
  requireDiscovery(ctx, 'E-074', ['sessionId', 'artifactId'])

  const { sessionId, artifactId } = ctx.discovery
  // 同一道题交两次会被服务端按「重复提交」拒绝（packages/agent/src/index.ts:730），
  // 所以这里必须拿两个**不同**的题号；题目集里不足两题时这条用例构造不出来，显式 skip 而不是复用同一个 id。
  const [q1, q2] = requireDistinctQuestions(ctx, 'E-074')
  const envelope = await ctx.target.answerSet({
    sessionId,
    artifactId,
    answers: [
      { questionId: q1, answer: 'A' },
      { questionId: q2, answer: 'B' },
    ],
  })

  const results = Array.isArray(envelope.result?.results) ? envelope.result.results : []
  const assertions = [
    make('httpStatus', 200, envelope.httpStatus),
    make('ok', true, envelope.ok === true),
  ]
  const missingSetFields = ANSWER_SET_RESULT_FIELDS.filter((field) => !hasFields(envelope.result ?? {}, [field]))
  assertions.push(make('answerSetResultFields', ANSWER_SET_RESULT_FIELDS, missingSetFields, { ok: missingSetFields.length === 0 }))
  assertions.push(make('resultsLength', 2, results.length))

  const readback = await ctx.target.rpc('questions.attempts', { questionIds: [q1, q2] })
  const attempts = Array.isArray(readback.result) ? readback.result : []
  const readbackQuestionIds = attempts.map((row) => row?.question_id)
  const bothFound = [q1, q2].every((id) => readbackQuestionIds.includes(id))
  assertions.push(make('readbackFoundBoth', [q1, q2], readbackQuestionIds, { ok: bothFound }))

  return {
    assertions,
    expected: { resultFields: ANSWER_SET_RESULT_FIELDS, resultsLength: 2, readback: [q1, q2] },
    actual: {
      http: envelope.httpStatus,
      resultsLength: results.length,
      readbackQuestionIds,
      reusedSameQuestion: q1 === q2,
      questionIdsUsed: [q1, q2],
    },
  }
})

/** E-075：answers: [] → 400 BAD_REQUEST，消息逐字冻结文案（02-contract §5.4）。 */
const E075 = def('E-075', async function run(ctx) {
  if (ctx.targetKind === 'electron') ctx.skip(ELECTRON_SKIP)
  requireDiscovery(ctx, 'E-075', ['sessionId', 'artifactId'])

  const { sessionId, artifactId } = ctx.discovery
  const envelope = await ctx.target.answerSet({ sessionId, artifactId, answers: [] })

  const assertions = [
    make('httpStatus', 400, envelope.httpStatus),
    make('errorCode', 'BAD_REQUEST', envelope.error?.code),
    make('messageExact', MESSAGE_ANSWER_SET_EMPTY, envelope.error?.message),
  ]

  return {
    assertions,
    expected: { http: 400, code: 'BAD_REQUEST', message: MESSAGE_ANSWER_SET_EMPTY },
    actual: {
      http: envelope.httpStatus,
      code: envelope.error?.code,
      message: envelope.error?.message,
      field: envelope.error?.field ?? null,
    },
  }
})

/** E-076：health 不带 Authorization 仍 200，字段齐全，warnings/notices 为数组，appHome 为绝对路径（02-contract §5.5）。 */
const E076 = def('E-076', async function run(ctx) {
  const res = await ctx.target.health({ auth: false })
  const result = res.body?.result ?? {}

  const appHome = result.appHome
  const isAbsoluteAppHome = typeof appHome === 'string'
    && appHome.length > 0
    && (/^[A-Za-z]:[\\/]/.test(appHome) || appHome.startsWith('/'))

  const assertions = [
    make('httpStatus', 200, res.httpStatus),
  ]
  const missingHealthFields = HEALTH_RESULT_FIELDS.filter((field) => !hasFields(result, [field]))
  assertions.push(make('healthResultFields', HEALTH_RESULT_FIELDS, missingHealthFields, { ok: missingHealthFields.length === 0 }))
  assertions.push(make('warningsIsArray', true, Array.isArray(result.warnings)))
  assertions.push(make('noticesIsArray', true, Array.isArray(result.notices)))
  assertions.push(
    make('appHomeAbsolute', '绝对路径形态（盘符或 / 开头）', appHome, { ok: isAbsoluteAppHome }),
  )

  return {
    assertions,
    expected: { http: 200, fields: HEALTH_RESULT_FIELDS },
    actual: {
      http: res.httpStatus,
      appHome,
      warningsIsArray: Array.isArray(result.warnings),
      noticesIsArray: Array.isArray(result.notices),
    },
  }
})

export const CASES = [E070, E071, E072, E073, E074, E075, E076]
