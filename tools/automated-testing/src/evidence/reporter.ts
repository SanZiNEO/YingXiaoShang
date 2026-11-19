import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter'
import { depsOf } from '../scenarios/dependencies.js'
import { artifactsRoot } from '../driver/paths.js'
import { tcOf } from './evidence.js'

interface IndexEntry {
  tc: string
  title: string
  status: string
  mappedStatus: 'passed' | 'failed' | 'blocked'
  outputDir: string
  durationMs: number
  error?: string
  dependencies?: string
}

interface Row extends IndexEntry {
  deps: string[]
}

function readIndex(path: string): IndexEntry[] {
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0)
  const entries: IndexEntry[] = []
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as IndexEntry)
    } catch {
      // 单行坏掉不影响其它行。
    }
  }
  return entries
}

const STATUS_LABEL: Record<string, string> = {
  passed: '通过',
  failed: '失败',
  blocked: '阻塞',
}

/**
 * 报告器：把每条 TC 的 meta 索引汇总成一张总表。
 * 输出 `.artifacts/report.json` 与 `.artifacts/report.md`。
 */
export default class CaseReporter implements Reporter {
  private readonly endings = new Map<string, { status: string; durationMs: number; error?: string }>()

  onBegin(_config: FullConfig, _suite: Suite): void {
    mkdirSync(artifactsRoot, { recursive: true })
    // 每轮清空索引，避免上一轮的结果混进来。
    writeFileSync(join(artifactsRoot, 'index.jsonl'), '', 'utf8')
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const tc = tcOf(test.title)
    if (!tc) return
    this.endings.set(tc, {
      status: result.status,
      durationMs: result.duration,
      error: result.error?.message,
    })
  }

  onEnd(result: FullResult): void {
    const index = readIndex(join(artifactsRoot, 'index.jsonl'))
    const byTc = new Map<string, IndexEntry>()
    for (const entry of index) byTc.set(entry.tc, entry)

    const rows: Row[] = []
    for (const [tc, ending] of this.endings) {
      const entry = byTc.get(tc)
      rows.push({
        tc,
        title: entry?.title ?? '',
        status: ending.status,
        mappedStatus: entry?.mappedStatus ?? (ending.status === 'passed' ? 'passed' : ending.status === 'skipped' ? 'blocked' : 'failed'),
        outputDir: entry?.outputDir ?? '',
        durationMs: entry?.durationMs ?? ending.durationMs,
        error: entry?.error ?? ending.error,
        dependencies: entry?.dependencies,
        deps: depsOf(tc),
      })
    }
    rows.sort((left, right) => left.tc.localeCompare(right.tc))

    const counts = {
      passed: rows.filter((row) => row.mappedStatus === 'passed').length,
      failed: rows.filter((row) => row.mappedStatus === 'failed').length,
      blocked: rows.filter((row) => row.mappedStatus === 'blocked').length,
    }

    const payload = { finishedAt: new Date().toISOString(), status: result.status, counts, rows }
    writeFileSync(join(artifactsRoot, 'report.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

    const lines = [
      '# 营小商 Electron 自动化测试报告',
      '',
      `- 结束时间：${payload.finishedAt}`,
      `- 结果：通过 ${counts.passed} / 失败 ${counts.failed} / 阻塞 ${counts.blocked}`,
      '',
      '| TC | 场景 | 结果 | 耗时(ms) | 证据目录 | 依赖 ID |',
      '|---|---|---|---|---|---|',
      ...rows.map(
        (row) =>
          `| ${row.tc} | ${row.title.replace(/\|/g, '/')} | ${STATUS_LABEL[row.mappedStatus]} | ${row.durationMs} | ${
            row.outputDir.replace(/\\/g, '/') || '—'
          } | ${row.deps.join(', ')} |`,
      ),
      '',
      '## 失败/阻塞摘要',
      '',
      ...rows
        .filter((row) => row.mappedStatus !== 'passed')
        .map((row) => `- ${row.tc}：${(row.error ?? '无错误信息').split('\n')[0]}`),
      '',
    ]
    writeFileSync(join(artifactsRoot, 'report.md'), `${lines.join('\n')}\n`, 'utf8')

    console.log(
      `\n报告：通过 ${counts.passed} / 失败 ${counts.failed} / 阻塞 ${counts.blocked} → ${join(artifactsRoot, 'report.md')}`,
    )
  }
}
