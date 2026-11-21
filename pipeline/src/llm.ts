interface ContentBlock {
  type: string
  text?: string
}

interface Message {
  role: string
  content: readonly ContentBlock[]
}

interface Tool {
  name: string
  description: string
  parameters: unknown
}

interface StreamOptions {
  system?: string
  messages: readonly Message[]
  maxTokens?: number
  temperature?: number
  tools?: readonly Tool[]
  signal?: AbortSignal
}

export interface DeepSeekSettings {
  apiKey: string
  model: string
}

function wireMessages(messages: readonly Message[]): Array<{ role: string; content: string }> {
  return messages.map((message) => ({
    role: message.role === 'developer' ? 'system' : message.role,
    content: message.content
      .map((block) => (block.type === 'text' ? block.text ?? '' : ''))
      .filter((text) => text.length > 0)
      .join('\n'),
  }))
}

export class DeepSeekLlm {
  constructor(private readonly settings: () => DeepSeekSettings) {}

  async *stream(options: StreamOptions): AsyncIterable<Record<string, unknown>> {
    const settings = this.settings()
    if (!settings.apiKey) throw new Error('DEEPSEEK_API_KEY is not configured')
    const body: Record<string, unknown> = {
      model: settings.model,
      messages: options.system
        ? [{ role: 'system', content: options.system }, ...wireMessages(options.messages)]
        : wireMessages(options.messages),
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
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    })
    if (!response.ok) throw new Error(`DeepSeek API ${response.status}: ${await response.text()}`)
    const payload = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string | null
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
        }
      }>
    }
    const message = payload.choices?.[0]?.message
    const toolCalls = message?.tool_calls ?? []
    if (toolCalls.length > 0) {
      for (let index = 0; index < toolCalls.length; index++) {
        const call = toolCalls[index]!
        const name = call.function?.name ?? 'tool'
        const args = call.function?.arguments ?? '{}'
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id: call.id ?? `call_${index}`, name, argumentsDelta: args }
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: call.id ?? `call_${index}`, name, arguments: args },
        }
      }
    } else {
      const text = message?.content ?? ''
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
