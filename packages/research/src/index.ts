import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type LearningDb from '@learning-agent/db'
import { callStructuredTool, jsonObjectSchema } from '@learning-agent/llm-json'
import type { ResearchArtifact, ResearchProject } from '@learning-agent/shared'
import { z } from 'zod'

export const name = 'learning-research'
export const inject = ['tools', 'learningDb', 'llm']

declare module '@deepseek-ai/cordis' {
  interface Context {
    research: ResearchService
  }
}

/** Stable artifact step keys persisted through `learningDb.upsertResearchArtifact`. */
export const RESEARCH_STEP_KEYS = {
  brief: 'brief',
  method: 'method',
  sampling: 'sampling',
  questionnaire: 'questionnaire',
  interviewGuide: 'interview_guide',
  analysis: 'analysis',
  review: 'review',
} as const

export type ResearchStepKey = (typeof RESEARCH_STEP_KEYS)[keyof typeof RESEARCH_STEP_KEYS]

const RESEARCH_SYSTEM = [
  '你是市场营销调研方法教练，服务本科营销课程。',
  '你只通过指定的 emit 工具提交结构化结果；字段必须完整、可执行、可 JSON 序列化。',
  '原则：',
  '1. 先明确决策问题，再落到可回答的研究问题；方法必须与研究问题匹配。',
  '2. 每个方法、抽样、工具和分析选择都要说明取舍与风险，不能只给模板。',
  '3. 不编造数据、来源、样本量依据或受访者；无法确认的信息写入 assumptions 或标为“未说明”。',
  '4. 输出使用简体中文；专业术语可保留英文。',
].join('\n')

const RESEARCH_DEPTH_KEYS = [
  'research_question',
  'objectives',
  'method',
  'sampling',
  'questionnaire',
  'interview_guide',
  'analysis',
] as const

function objectOutput<const P extends ParameterSchemaSpec>(properties: P) {
  return { type: 'object' as const, additionalProperties: false as const, properties }
}

function jsonContent(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) ?? '' }]
}

const ResearchMethodSchema = z.enum(['qualitative', 'quantitative', 'mixed'])

const ResearchBriefSchema = z.object({
  research_question: z.string().min(1),
  objectives: z.array(z.string().min(1)).min(3),
  constraints: z.array(z.string()),
  assumptions: z.array(z.string()),
})
export type ResearchBrief = z.infer<typeof ResearchBriefSchema>

const MethodChoiceSchema = z.object({
  method: ResearchMethodSchema,
  rationale: z.string().min(1),
  alternatives: z
    .array(
      z.object({
        method: ResearchMethodSchema,
        tradeoff: z.string().min(1),
      }),
    )
    .min(2),
})
export type MethodChoice = z.infer<typeof MethodChoiceSchema>

const SamplingPlanSchema = z.object({
  sampling_frame: z.string().min(1),
  technique: z.string().min(1),
  target_size: z.number().int().positive(),
  recruitment: z.string().min(1),
  risks: z.array(z.string().min(1)).min(2),
})
export type SamplingPlan = z.infer<typeof SamplingPlanSchema>

const QuestionTypeSchema = z.enum(['open', 'single', 'multi', 'scale'])

const QuestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  type: QuestionTypeSchema,
  options: z.array(z.string().min(1)).optional(),
  scale: z
    .object({
      min: z.number().int(),
      max: z.number().int(),
      labels: z.array(z.string().min(1)),
    })
    .optional(),
})
export type ResearchQuestion = z.infer<typeof QuestionSchema>

const QuestionnaireSchema = z.object({
  questions: z.array(QuestionSchema).min(8),
})
export type Questionnaire = z.infer<typeof QuestionnaireSchema>

const InterviewGuideSchema = z.object({
  sections: z
    .array(
      z.object({
        title: z.string().min(1),
        questions: z.array(z.string().min(1)).min(2),
        probes: z.array(z.string().min(1)).min(2),
      }),
    )
    .min(3),
})
export type InterviewGuide = z.infer<typeof InterviewGuideSchema>

