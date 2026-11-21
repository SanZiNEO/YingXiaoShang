// @yxs/migrate-pg · values.js
//
// 取值归一的唯一实现：migrate.js（决定送进 COPY 的字节）与 verify.js（决定两侧是否相等）
// 必须调用同一组函数。两侧口径一旦分叉，同一份合法数据就会出现「migrate 成功、verify
// 以环境错误退出」这种自相矛盾的结论。
//
// jsonb 的核心约定（02-contract §3.1）：JS 只负责**校验**合法性，绝不负责重新序列化。
// `JSON.parse` → `JSON.stringify` 往返会把 19 位雪花 id 改写成 1.2345678901234568e+29、
// 把 1e400 变成 null、把 1.0 变成 1；这些失真一旦发生就不可逆，且 verify 若也用同一
// 往返比对就永远发现不了。因此送 COPY 的始终是源库原始文本（空串按默认 JSON 归一），
// 数值精度由 PostgreSQL 的 jsonb 解析器保留。

// 合法 ISO-8601：Z 或 ±HH:MM 偏移；秒可省略；可带小数秒。窄 `…Z$` 正则会误杀带偏移的合法值。
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i

// 已带中文定位信息的错误：调用方原样输出，不再套「装载表 … 失败」前缀。
export class LocalizedError extends Error {
  constructor(message) {
    super(message)
    this.localized = true
  }
}

// jsonb 列默认值归一：`'[]'::jsonb` → `[]`，`'{}'::jsonb` → `{}`；无 JSON 默认值返回 null。
// 返回值是 JSON 文本（不是 JS 值），可直接拼进 COPY 数据流。
export function defaultJsonText(defaultLit) {
  if (!defaultLit) return null
  const bare = String(defaultLit).replace(/::\s*jsonb\s*$/i, '').trim().replace(/^'(.*)'$/s, '$1')
  if (bare === '[]') return '[]'
  if (bare === '{}') return '{}'
  return null
}

function requireJsonText(table, col, text, pk) {
  try {
    JSON.parse(text)
  } catch (err) {
    throw new LocalizedError(
      `表 ${table.name} 的列 ${col.name} 不是合法 JSON（主键 ${pk}）：${reasonOf(err)}。`,
    )
  }
  return text
}

function reasonOf(err) {
  const msg = err && err.message ? String(err.message) : String(err)
  return msg.split('\n')[0].trim()
}

// 送 COPY 的 jsonb 文本：空串 → 该列默认 JSON（契约 §3.1）；其余按原文直传。
export function jsonbTextForCopy(table, col, raw, pk) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string' && raw === '') {
    const norm = defaultJsonText(col.default)
    if (norm === null) {
      throw new LocalizedError(
        `表 ${table.name} 的列 ${col.name} 不是合法 JSON（主键 ${pk}）：空串且该列无 JSON 默认值。`,
      )
    }
    return norm
  }
  // SQLite TEXT 亲和性可能让该列混入数值；统一转成文本后再校验，绝不先转成 JS 数字。
  const text = typeof raw === 'string' ? raw : String(raw)
  return requireJsonText(table, col, text, pk)
}

// 时间戳：空串是「未发生」的占位，归一为 NULL（契约 §3.1）；其余按 ISO-8601 解析成 UTC。
export function timestampForCopy(table, col, raw, pk) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string' && raw === '') return null
  const text = String(raw)
  if (!ISO_RE.test(text) || Number.isNaN(new Date(text).getTime())) {
    throw new LocalizedError(
      `时间戳列 ${table.name}.${col.name} 存在非 ISO 取值（主键 ${pk}）：${text}。`,
    )
  }
  return new Date(text).toISOString()
}

// 时间戳的比对口径：NULL 与空串等价（源库空串 = PG NULL），其余比时刻而非比文本。
export function timestampMillisForCompare(table, col, raw, pk) {
  if (raw === null || raw === undefined || raw === '') return null
  if (raw instanceof Date) return raw.getTime()
  const text = String(raw)
  if (!ISO_RE.test(text)) {
    throw new LocalizedError(
      `时间戳列 ${table.name}.${col.name} 存在非 ISO 取值（主键 ${pk}）：${text}。`,
    )
  }
  const ms = new Date(text).getTime()
  if (Number.isNaN(ms)) {
    throw new LocalizedError(
      `时间戳列 ${table.name}.${col.name} 存在非 ISO 取值（主键 ${pk}）：${text}。`,
    )
  }
  return ms
}

// 唯一的布尔例外列（skills.enabled）；值域 0/1，其他值不静默兜底。
export function booleanForCopy(table, col, raw, pk) {
  if (raw === 1 || raw === '1' || raw === true) return 'true'
  if (raw === 0 || raw === '0' || raw === false) return 'false'
  throw new LocalizedError(
    `表 ${table.name} 的列 ${col.name} 只接受 0 或 1（主键 ${pk}）：${String(raw)}。`,
  )
}

// 进入 COPY 前逐列归一；返回值要么是 null，要么是可直接写进 CSV 的文本。
export function valueForCopy(table, col, raw, pk) {
  if (raw === null || raw === undefined) return null
  switch (col.pg) {
    case 'jsonb':
      return jsonbTextForCopy(table, col, raw, pk)
    case 'timestamptz':
      return timestampForCopy(table, col, raw, pk)
    case 'boolean':
      return booleanForCopy(table, col, raw, pk)
    case 'bigint':
    case 'double precision':
      return String(raw)
    default:
      // text：保留空串；非字符串值显式 String(v)，不静默变空串。
      return typeof raw === 'string' ? raw : String(raw)
  }
}

