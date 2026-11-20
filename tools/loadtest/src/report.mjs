// report.mjs —— F 轮压测报告渲染层：只渲染不改数，同一份 ReportData 同源生成 md 与 json。

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 数值/空值格式化：null/undefined 显示为 —，其余原样转字符串（渲染层不二次改数）。 */
function fmt(v) {
  return v === null || v === undefined ? '—' : String(v);
}

/** 比率格式化为百分比；null 显示 —。 */
function pct(rate) {
  return rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(2)}%`;
}

/** 分位数表行（3.1 / 3.2 共用），数字全部直接取自传入的 Quantile 对象。 */
function quantileRows(q) {
  return [
    ['P50', fmt(q?.p50)],
    ['P95', fmt(q?.p95)],
    ['P99', fmt(q?.p99)],
    ['avg（仅参考）', fmt(q?.avg)],
    ['min', fmt(q?.min)],
    ['max', fmt(q?.max)],
    ['sampleCount', fmt(q?.sampleCount)],
    ['unit', fmt(q?.unit)],
  ];
}

/**
 * 渲染 JSON 报告：2 空格缩进 + 末尾换行。
 * @param {object} data ReportData
 * @returns {string}
 */
export function renderJson(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/**
 * 渲染 Markdown 报告（02-contract §3.5 八节骨架）；P95、错误率、busy 次数直接取 data.summary 同名字段。
 * @param {object} data ReportData
 * @returns {string}
 */
export function renderMarkdown(data) {
  const meta = data.meta ?? {};
  const summary = data.summary ?? {};
  const scrape = data.metricsScrape ?? {};
  const lines = [];

  lines.push(`# 压测报告 ${meta.runId}（${fmt(meta.llmMode)} / ${fmt(meta.target?.type)}）`);
  lines.push('');

  // 1 运行概览
  lines.push('## 1 运行概览');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  lines.push(`| startedAt | ${fmt(meta.startedAt)} |`);
  lines.push(`| endedAt | ${fmt(meta.endedAt)} |`);
  lines.push(`| durationMs | ${fmt(meta.durationMs)} |`);
  lines.push(`| students | ${fmt(meta.config?.students)} |`);
  lines.push(`| scenario | ${fmt(meta.config?.scenario)} |`);
  lines.push(`| baseUrl | ${fmt(meta.target?.baseUrl)} |`);
  lines.push(`| port | ${fmt(meta.target?.port)} |`);
  lines.push(`| llmMode | ${fmt(meta.llmMode)} |`);
  lines.push(`| serverRestarted | ${fmt(meta.serverRestarted)} |`);
  lines.push('');

  // 2 总体结论
  lines.push('## 2 总体结论');
  lines.push('');
  lines.push(`- overall verdict：**${fmt(data.verdicts?.overall)}**`);
  lines.push('');
  lines.push('| 规则 | 阈值 | 实测 | 状态 | 备注 |');
  lines.push('|---|---|---|---|---|');
  for (const item of data.verdicts?.items ?? []) {
    lines.push(`| ${fmt(item.rule)} | ${fmt(item.threshold)} | ${fmt(item.observed)} | ${fmt(item.state)} | ${fmt(item.note)} |`);
  }
  lines.push('');

  // 3 延迟分位数
  lines.push('## 3 延迟分位数');
  lines.push('');
  lines.push('### 3.1 HTTP/RPC 延迟（客户端采样，最近秩法，ms）');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  for (const [k, v] of quantileRows(summary.latency)) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push('### 3.2 SSE 首 token（客户端采样，最近秩法，ms；本机回环口径，仅用于回归对比）');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  for (const [k, v] of quantileRows(summary.firstToken)) lines.push(`| ${k} | ${v} |`);
  lines.push('');

  // 4 错误率与状态分布
  const breakdown = summary.statusBreakdown ?? {};
  lines.push('## 4 错误率与状态分布');
  lines.push('');
  lines.push(`- requestsTotal：${fmt(summary.requestsTotal)}`);
  lines.push(`- requestsOk：${fmt(summary.requestsOk)}`);
  lines.push(`- requestsFailed：${fmt(summary.requestsFailed)}`);
  lines.push(`- errorRate：${pct(summary.errorRate)}`);
  lines.push(`- 5xx 率（http5xx/(http2xx+http4xx+http5xx)，单列口径）：${pct(summary.fiveXxRate)}`);
  lines.push('');
  lines.push('| 状态分类 | 次数 |');
  lines.push('|---|---|');
  for (const key of ['http2xx', 'http4xx', 'http5xx', 'businessError', 'sseError', 'cancelled', 'timeout', 'networkAbort']) {
    lines.push(`| ${key} | ${fmt(breakdown[key])} |`);
  }
  lines.push('');

  // 按 code / method 明细（只记分类码与方法，不回显消息正文）
  const errors = data.errors ?? [];
  const byCode = new Map();
  const byMethod = new Map();
  for (const e of errors) {
    const codeKey = fmt(e.code ?? '(none)');
    if (!byCode.has(codeKey)) byCode.set(codeKey, { count: 0, requestIds: [] });
    const c = byCode.get(codeKey);
    c.count += 1;
    if (c.requestIds.length < 5) c.requestIds.push(e.requestId);
    const methodKey = fmt(e.method ?? '(none)');
    if (!byMethod.has(methodKey)) byMethod.set(methodKey, { count: 0, codes: new Set() });
    const m = byMethod.get(methodKey);
    m.count += 1;
    m.codes.add(codeKey);
  }
  lines.push('### 4.1 按错误码明细');
  lines.push('');
  if (byCode.size === 0) {
    lines.push('（无失败样本）');
  } else {
    lines.push('| code | 次数 | requestId 样例 |');
    lines.push('|---|---|---|');
    for (const [code, c] of byCode) lines.push(`| ${code} | ${c.count} | ${c.requestIds.join(', ')} |`);
  }
  lines.push('');
  lines.push('### 4.2 按方法/路由明细');
  lines.push('');
  if (byMethod.size === 0) {
    lines.push('（无失败样本）');
  } else {
    lines.push('| method/route | 失败次数 | 涉及 code |');
    lines.push('|---|---|---|');
    for (const [method, m] of byMethod) lines.push(`| ${method} | ${m.count} | ${[...m.codes].join(', ')} |`);
  }
  lines.push('');

  // 5 每学生明细
  lines.push('## 5 每学生明细');
  lines.push('');
  lines.push('| studentId | status | asks | answers | submissions | turns | tokensPrompt | tokensCompletion | tokensTotal | rpcErrors | cancelled | timeouts |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of data.perStudent ?? []) {
    const cells = [
      row.studentId, row.status, row.asks, row.answers, row.submissions, row.turns,
      row.tokensPrompt, row.tokensCompletion, row.tokensTotal, row.rpcErrors, row.cancelled, row.timeouts,
    ].map(fmt);
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('');

  // 6 指标抓取快照
  lines.push('## 6 指标抓取快照');
  lines.push('');
  lines.push(`- scrapedAt：${fmt(scrape.scrapedAt)}`);
  lines.push(`- endpoint：${fmt(scrape.endpoint)}`);
  lines.push(`- present（${(scrape.present ?? []).length}）：${(scrape.present ?? []).join(', ') || '—'}`);
  lines.push(`- missing（${(scrape.missing ?? []).length}）：${(scrape.missing ?? []).join(', ') || '—'}`);
  lines.push(`- sqliteBusyTotal：${fmt(summary.sqliteBusyTotal)}`);
  lines.push(`- tokens：prompt=${fmt(summary.tokens?.prompt)}，completion=${fmt(summary.tokens?.completion)}，total=${fmt(summary.tokens?.total)}，mode=${fmt(summary.tokens?.mode)}`);
  lines.push(`- sseActivePeak：${fmt(summary.sseActivePeak)}`);
  lines.push(`- bucketsOk：${fmt(scrape.bucketsOk)}；missingBuckets：${(scrape.missingBuckets ?? []).join(', ') || '—'}；extraBuckets：${(scrape.extraBuckets ?? []).join(', ') || '—'}`);
  lines.push('');
  lines.push('### 6.1 服务端直方图对照（直方图复算，ms；分位精度受 12 个桶边界限制）');
  lines.push('');
  lines.push('| 口径 | P50 | P95 | P99 | sampleCount |');
  lines.push('|---|---|---|---|---|');
  const sl = scrape.serverLatency;
  lines.push(`| HTTP/RPC（服务端） | ${fmt(sl?.p50)} | ${fmt(sl?.p95)} | ${fmt(sl?.p99)} | ${fmt(sl?.sampleCount)} |`);
  const ft = scrape.firstTokenServer;
  lines.push(`| 首 token（服务端） | ${fmt(ft?.p50)} | ${fmt(ft?.p95)} | ${fmt(ft?.p99)} | ${fmt(ft?.sampleCount)} |`);
  lines.push('');

  // 7 告警规则演练结果
  lines.push('## 7 告警规则演练结果');
  lines.push('');
  lines.push('| 规则 | 级别 | for | state | value | reason |');
  lines.push('|---|---|---|---|---|---|');
  for (const rule of data.alerts?.rules ?? []) {
    lines.push(`| ${fmt(rule.name)} | ${fmt(rule.severity)} | ${fmt(rule.for)} | ${fmt(rule.state)} | ${fmt(rule.value)} | ${fmt(rule.reason)} |`);
  }
  lines.push('');

  // 8 口径与失真说明
  lines.push('## 8 口径与失真说明');
  lines.push('');
  lines.push('### 8.1 固定口径 caveats');
  lines.push('');
  for (const c of meta.caveats ?? []) lines.push(`- ${c}`);
  lines.push('');
  lines.push('### 8.2 已知偏差与缺口登记');
  lines.push('');
  for (const w of data.warnings ?? []) lines.push(`- ${w}`);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

/**
 * 落盘报告：loadtest-report.md / loadtest-report.json / metrics-before.txt / metrics-after.txt / sse/<requestId>.txt。
 * 目录不存在自动创建；写失败抛中文错误（由 CLI 转基础设施失败退出码 1）。
 * @param {object} data ReportData
 * @param {string} outDir 报告目录
 * @param {object} extra { beforeText, afterText, failedFrames: [{requestId, text}] }
 * @returns {Promise<{ mdPath: string, jsonPath: string }>}
 */
export async function writeReport(data, outDir, extra = {}) {
  const beforeText = extra.beforeText ?? '';
  const afterText = extra.afterText ?? '';
  const failedFrames = extra.failedFrames ?? [];
  try {
    await mkdir(outDir, { recursive: true });
    const sseDir = path.join(outDir, 'sse');
    await mkdir(sseDir, { recursive: true });

    const mdPath = path.join(outDir, 'loadtest-report.md');
    const jsonPath = path.join(outDir, 'loadtest-report.json');
    await writeFile(mdPath, renderMarkdown(data), 'utf8');
    await writeFile(jsonPath, renderJson(data), 'utf8');
    await writeFile(path.join(outDir, 'metrics-before.txt'), beforeText, 'utf8');
    await writeFile(path.join(outDir, 'metrics-after.txt'), afterText, 'utf8');

    for (const frame of failedFrames) {
      const safeId = String(frame?.requestId ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '');
      await writeFile(path.join(sseDir, `${safeId}.txt`), frame?.text ?? '', 'utf8');
    }
    return { mdPath, jsonPath };
  } catch (err) {
    throw new Error(`报告写入失败（${outDir}）：请检查 .scratch/run/F 目录权限与磁盘空间。原始错误：${err?.message ?? err}`);
  }
}
