import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ChatTurn, LlmLike } from './types.js'

/**
 * Deterministic mock model for smoke / contract tests and offline runs.
 *
 * The chunk vocabulary matches the dsh-llm stream protocol consumed by the
 * agent loop (`block-start` / `text-delta` / `tool-call-delta` / `block-end` /
 * `usage` / `finish`), so no special mock-only branch lives in the agent code.
 */
export interface MockOptions {
  /** `tools` enables the scripted `emit_question_set` round. */
  script: string
}

interface MockBlock {
  type?: string
  text?: string
}

interface MockMessage {
  role?: string
  content?: unknown
}

const QUESTION_INTENT = /出题|题目|练习|测验|做题/

const NORMAL_SEGMENTS = [
  '好的，我们先从这一章最基础的概念说起，理解起来并不难。',
  '你可以先抓住关键词，再结合自己生活里的例子对照着理解。',
  '教材上的定义先记个大概，做题时遇到卡住的地方再回来翻。',
  '有哪里读不顺的直接问我，我们一段一段把它讲明白。',
  '这一轮先聊到这里，你可以用自己的话复述一下刚才的要点。',
]

/**
 * Valid empty-result arguments for each single-tool structured call, keyed by
 * tool name. Field names follow the schemas in packages/profile / matcher /
 * questions / research / bp; consumers read optional arrays and degrade to
 * empty, but an unparseable or missing body would make the recorder fail for
 * no reason.
 */
const EMPTY_STRUCTURED_RESULTS: Record<string, unknown> = {
  emit_evidence: { evidence: [] },
  emit_matches: { matches: [], ideology: [] },
  emit_questions: { questions: [] },
  emit_analysis_plan: { methods: [], steps: [], outputs: [], limitations: [] },
  emit_research_review: { level: '', strengths: [], gaps: [], next_steps: [] },
  emit_bp_review: { level: '', strengths: [], gaps: [], next_steps: [] },
  emit_research_brief: { research_question: '', objectives: [], constraints: [], assumptions: [] },
  emit_research_method: { method: '', rationale: '', alternatives: [] },
  emit_sampling_plan: { sampling_frame: '', technique: '', target_size: 0, recruitment: '', risks: [] },
  emit_questionnaire: { questions: [] },
  emit_interview_guide: { sections: [] },
  emit_bp_outline: { sections: [] },
  emit_competitor_analysis: { competitors: [] },
  emit_business_model_canvas: {
    customer_segments: [],
    value_propositions: [],
    channels: [],
    customer_relationships: [],
    revenue_streams: [],
    key_resources: [],
    key_activities: [],
    key_partners: [],
    cost_structure: [],
  },
  emit_gtm_plan: { channels: [], milestones: [] },
  emit_financial_projection: { years: [], assumptions: [] },
  emit_market_sizing: { tam: 0, sam: 0, som: 0, currency: '', assumptions: [], sources: [] },
}

const QUESTION_SET_ARGS = {
  title: 'mock 题目集',
  content: {
    intro: '这是 mock 模式生成的两道题。',
    questions: [
      {
        type: 'single',
        stem: 'mock 第一题：消费者行为的核心是？',
        options: ['需求识别', '价格歧视', '渠道压货'],
        answer: '需求识别',
        explanation: 'mock 解析',
        kpIds: [],
        difficulty: 1,
      },
      {
        type: 'short',
        stem: 'mock 第二题：用一个例子说明参考群体影响。',
        options: [],
        answer: '示例答案',
        explanation: 'mock 解析',
        kpIds: [],
        difficulty: 2,
      },
    ],
  },
}

function blocksOf(message: MockMessage): MockBlock[] {
  return Array.isArray(message.content) ? (message.content as MockBlock[]) : []
}

function textOf(message: MockMessage): string {
  if (typeof message.content === 'string') return message.content
  return blocksOf(message)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

/**
 * The last thing the *student* said. The agent loop injects a `[程序状态]`
 * user message before every round and a `（系统提示：…）` one when rounds run
 * out; neither is the student's question, so they are skipped.
 */
function lastUserText(messages: readonly MockMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    const text = textOf(message)
    if (text.startsWith('[程序状态]') || text.startsWith('（系统提示')) continue
    return text
  }
  return ''
}

function hasToolResult(messages: readonly MockMessage[]): boolean {
  return messages.some((message) => blocksOf(message).some((block) => block.type === 'tool-result'))
}

function usageChunk() {
  return { type: 'usage' as const, usage: { inputTokens: 100, outputTokens: 50 } }
}

function finishChunk() {
  return { type: 'finish' as const, reason: { kind: 'stop' as const } }
}

/**
 * Deterministic pacing (`YXS_MOCK_DELAY_MS`, default 0). A real model takes
 * hundreds of milliseconds per delta; without pacing, cancel / heartbeat /
 * disconnect behaviour cannot be exercised at all. It also keeps the mock
 * honest about aborting: every chunk is gated on `signal`.
 */
const MOCK_DELAY_MS = Math.max(0, Number(process.env.YXS_MOCK_DELAY_MS ?? '0') || 0)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function* paced(
  signal: AbortSignal | undefined,
  chunks: readonly StreamChunk[],
): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) {
    if (signal?.aborted) return
    if (MOCK_DELAY_MS > 0) {
      await sleep(MOCK_DELAY_MS)
      if (signal?.aborted) return
    }
    yield chunk
  }
}

function textChunks(deltas: string[]): StreamChunk[] {
  const chunks: StreamChunk[] = [{ type: 'block-start', index: 0, blockType: 'text' }]
  for (const text of deltas) chunks.push({ type: 'text-delta', index: 0, text })
  chunks.push(usageChunk(), finishChunk())
  return chunks
}

function toolCallChunks(name: string, args: unknown): StreamChunk[] {
  const argumentsJson = JSON.stringify(args)
  const id = ToolCallId('call_mock_1')
  return [
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    usageChunk(),
    finishChunk(),
  ]
}

export function createMockLlm(options: MockOptions): LlmLike {
  const script = options.script

  return {
    async *stream(generateOptions: GenerateOptions): AsyncIterable<StreamChunk> {
      if (generateOptions.signal?.aborted) return

      const messages = (generateOptions.messages ?? []) as unknown as MockMessage[]
      const tools = generateOptions.tools ?? []
      const toolNames = tools.map((tool) => tool.name)

      // A previous tool round already produced a result: answer in prose, do not
      // call the same tool again.
      if (hasToolResult(messages)) {
        yield* paced(generateOptions.signal, textChunks(['题目已经准备好了，先从第一题开始。']))
        return
      }

      // callStructuredTool hands over exactly one synthetic emit_* tool: answer
      // with a valid empty result so the recorder / matcher / questions degrade
      // to empty instead of failing on malformed JSON.
      if (tools.length === 1 && toolNames[0]?.startsWith('emit_')) {
        const toolName = toolNames[0]
        const empty = EMPTY_STRUCTURED_RESULTS[toolName] ?? {}
        yield* paced(generateOptions.signal, toolCallChunks(toolName, empty))
        return
      }

      if (script === 'tools' && QUESTION_INTENT.test(lastUserText(messages))) {
        yield* paced(generateOptions.signal, toolCallChunks('emit_question_set', QUESTION_SET_ARGS))
        return
      }

      yield* paced(generateOptions.signal, textChunks(NORMAL_SEGMENTS))
    },

    async chat(messages: ChatTurn[]): Promise<string> {
      // No package currently calls the non-streaming path, but it must stay a
      // real implementation: return the same deterministic prose.
      void messages
      return NORMAL_SEGMENTS.join('')
    },
  }
}
