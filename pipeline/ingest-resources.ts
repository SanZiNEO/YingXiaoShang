import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import pLimit from 'p-limit'
import {
  CHAPTER_TITLES,
  ChapterSchema,
  ContentBlockSchema,
  IdeologyPointSchema,
  IngestReportSchema,
  KnowledgePointSchema,
  QuestionSchema,
  SectionSchema,
  TeachingGuideSchema,
  chapterId,
} from '../packages/shared/src/index.ts'
import type {
  Chapter,
  ContentBlock,
  IdeologyPoint,
  IngestReport,
  KnowledgePoint,
  Question,
  Section,
  TeachingGuide,
} from '@learning-agent/shared'
import { parseDoc } from './lib/doc.ts'
import { parseDocx } from './lib/docx.ts'
import { buildContentBlocks } from './lib/content.ts'
import { extractIdeology } from './lib/ideology.ts'
import {
  buildChapterKnowledge,
  cleanLegacyRecord,
  extractOfficialRows,
  type KnowledgeBuildResult,
  type LegacyKpRecord,
} from './lib/knowledge.ts'
import { parsePdf } from './lib/pdf.ts'
import { extractQuestions } from './lib/questions.ts'
import { extractTeachingGuide } from './lib/teaching.ts'
import { stripLeadingNumber, unique } from './lib/text.ts'
import type { OfficialKpRow, ParsedDocument } from './lib/types.ts'

const RESOURCE_ROOT = resolve('resources/《市场营销学》（第5版）数字资源（不含课件）')
const OUTPUT_DIR = resolve('data/normalized')
const LEGACY_PATH = resolve('data/legacy/marketing_textbook/ch03-05/knowledge_points.json')
const REQUIRED_KINDS = ['kp', 'exercise', 'ideology', 'guide'] as const
const REQUIRED_LABELS: Record<RequiredKind, string> = {
  kp: '知识点与关键词',
  exercise: '习题',
  ideology: '课程思政',
  guide: '教学指南',
}
const QUESTION_TYPE_ORDER = ['名词解释', '填空', '判断', '单选', '多选', '简答', '案例分析']

type RequiredKind = (typeof REQUIRED_KINDS)[number]
type DocKind = RequiredKind | 'framework'

interface DiscoveredFiles {
  required: Record<RequiredKind, string | undefined>
  framework?: string
  all: string[]
  warnings: string[]
}

interface ChapterResult {
  chapter: Chapter
  sections: Section[]
  knowledgePoints: KnowledgePoint[]
  contentBlocks: ContentBlock[]
  questions: Question[]
  ideologyPoints: IdeologyPoint[]
  teachingGuide?: TeachingGuide
  report: IngestReport['chapters'][number]
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString()
  const legacy = await loadLegacyRecords()
  const chapterDirs = await discoverChapterDirs()
  const chapterNumbers = Array.from({ length: 13 }, (_, index) => index + 1)
  const limit = pLimit(3)

  const results = await Promise.all(
    chapterNumbers.map((number) =>
      limit(async () => {
        const dir = chapterDirs.get(number)
        if (!dir) {
          const title = CHAPTER_TITLES[number] ?? `第${number}章`
          const id = chapterId(number)
          const failed = REQUIRED_KINDS.map((kind) => expectedPath(RESOURCE_ROOT, number, kind))
          return {
            chapter: { id, number, title, source_path: resolve(RESOURCE_ROOT, `第${number}章数字资源`) },
            sections: [],
            knowledgePoints: [],
            contentBlocks: [],
            questions: [],
            ideologyPoints: [],
            report: {
              chapter_id: id,
              number,
              title,
              files: [],
              failed,
              warnings: [`chapter directory not found: 第${number}章数字资源`],
              counts: {},
            },
          } satisfies ChapterResult
        }
        return processChapter(dir, number, legacy.records, legacy.source)
      }),
    ),
  )

