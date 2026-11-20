/**
 * 30 个业务方法的合法 / 非法用例（E-001..E-060）+ 4 个 legacy 只读用例（E-061..E-064）。
 *
 * 用例只描述「打什么、断言什么」（03-implementation §1 分层），传输方式一律不碰：
 * 这里没有 fetch、没有 IPC、没有 _electron，只有 ctx.target.rpc(...)。
 *
 * 逐条入参与期望全部来自 src/frozen.mjs（它逐条抄自冻结 §5 与 02-contract §3），
 * 所以本文件里不出现第二份方法清单、也不出现第二份中文文案。
 */

import { METHODS, LEGACY_METHODS, requiredMessage } from '../src/frozen.mjs'
import { resolveSymbolicParams, newRequestId, MISSING_ID } from '../src/fixtures.mjs'
import { make, shapeAssertions } from '../src/assert.mjs'

/** 合法用例的通用信封断言（02-contract §2.3）：200 + ok:true + requestId 回显 + elapsedMs ≥ 0。 */
function legalAssertions(ctx, requestId, envelope, expect) {
  return [
    make('httpStatus', 200, envelope.httpStatus),
    make('ok', true, envelope.ok === true),
    make('requestId', requestId, envelope.requestId),
    make('elapsedMs', '>=0 的数字', envelope.elapsedMs, {
      ok: typeof envelope.elapsedMs === 'number' && envelope.elapsedMs >= 0,
    }),
    ...shapeAssertions('result', expect, envelope.result),
  ]
}

/** 非法用例的通用信封断言（02-contract §2.3）：HTTP 状态 + error.code + 逐字消息 + field。 */
function illegalAssertions(ctx, envelope, expect) {
  const assertions = [
    make('httpStatus', expect.http, envelope.httpStatus),
    make('errorCode', expect.code, envelope.error?.code),
    make('messageExact', expect.message, envelope.error?.message),
  ]
  if (expect.field) {
    assertions.push(make('field', expect.field, envelope.error?.field))
  }
  return assertions
}

/** 30 方法：每个方法一条合法（method-legal）+ 一条非法（method-illegal）。 */
const methodCases = METHODS.flatMap((row) => {
  const legalId = `E-${String(row.n).padStart(3, '0')}`
  const illegalId = `E-${String(row.n + 30).padStart(3, '0')}`

  return [
    {
      id: legalId,
      kind: 'method-legal',
      method: row.method,
      channel: '/api/v1/rpc',
      targets: '*',
      writes: row.writes,
      evidenceSource: row.evidence,
      async run(ctx) {
        const params = resolveSymbolicParams(row.legal.params, ctx.discovery, { caseId: legalId })
        const requestId = newRequestId()
        const envelope = await ctx.target.rpc(row.method, params, { requestId })
        const assertions = legalAssertions(ctx, requestId, envelope, row.legal.expect)
        return {
          assertions,
          expected: { code: 'OK', http: 200, ...row.legal.expect },
          actual: {
            code: envelope.ok ? 'OK' : envelope.error?.code,
            http: envelope.httpStatus,
            requestId: envelope.requestId,
            error: envelope.error,
          },
        }
      },
    },
    {
      id: illegalId,
      kind: 'method-illegal',
      method: row.method,
      channel: '/api/v1/rpc',
      targets: '*',
      async run(ctx) {
        // params 非对象：冻结 §3 表头一句「params 必须是对象。」；其余按该方法的类型/越界/缺字段构造
        const params = row.illegal.shape === 'array'
          ? []
          : resolveSymbolicParams(row.illegal.params, ctx.discovery, { caseId: illegalId })
        const requestId = newRequestId()
        const envelope = await ctx.target.rpc(row.method, params, { requestId })
        return {
          assertions: illegalAssertions(ctx, envelope, row.illegal.expect),
          expected: row.illegal.expect,
          actual: {
            code: envelope.error?.code ?? (envelope.ok ? 'OK' : null),
            http: envelope.httpStatus,
            message: envelope.error?.message ?? null,
            field: envelope.error?.field ?? null,
          },
        }
      },
    },
  ]
})

/** 4 个 legacy 只读方法：各 1 条合法用例，不计入 30 方法覆盖统计（冻结 §6）。 */
const legacyCases = LEGACY_METHODS.map((row) => ({
  id: row.id,
  kind: 'legacy',
  method: row.method,
  channel: '/api/v1/rpc',
  targets: '*',
  evidenceSource: row.evidence,
  async run(ctx) {
    const params = resolveSymbolicParams(row.legal, ctx.discovery, { caseId: row.id })
    const requestId = newRequestId()
    const envelope = await ctx.target.rpc(row.method, params, { requestId })
    return {
      assertions: legalAssertions(ctx, requestId, envelope, row.expect),
      expected: { code: 'OK', http: 200, ...row.expect, legacy: true },
      actual: { code: envelope.ok ? 'OK' : envelope.error?.code, http: envelope.httpStatus, error: envelope.error },
    }
  },
}))

export const CASES = [...methodCases, ...legacyCases]

/** 供 run.mjs 与 README 用的常量说明（不参与断言）。 */
export const CASE_COUNTS = {
  methodLegal: methodCases.filter((item) => item.kind === 'method-legal').length,
  methodIllegal: methodCases.filter((item) => item.kind === 'method-illegal').length,
  legacy: legacyCases.length,
}

/** 未在冻结表里出现、但用例需要引用的常量（集中在这里，避免散落）。 */
export const ILLEGAL_CLASS_PARAMS = { missingArticleId: MISSING_ID, requiredArticleIdMessage: requiredMessage('articleId') }
