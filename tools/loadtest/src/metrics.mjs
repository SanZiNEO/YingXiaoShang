// 职责：解析 /metrics 的 Prometheus exposition 文本，做快照完整性核对、前后快照增量对比与直方图分位数复算；纯文本解析 + 纯函数，不发任何请求。

/** 冻结 §9.2 的 10 个指标名（逐字，顺序即清单顺序）。 */
export const METRIC_NAMES = [
  'yxs_http_requests_total',
  'yxs_http_request_duration_seconds',
  'yxs_rpc_requests_total',
  'yxs_tokens_total',
  'yxs_errors_total',
  'yxs_sqlite_busy_total',
  'yxs_sse_active_connections',
  'yxs_sse_first_token_seconds',
  'yxs_login_total',
  'yxs_process_start_time_seconds',
]

/** 两张直方图的 12 个有限桶边界（秒）；+Inf 是 exposition 结构性产物，不在此清单内。 */
export const BUCKET_BOUNDARIES = [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 13, 20, 30]

/** 需要做桶核对的两张直方图基名。 */
const HISTOGRAM_BASES = [
  'yxs_http_request_duration_seconds',
  'yxs_sse_first_token_seconds',
]

const SAMPLE_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([^\s]+)(?:\s+(\S+))?\s*$/

/** `# TYPE <name> <type>`：指标族的声明行。 */
const TYPE_RE = /^#\s+TYPE\s+([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(\S+)\s*$/

/** `# HELP <name> <text>`：指标族的说明行。 */
const HELP_RE = /^#\s+HELP\s+([a-zA-Z_:][a-zA-Z0-9_:]*)\s+/

/**
 * 把边界数值格式化成 exposition 里的 le 文本（整数不带小数点）。
 * @param {number} b
 * @returns {string}
 */
function boundaryText(b) {
  return Number.isInteger(b) ? String(b) : String(b)
}

/**
 * 解析标签片段 `key="v",key2="v2"`，处理 Prometheus 标签转义。
 * @param {string|undefined} labelPart
 * @returns {Record<string,string>}
 */
function parseLabels(labelPart) {
  /** @type {Record<string,string>} */
  const labels = {}
  if (!labelPart) return labels
  for (const pair of labelPart.split(',')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    const raw = trimmed.slice(eq + 1).trim()
    if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') continue
    const value = raw
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\n/g, '\n')
    labels[key] = value
  }
  return labels
}

/**
 * 标签键：按 key 升序拼成 `key=value`，多标签用 `|` 连接；无标签用 `'value'`。
 * @param {Record<string,string>} labels
 * @returns {string}
 */
function labelKey(labels) {
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return 'value'
  return keys.map((k) => `${k}=${labels[k]}`).join('|')
}

/**
 * 去掉直方图族后缀（_bucket/_sum/_count）；counter 的 `_total` 保留。
 * @param {string} name
 * @returns {string}
 */
export function stripFamilySuffix(name) {
  return String(name).replace(/_(bucket|sum|count)$/, '')
}

/**
 * 解析 Prometheus exposition 文本。
 *
 * `declared` 收集 `# TYPE` / `# HELP` 声明过的指标族名。prom-client 对「带标签且从未 inc」
 * 的 counter 只输出 HELP/TYPE 两行、不输出样本行，所以判定「指标存在」必须看声明行，
 * 只看样本行会把零错误轮次的 `yxs_errors_total` 误判成缺失。
 * @param {string} text
 * @returns {{ samples: Array<{name:string,labels:Record<string,string>,value:number}>, families: Record<string, Array<{name:string,labels:Record<string,string>,value:number}>>, declared: Record<string,string> }}
 */
export function parseExposition(text) {
  /** @type {Array<{name:string,labels:Record<string,string>,value:number}>} */
  const samples = []
  /** @type {Record<string, Array<{name:string,labels:Record<string,string>,value:number}>>} */
  const families = {}
  /** @type {Record<string,string>} 指标族名 -> 声明类型 */
  const declared = {}
  if (typeof text !== 'string') return { samples, families, declared }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      const typeMatch = TYPE_RE.exec(line)
      if (typeMatch) {
        declared[typeMatch[1]] = typeMatch[2]
        continue
      }
      const helpMatch = HELP_RE.exec(line)
      if (helpMatch && declared[helpMatch[1]] === undefined) declared[helpMatch[1]] = ''
      continue
    }
    const m = SAMPLE_RE.exec(line)
    if (!m) continue
    const name = m[1]
    const labels = parseLabels(m[2])
    const value = Number(m[3])
    if (!Number.isFinite(value)) continue
    const sample = { name, labels, value }
    samples.push(sample)
    const base = stripFamilySuffix(name)
    ;(families[base] ??= []).push(sample)
  }
  return { samples, families, declared }
}

/**
 * 从样本集合里取某指标名（精确匹配，不含直方图后缀族）的样本。
 * @param {Array<{name:string,labels:Record<string,string>,value:number}>} samples
 * @param {string} metricName
 */
function samplesOf(samples, metricName) {
  return samples.filter((s) => s.name === metricName)
}

