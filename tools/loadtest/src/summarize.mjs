// summarize.mjs —— F 轮压测汇总层：纯函数聚合样本与指标快照，产出报告数据对象；不发请求、不落盘。

/** 冻结 §9.2 的 10 个指标名（逐字）；metrics.mjs 缺失时作为本地兜底口径。 */
export const METRIC_NAMES = [
  'yxs_http_requests_total', 'yxs_http_request_duration_seconds', 'yxs_rpc_requests_total',
  'yxs_tokens_total', 'yxs_errors_total', 'yxs_sqlite_busy_total',
  'yxs_sse_active_connections', 'yxs_sse_first_token_seconds',
  'yxs_login_total', 'yxs_process_start_time_seconds',
];

/** 五条告警规则（与 prometheus/alerts.yml 逐字一致；规则 3 使用默认配额 200000 对应的常量阈值）。 */
export const ALERT_RULES = [
  {
    name: 'YxsHttp5xxRate',
    severity: 'page',
    expr: 'sum(rate(yxs_http_requests_total{status=~"5.."}[5m])) / sum(rate(yxs_http_requests_total[5m])) > 0.01',
    for: '5m',
  },
  {
    name: 'YxsHttpP95Latency',
    severity: 'warn',
    expr: 'histogram_quantile(0.95, sum by (le)(rate(yxs_http_request_duration_seconds_bucket[10m]))) > 3',
    for: '10m',
  },
  {
    name: 'YxsTokenUsageHigh',
    severity: 'warn',
    expr: 'sum by (student_id)(yxs_tokens_total{kind="prompt"}) > 160000',
    for: '15m',
  },
  {
    name: 'YxsSqliteBusySpike',
    severity: 'warn',
    expr: 'increase(yxs_sqlite_busy_total[5m]) > 5',
    for: '5m',
  },
  {
    name: 'YxsServerDown',
    severity: 'page',
    expr: 'up{job="yxs-server"} == 0',
    for: '1m',
  },
];

/** 规则 `for` 时长换算毫秒（冻结值，不自创）。 */
const FOR_MS = { '1m': 60_000, '5m': 300_000, '10m': 600_000, '15m': 900_000 };

/** 冻结口径的默认配额（`ALERT_RULES[2].expr` 里的 160000 = 0.8 × 200000）。 */
export const DEFAULT_TOKEN_QUOTA = 200_000;

/**
 * 按本轮 `--token-quota` 派生规则集：只有规则 3 的常量阈值随配额走。
 *
 * 之前规则 3 的 expr 硬编码 160000，与 `--token-quota` 脱钩：跑 `--token-quota 100` 时
 * verdict 按 80 判红、告警演练却仍按 160000 判未越线，同一份报告里两个口径打架。
 * 冻结表达式本身保持 200000 口径（`ALERT_RULES` 不改，仍与 alerts.yml 逐字一致），
 * 这里只在评估时按实际配额重算阈值；改文件阈值需同步 alerts.yml。
 * @param {number} tokenQuota
 * @returns {typeof ALERT_RULES}
 */
export function alertRulesFor(tokenQuota) {
  const quota = Number(tokenQuota)
  if (!Number.isFinite(quota) || quota <= 0) return ALERT_RULES
  const threshold = Math.round(0.8 * quota)
  return ALERT_RULES.map((rule) => (
    rule.name === 'YxsTokenUsageHigh'
      ? { ...rule, expr: `sum by (student_id)(yxs_tokens_total{kind="prompt"}) > ${threshold}` }
      : rule
  ))
}

/** impl-spec §5 固定 caveats 原文。 */
const FIXED_CAVEATS = [
  '首 token 延迟测自本机回环，仅用于回归对比，不代表局域网/公网真实首字节时间。',
  'mock 模式下 token 用量为固定 usage（每轮 prompt 100 / completion 50），与真实模型计费口径不同，两档不合并平均。',
  'stub 目标无数据库与真实模型，延迟与 SQLITE_BUSY 数字只用于验证工具链，不作为服务端性能基线。',
  '服务端直方图分位精度受 12 个桶边界限制（0.05…30 秒），桶间真实分布不可还原。',
  '客户端分位数为内存样本最近秩法，样本数 < 30 时标 low-sample，不参与红绿判定。',
];

