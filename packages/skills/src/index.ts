import { Service, type Context } from '@deepseek-ai/cordis'
import type { Artifact, Question, QuestionType, SkillRow } from '@learning-agent/shared'
import type {} from '@learning-agent/db'
import type {} from '@learning-agent/artifacts'
import type {} from '@learning-agent/profile'
import type {} from '@learning-agent/questions'
import type {} from '@learning-agent/research'
import type {} from '@learning-agent/bp'
import type {} from '@learning-agent/matcher'

declare module '@deepseek-ai/cordis' {
  interface Context {
    skills: SkillService
  }
}

export interface SkillContext {
  studentId: string
  sessionId?: string
  chapterId?: string
}

export interface SkillResult {
  skillId: string
  summary: string
  artifact?: Artifact
}

interface SkillDefinition {
  id: string
  expertId: string
  name: string
  description: string
  templateId: string
  inputSchema: Record<string, unknown>
}

const DEFINITIONS: SkillDefinition[] = [
  {
    id: 'question.generate_set',
    expertId: 'question-gen',
    name: '生成题目集',
    description: '从知识点、新闻、教材资源或自定义文本生成题目，校验后导出。',
    templateId: 'question_set',
    inputSchema: {
      type: 'object',
      properties: {
        sourceType: { type: 'string', enum: ['kp', 'news', 'text', 'resource'] },
        sourceId: { type: 'string' },
        text: { type: 'string' },
        kpIds: { type: 'array', items: { type: 'string' } },
        types: { type: 'array', items: { type: 'string' } },
        difficulty: { type: 'integer' },
        count: { type: 'integer' },
      },
    },
  },
  {
    id: 'research.design',
    expertId: 'research',
    name: '生成研究设计',
    description: '从 brief 生成研究问题、目标、方法取舍与抽样设计。',
    templateId: 'research_design',
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string' },
        population: { type: 'string' },
        constraints: { type: 'array', items: { type: 'string' } },
      },
      required: ['brief'],
    },
  },
  {
    id: 'bp.outline',
    expertId: 'bp',
    name: '生成商业计划书目录',
    description: '从商业想法生成 8–10 节 BP 目录与证据要求。',
    templateId: 'bp_outline',
    inputSchema: {
      type: 'object',
      properties: {
        idea: { type: 'string' },
        audience: { type: 'string' },
        stage: { type: 'string' },
      },
      required: ['idea'],
    },
  },
  {
    id: 'growth.card',
    expertId: 'profile',
    name: '生成成长卡',
    description: '根据证据账本生成四维能力成长卡。',
    templateId: 'growth_card',
    inputSchema: {
      type: 'object',
      properties: {
        chapterId: { type: 'string' },
      },
    },
  },
  {
    id: 'news.analyze',
    expertId: 'knowledge-news',
    name: '分析新闻中的营销知识点',
    description: '把一条新闻匹配到消费者行为知识点与课程思政点，并给出原文证据。',
    templateId: 'case_analysis',
    inputSchema: {
      type: 'object',
      properties: {
        articleId: { type: 'string' },
        query: { type: 'string' },
      },
    },
  },
]

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function questionLine(question: Question, index: number): string {
  const options = question.options.length > 0
    ? `\n${question.options.map((option, optionIndex) => `   ${String.fromCharCode(65 + optionIndex)}. ${option}`).join('\n')}`
    : ''
  return `${index + 1}. [${question.type}] ${question.stem}${options}`
}


function isOfflineError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /DEEPSEEK_API_KEY|fetch failed|ECONN|ENOTFOUND|401|403|404|429|5\d\d|未通过校验|模型未返回/i.test(message)
}

