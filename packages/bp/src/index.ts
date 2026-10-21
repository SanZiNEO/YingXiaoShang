import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type LearningDb from '@learning-agent/db'
import { writeDocx, writeMarkdown, type DocBlock } from '@learning-agent/export'
import { callStructuredTool, jsonObjectSchema } from '@learning-agent/llm-json'
import type { BpProject, BpSection } from '@learning-agent/shared'
import { resolve } from 'node:path'
import { z } from 'zod'

export const name = 'learning-bp'
export const inject = ['tools', 'learningDb', 'llm']

declare module '@deepseek-ai/cordis' {
  interface Context {
    bp: BpService
  }
}

/** Stable section keys persisted through `learningDb.upsertBpSection`. */
export const BP_SECTION_KEYS = {
  outline: 'outline',
  marketSizing: 'market_sizing',
  competitors: 'competitors',
  canvas: 'canvas',
  gtm: 'gtm',
  financials: 'financials',
  review: 'review',
} as const

export type BpSectionKey = (typeof BP_SECTION_KEYS)[keyof typeof BP_SECTION_KEYS]

const BP_SECTION_TITLES: Record<string, string> = {
  outline: '计划书结构',
  market_sizing: '市场规模',
  competitors: '竞争分析',
  canvas: '商业模式画布',
  gtm: '上市计划',
  financials: '财务预测',
  review: 'BP 评审',
}

const BP_SECTION_ORDER = [
  BP_SECTION_KEYS.outline,
  BP_SECTION_KEYS.marketSizing,
  BP_SECTION_KEYS.competitors,
  BP_SECTION_KEYS.canvas,
  BP_SECTION_KEYS.gtm,
  BP_SECTION_KEYS.financials,
  BP_SECTION_KEYS.review,
]

const BP_DEPTH_KEYS = [
  'outline',
  'sections',
  'market_sizing',
  'market',
  'competitors',
  'competitor_analysis',
  'canvas',
  'business_model_canvas',
  'gtm',
  'gtm_plan',
  'financials',
  'financial_projection',
] as const

const LABELS: Record<string, string> = {
  assumptions: '假设',
  tam: 'TAM',
  sam: 'SAM',
  som: 'SOM',
  currency: '货币',
  sources: '来源',
  competitors: '竞争者',
  name: '名称',
  positioning: '定位',
  strengths: '优势',
  weaknesses: '劣势',
  evidence: '证据',
  customer_segments: '客户细分',
  value_propositions: '价值主张',
  channels: '渠道',
  customer_relationships: '客户关系',
  revenue_streams: '收入来源',
  key_resources: '关键资源',
  key_activities: '关键活动',
  key_partners: '关键伙伴',
  cost_structure: '成本结构',
  role: '角色',
  budget_share: '预算占比',
  kpi: 'KPI',
  milestones: '里程碑',
  phase: '阶段',
  action: '行动',
  metric: '指标',
  years: '年度',
  year: '年份',
  revenue: '收入',
  cost: '成本',
  gross_profit: '毛利',
  ebitda: 'EBITDA',
  customers: '客户数',
  level: '等级',
  gaps: '差距',
  next_steps: '下一步',
  required_evidence: '所需证据',
  purpose: '目的',
  title: '标题',
  id: '编号',
  sections: '章节',
}

const BP_SYSTEM = [
  '你是商业计划书教练，服务本科营销与创业课程。',
  '你只通过指定的 emit 工具提交结构化结果；字段必须完整、可执行、可 JSON 序列化。',
  '原则：',
  '1. 先问客户、痛点、证据和商业模式假设；不要替学生写完整计划书。',
  '2. 每个数字都要标来源或假设；没有来源就写「假设」，不要编造市场数据、报告名、URL 或年份。',
  '3. 证据要求先于内容；无法确认的信息放入 assumptions 并说明验证方法。',
  '4. 输出使用简体中文；专业术语可保留英文。',
].join('\n')

function objectOutput<const P extends ParameterSchemaSpec>(properties: P) {
  return { type: 'object' as const, additionalProperties: false as const, properties }
}

function jsonContent(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) ?? '' }]
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function humanize(key: string): string {
  return LABELS[key] ?? key.replace(/_/g, ' ')
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value) ?? ''
}

const BpOutlineSchema = z.object({
  sections: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        purpose: z.string().min(1),
        required_evidence: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(8)
    .max(10),
})
export type BpOutline = z.infer<typeof BpOutlineSchema>

const MarketSizingSchema = z.object({
  tam: z.number().positive(),
  sam: z.number().positive(),
  som: z.number().positive(),
  currency: z.string().min(1),
  assumptions: z.array(z.string().min(1)).min(1),
  sources: z.array(z.string().min(1)).min(1),
})
export type MarketSizing = z.infer<typeof MarketSizingSchema>

const CompetitorAnalysisSchema = z.object({
  competitors: z
    .array(
      z.object({
        name: z.string().min(1),
        positioning: z.string().min(1),
        strengths: z.array(z.string().min(1)).min(1),
        weaknesses: z.array(z.string().min(1)).min(1),
        evidence: z.string().min(1),
      }),
    )
    .min(2),
})
export type CompetitorAnalysis = z.infer<typeof CompetitorAnalysisSchema>

