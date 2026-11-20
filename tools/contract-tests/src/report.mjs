/**
 * 报告汇总 —— 唯一写盘的地方（03-implementation §4：只有 report/<时间戳>/ 可以写）。
 *
 * 目录结构与 02-contract §6 / 04-acceptance §4 对齐：
 *   report/<yyyyMMdd-HHmmss>/
 *     report.json         汇总（schemaVersion 1.0、round E、target、environment、summary、cases、mutations、probes）
 *     report.md           人读报告（覆盖矩阵、失败明细、mutation 记录、环境与端口）
 *     cases/<case-id>.json 单条用例：入参、期望、实际、断言差异、耗时
 *     sse/<case-id>.txt   SSE 原始帧 / 事件序列
 *     coverage.json       coverage.mjs 产出（由 coverage.mjs 自己写，这里只保证目录存在）
 *     mutations/<id>.diff mutation 运行时生成的 diff（由 src/patch.mjs 写）
 *     run.log             每用例一行结构化日志，不含 token / 口令 / 消息正文
 */

import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { redactSecrets } from './assert.mjs'

/** 报告目录名：yyyyMMdd-HHmmss（本地时间），与 04-acceptance §4 的命名一致。 */
export function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

export class Report {
  /**
   * @param {{ dir: string, pkgRoot: string, secrets?: string[] }} options
   */
  constructor({ dir, pkgRoot, secrets = [] }) {
    this.dir = resolve(dir)
    this.pkgRoot = resolve(pkgRoot)
    this.secrets = secrets
    this.logLines = []
  }

  /** 把绝对路径转成报告里使用的相对路径（相对工具包根，统一正斜杠）。 */
  rel(absolutePath) {
    return relative(this.pkgRoot, resolve(absolutePath)).split(sep).join('/')
  }

  async init() {
    for (const sub of ['cases', 'sse', 'mutations']) {
      await mkdir(join(this.dir, sub), { recursive: true })
    }
  }

  /** 单条用例证据：cases/<case-id>.json。返回报告内的相对路径，写进 case.evidence。 */
  async writeCase(id, payload) {
    const file = join(this.dir, 'cases', `${id}.json`)
    await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    return this.rel(file)
  }

  /** SSE / 事件序列原始帧：sse/<case-id>.txt。 */
  async writeSse(id, text) {
    const file = join(this.dir, 'sse', `${id}.txt`)
    await writeFile(file, `${redactSecrets(String(text ?? ''), this.secrets)}\n`, 'utf8')
    return this.rel(file)
  }

  /** run.log：一行一个 JSON，脱敏后落盘。 */
  async log(fields) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...fields })
    const safe = redactSecrets(line, this.secrets)
    this.logLines.push(safe)
    await appendFile(join(this.dir, 'run.log'), `${safe}\n`, 'utf8')
  }

  /** report.json + report.md 一次写完。 */
  async finalize(reportObject) {
    const json = { ...reportObject }
    const safeJson = redactSecrets(JSON.stringify(json, null, 2), this.secrets)
    await writeFile(join(this.dir, 'report.json'), `${safeJson}\n`, 'utf8')
    await writeFile(join(this.dir, 'report.md'), redactSecrets(buildMarkdown(json), this.secrets), 'utf8')
  }
}

/** 人读报告。只写事实与失效项，不写主编排叙述、不写堆栈。 */
export function buildMarkdown(report) {
  const lines = []
  const { summary = {}, environment = {}, cases = [], mutations = [], probes = [] } = report
  lines.push(`# E · 契约测试报告（${report.target}）`)
  lines.push('')
  lines.push(`- 开始：${report.startedAt}`)
  lines.push(`- 结束：${report.finishedAt}`)
  lines.push(`- 总计：${summary.total} 条 → passed ${summary.passed} / failed ${summary.failed} / skipped ${summary.skipped} / pending ${summary.pending}`)
  lines.push(`- 环境：baseUrl=${environment.baseUrl} port=${environment.port} home=${environment.home} openapi=${environment.openapi} lockedElectron=${environment.lockedElectron}`)
  lines.push('')

  lines.push('## 失败明细')
  const failed = cases.filter((item) => item.status === 'failed')
  if (failed.length === 0) {
    lines.push('')
    lines.push('无失败用例。')
  } else {
    lines.push('')
    lines.push('| 编号 | 方法/通道 | 断言 | 期望 | 实际 |')
    lines.push('|---|---|---|---|---|')
    for (const item of failed) {
      for (const assertion of item.assertions.filter((row) => row && row.ok !== true)) {
        lines.push(`| ${item.id} | ${item.method ?? item.channel} | ${assertion.name} | ${short(assertion.expected)} | ${short(assertion.actual)} |`)
      }
    }
  }
  lines.push('')

  lines.push('## 覆盖矩阵（30 个业务方法，每方法合法 + 非法各 ≥1 条）')
  lines.push('')
  lines.push('| 方法 | 用例 | 条数 | 状态 |')
  lines.push('|---|---|---|---|')
  const byMethod = new Map()
  for (const item of cases) {
    if (!item.method) continue
    const rows = byMethod.get(item.method) ?? []
    rows.push(item)
    byMethod.set(item.method, rows)
  }
  for (const [method, rows] of byMethod) {
    const statuses = Array.from(new Set(rows.map((row) => row.status))).join('/')
    lines.push(`| ${method} | ${rows.map((row) => row.id).join(', ')} | ${rows.length} | ${statuses} |`)
  }
  lines.push('')

  lines.push('## 跳过与待定')
  const notRun = cases.filter((item) => item.status === 'skipped' || item.status === 'pending')
  if (notRun.length === 0) {
    lines.push('')
    lines.push('无跳过或待定项。')
  } else {
    lines.push('')
    lines.push('| 编号 | 状态 | 原因 |')
    lines.push('|---|---|---|')
    for (const item of notRun) {
      lines.push(`| ${item.id} | ${item.status} | ${short(item.reason ?? item.error ?? '')} |`)
    }
  }
  lines.push('')

  lines.push('## mutation')
  lines.push('')
  if (mutations.length === 0) {
    lines.push('本次运行未执行 mutation 回放。')
  } else {
    lines.push('| 编号 | 目标用例 | 状态 | 说明 |')
    lines.push('|---|---|---|---|')
    for (const item of mutations) {
      lines.push(`| ${item.id} | ${item.targetCase ?? ''} | ${item.status ?? (item.applied ? 'applied' : 'not-run')} | ${short(item.reason ?? '')} |`)
    }
  }
  lines.push('')

  lines.push('## 前置探针（不计入 80 条）')
  if (probes.length === 0) {
    lines.push('')
    lines.push('无探针记录。')
  } else {
    lines.push('')
    lines.push('| 探针 | 状态 | 说明 |')
    lines.push('|---|---|---|')
    for (const probe of probes) {
      lines.push(`| ${probe.name} | ${probe.status} | ${short(probe.detail ?? '')} |`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

function short(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (!text) return ''
  return text.replace(/\|/g, '\\|').slice(0, 160)
}
