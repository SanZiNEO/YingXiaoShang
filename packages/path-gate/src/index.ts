import type { Context } from '@deepseek-ai/cordis'
import { isPathUnder } from '@learning-agent/shared/containment'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { isAbsolute, resolve } from 'node:path'

export const name = 'learning-path-gate'
export const inject = ['tools', 'workingDirectory']

const PATH_ARGS: Record<string, string[]> = {
  read: ['file_path'],
  read_image: ['file_path'],
  write: ['file_path'],
  edit: ['file_path'],
  glob: ['path'],
  grep: ['path'],
  bash: ['workdir'],
  pwsh: ['workdir'],
  working_directory: ['cd'],
}

const SHELL_TOOLS: Record<string, true> = {
  bash: true,
  pwsh: true,
  terminal: true,
  glob: true,
  grep: true,
  working_directory: true,
}

export interface Config {
  appRoot: string
}

export function apply(ctx: Context, config: Config) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (SHELL_TOOLS[exec.name]) {
      return {
        kind: 'deny' as const,
        reason: `shell and search tools are not permitted in this composition: ${exec.name}`,
        info: { name: 'PathPolicyError', code: 'PATH_OUTSIDE_APP' },
      }
    }
    const keys = PATH_ARGS[exec.name] ?? []
    const args = (exec.arguments ?? {}) as Record<string, unknown>
    const sessionCwd = exec.agent ? ctx.workingDirectory.get(exec.agent.session) : config.appRoot
    for (const key of keys) {
      const value = args[key]
      if (typeof value !== 'string' || value.length === 0) continue
      const absolute = isAbsolute(value) ? value : resolve(sessionCwd, value)
      if (!(await isPathUnder(absolute, config.appRoot))) {
        return {
          kind: 'deny' as const,
          reason: `path outside the application directory: ${value}`,
          info: { name: 'PathPolicyError', code: 'PATH_OUTSIDE_APP' },
        }
      }
    }
    return next()
  })
}
