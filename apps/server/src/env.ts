import { copyFileSync, existsSync, mkdirSync, statSync, accessSync, constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repo root, both when running from `src/` (tsx) and `lib/` (node). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export interface Env {
  repoRoot: string
  home: string
  dbPath: string
  authDbPath: string
  host: string
  port: number
  templatesDir: string
  promptsDir: string
  llm: 'mock' | 'deepseek'
  deepseekKey: string
  deepseekModel: string
  deepseekBaseUrl: string
  tokenTtlDays: number
  metricsToken: string
  corsOrigins: string[]
  newsBaseUrl: string
  newsOffline: boolean
  seedDb: string
  openapiPath: string
  version: string
}

function text(name: string, fallback = ''): string {
  const value = process.env[name]
  return value === undefined ? fallback : value.trim()
}

function integer(name: string, fallback: number, min: number, max: number, label: string): number {
  const raw = text(name)
  if (raw.length === 0) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}必须是 ${min}-${max} 的整数。`)
  }
  return parsed
}

export function loadEnv(repoRoot = REPO_ROOT): Env {
  const home = resolve(text('LEARNING_AGENT_HOME', join(repoRoot, '.learning-agent')))
  const openapiPath = join(repoRoot, 'docs', 'contracts', 'openapi.yaml')
  const llmRaw = text('YXS_LLM', 'mock')
  if (llmRaw !== 'mock' && llmRaw !== 'deepseek') {
    throw new Error('YXS_LLM 只能填 mock 或 deepseek。')
  }
  const port = integer('YXS_SERVER_PORT', 8080, 1, 65535, '端口')
  const tokenTtlDays = integer('YXS_TOKEN_TTL_DAYS', 7, 1, 365, '令牌有效期')
  return {
    repoRoot,
    home,
    dbPath: text('YXS_DB_PATH') || join(home, 'data', 'learning.db'),
    authDbPath: text('YXS_AUTH_DB_PATH') || join(home, 'data', 'auth.db'),
    host: text('YXS_SERVER_HOST', '127.0.0.1'),
    port,
    templatesDir: resolve(text('YXS_TEMPLATES_DIR', join(repoRoot, 'apps', 'desktop', 'templates'))),
    promptsDir: resolve(text('LEARNING_AGENT_PROMPTS_DIR', join(repoRoot, 'packages', 'agent'))),
    llm: llmRaw,
    deepseekKey: text('DEEPSEEK_API_KEY'),
    deepseekModel: text('DEEPSEEK_MODEL', 'deepseek-chat'),
    deepseekBaseUrl: text('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
    tokenTtlDays,
    metricsToken: text('YXS_METRICS_TOKEN'),
    corsOrigins: text('YXS_CORS_ORIGINS')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
    newsBaseUrl: text('NEWS_CRAWLER_BASE_URL', 'http://127.0.0.1:8787'),
    newsOffline: text('YXS_NEWS_OFFLINE') === '1',
    seedDb: text('YXS_SEED_DB'),
    openapiPath,
    version: '0.1.0',
  }
}

/** Fails loudly instead of starting with a silently broken workspace. */
export function prepareWorkspace(env: Env): void {
  try {
    mkdirSync(env.home, { recursive: true, mode: 0o700 })
    accessSync(env.home, constants.R_OK | constants.W_OK)
  } catch {
    throw new Error(`运行时工作区不可写：${env.home}。换一个目录或用 LEARNING_AGENT_HOME 指定可写目录。`)
  }
  mkdirSync(dirname(env.dbPath), { recursive: true, mode: 0o700 })
  if (!existsSync(env.dbPath) && env.seedDb.length > 0) {
    const seed = resolve(env.repoRoot, env.seedDb)
    if (!existsSync(seed)) throw new Error(`YXS_SEED_DB 指向的种子库不存在：${seed}。`)
    copyFileSync(seed, env.dbPath)
  }
  if (!existsSync(env.templatesDir) || !statSync(env.templatesDir).isDirectory()) {
    throw new Error(`产物模板目录不存在：${env.templatesDir}。用 YXS_TEMPLATES_DIR 指定。`)
  }
  const mentor = join(env.promptsDir, 'agents', 'mentor.md')
  if (!existsSync(mentor)) {
    throw new Error(`提示词目录不完整：缺少 ${mentor}。用 LEARNING_AGENT_PROMPTS_DIR 指向 packages/agent。`)
  }
  if (!existsSync(env.openapiPath)) {
    throw new Error('缺少契约文件 docs/contracts/openapi.yaml，先在 apps/server 里跑 pnpm gen:openapi。')
  }
}