  const chapters = results.map((result) => result.chapter).sort((left, right) => left.number - right.number)
  const sections = results.flatMap((result) => result.sections)
  const knowledgePoints = results.flatMap((result) => result.knowledgePoints)
  for (const point of await loadCuratedKps()) {
    const at = knowledgePoints.findIndex((existing) => existing.id === point.id)
    if (at >= 0) knowledgePoints[at] = point
    else knowledgePoints.push(point)
  }
  const contentBlocks = results.flatMap((result) => result.contentBlocks)
  const questions = results.flatMap((result) => result.questions)
  const ideologyPoints = mergeIdeologyPoints(results.flatMap((result) => result.ideologyPoints))
  const teachingGuides = results
    .flatMap((result) => (result.teachingGuide ? [result.teachingGuide] : []))
    .sort((left, right) => chapterNumber(left.chapter_id) - chapterNumber(right.chapter_id))

  sortChapters(chapters, sections, knowledgePoints, contentBlocks, questions)
  validateAll(chapters, sections, knowledgePoints, contentBlocks, questions, ideologyPoints, teachingGuides)

  const failed = unique(results.flatMap((result) => result.report.failed))
  const requiredDiscovered = results.reduce(
    (sum, result) =>
      sum + REQUIRED_KINDS.filter((kind) => result.report.files.some((file) => isKindFile(file, kind))).length,
    0,
  )
  const optionalDiscovered = results.filter((result) =>
    result.report.files.some((file) => isKindFile(file, 'framework')),
  ).length
  const totals: Record<string, number> = {
    chapters: chapters.length,
    required_expected: 13 * REQUIRED_KINDS.length,
    required_documents: requiredDiscovered,
    optional_expected: 13,
    optional_documents: optionalDiscovered,
    knowledge_points: knowledgePoints.length,
    official_knowledge_points: results.reduce(
      (sum, result) => sum + (result.report.counts.official_knowledge_points ?? 0),
      0,
    ),
    granular_knowledge_points: results.reduce(
      (sum, result) => sum + (result.report.counts.granular_knowledge_points ?? 0),
      0,
    ),
    sections: sections.length,
    content_blocks: contentBlocks.length,
    questions: questions.length,
    ideology_points: ideologyPoints.length,
    teaching_guides: teachingGuides.length,
    failed_required: failed.length,
  }

  const report: IngestReport = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    chapters: results
      .map((result) => result.report)
      .sort((left, right) => left.number - right.number),
    totals,
    failed,
  }
  IngestReportSchema.parse(report)

  await mkdir(OUTPUT_DIR, { recursive: true })
  await writeJson('chapters.json', chapters)
  await writeJson('sections.json', sections)
  await writeJson('knowledge_points.json', knowledgePoints)
  await writeJsonl('content_blocks.jsonl', contentBlocks)
  await writeJson('questions.json', questions)
  await writeJson('ideology_points.json', ideologyPoints)
  await writeJson('teaching_guides.json', teachingGuides)
  await writeJson('ingest-report.json', report)

  printSummary(results, report, knowledgePoints, questions, ideologyPoints, contentBlocks)
  if (failed.length > 0) process.exitCode = 1
}

