import type { Page } from 'playwright'
import { ChatEventCollector } from './chat-events.js'
import type {
  AnswerInput,
  AnswerSetInput,
  AnswerSetResponse,
  Artifact,
  Chapter,
  ChatInput,
  ChatMessage,
  ChatSession,
  HealthResponse,
  IpcCall,
  KnowledgePoint,
  MemoryFact,
  NewsArticle,
  ProfileEvidence,
  PublicSettings,
  SettingsInput,
  Student,
  TurnResponse,
} from './types.js'

interface BridgeCall {
  fn: string
  args: unknown[]
}

function preview(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text.length > 300 ? `${text.slice(0, 300)}…` : text
  } catch {
    return String(value)
  }
}

/**
 * `window.learning` 的强类型封装。所有断言优先走这一层：
 * 每次调用都记入 ipc 日志，失败取证时原样落盘。
 */
export class LearningClient {
  readonly calls: IpcCall[] = []
  readonly events: ChatEventCollector
  lastRequestId = ''
  private requestSeq = 0

  constructor(private readonly page: Page, events = new ChatEventCollector()) {
    this.events = events
  }

  async connect(): Promise<void> {
    await this.events.attach(this.page)
  }

  private async bridge<T>(fn: string, args: unknown[], method: IpcCall['method'], detail: string): Promise<T> {
    const started = Date.now()
    const seq = this.calls.length + 1
    try {
      const result = await this.page.evaluate(async (call: BridgeCall) => {
        const api = (window as unknown as { learning?: Record<string, unknown> }).learning
        if (!api) throw new Error('window.learning 不存在：preload 未注入')
        const member = call.fn.split('.').reduce<unknown>((target, key) => {
          if (target === null || target === undefined) return undefined
          return (target as Record<string, unknown>)[key]
        }, api)
        if (typeof member !== 'function') throw new Error(`window.learning.${call.fn} 不是函数`)
        return await (member as (...inner: unknown[]) => Promise<unknown>).apply(api, call.args)
      }, { fn, args })
      this.calls.push({
        seq,
        method,
        detail,
        ok: true,
        durationMs: Date.now() - started,
        at: new Date(started).toISOString(),
        resultPreview: preview(result),
      })
      return result as T
    } catch (error) {
      this.calls.push({
        seq,
        method,
        detail,
        ok: false,
        durationMs: Date.now() - started,
        at: new Date(started).toISOString(),
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  newRequestId(prefix = 'req'): string {
    this.requestSeq += 1
    this.lastRequestId = `${prefix}_${Date.now().toString(36)}_${this.requestSeq}`
    return this.lastRequestId
  }

  async invoke<T = unknown>(method: string, input?: unknown): Promise<T> {
    return await this.bridge<T>('invoke', [method, input], 'invoke', method)
  }

  async health(): Promise<HealthResponse> {
    return await this.bridge<HealthResponse>('health', [], 'health', 'health')
  }

  async chat(input: ChatInput): Promise<TurnResponse> {
    const requestId = input.requestId ?? this.newRequestId('chat')
    this.lastRequestId = requestId
    return await this.bridge<TurnResponse>('chat', [{ ...input, requestId }], 'chat', `chat ${requestId}`)
  }

  async cancel(requestId: string): Promise<{ cancelled: boolean }> {
    return await this.bridge<{ cancelled: boolean }>('cancel', [requestId], 'cancel', requestId)
  }

  async answer(input: AnswerInput): Promise<unknown> {
    return await this.bridge('answer', [input], 'answer', input.questionId)
  }

  async answerSet(input: AnswerSetInput): Promise<AnswerSetResponse> {
    return await this.bridge<AnswerSetResponse>('answerSet', [input], 'answerSet', input.artifactId)
  }

  async settingsGet(): Promise<PublicSettings> {
    return await this.bridge<PublicSettings>('settings.get', [], 'settings.get', 'get')
  }

  async settingsSet(value: SettingsInput): Promise<PublicSettings> {
    return await this.bridge<PublicSettings>('settings.set', [value], 'settings.set', preview(value))
  }

  async studentCurrent(): Promise<Student> {
    return await this.invoke<Student>('student.current')
  }

  async chapters(): Promise<Chapter[]> {
    return await this.invoke<Chapter[]>('chapters.list')
  }

  async kps(chapterId: string): Promise<KnowledgePoint[]> {
    return await this.invoke<KnowledgePoint[]>('kps.list', { chapter: chapterId, limit: 1000 })
  }

  async newsList(input?: Record<string, unknown>): Promise<NewsArticle[]> {
    return await this.invoke<NewsArticle[]>('news.list', input)
  }

  async newsStatus(): Promise<Record<string, unknown>> {
    return await this.invoke<Record<string, unknown>>('news.status')
  }

  async artifactsList(): Promise<Artifact[]> {
    return await this.invoke<Artifact[]>('artifacts.list')
  }

  async artifactGet(id: string): Promise<Artifact> {
    return await this.invoke<Artifact>('artifacts.get', { artifactId: id })
  }

  async artifactsExport(id: string, format: 'md' | 'docx' | 'html'): Promise<{ path: string }> {
    return await this.invoke<{ path: string }>('artifacts.export', { artifactId: id, format })
  }

  async sessions(): Promise<ChatSession[]> {
    return await this.invoke<ChatSession[]>('chat.sessions')
  }

  async messages(sessionId: string): Promise<ChatMessage[]> {
    return await this.invoke<ChatMessage[]>('chat.messages', { sessionId })
  }

  async memoryFacts(): Promise<MemoryFact[]> {
    return await this.invoke<MemoryFact[]>('memory.facts')
  }

  async memoryUpsert(input: { kind: string; key: string; value: unknown }): Promise<MemoryFact> {
    return await this.invoke<MemoryFact>('memory.upsert', input)
  }

  async memoryDelete(id: string): Promise<unknown> {
    return await this.invoke('memory.delete', { factId: id })
  }

  async profileEvidence(): Promise<ProfileEvidence[]> {
    return await this.invoke<ProfileEvidence[]>('profile.evidence')
  }

  async profileGet(): Promise<Record<string, unknown>> {
    return await this.invoke<Record<string, unknown>>('profile.get')
  }

  async profileSnapshot(input?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.invoke<Record<string, unknown>>('profile.snapshot', input)
  }

  async profileReview(evidenceId: string, status: 'reviewed' | 'rejected', note = ''): Promise<{ ok: boolean }> {
    return await this.invoke<{ ok: boolean }>('profile.review', { evidenceId, status, note })
  }

  async agentTurns(sessionId = '', limit = 50): Promise<Record<string, unknown>[]> {
    return await this.invoke<Record<string, unknown>[]>('agent.turns', { sessionId, limit })
  }

  async agentLedger(): Promise<{ items: Record<string, unknown>[]; counts: Record<string, number> }> {
    return await this.invoke('agent.ledger')
  }

  async agentRetry(input: Record<string, unknown>): Promise<unknown> {
    return await this.invoke('agent.retry', input)
  }
}

export async function createClient(page: Page): Promise<LearningClient> {
  const client = new LearningClient(page)
  await client.connect()
  return client
}
