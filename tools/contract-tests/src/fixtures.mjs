/**
 * 夹具 —— 测试数据外置（03-implementation §4：fixture 由用例内置或从隔离副本只读探针读取，不复制别人的 .scratch 目录）。
 *
 * 两类数据：
 * 1) 学生 fixture：主学生 A 与第二个学生 B（E-068 越权要用 B 的凭证读 A 的会话）。
 *    学号与口令是 http 目标登录前置的输入，默认值可用 --student-id / --password 覆盖，
 *    口令永远不出现在报告正文与日志里（run.mjs 会把它们交给 redactSecrets）。
 * 2) 符号占位：冻结表里的 `$articleId` 这类值不是真 ID，运行期由各 target 的 discovery 换成真实值；
 *    换不到就按 02-contract §3.1 让用例 skipped 并写明原因，不编造 ID。
 */

import { SkipSignal } from './target-interface.mjs'

/** http 目标登录前置的默认学生（A）。学号/口令是本地测试夹具，不是真实账号。 */
export const STUDENT_A = {
  role: 'A',
  studentId: '20230001',
  password: 'e-contract-tests',
  displayName: '契约测试学生甲',
}

/**
 * 第二个学生（B），只用于越权构造；同一个服务端实例里必须有这条账号。
 *
 * 建号命令（apps/server/scripts/add-student.mjs，auth.db 与 learning.db 分开）：
 *   pnpm --dir apps/server exec tsx scripts/add-student.mjs --id 20230002 --name 契约测试学生乙 --cohort 2023 --password <与 A 同口令>
 * 没建 B 时 http 目标的 B 登录会失败，E-068 按「B 登录失败」显式 skip 并写明原因（不伪装成 passed）。
 */
export const STUDENT_B = {
  role: 'B',
  studentId: '20230002',
  password: 'e-contract-tests',
  displayName: '契约测试学生乙',
}

/** `$symbol` 占位里允许出现的键名（与各 target 的 discovery 输出对齐）。 */
export const DISCOVERY_KEYS = [
  'articleId', 'sessionId', 'artifactId', 'factId', 'evidenceId', 'sourceId',
  'chapterId', 'kpId', 'blockId', 'resourceId', 'questionId',
]

/**
 * 一条不可能存在的 ID（E-067 资源不存在用）。固定字符串而非随机：报告可复现，排查时一眼能认出是测试造的值。
 * 形态按 03-implementation §3.6 用 uuid 样式，避免被测侧因为格式不对先报 BAD_REQUEST。
 */
export const MISSING_ID = '00000000-0000-4000-8000-000000000000'

/** 请求号：`req_` + 时间戳/序号 base36（只含小写字母与数字），与 03-implementation §3.2 第 3 条同形。 */
let requestSeq = 0
export function newRequestId() {
  requestSeq += 1
  return `req_${(Date.now().toString(36) + requestSeq.toString(36)).slice(-12)}`
}

/** 把冻结表里的 `$symbol` 换成 discovery 里的真实值；换不到就抛 SkipSignal（由 run.mjs 记 skipped）。 */
export function resolveSymbolicParams(params, discovery, { caseId = '' } = {}) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    // params 非对象的非法用例原样传下去，交给被测侧判 BAD_REQUEST
    return params
  }
  const output = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.startsWith('$')) {
      const symbol = value.slice(1)
      if (symbol === 'missingArticleId') {
        output[key] = MISSING_ID
        continue
      }
      const resolved = discovery?.[symbol]
      if (!resolved) {
        throw new SkipSignal(
          `取不到 ${symbol}：隔离副本里没有这类记录（${caseId} 依赖真实 ID，不编造，按 02-contract §3.1 跳过）`,
        )
      }
      output[key] = resolved
      continue
    }
    output[key] = value
  }
  return output
}

/** 用例引用到的符号清单（用于在报告里说明为什么跳过）。 */
export function symbolsOf(params) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return []
  return Object.values(params)
    .filter((value) => typeof value === 'string' && value.startsWith('$') && value !== '$missingArticleId')
    .map((value) => value.slice(1))
}

/** 消息长度边界（冻结 §2：8000 字符/码点），超限用例与 fixtures 都用这一处。 */
export const MESSAGE_MAX_CHARS = 8000
