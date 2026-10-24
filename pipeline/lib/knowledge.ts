import type { KnowledgePoint } from '@learning-agent/shared'
import {
  bigramSimilarity,
  cleanText,
  matchScore,
  normalizeName,
  oneLine,
  pageFromLabel,
  sectionNumberFromLabel,
  slugify,
  splitKeywords,
  stripLeadingNumber,
  unique,
} from './text.ts'
import type { BodySection, OfficialKpRow, ParsedDocument } from './types.ts'

export interface LegacyKpRecord {
  kp_id: string
  name: string
  name_en?: string
  chapter?: string
  section?: string
  unit_id?: string
  parent_id?: string | null
  definition?: string
  examples?: string[]
  non_examples?: string[]
  aliases?: string[]
  prerequisites?: string[]
  difficulty?: number
  competencies?: string[]
  decisions?: string[]
  status?: string
}

export interface KnowledgeBuildResult {
  knowledgePoints: KnowledgePoint[]
  bodySections: BodySection[]
  officialCount: number
  granularCount: number
  warnings: string[]
}

const DOMAIN_TOKENS = [
  '参照群体',
  '社会阶层',
  '亚文化',
  '生活方式',
  '感觉和知觉',
  '自我概念',
  '消费者市场',
  '消费者行为',
  '购买行为',
  '购买决策',
  '情境因素',
  '文化因素',
  '社会因素',
  '个人因素',
  '心理因素',
  '数智消费者',
  '知觉',
  '情感',
  '情境',
  '文化',
  '社会',
  '个人',
  '心理',
  '角色',
  '家庭',
  '动机',
  '需要',
  '学习',
  '信念',
  '态度',
  '群体',
  '忠诚',
  '隐私',
  '算法',
  '品牌',
  '渠道',
  '定价',
  '促销',
  '产品',
  '服务',
  '价值',
  '满意',
]

export function extractOfficialRows(doc: ParsedDocument): OfficialKpRow[] {
  const tables = collectTables(doc)
  for (const rows of tables) {
    const headerIndex = rows.findIndex((row) => {
      const joined = row.join(' ')
      return joined.includes('序号') && /知\s*识\s*点/.test(joined)
    })
    if (headerIndex >= 0) {
      return rows
        .slice(headerIndex + 1)
        .map(parseOfficialRow)
        .filter((row): row is OfficialKpRow => row !== undefined)
    }
  }

  const fallbackRows = doc.blocks
    .filter((block) => block.kind === 'table_row' && block.cells)
    .map((block) => parseOfficialRow(block.cells ?? []))
    .filter((row): row is OfficialKpRow => row !== undefined)
  return dedupeOfficialRows(fallbackRows)
}

function collectTables(doc: ParsedDocument): string[][][] {
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
  return tables
}

function parseOfficialRow(cells: string[]): OfficialKpRow | undefined {
  if (cells.length < 4) return undefined
  const numberText = oneLine(cells[0] ?? '')
  if (!/^\d+$/.test(numberText)) return undefined
  const number = Number(numberText)
  const name = stripLeadingNumber(cells[1] ?? '').replace(/\s+/g, '')
  if (!name || /序号|知识点/.test(name)) return undefined
  const pageLabel = oneLine(cells[2] ?? '')
  return {
    number,
    name,
    page: pageFromLabel(pageLabel),
    pageLabel,
    sectionNumber: sectionNumberFromLabel(cells[3] ?? '') ?? 1,
  }
}

