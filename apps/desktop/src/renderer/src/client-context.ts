import type {
  BpProject,
  CaseMatch,
  Chapter,
  IdeologyMatch,
  IdeologyPoint,
  KnowledgePoint,
  NewsArticle,
  Question,
  QuestionType,
  ResearchProject,
} from '@learning-agent/shared'

export interface RemoteResult<T> {
  ok: boolean
  value?: T
  error?: unknown
}

export interface LearningClient {
  listChapters(input: Record<string, never>): Promise<RemoteResult<Chapter[]>>
  listKps(input: { chapter?: string; query?: string; limit?: number }): Promise<RemoteResult<KnowledgePoint[]>>
  getKp(input: { kpId: string }): Promise<RemoteResult<KnowledgePoint | undefined>>
  listIdeology(input: Record<string, never>): Promise<RemoteResult<IdeologyPoint[]>>
  listNews(input: { source?: string; since?: string; limit?: number }): Promise<RemoteResult<NewsArticle[]>>
  getNews(input: { articleId: string }): Promise<RemoteResult<{
    article: NewsArticle
    matches: CaseMatch[]
    ideology: IdeologyMatch[]
  } | undefined>>
  matchNews(input: { articleId: string; topK?: number }): Promise<RemoteResult<{ matches: CaseMatch[] }>>
  generateQuestions(input: {
    sourceType: 'news' | 'kp' | 'text' | 'resource'
    sourceId?: string
    text?: string
    kpIds?: string[]
    types?: QuestionType[]
    difficulty?: 1 | 2 | 3
    count?: number
  }): Promise<RemoteResult<Question[]>>
  listQuestions(input: { kpId?: string; limit?: number }): Promise<RemoteResult<Question[]>>
  createResearchProject(input: { brief: string }): Promise<RemoteResult<{ id: string }>>
  listResearchProjects(input: Record<string, never>): Promise<RemoteResult<ResearchProject[]>>
  getResearchProject(input: { id: string }): Promise<RemoteResult<ResearchProject | undefined>>
  createBpProject(input: { idea: string }): Promise<RemoteResult<{ id: string }>>
  listBpProjects(input: Record<string, never>): Promise<RemoteResult<BpProject[]>>
  getBpProject(input: { id: string }): Promise<RemoteResult<BpProject | undefined>>
  exportQuestions(input: { questionIds: string[]; format: 'json' | 'csv' | 'docx' }): Promise<RemoteResult<{ path: string }>>
  exportBp(input: { projectId: string; format: 'docx' | 'md' }): Promise<RemoteResult<{ path: string }>>
  startSession(input: { presetId: 'knowledge-news' | 'question-gen' | 'research' | 'bp' }): Promise<RemoteResult<{ sessionId: string }>>
}

export interface ClientContext {
  slots: {
    register(options: Record<string, unknown>, component: unknown): () => void
    inject(key: string, callback: () => () => void): () => void
  }
  layout: {
    selectPanel(id: string): void
  }
  uiWorkspace: {
    startSession(workspaceId?: string, options?: { agentPreset?: string; prompt?: string }): void
  }
  remote?: {
    learning?: LearningClient
  }
}

export class RemoteUnavailableError extends Error {
  constructor() {
    super('数据接口尚未挂载；请先在对话中提出你的需求。')
    this.name = 'RemoteUnavailableError'
  }
}

export async function callLearning<T>(
  client: ClientContext,
  method: keyof LearningClient,
  input: unknown,
): Promise<T> {
  const fn = client.remote?.learning?.[method] as
    | ((value: unknown) => Promise<RemoteResult<T>>)
    | undefined
  if (!fn) throw new RemoteUnavailableError()
  const result = await fn(input)
  if (!result.ok) throw new Error(remoteErrorMessage(result.error))
  return result.value as T
}

function remoteErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    if (typeof record.message === 'string') return record.message
    if (typeof record.code === 'string') return record.code
  }
  return '远程调用失败'
}

export function startPreset(
  client: ClientContext,
  preset: 'knowledge-news' | 'question-gen' | 'research' | 'bp',
  prompt?: string,
) {
  client.uiWorkspace.startSession(undefined, { agentPreset: preset, prompt })
}

export function panel(client: ClientContext, id: 'knowledge' | 'question' | 'research' | 'bp') {
  client.layout.selectPanel(id)
}