/**
 * 核对单张直方图的有限桶集合。
 * 缺桶与多桶都要报：AC-09 要求「恰好 12 个」，只查缺会让多出来的边界蒙混过关。
 * @param {Array<{name:string,labels:Record<string,string>,value:number}>} familySamples
 * @returns {{ missing: string[], extra: string[] }}
 */
function bucketDiffFor(familySamples) {
  const present = new Set()
  for (const s of familySamples) {
    if (!s.name.endsWith('_bucket')) continue
    if (!('le' in s.labels)) continue
    const le = s.labels.le
    present.add(le)
    const num = Number(le)
    if (Number.isFinite(num)) present.add(boundaryText(num))
  }
  const expected = new Set(BUCKET_BOUNDARIES.map(boundaryText))
  const missing = BUCKET_BOUNDARIES.filter((b) => !present.has(boundaryText(b))).map(boundaryText)
  const extra = [...present].filter((le) => le !== '+Inf' && !expected.has(le)).sort()
  return { missing, extra }
}

/**
 * 解析并核对一次 /metrics 快照。
 * @param {string} text
 * @returns {import('./metrics.mjs').MetricsAnalysis}
 */
export function analyzeSnapshot(text) {
  const { samples, families, declared } = parseExposition(text)
  const familyNames = new Set(Object.keys(families))
  const declaredNames = new Set(Object.keys(declared))

  /** @type {string[]} */
  const present = []
  /** @type {string[]} */
  const missing = []
  for (const name of METRIC_NAMES) {
    // 存在性以 `# TYPE` / `# HELP` 声明行为准：带标签且从未 inc 的 counter 只有声明行、
    // 没有样本行，看样本行会把零错误轮次的 yxs_errors_total 误判为缺失（AC-08 会因此永不通过）。
    if (declaredNames.has(name) || familyNames.has(name)) present.push(name)
    else missing.push(name)
  }

  /** @type {Record<string, Record<string, number>>} */
  const counters = {}
  for (const s of samples) {
    if (/_bucket$|_sum$|_count$/.test(s.name)) continue
    ;(counters[s.name] ??= {})[labelKey(s.labels)] = s.value
  }

  /** @type {Record<string, string[]>} */
  const missingBucketsByHistogram = {}
  /** @type {Record<string, string[]>} */
  const extraBucketsByHistogram = {}
  const missingBucketsSet = new Set()
  const extraBucketsSet = new Set()
  for (const base of HISTOGRAM_BASES) {
    const diff = bucketDiffFor(families[base] ?? [])
    missingBucketsByHistogram[base] = diff.missing
    extraBucketsByHistogram[base] = diff.extra
    for (const b of diff.missing) missingBucketsSet.add(b)
    for (const b of diff.extra) extraBucketsSet.add(b)
  }
  const missingBuckets = [...missingBucketsSet]
  const extraBuckets = [...extraBucketsSet]
  const bucketsOk = missingBuckets.length === 0 && extraBuckets.length === 0

  // sqlite busy：按 db 标签汇总。
  const busy = { total: 0, byDb: /** @type {Record<string,number>} */ ({}) }
  for (const s of samplesOf(samples, 'yxs_sqlite_busy_total')) {
    const db = s.labels.db || 'default'
    busy.byDb[db] = s.value
    busy.total += s.value
  }

  // tokens：按 student_id 分别记 prompt/completion 快照绝对值。
  /** @type {Record<string,{prompt:number,completion:number}>} */
  const tokens = {}
  for (const s of samplesOf(samples, 'yxs_tokens_total')) {
    const sid = s.labels.student_id || ''
    const kind = s.labels.kind === 'completion' ? 'completion' : 'prompt'
    ;(tokens[sid] ??= { prompt: 0, completion: 0 })[kind] = s.value
  }

  const activeSamples = samplesOf(samples, 'yxs_sse_active_connections')
  const sseActive = activeSamples.length > 0 ? activeSamples[0].value : null

  const startSamples = samplesOf(samples, 'yxs_process_start_time_seconds')
  const processStartTime = startSamples.length > 0 ? startSamples[0].value : null

  const serverLatency = histogramQuantile(
    { samples, families },
    'yxs_http_request_duration_seconds',
    null,
  )
  const firstTokenServer = histogramQuantile(
    { samples, families },
    'yxs_sse_first_token_seconds',
    null,
  )

  return {
    present,
    missing,
    counters,
    bucketsOk,
    missingBuckets,
    missingBucketsByHistogram,
    extraBuckets,
    extraBucketsByHistogram,
    busy,
    tokens,
    sseActive,
    processStartTime,
    serverLatency,
    firstTokenServer,
    // 内部保留解析结果，供 histogramQuantile / 增量对比复用；消费方可忽略。
    samples,
    families,
  }
}

/**
 * 归一化入参：允许直接传快照文本或 analyzeSnapshot 的结果。
 * @param {string|ReturnType<typeof analyzeSnapshot>} input
 */
function normalizeAnalysis(input) {
  if (input && typeof input === 'object' && Array.isArray(input.present)) return input
  if (typeof input === 'string') return analyzeSnapshot(input)
  return analyzeSnapshot('')
}

