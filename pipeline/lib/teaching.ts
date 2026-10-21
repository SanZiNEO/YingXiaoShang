import type { TeachingGuide } from '@learning-agent/shared'
import { cleanText, oneLine, stripLeadingNumber, unique } from './text.ts'
import type { ParsedDocument } from './types.ts'

export interface TeachingGuideResult {
  guide: TeachingGuide
  warnings: string[]
}

type SectionName = 'summary' | 'key' | 'objectives' | 'tasks' | 'framework'

export function extractTeachingGuide(
  doc: ParsedDocument,
  params: {
    chapterId: string
    sourcePath: string
    frameworkText?: string
  },
): TeachingGuideResult {
  const warnings: string[] = []
  const sections: Record<SectionName, string[]> = {
    summary: [],
    key: [],
    objectives: [],
    tasks: [],
    framework: [],
  }
  let current: SectionName | undefined

  for (const block of doc.blocks) {
    if (block.kind === 'table' || block.kind === 'table_row') continue
    const text = oneLine(block.text)
    if (!text) continue
    if (/^第\s*\d+\s*章.*教学指南/.test(text)) continue

    const heading = detectSection(text)
    if (heading) {
      current = heading
      continue
    }
    if (current) sections[current].push(text)
  }

  const summary = sections.summary.join('\n').trim()
  const keyBlocks = unique(
    sections.key.map((item) => stripLeadingNumber(item)).filter(Boolean),
  )
  const difficulties = keyBlocks.filter((item) => /难点|辨析/.test(item))
  const keyPoints = keyBlocks.filter((item) => !/难点|辨析/.test(item))
  const objectives = unique(splitSentences(sections.objectives))
  const tasks = unique(sections.tasks.map((item) => cleanText(item)).filter(Boolean))
  const guideFramework = sections.framework.join('\n').trim()
  const frameworkText = (params.frameworkText ?? '').trim() || guideFramework

  if (!summary && keyBlocks.length === 0 && objectives.length === 0 && tasks.length === 0) {
    warnings.push('no teaching guide sections parsed')
  }
  if (!summary) warnings.push('teaching guide has no 本章提要 section')

  return {
    guide: {
      chapter_id: params.chapterId,
      summary,
      key_points: keyPoints,
      difficulties,
      objectives,
      tasks,
      framework_text: frameworkText,
      source: params.sourcePath,
    },
    warnings,
  }
}

function detectSection(text: string): SectionName | undefined {
  if (text.length > 40) return undefined
  const compact = text
    .replace(/[\s\u3000]/g, '')
    .replace(/^[一二三四五六七八九十]+[、.．]/, '')
    .replace(/^[（(][一二三四五六七八九十\d]+[）)]/, '')
  if (/本章提要|内容提要|^提要/.test(compact)) return 'summary'
  if (/重点与难点|重点难点|教学重点|本章重点/.test(compact)) return 'key'
  if (/教学目标|教学目的/.test(compact)) return 'objectives'
  if (/学习任务|教学任务/.test(compact)) return 'tasks'
  if (/知识框架图|框架图|知识结构图/.test(compact)) return 'framework'
  return undefined
}

function splitSentences(blocks: string[]): string[] {
  const text = blocks.join('\n')
  return text
    .split(/[；;。\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}
