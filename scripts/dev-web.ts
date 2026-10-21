import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const env = {
  ...process.env,
  LEARNING_AGENT_HOME: process.env.LEARNING_AGENT_HOME || join(repoRoot, '.learning-agent'),
}

const child = spawn(
  'npx',
  ['@deepseek-ai/dsh@0.2.1-rc.2', '--profile', 'learning-agent'],
  { cwd: repoRoot, env, stdio: 'inherit', shell: process.platform === 'win32' },
)
child.on('exit', (code) => process.exit(code ?? 0))
