// 告警规则兜底自检：本机没有 promtool 时，用本脚本独立核对 alerts.yml 的结构、
// 规则名、expr/for/labels/annotations 字段、指标清单与冻结阈值。零第三方依赖。

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** 冻结 §9.2 / 契约 §3.1 的 10 项指标清单（逐字）。 */
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
];

/** 冻结 §9.3 五条规则的期望口径（规则 3 为 F 侧替代口径表达式）。 */
export const FROZEN_RULES = [
  {
    name: 'YxsHttp5xxRate',
    for: '5m',
    severity: 'page',
    expr: 'sum(rate(yxs_http_requests_total{status=~"5.."}[5m])) / sum(rate(yxs_http_requests_total[5m])) > 0.01',
  },
  {
    name: 'YxsHttpP95Latency',
    for: '10m',
    severity: 'warn',
    expr: 'histogram_quantile(0.95, sum by (le)(rate(yxs_http_request_duration_seconds_bucket[10m]))) > 3',
  },
  {
    name: 'YxsTokenUsageHigh',
    for: '15m',
    severity: 'warn',
    expr: 'sum by (student_id)(yxs_tokens_total{kind="prompt"}) > 160000',
  },
  {
    name: 'YxsSqliteBusySpike',
    for: '5m',
    severity: 'warn',
    expr: 'increase(yxs_sqlite_busy_total[5m]) > 5',
  },
  {
    name: 'YxsServerDown',
    for: '1m',
    severity: 'page',
    expr: 'up{job="yxs-server"} == 0',
  },
];

const HISTOGRAM_SUFFIXES = ['_bucket', '_sum', '_count'];

/** 去掉 YAML 标量两侧引号。 */
function stripQuote(value) {
  let v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v.trim();
}

/** 直方图样本名归族：yxs_http_request_duration_seconds_bucket -> yxs_http_request_duration_seconds。 */
function stripHistogramSuffix(name) {
  for (const suffix of HISTOGRAM_SUFFIXES) {
    if (name.endsWith(suffix)) return name.slice(0, name.length - suffix.length);
  }
  return name;
}

/** 抽取表达式中出现的全部 yxs_* 指标名（原样保留直方图后缀形式）。 */
function extractMetricRefs(expr) {
  if (!expr) return [];
  const matches = expr.match(/yxs_[a-zA-Z0-9_]+/g) ?? [];
  return [...new Set(matches)];
}

/**
 * 轻量缩进 YAML 解析（只覆盖本规则文件用到的 groups/rules/expr/for/labels/annotations 形态）。
 * 返回 { groups, rules, commentLines }：
 * - groups: [{ name, rules: [] }]
 * - rules: [{ name, expr, for, labels, annotations, comments, line }]
 * - commentLines: [{ line, text }] 全部注释行，供缺口说明核对。
 */