// ---------------------------------------------------------------------------
// 精确 JSON 比对
//
// verify 需要判断「源库文本」与「PG 存回来的文本」是否表达同一个 JSON 值。用 JSON.parse
// 之后比 JS 值是不成立的：19 位整数会被读成双精度浮点，两侧同时失真后仍然相等，篡改就
// 漏过去了。这里用保留数字字面量的解析器 + 十进制规范化比较，保证精度可判。
// ---------------------------------------------------------------------------

class JsonNumber {
  constructor(key) {
    this.key = key
  }
}

// 把 JSON 数字字面量规范成「符号 + 有效数字 + 十进制指数」，不经过浮点。
// 1 / 1.0 / 1e0 归一为同一个 key；1e400 与 1.2345678901234568e+29 保持不同。
export function canonicalDecimal(literal) {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal)
  if (!m) return null
  const sign = m[1] === '-' ? '-' : ''
  const intPart = m[2]
  const fracPart = m[3] || ''
  let exp = m[4] ? Number(m[4]) : 0
  let digits = (intPart + fracPart).replace(/^0+/, '')
  exp -= fracPart.length
  if (digits === '') return '0'
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1)
    exp += 1
  }
  return `${sign}${digits}e${exp}`
}

// 保留数字字面量的 JSON 解析器；只接受 RFC 8259 语法，非法输入抛错。
export function parseJsonExact(text) {
  let i = 0
  const src = String(text)

  function fail(what) {
    throw new SyntaxError(`${what}（位置 ${i}）`)
  }

  function skipWs() {
    while (i < src.length) {
      const ch = src[i]
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') i++
      else break
    }
  }

  function parseValue() {
    skipWs()
    const ch = src[i]
    if (ch === '{') return parseObject()
    if (ch === '[') return parseArray()
    if (ch === '"') return parseString()
    if (src.startsWith('true', i)) { i += 4; return true }
    if (src.startsWith('false', i)) { i += 5; return false }
    if (src.startsWith('null', i)) { i += 4; return null }
    return parseNumber()
  }

  function parseObject() {
    i++
    const out = new Map()
    skipWs()
    if (src[i] === '}') { i++; return out }
    for (;;) {
      skipWs()
      if (src[i] !== '"') fail('对象键必须是字符串')
      const key = parseString()
      skipWs()
      if (src[i] !== ':') fail('对象键后缺少冒号')
      i++
      out.set(key, parseValue())
      skipWs()
      if (src[i] === ',') { i++; continue }
      if (src[i] === '}') { i++; return out }
      fail('对象未正确闭合')
    }
  }

  function parseArray() {
    i++
    const out = []
    skipWs()
    if (src[i] === ']') { i++; return out }
    for (;;) {
      out.push(parseValue())
      skipWs()
      if (src[i] === ',') { i++; continue }
      if (src[i] === ']') { i++; return out }
      fail('数组未正确闭合')
    }
  }

  function parseString() {
    i++
    let out = ''
    for (;;) {
      if (i >= src.length) fail('字符串未闭合')
      const ch = src[i++]
      if (ch === '"') return out
      if (ch === '\\') {
        const esc = src[i++]
        if (esc === 'u') {
          const hex = src.slice(i, i + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('非法 \\u 转义')
          out += String.fromCharCode(parseInt(hex, 16))
          i += 4
        } else if (esc === '"') out += '"'
        else if (esc === '\\') out += '\\'
        else if (esc === '/') out += '/'
        else if (esc === 'b') out += '\b'
        else if (esc === 'f') out += '\f'
        else if (esc === 'n') out += '\n'
        else if (esc === 'r') out += '\r'
        else if (esc === 't') out += '\t'
        else fail('非法转义')
        continue
      }
      out += ch
    }
  }

  function parseNumber() {
    const start = i
    if (src[i] === '-' || src[i] === '+') i++
    while (i < src.length && /[0-9]/.test(src[i])) i++
    if (src[i] === '.') {
      i++
      while (i < src.length && /[0-9]/.test(src[i])) i++
    }
    if (src[i] === 'e' || src[i] === 'E') {
      i++
      if (src[i] === '-' || src[i] === '+') i++
      while (i < src.length && /[0-9]/.test(src[i])) i++
    }
    const literal = src.slice(start, i)
    const key = canonicalDecimal(literal)
    if (key === null) fail(`非法数字 ${literal}`)
    return new JsonNumber(key)
  }

  const value = parseValue()
  skipWs()
  if (i !== src.length) fail('JSON 之后还有多余字符')
  return value
}

function jsonExactEqual(a, b) {
  if (a instanceof JsonNumber || b instanceof JsonNumber) {
    return a instanceof JsonNumber && b instanceof JsonNumber && a.key === b.key
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, idx) => jsonExactEqual(item, b[idx]))
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false
    for (const [key, val] of a) {
      if (!b.has(key)) return false
      if (!jsonExactEqual(val, b.get(key))) return false
    }
    return true
  }
  return a === b
}

// 两段 JSON 文本是否表达同一个值（键序无关，数字按十进制精确比较）。
export function jsonTextEqual(left, right) {
  return jsonExactEqual(parseJsonExact(left), parseJsonExact(right))
}