const AnalysisPlanSchema = z.object({
  methods: z.array(z.string().min(1)).min(2),
  steps: z.array(z.string().min(1)).min(4),
  outputs: z.array(z.string().min(1)).min(2),
  limitations: z.array(z.string().min(1)).min(2),
})
export type AnalysisPlan = z.infer<typeof AnalysisPlanSchema>

const DesignReviewSchema = z.object({
  level: z.enum(['L1', 'L2', 'L3', 'L4']),
  strengths: z.array(z.string().min(1)).min(2),
  gaps: z.array(z.string().min(1)).min(1),
  next_steps: z.array(z.string().min(1)).min(3),
})
export type DesignReview = z.infer<typeof DesignReviewSchema>

function collectKeys(value: unknown, depth = 0): string[] {
  if (depth > 2 || value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((item) => collectKeys(item, depth + 1))
  const keys: string[] = []
  for (const [key, child] of Object.entries(value)) {
    keys.push(key)
    keys.push(...collectKeys(child, depth + 1))
  }
  return keys
}

function questionnaireProblems(value: Questionnaire): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  for (const question of value.questions) {
    if (ids.has(question.id)) problems.push(`题目 id 重复：${question.id}`)
    ids.add(question.id)
    if (question.type === 'open') {
      if (question.options && question.options.length > 0) problems.push(`${question.id} 是开放题，不应提供 options`)
      if (question.scale) problems.push(`${question.id} 是开放题，不应提供 scale`)
    }
    if (question.type === 'single' || question.type === 'multi') {
      if (!question.options || question.options.length < 2) {
        problems.push(`${question.id} 的 ${question.type} 题至少需要 2 个选项`)
      }
      if (question.scale) problems.push(`${question.id} 是 ${question.type} 题，不应提供 scale`)
    }
    if (question.type === 'scale') {
      if (question.options && question.options.length > 0) {
        problems.push(`${question.id} 是 scale 题，不应提供 options`)
      }
      if (!question.scale) {
        problems.push(`${question.id} 的 scale 题缺少 scale 定义`)
      } else {
        if (question.scale.min >= question.scale.max) {
          problems.push(`${question.id} 的 scale.min 必须小于 scale.max`)
        }
        if (question.scale.labels.length !== question.scale.max - question.scale.min + 1) {
          problems.push(`${question.id} 的 labels 数量必须等于 max-min+1`)
        }
      }
    }
  }
  if (new Set(value.questions.map((question) => question.type)).size < 2) {
    problems.push('至少使用两种题型')
  }
  return problems
}

function reviewProblems(value: DesignReview, design: unknown): string[] {
  const problems: string[] = []
  const evidence = value.strengths.filter((item) => /\[[^\]]+\]|【[^】]+】/.test(item))
  if (evidence.length === 0) {
    problems.push('strengths 至少一条必须以 [设计元素] 开头并引用 design 中的证据')
  }
  if (value.level === 'L3' || value.level === 'L4') {
    const keys = collectKeys(design)
    const present = RESEARCH_DEPTH_KEYS.filter((key) => keys.includes(key))
    if (present.length < 4) {
      problems.push(
        `L3/L4 需要 design 至少包含 ${RESEARCH_DEPTH_KEYS.join('、')} 中的 4 项；当前证据不足，最高只能评 L2`,
      )
    }
    if (evidence.length < 2) {
      problems.push('L3/L4 至少需要两条引用设计元素的证据')
    }
  }
  return problems
}

interface StructuredRequest<T> {
  schema: z.ZodType<T>
  toolName: string
  toolDescription: string
  parameters: Record<string, unknown>
  prompt: string
  maxTokens?: number
  problems?: (value: T) => string[]
}

const MAX_ATTEMPTS = 3

