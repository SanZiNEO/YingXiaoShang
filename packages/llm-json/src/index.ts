import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, type ToolSchema } from '@deepseek-ai/dsh-llm'

export interface LlmRoute {
  provider: string
  model: string
}

export const DEFAULT_ROUTE: LlmRoute = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
}

export interface StructuredCallInput {
  ctx: Context
  system: string
  prompt: string
  toolName: string
  toolDescription: string
  parameters: Record<string, unknown>
  route?: LlmRoute
  maxTokens?: number
  signal?: AbortSignal
}

export class StructuredCallError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'StructuredCallError'
  }
}

/**
 * Call the configured model with exactly one synthetic tool and return the
 * parsed tool arguments. DeepSeek has no JSON mode, so a tool call is the
 * structured-output contract.
 */
export async function callStructuredTool<T>(input: StructuredCallInput): Promise<T> {
  const route = input.route ?? DEFAULT_ROUTE
  const tool: ToolSchema = {
    name: input.toolName,
    description: input.toolDescription,
    parameters: input.parameters,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of input.ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    system: input.system,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: input.prompt }],
      },
    ],
    tools: [tool],
    maxTokens: input.maxTokens ?? 4096,
    signal: input.signal,
  })) {
    assembler.push(chunk)
  }
  const call = assembler
    .blocks()
    .find((block) => block.type === 'tool-call' && block.name === input.toolName)
  if (!call || call.type !== 'tool-call') {
    throw new StructuredCallError(`model did not call ${input.toolName}`)
  }
  try {
    return JSON.parse(call.arguments) as T
  } catch (error) {
    throw new StructuredCallError(`model returned invalid JSON for ${input.toolName}`, { cause: error })
  }
}

export function jsonObjectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  }
}
