import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DeepSeekSettings } from './llm.js'

export interface PublicSettings {
  hasApiKey: boolean
  model: string
  /** Where the effective key comes from; environment wins over the local file. */
  apiKeySource: 'env' | 'stored' | 'none'
  /**
   * Set when the settings file exists but cannot be parsed. The file is still
   * ignored, but callers can tell「没有配置」apart from「配置坏了」instead of
   * both surfacing as「DEEPSEEK_API_KEY is not configured」.
   */
  configError?: string
}

/** Windows editors (and PowerShell's utf8 default) prepend a BOM; JSON.parse rejects it. */
const BOM = /^\uFEFF/

export class SettingsStore {
  /** Last parse failure, if any. Cleared on a successful write. */
  private configError: string | undefined

  constructor(private readonly path: string) {}

  private stored(): Partial<DeepSeekSettings> {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      // First launch: no file yet, fall back to the environment.
      return {}
    }
    try {
      return JSON.parse(raw.replace(BOM, '')) as Partial<DeepSeekSettings>
    } catch {
      // The file is there but broken. Saying so beats silently acting unconfigured.
      this.configError = `${this.path} 不是合法的 JSON，已忽略该文件`
      console.warn(`[settings] ${this.configError}`)
      return {}
    }
  }

  read(): DeepSeekSettings {
    const stored = this.stored()
    return {
      apiKey: process.env.DEEPSEEK_API_KEY || stored.apiKey || '',
      model: process.env.DEEPSEEK_MODEL || stored.model || 'deepseek-chat',
    }
  }

  readPublic(): PublicSettings {
    const stored = this.stored()
    const envKey = process.env.DEEPSEEK_API_KEY ?? ''
    const storedKey = stored.apiKey ?? ''
    return {
      hasApiKey: (envKey || storedKey).length > 0,
      model: process.env.DEEPSEEK_MODEL || stored.model || 'deepseek-chat',
      apiKeySource: envKey.length > 0 ? 'env' : storedKey.length > 0 ? 'stored' : 'none',
      ...(this.configError ? { configError: this.configError } : {}),
    }
  }

  write(settings: Partial<DeepSeekSettings> & { clearApiKey?: boolean }): PublicSettings {
    const current = this.stored()
    const next = {
      apiKey: settings.clearApiKey
        ? ''
        : settings.apiKey !== undefined && settings.apiKey.length > 0
          ? settings.apiKey
          : current.apiKey ?? '',
      model: settings.model ?? current.model ?? 'deepseek-chat',
    }
    mkdirSync(dirname(this.path), { recursive: true })
    // Always rewrite without a BOM: this is the one place that repairs a file
    // a teacher edited in PowerShell.
    writeFileSync(this.path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    this.configError = undefined
    // Report the effective configuration: an environment key survives clearApiKey.
    return this.readPublic()
  }
}
