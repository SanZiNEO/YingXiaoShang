interface LlmContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

interface LlmMessage {
  role: string
  content: readonly LlmContentBlock[]
}

interface LlmTool {
  name: string
  description: string
  parameters: unknown
}

interface GenerateOptions {
  messages: readonly LlmMessage[]
  system?: string
  maxTokens?: number
  temperature?: number
  tools?: readonly LlmTool[]
  signal?: AbortSignal
}

interface StreamChunk {
  type: string
  [key: string]: unknown
}

export interface DeepSeekSettings {
  apiKey: string
  model: string
}

function messageText(message: LlmMessage): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text ?? '' : ''))
    .filter((text) => text.length > 0)
    .join('\n')
}

function wireMessages(options: GenerateOptions): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = []
  for (const message of options.messages) {
    const toolResults = message.content.filter((block) => block.type === 'tool-result')
    if (toolResults.length > 0) {
      // DeepSeek wants one `role: tool` message per call, keyed by tool_call_id.
      for (const result of toolResults) {
        wire.push({
          role: 'tool',
          tool_call_id: typeof result.id === 'string' ? result.id : '',
          content: typeof result.text === 'string' ? result.text : '',
        })
      }
      continue
    }
    const toolCalls = message.content.filter((block) => block.type === 'tool-call')
    if (toolCalls.length > 0) {
      wire.push({
        role: 'assistant',
        content: messageText(message) || null,
        tool_calls: toolCalls.map((call) => ({
          id: typeof call.id === 'string' ? call.id : '',
          type: 'function',
          function: {
            name: typeof call.name === 'string' ? call.name : '',
            arguments: typeof call.arguments === 'string' ? call.arguments : '{}',
          },
        })),
      })
      continue
    }
    wire.push({
      role: message.role === 'developer' ? 'system' : message.role,
      content: messageText(message),
    })
  }
  return wire
}

/** 允许用本地假服务验证流式链路；默认仍走官方地址。 */
function endpoint(): string {
  const base = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '')
  return `${base}/chat/completions`
}

export class DeepSeekLlm {
  constructor(private readonly settings: () => DeepSeekSettings) {}

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const settings = this.settings()
    if (!settings.apiKey) throw new Error('DEEPSEEK_API_KEY is not configured')
    const body: Record<string, unknown> = {
      model: settings.model,
      messages: options.system
        ? [{ role: 'system', content: options.system }, ...wireMessages(options)]
        : wireMessages(options),
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.2,
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
      body.tool_choice = 'auto'
    }
    const response = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
      signal: options.signal,
    })
    if (!response.ok) throw new Error(`DeepSeek API ${response.status}: ${await response.text()}`)
    if (!response.body) throw new Error('DeepSeek 没有返回流式响应')

    // 真流式：边读边吐，界面才有可能在第一个字到达时就显示出来。
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let textStarted = false
    let done = false
    const toolSlots = new Map<number, { id: string; name: string; args: string; started: boolean }>()

    const handleLine = function* (line: string): Generator<StreamChunk, boolean, void> {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return false
      const data = trimmed.slice(5).trim()
      if (data.length === 0) return false
      if (data === '[DONE]') return true
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(data) as Record<string, unknown>
      } catch {
        return false
      }
      if (payload.usage && typeof payload.usage === 'object') {
        yield { type: 'usage', usage: payload.usage }
      }
      const choices = payload.choices as Array<Record<string, unknown>> | undefined
      const choice = choices?.[0]
      const delta = (choice?.delta ?? {}) as Record<string, unknown>
      const content = typeof delta.content === 'string' ? delta.content : ''
      if (content.length > 0) {
        if (!textStarted) {
          textStarted = true
          yield { type: 'block-start', index: 0, blockType: 'text' }
        }
        yield { type: 'text-delta', index: 0, text: content }
      }
      const calls = delta.tool_calls
      if (Array.isArray(calls)) {
        for (const raw of calls as Array<Record<string, unknown>>) {
          const slotIndex = typeof raw.index === 'number' ? raw.index : toolSlots.size
          const fn = (raw.function ?? {}) as Record<string, unknown>
          const slot = toolSlots.get(slotIndex) ?? { id: `call_${slotIndex}`, name: '', args: '', started: false }
          if (typeof raw.id === 'string' && raw.id.length > 0) slot.id = raw.id
          if (typeof fn.name === 'string' && fn.name.length > 0) slot.name = fn.name
          const fragment = typeof fn.arguments === 'string' ? fn.arguments : ''
          slot.args += fragment
          if (!slot.started) {
            slot.started = true
            yield { type: 'block-start', index: slotIndex + 1, blockType: 'tool-call' }
          }
          yield { type: 'tool-call-delta', index: slotIndex + 1, id: slot.id, name: slot.name, argumentsDelta: fragment }
          toolSlots.set(slotIndex, slot)
        }
      }
      return choice?.finish_reason !== undefined && choice?.finish_reason !== null
    }

    while (!done) {
      const { value, done: streamDone } = await reader.read()
      if (streamDone) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        const stop = yield* handleLine(line)
        if (stop) { done = true; break }
      }
    }
    for (const [slotIndex, slot] of toolSlots) {
      yield {
        type: 'block-end',
        index: slotIndex + 1,
        block: { type: 'tool-call', id: slot.id, name: slot.name, arguments: slot.args } as LlmContentBlock,
      }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  async chat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<string> {
    const settings = this.settings()
    if (!settings.apiKey) throw new Error('请先在设置中填写 DEEPSEEK_API_KEY')
    const response = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        max_tokens: 8192,
        temperature: 0.4,
      }),
    })
    if (!response.ok) throw new Error(`DeepSeek API ${response.status}: ${await response.text()}`)
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>
    }
    return payload.choices?.[0]?.message?.content ?? ''
  }
}
