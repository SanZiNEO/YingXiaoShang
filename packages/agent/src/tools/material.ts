import type { Context } from '@deepseek-ai/cordis'
import type { KnowledgePoint } from '@learning-agent/shared'

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