async function requestStructured<T>(
  ctx: Context,
  request: StructuredRequest<T>,
  signal?: AbortSignal,
): Promise<T> {
  let feedback = ''
  let lastError = 'unknown error'
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted()
    const prompt = feedback
      ? `${request.prompt}\n\n上一次输出未通过校验：${feedback}\n请修正后重新调用 ${request.toolName}，不要重复同样的错误。`
      : request.prompt
    let raw: unknown
    try {
      raw = await callStructuredTool<unknown>({
        ctx,
        system: RESEARCH_SYSTEM,
        prompt,
        toolName: request.toolName,
        toolDescription: request.toolDescription,
        parameters: request.parameters,
        maxTokens: request.maxTokens ?? 4096,
        signal,
      })
    } catch (error) {
      const errorName = error instanceof Error ? error.name : ''
      if (signal?.aborted || errorName === 'AbortError') throw error
      lastError = error instanceof Error ? error.message : String(error)
      feedback = `模型调用失败：${lastError}`
      continue
    }
    const parsed = request.schema.safeParse(raw)
    if (!parsed.success) {
      lastError = parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      feedback = lastError
      continue
    }
    const problems = request.problems?.(parsed.data) ?? []
    if (problems.length === 0) return parsed.data
    lastError = problems.join('; ')
    feedback = lastError
  }
  throw new Error(`${request.toolName} 输出未通过校验：${lastError}`)
}

function briefPrompt(brief: string): string {
  return [
    '把下面的学生调研简报解析为研究设计起点。',
    '要求：',
    '- research_question：一个可回答的疑问句，包含研究对象、核心现象/变量和情境；不要写成主题词或“了解……”。',
    '- objectives：3-5 条，每条以动词开头，说明要产出什么证据、回答哪个子问题。',
    '- constraints：列出时间、预算、样本、伦理、课程要求等已知限制；没有就写“未说明”。',
    '- assumptions：列出简报缺失但设计必须假设的信息；没有就写“无”。',
    '- 不要替学生决定研究方法。',
    '',
    `简报：${brief}`,
  ].join('\n')
}

function methodPrompt(researchQuestion: string, constraints: string[]): string {
  return [
    `研究问题：${researchQuestion}`,
    `已知约束：${constraints.length > 0 ? constraints.join('；') : '未说明'}`,
    '要求：',
    '- 在 qualitative、quantitative、mixed 中选择一个方法。',
    '- rationale 必须引用研究问题的关键要素与约束，说明该方法为什么能回答它。',
    '- alternatives 至少 2 个其他可行方法；每个写清 tradeoff（成本、时间、因果推断、外部效度、伦理等）。',
    '- 不得编造数据或研究结论。',
  ].join('\n')
}

function samplingPrompt(population: string, method: string, constraints: string[]): string {
  return [
    `总体：${population}`,
    `研究方法：${method}`,
    `已知约束：${constraints.length > 0 ? constraints.join('；') : '未说明'}`,
    '要求：',
    '- sampling_frame：可操作的抽样框（从哪里、用什么名单/平台、覆盖谁、排除谁）。',
    '- technique：具体抽样技术（概率/非概率、分层/配额/滚雪球等）及关键参数。',
    '- target_size：正整数；在 recruitment 中说明样本量依据（定性饱和或定量误差范围）。',
    '- recruitment：招募渠道、激励、知情同意与伦理注意事项。',
    '- risks：至少 2 条，覆盖覆盖偏差、无应答、执行可行性。',
    '- 不得编造已有样本、名单或受访者。',
  ].join('\n')
}

function questionnairePrompt(objectives: string[], target: string, length: number): string {
  return [
    `研究目标：${objectives.join('；')}`,
    `目标受访者：${target}`,
    `题量：${length}（必须在 8-20 之间）`,
    '要求：',
    '- 至少 8 题，id 使用 q1..qN。',
    '- 题型使用 open/single/multi/scale，至少覆盖两种。',
    '- 每题只问一个概念；避免诱导性、双重-barrel、行话和假设性提问。',
    '- single/multi 提供 2-6 个互斥选项；multi 可多选。',
    '- scale 提供 min、max 和 labels；labels 数量必须等于 max-min+1。',
    '- open 题不要 options 或 scale。',
    '- 问卷顺序：筛选题/背景 → 行为 → 态度/偏好 → 决策因素 → 开放建议。',
  ].join('\n')
}

