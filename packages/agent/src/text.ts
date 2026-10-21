import type { Chapter, Question, QuestionType } from '@learning-agent/shared'

const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f']

export function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。！？；：、,.!?;:'"“”‘’（）()【】\[\]《》<>—\-_/\\]/g, '')
}

export function bigrams(value: string): Set<string> {
  const text = normalize(value)
  const output = new Set<string>()
  for (let index = 0; index < text.length - 1; index++) {
    output.add(text.slice(index, index + 2))
  }
  if (text.length === 1) output.add(text)
  return output
}

export function similarity(left: string, right: string): number {
  const a = bigrams(left)
  const b = bigrams(right)
  if (a.size === 0 || b.size === 0) return 0
  let overlap = 0
  for (const item of a) if (b.has(item)) overlap += 1
  return overlap / Math.max(a.size, b.size)
}

function optionIndex(
  options: string[],
  value: string,
  allowSubstring = true,
  allowLabelStrip = true,
): number {
  const target = normalize(value)
  if (target.length === 0) return -1

  const letter = /^[a-f]$/.exec(target)?.[0]
  if (letter) {
    const index = LETTERS.indexOf(letter)
    if (index >= 0 && index < options.length) return index
  }
  const numeric = /^\d+$/.exec(target)
  if (numeric) {
    const index = Number(numeric[0]) - 1
    if (index >= 0 && index < options.length) return index
  }

  const normalized = options.map((option) => normalize(option).replace(/^[a-f](?=[^a-z]|$)/, ''))
  const exact = normalized.findIndex((option) => option === target)
  if (exact >= 0) return exact
  if (allowLabelStrip) {
    const stripped = target.replace(/^[a-f](?=[^a-z]|$)/, '')
    if (stripped !== target) {
      const byStripped = normalized.findIndex((option) => option === stripped)
      if (byStripped >= 0) return byStripped
    }
  }

  if (!allowSubstring) return -1
  // Containment is only safe when exactly one option matches. Options that are
  // prefixes/substrings of each other must not silently select the first one.
  const candidates = normalized
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => option.length > 0 && (option.includes(target) || target.includes(option)))
  return candidates.length === 1 ? candidates[0]!.index : -1
}

function segmentOptions(options: string[], value: string): number[] | undefined {
  const target = normalize(value)
  if (!target) return undefined
  const candidates = options
    .map((option, index) => ({
      text: normalize(option).replace(/^[a-f](?=[^a-z]|$)/, ''),
      index,
    }))
    .filter((item) => item.text.length > 0)
    .sort((left, right) => right.text.length - left.text.length)
  const indexes: number[] = []
  let position = 0
  while (position < target.length) {
    const match = candidates.find((item) => target.startsWith(item.text, position))
    if (!match) return undefined
    if (!indexes.includes(match.index)) indexes.push(match.index)
    position += match.text.length
  }
  return indexes.length > 0 ? indexes.sort((left, right) => left - right) : undefined
}

function optionIndexes(options: string[], value: string): number[] {
  const compact = /^[a-f]{2,}$/.exec(normalize(value))?.[0]
  if (compact && compact.length <= options.length) {
    const indexes: number[] = []
    for (const letter of compact) {
      const index = LETTERS.indexOf(letter)
      if (index >= 0 && index < options.length && !indexes.includes(index)) indexes.push(index)
    }
    if (indexes.length > 0) return indexes
  }
  const whole = optionIndex(options, value, false, false)
  if (whole >= 0) return [whole]
  const output: number[] = []
  let matchedAll = true
  for (const token of value.split(/[,，、;；\s]+/).map((part) => part.trim()).filter(Boolean)) {
    const normalized = normalize(token)
    const letters = /^[a-f]{2,}$/.exec(normalized)?.[0]
    if (letters && letters.length <= options.length) {
      for (const letter of letters) {
        const index = LETTERS.indexOf(letter)
        if (index >= 0 && index < options.length && !output.includes(index)) output.push(index)
      }
      continue
    }
    const index = optionIndex(options, token, false)
    if (index < 0) {
      matchedAll = false
      break
    }
    if (!output.includes(index)) output.push(index)
  }
  if (matchedAll && output.length > 0) return output
  return segmentOptions(options, value) ?? output
}

export function scoreAnswer(question: Question, answer: string): {
  correct: boolean
  partial: boolean
  score: number
} {
  const submitted = normalize(answer)
  if (submitted.length === 0) return { correct: false, partial: false, score: 0 }

  if (question.type === '单选' || question.type === '多选') {
    if (question.type === '单选') {
      const expected = optionIndex(question.options, question.answer)
      const actual = optionIndex(question.options, answer)
      const correct = expected >= 0 && actual >= 0 && expected === actual
      return { correct, partial: false, score: correct ? 1 : 0 }
    }
    const expectedLetters = new Set(optionIndexes(question.options, question.answer))
    const actualLetters = new Set(optionIndexes(question.options, answer))
    const same = expectedLetters.size === actualLetters.size
      && [...expectedLetters].every((item) => actualLetters.has(item))
    const overlap = [...actualLetters].filter((item) => expectedLetters.has(item)).length
    const correct = expectedLetters.size > 0 && same
    return {
      correct,
      partial: !correct && overlap > 0,
      score: expectedLetters.size > 0 ? Number((overlap / expectedLetters.size).toFixed(2)) : 0,
    }
  }

  if (question.type === '判断') {
    const truth = (value: string): boolean | undefined => {
      const text = normalize(value)
      if (/^(正确|对|是|true|t|yes|y)$/.test(text)) return true
      if (/^(错误|错|否|false|f|no|n)$/.test(text)) return false
      return undefined
    }
    const expected = truth(question.answer)
    const actual = truth(answer)
    const correct = expected !== undefined && actual !== undefined && expected === actual
    return { correct, partial: !correct && actual !== undefined, score: correct ? 1 : 0 }
  }

  const ratio = similarity(answer, question.answer)
  return { correct: ratio >= 0.28, partial: ratio >= 0.12, score: Number(ratio.toFixed(2)) }
}

