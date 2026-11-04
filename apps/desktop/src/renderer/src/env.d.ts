/** Mirrors `PublicSettings` in `src/main/settings.ts`. */
interface PublicSettingsView {
  hasApiKey: boolean
  model: string
  apiKeySource?: 'env' | 'stored' | 'none'
  /** Set when the settings file exists but cannot be parsed. */
  configError?: string
}

interface LearningBridge {
  capabilities?: {
    localFiles: boolean
    revealFiles: boolean
    downloadArtifacts: 'desktop' | 'browser'
  }
  downloadArtifact?: (artifactId: string, format: 'md' | 'docx' | 'html') => Promise<{ filename: string }>
  invoke(method: string, input: unknown): Promise<unknown>
  chat(input: {
    studentId?: string
    sessionId?: string
    message: string
    scopeOverride?: unknown
    chapterId?: string
    requestId?: string
  }): Promise<unknown>
  /** 订阅本轮执行进度；返回取消订阅函数。 */
  onChatEvent?(handler: (event: unknown) => void): () => void
  answer(input: {
    studentId?: string
    sessionId: string
    questionId: string
    answer: string
    artifactId?: string
    chapterId?: string
  }): Promise<unknown>
  answerSet(input: {
    studentId?: string
    sessionId: string
    artifactId: string
    answers: Array<{ questionId: string; answer: string }>
    chapterId?: string
  }): Promise<unknown>
  settings: {
    get(): Promise<PublicSettingsView>
    set(value: { apiKey?: string; model?: string; clearApiKey?: boolean }): Promise<PublicSettingsView>
  }
}

declare global {
  interface Window {
    learning: LearningBridge
  }
}

export {}