function interviewPrompt(objectives: string[], target: string): string {
  return [
    `研究目标：${objectives.join('；')}`,
    `目标受访者：${target}`,
    '要求：',
    '- 3-6 个 sections，按访谈流程组织：暖场与背景、最近一次行为、决策过程、障碍与替代方案、收尾。',
    '- 每节 2-5 个主问题，2-5 个 probes。',
    '- 主问题开放、非诱导；probes 追问具体事件（最近一次、当时为什么、然后呢、还有呢）。',
    '- 不写问卷式选项，不编造受访者信息。',
  ].join('\n')
}

function analysisPrompt(dataType: string, objectives: string[]): string {
  return [
    `数据类型：${dataType}`,
    `研究目标：${objectives.join('；')}`,
    '要求：',
    '- methods：至少 2 种与 data_type 匹配的分析方法。',
    '- steps：至少 4 步，覆盖数据清洗、编码/变量构造、主分析、稳健性/三角验证。',
    '- outputs：至少 2 项，对应 objectives 的交付物（表、图、编码本、结论）。',
    '- limitations：至少 2 条，说明方法边界、推断限制和替代解释。',
    '- 不编造数据结果。',
  ].join('\n')
}

function reviewPrompt(design: unknown): string {
  return [
    '按四级量表评审下面的研究设计：',
    'L1 复述：能说出概念和步骤，但没有针对本研究问题的选择理由。',
    'L2 套用：按模板完成方法、抽样、工具和分析，步骤完整但缺少情境适配。',
    'L3 情境化：每个设计选择都针对研究问题、对象和约束做了调整，并说明取舍。',
    'L4 批判性：能识别设计边界、替代解释和效度威胁，并给出可执行的改进或验证方案。',
    '要求：',
    '- strengths 每条以 `[设计元素]` 开头，引用 design 中真实存在的字段或内容；至少一条直接支撑 level。',
    '- gaps 每条指出缺失或薄弱的设计元素，并引用字段名。',
    '- next_steps 3-5 条，可执行、可验收。',
    '- 没有证据不得给高等级；若 design 缺少 research_question、objectives、method、sampling、questionnaire/interview_guide、analysis 中的多数元素，level 不得高于 L2。',
    '',
    'design JSON：',
    JSON.stringify(design, null, 2),
  ].join('\n')
}

const ResearchBriefOutput = objectOutput({
  research_question: { type: 'string', required: true },
  objectives: { type: 'array', items: { type: 'string' }, required: true },
  constraints: { type: 'array', items: { type: 'string' }, required: true },
  assumptions: { type: 'array', items: { type: 'string' }, required: true },
})

const MethodChoiceOutput = objectOutput({
  method: { type: 'string', enum: ['qualitative', 'quantitative', 'mixed'], required: true },
  rationale: { type: 'string', required: true },
  alternatives: {
    type: 'array',
    required: true,
    items: objectOutput({
      method: { type: 'string', enum: ['qualitative', 'quantitative', 'mixed'], required: true },
      tradeoff: { type: 'string', required: true },
    }),
  },
})

const SamplingPlanOutput = objectOutput({
  sampling_frame: { type: 'string', required: true },
  technique: { type: 'string', required: true },
  target_size: { type: 'integer', required: true },
  recruitment: { type: 'string', required: true },
  risks: { type: 'array', items: { type: 'string' }, required: true },
})

const QuestionnaireOutput = objectOutput({
  questions: {
    type: 'array',
    required: true,
    items: objectOutput({
      id: { type: 'string', required: true },
      text: { type: 'string', required: true },
      type: { type: 'string', enum: ['open', 'single', 'multi', 'scale'], required: true },
      options: { type: 'array', items: { type: 'string' } },
      scale: objectOutput({
        min: { type: 'integer', required: true },
        max: { type: 'integer', required: true },
        labels: { type: 'array', items: { type: 'string' }, required: true },
      }),
    }),
  },
})