function offlineResearch(briefText: string): {
  brief: { research_question: string; objectives: string[]; constraints: string[]; assumptions: string[] }
  method: { method: string; rationale: string; alternatives: Array<{ method: string; tradeoff: string }> }
  sampling: { sampling_frame: string; technique: string; target_size: number; recruitment: string; risks: string[] }
} {
  const topic = briefText.replace(/[。！？?]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)
  return {
    brief: {
      research_question: `在“${topic}”情境下，目标消费者的核心需求、决策因素与主要阻碍分别是什么？`,
      objectives: [
        '识别目标消费者的核心需求与决策场景。',
        '比较影响选择的关键因素及其相对权重。',
        '找出阻碍购买或使用的主要摩擦点。',
        '形成可用于产品或传播决策的证据链。',
      ],
      constraints: ['课程作业时间有限', '以可接触的便利样本为主', '需遵守知情同意与隐私保护'],
      assumptions: ['目标消费者可在校园或社交平台接触', '学生可独立完成招募与访谈'],
    },
    method: {
      method: 'mixed',
      rationale: '先用定性访谈发现需求与阻碍，再用小样本问卷验证因素权重；两者结合能兼顾解释深度与覆盖范围。',
      alternatives: [
        { method: 'qualitative', tradeoff: '解释力强但样本小，难以估计比例。' },
        { method: 'quantitative', tradeoff: '覆盖广但难以发现未预设的需求。' },
      ],
    },
    sampling: {
      sampling_frame: '校园内目标专业学生与近三个月有过相关购买/使用行为的消费者。',
      technique: '目的抽样 + 配额抽样；定性 12 人，定量 60 人。',
      target_size: 72,
      recruitment: '课程群、校园社团与社交平台招募；说明研究目的、匿名处理和退出权。',
      risks: ['便利样本覆盖偏差', '自报数据与社会赞许偏差', '期末时间冲突导致无应答'],
    },
  }
}

function offlineBpOutline(idea: string): {
  sections: Array<{ id: string; title: string; purpose: string; required_evidence: string[] }>
} {
  return {
    sections: [
      { id: 's1', title: '执行摘要', purpose: `用一页说明「${idea}」的机会、方案与关键数字。`, required_evidence: ['一句话价值主张', '目标市场与规模', '核心财务假设'] },
      { id: 's2', title: '问题与机会', purpose: '说明用户痛点、现有替代方案与机会窗口。', required_evidence: ['用户访谈原话', '替代方案对比', '市场变化数据'] },
      { id: 's3', title: '产品与服务', purpose: '说明提供什么、解决哪个环节、最小可行产品是什么。', required_evidence: ['产品原型或流程图', '功能优先级', '使用场景'] },
      { id: 's4', title: '市场与竞争', purpose: '界定 TAM/SAM/SOM 与主要竞争者。', required_evidence: ['市场规模来源', '竞品定位表', '差异化证据'] },
      { id: 's5', title: '商业模式', purpose: '说明收入来源、成本结构与关键伙伴。', required_evidence: ['收入公式', '单位经济模型', '合作方清单'] },
      { id: 's6', title: '营销与增长', purpose: '说明获客渠道、预算分配与阶段指标。', required_evidence: ['渠道假设', 'CAC/转化率假设', '试点计划'] },
      { id: 's7', title: '运营与团队', purpose: '说明交付流程、关键岗位与里程碑。', required_evidence: ['运营流程图', '岗位职责', '90 天计划'] },
      { id: 's8', title: '财务预测', purpose: '给出三年收入、成本、毛利与现金流假设。', required_evidence: ['假设表', '敏感性分析', '盈亏平衡点'] },
      { id: 's9', title: '风险与退出', purpose: '列出主要风险、验证方式与退出条件。', required_evidence: ['风险清单', '触发条件', '应对方案'] },
    ],
  }
}

function offlineGrowthCard(
  summary: Array<{ competency: { id: string; name: string }; level: string; confidence: number; evidenceCount: number; status: string }>,
  evidence: Array<{ competency_id: string; level: string; strength: string; excerpt: string; rationale: string }>,
): string {
  return [
    '# 能力成长卡',
    '',
    ...summary.map((item) => {
      const rows = evidence.filter((row) => row.competency_id === item.competency.id).slice(0, 3)
      return [
        `## ${item.competency.name}`,
        `当前水平：${item.level}；置信度 ${item.confidence}；证据 ${item.evidenceCount} 条；结论：${item.status}。`,
        item.evidenceCount === 0 ? '证据不足：本维度暂不给出确定结论。' : '',
        ...rows.map((row) => `- ${row.level}/${row.strength}：${row.excerpt}（${row.rationale}）`),
        `下一步：${item.evidenceCount === 0 ? '先完成一次案例判断或前测。' : '补充反例、失败模式或迁移情境。'}`,
        '',
      ].filter((line) => line.length > 0).join('\n')
    }),
  ].join('\n')
}

