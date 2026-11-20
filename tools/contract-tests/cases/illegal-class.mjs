/**
 * 5 类非法输入的专属用例（E-065..E-069）—— 02-contract §4.3 冻结，每类一条，不与其他编号重复计数。
 *
 *   E-065 缺字段        news.get 传 {}                → 400  articleId 不能为空。
 *   E-066 类型错        kps.list 传 {limit:"80"}      → 400  limit 必须是整数。
 *   E-067 资源不存在    news.get 传不存在的 articleId → 404  没有找到这条记录，可能已被删除。
 *   E-068 越权          学生 B 读学生 A 的会话        → 403  这个资源不属于当前学号，换回自己的账号再试。
 *   E-069 未知方法      method:"learning.__nonexistent__" → 404  没有这个方法：learning.__nonexistent__
 *
 * E-068 的构造：会话 ID 来自学生 A 的 discovery（A 的合法用例里同一份 ID 已被读到过），
 * 再用 opts.asStudent='B' 发一次请求。归属表依据 packages/db/src/index.ts:276（chat_sessions.student_id）。
 */

import { ILLEGAL_CLASS_CASES } from '../src/frozen.mjs'
import { resolveSymbolicParams, newRequestId } from '../src/fixtures.mjs'
import { make } from '../src/assert.mjs'

export const CASES = ILLEGAL_CLASS_CASES.map((row) => ({
  id: row.id,
  kind: 'illegal-class',
  method: row.method,
  channel: '/api/v1/rpc',
  targets: '*',
  illegalCategory: row.category,
  async run(ctx) {
    if (row.asStudent === 'B' && ctx.target.kind === 'electron') {
      // 桌面端只有一个本机学生，无法构造第二个身份；这是环境限制，不是断言失败（01-scope §4 差异表）
      ctx.skip('electron 桥接只有本机一个学生，构造不出第二个身份来验证 403 越权')
    }
    if (row.asStudent === 'B' && typeof ctx.target.requireStudentB === 'function') {
      // http 目标：B 不存在时 401 会被误读成「越权不生效」，所以先确认真有这个人，没有就显式 skip。
      const probe = await ctx.target.requireStudentB()
      if (!probe.ok) ctx.skip(probe.reason)
    }
    const params = resolveSymbolicParams(row.params, ctx.discovery, { caseId: row.id })
    const requestId = newRequestId()
    const envelope = await ctx.target.rpc(row.method, params, {
      requestId,
      asStudent: row.asStudent,
    })
    const assertions = [
      make('httpStatus', row.expect.http, envelope.httpStatus),
      make('errorCode', row.expect.code, envelope.error?.code),
      make('messageExact', row.expect.message, envelope.error?.message),
    ]
    if (row.id === 'E-068') {
      // 越权不得用空数组泄漏存在性：result 必须为空，且错误码是 FORBIDDEN 而不是 200 + []
      assertions.push(make('noLeakedResult', true, envelope.result === undefined))
    }
    return {
      assertions,
      expected: row.expect,
      actual: {
        code: envelope.error?.code ?? (envelope.ok ? 'OK' : null),
        http: envelope.httpStatus,
        message: envelope.error?.message ?? null,
        hasResult: envelope.result !== undefined,
      },
    }
  },
}))