const InterviewGuideOutput = objectOutput({
  sections: {
    type: 'array',
    required: true,
    items: objectOutput({
      title: { type: 'string', required: true },
      questions: { type: 'array', items: { type: 'string' }, required: true },
      probes: { type: 'array', items: { type: 'string' }, required: true },
    }),
  },
})

const AnalysisPlanOutput = objectOutput({
  methods: { type: 'array', items: { type: 'string' }, required: true },
  steps: { type: 'array', items: { type: 'string' }, required: true },
  outputs: { type: 'array', items: { type: 'string' }, required: true },
  limitations: { type: 'array', items: { type: 'string' }, required: true },
})

const DesignReviewOutput = objectOutput({
  level: { type: 'string', enum: ['L1', 'L2', 'L3', 'L4'], required: true },
  strengths: { type: 'array', items: { type: 'string' }, required: true },
  gaps: { type: 'array', items: { type: 'string' }, required: true },
  next_steps: { type: 'array', items: { type: 'string' }, required: true },
})

export interface ParseBriefInput {
  brief: string
  projectId?: string
}

export interface ChooseMethodInput {
  researchQuestion: string
  constraints?: string[]
  projectId?: string
}

export interface DesignSamplingInput {
  population: string
  method: string
  constraints?: string[]
  projectId?: string
}

export interface BuildQuestionnaireInput {
  objectives: string[]
  target: string
  length?: number
  projectId?: string
}

export interface BuildInterviewGuideInput {
  objectives: string[]
  target: string
  projectId?: string
}

export interface DesignAnalysisInput {
  dataType: string
  objectives: string[]
  projectId?: string
}

export interface ReviewDesignInput {
  design: unknown
  projectId?: string
}

export class ResearchService extends Service {
  static inject = ['learningDb', 'llm']

  constructor(ctx: Context) {
    super(ctx, 'research')
  }

  private get db(): LearningDb {
    return this.ctx.learningDb
  }

  getProject(projectId: string): ResearchProject | undefined {
    return this.db.getResearchProject(projectId)
  }

  listArtifacts(projectId: string): ResearchArtifact[] {
    return this.db.getResearchArtifacts(projectId)
  }

  private assertProject(projectId: string | undefined): void {
    if (projectId && !this.getProject(projectId)) {
      throw new Error(`research project not found: ${projectId}`)
    }
  }

  private persist(projectId: string | undefined, step: ResearchStepKey, content: unknown): void {
    if (!projectId) return
    this.db.upsertResearchArtifact(projectId, step, content)
  }

  async parseBrief(input: ParseBriefInput, signal?: AbortSignal): Promise<ResearchBrief> {
    this.assertProject(input.projectId)
    const value = await requestStructured(
      this.ctx,
      {
        schema: ResearchBriefSchema,
        toolName: 'emit_research_brief',
        toolDescription: '提交解析后的研究简报：研究问题、目标、约束与假设。',
        parameters: jsonObjectSchema(
          {
            research_question: { type: 'string' },
            objectives: { type: 'array', items: { type: 'string' } },
            constraints: { type: 'array', items: { type: 'string' } },
            assumptions: { type: 'array', items: { type: 'string' } },
          },
          ['research_question', 'objectives', 'constraints', 'assumptions'],
        ),
        prompt: briefPrompt(input.brief),
      },
      signal,
    )
    this.persist(input.projectId, RESEARCH_STEP_KEYS.brief, value)
    return value
  }