const BusinessModelCanvasSchema = z.object({
  customer_segments: z.array(z.string().min(1)).min(1),
  value_propositions: z.array(z.string().min(1)).min(1),
  channels: z.array(z.string().min(1)).min(1),
  customer_relationships: z.array(z.string().min(1)).min(1),
  revenue_streams: z.array(z.string().min(1)).min(1),
  key_resources: z.array(z.string().min(1)).min(1),
  key_activities: z.array(z.string().min(1)).min(1),
  key_partners: z.array(z.string().min(1)).min(1),
  cost_structure: z.array(z.string().min(1)).min(1),
})
export type BusinessModelCanvas = z.infer<typeof BusinessModelCanvasSchema>

const GtmPlanSchema = z.object({
  channels: z
    .array(
      z.object({
        name: z.string().min(1),
        role: z.string().min(1),
        budget_share: z.number().min(0).max(1),
        kpi: z.string().min(1),
      }),
    )
    .min(3),
  milestones: z
    .array(
      z.object({
        phase: z.string().min(1),
        action: z.string().min(1),
        metric: z.string().min(1),
      }),
    )
    .min(3),
})
export type GtmPlan = z.infer<typeof GtmPlanSchema>

const FinancialProjectionSchema = z.object({
  years: z
    .array(
      z.object({
        year: z.number().int(),
        revenue: z.number().min(0),
        cost: z.number().min(0),
        gross_profit: z.number(),
        ebitda: z.number(),
        customers: z.number().int().min(0),
      }),
    )
    .min(3)
    .max(5),
  assumptions: z.array(z.string().min(1)).min(1),
})
export type FinancialProjection = z.infer<typeof FinancialProjectionSchema>

const BpReviewSchema = z.object({
  level: z.enum(['L1', 'L2', 'L3', 'L4']),
  strengths: z.array(z.string().min(1)).min(2),
  gaps: z.array(z.string().min(1)).min(1),
  next_steps: z.array(z.string().min(1)).min(3),
})
export type BpReview = z.infer<typeof BpReviewSchema>

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

function outlineProblems(value: BpOutline): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  for (const section of value.sections) {
    if (ids.has(section.id)) problems.push(`章节 id 重复：${section.id}`)
    ids.add(section.id)
  }
  return problems
}

function marketSizingProblems(value: MarketSizing): string[] {
  const problems: string[] = []
  if (value.tam < value.sam) problems.push('TAM 必须大于或等于 SAM')
  if (value.sam < value.som) problems.push('SAM 必须大于或等于 SOM')
  return problems
}

function competitorProblems(value: CompetitorAnalysis, requested: string[] | undefined): string[] {
  const problems: string[] = []
  if (value.competitors.length > 6) problems.push('competitors 最多 6 个')
  const names = new Set<string>()
  for (const competitor of value.competitors) {
    const key = competitor.name.toLowerCase()
    if (names.has(key)) problems.push(`竞争者重复：${competitor.name}`)
    names.add(key)
  }
  for (const name of requested ?? []) {
    const target = name.toLowerCase()
    const covered = value.competitors.some(
      (competitor) =>
        competitor.name.toLowerCase().includes(target) || target.includes(competitor.name.toLowerCase()),
    )
    if (!covered) problems.push(`未覆盖输入中的竞争者：${name}`)
  }
  return problems
}

function gtmProblems(value: GtmPlan): string[] {
  const problems: string[] = []
  if (value.channels.length > 6) problems.push('channels 最多 6 个')
  if (value.milestones.length > 6) problems.push('milestones 最多 6 个')
  const total = value.channels.reduce((sum, channel) => sum + channel.budget_share, 0)
  if (total <= 0) problems.push('channels.budget_share 合计必须大于 0')
  return problems
}

function financialProblems(value: FinancialProjection): string[] {
  const problems: string[] = []
  for (const [index, item] of value.years.entries()) {
    const previous = value.years[index - 1]
    if (previous && item.year <= previous.year) problems.push('years 必须按年份严格递增')
    if (item.ebitda > item.revenue - item.cost + 1e-6) {
      problems.push(`year ${item.year}: ebitda 不能大于 gross_profit（revenue - cost）`)
    }
  }
  return problems
}

function reviewProblems(value: BpReview, bp: unknown): string[] {
  const problems: string[] = []
  const evidence = value.strengths.filter((item) => /\[[^\]]+\]|【[^】]+】/.test(item))
  if (evidence.length === 0) {
    problems.push('strengths 至少一条必须以 [计划书元素] 开头并引用 bp 中的证据')
  }
  if (value.level === 'L3' || value.level === 'L4') {
    const keys = collectKeys(bp)
    const present = BP_DEPTH_KEYS.filter((key) => keys.includes(key))
    if (present.length < 4) {
      problems.push(
        `L3/L4 需要 bp 至少包含 ${BP_DEPTH_KEYS.join('、')} 中的 4 项；当前证据不足，最高只能评 L2`,
      )
    }
    if (evidence.length < 2) {
      problems.push('L3/L4 至少需要两条引用计划书元素的证据')
    }
  }
  return problems
}

