import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Agent prompts are content, not code: they live as markdown under
 * `packages/agent/agents/` (copied verbatim from the course design) and are
 * shipped to the packaged app as `resources/prompts`.
 *
 * Search roots, in order:
 *   1. LEARNING_AGENT_PROMPTS_DIR  (explicit override)
 *   2. LEARNING_AGENT_PROMPT_ROOTS (`;`-separated, set by the desktop/web host)
 */
function roots(): string[] {
  const explicit = process.env.LEARNING_AGENT_PROMPTS_DIR ?? ''
  const listed = process.env.LEARNING_AGENT_PROMPT_ROOTS ?? ''
  return [explicit, ...listed.split(';')]
    .map((root) => root.trim())
    .filter((root) => root.length > 0)
}

const cache = new Map<string, string>()

/** Drop the YAML frontmatter: it is metadata for the host, not instructions. */
function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown.trim()
  const end = markdown.indexOf('\n---', 3)
  if (end < 0) return markdown.trim()
  const after = markdown.indexOf('\n', end + 4)
  return (after < 0 ? '' : markdown.slice(after + 1)).trim()
}

function read(kind: 'agents' | 'references', name: string): string {
  const key = `${kind}/${name}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  for (const root of roots()) {
    try {
      const text = stripFrontmatter(readFileSync(join(root, kind, `${name}.md`), 'utf8'))
      if (text.length > 0) {
        cache.set(key, text)
        return text
      }
    } catch {
      // Try the next root; a missing prompt must surface, not silently degrade.
    }
  }
  throw new Error(
    `找不到提示词 ${kind}/${name}.md。请设置 LEARNING_AGENT_PROMPTS_DIR 指向 packages/agent 目录。`,
  )
}

/** The agent prompt. There is exactly one. */
export function loadAgent(): string {
  return read('agents', 'mentor')
}

/** A toolkit reference the agent may consult, e.g. `loadReference('teaching-playbook')`. */
export function loadReference(name: string): string {
  return read('references', name)
}

/** Names of the references shipped alongside the agent prompt. */
export const REFERENCE_NAMES = [
  'teaching-playbook',
  'case-playbook',
  'question-playbook',
  'research-bp-playbook',
  'competency-rubric',
  'counterexample-playbook',
  'artifact-schemas',
] as const
