import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function loadEnv(): void {
  const envPath = join(repoRoot, '.env')
  if (existsSync(envPath)) process.loadEnvFile(envPath)
  const home = process.env.LEARNING_AGENT_HOME || join(repoRoot, '.learning-agent')
  process.env.LEARNING_AGENT_HOME = home
}

export { repoRoot }