/**
 * 对比前后两次快照：busy 增量、token 增量、计数器回退标记、重启检测。
 * counter 回退（结束值 < 起始值）时取结束值为准，并标 counterReset，不做负增长。
 * @param {string|ReturnType<typeof analyzeSnapshot>} before
 * @param {string|ReturnType<typeof analyzeSnapshot>} after
 */
export function diffSnapshots(before, after) {
  const b = normalizeAnalysis(before)
  const a = normalizeAnalysis(after)

  let counterReset = false

  /** @type {Record<string,number>} */
  const busyByDb = {}
  let busyDelta = 0
  const dbKeys = new Set([...Object.keys(b.busy.byDb), ...Object.keys(a.busy.byDb)])
  for (const db of dbKeys) {
    const beforeVal = b.busy.byDb[db] ?? 0
    const afterVal = a.busy.byDb[db] ?? 0
    let delta
    if (afterVal < beforeVal) {
      counterReset = true
      delta = afterVal
    } else {
      delta = afterVal - beforeVal
    }
    busyByDb[db] = delta
    busyDelta += delta
  }

  /** @type {Record<string,{prompt:number,completion:number}>} */
  const tokenDelta = {}
  const studentKeys = new Set([...Object.keys(b.tokens), ...Object.keys(a.tokens)])
  for (const sid of studentKeys) {
    const bt = b.tokens[sid] ?? { prompt: 0, completion: 0 }
    const at = a.tokens[sid] ?? { prompt: 0, completion: 0 }
    const row = { prompt: 0, completion: 0 }
    for (const kind of /** @type {const} */ (['prompt', 'completion'])) {
      let delta
      if (at[kind] < bt[kind]) {
        counterReset = true
        delta = at[kind]
      } else {
        delta = at[kind] - bt[kind]
      }
      row[kind] = delta
    }
    tokenDelta[sid] = row
  }

  const processRestarted =
    b.processStartTime != null &&
    a.processStartTime != null &&
    b.processStartTime !== a.processStartTime

  return {
    busyDelta,
    busyByDb,
    counterReset,
    tokenDelta,
    processStartTime: a.processStartTime,
    processRestarted,
    sseActive: a.sseActive,
  }
}

/**
 * 按 Prometheus histogram_quantile 口径在桶内线性插值；返回毫秒（ms），算不出返回 null。
 * q 传 null 时返回 { p50, p95, p99 } 分位对象；否则返回单个分位毫秒数。
 * @param {ReturnType<typeof analyzeSnapshot>|{samples:Array<{name:string,labels:Record<string,string>,value:number}>}} analysis
 * @param {string} baseName 直方图基名（不含 _bucket/_sum/_count）
 * @param {number|null} q 0..1；null 表示取 p50/p95/p99 整组
 * @returns {number|{p50:number|null,p95:number|null,p99:number|null}|null}
 */
export function histogramQuantile(analysis, baseName, q) {
  const source =
    analysis && Array.isArray(analysis.samples)
      ? analysis
      : analyzeSnapshot(String(analysis ?? ''))

  /** @type {Map<string, number>} le -> 累计计数（跨标签序列求和） */
  const bucketMap = new Map()
  let totalCount = 0
  for (const s of source.samples) {
    if (s.name === `${baseName}_bucket`) {
      const le = s.labels.le
      if (le == null) continue
      bucketMap.set(le, (bucketMap.get(le) ?? 0) + s.value)
    } else if (s.name === `${baseName}_count`) {
      totalCount += s.value
    }
  }
  if (bucketMap.size === 0) return q == null ? null : null

  const buckets = [...bucketMap.entries()]
    .map(([le, count]) => ({
      le: le === '+Inf' ? Infinity : Number(le),
      leText: le,
      count,
    }))
    .sort((x, y) => x.le - y.le)

  const infBucket = buckets.find((b) => !Number.isFinite(b.le))
  if (totalCount === 0) totalCount = infBucket ? infBucket.count : 0
  if (totalCount <= 0) return q == null ? null : null

  /**
   * 单分位计算，返回秒；不可估返回 null。
   * @param {number} quantile
   */
  function quantileOne(quantile) {
    if (!(quantile >= 0 && quantile <= 1)) return null
    const rank = quantile * totalCount
    let lowerCount = 0
    let lowerLe = 0
    for (const bucket of buckets) {
      if (bucket.count >= rank) {
        if (!Number.isFinite(bucket.le)) return null
        if (bucket.count === lowerCount) return bucket.le
        const fraction = (rank - lowerCount) / (bucket.count - lowerCount)
        return lowerLe + fraction * (bucket.le - lowerLe)
      }
      lowerCount = bucket.count
      lowerLe = bucket.le
    }
    return null
  }

  const round2 = (v) => (v == null ? null : Number(v.toFixed(2)))

  if (q == null) {
    const pick = (p) => {
      const sec = quantileOne(p)
      return sec == null ? null : round2(sec * 1000)
    }
    return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99) }
  }
  const sec = quantileOne(q)
  return sec == null ? null : round2(sec * 1000)
}
