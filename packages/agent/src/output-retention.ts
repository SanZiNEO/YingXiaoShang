/**
 * Byte-budgeted text retention, ported from DSH `@deepseek-ai/dsh-output-retention`.
 *
 * The library owns only "what was kept, what was omitted"; the caller owns the
 * recovery words and any tool-specific framing. Text budgets are UTF-8 bytes so
 * a cut can never introduce a replacement character at the boundary.
 */

/** How much content the retainer omitted. */
export type Omitted =
  | { kind: 'none' }
  | { kind: 'exact'; count: number }
  | { kind: 'unknown' }

/** Per-push retention decision. */
export interface PushDecision {
  /** Was this whole chunk retained (nothing dropped)? */
  kept: boolean
  /** Cumulative: has anything been omitted by the budget yet? */
  truncated: boolean
}

/** Final result for a byte-oriented text stream. */
export interface RetainedText {
  text: string
  truncated: boolean
  omittedBytes: Omitted
}

/** Keep a prefix, a suffix, or both. Budgets are UTF-8 bytes. */
export type TextRetentionStrategy =
  | { kind: 'head'; maxBytes: number }
  | { kind: 'tail'; maxBytes: number }
  | { kind: 'headTail'; headBytes: number; tailBytes: number }

/** Neutral description of one retention outcome, for notice formatting. */
export interface RetentionNotice {
  scope: string
  strategy: 'head' | 'tail' | 'headTail'
  unit: 'items' | 'bytes' | 'chars' | 'lines'
  limit: number | { head: number; tail: number }
  kept: number
  omitted: Omitted
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function assertBudget(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
}

/** Drop a trailing incomplete UTF-8 sequence at a prefix cut. */
function trimTrailingPartialUtf8(bytes: Uint8Array): Uint8Array {
  let index = bytes.length - 1
  while (index >= 0 && ((bytes[index] as number) & 0xc0) === 0x80 && bytes.length - index <= 3) {
    index -= 1
  }
  if (index < 0) return bytes
  const lead = bytes[index] as number
  const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 0
  if (expected === 0) return bytes
  return bytes.length - index < expected ? bytes.subarray(0, index) : bytes
}

/** Drop leading continuation bytes at a suffix cut. */
function trimLeadingContinuationUtf8(bytes: Uint8Array): Uint8Array {
  let index = 0
  while (index < bytes.length && ((bytes[index] as number) & 0xc0) === 0x80) index += 1
  return bytes.subarray(index)
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Bounds a byte-oriented text stream. `head` keeps a prefix, `tail` keeps a
 * suffix, `headTail` keeps both. `finish()` trims each real cut to a UTF-8
 * boundary and reports the exact omitted byte count.
 */
export class TextRetainer {
  private readonly prefixCap: number
  private readonly suffixCap: number
  private readonly prefixChunks: Uint8Array[] = []
  private prefixHeld = 0
  private readonly suffixChunks: Uint8Array[] = []
  private suffixHeld = 0
  private total = 0

  constructor(strategy: TextRetentionStrategy) {
    switch (strategy.kind) {
      case 'head':
        assertBudget(strategy.maxBytes, 'maxBytes')
        this.prefixCap = strategy.maxBytes
        this.suffixCap = 0
        break
      case 'tail':
        assertBudget(strategy.maxBytes, 'maxBytes')
        this.prefixCap = 0
        this.suffixCap = strategy.maxBytes
        break
      case 'headTail':
        assertBudget(strategy.headBytes, 'headBytes')
        assertBudget(strategy.tailBytes, 'tailBytes')
        this.prefixCap = strategy.headBytes
        this.suffixCap = strategy.tailBytes
        break
    }
  }

  /** Offer one chunk; prefix bytes fill first, suffix bytes roll. */
  push(chunk: Uint8Array | string): PushDecision {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
    const before = this.total
    this.total += bytes.length

    const room = this.prefixCap - this.prefixHeld
    const take = Math.max(0, Math.min(room, bytes.length))
    if (take > 0) {
      this.prefixChunks.push(bytes.subarray(0, take))
      this.prefixHeld += take
    }

    if (this.suffixCap > 0) {
      this.suffixChunks.push(bytes)
      this.suffixHeld += bytes.length
      let head = this.suffixChunks[0]
      while (head !== undefined && this.suffixHeld - head.length >= this.suffixCap) {
        this.suffixChunks.shift()
        this.suffixHeld -= head.length
        head = this.suffixChunks[0]
      }
      if (head !== undefined && this.suffixHeld > this.suffixCap) {
        const excess = this.suffixHeld - this.suffixCap
        this.suffixChunks[0] = head.subarray(excess)
        this.suffixHeld -= excess
      }
    }

    return {
      kept: this.omittedAt(this.total) === this.omittedAt(before),
      truncated: this.omittedAt(this.total) > 0,
    }
  }

  /** Bytes omitted once `total` bytes have been seen. */
  private omittedAt(total: number): number {
    const prefixLength = Math.min(total, this.prefixCap)
    const suffixLength = Math.min(total - prefixLength, this.suffixCap)
    return total - prefixLength - suffixLength
  }

  /** Finalize the retained text and its exact omission metadata. */
  finish(): RetainedText {
    const prefixLength = Math.min(this.total, this.prefixCap)
    const suffixLength = Math.min(this.total - prefixLength, this.suffixCap)

    const prefix = concat(this.prefixChunks)
    const suffix = concat(this.suffixChunks).subarray(this.suffixHeld - suffixLength)
    const budgetOmitted = this.omittedAt(this.total)
    const [keptPrefix, keptSuffix] = budgetOmitted > 0
      ? [trimTrailingPartialUtf8(prefix), trimLeadingContinuationUtf8(suffix)]
      : [prefix, suffix]
    const text = budgetOmitted > 0
      ? decoder.decode(keptPrefix) + decoder.decode(keptSuffix)
      : decoder.decode(concat([prefix, suffix]))

    const omitted = this.total - keptPrefix.length - keptSuffix.length
    return {
      text,
      truncated: omitted > 0,
      omittedBytes: omitted > 0 ? { kind: 'exact', count: omitted } : { kind: 'none' },
    }
  }
}

/** Standardized omission wording; the caller supplies recovery guidance. */
export function describeOmitted(omitted: Omitted, unit: RetentionNotice['unit']): string {
  switch (omitted.kind) {
    case 'none':
      return ''
    case 'exact':
      return `省略 ${omitted.count} ${unit}。`
    case 'unknown':
      return `还有更多 ${unit} 被省略。`
  }
}

/** Join the standard omission clause with the tool's own recovery sentence. */
export function formatRetentionNotice(
  notice: RetentionNotice,
  recovery: (notice: RetentionNotice) => string,
): string {
  return [describeOmitted(notice.omitted, notice.unit), recovery(notice)]
    .filter((part) => part.length > 0)
    .join(' ')
}

/** Cap text at `maxChars` UTF-16 code units without splitting a surrogate pair. */
export function truncateWithoutSplittingSurrogatePair(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const capped = text.slice(0, maxChars)
  return /[\uD800-\uDBFF]$/.test(capped) ? capped.slice(0, -1) : capped
}