  async chooseMethod(input: ChooseMethodInput, signal?: AbortSignal): Promise<MethodChoice> {
    this.assertProject(input.projectId)
    const value = await requestStructured(
      this.ctx,
      {
        schema: MethodChoiceSchema,
        toolName: 'emit_research_method',
        toolDescription: '提交研究方法选择、理由和替代方案。',
        parameters: jsonObjectSchema(
          {
            method: { type: 'string', enum: ['qualitative', 'quantitative', 'mixed'] },
            rationale: { type: 'string' },
            alternatives: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  method: { type: 'string', enum: ['qualitative', 'quantitative', 'mixed'] },
                  tradeoff: { type: 'string' },
                },
                required: ['method', 'tradeoff'],
              },
            },
          },
          ['method', 'rationale', 'alternatives'],
        ),
        prompt: methodPrompt(input.researchQuestion, input.constraints ?? []),
      },
      signal,
    )
    this.persist(input.projectId, RESEARCH_STEP_KEYS.method, value)
    return value
  }

  async designSampling(input: DesignSamplingInput, signal?: AbortSignal): Promise<SamplingPlan> {
    this.assertProject(input.projectId)
    const value = await requestStructured(
      this.ctx,
      {
        schema: SamplingPlanSchema,
        toolName: 'emit_sampling_plan',
        toolDescription: '提交抽样框、抽样技术、样本量、招募方案与风险。',
        parameters: jsonObjectSchema(
          {
            sampling_frame: { type: 'string' },
            technique: { type: 'string' },
            target_size: { type: 'integer' },
            recruitment: { type: 'string' },
            risks: { type: 'array', items: { type: 'string' } },
          },
          ['sampling_frame', 'technique', 'target_size', 'recruitment', 'risks'],
        ),
        prompt: samplingPrompt(input.population, input.method, input.constraints ?? []),
      },
      signal,
    )
    this.persist(input.projectId, RESEARCH_STEP_KEYS.sampling, value)
    return value
  }

  async buildQuestionnaire(input: BuildQuestionnaireInput, signal?: AbortSignal): Promise<Questionnaire> {
    this.assertProject(input.projectId)
    const length = Math.min(20, Math.max(8, Math.trunc(input.length ?? 10)))
    const value = await requestStructured(
      this.ctx,
      {
        schema: QuestionnaireSchema,
        toolName: 'emit_questionnaire',
        toolDescription: '提交问卷题目：每题包含 id、题干、题型，以及必要的选项或量表。',
        parameters: jsonObjectSchema(
          {
            questions: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  type: { type: 'string', enum: ['open', 'single', 'multi', 'scale'] },
                  options: { type: 'array', items: { type: 'string' } },
                  scale: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      min: { type: 'integer' },
                      max: { type: 'integer' },
                      labels: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['min', 'max', 'labels'],
                  },
                },
                required: ['id', 'text', 'type'],
              },
            },
          },
          ['questions'],
        ),
        prompt: questionnairePrompt(input.objectives, input.target, length),
        maxTokens: 6000,
        problems: questionnaireProblems,
      },
      signal,
    )
    const normalized: Questionnaire = {
      questions: value.questions.map((question) => ({
        id: question.id,
        text: question.text,
        type: question.type,
        ...(question.options ? { options: question.options } : {}),
        ...(question.scale
          ? {
              scale: {
                min: question.scale.min,
                max: question.scale.max,
                labels: question.scale.labels,
              },
            }
          : {}),
      })),
    }
    this.persist(input.projectId, RESEARCH_STEP_KEYS.questionnaire, normalized)
    return normalized
  }

  async buildInterviewGuide(input: BuildInterviewGuideInput, signal?: AbortSignal): Promise<InterviewGuide> {
    this.assertProject(input.projectId)
    const value = await requestStructured(
      this.ctx,
      {
        schema: InterviewGuideSchema,
        toolName: 'emit_interview_guide',
        toolDescription: '提交访谈提纲：按流程分节，每节包含主问题与追问。',
        parameters: jsonObjectSchema(
          {
            sections: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  title: { type: 'string' },
                  questions: { type: 'array', items: { type: 'string' } },
                  probes: { type: 'array', items: { type: 'string' } },
                },
                required: ['title', 'questions', 'probes'],
              },
            },
          },
          ['sections'],
        ),
        prompt: interviewPrompt(input.objectives, input.target),
        maxTokens: 5000,
      },
      signal,
    )
    this.persist(input.projectId, RESEARCH_STEP_KEYS.interviewGuide, value)
    return value
  }

  async designAnalysis(input: DesignAnalysisInput, signal?: AbortSignal): Promise<AnalysisPlan> {
    this.assertProject(input.projectId)
    const value = await requestStructured(
      this.ctx,
      {
        schema: AnalysisPlanSchema,
        toolName: 'emit_analysis_plan',
        toolDescription: '提交数据分析方法、步骤、产出与局限。',
        parameters: jsonObjectSchema(
          {
            methods: { type: 'array', items: { type: 'string' } },
            steps: { type: 'array', items: { type: 'string' } },
            outputs: { type: 'array', items: { type: 'string' } },
            limitations: { type: 'array', items: { type: 'string' } },
          },
          ['methods', 'steps', 'outputs', 'limitations'],
        ),
        prompt: analysisPrompt(input.dataType, input.objectives),
      },
      signal,
    )
    this.persist(input.projectId, RESEARCH_STEP_KEYS.analysis, value)
    return value
  }

  async reviewDesign(input: ReviewDesignInput, signal?: AbortSignal): Promise<DesignReview> {
    this.assertProject(input.projectId)
    const value = await requestStructured(
      this.ctx,
      {
        schema: DesignReviewSchema,
        toolName: 'emit_research_review',
        toolDescription: '按 L1-L4 量表提交研究设计评审：等级、优势、差距与下一步。',
        parameters: jsonObjectSchema(
          {
            level: { type: 'string', enum: ['L1', 'L2', 'L3', 'L4'] },
            strengths: { type: 'array', items: { type: 'string' } },
            gaps: { type: 'array', items: { type: 'string' } },
            next_steps: { type: 'array', items: { type: 'string' } },
          },
          ['level', 'strengths', 'gaps', 'next_steps'],
        ),
        prompt: reviewPrompt(input.design),
        problems: (review) => reviewProblems(review, input.design),
      },
      signal,
    )
    this.persist(input.projectId, RESEARCH_STEP_KEYS.review, value)
    return value
  }
}

