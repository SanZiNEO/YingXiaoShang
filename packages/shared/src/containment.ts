import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

function under(candidate: string, root: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/**
 * Canonical containment check that tolerates a not-yet-created suffix: walk
 * to the deepest existing ancestor, realpath it, then re-attach the suffix.
 */
export async function isPathUnder(candidate: string, root: string): Promise<boolean> {
  const realRoot = await realpath(root).catch(() => resolve(root))
  let current = resolve(candidate)
  const suffix: string[] = []
  for (;;) {
    try {
      const real = await realpath(current)
      return under(resolve(real, ...suffix), realRoot)
    } catch {
      const parent = dirname(current)
      if (parent === current) return under(resolve(candidate), realRoot)
      suffix.unshift(basename(current))
      current = parent
    }
  }
}
