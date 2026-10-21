/**
 * Browser implementation of the `window.learning` bridge used by the desktop
 * renderer. Every call is a same-origin JSON request to `server.ts`.
 */

export interface LearningBridge {
  capabilities: {
    localFiles: boolean
    revealFiles: boolean
    downloadArtifacts: 'desktop' | 'browser'
  }
  downloadArtifact(artifactId: string, format: 'md' | 'docx' | 'html'): Promise<{ filename: string }>
  invoke(method: string, input: unknown): Promise<unknown>
  chat(input: {
    studentId?: string
    sessionId?: string
    message: string
    scopeOverride?: unknown
    chapterId?: string
    requestId?: string
  }): Promise<unknown>
  /** 浏览器端暂不推流；桌面端才有逐字输出。 */
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
    get(): Promise<{ hasApiKey: boolean; model: string; apiKeySource?: 'env' | 'stored' | 'none' }>
    set(value: { apiKey?: string; model?: string; clearApiKey?: boolean }): Promise<{ hasApiKey: boolean; model: string; apiKeySource?: 'env' | 'stored' | 'none' }>
  }
}

declare global {
  interface Window {
    learning: LearningBridge
  }
}

/** Envelope written by `server.ts`; the server is the only producer. */
interface ApiEnvelope<T> {
  result?: T
  error?: string
}

const TOKEN_STORAGE_KEY = 'learning-agent.access-token'

function readStoredToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function storeToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    // Private browsing / disabled storage: keep the token for this page only.
  }
}

/**
 * Read a query value without URLSearchParams' form decoding: a raw `+` in the
 * token is a literal plus, not a space. Other reserved characters should still
 * be percent-encoded by the caller. Percent-escapes are decoded once.
 */
function rawSearchParam(name: string): string {
  const query = window.location.search
  if (query.length <= 1) return ''
  for (const chunk of query.slice(1).split('&')) {
    const separator = chunk.indexOf('=')
    const rawKey = separator === -1 ? chunk : chunk.slice(0, separator)
    let key = rawKey
    try {
      key = decodeURIComponent(rawKey)
    } catch {
      // Keep the raw key; malformed escapes are matched literally.
    }
    if (key !== name) continue
    const rawValue = separator === -1 ? '' : chunk.slice(separator + 1)
    try {
      return decodeURIComponent(rawValue)
    } catch {
      return rawValue
    }
  }
  return ''
}

/**
 * Accept `?token=...` once, persist it, and remove it from the address bar so
 * it does not leak through screenshots, history, or referrer headers.
 */
function captureTokenFromUrl(): string {
  try {
    const token = rawSearchParam('token')
    if (!token) return ''
    storeToken(token)
    const url = new URL(window.location.href)
    url.searchParams.delete('token')
    const next = `${url.pathname}${url.search}${url.hash}`
    window.history.replaceState(null, '', next)
    return token
  } catch {
    return ''
  }
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const token = captureTokenFromUrl() || readStoredToken()
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (token) headers.set('authorization', `Bearer ${token}`)

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
  })

  const text = await response.text()
  let payload: ApiEnvelope<T> | undefined
  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as ApiEnvelope<T>
    } catch {
      payload = undefined
    }
  }

  if (!response.ok) {
    throw new Error(payload?.error ?? `请求失败（HTTP ${response.status}）`)
  }
  if (payload?.error !== undefined) throw new Error(payload.error)
  return payload?.result as T
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

async function downloadArtifact(artifactId: string, format: 'md' | 'docx' | 'html'): Promise<{ filename: string }> {
  const token = captureTokenFromUrl() || readStoredToken()
  const response = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/download?format=${format}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const text = await response.text()
    let message = `下载失败（HTTP ${response.status}）`
    try {
      const payload = JSON.parse(text) as { error?: string }
      if (payload.error) message = payload.error
    } catch {
      // Non-JSON error body: keep the status message.
    }
    throw new Error(message)
  }
  const blob = await response.blob()
  const disposition = response.headers.get('content-disposition') ?? ''
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
  const filename = encoded ? decodeURIComponent(encoded) : `artifact-${artifactId}.${format}`
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return { filename }
}

export function installLearningBridge(): void {
  window.learning = {
    capabilities: {
      localFiles: false,
      revealFiles: false,
      downloadArtifacts: 'browser',
    },
    downloadArtifact,
    invoke: (method, input) => postJson('/api/invoke', { method, input }),
    chat: (input) => postJson('/api/chat', input),
    onChatEvent: () => () => {},
    answer: (input) => postJson('/api/answer', input),
    answerSet: (input) => postJson('/api/answer-set', input),
    settings: {
      get: () => request('/api/settings', { method: 'GET' }),
      set: (value) => postJson('/api/settings', value),
    },
  }
}
