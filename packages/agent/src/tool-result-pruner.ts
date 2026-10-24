/**
 * Deterministic middle pruning for old tool results. The budget is counted in
 * Unicode code points (not bytes) so a retained boundary cannot split a
 * surrogate pair.
 */

export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

export interface PruneLimits {
  /** Prune when the text exceeds this many code points. */
  thresholdChars: number
  /** Leading code points retained. */
  headChars: number
  /** Trailing code points retained. */
  tailChars: number
}

export const PRUNE_DEFAULTS: PruneLimits = {
  thresholdChars: 8_192,
  headChars: 4_096,
  tailChars: 1_024,
}

export interface ToolPruneState {
  prunedChars: number
  prunedCalls: number
  peakChars: number
}

export function emptyPruneState(): ToolPruneState {
  return { prunedChars: 0, prunedCalls: 0, peakChars: 0 }
}

/** Count Unicode code points without splitting surrogate pairs. */
export function codePointLength(text: string): number {
  return Array.from(text).length
}

/**
 * Replace the middle of one over-budget text with {@link PRUNE_MARKER}.
 * Returns `null` when the text is within budget.
 */
export function pruneText(text: string, limits: PruneLimits = PRUNE_DEFAULTS): string | null {
  const points = Array.from(text)
  if (points.length <= limits.thresholdChars) return null
  const removedEnd = points.length - limits.tailChars
  if (removedEnd <= limits.headChars) {
    throw new Error('tool-result prune: headChars + tailChars must be smaller than the input')
  }
  return points.slice(0, limits.headChars).join('')
    + PRUNE_MARKER
    + points.slice(removedEnd).join('')
}

/** Total code points currently carried by tool-result text blocks. */
export function totalToolResultChars(messages: ReadonlyArray<{ role: string; content: Array<Record<string, unknown>> }>): number {
  let total = 0
  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const block of message.content) {
      if (block.type === 'tool-result' && typeof block.text === 'string') {
        total += codePointLength(block.text)
      }
    }
  }
  return total
}

/**
 * Prune every over-budget tool result once the current turn exceeds
 * `maxTotalChars`. Messages are never removed, so assistant tool calls keep
 * their paired results.
 */
export function pruneToolResults(
  messages: Array<{ role: string; content: Array<Record<string, unknown>> }>,
  state: ToolPruneState,
  maxTotalChars: number,
  limits: PruneLimits = PRUNE_DEFAULTS,
): void {
  const total = totalToolResultChars(messages)
  state.peakChars = Math.max(state.peakChars, total)
  if (total <= maxTotalChars) return

  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const block of message.content) {
      if (block.type !== 'tool-result' || typeof block.text !== 'string') continue
      const pruned = pruneText(block.text, limits)
      if (pruned === null) continue
      const before = codePointLength(block.text)
      const after = codePointLength(pruned)
      block.text = pruned
      state.prunedCalls += 1
      state.prunedChars += before - after
    }
  }
}
