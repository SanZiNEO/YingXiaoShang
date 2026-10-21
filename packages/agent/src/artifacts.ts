import type { Context } from '@deepseek-ai/cordis'
import { type Artifact } from '@learning-agent/shared'

export interface EmitContext {
  ctx: Context
  studentId: string
  sessionId: string
  chapterId: string
  /** 本轮按类型累积；一轮结束才落库一次。 */
  pending: Map<string, PendingArtifact>
  /** 本轮写出的产物，按创建顺序。 */
  created: Artifact[]
}

interface PendingArtifact {
  spec: ArtifactSpec
  title: string
  content: Record<string, unknown>
  /**
   * 落库正文。`page` 就是 HTML 本身；结构化产物是可选的 Markdown 导出稿，
   * 没写就由系统按 JSON 兜底，保证导出的文件不是空的。
   */
  body: string
  sourceRefs: string[]
}

/**
 * 一份产物的完整契约：落库类型、格式、校验 schema、怎么从工具参数里取内容、
 * 分几次写时怎么合并。
 */
export interface ArtifactSpec {
  type: Artifact['type']
  format: Artifact['format']
  schemaVersion: string
  schema: { parse: (value: unknown) => unknown }
  extract: (args: Record<string, unknown>) => {
    title: string
    content: Record<string, unknown>
    body: string
    sourceRefs: string[]
  }
  /** 同一轮里写第二次时怎么并进已有的内容。 */
  merge?: (current: Record<string, unknown>, incoming: Record<string, unknown>) => Record<string, unknown>
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value
  return value === undefined || value === null ? '' : String(value)
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => asString(item)).filter((item) => item.length > 0)
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()]
  return []
}

function sourceRefsOf(args: Record<string, unknown>): string[] {
  return Array.isArray(args.sourceRefs)
    ? args.sourceRefs.filter((item): item is string => typeof item === 'string')
    : []
}

interface Collected {
  title: string
  content: Record<string, unknown>
  body: string
  sourceRefs: string[]
}

/**
 * 收一次写入。分几次写同一份产物时由 `merge` 合并——模型看不到已有内容，
 * 所以既不整份重写，也补不出重复条目。
 */
export function collect(emit: EmitContext, spec: ArtifactSpec, args: Record<string, unknown>): string {
  const incoming: Collected = spec.extract(args)
  const existing = emit.pending.get(spec.type)
  const content = existing && spec.merge ? spec.merge(existing.content, incoming.content) : incoming.content
  emit.pending.set(spec.type, {
    spec,
    title: incoming.title.length > 0 ? incoming.title : existing?.title ?? spec.type,
    content,
    body: incoming.body.length > 0 ? incoming.body : existing?.body ?? '',
    sourceRefs: incoming.sourceRefs.length > 0 ? incoming.sourceRefs : existing?.sourceRefs ?? [],
  })
  const count = Array.isArray(content.questions) ? content.questions.length : 0
  return count > 0
    ? `已收齐 ${spec.type}：共 ${count} 题，附件会在本轮结束时生成。本工具已关闭，下一步直接写结论，不要再调用。`
    : `已收齐 ${spec.type}，附件会在本轮结束时生成。本工具已关闭，下一步直接写结论，不要再调用。`
}

/**
 * Write every collected artifact once, after the turn's conversation ends.
 * Validation happens here so a bad payload fails loudly instead of silently
 * producing an empty card.
 */
export async function finalizeArtifacts(emit: EmitContext, warnings: string[] = []): Promise<Artifact[]> {
  const created: Artifact[] = []
  for (const pending of emit.pending.values()) {
    let contentJson: unknown
    try {
      contentJson = pending.spec.schema.parse(pending.content)
    } catch (error) {
      // A malformed artifact must not kill the turn, and the student must not
      // see raw schema errors — details go to the log only.
      console.warn(`[artifacts] ${pending.spec.type} 校验失败：${error instanceof Error ? error.message : String(error)}`)
      warnings.push(`这轮有产物没生成（${pending.spec.type}），内容不完整；可以让我重做一次。`)
      continue
    }
    const body = pending.body.length > 0
      ? pending.body
      : `# ${pending.title}\n\n\`\`\`json\n${JSON.stringify(contentJson, null, 2)}\n\`\`\`\n`
    const artifact = await emit.ctx.artifacts.create({
      studentId: emit.studentId,
      sessionId: emit.sessionId,
      skillId: 'agent',
      templateId: pending.spec.type,
      type: pending.spec.type,
      title: pending.title,
      format: pending.spec.format,
      content: body,
      contentJson,
      schemaVersion: pending.spec.schemaVersion,
      sourceRefs: pending.sourceRefs,
      evidenceIds: [],
    })
    created.push(artifact)
  }
  emit.created.push(...created)
  return created
}

export { asString, asStringArray, sourceRefsOf }
