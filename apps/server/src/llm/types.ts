import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * The shape the agent loop consumes. It mirrors the two methods used from
 * `ctx.llm`, without pretending to be the full LlmRuntime service.
 */
export interface LlmLike {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  chat(messages: ChatTurn[]): Promise<string>
}

export type { GenerateOptions, StreamChunk, TokenUsage }