async function processChapter(
  dir: string,
  number: number,
  legacyRecords: LegacyKpRecord[],
  legacySource: string,
): Promise<ChapterResult> {
  const title = CHAPTER_TITLES[number] ?? `第${number}章`
  const id = chapterId(number)
  const discovered = await discoverFiles(dir, number)
  const warnings = [...discovered.warnings]
  const failed: string[] = []
  const parsed = new Map<RequiredKind, ParsedDocument>()

  for (const kind of REQUIRED_KINDS) {
    const path = discovered.required[kind]
    if (!path) {
      failed.push(expectedPath(dir, number, kind))
      warnings.push(`missing required ${REQUIRED_LABELS[kind]}: ${expectedPath(dir, number, kind)}`)
      continue
    }
    try {
      const doc = path.toLowerCase().endsWith('.docx') ? await parseDocx(path) : await parseDoc(path)
      parsed.set(kind, doc)
      warnings.push(...doc.warnings)
    } catch (error) {
      failed.push(path)
      warnings.push(`${REQUIRED_LABELS[kind]} parse failed: ${errorMessage(error)}`)
    }
  }

  let frameworkText = ''
  let frameworkSource: string | undefined
  if (discovered.framework) {
    try {
      const pdf = await parsePdf(discovered.framework)
      frameworkText = pdf.text
      frameworkSource = discovered.framework
      warnings.push(...pdf.warnings)
    } catch (error) {
      warnings.push(`optional framework PDF failed: ${discovered.framework}: ${errorMessage(error)}`)
    }
  } else {
    warnings.push('optional 知识框架图.pdf not found')
  }

  const chapter: Chapter = { id, number, title, source_path: resolve(dir) }
  const kpDoc = parsed.get('kp')
  let officialRows: OfficialKpRow[] = []
  let knowledge: KnowledgeBuildResult | undefined
  if (kpDoc) {
    officialRows = extractOfficialRows(kpDoc)
    const legacyForChapter = legacyRecords.filter((record) => legacyChapterNumber(record) === number)
    knowledge = buildChapterKnowledge({
      chapterNumber: number,
      chapterId: id,
      sourcePath: kpDoc.path,
      kpDoc,
      officialRows,
      legacyRecords: legacyForChapter,
      legacySource,
    })
    warnings.push(...knowledge.warnings)
    if (officialRows.length === 0) {
      failed.push(kpDoc.path)
      warnings.push('no official knowledge point table rows parsed')
    }
  }

  const guideDoc = parsed.get('guide')
  let teachingGuide: TeachingGuide | undefined
  if (guideDoc) {
    const guideResult = extractTeachingGuide(guideDoc, {
      chapterId: id,
      sourcePath: guideDoc.path,
      frameworkText,
    })
    teachingGuide = guideResult.guide
    warnings.push(...guideResult.warnings)
    if (
      !teachingGuide.summary &&
      teachingGuide.key_points.length === 0 &&
      teachingGuide.objectives.length === 0 &&
      teachingGuide.tasks.length === 0 &&
      !teachingGuide.framework_text
    ) {
      failed.push(guideDoc.path)
      warnings.push('teaching guide parsed empty')
    }
  }

  const exerciseDoc = parsed.get('exercise')
  let questions: Question[] = []
  if (exerciseDoc) {
    const questionResult = extractQuestions(exerciseDoc, {
      chapterId: id,
      chapterNumber: number,
      sourcePath: exerciseDoc.path,
      knowledgePoints: knowledge?.knowledgePoints ?? [],
    })
    questions = questionResult.questions
    warnings.push(...questionResult.warnings)
    if (questions.length === 0) {
      failed.push(exerciseDoc.path)
      warnings.push('no questions parsed')
    }
  }

  const ideologyDoc = parsed.get('ideology')
  let ideologyPoints: IdeologyPoint[] = []
  if (ideologyDoc) {
    const ideologyResult = extractIdeology(ideologyDoc, {
      chapterTitle: title,
      knowledgePoints: knowledge?.knowledgePoints ?? [],
    })
    ideologyPoints = ideologyResult.ideologyPoints
    warnings.push(...ideologyResult.warnings)
    if (ideologyPoints.length === 0) {
      failed.push(ideologyDoc.path)
      warnings.push('no ideology points parsed')
    }
  }

  const sections = buildSections(id, officialRows, teachingGuide, knowledge?.knowledgePoints ?? [])
  const contentBlocks = knowledge
    ? buildContentBlocks({
        chapterId: id,
        chapterNumber: number,
        sourcePath: kpDoc?.path ?? dir,
        bodySections: knowledge.bodySections,
        officialRows,
        frameworkText,
        frameworkSource,
      })
    : []

  const counts: Record<string, number> = {
    knowledge_points: knowledge?.knowledgePoints.length ?? 0,
    official_knowledge_points: knowledge?.officialCount ?? 0,
    granular_knowledge_points: knowledge?.granularCount ?? 0,
    sections: sections.length,
    content_blocks: contentBlocks.length,
    questions: questions.length,
    ideology_points: ideologyPoints.length,
    teaching_guide: teachingGuide ? 1 : 0,
    framework_pdf: frameworkSource ? 1 : 0,
    framework_text_chars: frameworkText.length,
    required_files: REQUIRED_KINDS.filter((kind) => discovered.required[kind]).length,
  }

  return {
    chapter,
    sections,
    knowledgePoints: knowledge?.knowledgePoints ?? [],
    contentBlocks,
    questions,
    ideologyPoints,
    teachingGuide,
    report: {
      chapter_id: id,
      number,
      title,
      files: discovered.all,
      failed: unique(failed),
      warnings: unique(warnings),
      counts,
    },
  }
}

