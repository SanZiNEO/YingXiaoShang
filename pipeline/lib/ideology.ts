import type { IdeologyPoint, KnowledgePoint } from '@learning-agent/shared'
import { cleanText, matchScore, normalizeName, oneLine, sha1Short, unique } from './text.ts'
import type { ParsedDocument } from './types.ts'

export interface IdeologyExtractionResult {
  ideologyPoints: IdeologyPoint[]
  warnings: string[]
}

export function extractIdeology(
  doc: ParsedDocument,
  params: {
    chapterTitle: string
    knowledgePoints: KnowledgePoint[]
  },
): IdeologyExtractionResult {
  const { chapterTitle, knowledgePoints } = params
  const warnings: string[] = []
  const rows = findIdeologyRows(doc)
  const points = new Map<string, IdeologyPoint>()

  for (const row of rows) {
    const [kpName, goal, integration, content] = row
    const name = cleanText(kpName ?? '')
    if (!name || /知识点/.test(name)) continue
    const definition =
      [cleanText(goal ?? ''), cleanText(content ?? '')].filter(Boolean).join('\n') ||
      cleanText(integration ?? '') ||
      name
    const examples = unique([cleanText(integration ?? '')].filter(Boolean))
    const related = matchKnowledgePoint(name, knowledgePoints)
    const id = `ideo_${sha1Short(name, 12)}`
    const existing = points.get(id)
    if (existing) {
      if (definition && !existing.definition.includes(definition)) {
        existing.definition = `${existing.definition}\n${definition}`.trim()
      }
      existing.examples = unique([...existing.examples, ...examples])
      if (related && !existing.related_kp_ids.includes(related.id)) {
        existing.related_kp_ids.push(related.id)
      }
      if (!existing.source.includes(doc.path)) existing.source = `${existing.source}; ${doc.path}`
      continue
    }
    points.set(id, {
      id,
      name,
      definition,
      examples,
      non_examples: [],
      related_kp_ids: related ? [related.id] : [],
      source: doc.path,
    })
  }

  if (rows.length === 0) {
    warnings.push('no ideology table rows parsed; used overall goal fallback')
    const goal = findOverallGoal(doc)
    if (goal) {
      const name = `${chapterTitle}课程思政`
      const id = `ideo_${sha1Short(name, 12)}`
      const fallback = knowledgePoints.find((point) => point.status === 'reviewed')
      points.set(id, {
        id,
        name,
        definition: goal,
        examples: [],
        non_examples: [],
        related_kp_ids: fallback ? [fallback.id] : [],
        source: doc.path,
      })
    }
  }

  if (points.size === 0) warnings.push('no ideology points parsed')
  return { ideologyPoints: [...points.values()], warnings }
}

function findIdeologyRows(doc: ParsedDocument): string[][] {
  if (doc.format === 'doc') return rowsFromDocBlocks(doc)

  const tables: string[][][] = []
  let current: string[][] = []

  for (const block of doc.blocks) {
    if (block.kind === 'table' && block.rows) {
      if (current.length > 0) {
        tables.push(current)
        current = []
      }
      tables.push(block.rows)
      continue
    }
    if (block.kind === 'table_row' && block.cells) {
      current.push(block.cells)
      continue
    }
    if (current.length > 0) {
      tables.push(current)
      current = []
    }
  }
  if (current.length > 0) tables.push(current)

  for (const rows of tables) {
    const headerIndex = rows.findIndex((row) => {
      const joined = row.join(' ')
      return /知识点/.test(joined) && /思政/.test(joined)
    })
    if (headerIndex < 0) continue
    return rows
      .slice(headerIndex + 1)
      .map(normalizeRow)
      .filter((row): row is string[] => row !== undefined)
  }

  const fallback = doc.blocks
    .filter((block) => block.kind === 'table_row' && block.cells)
    .map((block) => normalizeRow(block.cells ?? []))
    .filter((row): row is string[] => row !== undefined)
  return fallback
}

