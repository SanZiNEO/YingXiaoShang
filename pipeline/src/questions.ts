import type { KnowledgePoint, Question, QuestionType } from '@learning-agent/shared'
import {
  cleanText,
  firstSentence,
  matchScore,
  normalizeName,
  oneLine,
  parseDifficulty,
  sha1Short,
  splitInlineFields,
  unique,
} from './text.ts'
import type { ParsedDocument } from './types.ts'

interface QuestionDraft {
  type: QuestionType
  stemLines: string[]
  answerLines: string[]
  explanationLines: string[]
  kpLines: string[]
  difficultyLines: string[]
  options: string[]
}

export interface QuestionExtractionResult {
  questions: Question[]
  warnings: string[]
}

export function extractQuestions(
  doc: ParsedDocument,
  params: {
    chapterId: string
    chapterNumber: number
    sourcePath: string
    knowledgePoints: KnowledgePoint[]
  },
): QuestionExtractionResult {
  const { chapterId, chapterNumber, sourcePath, knowledgePoints } = params
  const warnings: string[] = []
  const questions: Question[] = []
  const seenIds = new Set<string>()
  let currentType: QuestionType | undefined
  let current: QuestionDraft | undefined
  let fallbackKpWarnings = 0

  const flush = (): void => {
    if (!current) return
    const question = buildQuestion(current, {
      chapterId,
      chapterNumber,
      sourcePath,
      knowledgePoints,
      warnings,
      onFallbackKp: () => {
        fallbackKpWarnings++
      },
    })
    current = undefined
    if (!question) return
    if (seenIds.has(question.id)) {
      warnings.push(`duplicate question id skipped: ${question.id}`)
      return
    }
    seenIds.add(question.id)
    questions.push(question)
  }

  for (const block of doc.blocks) {
    if (block.kind === 'table' || block.kind === 'table_row') continue
    const rawText = oneLine(block.text)
    if (!rawText) continue
    if (/^第\s*\d+\s*章.*习题/.test(rawText)) continue

    const segments = splitInlineFields(rawText)
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
      const text = oneLine(segments[segmentIndex] ?? '')
      if (!text) continue
      const blankBefore = segmentIndex === 0 ? (block.blankBefore ?? true) : false

      const headingType = detectQuestionType(text)
      if (headingType) {
        flush()
        currentType = headingType
        continue
      }
      if (isContainerHeading(text)) continue

      const field = parseField(text)
      if (field) {
        if (!current) continue
        if (field.name === '答案') current.answerLines.push(field.value)
        else if (field.name === '解析') current.explanationLines.push(field.value)
        else if (field.name === '知识点') current.kpLines.push(field.value)
        else current.difficultyLines.push(field.value)
        continue
      }

      if (!currentType) continue
      const numbered = /^\s*\d+\s*[.、．]\s*/.test(text)
      const continuation = /^[（(]\d+[）)]|^[①②③④⑤⑥⑦⑧⑨⑩]/.test(text)
      const optionList = parseOptions(text)
      const isOptionContext = currentType === '单选' || currentType === '多选'

      if (optionList.length > 0 && current && isOptionContext) {
        current.options.push(...optionList)
        continue
      }

      if (!current) {
        current = newDraft(currentType, numbered ? stripNumber(text) : text)
        continue
      }

      if (numbered) {
        flush()
        current = newDraft(currentType, stripNumber(text))
        continue
      }

      const completed =
        current.answerLines.length > 0 ||
        current.explanationLines.length > 0 ||
        current.kpLines.length > 0 ||
        current.difficultyLines.length > 0

      if (completed) {
        if (continuation) {
          current.explanationLines.push(text)
          continue
        }
        if (isOptionContext && current.options.length > 0 && current.answerLines.length === 0) {
          current.options[current.options.length - 1] += ` ${text}`
          continue
        }
        if (current.type === '名词解释' && text.length <= 60 && !/[。；，]/.test(text)) {
          const type = current.type
          flush()
          current = newDraft(type, text)
          continue
        }
        if (current.type === '名词解释' && current.explanationLines.length > 0) {
          current.explanationLines.push(text)
          continue
        }
        if (!blankBefore && current.explanationLines.length > 0) {
          current.explanationLines.push(text)
          continue
        }
        flush()
        current = newDraft(currentType, text)
        continue
      }

      if (current.type === '名词解释' && current.stemLines.length === 1 && text.length >= 20) {
        current.explanationLines.push(text)
        continue
      }
      current.stemLines.push(text)
    }
  }
  flush()

  if (fallbackKpWarnings > 0) {
    warnings.push(`${fallbackKpWarnings} question(s) had no knowledge point match; used a chapter fallback`)
  }
  if (questions.length === 0) {
    warnings.push('no questions parsed')
  }
  return { questions, warnings }
}

function newDraft(type: QuestionType, stem: string): QuestionDraft {
  return {
    type,
    stemLines: [stem],
    answerLines: [],
    explanationLines: [],
    kpLines: [],
    difficultyLines: [],
    options: [],
  }
}

