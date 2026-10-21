import { PageContentSchema, QuestionSetContentSchema } from '@learning-agent/shared'
import type { Context } from '@deepseek-ai/cordis'
import { asString, asStringArray, collect, sourceRefsOf, type ArtifactSpec } from '../artifacts.js'
import type { ToolSpec } from './types.js'

/**
 * 模型只认知识点中文名，不知道 `kp_*` 这类内部 id。让工具自己翻译：
 * 存进去的是 id，模型说的是人话，谁也不欠谁的。
 */
function resolveKpIds(context: Context, chapterId: string, value: unknown): string[] {
  const points = context.learningDb.listKpsByChapter(chapterId)
  const ids = new Set(points.map((point) => point.id))
  const byName = new Map<string, string>()
  for (const point of points) {
    byName.set(point.name, point.id)
    for (const alias of point.aliases) byName.set(alias, point.id)
  }
  const resolved = asStringArray(value)
    .map((item) => (ids.has(item) ? item : byName.get(item.trim()) ?? ''))
    .filter((item) => item.length > 0)
  return [...new Set(resolved)]
}

/**
 * 默认产物：模型直接写成页面。
 * 好不好在「怎么组织、怎么举例、怎么排版才讲得清」，那是模型擅长、模板不擅长的事。
 */
const PAGE: ArtifactSpec = {
  type: 'page',
  format: 'html',
  schemaVersion: 'Page@1',
  schema: PageContentSchema,
  extract(args) {
    const html = asString(args.html)
    const title = asString(args.title).trim() || '页面'
    return { title, content: { title, html }, body: html, sourceRefs: sourceRefsOf(args) }
  },
  // 分几次写时按顺序拼片段；模型只写正文片段，不重复写外框。
  merge(current, incoming) {
    const parts = [asString(current.html), asString(incoming.html)].filter((part) => part.length > 0)
    return { ...current, html: parts.join('\n') }
  },
}

/**
 * 唯一的例外：产物要嵌进我们的交互，学生要在里面作答，作答还要被批改、
 * 记成证据、进题库去重。这些是数据，不是页面，所以必须结构化。
 */
const QUESTION_SET: ArtifactSpec = {
  type: 'question_set',
  format: 'docx',
  schemaVersion: 'QuestionSet@1',
  schema: QuestionSetContentSchema,
  extract(args) {
    const raw = args.content && typeof args.content === 'object' ? args.content as Record<string, unknown> : {}
    const questions = Array.isArray(raw.questions) ? raw.questions : []
    const content = {
      ...raw,
      questions: questions.map((item, index) => {
        const question = (item ?? {}) as Record<string, unknown>
        const difficulty = Number(question.difficulty)
        return {
          ...question,
          id: asString(question.id) || `q${index + 1}`,
          type: asString(question.type) || '单选',
          stem: asString(question.stem),
          options: asStringArray(question.options),
          answer: asString(question.answer),
          explanation: asString(question.explanation),
          kpIds: asStringArray(question.kpIds),
          difficulty: Number.isFinite(difficulty) && difficulty >= 1 ? Math.round(difficulty) : 2,
        }
      }),
    }
    return {
      title: asString(args.title).trim() || '题目集',
      content,
      body: asString(args.markdown),
      sourceRefs: sourceRefsOf(args),
    }
  },
  merge(current, incoming) {
    const merged = [...(Array.isArray(current.questions) ? current.questions : [])] as Array<Record<string, unknown>>
    const seen = new Set(merged.map((item) => String(item.stem ?? '').replace(/\s+/g, '').slice(0, 60)))
    for (const item of Array.isArray(incoming.questions) ? incoming.questions : []) {
      const question = (item ?? {}) as Record<string, unknown>
      const key = String(question.stem ?? '').replace(/\s+/g, '').slice(0, 60)
      if (key.length > 0 && seen.has(key)) continue
      seen.add(key)
      merged.push({ ...question, id: `q${merged.length + 1}` })
    }
    return { ...current, ...incoming, questions: merged }
  },
}

/** 写产物的工具。只有两个：一份页面，一份题目集。 */
export const WRITE_TOOLS: ToolSpec[] = [
  {
    name: 'write_page',
    kind: 'write',
    description: [
      '写一份给学生看的 HTML 页面，本轮结束时出现在右栏。',
      '讲清一个概念、精讲一个案例、分析一条新闻、一份研究设计、一份 BP 大纲、一张成长卡——都用它。',
      '内容长了分 2–3 次调用，每次写一段 <section>…</section> 片段，系统按顺序拼接；不要重复写 <html>/<head>/<body> 外框，也不要整份重写。',
      '硬约束：单文件、内联样式；不写 <script>；不引外部 CSS/JS/字体/图片链接；最窄按 320px 排版、不许横向滚动；浅底深字；不要再写一个 <h1> 重复文档头的标题。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '标题，右栏文档头显示它' },
        html: { type: 'string', description: '页面正文的 HTML 片段（内联样式）' },
        sourceRefs: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：来源 id 列表（新闻 id、知识点 id、教材块 id）',
        },
      },
      required: ['html'],
    },
    execute: (args, turn) => collect(turn.emit, PAGE, args),
  },
  {
    name: 'emit_question_set',
    kind: 'write',
    description: [
      '写一份题目集（结构化，学生要在这里作答、交卷、被批改），本轮结束时出现在右栏。',
      '内容长了分 2–3 次调用，一次写 3–5 道；系统按题干合并去重，不要整份重写。',
      '结构：{ intro, questions: [{ id, type, stem, options, answer, explanation, kpIds, difficulty }] }。',
      '每道题都要标 kpIds（知识点中文名，系统会自己转成内部 id）与 difficulty（1 基础 / 2 应用 / 3 挑战），options 只写选项文字，不要带「A.」前缀。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '产物标题' },
        content: { type: 'object', description: '题目集内容，结构见工具说明' },
        markdown: { type: 'string', description: '可选：导出用的 Markdown 正文' },
        sourceRefs: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：来源 id 列表',
        },
      },
      required: ['content'],
    },
    execute(args, turn) {
      const content = args.content && typeof args.content === 'object' ? args.content as Record<string, unknown> : {}
      const questions = Array.isArray(content.questions) ? content.questions : []
      return collect(turn.emit, QUESTION_SET, {
        ...args,
        content: {
          ...content,
          questions: questions.map((item) => {
            const question = (item ?? {}) as Record<string, unknown>
            return { ...question, kpIds: resolveKpIds(turn.ctx, turn.chapterId, question.kpIds) }
          }),
        },
      })
    },
  },
]