export class SkillService extends Service {
  static inject = ['learningDb', 'questionSmith', 'research', 'bp', 'profile', 'artifacts', 'matcher']

  constructor(ctx: Context) {
    super(ctx, 'skills')
    const now = new Date().toISOString()
    const rows: SkillRow[] = DEFINITIONS.map((definition) => ({
      id: definition.id,
      expert_id: definition.expertId,
      name: definition.name,
      description: definition.description,
      input_schema_json: JSON.stringify(definition.inputSchema),
      template_id: definition.templateId,
      enabled: true,
      updated_at: now,
    }))
    ctx.learningDb.upsertSkills(rows)
  }

  list(): SkillDefinition[] {
    return DEFINITIONS
  }

  async run(skillId: string, input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    switch (skillId) {
      case 'question.generate_set':
        return this.generateQuestions(input, context)
      case 'research.design':
        return this.generateResearch(input, context)
      case 'bp.outline':
        return this.generateBp(input, context)
      case 'growth.card':
        return this.generateGrowth(input, context)
      case 'news.analyze':
        return this.analyzeNews(input, context)
      default:
        throw new Error(`unknown skill: ${skillId}`)
    }
  }

  private async generateQuestions(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const sourceType = stringValue(input.sourceType) as 'kp' | 'news' | 'text' | 'resource' | undefined
    const sourceId = stringValue(input.sourceId)
    const text = stringValue(input.text)
    if (!sourceType) throw new Error('需要来源类型：kp/news/text/resource')
    if (sourceType !== 'text' && !sourceId) throw new Error('需要来源 ID')
    if (sourceType === 'text' && !text) throw new Error('需要自定义文本')
    const types = Array.isArray(input.types)
      ? input.types.filter((item): item is QuestionType => typeof item === 'string')
      : ['简答' as QuestionType]
    const count = typeof input.count === 'number' ? input.count : 2
    const difficulty = typeof input.difficulty === 'number' && input.difficulty >= 1 && input.difficulty <= 3
      ? input.difficulty as 1 | 2 | 3
      : 2
    const questions = await this.ctx.questionSmith.generate({
      sourceType,
      sourceId,
      text,
      kpIds: Array.isArray(input.kpIds) ? input.kpIds.map(String) : undefined,
      types,
      difficulty,
      count,
    })
    const sourceName = sourceType === 'kp'
      ? this.ctx.learningDb.getKp(sourceId ?? '')?.name ?? '课程知识点'
      : sourceType === 'news'
        ? this.ctx.learningDb.getNews(sourceId ?? '')?.title ?? '新闻材料'
        : sourceType === 'resource' ? '教材资源' : '自定义文本'
    const content = await this.ctx.artifacts.renderTemplate('question_set', {
      intro: `来源：${sourceName}；共 ${questions.length} 道题；难度 ${difficulty}。`,
      questions: questions.map(questionLine).join('\n\n'),
      answers: '',
    })
    const artifact = await this.ctx.artifacts.create({
      studentId: context.studentId,
      sessionId: context.sessionId,
      skillId: 'question.generate_set',
      templateId: 'question_set',
      type: 'question_set',
      title: `题目集 · ${sourceName}`,
      format: 'docx',
      content,
      schemaVersion: 'QuestionSet@1',
      contentJson: {
        intro: `本组 ${questions.length} 道题，先独立作答，交卷后查看反馈。`,
        questions: questions.map((question) => ({
          id: question.id,
          type: question.type,
          stem: question.stem,
          options: question.options,
          answer: question.answer,
          explanation: question.explanation,
          kpIds: question.kp_ids,
          difficulty: question.difficulty,
        })),
      },
      sourceRefs: [...new Set([
        sourceId,
        ...(Array.isArray(input.kpIds) ? input.kpIds.map(String) : []),
        ...questions.flatMap((question) => question.kp_ids),
      ].filter((id): id is string => typeof id === 'string' && id.length > 0))],
    })
    return {
      skillId: 'question.generate_set',
      summary: `已生成 ${questions.length} 道题，产物已保存。`,
      artifact,
    }
  }