function normalizeMarketSizing(value: MarketSizing): MarketSizing {
  const assumptions = value.assumptions.map((item) => {
    if (/^assumption\s*:/i.test(item)) return item
    if (/^假设\s*:?/.test(item)) return `assumption: ${item.replace(/^假设\s*:?\s*/, '')}`
    return `assumption: ${item}`
  })
  const sources = [
    ...new Set(
      value.sources
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .map((item) => {
          if (/^(assumption|假设)\s*:?/i.test(item) || /估算|推测|经验判断/.test(item)) {
            return 'assumption'
          }
          if (/^source\s*:/i.test(item)) return item
          return `source: ${item}`
        }),
    ),
  ]
  if (!sources.some((item) => /^source\s*:/i.test(item)) && !sources.includes('assumption')) {
    sources.push('assumption')
  }
  const labelled = `${assumptions.join('\n')}\n${sources.join('\n')}`.toLowerCase()
  for (const key of ['tam', 'sam', 'som'] as const) {
    if (!new RegExp(`\\b${key}\\b`).test(labelled)) {
      assumptions.push(
        `assumption: ${key} = ${value[key]} ${value.currency}；该数值为模型估计，需用一手或可核验二手数据复核`,
      )
    }
  }
  return { ...value, assumptions, sources }
}

function normalizeGtmPlan(value: GtmPlan): GtmPlan {
  const total = value.channels.reduce((sum, channel) => sum + channel.budget_share, 0)
  const channels =
    total > 0
      ? value.channels.map((channel) => ({
          ...channel,
          budget_share: round(channel.budget_share / total, 4),
        }))
      : value.channels
  return { channels, milestones: value.milestones }
}