function parseResearchBriefTool(ctx: Context) {
  return defineTool({
    name: 'parse_research_brief',
    description: '把学生的调研简报解析为研究问题、目标、约束与假设。提供 project_id 时持久化到调研项目。',
    parameters: {
      brief: { type: 'string', required: true, description: '调研简报原文' },
      project_id: { type: 'string', description: '调研项目 ID（可选）；提供时持久化 artifact' },
    },
    output: {
      schema: ResearchBriefOutput,
      render: (_args, value) => jsonContent(value),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return ctx.research.parseBrief({ brief: args.brief, projectId: args.project_id }, exec.signal)
    },
  })
}

function chooseResearchMethodTool(ctx: Context) {
  return defineTool({
    name: 'choose_research_method',
    description: '根据研究问题和约束选择 qualitative/quantitative/mixed 方法，并给出理由与至少两个替代方案的取舍。',
    parameters: {
      research_question: { type: 'string', required: true, description: '已确认的研究问题' },
      constraints: { type: 'array', items: { type: 'string' }, description: '时间、预算、样本等约束' },
      project_id: { type: 'string', description: '调研项目 ID（可选）' },
    },
    output: {
      schema: MethodChoiceOutput,
      render: (_args, value) => jsonContent(value),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return ctx.research.chooseMethod(
        {
          researchQuestion: args.research_question,
          constraints: args.constraints,
          projectId: args.project_id,
        },
        exec.signal,
      )
    },
  })
}

function designSamplingTool(ctx: Context) {
  return defineTool({
    name: 'design_sampling',
    description: '设计抽样框、抽样技术、样本量、招募方案与风险。',
    parameters: {
      population: { type: 'string', required: true, description: '目标总体' },
      method: { type: 'string', required: true, description: '研究方法（qualitative/quantitative/mixed 或具体方法）' },
      constraints: { type: 'array', items: { type: 'string' }, description: '时间、预算、可及性等约束' },
      project_id: { type: 'string', description: '调研项目 ID（可选）' },
    },
    output: {
      schema: SamplingPlanOutput,
      render: (_args, value) => jsonContent(value),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return ctx.research.designSampling(
        {
          population: args.population,
          method: args.method,
          constraints: args.constraints,
          projectId: args.project_id,
        },
        exec.signal,
      )
    },
  })
}