function dedupeOfficialRows(rows: OfficialKpRow[]): OfficialKpRow[] {
  const seen = new Set<string>()
  const result: OfficialKpRow[] = []
  for (const row of rows) {
    const key = `${row.number}|${normalizeName(row.name)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(row)
  }
  return result.sort((left, right) => left.number - right.number)
}

export function extractBodySections(doc: ParsedDocument, officialRows: OfficialKpRow[]): BodySection[] {
  const blocks = doc.blocks.filter((block) => block.kind !== 'table' && block.kind !== 'table_row')
  const officialNames = new Set(officialRows.map((row) => normalizeName(row.name)))
  const sections: BodySection[] = []
  let current: BodySection | undefined

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (!block) continue
    const text = oneLine(block.text)
    if (!text) continue
    if (/^第\s*\d+\s*章/.test(text)) continue
    if (/^(序号|知\s*识\s*点)/.test(text)) continue
    if (/^(关键词|答案|解析|知识点|难度级别|难度)\s*[：:]/.test(text)) {
      if (current) current.paragraphs.push(text)
      continue
    }

    const nextText = oneLine(blocks[index + 1]?.text ?? '')
    const numbered = /^\d+\s*[.、．]\s*/.test(text)
    const followedByKeywords = /^关键词\s*[：:]/.test(nextText)
    const heading =
      text.length <= 80 &&
      (Boolean(block.bold) ||
        numbered ||
        followedByKeywords ||
        officialNames.has(normalizeName(text)))

    if (heading) {
      if (current) sections.push(finalizeBodySection(current))
      current = {
        order: sections.length + 1,
        name: stripLeadingNumber(text).replace(/[：:]\s*$/, '').trim(),
        definition: '',
        paragraphs: [],
        keywords: [],
      }
      continue
    }

    if (current) current.paragraphs.push(text)
  }
  if (current) sections.push(finalizeBodySection(current))
  return sections.filter((section) => section.name.length > 0)
}

function finalizeBodySection(section: BodySection): BodySection {
  const keywords: string[] = []
  const content: string[] = []
  for (const paragraph of section.paragraphs) {
    if (/^关键词\s*[：:]/.test(paragraph)) {
      keywords.push(...splitKeywords(paragraph))
    } else {
      content.push(paragraph)
    }
  }
  section.keywords = unique(keywords)
  section.definition = pickDefinition(content)
  return section
}

function pickDefinition(paragraphs: string[]): string {
  const substantial = paragraphs.find(
    (paragraph) =>
      paragraph.length >= 20 &&
      (/[。！？]$/.test(paragraph) || /是指|指的是|是为|定义为/.test(paragraph)),
  )
  if (substantial) return substantial
  const medium = paragraphs.find((paragraph) => paragraph.length >= 12)
  if (medium) return medium
  if (paragraphs.length > 0) return paragraphs.slice(0, 4).join('；')
  return ''
}

export function buildChapterKnowledge(params: {
  chapterNumber: number
  chapterId: string
  sourcePath: string
  kpDoc: ParsedDocument
  officialRows: OfficialKpRow[]
  legacyRecords: LegacyKpRecord[]
  legacySource: string
}): KnowledgeBuildResult {
  const { chapterNumber, chapterId, sourcePath, kpDoc, officialRows, legacyRecords, legacySource } = params
  const warnings: string[] = []
  const bodySections = extractBodySections(kpDoc, officialRows)
  const sectionPrefix = `ch${chapterNumber}_s`
  const legacyById = new Map(legacyRecords.map((record) => [record.kp_id, record]))
  const officialByNorm = new Map(officialRows.map((row) => [normalizeName(row.name), row]))
  const usedIds = new Set<string>()

  for (const row of officialRows) {
    const legacyMatch = findLegacyMatch(row.name, legacyRecords)
    row.id = uniqueId(
      legacyMatch?.kp_id ?? `kp_${chapterId}_${slugify(row.name)}`,
      usedIds,
    )
  }

  const matchedBody = new Map<string, BodySection[]>()
  const unmatchedBody: BodySection[] = []
  for (const section of bodySections) {
    const official = matchOfficial(section.name, officialRows, legacyRecords, legacyById)
    if (official) {
      const officialId = official.id ?? official.name
      section.sectionNumber = official.sectionNumber
      section.matchedOfficialId = officialId
      section.matchedOfficialName = official.name
      const list = matchedBody.get(officialId) ?? []
      list.push(section)
      matchedBody.set(officialId, list)
    } else {
      unmatchedBody.push(section)
    }
  }

  const knowledgePoints: KnowledgePoint[] = []

  for (const row of officialRows) {
    const legacyMatch = findLegacyMatch(row.name, legacyRecords)
    const id = row.id ?? uniqueId(`kp_${chapterId}_${slugify(row.name)}`, usedIds)
    const sections = matchedBody.get(id) ?? []
    const bodyDefinitions = unique(sections.map((section) => section.definition).filter(Boolean))
    const bodyKeywords = unique(sections.flatMap((section) => section.keywords))
    const legacyDefinition = legacyMatch?.definition?.trim() ?? ''
    const definition =
      bodyDefinitions.join('\n') ||
      legacyDefinition ||
      (row.pageLabel ? `本章知识点：${row.name}（教材${row.pageLabel}）。` : `本章知识点：${row.name}。`)

    knowledgePoints.push({
      id,
      chapter_id: chapterId,
      section_id: `${sectionPrefix}${row.sectionNumber}`,
      name: row.name,
      name_en: legacyMatch?.name_en ?? '',
      definition,
      keywords: bodyKeywords,
      examples: legacyMatch?.examples ?? [],
      non_examples: legacyMatch?.non_examples ?? [],
      aliases: legacyMatch?.aliases ?? [],
      difficulty: clampDifficulty(legacyMatch?.difficulty ?? 2, 4),
      competencies: legacyMatch?.competencies ?? [],
      decisions: legacyMatch?.decisions ?? [],
      source: sourcePath,
      status: 'reviewed',
      parent_id: null,
    })
    if (!bodyDefinitions.length && !legacyDefinition) {
      warnings.push(`official knowledge point has no body definition: ${row.name}`)
    }
  }

  let previousSection = officialRows[0]?.sectionNumber ?? 1
  for (const section of bodySections) {
    if (section.matchedOfficialId) {
      previousSection = section.sectionNumber ?? previousSection
      continue
    }
    section.sectionNumber = previousSection
  }

  let draftCount = 0
  for (const section of unmatchedBody) {
    const id = uniqueId(`kp_${chapterId}_${slugify(section.name)}`, usedIds)
    knowledgePoints.push({
      id,
      chapter_id: chapterId,
      section_id: `${sectionPrefix}${section.sectionNumber ?? 1}`,
      name: section.name,
      name_en: '',
      definition: section.definition || section.name,
      keywords: section.keywords,
      examples: [],
      non_examples: [],
      aliases: [],
      difficulty: 2,
      competencies: [],
      decisions: [],
      source: sourcePath,
      status: 'draft',
      parent_id: null,
    })
    draftCount++
  }

  let legacyCount = 0
  for (const record of legacyRecords) {
    const official = officialForLegacy(record, officialRows, legacyById)
    const exactOfficial = officialByNorm.get(normalizeName(record.name))
    // The official table already owns this concept; emitting a second row is
    // what created the ch04 same-name duplicates.
    if (exactOfficial) continue
    const parentId = official?.id ?? null
    const id = uniqueId(record.kp_id, usedIds)
    const sectionNumber = sectionNumberFromUnit(record.unit_id) ?? official?.sectionNumber ?? 1
    knowledgePoints.push({
      id,
      chapter_id: chapterId,
      section_id: `${sectionPrefix}${sectionNumber}`,
      name: record.name,
      name_en: record.name_en ?? '',
      definition: record.definition?.trim() || record.name,
      keywords: [],
      examples: record.examples ?? [],
      non_examples: record.non_examples ?? [],
      aliases: record.aliases ?? [],
      difficulty: clampDifficulty(record.difficulty ?? 2, 4),
      competencies: record.competencies ?? [],
      decisions: record.decisions ?? [],
      source: legacySource,
      status: 'draft',
      parent_id: parentId,
    })
    legacyCount++
  }

  if (officialRows.length === 0) {
    warnings.push('no official knowledge point table rows parsed')
  }
  if (legacyRecords.length > 0) {
    warnings.push(`merged ${legacyRecords.length} legacy granular knowledge points from ${legacySource}`)
  }

  return {
    knowledgePoints: dedupeKnowledgePoints(knowledgePoints),
    bodySections,
    officialCount: officialRows.length,
    granularCount: legacyCount + draftCount,
    warnings,
  }
}

function matchOfficial(
  name: string,
  officialRows: OfficialKpRow[],
  legacyRecords: LegacyKpRecord[],
  legacyById: Map<string, LegacyKpRecord>,
): OfficialKpRow | undefined {
  const exact = officialRows.find((row) => normalizeName(row.name) === normalizeName(name))
  if (exact) return exact

  const direct = bestOfficial(name, officialRows, 0.78)
  if (direct) return direct

  let bestLegacy: LegacyKpRecord | undefined
  let bestTokenLength = 0
  const normalized = normalizeName(name)
  for (const record of legacyRecords) {
    const tokens = DOMAIN_TOKENS.filter((token) => record.name.includes(token))
    for (const token of tokens) {
      if (normalized.includes(normalizeName(token)) && token.length > bestTokenLength) {
        bestTokenLength = token.length
        bestLegacy = record
      }
    }
  }
  if (bestLegacy) {
    const official = officialForLegacy(bestLegacy, officialRows, legacyById)
    if (official) return official
  }

  return bestOfficial(name, officialRows, 0.45)
}

function bestOfficial(
  name: string,
  officialRows: OfficialKpRow[],
  threshold: number,
): OfficialKpRow | undefined {
  let best: OfficialKpRow | undefined
  let bestScore = 0
  for (const row of officialRows) {
    const score = Math.max(matchScore(name, row.name), bigramSimilarity(name, row.name))
    if (score > bestScore) {
      bestScore = score
      best = row
    }
  }
  return bestScore >= threshold ? best : undefined
}

function findLegacyMatch(name: string, legacyRecords: LegacyKpRecord[]): LegacyKpRecord | undefined {
  const exact = legacyRecords.find((record) => normalizeName(record.name) === normalizeName(name))
  if (exact) return exact
  let best: LegacyKpRecord | undefined
  let bestScore = 0
  for (const record of legacyRecords) {
    const score = matchScore(name, record.name)
    if (score > bestScore) {
      bestScore = score
      best = record
    }
  }
  return bestScore >= 0.7 ? best : undefined
}

function officialForLegacy(
  record: LegacyKpRecord,
  officialRows: OfficialKpRow[],
  legacyById: Map<string, LegacyKpRecord>,
): OfficialKpRow | undefined {
  const sectionNumber = sectionNumberFromUnit(record.unit_id)
  const direct = bestOfficial(record.name, officialRows, 0.7)
  const parent = parentOfficialForLegacy(record, officialRows, legacyById)

  if (direct) {
    if (
      sectionNumber !== undefined &&
      direct.sectionNumber !== sectionNumber &&
      parent?.sectionNumber === sectionNumber
    ) {
      return parent
    }
    return direct
  }
  if (parent && (sectionNumber === undefined || parent.sectionNumber === sectionNumber)) {
    return parent
  }
  if (sectionNumber !== undefined) {
    return officialRows.find((row) => row.sectionNumber === sectionNumber)
  }
  return parent
}

function parentOfficialForLegacy(
  record: LegacyKpRecord,
  officialRows: OfficialKpRow[],
  legacyById: Map<string, LegacyKpRecord>,
): OfficialKpRow | undefined {
  let current = record.parent_id ? legacyById.get(record.parent_id) : undefined
  const visited = new Set<string>()
  while (current && !visited.has(current.kp_id)) {
    visited.add(current.kp_id)
    const official = bestOfficial(current.name, officialRows, 0.7)
    if (official) return official
    current = current.parent_id ? legacyById.get(current.parent_id) : undefined
  }
  return undefined
}

function sectionNumberFromUnit(unitId: string | undefined): number | undefined {
  if (!unitId) return undefined
  const match = /_s(\d+)$/.exec(unitId)
  if (!match) return undefined
  const number = Number(match[1])
  return Number.isInteger(number) && number > 0 ? number : undefined
}

function uniqueId(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) {
    used.add(candidate)
    return candidate
  }
  let index = 2
  while (used.has(`${candidate}_${index}`)) index++
  const id = `${candidate}_${index}`
  used.add(id)
  return id
}

function clampDifficulty(value: number, max: number): number {
  if (!Number.isFinite(value)) return 2
  return Math.min(max, Math.max(1, Math.round(value)))
}

function dedupeKnowledgePoints(points: KnowledgePoint[]): KnowledgePoint[] {
  const statusRank: Record<string, number> = { published: 3, reviewed: 2, draft: 1 }
  const seenIds = new Set<string>()
  const byName = new Map<string, KnowledgePoint>()
  const result: KnowledgePoint[] = []
  for (const point of points) {
    if (seenIds.has(point.id)) continue
    seenIds.add(point.id)
    const key = `${point.chapter_id}|${normalizeName(point.name)}`
    const existing = byName.get(key)
    if (!existing) {
      byName.set(key, point)
      result.push(point)
      continue
    }
    const replace = (statusRank[point.status] ?? 0) > (statusRank[existing.status] ?? 0)
    const canonical = replace ? point : existing
    const other = replace ? existing : point
    canonical.aliases = unique([
      ...canonical.aliases,
      other.id,
      ...(other.name !== canonical.name ? [other.name] : []),
      ...other.aliases,
    ].filter((alias) => alias !== canonical.name))
    canonical.keywords = unique([...canonical.keywords, ...other.keywords])
    canonical.examples = unique([...canonical.examples, ...other.examples])
    canonical.non_examples = unique([...canonical.non_examples, ...other.non_examples])
    canonical.competencies = unique([...canonical.competencies, ...other.competencies])
    canonical.decisions = unique([...canonical.decisions, ...other.decisions])
    if (!canonical.definition.trim()) canonical.definition = other.definition
    canonical.parent_id ??= other.parent_id ?? null
    if (replace) {
      const at = result.indexOf(existing)
      if (at >= 0) result[at] = canonical
    }
    byName.set(key, canonical)
  }
  return result
}

export function cleanLegacyRecord(value: unknown): LegacyKpRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.kp_id !== 'string' || typeof record.name !== 'string') return undefined
  return {
    kp_id: record.kp_id,
    name: cleanText(record.name),
    name_en: typeof record.name_en === 'string' ? record.name_en : '',
    chapter: typeof record.chapter === 'string' ? record.chapter : undefined,
    section: typeof record.section === 'string' ? record.section : undefined,
    unit_id: typeof record.unit_id === 'string' ? record.unit_id : undefined,
    parent_id: typeof record.parent_id === 'string' ? record.parent_id : null,
    definition: typeof record.definition === 'string' ? record.definition : '',
    examples: Array.isArray(record.examples) ? record.examples.filter((item): item is string => typeof item === 'string') : [],
    non_examples: Array.isArray(record.non_examples)
      ? record.non_examples.filter((item): item is string => typeof item === 'string')
      : [],
    aliases: Array.isArray(record.aliases)
      ? record.aliases.filter((item): item is string => typeof item === 'string')
      : [],
    prerequisites: Array.isArray(record.prerequisites)
      ? record.prerequisites.filter((item): item is string => typeof item === 'string')
      : [],
    difficulty: typeof record.difficulty === 'number' ? record.difficulty : 2,
    competencies: Array.isArray(record.competencies)
      ? record.competencies.filter((item): item is string => typeof item === 'string')
      : [],
    decisions: Array.isArray(record.decisions)
      ? record.decisions.filter((item): item is string => typeof item === 'string')
      : [],
    status: typeof record.status === 'string' ? record.status : 'draft',
  }
}
