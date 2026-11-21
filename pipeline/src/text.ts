import { createHash } from 'node:crypto'

export function cleanText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

export function oneLine(value: string): string {
  return cleanText(value).replace(/\s*\n\s*/g, ' ')
}

export function stripLeadingNumber(value: string): string {
  return oneLine(value).replace(/^\s*\d+\s*[.、．]\s*/, '').trim()
}

export function normalizeName(value: string): string {
  return oneLine(value)
    .replace(/^\s*\d+\s*[.、．]\s*/, '')
    .replace(/^[（(][一二三四五六七八九十\d]+[）)]\s*/, '')
    .replace(/^[一二三四五六七八九十]+[、.．]\s*/, '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。；：、（）()【】\[\]《》〈〉“”"'‘’·\-—–_/\\]/g, '')
    .replace(/^(第[一二三四五六七八九十\d]+[章节部分])/, '')
    .replace(/的含义及类型$/, '')
    .replace(/的类型及其对购买行为的影响$/, '')
    .replace(/的心理与行为特征$/, '')
    .replace(/的购买决策过程$/, '')
    .replace(/的一般过程$/, '')
    .replace(/的主要阶段$/, '')
    .replace(/及其作用机制$/, '')
    .replace(/的影响因素$/, '')
    .replace(/的含义$/, '')
    .replace(/的概念$/, '')
    .replace(/的特点$/, '')
    .replace(/的类型$/, '')
    .replace(/[与和及]/g, '')
    .replace(/的/g, '')
    .toLowerCase()
}

export function bigramSimilarity(a: string, b: string): number {
  const left = normalizeName(a)
  const right = normalizeName(b)
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.length < 2 || right.length < 2) return 0

  const grams = (value: string): Map<string, number> => {
    const map = new Map<string, number>()
    for (let i = 0; i < value.length - 1; i++) {
      const gram = value.slice(i, i + 2)
      map.set(gram, (map.get(gram) ?? 0) + 1)
    }
    return map
  }

  const aGrams = grams(left)
  const bGrams = grams(right)
  let overlap = 0
  for (const [gram, count] of aGrams) {
    overlap += Math.min(count, bGrams.get(gram) ?? 0)
  }
  return (2 * overlap) / (left.length - 1 + right.length - 1)
}

export function matchScore(query: string, candidate: string): number {
  const q = normalizeName(query)
  const c = normalizeName(candidate)
  if (!q || !c) return 0
  if (q === c) return 1
  if (q.includes(c) || c.includes(q)) {
    const ratio = Math.min(q.length, c.length) / Math.max(q.length, c.length)
    return 0.82 + 0.18 * ratio
  }
  return bigramSimilarity(q, c)
}

export function splitKeywords(value: string): string[] {
  return oneLine(value)
    .replace(/^关键词\s*[：:]\s*/, '')
    .split(/[、,，;；/|]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function splitInlineFields(value: string): string[] {
  const text = oneLine(value)
  if (!text) return []
  return text
    .split(/(?=(?:答案|解析|知识点|难度级别|难度)\s*[：:])/g)
    .map((part) => part.trim())
    .filter(Boolean)
}

export function sha1Short(value: string, length = 12): string {
  return createHash('sha1').update(value).digest('hex').slice(0, length)
}

export function slugify(value: string): string {
  const ascii = value
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '_')
  return ascii || sha1Short(value, 8)
}

export function firstSentence(value: string): string {
  const text = oneLine(value)
  if (!text) return ''
  const match = /^(.+?[。！？!?])/.exec(text)
  return (match?.[1] ?? text).trim()
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

export function pageFromLabel(value: string): number | undefined {
  const match = /(\d{1,4})/.exec(value)
  if (!match) return undefined
  const page = Number(match[1])
  return Number.isFinite(page) && page > 0 ? page : undefined
}

export function sectionNumberFromLabel(value: string): number | undefined {
  const match = /第\s*(\d+)\s*节/.exec(value)
  if (!match) return undefined
  const number = Number(match[1])
  return Number.isInteger(number) && number > 0 ? number : undefined
}

export function parseDifficulty(value: string): number {
  const match = /(\d+)/.exec(value)
  if (!match) return 2
  const number = Number(match[1])
  if (!Number.isFinite(number)) return 2
  return Math.min(3, Math.max(1, Math.round(number)))
}

export function isHeadingLike(value: string): boolean {
  const text = oneLine(value)
  if (!text || text.length > 80) return false
  if (/[。；;]$/.test(text)) return false
  return true
}
