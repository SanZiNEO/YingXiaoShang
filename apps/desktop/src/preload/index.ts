import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('learning', {
  capabilities: {
    localFiles: true,
    revealFiles: true,
    downloadArtifacts: 'desktop',
  },
  invoke: (method: string, input: unknown) => ipcRenderer.invoke('learning:invoke', method, input),
  chat: (input: {
    studentId?: string
    sessionId?: string
    message: string
    scopeOverride?: unknown
    chapterId?: string
    requestId?: string
  }) => ipcRenderer.invoke('learning:chat', input),
  onChatEvent: (handler: (event: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown): void => handler(payload)
    ipcRenderer.on('learning:chat-event', listener)
    return () => ipcRenderer.removeListener('learning:chat-event', listener)
  },
  answer: (input: {
    studentId?: string
    sessionId: string
    questionId: string
    answer: string
    artifactId?: string
    chapterId?: string
  }) => ipcRenderer.invoke('learning:answer', input),
  answerSet: (input: {
    studentId?: string
    sessionId: string
    artifactId: string
    answers: Array<{ questionId: string; answer: string }>
    chapterId?: string
  }) => ipcRenderer.invoke('learning:answer-set', input),
  settings: {
    get: () => ipcRenderer.invoke('learning:settings:get'),
    set: (value: { apiKey?: string; model?: string; clearApiKey?: boolean }) => ipcRenderer.invoke('learning:settings:set', value),
  },
})
