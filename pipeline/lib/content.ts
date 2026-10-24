import type { ContentBlock } from '@learning-agent/shared'
import { cleanText, sha1Short } from './text.ts'
import type { BodySection, OfficialKpRow } from './types.ts'

function isKeywordLine(text: string): boolean {
  return /^关键词\s*[：:]/.test(text.trim())
}

function isShortFragment(block: ContentBlock): boolean {
  const text = block.text.trim()
  return text.length < 20 && !/[。！？!?；;]/.test(text)
}

export interface ContentBlockMapping {
  oldId: string
  canonicalId: string
  reason: 'fragment' | 'keyword'
}

export interface ContentBlockNormalization {
  blocks: ContentBlock[]
  mapping: ContentBlockMapping[]
}

/**
 * Turn parser fragments into teachable blocks: keyword-only lines are metadata,
 * short headings merge into their section's paragraphs, and the old fragment ids
 * come back in `mapping` so persisted citations stay resolvable.
 */
export function normalizeContentBlocksWithMap(blocks: ContentBlock[]): ContentBlockNormalization {
  const groups = new Map<string, ContentBlock[]>()
  for (const block of blocks) {
    const key = `${block.chapter_id}|${block.section_id}`
    const group = groups.get(key) ?? []
    group.push(block)
    groups.set(key, group)
  }
  const output: ContentBlock[] = []
  const mapping: ContentBlockMapping[] = []
  for (const group of groups.values()) {
    const keywordBlocks = group.filter((block) => isKeywordLine(block.text))
    const content = group.filter((block) => !isKeywordLine(block.text))
    const fragments = content.filter(isShortFragment)
    const targets = content.filter((block) => !isShortFragment(block))
    if (targets.length === 0) {
      output.push(...content)
      continue
    }
    const paragraphTargets = targets.filter((block) => block.block_type === 'paragraph')
    const mergeTargets = (paragraphTargets.length > 0 ? paragraphTargets : targets)
      .slice()
      .sort((left, right) => right.text.length - left.text.length || left.id.localeCompare(right.id))
    const primaryTarget = mergeTargets[0]!
    for (const keyword of keywordBlocks) {
      mapping.push({ oldId: keyword.id, canonicalId: primaryTarget.id, reason: 'keyword' })
    }
    const additions = new Map<string, string[]>()
    fragments
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .forEach((fragment, index) => {
        const target = mergeTargets[index % mergeTargets.length]!
        const list = additions.get(target.id) ?? []
        list.push(fragment.text.trim())
        additions.set(target.id, list)
        mapping.push({ oldId: fragment.id, canonicalId: target.id, reason: 'fragment' })
      })
    for (const target of targets) {
      const prefix = additions.get(target.id)
      output.push(
        prefix && prefix.length > 0
          ? { ...target, text: [...prefix, target.text.trim()].join('\n') }
          : target,
      )
    }
  }
  return {
    blocks: output.sort((left, right) => {
      const chapterDiff = left.chapter_id.localeCompare(right.chapter_id)
      if (chapterDiff !== 0) return chapterDiff
      const sectionDiff = left.section_id.localeCompare(right.section_id)
      if (sectionDiff !== 0) return sectionDiff
      const typeRank = { table: 0, paragraph: 1, figure: 2, exercise: 3, case_fragment: 4 }
      const typeDiff = typeRank[left.block_type] - typeRank[right.block_type]
      if (typeDiff !== 0) return typeDiff
      return left.id.localeCompare(right.id)
    }),
    mapping,
  }
}

export function normalizeContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return normalizeContentBlocksWithMap(blocks).blocks
}

export function buildContentBlocks(params: {
  chapterId: string
  chapterNumber: number
  sourcePath: string
  bodySections: BodySection[]
  officialRows: OfficialKpRow[]
  frameworkText?: string
  frameworkSource?: string
}): ContentBlock[] {
  const { chapterId, chapterNumber, sourcePath, bodySections, officialRows } = params
  const sectionPrefix = `ch${chapterNumber}_s`
  const blocks: ContentBlock[] = []
  const officialByName = new Map(officialRows.map((row) => [row.name, row]))
  let index = 0

  const push = (
    sectionId: string,
    blockType: ContentBlock['block_type'],
    text: string,
    source: string,
    page?: number,
  ): void => {
    const trimmed = cleanText(text)
    if (!trimmed) return
    const id = `cb_${sha1Short(`${chapterId}|${sectionId}|${blockType}|${index}|${trimmed}`, 12)}`
    const block: ContentBlock = {
      id,
      chapter_id: chapterId,
      section_id: sectionId,
      block_type: blockType,
      text: trimmed,
      source,
      rights: 'internal-course-use',
    }
    if (page !== undefined) block.page = page
    blocks.push(block)
    index++
  }

  if (officialRows.length > 0) {
    const header = '序号 | 知识点 | 页码 | 教材章节'
    const rows = officialRows.map(
      (row) => `${row.number} | ${row.name} | ${row.pageLabel} | 第${row.sectionNumber}节`,
    )
    push(
      `${sectionPrefix}${officialRows[0]?.sectionNumber ?? 1}`,
      'table',
      [header, ...rows].join('\n'),
      sourcePath,
    )
  }

  for (const section of bodySections) {
    const sectionId = `${sectionPrefix}${section.sectionNumber ?? 1}`
    const page = section.matchedOfficialName
      ? officialByName.get(section.matchedOfficialName)?.page
      : undefined
    for (const paragraph of section.paragraphs) {
      if (isKeywordLine(paragraph)) continue
      push(sectionId, 'paragraph', paragraph, sourcePath, page)
    }
  }

  if (params.frameworkText && params.frameworkSource) {
    push(`${sectionPrefix}1`, 'figure', params.frameworkText, params.frameworkSource)
  }

  return normalizeContentBlocks(blocks)
}