function normalizeFinancialProjection(value: FinancialProjection): FinancialProjection {
  const years = value.years.map((item) => ({
    ...item,
    gross_profit: item.revenue - item.cost,
  }))
  const assumptions = value.assumptions.map((item) => {
    if (/^(assumption|formula)\s*:/i.test(item)) return item
    if (/^假设\s*:?/.test(item)) return `assumption: ${item.replace(/^假设\s*:?\s*/, '')}`
    if (/^公式\s*:?/.test(item)) return `formula: ${item.replace(/^公式\s*:?\s*/, '')}`
    return `assumption: ${item}`
  })
  for (const item of years) {
    const hasFormula = assumptions.some(
      (line) => line.includes(String(item.year)) && /formula|assumption/i.test(line),
    )
    if (!hasFormula) {
      assumptions.push(
        `formula: year ${item.year}: gross_profit = revenue - cost = ${item.revenue} - ${item.cost}; ebitda = gross_profit - operating expenses (opex not separately modeled)`,
      )
    }
  }
  if (!assumptions.some((line) => /^assumption\s*:/i.test(line))) {
    assumptions.unshift('assumption: 收入、成本与客户数由输入假设推导；未使用外部市场数据')
  }
  return { years, assumptions }
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
        system: BP_SYSTEM,
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

function outlinePrompt(idea: string, audience: string, stage: string): string {
  return [
    `创业想法：${idea}`,
    `目标读者：${audience}`,
    `阶段：${stage}`,
    '要求：',
    '- 8-10 节，顺序符合路演/评审阅读逻辑。',
    '- id 使用 snake_case，且唯一。',
    '- purpose 用一句话说明该节要回答的投资人/评审问题。',
    '- required_evidence 每节 1-4 条，写清需要什么证据、数据或来源；不能写“补充资料”。',
    '- 必须覆盖：问题与机会、解决方案、市场与规模、竞争、商业模式、GTM、团队、财务、融资/里程碑、风险。',
  ].join('\n')
}

function marketSizingPrompt(market: string, geography: string, method: string): string {
  return [
    `市场：${market}`,
    `地理范围：${geography}`,
    `测算方法：${method}`,
    '要求：',
    '- tam、sam、som 为同一货币的数值，不要带单位字符串；currency 用 ISO 代码或人民币。',
    '- top-down 从行业总量逐层过滤；bottom-up 从客户数 × 客单价/使用量自下而上。必须写出每一层的计算式和过滤条件。',
    '- sources 只写真实可核验来源；不能确认来源时写 "assumption"，不得编造报告名、URL 或年份。',
    '- assumptions 每条以 "assumption:" 开头；sources 每条以 "source:" 开头或为 "assumption"。',
    '- 必须让 tam、sam、som 三个数字各自在 assumptions 或 sources 中有对应标签。',
  ].join('\n')
}

function competitorPrompt(market: string, competitors: string[]): string {
  return [
    `市场：${market}`,
    `已知竞争者：${competitors.length > 0 ? competitors.join('、') : '未指定'}`,
    '要求：',
    '- 2-6 个直接或间接竞争者；若给定 competitors，必须全部覆盖，并补充 1-2 个。',
    '- positioning 用一句话说明其目标客户与差异点。',
    '- strengths、weaknesses 各 1-4 条，具体到产品、渠道、价格或品牌。',
    '- evidence 必须是可核验的事实（官网、财报、公开报道）；不能编造；没有证据时写 "assumption: ..."。',
  ].join('\n')
}

function canvasPrompt(idea: string): string {
  return [
    `创业想法：${idea}`,
    '要求：',
    '- 九个模块各 1-5 条，具体到可验证的客户、活动、资源或收入。',
    '- customer_segments 与 value_propositions 必须一一对应。',
    '- revenue_streams 写清计价方式；cost_structure 区分固定成本与变动成本。',
    '- 不要空泛写“年轻人”“线上推广”这类无法执行的描述。',
  ].join('\n')
}

function gtmPrompt(product: string, target: string, budget: number | undefined): string {
  return [
    `产品：${product}`,
    `目标客户：${target}`,
    `预算：${budget === undefined ? '未指定' : budget}`,
    '要求：',
    '- channels 3-6 个，budget_share 为 0-1 的小数且合计约等于 1；role 说明该渠道在漏斗中的位置。',
    '- kpi 必须可度量（CAC、转化率、ROI、留存等）。',
    '- milestones 3-6 个阶段，按时间顺序；action 可执行，metric 可验收。',
    '- 若给出预算，在 role 或 kpi 中说明预算量级与分配逻辑。',
  ].join('\n')
}

function financialPrompt(assumptions: unknown): string {
  return [
    '输入假设：',
    JSON.stringify(assumptions, null, 2),
    '要求：',
    '- 3-5 年；year 为年份整数，按时间严格递增。',
    '- revenue、cost、gross_profit、ebitda、customers 为数值；gross_profit = revenue - cost 必须成立；ebitda <= gross_profit。',
    '- assumptions 至少 3 条，每条以 "assumption:" 或 "formula:" 开头。',
    '- 必须为每一年写出 revenue 与 cost 的公式/驱动（customers × ARPU、毛利率、固定成本等）。',
    '- 不得编造市场数据；输入没有的数字必须明确写成 assumption 并说明推导。',
  ].join('\n')
}

function bpReviewPrompt(bp: unknown): string {
  return [
    '按四级量表评审下面的商业计划书：',
    'L1 复述：能说出商业计划的模块和概念，但没有针对本项目的证据或选择理由。',
    'L2 套用：按模板填完九宫格/财务/GTM，结构完整但缺少客户验证和情境适配。',
    'L3 情境化：每个模块都针对目标客户、场景和约束做了调整，并说明取舍。',
    'L4 批判性：能识别关键假设、替代解释、证据缺口和失败模式，并给出可执行的验证方案。',
    '要求：',
    '- strengths 每条以 `[计划书元素]` 开头，引用 bp 中真实存在的字段或内容；至少一条直接支撑 level。',
    '- gaps 每条指出缺失或薄弱的计划书元素，并引用字段名。',
    '- next_steps 3-5 条，可执行、可验收。',
    '- 没有证据不得给高等级；若 bp 缺少市场、竞争、商业模式、GTM、财务中的多数模块，level 不得高于 L2。',
    '',
    'bp JSON：',
    JSON.stringify(bp, null, 2),
  ].join('\n')
}

const BpOutlineOutput = objectOutput({
  sections: {
    type: 'array',
    required: true,
    items: objectOutput({
      id: { type: 'string', required: true },
      title: { type: 'string', required: true },
      purpose: { type: 'string', required: true },
      required_evidence: { type: 'array', items: { type: 'string' }, required: true },
    }),
  },
})

const MarketSizingOutput = objectOutput({
  tam: { type: 'number', required: true },
  sam: { type: 'number', required: true },
  som: { type: 'number', required: true },
  currency: { type: 'string', required: true },
  assumptions: { type: 'array', items: { type: 'string' }, required: true },
  sources: { type: 'array', items: { type: 'string' }, required: true },
})

const CompetitorAnalysisOutput = objectOutput({
  competitors: {
    type: 'array',
    required: true,
    items: objectOutput({
      name: { type: 'string', required: true },
      positioning: { type: 'string', required: true },
      strengths: { type: 'array', items: { type: 'string' }, required: true },
      weaknesses: { type: 'array', items: { type: 'string' }, required: true },
      evidence: { type: 'string', required: true },
    }),
  },
})

const BusinessModelCanvasOutput = objectOutput({
  customer_segments: { type: 'array', items: { type: 'string' }, required: true },
  value_propositions: { type: 'array', items: { type: 'string' }, required: true },
  channels: { type: 'array', items: { type: 'string' }, required: true },
  customer_relationships: { type: 'array', items: { type: 'string' }, required: true },
  revenue_streams: { type: 'array', items: { type: 'string' }, required: true },
  key_resources: { type: 'array', items: { type: 'string' }, required: true },
  key_activities: { type: 'array', items: { type: 'string' }, required: true },
  key_partners: { type: 'array', items: { type: 'string' }, required: true },
  cost_structure: { type: 'array', items: { type: 'string' }, required: true },
})

const GtmPlanOutput = objectOutput({
  channels: {
    type: 'array',
    required: true,
    items: objectOutput({
      name: { type: 'string', required: true },
      role: { type: 'string', required: true },
      budget_share: { type: 'number', required: true },
      kpi: { type: 'string', required: true },
    }),
  },
  milestones: {
    type: 'array',
    required: true,
    items: objectOutput({
      phase: { type: 'string', required: true },
      action: { type: 'string', required: true },
      metric: { type: 'string', required: true },
    }),
  },
})

const FinancialProjectionOutput = objectOutput({
  years: {
    type: 'array',
    required: true,
    items: objectOutput({
      year: { type: 'integer', required: true },
      revenue: { type: 'number', required: true },
      cost: { type: 'number', required: true },
      gross_profit: { type: 'number', required: true },
      ebitda: { type: 'number', required: true },
      customers: { type: 'integer', required: true },
    }),
  },
  assumptions: { type: 'array', items: { type: 'string' }, required: true },
})

const BpReviewOutput = objectOutput({
  level: { type: 'string', enum: ['L1', 'L2', 'L3', 'L4'], required: true },
  strengths: { type: 'array', items: { type: 'string' }, required: true },
  gaps: { type: 'array', items: { type: 'string' }, required: true },
  next_steps: { type: 'array', items: { type: 'string' }, required: true },
})

const ExportBpOutput = objectOutput({
  path: { type: 'string', required: true },
})

export interface BpOutlineInput {
  idea: string
  audience: string
  stage: string
  projectId?: string
}

export interface MarketSizingInput {
  market: string
  geography: string
  method: 'top-down' | 'bottom-up'
  projectId?: string
}

export interface CompetitorAnalysisInput {
  market: string
  competitors?: string[]
  projectId?: string
}

export interface BusinessModelCanvasInput {
  idea: string
  projectId?: string
}

export interface GtmPlanInput {
  product: string
  target: string
  budget?: number
  projectId?: string
}

export interface FinancialProjectionInput {
  assumptions: unknown
  projectId?: string
}

export interface BpReviewInput {
  bp: unknown
  projectId?: string
}

export interface ExportBpInput {
  projectId: string
  format: 'docx' | 'md'
}

function renderEntry(key: string, value: unknown): DocBlock[] {
  const label = humanize(key)
  if (Array.isArray(value)) {
    if (value.length === 0) return []
    const stringItems: string[] = []
    for (const item of value) {
      if (typeof item === 'string') stringItems.push(item)
    }
    if (stringItems.length === value.length) {
      return [{ heading: label, list: stringItems }]
    }
    const objectRows: [string, unknown][][] = []
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        objectRows.push(Object.entries(item))
      }
    }
    if (objectRows.length === value.length) {
      const headers: string[] = []
      for (const entries of objectRows) {
        for (const [header] of entries) {
          if (headers.length < 6 && !headers.includes(header)) headers.push(header)
        }
      }
      if (headers.length > 0) {
        const rows = objectRows.map((entries) => {
          const lookup = new Map(entries)
          return headers.map((header) => formatCell(lookup.get(header)))
        })
        return [{ heading: label, table: { headers: headers.map(humanize), rows } }]
      }
    }
    return [{ heading: label, text: JSON.stringify(value, null, 2) ?? '' }]
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.every(([, child]) => child === null || typeof child !== 'object')) {
      return [
        {
          heading: label,
          list: entries.map(([childKey, child]) => `${humanize(childKey)}: ${formatCell(child)}`),
        },
      ]
    }
    return [{ heading: label, text: JSON.stringify(value, null, 2) ?? '' }]
  }
  return [{ text: `${label}: ${formatCell(value)}` }]
}