function rowsFromDocBlocks(doc: ParsedDocument): string[][] {
  const blocks = doc.blocks
  const headerIndex = blocks.findIndex((block) => {
    const text =
      block.kind === 'table_row' ? (block.cells ?? []).join(' ') : oneLine(block.text)
    return /知识点/.test(text) && /思政/.test(text) && /导入形式|思政内容/.test(text)
  })
  if (headerIndex < 0) return []

  const groups: string[][] = []
  let current: string[] = []

  for (const block of blocks.slice(headerIndex + 1)) {
    if (block.kind === 'table') continue
    if (block.kind === 'table_row' && block.cells) {
      const cells = block.cells.map((cell) => cleanText(cell)).filter(Boolean)
      if (cells.length === 0) continue
      if (current.length === 0 && cells.length >= 5) {
        groups.push(cells)
        continue
      }
      current.push(...cells)
      if (cells.length >= 5) {
        groups.push(current)
        current = []
      }
      continue
    }
    if (block.kind !== 'paragraph' && block.kind !== 'list_item') continue
    const text = oneLine(block.text)
    if (!text) continue
    if (/^第\s*\d+\s*章/.test(text)) continue
    current.push(text)
    if (isImportForm(text)) {
      groups.push(current)
      current = []
    }
  }
  if (current.length > 0) groups.push(current)

  return groups
    .map(normalizeGroup)
    .filter((row): row is string[] => row !== undefined)
}

function normalizeGroup(group: string[]): string[] | undefined {
  const cells = group.map((cell) => cleanText(cell)).filter(Boolean)
  if (cells.length < 2) return undefined
  if (/知识点/.test(cells[0] ?? '')) return undefined

  const last = cells[cells.length - 1] ?? ''
  const hasImport = isImportForm(last)
  let kp = cells[0] ?? ''
  let goal = ''
  let integration = ''
  let content = ''
  const importForm = hasImport ? last : ''
  const middle = hasImport ? cells.slice(1, -1) : cells.slice(1)

  const firstSplit = splitCell(kp)
  if (firstSplit) {
    kp = firstSplit[0]
    goal = firstSplit[1]
  }

  if (middle.length === 0) {
    return importForm ? [kp, '', '', '', importForm] : undefined
  }

  let rest = middle
  if (!goal && rest.length >= 2) {
    goal = rest[0] ?? ''
    rest = rest.slice(1)
  }

  if (rest.length === 1) {
    const split = splitCell(rest[0] ?? '')
    if (split) {
      integration = split[0]
      content = split[1]
    } else {
      content = rest[0] ?? ''
    }
  } else if (rest.length > 1) {
    integration = rest[0] ?? ''
    content = rest.slice(1).join(' ')
  }

  return [kp, goal, integration, content, importForm]
}

function splitCell(value: string): [string, string] | undefined {
  const text = oneLine(value)
  const index = text.indexOf(' ')
  if (index <= 0) return undefined
  const left = text.slice(0, index).trim()
  const right = text.slice(index + 1).trim()
  if (left.length < 2 || left.length > 24 || right.length < 4) return undefined
  if (/[。；，]/.test(left)) return undefined
  return [left, right]
}

function isImportForm(value: string): boolean {
  const text = oneLine(value)
  if (!text || text.length > 24 || /[。；]$/.test(text)) return false
  return /课堂|案例讨论|案例交流|课后|线上|视频|小组|角色|情景|辩论|实践|讲授|分享|查阅/.test(text)
}

function normalizeRow(cells: string[]): string[] | undefined {
  const cleaned = cells.map((cell) => cleanText(cell))
  if (cleaned.filter(Boolean).length < 4) return undefined
  if (/知识点/.test(cleaned[0] ?? '')) return undefined
  if (cleaned.length > 5) {
    return [
      cleaned[0] ?? '',
      cleaned[1] ?? '',
      cleaned[2] ?? '',
      cleaned.slice(3, -1).join(' '),
      cleaned[cleaned.length - 1] ?? '',
    ]
  }
  while (cleaned.length < 5) cleaned.push('')
  return cleaned
}

function findOverallGoal(doc: ParsedDocument): string {
  const blocks = doc.blocks
    .filter((block) => block.kind === 'paragraph' || block.kind === 'list_item')
    .map((block) => oneLine(block.text))
    .filter(Boolean)

  for (let index = 0; index < blocks.length; index++) {
    const text = blocks[index] ?? ''
    if (!/总体思政目标|思政目标/.test(text)) continue
    const afterColon = text.replace(/^.*?[：:]\s*/, '').trim()
    if (afterColon && afterColon !== text) return afterColon
    const next = blocks[index + 1]
    if (next) return next
  }
  return blocks.find((text) => /通过本章学习|使学生/.test(text)) ?? ''
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
