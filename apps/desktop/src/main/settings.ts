import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DeepSeekSettings } from './llm.js'

export interface PublicSettings {
  hasApiKey: boolean
  model: string
  /** Where the effective key comes from; environment wins over the local file. */
  apiKeySource: 'env' | 'stored' | 'none'
}

export class SettingsStore {
  constructor(private readonly path: string) {}

  private stored(): Partial<DeepSeekSettings> {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Partial<DeepSeekSettings>
    } catch {
      // First launch or malformed file: fall back to the environment.
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
    writeFileSync(this.path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    // Report the effective configuration: an environment key survives clearApiKey.
    return this.readPublic()
  }
}