function sectionBlocks(section: BpSection): DocBlock[] {
  const blocks: DocBlock[] = [
    { heading: BP_SECTION_TITLES[section.section] ?? humanize(section.section) },
  ]
  let parsed: unknown = undefined
  try {
    parsed = JSON.parse(section.content)
  } catch {
    parsed = undefined
  }
  if (parsed === undefined) {
    blocks.push({ text: section.content })
  } else if (Array.isArray(parsed)) {
    blocks.push(...renderEntry('items', parsed))
  } else if (parsed !== null && typeof parsed === 'object') {
    for (const [key, value] of Object.entries(parsed)) blocks.push(...renderEntry(key, value))
  } else {
    blocks.push({ text: formatCell(parsed) })
  }
  const evidence = section.evidence
  if (evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence)) {
    const items = Object.entries(evidence).map(
      ([key, value]) => `${humanize(key)}: ${formatCell(value)}`,
    )
    if (items.length > 0) blocks.push({ heading: '证据', list: items })
  }
  return blocks
}

export class BpService extends Service {
  static inject = ['learningDb', 'llm']

  constructor(ctx: Context) {
    super(ctx, 'bp')
  }

  private get db(): LearningDb {
    return this.ctx.learningDb
  }

  getProject(projectId: string): BpProject | undefined {
    return this.db.getBpProject(projectId)
  }

  listSections(projectId: string): BpSection[] {
    return this.db.listBpSections(projectId)
  }

  private assertProject(projectId: string | undefined): void {
    if (projectId && !this.getProject(projectId)) {
      throw new Error(`bp project not found: ${projectId}`)
    }
  }

  private persist(
    projectId: string | undefined,
    section: BpSectionKey,
    content: unknown,
    evidence: unknown,
  ): void {
    if (!projectId) return
    this.db.upsertBpSection(projectId, section, JSON.stringify(content) ?? 'null', evidence)
  }

