export interface SpanLocation {
  /** Exact substring of the source text. */
  span: string
  /** UTF-16 start offset in the source text. */
  start: number
  /** UTF-16 end offset (exclusive) in the source text. */
  end: number
}

interface NormalizedText {
  text: string
  map: number[]
}

function normalizeWithMap(value: string): NormalizedText {
  let text = ''
  const map: number[] = []
  let inSpace = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index] ?? ''
    if (/\s/.test(char)) {
      if (!inSpace) {
        text += ' '
        map.push(index)
        inSpace = true
      }
    } else {
      text += char
      map.push(index)
      inSpace = false
    }
  }
  return { text, map }
}

/**
 * Locate a quote in a source text. Whitespace runs are normalized before
 * matching, but the returned span is always a verbatim slice of `text`.
 * This is the single span contract used by tags, matches, citations and
 * evidence validation.
 */
export function locateSpan(text: string, quote: string): SpanLocation | undefined {
  const needle = normalizeWithMap(quote).text.trim()
  if (needle.length === 0) return undefined
  const normalized = normalizeWithMap(text)
  const at = normalized.text.indexOf(needle)
  if (at < 0) return undefined
  const start = normalized.map[at]
  const last = normalized.map[at + needle.length - 1]
  if (start === undefined || last === undefined) return undefined
  return { span: text.slice(start, last + 1), start, end: last + 1 }
}
