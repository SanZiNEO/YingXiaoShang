import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DEFAULT_PORT = 8788
const SERVICE_DIR = 'services/news-crawler-py'

/** Desktop uses its own port so a separately started server (8787) never shares a DB by accident. */
export function desktopNewsCrawlerUrl(): string {
  const port = process.env.NEWS_CRAWLER_PORT || String(DEFAULT_PORT)
  return (process.env.NEWS_CRAWLER_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '')
}

interface HealthPayload {
  ok?: boolean
  db_path?: string
}

async function health(url: string): Promise<HealthPayload | undefined> {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(1_500),
    })
    if (!response.ok) return undefined
    return (await response.json()) as HealthPayload
  } catch {
    return undefined
  }
}

async function waitHealthy(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await health(url))?.ok) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}

function findServiceDir(appPath: string): string | undefined {
  const candidates = [
    process.env.NEWS_CRAWLER_DIR,
    join(appPath, SERVICE_DIR),
    join(appPath, '..', '..', SERVICE_DIR),
    join(process.cwd(), SERVICE_DIR),
  ].filter((value): value is string => Boolean(value))
  return candidates.find((candidate) => existsSync(join(candidate, 'pyproject.toml')))
}

function findExecutable(serviceDir: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } | undefined {
  const configured = process.env.NEWS_CRAWLER_PYTHON
  if (configured) {
    return {
      command: configured,
      args: ['-m', 'news_crawler'],
      env: { PYTHONPATH: join(serviceDir, 'src') },
    }
  }

  const consoleScript = join(
    serviceDir,
    '.venv',
    process.platform === 'win32' ? 'Scripts/news-crawler.exe' : 'bin/news-crawler',
  )
  if (existsSync(consoleScript)) return { command: consoleScript, args: [], env: {} }

  const python = join(
    serviceDir,
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  )
  if (existsSync(python)) {
    return {
      command: python,
      args: ['-m', 'news_crawler'],
      env: { PYTHONPATH: join(serviceDir, 'src') },
    }
  }
  return undefined
}

let child: ChildProcess | undefined

/**
 * Start the Python collection service for this desktop installation.
 *
 * A server deployment should point `NEWS_CRAWLER_URL` at its own service and
 * leave `NEWS_CRAWLER_AUTOSTART=0`; then this function only health-checks.
 */
export async function startNewsBackend(options: {
  appPath: string
  appHome: string
}): Promise<string> {
  const url = desktopNewsCrawlerUrl()
  if (process.env.NEWS_CRAWLER_URL || process.env.NEWS_CRAWLER_AUTOSTART === '0') {
    return url
  }
  const dbPath = resolve(options.appHome, 'data', 'learning.db')
  const existing = await health(url)
  if (existing?.ok) {
    if (existing.db_path && resolve(existing.db_path) !== resolve(dbPath)) {
      console.warn(
        `[news] port ${url} is serving ${existing.db_path}, but this desktop reads ${dbPath}`,
      )
    }
    return url
  }

  const serviceDir = findServiceDir(options.appPath)
  if (!serviceDir) {
    console.warn(`[news] Python service not found; set NEWS_CRAWLER_URL or ${SERVICE_DIR}`)
    return url
  }
  const executable = findExecutable(serviceDir)
  if (!executable) {
    console.warn('[news] no Python executable found in services/news-crawler-py/.venv')
    return url
  }
  const port = new URL(url).port || String(DEFAULT_PORT)
  const args = [
    ...executable.args,
    'serve',
    '--db',
    dbPath,
    '--host',
    '127.0.0.1',
    '--port',
    port,
    '--workers',
    process.env.NEWS_CRAWLER_WORKERS || '8',
    '--max-run-s',
    '90',
  ]
  child = spawn(executable.command, args, {
    cwd: serviceDir,
    env: {
      ...process.env,
      ...executable.env,
      NEWS_CRAWLER_DB: dbPath,
      NEWS_CRAWLER_WORKERS: process.env.NEWS_CRAWLER_WORKERS || '8',
      NEWS_CRAWLER_PORT: port,
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim()
    if (line) console.info(`[news] ${line}`)
  })
  child.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim()
    if (line) console.warn(`[news] ${line}`)
  })
  child.on('exit', (code) => {
    if (code !== null && code !== 0) console.warn(`[news] service exited with code ${code}`)
    child = undefined
  })

  if (await waitHealthy(url, 8_000)) {
    console.info(`[news] Python service ready at ${url} (db=${dbPath})`)
    return url
  }
  console.warn(`[news] Python service did not become healthy at ${url}`)
  return url
}

export function stopNewsBackend(): void {
  if (!child) return
  child.kill()
  child = undefined
}