function buildSections(
  id: string,
  officialRows: OfficialKpRow[],
  guide: TeachingGuide | undefined,
  knowledgePoints: KnowledgePoint[],
): Section[] {
  const titles = (guide?.summary ?? '')
    .split('\n')
    .map((item) => stripLeadingNumber(item))
    .filter(Boolean)
  const sectionNumbers = [
    ...officialRows.map((row) => row.sectionNumber),
    ...knowledgePoints.map((point) => sectionNumberFromId(point.section_id)).filter(isNumber),
  ]
  const maxSection = Math.max(1, titles.length, ...sectionNumbers)
  const sectionPrefix = `ch${chapterNumber(id)}_s`
  return Array.from({ length: maxSection }, (_, index) => {
    const number = index + 1
    const officialTitle = officialRows.find((row) => row.sectionNumber === number)?.name
    return {
      id: `${sectionPrefix}${number}`,
      chapter_id: id,
      number,
      title: titles[index] || officialTitle || `第${number}节`,
    }
  })
}

async function discoverChapterDirs(): Promise<Map<number, string>> {
  const entries = await readdir(RESOURCE_ROOT, { withFileTypes: true })
  const dirs = new Map<number, string>()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const match = /^第\s*(\d+)\s*章数字资源$/.exec(entry.name)
    if (!match) continue
    const number = Number(match[1])
    if (number >= 1 && number <= 13) dirs.set(number, join(RESOURCE_ROOT, entry.name))
  }
  return dirs
}

async function discoverFiles(dir: string, number: number): Promise<DiscoveredFiles> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(dir, entry.name))
  const warnings: string[] = []
  const required = {} as Record<RequiredKind, string | undefined>

  for (const kind of REQUIRED_KINDS) {
    const candidates = files.filter((file) => isKindFile(file, kind))
    if (candidates.length === 0) {
      required[kind] = undefined
      continue
    }
    candidates.sort((left, right) => extensionRank(left) - extensionRank(right))
    required[kind] = candidates[0]
    if (candidates.length > 1) {
      warnings.push(`multiple ${REQUIRED_LABELS[kind]} files found; using ${candidates[0]}`)
    }
  }

  const frameworkCandidates = files.filter((file) => isKindFile(file, 'framework'))
  if (frameworkCandidates.length > 1) {
    warnings.push(`multiple framework PDFs found; using ${frameworkCandidates[0]}`)
  }

  return {
    required,
    framework: frameworkCandidates[0],
    all: unique([
      ...REQUIRED_KINDS.map((kind) => required[kind]).filter((file): file is string => Boolean(file)),
      ...(frameworkCandidates[0] ? [frameworkCandidates[0]] : []),
    ]),
    warnings,
  }
}

function isKindFile(file: string, kind: DocKind): boolean {
  const name = file.replaceAll('\\', '/').split('/').pop() ?? ''
  const lower = name.toLowerCase()
  if (kind === 'framework') return /知识框架图/.test(name) && lower.endsWith('.pdf')
  if (!lower.endsWith('.doc') && !lower.endsWith('.docx')) return false
  if (kind === 'kp') return /知识点[与和]关键词/.test(name)
  if (kind === 'exercise') return /习题/.test(name)
  if (kind === 'ideology') return /课程思政/.test(name)
  if (kind === 'guide') return /教学指南/.test(name)
  return false
}

