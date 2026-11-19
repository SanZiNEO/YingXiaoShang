import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { moduleRoot } from './paths.js'

/**
 * 模型网关配置只从环境变量 / 本地 `.env.local` 读取，**仓库内不留任何真实地址或模型名**。
 * 需要在本地跑对话类用例时，复制 `.env.local.example` 为 `.env.local` 并填写：
 *   YXS_LLM_BASE_URL=
 *   YXS_LLM_API_KEY=
 *   YXS_LLM_MODEL=
 */
export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
}

let loaded = false

/** 读模块根目录的 `.env.local`（已存在的环境变量优先）。缺文件时保持空配置。 */
export function loadLocalEnv(): void {
  if (loaded) return
  loaded = true
  const file = join(moduleRoot, '.env.local')
  if (!existsSync(file)) return
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, '')
    if (key.length > 0 && process.env[key] === undefined) process.env[key] = value
  }
}

export function resolveLlmConfig(): LlmConfig {
  loadLocalEnv()
  return {
    baseUrl: process.env.YXS_LLM_BASE_URL ?? '',
    apiKey: process.env.YXS_LLM_API_KEY ?? '',
    model: process.env.YXS_LLM_MODEL ?? '',
  }
}

export interface BuildEnvInput {
  home: string
  userDataDir: string
  newsPort: number
  autostartSidecar: boolean
  extraEnv?: Record<string, string | undefined>
}

/** 子进程环境：固定隔离 home / 端口 / sidecar 策略；模型网关仅在本地配置存在时注入。 */
export function buildEnv(input: BuildEnvInput): Record<string, string> {
  loadLocalEnv()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  // 不让 dev server 地址残留：out/ 与 packaged 都必须走本地文件。
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_RUN_AS_NODE
  delete env.LEARNING_AGENT_PROMPT_ROOTS

  env.LEARNING_AGENT_HOME = input.home
  env.NEWS_CRAWLER_PORT = String(input.newsPort)
  env.NEWS_CRAWLER_URL = `http://127.0.0.1:${input.newsPort}`
  env.NEWS_CRAWLER_AUTOSTART = input.autostartSidecar ? '1' : '0'
  env.LEARNING_AGENT_NEWS_REFRESH_MINUTES = '1440'

  const llm = resolveLlmConfig()
  if (llm.baseUrl.length > 0) env.DEEPSEEK_BASE_URL = llm.baseUrl
  if (llm.apiKey.length > 0) env.DEEPSEEK_API_KEY = llm.apiKey
  if (llm.model.length > 0) env.DEEPSEEK_MODEL = llm.model

  for (const [key, value] of Object.entries(input.extraEnv ?? {})) {
    // 空串与 undefined 都表示“清除该变量”，避免 Electron 把空值当成已配置。
    if (value === undefined || value === '') delete env[key]
    else env[key] = value
  }
  return env
}

export interface GatewayProbe {
  ok: boolean
  models: string[]
  error?: string
}

/** 对话类用例开跑前显式确认网关可达且模型在列；配置缺失或不可达直接报错，不静默降级。 */
export async function probeGateway(timeoutMs = 5000): Promise<GatewayProbe> {
  const config = resolveLlmConfig()
  if (!config.baseUrl || !config.apiKey || !config.model) {
    return { ok: false, models: [], error: '未配置 YXS_LLM_BASE_URL / YXS_LLM_API_KEY / YXS_LLM_MODEL（见 .env.local.example）' }
  }
  const base = config.baseUrl.replace(/\/$/, '')
  try {
    const response = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { ok: false, models: [], error: `HTTP ${response.status}` }
    const body = (await response.json()) as { data?: Array<{ id?: string }> }
    const models = (body.data ?? []).map((item) => item.id ?? '').filter((id) => id.length > 0)
    if (!models.includes(config.model)) {
      return { ok: false, models, error: `模型 ${config.model} 不在网关模型列表里` }
    }
    return { ok: true, models }
  } catch (error) {
    return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) }
  }
}
