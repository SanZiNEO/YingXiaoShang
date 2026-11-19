import type { ChildProcess } from 'node:child_process'
import type { Page } from 'playwright'
import { writeFileSync } from 'node:fs'

export type LogStream = 'stdout' | 'stderr' | 'page' | 'pageerror'

export interface LogLine {
  at: string
  stream: LogStream
  text: string
}

/**
 * 进程日志采集。等待策略不靠 sleep，但失败取证必须留下完整时间线，
 * 所以每条都带毫秒时间戳，落盘为 main.log。
 */
export class ProcessLog {
  readonly lines: LogLine[] = []

  private push(stream: LogStream, text: string): void {
    for (const line of String(text).split(/\r?\n/)) {
      if (line.length === 0) continue
      this.lines.push({ at: new Date().toISOString(), stream, text: line })
    }
  }

  attachProcess(child: ChildProcess): void {
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.push('stdout', chunk))
    child.stderr?.on('data', (chunk: string) => this.push('stderr', chunk))
  }

  attachPage(page: Page): void {
    page.on('console', (message) => this.push('page', `[${message.type()}] ${message.text()}`))
    page.on('pageerror', (error) => this.push('pageerror', error.message))
  }

  text(): string {
    return this.lines.map((line) => `${line.at} [${line.stream}] ${line.text}`).join('\n')
  }

  includes(pattern: RegExp | string): boolean {
    const needle = typeof pattern === 'string' ? pattern : pattern.source
    return this.lines.some((line) => (typeof pattern === 'string' ? line.text.includes(needle) : pattern.test(line.text)))
  }

  write(path: string): void {
    writeFileSync(path, `${this.text()}\n`, 'utf8')
  }
}
