export interface LogLine {
  requestId?: string
  studentId?: string
  method?: string
  route?: string
  status?: number
  code?: string
  durationMs?: number
  bytes?: number
  ua?: string
  ignoredStudentId?: boolean
}

export interface Logger {
  info(line: LogLine): void
  warn(line: LogLine): void
  error(line: LogLine): void
}

/**
 * One JSON object per line. Callers must never pass tokens, passwords or chat
 * text here; the gateway is the only place that knows those values.
 */
export function createLogger(): Logger {
  const write = (level: 'info' | 'warn' | 'error', line: LogLine) => {
    const record = {
      ts: new Date().toISOString(),
      level,
      requestId: '',
      studentId: '',
      method: '',
      route: '',
      status: 0,
      code: '',
      durationMs: 0,
      bytes: 0,
      ua: '',
      ignoredStudentId: false,
      ...line,
    }
    const text = `${JSON.stringify(record)}\n`
    if (level === 'info') process.stdout.write(text)
    else process.stderr.write(text)
  }
  return {
    info: (line) => write('info', line),
    warn: (line) => write('warn', line),
    error: (line) => write('error', line),
  }
}

/** Startup/shutdown lines are not request logs, but stay machine-readable. */
export function runtimeLog(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    event,
    ...fields,
  })}\n`)
}
