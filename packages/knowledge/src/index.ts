import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@learning-agent/db'
import type { IdeologyPoint, KnowledgePoint, Question } from '@learning-agent/shared'

declare module '@deepseek-ai/cordis' {
  interface Context {
    knowledge: KnowledgeService
  }
}

export const name = 'learning-knowledge'
export const inject = ['tools', 'learningDb']

export class KnowledgeService extends Service {
  static inject = ['learningDb']

  constructor(ctx: Context) {
    super(ctx, 'knowledge')
  }

  search(query: string, chapter?: string, limit = 20): KnowledgePoint[] {
    return this.ctx.learningDb.searchKps(query, chapter, limit)
  }

  get(kpId: string): {
    knowledge_point: KnowledgePoint
    related_questions: Question[]
    ideology: IdeologyPoint[]
  } | undefined {
    const kp = this.ctx.learningDb.getKp(kpId)
    if (!kp) return undefined
    return {
      knowledge_point: kp,
      related_questions: this.ctx.learningDb.listQuestions({ kpId, limit: 20 }),
      ideology: this.ctx.learningDb
        .listIdeology()
        .filter((point) => point.related_kp_ids.includes(kpId)),
    }
  }
}

const jsonOutput = <const S extends ValueSchemaSpec>(schema: S) => ({
  schema,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
})

export function apply(ctx: Context) {
  ctx.plugin(KnowledgeService)
  ctx.tools.register(
    defineTool({
      name: 'search_knowledge',
      description: '检索教材知识点。query 为空字符串时返回该章节的全部知识点。',
      parameters: {
        query: { type: 'string', required: true },
        chapter: { type: 'string' },
        limit: { type: 'integer',  },
      },
      output: jsonOutput({
        type: 'object',
        additionalProperties: false,
        properties: {
          knowledge_points: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                chapter_id: { type: 'string' },
                section_id: { type: 'string' },
                definition: { type: 'string' },
              },
            },
          },
        },
      }),
      async execute(args) {
        const points = args.query.length === 0
          ? ctx.learningDb.searchKps('', args.chapter, args.limit ?? 20)
          : ctx.learningDb.searchKps(args.query, args.chapter, args.limit ?? 20)
        return {
          knowledge_points: points.map((point) => ({
            id: point.id,
            name: point.name,
            chapter_id: point.chapter_id,
            section_id: point.section_id,
            definition: point.definition,
          })),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'get_knowledge_point',
      description: '读取一个知识点的完整定义、相关题目和关联课程思政点。',
      parameters: {
        kp_id: { type: 'string', required: true },
      },
      output: jsonOutput({
        type: 'object',
        additionalProperties: false,
        properties: {
          knowledge_point: { type: 'object', additionalProperties: true },
          related_questions: { type: 'array', items: { type: 'object', additionalProperties: true } },
          ideology: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      }),
      async execute(args) {
        const result = ctx.knowledge.get(args.kp_id)
        if (!result) throw new Error(`knowledge point not found: ${args.kp_id}`)
        return result
      },
    }),
  )
}