function buildQuestionnaireTool(ctx: Context) {
  return defineTool({
    name: 'build_questionnaire',
    description: '根据研究目标和受访者生成至少 8 题的问卷，支持开放、单选、多选和量表题。',
    parameters: {
      objectives: { type: 'array', items: { type: 'string' }, required: true, description: '研究目标' },
      target: { type: 'string', required: true, description: '目标受访者' },
      length: { type: 'integer', description: '题目数量，默认 10，范围 8-20' },
      project_id: { type: 'string', description: '调研项目 ID（可选）' },
    },
    output: {
      schema: QuestionnaireOutput,
      render: (_args, value) => jsonContent(value),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return ctx.research.buildQuestionnaire(
        {
          objectives: args.objectives,
          target: args.target,
          length: args.length,
          projectId: args.project_id,
        },
        exec.signal,
      )
    },
  })
}

function buildInterviewGuideTool(ctx: Context) {
  return defineTool({
    name: 'build_interview_guide',
    description: '生成分节访谈提纲，每节包含主问题与追问。',
    parameters: {
      objectives: { type: 'array', items: { type: 'string' }, required: true, description: '研究目标' },
      target: { type: 'string', required: true, description: '目标受访者' },
      project_id: { type: 'string', description: '调研项目 ID（可选）' },
    },
    output: {
      schema: InterviewGuideOutput,
      render: (_args, value) => jsonContent(value),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return ctx.research.buildInterviewGuide(
        {
          objectives: args.objectives,
          target: args.target,
          projectId: args.project_id,
        },
        exec.signal,
      )
    },
  })
}

function designAnalysisTool(ctx: Context) {
  return defineTool({
    name: 'design_analysis',
    description: '根据数据类型和研究目标设计分析方法、步骤、产出与局限。',
    parameters: {
      data_type: { type: 'string', required: true, description: '数据类型（访谈、问卷、观察、二手数据等）' },
      objectives: { type: 'array', items: { type: 'string' }, required: true, description: '研究目标' },
      project_id: { type: 'string', description: '调研项目 ID（可选）' },
    },
    output: {
      schema: AnalysisPlanOutput,
      render: (_args, value) => jsonContent(value),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return ctx.research.designAnalysis(
        {
          dataType: args.data_type,
          objectives: args.objectives,
          projectId: args.project_id,
        },
        exec.signal,
      )
    },
  })
}

function reviewResearchDesignTool(ctx: Context) {
  return defineTool({
    name: 'review_research_design',
    description: '按 L1 复述、L2 套用、L3 情境化、L4 批判性四级量表评审研究设计，并引用设计元素作为证据。',
    parameters: {
      design: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: '研究设计对象（研究问题、目标、方法、抽样、工具、分析等）',
      },
      project_id: { type: 'string', description: '调研项目 ID（可选）' },
    },
    output: {
      schema: DesignReviewOutput,
      render: (_args, value) => jsonContent(value),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return ctx.research.reviewDesign({ design: args.design, projectId: args.project_id }, exec.signal)
    },
  })
}

export function apply(ctx: Context) {
  ctx.plugin(ResearchService)
  ctx.inject(['research'], (scoped) => {
    scoped.tools.register(parseResearchBriefTool(scoped))
    scoped.tools.register(chooseResearchMethodTool(scoped))
    scoped.tools.register(designSamplingTool(scoped))
    scoped.tools.register(buildQuestionnaireTool(scoped))
    scoped.tools.register(buildInterviewGuideTool(scoped))
    scoped.tools.register(designAnalysisTool(scoped))
    scoped.tools.register(reviewResearchDesignTool(scoped))
  })
}