  private async generateResearch(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const briefText = stringValue(input.brief)
    if (!briefText) throw new Error('需要研究 brief')
    let brief: { research_question: string; objectives: string[]; constraints: string[]; assumptions: string[] }
    let method: { method: string; rationale: string; alternatives: Array<{ method: string; tradeoff: string }> }
    let sampling: { sampling_frame: string; technique: string; target_size: number; recruitment: string; risks: string[] }
    try {
      brief = await this.ctx.research.parseBrief({ brief: briefText })
      method = await this.ctx.research.chooseMethod({
        researchQuestion: brief.research_question,
        constraints: brief.constraints,
      })
      sampling = await this.ctx.research.designSampling({
        population: stringValue(input.population) ?? '目标消费者',
        method: method.method,
        constraints: brief.constraints,
      })
    } catch (error) {
      if (!isOfflineError(error)) throw error
      const offline = offlineResearch(briefText)
      brief = offline.brief
      method = offline.method
      sampling = offline.sampling
    }
    const content = await this.ctx.artifacts.renderTemplate('research_design', {
      research_question: brief.research_question,
      objectives: brief.objectives.map((item) => `- ${item}`).join('\n'),
      method: `方法：${method.method}\n理由：${method.rationale}\n替代方案：${method.alternatives.map((item) => `${item.method}（${item.tradeoff}）`).join('；')}`,
      sampling: `抽样框：${sampling.sampling_frame}\n技术：${sampling.technique}\n目标样本：${sampling.target_size}\n招募：${sampling.recruitment}\n风险：${sampling.risks.join('；')}`,
      next_steps: '下一步：确认研究问题与假设，再生成问卷/访谈提纲。',
    })
    const relatedKps = this.ctx.learningDb.searchKps(briefText, context.chapterId, 3)
    const artifact = await this.ctx.artifacts.create({
      studentId: context.studentId,
      sessionId: context.sessionId,
      skillId: 'research.design',
      templateId: 'research_design',
      type: 'research_design',
      title: '研究设计',
      format: 'docx',
      content,
      sourceRefs: relatedKps.map((kp) => kp.id),
    })
    return {
      skillId: 'research.design',
      summary: `已生成研究设计：${brief.research_question}`,
      artifact,
    }
  }

  private async generateBp(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const idea = stringValue(input.idea)
    if (!idea) throw new Error('需要商业想法')
    let outline: { sections: Array<{ id: string; title: string; purpose: string; required_evidence: string[] }> }
    try {
      outline = await this.ctx.bp.outline({
        idea,
        audience: stringValue(input.audience) ?? '课程教师',
        stage: stringValue(input.stage) ?? '课程作业',
      })
    } catch (error) {
      if (!isOfflineError(error)) throw error
      outline = offlineBpOutline(idea)
    }
    const content = await this.ctx.artifacts.renderTemplate('bp_outline', {
      idea,
      sections: outline.sections.map((section) => `### ${section.title}\n目的：${section.purpose}\n所需证据：${section.required_evidence.join('；')}`).join('\n\n'),
      evidence: '每个数字必须标 source 或 assumption；没有来源时写“假设”。',
    })
    const relatedKps = this.ctx.learningDb.searchKps(idea, undefined, 3)
    const artifact = await this.ctx.artifacts.create({
      studentId: context.studentId,
      sessionId: context.sessionId,
      skillId: 'bp.outline',
      templateId: 'bp_outline',
      type: 'bp_outline',
      title: `BP 目录 · ${idea}`,
      format: 'docx',
      content,
      sourceRefs: relatedKps.map((kp) => kp.id),
    })
    return {
      skillId: 'bp.outline',
      summary: `已生成 ${outline.sections.length} 节 BP 目录。`,
      artifact,
    }
  }

