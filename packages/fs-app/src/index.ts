import type { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { isPathUnder } from '@learning-agent/shared/containment'
import { FsError, type FsTarget } from '@deepseek-ai/dsh-fs'
import { relative, resolve } from 'node:path'

export interface Config {
  cwd: string
  appRoot: string
}

function isLexicallyUnder(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

export default class AppFileSystem extends SandboxedFileSystem {
  static inject = ['sandboxPolicy']
  private readonly appRoot: string

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.appRoot = resolve(config.appRoot)
  }

  override async resolve(
    path: string,
    opts?: { cwd?: string; signal?: AbortSignal },
  ): Promise<FsTarget> {
    const target = await super.resolve(path, opts)
    if (!(await isPathUnder(target.targetKey, this.appRoot))) {
      throw new FsError(
        `cannot access "${target.displayPath}": outside the application directory`,
        'FS_PERMISSION_DENIED',
      )
    }
    return target
  }

  override async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ) {
    const target = await this.resolve(path, { ...opts, signal })
    return super.lstat(target.displayPath, opts, signal)
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    const mapped = super.processPathFromHostPath(hostPath)
    return mapped !== undefined && isLexicallyUnder(mapped, this.appRoot) ? mapped : undefined
  }
}