  async outline(input: BpOutlineInput, signal?: AbortSignal): Promise<BpOutline> {
    this.assertProject(input.projectId)
    const value = await requestStructured(
      this.ctx,
      {
        schema: BpOutlineSchema,
        toolName: 'emit_bp_outline',
        toolDescription: '提交商业计划书目录：8-10 节，每节包含目的与所需证据。',
        parameters: jsonObjectSchema(
          {
            sections: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  purpose: { type: 'string' },
                  required_evidence: { type: 'array', items: { type: 'string' } },
                },
                required: ['id', 'title', 'purpose', 'required_evidence'],
              },
            },
          },
          ['sections'],
        ),
        prompt: outlinePrompt(input.idea, input.audience, input.stage),
        maxTokens: 6000,
        problems: outlineProblems,
      },
      signal,
    )
    this.persist(input.projectId, BP_SECTION_KEYS.outline, value, {
      required_evidence: value.sections.map((section) => ({
        id: section.id,
        required_evidence: section.required_evidence,
      })),
    })
    return value
  }

  async marketSizing(input: MarketSizingInput, signal?: AbortSignal): Promise<MarketSizing> {
    this.assertProject(input.projectId)
    const value = await requestStructured(
      this.ctx,
      {
        schema: MarketSizingSchema,
        toolName: 'emit_market_sizing',
        toolDescription: '提交 TAM/SAM/SOM、货币、假设与来源；每个数字必须标注来源或假设。',
        parameters: jsonObjectSchema(
          {
            tam: { type: 'number' },
            sam: { type: 'number' },
            som: { type: 'number' },
            currency: { type: 'string' },
            assumptions: { type: 'array', items: { type: 'string' } },
            sources: { type: 'array', items: { type: 'string' } },
          },
          ['tam', 'sam', 'som', 'currency', 'assumptions', 'sources'],
        ),
        prompt: marketSizingPrompt(input.market, input.geography, input.method),
        problems: marketSizingProblems,
      },
      signal,
    )
    const normalized = normalizeMarketSizing(value)
    this.persist(input.projectId, BP_SECTION_KEYS.marketSizing, normalized, {
      sources: normalized.sources,
      assumptions: normalized.assumptions,
    })
    return normalized
  }

  async competitorAnalysis(
    input: CompetitorAnalysisInput,
    signal?: AbortSignal,
  ): Promise<CompetitorAnalysis> {
    this.assertProject(input.projectId)
    const value = await requestStructured(
      this.ctx,
      {
        schema: CompetitorAnalysisSchema,
        toolName: 'emit_competitor_analysis',
        toolDescription: '提交竞争者分析：定位、优势、劣势与可核验证据。',
        parameters: jsonObjectSchema(
          {
            competitors: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  positioning: { type: 'string' },
                  strengths: { type: 'array', items: { type: 'string' } },
                  weaknesses: { type: 'array', items: { type: 'string' } },
                  evidence: { type: 'string' },
                },
                required: ['name', 'positioning', 'strengths', 'weaknesses', 'evidence'],
              },
            },
          },
          ['competitors'],
        ),
        prompt: competitorPrompt(input.market, input.competitors ?? []),
        problems: (analysis) => competitorProblems(analysis, input.competitors),
      },
      signal,
    )
    this.persist(input.projectId, BP_SECTION_KEYS.competitors, value, {
      evidence: value.competitors.map((competitor) => ({
        name: competitor.name,
        evidence: competitor.evidence,
      })),
    })
    return value
  }

  async businessModelCanvas(
    input: BusinessModelCanvasInput,
    signal?: AbortSignal,
  ): Promise<BusinessModelCanvas> {
    this.assertProject(input.projectId)
    const value = await requestStructured(
      this.ctx,
      {
        schema: BusinessModelCanvasSchema,
        toolName: 'emit_business_model_canvas',
        toolDescription: '提交商业模式画布九个模块。',
        parameters: jsonObjectSchema(
          {
            customer_segments: { type: 'array', items: { type: 'string' } },
            value_propositions: { type: 'array', items: { type: 'string' } },
            channels: { type: 'array', items: { type: 'string' } },
            customer_relationships: { type: 'array', items: { type: 'string' } },
            revenue_streams: { type: 'array', items: { type: 'string' } },
            key_resources: { type: 'array', items: { type: 'string' } },
            key_activities: { type: 'array', items: { type: 'string' } },
            key_partners: { type: 'array', items: { type: 'string' } },
            cost_structure: { type: 'array', items: { type: 'string' } },
          },
          [
            'customer_segments',
            'value_propositions',
            'channels',
            'customer_relationships',
            'revenue_streams',
            'key_resources',
            'key_activities',
            'key_partners',
            'cost_structure',
          ],
        ),
        prompt: canvasPrompt(input.idea),
        maxTokens: 5000,
      },
      signal,
    )
    this.persist(input.projectId, BP_SECTION_KEYS.canvas, value, {
      generated_from: input.idea,
    })
    return value
  }

  async gtmPlan(input: GtmPlanInput, signal?: AbortSignal): Promise<GtmPlan> {
    this.assertProject(input.projectId)
    const value = await requestStructured(
      this.ctx,
      {
        schema: GtmPlanSchema,
        toolName: 'emit_gtm_plan',
        toolDescription: '提交 GTM 渠道、预算占比、KPI 与阶段里程碑。',
        parameters: jsonObjectSchema(
          {
            channels: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  role: { type: 'string' },
                  budget_share: { type: 'number' },
                  kpi: { type: 'string' },
                },
                required: ['name', 'role', 'budget_share', 'kpi'],
              },
            },
            milestones: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  phase: { type: 'string' },
                  action: { type: 'string' },
                  metric: { type: 'string' },
                },
                required: ['phase', 'action', 'metric'],
              },
            },
          },
          ['channels', 'milestones'],
        ),
        prompt: gtmPrompt(input.product, input.target, input.budget),
        problems: gtmProblems,
      },
      signal,
    )
    const normalized = normalizeGtmPlan(value)
    this.persist(input.projectId, BP_SECTION_KEYS.gtm, normalized, {
      kpis: normalized.channels.map((channel) => ({ channel: channel.name, kpi: channel.kpi })),
    })
    return normalized
  }

  async financialProjection(
    input: FinancialProjectionInput,
    signal?: AbortSignal,
  ): Promise<FinancialProjection> {
    this.assertProject(input.projectId)
    const value = await requestStructured(
      this.ctx,
      {
        schema: FinancialProjectionSchema,
        toolName: 'emit_financial_projection',
        toolDescription: '提交 3-5 年财务预测：收入、成本、毛利、EBITDA、客户数与公式/假设。',
        parameters: jsonObjectSchema(
          {
            years: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  year: { type: 'integer' },
                  revenue: { type: 'number' },
                  cost: { type: 'number' },
                  gross_profit: { type: 'number' },
                  ebitda: { type: 'number' },
                  customers: { type: 'integer' },
                },
                required: ['year', 'revenue', 'cost', 'gross_profit', 'ebitda', 'customers'],
              },
            },
            assumptions: { type: 'array', items: { type: 'string' } },
          },
          ['years', 'assumptions'],
        ),
        prompt: financialPrompt(input.assumptions),
        maxTokens: 5000,
        problems: financialProblems,
      },
      signal,
    )
    const normalized = normalizeFinancialProjection(value)
    this.persist(input.projectId, BP_SECTION_KEYS.financials, normalized, {
      assumptions: normalized.assumptions,
    })
    return normalized
  }

  async review(input: BpReviewInput, signal?: AbortSignal): Promise<BpReview> {
    this.assertProject(input.projectId)
    const value = await requestStructured(
      this.ctx,
      {
        schema: BpReviewSchema,
        toolName: 'emit_bp_review',
        toolDescription: '按 L1-L4 量表提交商业计划书评审：等级、优势、差距与下一步。',
        parameters: jsonObjectSchema(
          {
            level: { type: 'string', enum: ['L1', 'L2', 'L3', 'L4'] },
            strengths: { type: 'array', items: { type: 'string' } },
            gaps: { type: 'array', items: { type: 'string' } },
            next_steps: { type: 'array', items: { type: 'string' } },
          },
          ['level', 'strengths', 'gaps', 'next_steps'],
        ),
        prompt: bpReviewPrompt(input.bp),
        problems: (review) => reviewProblems(review, input.bp),
      },
      signal,
    )
    this.persist(input.projectId, BP_SECTION_KEYS.review, value, {
      level: value.level,
      strengths: value.strengths,
    })
    return value
  }

  async exportPlan(input: ExportBpInput): Promise<{ path: string }> {
    const project = this.getProject(input.projectId)
    if (!project) throw new Error(`bp project not found: ${input.projectId}`)
    const sections = this.listSections(input.projectId)
    const order = new Map<string, number>()
    BP_SECTION_ORDER.forEach((key, index) => order.set(key, index))
    const ordered = [...sections].sort(
      (left, right) => (order.get(left.section) ?? 99) - (order.get(right.section) ?? 99),
    )
    const blocks = ordered.flatMap((section) => sectionBlocks(section))
    if (blocks.length === 0) blocks.push({ text: '（尚未生成章节内容）' })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const safeId = input.projectId.replace(/[^A-Za-z0-9_-]/g, '_')
    const extension = input.format === 'docx' ? 'docx' : 'md'
    const path = resolve(this.db.appHome, 'exports', `bp-${safeId}-${stamp}.${extension}`)
    const title = `商业计划书：${project.idea}`
    if (input.format === 'docx') {
      await writeDocx(path, title, blocks)
    } else {
      await writeMarkdown(path, title, blocks)
    }
    return { path }
  }
}