  private async analyzeNews(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const articleId = stringValue(input.articleId)
    let article = articleId ? this.ctx.learningDb.getNews(articleId) : undefined
    if (!article) {
      const query = stringValue(input.query) ?? ''
      const candidates = this.ctx.learningDb.listNews({ limit: 30 })
      article = candidates.find((item) => query.includes(item.title)) ?? candidates[0]
    }
    if (!article) throw new Error('新闻库为空，请先导入新闻')
    const matched = await this.ctx.matcher.match({ articleId: article.id, topK: 3 })
    const kps = matched.matches.flatMap((match) => {
      const kp = this.ctx.learningDb.getKp(match.kp_id)
      return kp ? [{ match, kp }] : []
    })
    const ideologyPoints = this.ctx.learningDb.listIdeology()
    const ideology = matched.ideology.flatMap((match) => {
      const point = ideologyPoints.find((item) => item.id === match.ideology_id)
      return point ? [{ match, point }] : []
    })
    const content = [
      `# 新闻分析 · ${article.title}`,
      '',
      `来源：${article.source}｜发布时间：${article.published_at}`,
      article.url ? `链接：${article.url}` : '',
      '',
      '## 新闻摘要',
      article.summary || article.content.slice(0, 300),
      '',
      '## 消费者行为知识点',
      ...(kps.length > 0
        ? kps.map(({ match, kp }) => [
            `### ${kp.name}（${({ core: '核心', example: '例证', mention: '提及' } as const)[match.tag_role]} · 待核对的匹配候选）`,
            `定义：${kp.definition}`,
            `原文证据：${match.evidence_span}`,
            `匹配理由：${match.rationale}`,
          ].join('\n'))
        : ['未找到可靠匹配。可以换一条新闻，或在出题/调研中手动指定知识点。']),
      '',
      '## 课程思政点',
      ...(ideology.length > 0
        ? ideology.map(({ match, point }) => `- ${point.name}：${match.evidence_span}（${match.rationale}）`)
        : ['本条新闻未匹配到课程思政点。']),
      '',
      '## 使用提示',
      '这些匹配是形成性学习线索，不是标准答案。请回到原文核对证据，再判断是否成立。',
    ].filter((line) => line.length > 0).join('\n')
    const artifact = await this.ctx.artifacts.create({
      studentId: context.studentId,
      sessionId: context.sessionId,
      skillId: 'news.analyze',
      templateId: 'case_analysis',
      type: 'case_analysis',
      title: `新闻分析 · ${article.title.slice(0, 24)}`,
      format: 'docx',
      content,
      sourceRefs: [article.id, ...kps.map(({ kp }) => kp.id), ...ideology.map(({ point }) => point.id)],
    })
    return {
      skillId: 'news.analyze',
      summary: `已整理《${article.title}》的 ${kps.length} 个知识点候选与 ${ideology.length} 个思政线索，请回到原文核对，候选不等于结论。`,
      artifact,
    }
  }

  private async generateGrowth(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const chapterId = stringValue(input.chapterId) ?? context.chapterId
    let card = ''
    try {
      card = await this.ctx.profile.generateGrowthCard(context.studentId, chapterId)
    } catch (error) {
      if (!isOfflineError(error)) throw error
      card = offlineGrowthCard(
        this.ctx.profile.growthSummary(context.studentId, chapterId),
        this.ctx.learningDb.listEvidence({ studentId: context.studentId, chapterId, limit: 30 }),
      )
    }
    const content = await this.ctx.artifacts.renderTemplate('growth_card', {
      card,
      evidence_note: '成长卡只依据证据账本；证据不足的维度不应给出确定结论。',
    })
    const evidence = this.ctx.learningDb.listEvidence({ studentId: context.studentId, chapterId, limit: 30 })
    const artifact = await this.ctx.artifacts.create({
      studentId: context.studentId,
      sessionId: context.sessionId,
      skillId: 'growth.card',
      templateId: 'growth_card',
      type: 'growth_card',
      title: `成长卡${chapterId ? ` · ${chapterId}` : ''}`,
      format: 'docx',
      content,
      evidenceIds: evidence.map((item) => item.id),
    })
    return {
      skillId: 'growth.card',
      summary: '已生成能力成长卡。',
      artifact,
    }
  }
}