function buildQuestion(
  draft: QuestionDraft,
  params: {
    chapterId: string
    chapterNumber: number
    sourcePath: string
    knowledgePoints: KnowledgePoint[]
    warnings: string[]
    onFallbackKp: () => void
  },
): Question | undefined {
  const stem = cleanText(draft.stemLines.join(' '))
    .replace(/^\s*\d+\s*[.、．]\s*/, '')
    .trim()
  if (!stem) return undefined

  let answer = cleanText(draft.answerLines.join(' '))
  let explanation = cleanText(draft.explanationLines.join('\n'))

  if (draft.type === '判断' && answer) {
    if (/正确|√|^对$|^T$/i.test(answer)) answer = '正确'
    else if (/错误|×|^错$|^F$/i.test(answer)) answer = '错误'
  }
  if (!answer) answer = firstSentence(explanation) || stem
  if (!explanation) explanation = answer
  if (!answer) answer = stem
  if (!explanation) explanation = stem

  const kpNames = unique(
    draft.kpLines
      .flatMap((line) => line.split(/[、,，;；]/))
      .map((line) => line.trim())
      .filter(Boolean),
  )
  const kpIds: string[] = []
  for (const name of kpNames) {
    const match = matchKnowledgePoint(name, params.knowledgePoints)
    if (match) kpIds.push(match.id)
  }
  if (kpIds.length === 0) {
    const match = matchKnowledgePoint(stem, params.knowledgePoints)
    if (match) kpIds.push(match.id)
  }
  if (kpIds.length === 0) {
    const fallback = params.knowledgePoints[0]
    if (fallback) kpIds.push(fallback.id)
    params.onFallbackKp()
  }
  if (kpIds.length === 0) {
    params.warnings.push(`question dropped because no knowledge point is available: ${stem.slice(0, 40)}`)
    return undefined
  }

  if ((draft.type === '单选' || draft.type === '多选') && draft.options.length === 0) {
    params.warnings.push(`question has no options: ${stem.slice(0, 40)}`)
  }

  return {
    id: `q_${sha1Short(`${params.chapterNumber}|${draft.type}|${stem}`, 12)}`,
    source_type: 'resource',
    source_id: params.sourcePath,
    type: draft.type,
    stem,
    options: draft.options,
    answer,
    explanation,
    difficulty: parseDifficulty(draft.difficultyLines.join(' ')),
    kp_ids: unique(kpIds),
    ideology_ids: [],
    status: 'reviewed',
  }
}

function matchKnowledgePoint(
  name: string,
  knowledgePoints: KnowledgePoint[],
): KnowledgePoint | undefined {
  const normalized = normalizeName(name)
  if (!normalized) return undefined
  const exact = knowledgePoints.find((point) => normalizeName(point.name) === normalized)
  if (exact) return exact

  let best: KnowledgePoint | undefined
  let bestScore = 0
  for (const point of knowledgePoints) {
    const score = matchScore(name, point.name) + (point.status === 'reviewed' ? 0.02 : 0)
    if (score > bestScore) {
      bestScore = score
      best = point
    }
  }
  return bestScore >= 0.45 ? best : undefined
}

function detectQuestionType(text: string): QuestionType | undefined {
  if (text.length > 40) return undefined
  if (/[。]$/.test(text)) return undefined
  const compact = text
    .replace(/[\s\u3000]/g, '')
    .replace(/^[一二三四五六七八九十]+[、.．]/, '')
    .replace(/^[（(][一二三四五六七八九十\d]+[）)]/, '')
  if (/^名词解释/.test(compact)) return '名词解释'
  if (/^填空/.test(compact)) return '填空'
  if (/^判断/.test(compact)) return '判断'
  if (/^(单项选择|单选)/.test(compact)) return '单选'
  if (/^(多项选择|多选)/.test(compact)) return '多选'
  if (/^案例分析/.test(compact)) return '案例分析'
  if (/简答/.test(compact)) return '简答'
  if (/主观题/.test(compact) && !/客观题/.test(compact)) return '简答'
  return undefined
}

function isContainerHeading(text: string): boolean {
  return /^(客观题|一、客观题|第\s*\d+\s*章.*习题)$/.test(
    text.replace(/[\s\u3000]/g, ''),
  )
}

function parseField(text: string): { name: string; value: string } | undefined {
  const match = /^(答案|解析|知识点|难度级别|难度)\s*[：:]\s*([\s\S]*)$/.exec(text)
  if (!match) return undefined
  return {
    name: match[1] === '难度' ? '难度级别' : (match[1] ?? ''),
    value: cleanText(match[2] ?? ''),
  }
}

function parseOptions(text: string): string[] {
  const normalized = text.replace(/[Ａ-Ｄ]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) - 0xfee0),
  )
  if (!/[A-D]\s*[:：、.．]/.test(normalized)) return []
  const parts = normalized.split(/(?=[A-D]\s*[:：、.．]\s*)/)
  const options: string[] = []
  for (const part of parts) {
    const match = /^\s*([A-D])\s*[:：、.．]\s*([\s\S]*)$/.exec(part)
    if (match) {
      options.push(`${match[1]}. ${cleanText(match[2] ?? '')}`)
    } else if (options.length > 0) {
      options[options.length - 1] += ` ${cleanText(part)}`
    }
  }
  return options
}

function stripNumber(text: string): string {
  return text.replace(/^\s*\d+\s*[.、．]\s*/, '').trim()
}