function bpOutlineTool(ctx: Context) {
  return defineTool({
    name: 'bp_outline',
    description: '生成 8-10 节商业计划书目录，每节包含目的与所需证据。提供 project_id 时持久化到 BP 项目。',
    parameters: {
      idea: { type: 'string', required: true, description: '创业想法' },
      audience: { type: 'string', required: true, description: '目标读者（投资人、评委、课程教师等）' },
      stage: { type: 'string', required: true, description: '项目阶段（想法、原型、MVP、增长等）' },
      project_id: { type: 'string', description: 'BP 项目 ID（可选）；提供时持久化 section' },
    },
    output: {
      schema: BpOutlineOutput,
      render: (_args, value) => jsonContent(value),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return ctx.bp.outline(
        {
          idea: args.idea,
          audience: args.audience,
          stage: args.stage,
          projectId: args.project_id,
        },
        exec.signal,
      )
    },
  })
}

function marketSizingTool(ctx: Context) {
  return defineTool({
    name: 'market_sizing',
    description: '测算 TAM/SAM/SOM；每个数字必须标注来源或假设，没有来源时 sources 包含 assumption。',
    parameters: {
      market: { type: 'string', required: true, description: '市场/品类描述' },
      geography: { type: 'string', required: true, description: '地理范围' },
      method: {
        type: 'string',
        enum: ['top-down', 'bottom-up'],
        required: true,
        description: '测算方法',
      },
      project_id: { type: 'string', description: 'BP 项目 ID（可选）' },
    },
    output: {
      schema: MarketSizingOutput,
      render: (_args, value) => jsonContent(value),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return ctx.bp.marketSizing(
        {
          market: args.market,
          geography: args.geography,
          method: args.method,
          projectId: args.project_id,
        },
        exec.signal,
      )
    },
  })
}

