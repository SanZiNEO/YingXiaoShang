import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { randomUUID } from 'node:crypto'
import type {} from '@learning-agent/db'
import type {} from '@learning-agent/matcher'
import type {} from '@learning-agent/questions'
import type {} from '@learning-agent/research'
import type {} from '@learning-agent/bp'
import type {
  BpProject,
  CaseMatch,
  Chapter,
  IdeologyMatch,
  IdeologyPoint,
  KnowledgePoint,
  NewsArticle,
  Question,
  ResearchProject,
} from '@learning-agent/shared'

declare module '@deepseek-ai/cordis' {
  interface Context {
    learning: LearningRemote
  }
}

const STUDENT_ID = 'student_default'

export class LearningRemote extends TypertRemoteService {
  static inject = ['learningDb', 'agents', 'matcher', 'questionSmith', 'research', 'bp']

  constructor(ctx: Context) {
    super(ctx, 'learning')
  }

  @Remote
  async listChapters(_input: Record<string, never>): Promise<Chapter[]> {
    return this.ctx.learningDb.listChapters()
  }

  @Remote
  async listKps(input: { chapter?: string; query?: string; limit?: number }): Promise<KnowledgePoint[]> {
    const limit = input.limit ?? 50
    if (input.query && input.query.trim().length > 0) {
      return this.ctx.learningDb.searchKps(input.query, input.chapter, limit)
    }
    return input.chapter
      ? this.ctx.learningDb.listKpsByChapter(input.chapter).slice(0, limit)
      : this.ctx.learningDb.searchKps('', undefined, limit)
  }

  @Remote
  async getKp(input: { kpId: string }): Promise<KnowledgePoint | undefined> {
    return this.ctx.learningDb.getKp(input.kpId)
  }

  @Remote
  async listIdeology(_input: Record<string, never>): Promise<IdeologyPoint[]> {
    return this.ctx.learningDb.listIdeology()
  }

  @Remote
  async listNews(input: { source?: string; since?: string; limit?: number }): Promise<NewsArticle[]> {
    return this.ctx.learningDb.listNews(input)
  }

  @Remote
  async getNews(input: { articleId: string }): Promise<{
    article: NewsArticle
    matches: CaseMatch[]
    ideology: IdeologyMatch[]
  } | undefined> {
    const article = this.ctx.learningDb.getNews(input.articleId)
    if (!article) return undefined
    return {
      article,
      matches: this.ctx.learningDb.getMatches(input.articleId),
      ideology: this.ctx.learningDb.getIdeologyMatches(input.articleId),
    }
  }

  @Remote
  async matchNews(input: { articleId: string; topK?: number }): Promise<{ matches: CaseMatch[] }> {
    const result = await this.ctx.matcher.match({ articleId: input.articleId, topK: input.topK })
    return { matches: result.matches }
  }

  @Remote
  async generateQuestions(input: {
    sourceType: 'news' | 'kp' | 'text' | 'resource'
    sourceId?: string
    text?: string
    kpIds?: string[]
    types?: Question['type'][]
    difficulty?: 1 | 2 | 3
    count?: number
  }): Promise<Question[]> {
    return this.ctx.questionSmith.generate(input)
  }

  @Remote
  async listQuestions(input: { kpId?: string; limit?: number }): Promise<Question[]> {
    return this.ctx.learningDb.listQuestions(input)
  }

  @Remote
  async createResearchProject(input: { brief: string }): Promise<{ id: string }> {
    return { id: this.ctx.learningDb.createResearchProject({ studentId: STUDENT_ID, brief: input.brief }) }
  }

  @Remote
  async getResearchProject(input: { id: string }): Promise<ResearchProject | undefined> {
    return this.ctx.learningDb.getResearchProject(input.id)
  }

  @Remote
  async listResearchProjects(_input: Record<string, never>): Promise<ResearchProject[]> {
    return this.ctx.learningDb.listResearchProjects(STUDENT_ID)
  }

  @Remote
  async createBpProject(input: { idea: string }): Promise<{ id: string }> {
    return { id: this.ctx.learningDb.createBpProject({ studentId: STUDENT_ID, idea: input.idea }) }
  }

  @Remote
  async getBpProject(input: { id: string }): Promise<BpProject | undefined> {
    return this.ctx.learningDb.getBpProject(input.id)
  }

  @Remote
  async listBpProjects(_input: Record<string, never>): Promise<BpProject[]> {
    return this.ctx.learningDb.listBpProjects(STUDENT_ID)
  }

  @Remote
  async exportQuestions(input: { questionIds: string[]; format: 'json' | 'csv' | 'docx' }): Promise<{ path: string }> {
    return this.ctx.questionSmith.exportQuestions(input.questionIds, input.format)
  }

  @Remote
  async exportBp(input: { projectId: string; format: 'docx' | 'md' }): Promise<{ path: string }> {
    return this.ctx.bp.exportPlan({ projectId: input.projectId, format: input.format })
  }

  @Remote
  async startSession(input: {
    presetId: 'knowledge-news' | 'question-gen' | 'research' | 'bp'
  }): Promise<{ sessionId: string }> {
    const sessionId = `learning_${randomUUID()}` as SessionId
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: {
        cwd: this.ctx.learningDb.appHome,
        agentPreset: input.presetId,
      },
    })
    return { sessionId: String(handle.agent.id) }
  }
}

export const name = 'learning-api'
export const inject = ['learningDb', 'agents', 'matcher', 'questionSmith', 'research', 'bp']

export default LearningRemote
