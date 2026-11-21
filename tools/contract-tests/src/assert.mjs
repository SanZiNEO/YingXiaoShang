/**
 * 断言原语 —— 一条编号一条断言、失败原因写进断言文本，绝不吞掉失败（03-implementation §1 的分层原则）。
 *
 * 报告里每条断言都保留 expected 与 actual 并列（02-contract §6），所以这里的 make() 不抛异常，
 * 只产 `{ name, expected, actual, ok }`；什么时候判红由 run.mjs 用 statusFrom() 统一算。
 */

/** 深比较：先比引用与类型，再比数组逐项、对象键集与值。用于断言 expected/actual。 */
export function deepEqual(left, right) {
  if (Object.is(left, right)) return true
  if (typeof left !== typeof right) return false
  if (left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left)) {
    if (left.length !== right.length) return false
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  if (typeof left === 'object') {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]))
  }
  return false
}

/**
 * 造一条断言。
 * @param {string} name 断言名，取值限定 02-contract §6 的 httpStatus / errorCode / messageExact / field / resultFields / eventOrder / collectionEqual
 * @param {unknown} expected
 * @param {unknown} actual
 * @param {{ ok?: boolean }} [options] 少数场景（如「字段存在即可」）允许显式给 ok
 */
export function make(name, expected, actual, options = {}) {
  const ok = typeof options.ok === 'boolean' ? options.ok : deepEqual(expected, actual)
  return { name, expected, actual, ok }
}

/** 断言集合是否全绿。空集合视为失败——没有断言的用例不构成证据。 */
export function allOk(assertions) {
  return Array.isArray(assertions) && assertions.length > 0 && assertions.every((item) => item && item.ok === true)
}

/** 由断言集合算用例状态（skipped/pending 由 SkipSignal 决定，不在这里）。 */
export function statusFrom(assertions) {
  return allOk(assertions) ? 'passed' : 'failed'
}

/** 报告正文与日志的脱敏：token / 口令 / 消息正文一律不落盘（02-contract §6 与 03-implementation §6）。 */
export function redactSecrets(text, secrets = []) {
  let output = String(text ?? '')
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue
    output = output.split(secret).join('***')
  }
  // 兜底：只打码「恰好 43 个字符、两侧都不是同类字符」的串——那是 token 的固定长度（冻结 §3.1）。
  // 不用 {43,}：长目录名（electron-userdata-…）会被误伤，报告里就看不到隔离 home 路径了。
  output = output.replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, '***')
  return output
}

/**
 * 报告里给人看的差异说明：只写「期望 vs 实际」，不写堆栈。
 * @param {{ name: string, expected: unknown, actual: unknown, ok: boolean }[]} assertions
 */
export function describeFailures(assertions = []) {
  const failed = assertions.filter((item) => item && item.ok !== true)
  if (failed.length === 0) return '全部断言成立'
  return failed
    .map((item) => `${item.name}: 期望 ${preview(item.expected)}，实际 ${preview(item.actual)}`)
    .join('；')
}

function preview(value) {
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return String(value)
    return text.length > 240 ? `${text.slice(0, 240)}…` : text
  } catch {
    return String(value)
  }
}

/**
 * 证据落盘前的字段级脱敏：token / 口令 / 消息正文不进报告（02-contract §6、04-acceptance §4）。
 * 只替换「值」，保留键名与长度，便于排查时确认字段确实被看到过。
 */
const SENSITIVE_KEY = /^(token|password|passwd|secret|content|message|prompt|answer|text|authorization)$/i
export function scrubSensitive(value, depth = 0) {
  if (depth > 6) return '<depth-limit>'
  if (Array.isArray(value)) return value.map((item) => scrubSensitive(item, depth + 1))
  if (value === null || typeof value !== 'object') return value
  const output = {}
  for (const [key, inner] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) && typeof inner === 'string') {
      output[key] = `<redacted:${inner.length} chars>`
      continue
    }
    output[key] = scrubSensitive(inner, depth + 1)
  }
  return output
}

/** 集合相等（用于 E-077 的 enum 比对）：返回 missing / extra 明细，供报告列给 A 修。 */
export function compareSets(expected, actual) {
  const expectedList = Array.from(new Set(expected))
  const actualList = Array.from(new Set(actual))
  const missing = expectedList.filter((item) => !actualList.includes(item))
  const extra = actualList.filter((item) => !expectedList.includes(item))
  return { missing, extra, equal: missing.length === 0 && extra.length === 0 }
}

/** 对象是否含全部必含字段（多出的未知字段不判失败，02-contract §8）。 */
export function hasFields(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
}

/** 顶层形态断言：array 必须是数组；object 必须是对象（含字段与等值要求）。 */
export function shapeAssertions(prefix, expect, value) {
  const assertions = []
  if (expect.kind === 'array') {
    assertions.push(make(`${prefix}.isArray`, true, Array.isArray(value)))
  } else if (expect.kind === 'object') {
    assertions.push(make(`${prefix}.isObject`, true, value !== null && typeof value === 'object' && !Array.isArray(value)))
    if (Array.isArray(expect.fields) && expect.fields.length > 0) {
      assertions.push(make(`${prefix}.resultFields`, expect.fields, expect.fields.filter((f) => !hasFields(value, [f])), { ok: hasFields(value, expect.fields) }))
    }
  }
  if (expect.equals && typeof expect.equals === 'object') {
    for (const [key, expectedValue] of Object.entries(expect.equals)) {
      assertions.push(make(`${prefix}.${key}`, expectedValue, value === null || typeof value !== 'object' ? undefined : value[key]))
    }
  }
  return assertions
}