export function levelFromScore(score: number): 'L1' | 'L2' | 'L3' | 'L4' {
  if (score >= 0.75) return 'L3'
  if (score >= 0.4) return 'L2'
  return 'L1'
}

export function snippet(text: string, query: string, max = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const tokens = query
    .split(/[\s,，。！？；：、]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
  for (const token of tokens) {
    const at = clean.indexOf(token)
    if (at >= 0) {
      const start = Math.max(0, at - Math.floor(max / 3))
      return `${start > 0 ? '…' : ''}${clean.slice(start, start + max)}${start + max < clean.length ? '…' : ''}`
    }
  }
  return `${clean.slice(0, max)}${clean.length > max ? '…' : ''}`
}

export function extractCount(message: string, fallback = 3): number {
  const match = /(\d+)\s*道/.exec(message)
  if (!match) return fallback
  return Math.min(30, Math.max(1, Number(match[1])))
}

export function extractTypes(message: string): QuestionType[] {
  const output: QuestionType[] = []
  for (const type of ['名词解释', '填空', '判断', '单选', '多选', '简答', '案例分析'] as QuestionType[]) {
    if (message.includes(type)) output.push(type)
  }
  return output.length > 0 ? output : ['单选']
}

const CHAPTER_KEYWORDS: Array<{ chapterId: string; keywords: string[] }> = [
  { chapterId: 'ch01', keywords: ['营销是什么', '市场营销导论', '营销与销售', '销售的区别'] },
  { chapterId: 'ch02', keywords: ['营销观念', '管理哲学', '生产导向', '产品导向', '推销导向', '营销导向'] },
  { chapterId: 'ch03', keywords: ['营销环境', 'pestel', '宏观环境', '微观环境', '机会与威胁'] },
  {
    chapterId: 'ch04',
    keywords: ['消费者', '购买行为', '直播间', '冲动消费', '主播', '带货', '需求', '参照群体', '知觉', '文化因素', '心理因素', '社会因素'],
  },
  { chapterId: 'ch05', keywords: ['组织市场', 'b2b', '采购', '购买中心'] },
  { chapterId: 'ch06', keywords: ['调研', '研究设计', '问卷', '访谈', '抽样', '样本', '研究问题'] },
  { chapterId: 'ch07', keywords: ['stp', '细分', '定位', '目标市场'] },
  { chapterId: 'ch08', keywords: ['产品策略', '产品线', '产品组合', '产品层次'] },
  { chapterId: 'ch09', keywords: ['价格策略', '定价', '价格敏感'] },
  { chapterId: 'ch10', keywords: ['渠道策略', '分销', '渠道冲突'] },
  { chapterId: 'ch11', keywords: ['促销策略', '整合营销传播', '广告', '传播组合'] },
  { chapterId: 'ch12', keywords: ['商业计划书', 'bp', '创业计划', '营销计划', '计划与控制'] },
  { chapterId: 'ch13', keywords: ['数字化营销', '可持续营销', '新营销', '新趋势'] },
]

export function explicitChapter(message: string): string | undefined {
  const match = /第\s*(\d{1,2})\s*章/i.exec(message) ?? /\bch0?(\d{1,2})\b/i.exec(message)
  if (!match) return undefined
  const number = Number(match[1])
  return Number.isFinite(number) && number >= 1 && number <= 13
    ? `ch${String(number).padStart(2, '0')}`
    : undefined
}

export function inferChapterFromText(message: string): string | undefined {
  const lower = message.toLowerCase()
  for (const entry of CHAPTER_KEYWORDS) {
    if (entry.keywords.some((keyword) => lower.includes(keyword.toLowerCase()))) {
      return entry.chapterId
    }
  }
  return undefined
}

export function chapterTitle(chapters: Chapter[], chapterId: string | undefined): string {
  if (!chapterId) return ''
  return chapters.find((chapter) => chapter.id === chapterId)?.title ?? ''
}

const TOPIC_HINTS: Array<{ ids: string[]; keywords: string[] }> = [
  { ids: ['kp_situational'], keywords: ['直播间', '场景', '限时', '库存', '氛围', '冲动消费'] },
  { ids: ['kp_psychological'], keywords: ['冲动', '心理', '情绪', '从众', '损失厌恶', '知觉'] },
  { ids: ['kp_social'], keywords: ['主播', '社会', '群体', '评价', '口碑'] },
  { ids: ['kp_consumer_behavior_model'], keywords: ['购买行为', '决策', '为什么', '模式'] },
  { ids: ['kp_culture'], keywords: ['文化', '国潮', '价值观'] },
]

export function hintedTopicIds(message: string): string[] {
  const lower = message.toLowerCase()
  const output: string[] = []
  for (const hint of TOPIC_HINTS) {
    if (hint.keywords.some((keyword) => lower.includes(keyword))) {
      for (const id of hint.ids) if (!output.includes(id)) output.push(id)
    }
  }
  return output
}

export function topicLabel(message: string): string {
  return message
    .replace(/^(帮我|请|麻烦|我想|想要|需要|能不能|可以)+/g, '')
    .replace(/(帮我|请|设计|做|写|生成|出|一份|一个|的|调研|商业计划书|BP|目录|题目|题)+/gi, '')
    .replace(/[，。！？?；：、\s]+/g, '')
    .slice(0, 24) || '本次任务'
}