function extensionRank(file: string): number {
  return file.toLowerCase().endsWith('.docx') ? 0 : 1
}

function expectedPath(dir: string, number: number, kind: RequiredKind): string {
  return join(dir, `第${number}章 ${REQUIRED_LABELS[kind]}.docx|doc`)
}

async function loadCuratedKps(): Promise<KnowledgePoint[]> {
  const path = join(OUTPUT_DIR, 'knowledge_points.curated.json')
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
    return KnowledgePointSchema.array().parse(raw)
  } catch {
    return []
  }
}

async function loadLegacyRecords(): Promise<{ records: LegacyKpRecord[]; source: string }> {
  try {
    const raw = JSON.parse(await readFile(LEGACY_PATH, 'utf8')) as unknown
    if (!Array.isArray(raw)) return { records: [], source: LEGACY_PATH }
    const records = raw
      .map((item) => cleanLegacyRecord(item))
      .filter((item): item is LegacyKpRecord => item !== undefined)
    return { records, source: LEGACY_PATH }
  } catch {
    return { records: [], source: LEGACY_PATH }
  }
}

function legacyChapterNumber(record: LegacyKpRecord): number | undefined {
  const fromChapter = /第\s*(\d+)\s*章/.exec(record.chapter ?? '')
  if (fromChapter) return Number(fromChapter[1])
  const fromUnit = /^ch(\d+)_/.exec(record.unit_id ?? '')
  if (fromUnit) return Number(fromUnit[1])
  return undefined
}