function competitorAnalysisTool(ctx: Context) {
  return defineTool({
    name: 'competitor_analysis',
    description: '分析 2-6 个竞争者的定位、优势、劣势与可核验证据。',
    parameters: {
      market: { type: 'string', required: true, description: '市场/品类描述' },
      competitors: { type: 'array', items: { type: 'string' }, description: '已知竞争者名称（可选）' },
      project_id: { type: 'string', description: 'BP 项目 ID（可选）' },
    },
    output: {
      schema: CompetitorAnalysisOutput,
      render: (_args, value) => jsonContent(value),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return ctx.bp.competitorAnalysis(
        {
          market: args.market,
          competitors: args.competitors,
          projectId: args.project_id,
        },
        exec.signal,
      )
    },
  })
}

function businessModelCanvasTool(ctx: Context) {
  return defineTool({
    name: 'business_model_canvas',
    description: '生成商业模式画布九个模块。',
    parameters: {
      idea: { type: 'string', required: true, description: '创业想法' },
      project_id: { type: 'string', description: 'BP 项目 ID（可选）' },
    },
    output: {
      schema: BusinessModelCanvasOutput,
      render: (_args, value) => jsonContent(value),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return ctx.bp.businessModelCanvas(
        { idea: args.idea, projectId: args.project_id },
        exec.signal,
      )
    },
  })
}

function gtmPlanTool(ctx: Context) {
  return defineTool({
    name: 'gtm_plan',
    description: '生成 GTM 渠道、预算占比、KPI 与阶段里程碑。',
    parameters: {
      product: { type: 'string', required: true, description: '产品/服务' },
      target: { type: 'string', required: true, description: '目标客户' },
      budget: { type: 'number', description: '市场预算（可选）' },
      project_id: { type: 'string', description: 'BP 项目 ID（可选）' },
    },
    output: {
      schema: GtmPlanOutput,
      render: (_args, value) => jsonContent(value),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return ctx.bp.gtmPlan(
        {
          product: args.product,
          target: args.target,
          budget: args.budget,
          projectId: args.project_id,
        },
        exec.signal,
      )
    },
  })
}

function financialProjectionTool(ctx: Context) {
  return defineTool({
    name: 'financial_projection',
    description: '基于假设生成 3-5 年财务预测，逐项展示公式/假设，不编造市场数据。',
    parameters: {
      assumptions: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: '财务假设对象（客单价、客户数、成本结构等）',
      },
      project_id: { type: 'string', description: 'BP 项目 ID（可选）' },
    },
    output: {
      schema: FinancialProjectionOutput,
      render: (_args, value) => jsonContent(value),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return ctx.bp.financialProjection(
        { assumptions: args.assumptions, projectId: args.project_id },
        exec.signal,
      )
    },
  })
}

function bpReviewTool(ctx: Context) {
  return defineTool({
    name: 'bp_review',
    description: '按 L1 复述、L2 套用、L3 情境化、L4 批判性四级量表评审商业计划书，并引用计划书元素作为证据。',
    parameters: {
      bp: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: '商业计划书对象（各章节内容）',
      },
      project_id: { type: 'string', description: 'BP 项目 ID（可选）' },
    },
    output: {
      schema: BpReviewOutput,
      render: (_args, value) => jsonContent(value),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return ctx.bp.review({ bp: args.bp, projectId: args.project_id }, exec.signal)
    },
  })
}

function exportBpTool(ctx: Context) {
  return defineTool({
    name: 'export_bp',
    description: '把 BP 项目的全部章节导出为 docx 或 markdown，写入应用目录的 exports/ 下。',
    parameters: {
      project_id: { type: 'string', required: true, description: 'BP 项目 ID' },
      format: {
        type: 'string',
        enum: ['docx', 'md'],
        required: true,
        description: '导出格式',
      },
    },
    output: {
      schema: ExportBpOutput,
      render: (_args, value) => jsonContent(value),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return ctx.bp.exportPlan({ projectId: args.project_id, format: args.format })
    },
  })
}

export function apply(ctx: Context) {
  ctx.plugin(BpService)
  ctx.inject(['bp'], (scoped) => {
    scoped.tools.register(bpOutlineTool(scoped))
    scoped.tools.register(marketSizingTool(scoped))
    scoped.tools.register(competitorAnalysisTool(scoped))
    scoped.tools.register(businessModelCanvasTool(scoped))
    scoped.tools.register(gtmPlanTool(scoped))
    scoped.tools.register(financialProjectionTool(scoped))
    scoped.tools.register(bpReviewTool(scoped))
    scoped.tools.register(exportBpTool(scoped))
  })
}
