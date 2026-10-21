import type { Context } from '@deepseek-ai/cordis'
import type { KnowledgePoint } from '@learning-agent/shared'
import type { ReadLedger } from './types.js'

/**
 * 关键词要拆开匹配：模型习惯一次给「选择性注意 选择性理解」，整串做子串匹配永远命中不了，
 * 它就会换着词反复试，一路把轮次耗光。
 */
export function keywordTerms(keyword: string): string[] {
  return keyword.split(/[\s,，、;；/|]+/).map((term) => term.trim()).filter((term) => term.length >= 2)
}

export function matchesTerms(text: string, terms: string[]): boolean {
  if (terms.length === 0) return true
  return terms.some((term) => text.includes(term))
}

export function sectionTitle(context: Context, chapterId: string, sectionId: string): string {
  return context.learningDb.listSections(chapterId).find((section) => section.id === sectionId)?.title ?? sectionId
}

export function chapterTitle(context: Context, chapterId: string): string {
  return context.learningDb.listChapters().find((chapter) => chapter.id === chapterId)?.title ?? chapterId
}

/** Resolve a knowledge point by id, exact name, or name substring. */
export function findKp(context: Context, chapterId: string, query: string): KnowledgePoint | undefined {
  const byId = context.learningDb.getKp(query)
  if (byId) return byId
  const points = context.learningDb.listKpsByChapter(chapterId)
  const exact = points.find((point) => point.name === query)
  if (exact) return exact
  const lower = query.toLowerCase()
  return points.find((point) => point.name.toLowerCase().includes(lower))
    ?? points.find((point) => point.aliases.some((alias) => alias.toLowerCase().includes(lower)))
}

export function kpLine(context: Context, point: KnowledgePoint): string {
  return `- ${point.name}（${sectionTitle(context, point.chapter_id, point.section_id)}）：${point.definition}`
}

/**
 * 代码先按任务文本把本章相关知识点和原文备好，就不必用 5–6 轮 LLM 一轮读一个。
 * 读工具仍然保留，材料不够时自己补。
 *
 * 这是「把材料摆到手边」，不是「替模型判断要不要产物」：备好了它也可以不写。
 */
export function prefetchMaterial(
  ctx: Context,
  chapterId: string,
  task: string,
  reads?: ReadLedger,
  coverage = 6,
): { text: string; names: string[]; keys: string[] } {
  if (chapterId.length === 0 || task.length === 0) return { text: '', names: [], keys: [] }
  const keys: string[] = []
  const points = ctx.learningDb.listKpsByChapter(chapterId)
  const named = points
    .filter((point) => task.includes(point.name) || point.aliases.some((alias) => alias.length >= 2 && task.includes(alias)))
  // 任务里没点名具体概念（例如「出 3 道消费者行为的题」）时，给本章主干概念兜底，
  // 就不用先花两轮把整章读一遍。
  const hit = (named.length > 0 ? named : points).slice(0, coverage)
  const blocks = ctx.learningDb.listBlocks(chapterId)
  const byId = new Map(blocks.map((block) => [block.id, block]))
  const tags = ctx.learningDb.listContentTags({ chapterId, limit: 100000 })
  const used = new Set<string>()
  const sections: string[] = []
  for (const point of hit) {
    reads?.kps.add(point.name)
    keys.push(`kp:${point.name}`)
    const lines = [`## ${point.name}`, `定义：${point.definition}`]
    if (point.aliases.length > 0) lines.push(`别名：${point.aliases.join('、')}`)
    if (point.examples.length > 0) lines.push(`教材例子：${point.examples.join('；')}`)
    let taken = 0
    for (const tag of tags.filter((item) => item.tag_key === point.id || item.tag_key === point.name)) {
      if (taken >= 2) break
      const block = byId.get(tag.block_id)
      if (!block || used.has(block.id)) continue
      used.add(block.id)
      taken += 1
      reads?.blocks.add(block.id)
      keys.push(`block:${block.id}`)
      // 给整段原文并带上块 id：要引证据时直接引这段，不必再调 read_textbook。
      lines.push(`原文（blockId: ${block.id}）：${block.text}`)
    }
    sections.push(lines.join('\n'))
  }
  return { text: sections.join('\n\n'), names: hit.map((point) => point.name), keys }
}