export function parseRulesYaml(text) {
  const lines = String(text).split(/\r?\n/);
  const groups = [];
  const rules = [];
  const commentLines = [];
  let currentGroup = null;
  let currentRule = null;
  let section = null;

  const flushRule = () => {
    if (currentRule) {
      currentGroup?.rules.push(currentRule);
      rules.push(currentRule);
    }
    currentRule = null;
    section = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];

    const commentMatch = raw.match(/^\s*#\s?(.*)$/);
    if (commentMatch) {
      commentLines.push({ line: i + 1, text: commentMatch[1] });
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (/^groups:\s*$/.test(trimmed)) continue;
    if (/^rules:\s*$/.test(trimmed)) continue;

    let m = trimmed.match(/^-\s+name:\s*(.+?)\s*$/);
    if (m) {
      flushRule();
      currentGroup = { name: stripQuote(m[1]), rules: [] };
      groups.push(currentGroup);
      continue;
    }

    m = trimmed.match(/^-\s+alert:\s*(.+?)\s*$/);
    if (m) {
      flushRule();
      currentRule = {
        name: stripQuote(m[1]),
        expr: null,
        for: null,
        labels: {},
        annotations: {},
        comments: [],
        line: i + 1,
      };
      section = null;
      continue;
    }

    if (!currentRule) continue;

    if (section) {
      const nested = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (nested && !['labels', 'annotations'].includes(nested[1])) {
        currentRule[section][nested[1]] = stripQuote(nested[2]);
        continue;
      }
    }

    m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (m) {
      const key = m[1];
      const value = m[2];
      if (key === 'labels') {
        section = 'labels';
        continue;
      }
      if (key === 'annotations') {
        section = 'annotations';
        continue;
      }
      if (key === 'expr' || key === 'for') {
        section = null;
        currentRule[key] = stripQuote(value);
        continue;
      }
      if (key === 'alert') {
        currentRule.name = stripQuote(value);
        continue;
      }
      section = null;
    }
  }
  flushRule();

  // 注释归属：规则前的连续注释行记到该规则上，同时保留全文注释供缺口核对。
  const attached = [];
  for (const comment of commentLines) {
    const nextRule = rules.find((rule) => rule.line > comment.line);
    if (nextRule) nextRule.comments.push(comment.text);
    attached.push(comment.text);
  }

  return { groups, rules, commentLines: attached };
}

/**
 * 核对规则文件。返回 { ok, errors, rules }；
 * rules 元素：{ name, hasExpr, hasFor, hasLabels, hasAnnotations, severity, job, for, metrics }。
 */
export function checkRules(text) {
  const errors = [];
  const { groups, rules, commentLines } = parseRulesYaml(text);
  const commentsText = commentLines.join('\n');
  const rulesOut = [];
  const seenNames = new Map();

  const groupNames = groups.map((group) => group.name);
  if (groupNames.length === 0) {
    errors.push('未找到顶层 groups: 组定义。');
  } else if (!groupNames.includes('yxs-server')) {
    errors.push(`告警组 name 应为 yxs-server，实际：${groupNames.join(', ')}。`);
  }

  rules.forEach((rule, index) => {
    const frozen = FROZEN_RULES.find((item) => item.name === rule.name);
    const problems = [];

    if (!rule.name) {
      problems.push(`第 ${index + 1} 条规则缺少 alert 名称。`);
    } else if (seenNames.has(rule.name)) {
      problems.push(`规则名重复：${rule.name}。`);
    }
    if (rule.name) seenNames.set(rule.name, true);

    const hasExpr = Boolean(rule.expr && rule.expr.trim());
    const hasFor = Boolean(rule.for && rule.for.trim());
    const hasLabels = rule.labels && Object.keys(rule.labels).length > 0;
    const hasAnnotations = Boolean(
      rule.annotations && (rule.annotations.summary || rule.annotations.description),
    );

    if (!hasExpr) problems.push('缺少 expr。');
    if (!hasFor) problems.push('缺少 for。');
    if (!hasLabels) problems.push('缺少 labels。');
    if (!hasAnnotations) problems.push('缺少 annotations（summary/description）。');

    const severity = rule.labels?.severity ?? null;
    const job = rule.labels?.job ?? null;

    if (job && job !== 'yxs-server') {
      problems.push(`labels.job 应为 yxs-server，实际：${job}。`);
    }
    if (severity && !['page', 'warn'].includes(severity)) {
      problems.push(`labels.severity 应为 page 或 warn，实际：${severity}。`);
    }

    if (frozen) {
      if (hasFor && rule.for !== frozen.for) {
        problems.push(`for 与冻结值不一致：期望 ${frozen.for}，实际 ${rule.for}。`);
      }
      if (severity && severity !== frozen.severity) {
        problems.push(`severity 与冻结值不一致：期望 ${frozen.severity}，实际 ${severity}。`);
      }
      if (hasExpr && rule.expr.trim() !== frozen.expr) {
        problems.push(`expr 与冻结表达式不一致：期望 ${frozen.expr}，实际 ${rule.expr.trim()}。`);
      }
    } else if (rule.name) {
      problems.push(`规则名 ${rule.name} 不在冻结 §9.3 的五条规则内。`);
    }

    const metrics = extractMetricRefs(rule.expr);
    for (const raw of metrics) {
      const base = stripHistogramSuffix(raw);
      if (!METRIC_NAMES.includes(base)) {
        problems.push(
          `清单外指标 ${raw} 被当作现存指标：该指标不在冻结 §9.2 的 10 项清单内，活动表达式不得引用。`,
        );
      }
    }

    if (rule.name === 'YxsTokenUsageHigh') {
      if (rule.labels?.quota == null) problems.push('YxsTokenUsageHigh 缺少 quota 标签。');
      if (rule.labels?.pending == null) problems.push('YxsTokenUsageHigh 缺少 pending 标签。');
      const gapCommentOk =
        commentsText.includes('yxs_tokens_total{kind="prompt"} / yxs_token_quota > 0.8') &&
        commentsText.includes('yxs_token_quota') &&
        /缺口/.test(commentsText) &&
        /§12|A 轮/.test(commentsText);
      if (!gapCommentOk) {
        problems.push(
          'YxsTokenUsageHigh 缺少缺口注释：须保留冻结原式 yxs_tokens_total{kind="prompt"} / yxs_token_quota > 0.8，' +
            '并写明 yxs_token_quota 不在 §9.2 清单、待 A 轮补 gauge 后按冻结 §12 恢复。',
        );
      }
    }

    if (rule.name === 'YxsHttp5xxRate' && hasExpr && !/> 0\.01\s*$/.test(rule.expr.trim())) {
      problems.push('5xx 率阈值与冻结值不一致：期望 > 0.01。');
    }
    if (rule.name === 'YxsHttpP95Latency' && hasExpr && !/> 3\s*$/.test(rule.expr.trim())) {
      problems.push('P95 延迟阈值与冻结值不一致：期望 > 3（秒）。');
    }
    if (rule.name === 'YxsSqliteBusySpike' && hasExpr && !/> 5\s*$/.test(rule.expr.trim())) {
      problems.push('SQLITE_BUSY 增量阈值与冻结值不一致：期望 > 5。');
    }

    for (const problem of problems) {
      errors.push(`[${rule.name || '(未命名)'}] ${problem}`);
    }

    rulesOut.push({
      name: rule.name ?? null,
      hasExpr,
      hasFor,
      hasLabels,
      hasAnnotations,
      severity,
      job,
      for: rule.for,
      metrics,
    });
  });

  for (const frozen of FROZEN_RULES) {
    if (!seenNames.has(frozen.name)) {
      errors.push(`缺少冻结规则：${frozen.name}。`);
    }
  }

  return { ok: errors.length === 0, errors, rules: rulesOut };
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const cliArg = process.argv[2];
  const target = cliArg ? path.resolve(cliArg) : path.join(scriptDir, '..', 'prometheus', 'alerts.yml');

  let text;
  try {
    text = await readFile(target, 'utf8');
  } catch (err) {
    console.error(`读取规则文件失败：${err.message}`);
    process.exit(1);
  }

  const result = checkRules(text);
  console.log(`规则文件：${target}`);
  console.log(`规则条数：${result.rules.length}`);
  for (const rule of result.rules) {
    const metrics = rule.metrics.length > 0 ? rule.metrics.join(', ') : '—';
    console.log(
      `- ${rule.name ?? '(未命名)'} | severity=${rule.severity ?? '—'} | for=${rule.for ?? '—'} | metrics=${metrics}`,
    );
  }

  if (result.ok) {
    console.log('自检通过：5 条规则齐全，字段、指标清单与冻结阈值一致。');
    process.exit(0);
  }

  console.error('自检失败：');
  for (const error of result.errors) {
    console.error(`  ✗ ${error}`);
  }
  process.exit(1);
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  await main();
}