/** impl-spec §6 必须登记的四条偏差（4xx 口径 / 无 usage 事件 / token_quota 缺口 / +Inf 桶）。 */
const FIXED_WARNINGS = [
  '4xx 一律按 http4xx 单列、不进失败分子；businessError 仅指 "HTTP 200 且信封 ok:false"。',
  '冻结 §7.1 SSE 事件集（session/round/text/tool/tool-end/done/error）不含 usage 事件，故本轮不做流末 usage 交叉核对，token 一律取 /metrics。',
  'yxs_token_quota 不在冻结 §9.2 清单，alerts 第 3 条用固定配额替代（0.8×--token-quota），登记"待 A 轮补 gauge"。',
  '+Inf 桶是 exposition 结构性产物，桶核对只比对 12 个有限 le。',
];

const SSE_SCENARIOS = new Set(['ask']);
const BUCKET_KEYS = ['http2xx', 'http4xx', 'http5xx', 'businessError', 'sseError', 'cancelled', 'timeout', 'networkAbort'];

/**
 * 最近秩法分位数：升序数组，rank=ceil(p*n) 夹到 [1,n]，取 sorted[rank-1]，不插值；空数组返回 null。
 * @param {number[]} sortedAsc 已升序排序的数值数组
 * @param {number} p 分位（0..1）
 */
export function quantile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  let rank = Math.ceil(p * n);
  if (rank < 1) rank = 1;
  if (rank > n) rank = n;
  return sortedAsc[rank - 1];
}

/**
 * 构造分位数对象（ms）；空数组全字段 null、sampleCount=0。
 * @param {number[]} values 原始数值数组（null/非有限值自动剔除）
 * @param {string} unit 单位，恒为 'ms'
 */