function mergeIdeologyPoints(points: IdeologyPoint[]): IdeologyPoint[] {
  const merged = new Map<string, IdeologyPoint>()
  for (const point of points) {
    const existing = merged.get(point.id)
    if (!existing) {
      merged.set(point.id, {
        ...point,
        examples: [...point.examples],
        related_kp_ids: [...point.related_kp_ids],
      })
      continue
    }
    if (point.definition && !existing.definition.includes(point.definition)) {
      existing.definition = `${existing.definition}\n${point.definition}`.trim()
    }
    existing.examples = unique([...existing.examples, ...point.examples])
    existing.related_kp_ids = unique([...existing.related_kp_ids, ...point.related_kp_ids])
    if (!existing.source.includes(point.source)) existing.source = `${existing.source}; ${point.source}`
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
}

function sortChapters(
  chapters: Chapter[],
  sections: Section[],
  knowledgePoints: KnowledgePoint[],
  contentBlocks: ContentBlock[],
  questions: Question[],
): void {
  chapters.sort((left, right) => left.number - right.number)
  sections.sort(
    (left, right) => chapterNumber(left.chapter_id) - chapterNumber(right.chapter_id) || left.number - right.number,
  )
  knowledgePoints.sort((left, right) => {
    const chapterDiff = chapterNumber(left.chapter_id) - chapterNumber(right.chapter_id)
    if (chapterDiff !== 0) return chapterDiff
    const sectionDiff = sectionNumberFromId(left.section_id) - sectionNumberFromId(right.section_id)
    if (sectionDiff !== 0) return sectionDiff
    if (left.status !== right.status) return left.status === 'reviewed' ? -1 : 1
    return left.name.localeCompare(right.name, 'zh-CN')
  })
  contentBlocks.sort((left, right) => {
    const chapterDiff = chapterNumber(left.chapter_id) - chapterNumber(right.chapter_id)
    if (chapterDiff !== 0) return chapterDiff
    const sectionDiff = sectionNumberFromId(left.section_id) - sectionNumberFromId(right.section_id)
    if (sectionDiff !== 0) return sectionDiff
    const typeDiff = blockTypeRank(left.block_type) - blockTypeRank(right.block_type)
    if (typeDiff !== 0) return typeDiff
    return left.id.localeCompare(right.id)
  })
  questions.sort((left, right) => {
    const chapterDiff =
      chapterNumberFromSource(left.source_id) - chapterNumberFromSource(right.source_id)
    if (chapterDiff !== 0) return chapterDiff
    const typeDiff = QUESTION_TYPE_ORDER.indexOf(left.type) - QUESTION_TYPE_ORDER.indexOf(right.type)
    if (typeDiff !== 0) return typeDiff
    return left.id.localeCompare(right.id)
  })
}

function validateAll(
  chapters: Chapter[],
  sections: Section[],
  knowledgePoints: KnowledgePoint[],
  contentBlocks: ContentBlock[],
  questions: Question[],
  ideologyPoints: IdeologyPoint[],
  teachingGuides: TeachingGuide[],
): void {
  for (const chapter of chapters) ChapterSchema.parse(chapter)
  for (const section of sections) SectionSchema.parse(section)
  for (const point of knowledgePoints) KnowledgePointSchema.parse(point)
  for (const block of contentBlocks) ContentBlockSchema.parse(block)
  for (const question of questions) QuestionSchema.parse(question)
  for (const point of ideologyPoints) IdeologyPointSchema.parse(point)
  for (const guide of teachingGuides) TeachingGuideSchema.parse(guide)
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(join(OUTPUT_DIR, file), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeJsonl(file: string, values: unknown[]): Promise<void> {
  const body = values.map((value) => JSON.stringify(value)).join('\n')
  await writeFile(join(OUTPUT_DIR, file), body ? `${body}\n` : '', 'utf8')
}

function printSummary(
  results: ChapterResult[],
  report: IngestReport,
  knowledgePoints: KnowledgePoint[],
  questions: Question[],
  ideologyPoints: IdeologyPoint[],
  contentBlocks: ContentBlock[],
): void {
  console.log('Resource ingestion complete')
  console.log(`  chapters: ${report.totals.chapters}`)
  console.log(
    `  required documents: ${report.totals.required_documents}/${report.totals.required_expected} discovered`,
  )
  console.log(
    `  optional framework PDFs: ${report.totals.optional_documents}/${report.totals.optional_expected}`,
  )
  console.log(
    `  knowledge points: ${knowledgePoints.length} (official ${report.totals.official_knowledge_points}, granular ${report.totals.granular_knowledge_points})`,
  )
  console.log(`  questions: ${questions.length}`)
  console.log(`  ideology points: ${ideologyPoints.length}`)
  console.log(`  content blocks: ${contentBlocks.length}`)
  const chapter4 = results.find((result) => result.chapter.number === 4)
  if (chapter4) {
    console.log(
      `  chapter 4: official=${chapter4.report.counts.official_knowledge_points}, granular=${chapter4.report.counts.granular_knowledge_points}, questions=${chapter4.report.counts.questions}, ideology=${chapter4.report.counts.ideology_points}`,
    )
  }
  if (report.failed.length > 0) {
    console.log(`  FAILED required files (${report.failed.length}):`)
    for (const path of report.failed) console.log(`    - ${path}`)
    for (const chapter of report.chapters) {
      if (chapter.failed.length === 0) continue
      for (const warning of chapter.warnings) console.log(`    ${chapter.chapter_id}: ${warning}`)
    }
  } else {
    console.log('  required failures: 0')
  }
}

function sectionNumberFromId(id: string): number {
  const match = /_s(\d+)$/.exec(id)
  return match ? Number(match[1]) : 1
}

function chapterNumber(id: string): number {
  const match = /^ch(\d+)$/.exec(id)
  return match ? Number(match[1]) : 0
}

function chapterNumberFromSource(source: string): number {
  const match = /第\s*(\d+)\s*章/.exec(source)
  return match ? Number(match[1]) : 0
}

function blockTypeRank(type: ContentBlock['block_type']): number {
  return { table: 0, paragraph: 1, figure: 2, exercise: 3, case_fragment: 4 }[type]
}

function isNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
