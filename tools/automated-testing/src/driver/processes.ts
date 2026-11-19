import { execFileSync } from 'node:child_process'
import { delay } from './ports.js'

export interface ProcessRow {
  pid: number
  commandLine: string
}

interface CimRow {
  ProcessId: number
  CommandLine: string | null
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** 按命令行片段枚举进程（Windows CIM）。排除执行查询的 powershell 自身（它的命令行也含片段）。 */
export function listProcesses(fragment?: string): ProcessRow[] {
  const filter = fragment && fragment.length > 0
    ? ` | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like ${psQuote(`*${fragment}*`)} }`
    : ' | Where-Object { $_.ProcessId -ne $PID }'
  const script = [
    'Get-CimInstance Win32_Process',
    `${filter}`,
    '| Select-Object ProcessId, CommandLine',
    '| ConvertTo-Json -Compress',
  ].join(' ')
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    }).trim()
    if (raw.length === 0) return []
    const parsed = JSON.parse(raw) as CimRow | CimRow[]
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows
      .map((row) => ({ pid: Number(row.ProcessId), commandLine: String(row.CommandLine ?? '') }))
      .filter((row) => Number.isFinite(row.pid))
  } catch {
    return []
  }
}

export function killTree(pid: number): void {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000, windowsHide: true })
  } catch {
    try {
      process.kill(pid)
    } catch {
      // 进程已经退出。
    }
  }
}

export async function waitProcessGone(pid: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await delay(150)
  }
  return !isAlive(pid)
}

export function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