export function quantileObject(values, unit = 'ms') {
  const nums = (values ?? []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const n = nums.length;
  const empty = { p50: null, p95: null, p99: null, avg: null, min: null, max: null, sampleCount: 0, unit };
  if (n === 0) return empty;
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = nums.reduce((a, b) => a + b, 0);
  // 分位数在汇总层统一保留 2 位小数：保证 md 与 json 逐字同值，同时消掉浮点尾差。
  const round2 = (v) => (v === null ? null : Number(v.toFixed(2)));
  return {
    p50: round2(quantile(sorted, 0.5)),
    p95: round2(quantile(sorted, 0.95)),
    p99: round2(quantile(sorted, 0.99)),
    avg: round2(sum / n),
    min: round2(sorted[0]),
    max: round2(sorted[n - 1]),
    sampleCount: n,
    unit,
  };
}

/**
 * 八类互斥状态分桶；requestsTotal=counted 样本数，requestsFailed 不含 4xx 与 cancelled；
 * 另算 5xx 率（http5xx/(http2xx+http4xx+http5xx)），不并入 errorRate。
 * @param {Array} samples Sample[]
 */
export function statusBreakdown(samples) {
  const counted = (samples ?? []).filter((s) => s.counted !== false);
  const buckets = Object.fromEntries(BUCKET_KEYS.map((k) => [k, 0]));
  for (const s of counted) {
    const cls = s.errorClass;
    if (cls === null || cls === undefined) {
      buckets.http2xx += 1;
    } else if (Object.prototype.hasOwnProperty.call(buckets, cls)) {
      buckets[cls] += 1;
    } else {
      buckets.http2xx += 1;
    }
  }
  const requestsTotal = counted.length;
  const requestsOk = buckets.http2xx;
  const requestsFailed = buckets.http5xx + buckets.businessError + buckets.sseError + buckets.timeout + buckets.networkAbort;
  const errorRate = requestsTotal > 0 ? requestsFailed / requestsTotal : null;
  const httpDenom = buckets.http2xx + buckets.http4xx + buckets.http5xx;
  const fiveXxRate = httpDenom > 0 ? buckets.http5xx / httpDenom : null;
  return { buckets, requestsTotal, requestsOk, requestsFailed, errorRate, fiveXxRate };
}

/**
 * 按学生聚合明细行；turns 只数收到 done 的 ask；latencyMs 只装非 SSE 请求；firstTokenMs 只装 ask；
 * tokens 取 /metrics 增量；回读轮次与本地计数不一致时把差异文案返回 warnings，不改数。
 * @param {string[]} studentIds 学生编号列表
 * @param {Array} samples Sample[]
 * @param {object} tokenDelta { [studentId]: { prompt, completion } }
 * @returns {{ rows: Array, warnings: string[] }}
 */
export function perStudentRows(studentIds, samples, tokenDelta) {
  const byId = new Map();
  for (const id of studentIds ?? []) byId.set(id, []);
  for (const s of samples ?? []) {
    // 预检 health 样本 counted:false 且不带 studentId，不参与每学生聚合（perStudent 长度必须等于并发学生数）
    if (s.counted === false || !s.studentId) continue;
    if (!byId.has(s.studentId)) byId.set(s.studentId, []);
    byId.get(s.studentId).push(s);
  }
  const warnings = [];
  const rows = [];
  for (const id of studentIds ?? []) {
    const list = byId.get(id) ?? [];
    const counted = list.filter((s) => s.counted !== false);
    const loginSample = list.find((s) => s.scenario === 'login');
    const loginOk = Boolean(loginSample && loginSample.ok === true && (loginSample.errorClass === null || loginSample.errorClass === undefined));
    const asks = counted.filter((s) => s.scenario === 'ask');
    const okAsks = asks.filter((s) => s.ok === true && (s.errorClass === null || s.errorClass === undefined));
    const answers = counted.filter((s) => s.scenario === 'answer' && s.ok === true).length;
    const submissions = counted.filter((s) => s.scenario === 'answer-set' && s.ok === true).length;
    const turns = okAsks.length;
    const tok = tokenDelta?.[id] ?? {};
    const tokensPrompt = Number(tok.prompt ?? 0);
    const tokensCompletion = Number(tok.completion ?? 0);
    const rpcCalls = counted.length;
    const rpcErrors = counted.filter((s) => s.errorClass !== null && s.errorClass !== undefined).length;
    const cancelled = counted.filter((s) => s.errorClass === 'cancelled').length;
    const timeouts = counted.filter((s) => s.errorClass === 'timeout').length;
    const firstTokenMs = asks.map((s) => s.firstTokenMs).filter((v) => typeof v === 'number' && Number.isFinite(v));
    const latencyMs = counted
      .filter((s) => !SSE_SCENARIOS.has(s.scenario))
      .map((s) => s.durationMs)
      .filter((v) => typeof v === 'number' && Number.isFinite(v));

    const readback = counted.find((s) => s.scenario === 'readback' && s.meta && typeof s.meta.turnsReadback === 'number');
    if (readback && readback.meta.turnsReadback !== turns) {
      warnings.push(`学生 ${id} 回读轮次 ${readback.meta.turnsReadback} 与本地计数 ${turns} 不一致，以本地样本计数为准。`);
    }

    let status;
    if (!loginOk || rpcCalls === 0) status = 'failed';
    else if (rpcErrors > 0) status = 'partial';
    else status = 'ok';

    rows.push({
      studentId: id,
      loginOk,
      asks: asks.length,
      answers,
      submissions,
      turns,
      tokensPrompt,
      tokensCompletion,
      tokensTotal: tokensPrompt + tokensCompletion,
      rpcCalls,
      rpcErrors,
      cancelled,
      timeouts,
      firstTokenMs,
      latencyMs,
      status,
    });
  }
  rows.sort((a, b) => a.studentId.localeCompare(b.studentId));
  return { rows, warnings };
}

/**
 * 七条冻结 verdict 判定；阈值只取冻结 §9.3 / 采样规则，不自创。
 * @param {object} ctx { summary, metricsScrape, config, preflightOk, serverRestarted }
 * @returns {{ overall: string, items: Array }}
 */
export function evaluateVerdicts(ctx) {
  const summary = ctx.summary ?? {};
  const scrape = ctx.metricsScrape ?? {};
  const config = ctx.config ?? {};
  const quota = Number(config.tokenQuota ?? 200_000);
  const breakdown = summary.statusBreakdown ?? {};
  const items = [];

  // 1. 指标完整性：10 指标 + 12 桶齐全（present 计数与 missing 双保险，避免空清单假绿）
  const missing = scrape.missing ?? [];
  const missingBuckets = scrape.missingBuckets ?? [];
  const extraBuckets = scrape.extraBuckets ?? [];
  const metricsOk = missing.length === 0 && (scrape.present ?? []).length === METRIC_NAMES.length && scrape.bucketsOk !== false;
  const bucketNotes = [
    missingBuckets.length ? `缺桶: ${missingBuckets.join(', ')}` : '',
    extraBuckets.length ? `多出桶: ${extraBuckets.join(', ')}` : '',
  ].filter(Boolean).join('，');
  items.push({
    rule: 'metrics-completeness',
    threshold: '10 个冻结指标 + 12 个有限桶齐全（不多不少）',
    observed: `present=${(scrape.present ?? []).length}/10${missing.length ? `，missing: ${missing.join(', ')}` : ''}${bucketNotes ? `，${bucketNotes}` : ''}`,
    state: metricsOk ? 'green' : 'incomplete',
    note: metricsOk ? '指标与桶边界齐全。' : '存在缺失指标或桶边界不符，本轮可观测性结论不完整。',
  });

  // 2. 5xx 率 ≤ 0.01（告警口径，分母仅 HTTP 样本）
  const httpDenom = (breakdown.http2xx ?? 0) + (breakdown.http4xx ?? 0) + (breakdown.http5xx ?? 0);
  if (httpDenom === 0) {
    items.push({ rule: 'http-5xx-rate', threshold: '5xx 率 ≤ 0.01', observed: '无 HTTP 样本', state: 'unknown', note: '缺少 HTTP 请求样本，无法计算 5xx 率。' });
  } else {
    const rate = (breakdown.http5xx ?? 0) / httpDenom;
    items.push({
      rule: 'http-5xx-rate',
      threshold: '5xx 率 ≤ 0.01',
      observed: `${(rate * 100).toFixed(2)}%（5xx=${breakdown.http5xx}/${httpDenom}）`,
      state: rate <= 0.01 ? 'green' : 'red',
      note: rate <= 0.01 ? '5xx 率在冻结阈值内。' : '5xx 率超过冻结阈值 1%。',
    });
  }

  // 3. 服务端直方图 P95 ≤ 3000ms；直方图缺失 → unknown，note 给客户端 P95
  const serverLatency = scrape.serverLatency ?? null;
  const serverP95 = serverLatency?.p95 ?? null;
  const clientP95 = summary.latency?.p95 ?? null;
  if (serverP95 === null || serverP95 === undefined) {
    items.push({
      rule: 'http-p95-latency',
      threshold: '服务端直方图 P95 ≤ 3000ms',
      observed: '服务端直方图缺失',
      state: 'unknown',
      note: `无服务端延迟直方图；客户端 P95=${clientP95 === null ? '—' : `${clientP95} ms`}（仅参考，不替代服务端口径）。`,
    });
  } else {
    items.push({
      rule: 'http-p95-latency',
      threshold: '服务端直方图 P95 ≤ 3000ms',
      observed: `${serverP95} ms（直方图复算，桶边界受限）`,
      state: serverP95 <= 3000 ? 'green' : 'red',
      note: serverP95 <= 3000 ? '服务端 P95 在冻结阈值 3s 内。' : '服务端 P95 超过冻结阈值 3s。',
    });
  }

  // 4. token 用量：任一学生 prompt ≤ 0.8×quota
  const tokenByStudent = scrape.tokenByStudent ?? {};
  const promptEntries = Object.entries(tokenByStudent).map(([sid, t]) => [sid, Number(t?.prompt ?? 0)]);
  const tokenLimit = 0.8 * quota;
  if (promptEntries.length === 0) {
    items.push({ rule: 'token-usage', threshold: `prompt ≤ 0.8×${quota}（=${tokenLimit}）`, observed: '无 token 指标数据', state: 'unknown', note: '缺少 yxs_tokens_total 按学生汇总，无法判定用量。' });
  } else {
    const [maxSid, maxPrompt] = promptEntries.reduce((a, b) => (b[1] > a[1] ? b : a), promptEntries[0]);
    items.push({
      rule: 'token-usage',
      threshold: `prompt ≤ 0.8×${quota}（=${tokenLimit}）`,
      observed: `最高 ${maxSid}: prompt=${maxPrompt}`,
      state: maxPrompt <= tokenLimit ? 'green' : 'red',
      note: maxPrompt <= tokenLimit ? '学生 prompt 用量在 80% 配额内。' : '有学生 prompt 用量超过 80% 配额。',
    });
  }

  // 5. sqlite busy 增量 ≤ 5
  const busyTotal = Number(summary.sqliteBusyTotal ?? 0);
  items.push({
    rule: 'sqlite-busy',
    threshold: 'busy 增量 ≤ 5',
    observed: `本轮 busy 增量 ${busyTotal} 次`,
    state: busyTotal <= 5 ? 'green' : 'red',
    note: `${scrape.counterReset ? 'counter-reset：以结束快照值为准；' : ''}${busyTotal <= 5 ? 'busy 增量在阈值内。' : 'busy 增量超过阈值 5 次。'}`,
  });

  // 6. server-up：预检健康且运行期间未重启
  if (ctx.preflightOk === false) {
    items.push({ rule: 'server-up', threshold: '预检健康且运行期间未重启', observed: '预检未通过', state: 'incomplete', note: '开跑前健康检查失败，目标不可用。' });
  } else if (ctx.serverRestarted === true) {
    items.push({ rule: 'server-up', threshold: '预检健康且运行期间未重启', observed: '运行期间进程重启', state: 'red', note: '前后快照 process_start_time_seconds 发生变化。' });
  } else {
    items.push({ rule: 'server-up', threshold: '预检健康且运行期间未重启', observed: '在线且未重启', state: 'green', note: '健康检查通过，进程启动时间未变。' });
  }

  // 7. 样本充分性：latency ≥30；有 SSE 时 firstToken ≥30
  const latencyCount = summary.latency?.sampleCount ?? 0;
  const firstTokenCount = summary.firstToken?.sampleCount ?? 0;
  const hasSse = firstTokenCount > 0 || (summary.turnsTotal ?? 0) > 0;
  const adequate = latencyCount >= 30 && (!hasSse || firstTokenCount >= 30);
  items.push({
    rule: 'sample-adequacy',
    threshold: 'latency 样本 ≥30（有 SSE 时 firstToken 也 ≥30）',
    observed: `latency=${latencyCount}，firstToken=${firstTokenCount}`,
    state: adequate ? 'green' : 'incomplete',
    note: adequate ? '样本量达标。' : '样本量 <30，标 low-sample，不参与红绿判定。',
  });

  // 8. 登录限流约束（契约行为，非缺陷）：同一 IP 每分钟 5 次登录尝试。
  // 报告必须写明本档实际可登录学生数，否则 429 会被误读成服务端并发能力不足。
  const loginLimitedCount = Number(ctx.loginRateLimitedCount ?? 0);
  const loginLimit = Number(ctx.loginLimit ?? 5);
  if (loginLimitedCount > 0) {
    items.push({
      rule: 'login-rate-limit',
      threshold: `同一 IP 每分钟 ${loginLimit} 次登录尝试（冻结 §3.1）`,
      observed: `${loginLimitedCount} 次登录被 429 RATE_LIMITED`,
      state: 'incomplete',
      note: `登录限流是契约行为，不是服务端缺陷：所有 VU 共用同一出口 IP 时，实际可登录学生数 = ${loginLimit}/分钟。`
        + ' 用 --client-ips distinct（默认）给每个 VU 独立 X-Forwarded-For 可绕开该约束。',
    });
  }

  const hasRed = items.some((i) => i.state === 'red');
  const hasIncomplete = items.some((i) => i.state === 'incomplete' || i.state === 'unknown');
  const overall = hasRed ? 'red' : hasIncomplete ? 'incomplete' : 'green';
  return { overall, items };
}

/**
 * 五条告警规则本轮演练状态：越线且本轮墙钟 < for → pending；越线且 ≥ for → firing；未越线 → inactive；算不出 → unknown。
 * @param {object} ctx { durationMs, tokenQuota, summary, metricsScrape, serverUp }
 * @returns {{ rules: Array }}
 */
export function evaluateAlerts(ctx) {
  const summary = ctx.summary ?? {};
  const scrape = ctx.metricsScrape ?? {};
  const durationMs = Number(ctx.durationMs ?? 0);
  const quota = Number(ctx.tokenQuota ?? 200_000);

  const stateFor = (over, unknown, ruleFor) => {
    if (unknown) return 'unknown';
    if (!over) return 'inactive';
    return durationMs < FOR_MS[ruleFor] ? 'pending' : 'firing';
  };

  const rules = alertRulesFor(quota).map((rule) => {
    let value = null;
    let over = false;
    let unknown = false;
    let reason = '';

    if (rule.name === 'YxsHttp5xxRate') {
      const rate = summary.fiveXxRate ?? null;
      value = rate;
      if (rate === null) {
        unknown = true;
        reason = '缺少 HTTP 样本，5xx 率算不出。';
      } else {
        over = rate > 0.01;
        reason = `5xx 率 ${(rate * 100).toFixed(2)}%，冻结阈值 1%；${over ? '已越线' : '未越线'}。`;
      }
    } else if (rule.name === 'YxsHttpP95Latency') {
      const p95 = scrape.serverLatency?.p95 ?? null;
      value = p95;
      if (p95 === null || p95 === undefined) {
        unknown = true;
        reason = '服务端延迟直方图缺失，P95 算不出。';
      } else {
        over = p95 > 3000;
        reason = `服务端直方图 P95 ${p95} ms，冻结阈值 3000 ms；${over ? '已越线' : '未越线'}（分位受桶边界限制）。`;
      }
    } else if (rule.name === 'YxsTokenUsageHigh') {
      const tokenByStudent = scrape.tokenByStudent ?? {};
      const entries = Object.entries(tokenByStudent).map(([sid, t]) => [sid, Number(t?.prompt ?? 0)]);
      const limit = 0.8 * quota;
      if (entries.length === 0) {
        unknown = true;
        reason = '无 yxs_tokens_total 按学生数据，用量算不出。';
      } else {
        const [, maxPrompt] = entries.reduce((a, b) => (b[1] > a[1] ? b : a), entries[0]);
        value = maxPrompt;
        over = maxPrompt > limit;
        reason = `最高学生 prompt=${maxPrompt}，阈值 0.8×${quota}=${limit}；替代 yxs_token_quota 口径（本轮 --token-quota 派生的固定常量），待 A 轮补 yxs_token_quota gauge 后恢复冻结原式；${over ? '已越线' : '未越线'}。`;
      }
    } else if (rule.name === 'YxsSqliteBusySpike') {
      const busy = Number(summary.sqliteBusyTotal ?? 0);
      value = busy;
      over = busy > 5;
      reason = `本轮 busy 增量 ${busy} 次，冻结阈值 5 次；${over ? '已越线' : '未越线'}。`;
    } else if (rule.name === 'YxsServerDown') {
      if (ctx.serverUp === null || ctx.serverUp === undefined) {
        unknown = true;
        value = null;
        reason = '健康状态未知，无法判定 up 是否为 0。';
      } else {
        const up = ctx.serverUp ? 1 : 0;
        value = up;
        over = up === 0;
        reason = `up=${up}，${over ? '目标失联' : '目标在线'}；冻结阈值 up==0 持续 1m。`;
      }
    }

    return { name: rule.name, severity: rule.severity, expr: rule.expr, for: rule.for, state: stateFor(over, unknown, rule.for), value, reason };
  });

  return { rules };
}

/** 样本落报告前的脱敏拷贝：剔除消息正文、原始帧等敏感字段，只留分类与计数所需字段。 */
function sanitizeSample(s) {
  return {
    studentId: s.studentId,
    iteration: s.iteration,
    scenario: s.scenario,
    method: s.method ?? null,
    at: s.at,
    durationMs: s.durationMs,
    firstTokenMs: s.firstTokenMs ?? null,
    status: s.status,
    code: s.code ?? null,
    ok: s.ok,
    errorClass: s.errorClass ?? null,
    requestId: s.requestId,
    counted: s.counted !== false,
  };
}

/**
 * 汇总产出完整 ReportData（impl-spec §2.3）。
 * @param {object} input { runId, startedAt, endedAt, toolVersion, target, llmMode, config, samples,
 *   beforeAnalysis, afterAnalysis, beforeText, afterText, rawSnapshotPath, clientStats, sseActivePeak,
 *   preflightOk, serverUp, warnings }
 * @returns {object} ReportData
 */
export function buildReportData(input) {
  const samples = input.samples ?? [];
  const config = input.config ?? {};
  const afterAnalysis = input.afterAnalysis ?? null;
  const beforeAnalysis = input.beforeAnalysis ?? null;
  const diff = input.metricDiff ?? null;

  const breakdown = statusBreakdown(samples);
  // token 增量优先取 diffSnapshots.tokenDelta；无 diff 时退回结束快照绝对值。
  const tokenDelta = diff?.tokenDelta ?? afterAnalysis?.tokens ?? {};
  const derivedIds = [
    ...new Set(samples.filter((s) => s.counted !== false && s.studentId).map((s) => s.studentId)),
  ]
  // blocked 是 studentIds 的子集，直接拼接会让 perStudent 出现重复行（同一学生两条明细）。
  const seedIds = [...new Set([
    ...(input.studentIds && input.studentIds.length > 0 ? input.studentIds : derivedIds),
    ...(input.blocked ?? []),
  ])];
  const { rows: perStudent, warnings: rowWarnings } = perStudentRows(seedIds, samples, tokenDelta);

  const latencyValues = samples
    .filter((s) => s.counted !== false && !SSE_SCENARIOS.has(s.scenario))
    .map((s) => s.durationMs)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  const firstTokenValues = samples
    .filter((s) => s.scenario === 'ask')
    .map((s) => s.firstTokenMs)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));

  const latency = quantileObject(latencyValues, 'ms');
  const firstToken = quantileObject(firstTokenValues, 'ms');

  // busy 增量优先取 diffSnapshots.busyDelta/busyByDb/counterReset；无 diff 时退回结束快照。
  const busyTotal = diff
    ? Number(diff.busyDelta ?? 0)
    : Number(afterAnalysis?.busy?.total ?? afterAnalysis?.busyDelta ?? 0);
  const busyByDb = diff?.busyByDb ?? afterAnalysis?.busy?.byDb ?? afterAnalysis?.busyByDb ?? {};
  const counterReset = Boolean(diff?.counterReset ?? afterAnalysis?.counterReset ?? false);

  const promptTotal = Object.values(tokenDelta).reduce((acc, t) => acc + Number(t?.prompt ?? 0), 0);
  const completionTotal = Object.values(tokenDelta).reduce((acc, t) => acc + Number(t?.completion ?? 0), 0);
  const turnsTotal = perStudent.reduce((acc, r) => acc + r.turns, 0);

  // durationMs：显式传入优先；否则由 startedAt/endedAt 时间戳差值推导。
  let durationMs = Number(input.durationMs ?? NaN);
  if (!Number.isFinite(durationMs)) {
    const t0 = Date.parse(input.startedAt ?? '');
    const t1 = Date.parse(input.endedAt ?? '');
    durationMs = Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, t1 - t0) : 0;
  }

  const preflightOk = input.preflightOk ?? (input.preflight ? Boolean(input.preflight.ok) : true);
  const serverUp = input.serverUp ?? (input.preflight ? Boolean(input.preflight.ok) : null);

  // 进程重启判定：diff 结论优先；其次前后 process_start_time_seconds 不一致 → 重启。
  let serverRestarted = Boolean(input.serverRestarted);
  if (!serverRestarted) serverRestarted = Boolean(diff?.processRestarted ?? afterAnalysis?.processRestarted ?? false);
  if (!serverRestarted && beforeAnalysis?.processStartTime != null && afterAnalysis?.processStartTime != null) {
    serverRestarted = Number(beforeAnalysis.processStartTime) !== Number(afterAnalysis.processStartTime);
  }

  const present = afterAnalysis?.present ?? [];
  const missing = afterAnalysis?.missing ?? (present.length === 0 ? METRIC_NAMES : []);
  const metricsScrape = {
    scrapedAt: afterAnalysis?.scrapedAt ?? input.endedAt ?? new Date().toISOString(),
    endpoint: afterAnalysis?.endpoint ?? `${input.target?.baseUrl ?? ''}/metrics`,
    present,
    missing,
    counters: afterAnalysis?.counters ?? {},
    rawSnapshotPath: input.rawSnapshotPath ?? null,
    bucketsOk: afterAnalysis?.bucketsOk ?? true,
    missingBuckets: afterAnalysis?.missingBuckets ?? [],
    missingBucketsByHistogram: afterAnalysis?.missingBucketsByHistogram ?? {},
    extraBuckets: afterAnalysis?.extraBuckets ?? [],
    extraBucketsByHistogram: afterAnalysis?.extraBucketsByHistogram ?? {},
    busyByDb,
    tokenByStudent: tokenDelta,
    processStartTime: diff?.processStartTime ?? afterAnalysis?.processStartTime ?? null,
    counterReset,
    serverLatency: afterAnalysis?.serverLatency ?? null,
    firstTokenServer: afterAnalysis?.firstTokenServer ?? null,
  };

  const summary = {
    requestsTotal: breakdown.requestsTotal,
    requestsOk: breakdown.requestsOk,
    requestsFailed: breakdown.requestsFailed,
    errorRate: breakdown.errorRate,
    fiveXxRate: breakdown.fiveXxRate,
    statusBreakdown: breakdown.buckets,
    latency,
    firstToken,
    sseActivePeak: Number(input.sseActivePeak ?? 0),
    sqliteBusyTotal: busyTotal,
    tokens: { prompt: promptTotal, completion: completionTotal, total: promptTotal + completionTotal, mode: input.llmMode ?? 'mock' },
    turnsTotal,
  };

  const verdictCtx = {
    summary,
    metricsScrape,
    config,
    preflightOk,
    serverRestarted,
    // 登录限流是契约行为：把它单独列成一条 verdict，报告里就不会被误读成服务端并发缺陷。
    loginRateLimitedCount: samples.filter((s) => s.scenario === 'login' && s.status === 429).length,
    loginLimit: 5,
  };
  const verdicts = evaluateVerdicts(verdictCtx);

  const alertCtx = {
    durationMs,
    tokenQuota: Number(config.tokenQuota ?? 200_000),
    summary,
    metricsScrape,
    serverUp,
  };
  const alerts = evaluateAlerts(alertCtx);

  const errors = samples
    .filter((s) => s.errorClass !== null && s.errorClass !== undefined)
    .map(sanitizeSample);

  const warnings = [...(input.warnings ?? []), ...rowWarnings, ...FIXED_WARNINGS];

  return {
    meta: {
      runId: input.runId ?? '',
      startedAt: input.startedAt ?? '',
      endedAt: input.endedAt ?? '',
      durationMs,
      toolVersion: input.toolVersion ?? 'tools/loadtest',
      target: input.target ?? { type: 'stub', baseUrl: '', port: null },
      llmMode: input.llmMode ?? 'mock',
      config: {
        students: Number(config.students ?? 0),
        rampUpSec: Number(config.rampUpSec ?? 0),
        iterations: Number(config.iterations ?? 0),
        scenario: config.scenario ?? 'full',
        tokenQuota: Number(config.tokenQuota ?? 200_000),
        home: config.home ?? '',
      },
      caveats: [...FIXED_CAVEATS],
      serverRestarted,
      client: input.clientStats ?? undefined,
    },
    summary,
    perStudent,
    errors,
    metricsScrape,
    alerts,
    verdicts,
    warnings,
  };
}
