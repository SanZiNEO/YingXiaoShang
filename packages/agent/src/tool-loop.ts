import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, type ToolSchema } from '@deepseek-ai/dsh-llm'
import { DEFAULT_ROUTE } from '@learning-agent/llm-json'
import { DSML_OPEN_HINT, parseDsml } from './dsml.js'

/**
 * One tool an agent may call. `execute` returns text; the model sees it verbatim
 * on the next round.
 */
export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  /**
   * 写类工具（把产物落到系统里）。轮次用尽时只保留这类工具：
   * 读材料的时间用完了，但"把手上的东西交付出来"这一步不能不给机会。
   */
  write?: boolean
  execute: (args: Record<string, unknown>) => Promise<string> | string
}

export type AgentMessage = {
  role: 'user' | 'assistant' | 'tool'
  content: Array<Record<string, unknown>>
}

/** Progress events the host can forward to the UI. */
export type AgentLoopEvent =
  | { type: 'round'; round: number }
  | { type: 'text'; text: string }
  | { type: 'tool-start'; name: string; args: string }
  | { type: 'tool-end'; name: string; chars: number; cached: boolean; preview: string }

export interface AgentLoopHooks {
  /** Progress sink. Throwing here must never break the turn. */
  onEvent?: (event: AgentLoopEvent) => void
  /** Forward model text deltas; only the agent that speaks to the student sets this. */
  streamText?: boolean
}

export interface ToolCallRecord {
  name: string
  args: string
  chars: number
  cached: boolean
}

export interface AgentLoopInput {
  ctx: Context
  system: string
  /** Conversation so far; the caller supplies the first user turn. */
  messages: AgentMessage[]
  tools: AgentTool[]
  maxRounds?: number
  maxTokens?: number
  /**
   * 程序维护的进度事实，每轮注入一次（只有一条，就地替换，不累积）。
   * 借鉴 OpenHands / Cline 的 step state：模型反复读材料，往往是因为它不知道
   * 自己已经走到第几步、还差什么没交。让状态由代码算，而不是让模型自己记。
   */
  status?: (state: LoopState) => string
  hooks?: AgentLoopHooks
}

export interface LoopState {
  calls: ToolCallRecord[]
  /** 已经成功写进系统的产物工具名。 */
  written: string[]
}

export interface AgentLoopResult {
  text: string
  rounds: number
  /** Tool names in call order, for logging and for the caller's own checks. */
  called: string[]
  /** Per-call detail, deduped by name+args, for the turn trace. */
  calls: ToolCallRecord[]
}

/**
 * Tool-calling loop, mirroring dsh's shape: send tools → if the model asks for
 * tools, run them and feed the results back → repeat until it answers in text.
 * There is no template fallback: if the model never settles, this throws.
 *
 * Repeated identical calls (same name + same arguments) are served from the
 * call cache: the model sometimes asks twice while it re-reads its own plan,
 * and paying a second round trip for the same bytes is pure latency.
 */
export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const maxRounds = input.maxRounds ?? 8
  const schemas: ToolSchema[] = input.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  const messages = [...input.messages]
  const called: string[] = []
  const calls: ToolCallRecord[] = []
  const cache = new Map<string, string>()

  const emit = (event: AgentLoopEvent): void => {
    try {
      input.hooks?.onEvent?.(event)
    } catch {
      // A broken progress sink must not fail the turn.
    }
  }

  type ToolCall = { type: 'tool-call'; id: string; name: string; arguments: string }

  /**
   * One model request: stream the deltas out (unless told not to), then return
   * the tool calls it asked for plus whatever prose came with them.
   */
  const request = async (round: number, schemas: ToolSchema[]): Promise<{ toolCalls: ToolCall[]; text: string }> => {
    const assembler = new BlockAssembler()
    /**
     * 流式出字时不要把 DSML 标记漏给学生：以 '<' 开头的尾巴先压住，
     * 等下一片再判断它是不是标记。
     */
    let held = ''
    const pushText = (delta: string): void => {
      held += delta
      const tagStart = held.lastIndexOf('<')
      if (tagStart >= 0 && held.length - tagStart <= 40) {
        const safe = held.slice(0, tagStart)
        held = held.slice(tagStart)
        if (safe.length > 0) emit({ type: 'text', text: safe })
        return
      }
      if (held.length > 0) {
        emit({ type: 'text', text: held })
        held = ''
      }
    }
    for await (const chunk of input.ctx.llm.stream({
      provider: DEFAULT_ROUTE.provider,
      model: DEFAULT_ROUTE.model,
      system: input.system,
      messages: messages as unknown as Parameters<Context['llm']['stream']>[0]['messages'],
      tools: schemas,
      maxTokens: input.maxTokens ?? 8192,
    })) {
      const delta = chunk as { type?: string; text?: string }
      if (delta.type === 'text-delta' && typeof delta.text === 'string' && input.hooks?.streamText) {
        pushText(delta.text)
      }
      assembler.push(chunk)
    }
    // 压住的尾巴如果是 DSML 标记就丢掉，否则补发出去。
    if (held.length > 0 && !DSML_OPEN_HINT.test(held)) emit({ type: 'text', text: held })
    const blocks = assembler.blocks()
    // `blocks()` returns dsh's merge-extensible block union; tool calls are its
    // own discriminated member, so this narrows to the documented shape.
    const structured = blocks.filter((block) => block.type === 'tool-call') as ToolCall[]
    const rawText = blocks
      .map((block) => (block.type === 'text' ? block.text : ''))
      .filter((item) => item.length > 0)
      .join('')
      .trim()
    // 模型有时把工具调用写成正文（DSML），这时候也得当成调用执行，不能当答案。
    const parsed = parseDsml(rawText)
    return {
      text: parsed.rest,
      toolCalls: structured.length > 0
        ? structured
        : parsed.calls.map((call, index) => ({
            type: 'tool-call' as const,
            id: `text_${round}_${index}`,
            name: call.name,
            arguments: call.arguments,
          })),
    }
  }

  /** 执行一轮工具调用：推回 assistant 调用消息和 tool 结果消息。 */
  const runCalls = async (toolCalls: ToolCall[], round: number): Promise<void> => {
    if (process.env.AGENT_DEBUG_LOOP === '1') {
      console.log(
        `[loop] 第 ${round} 轮 → `
        + toolCalls.map((call) => `${call.name}(${call.arguments.length}字节)`).join(' '),
      )
    }
    messages.push({
      role: 'assistant',
      content: toolCalls.map((call) => ({
        type: 'tool-call',
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    })
    // 同一轮里的多个工具并行执行：模型经常一口气读两三份材料，串行等于把等待叠加。
    const inflight = new Map<string, Promise<string>>()
    const done = await Promise.all(toolCalls.map(async (call) => {
      called.push(call.name)
      const tool = input.tools.find((item) => item.name === call.name)
      const key = `${call.name}:${call.arguments}`
      const cached = cache.get(key)
      if (!tool) return { output: `未知工具：${call.name}`, cached: false }
      if (cached !== undefined) return { output: cached, cached: true }
      const running = inflight.get(key)
      if (running) return { output: await running, cached: true }
      emit({ type: 'tool-start', name: call.name, args: call.arguments })
      const work = (async (): Promise<string> => {
        try {
          const args = call.arguments.trim().length > 0
            ? (JSON.parse(call.arguments) as Record<string, unknown>)
            : {}
          const output = String(await tool.execute(args))
          cache.set(key, output)
          if (tool.write) written.push(tool.name)
          return output
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // 参数被 token 上限截断是最常见的失败：模型会一直重试同样大小的内容。
          // 得明确告诉它"拆小"，否则它只会一遍一遍重写同一份超长 JSON。
          if (/Unterminated string|Unexpected end of JSON|Expected .* after property|position \d+/.test(message)) {
            return `工具执行失败：参数太长，超过单次输出上限被截断了（${message}）。
不要重写整份：把内容拆成 2–3 次调用，每次只写一小部分（1–2 个条目），系统会自动合并。`
          }
          return `工具执行失败：${message}`
        }
      })()
      inflight.set(key, work)
      return { output: await work, cached: false }
    }))

    const results: Array<Record<string, unknown>> = []
    for (let index = 0; index < toolCalls.length; index++) {
      const call = toolCalls[index]!
      const { output, cached } = done[index]!
      emit({
        type: 'tool-end',
        name: call.name,
        chars: output.length,
        cached,
        preview: output.replace(/\s+/g, ' ').slice(0, 80),
      })
      calls.push({ name: call.name, args: call.arguments, chars: output.length, cached })
      if (process.env.AGENT_DEBUG_LOOP === '1') {
        console.log(`[loop]   ← ${call.name}${cached ? '（缓存）' : ''} ${output.length}字 ${output.replace(/\s+/g, ' ').slice(0, 100)}`)
      }
      results.push({ type: 'tool-result', id: call.id, text: output.slice(0, 12_000) })
    }
    messages.push({ role: 'tool', content: results })
  }

  let lastText = ''
  /** 已经成功落过库的写类工具，用于最后的兜底说明。 */
  const written: string[] = []
  /** 写类工具：产物的唯一入口。 */
  const writers = input.tools.filter((tool) => tool.write)
  /** 进度事实消息在 messages 里的位置：每轮就地替换，避免上下文越滚越长。 */
  let statusIndex = -1
  const injectStatus = (): void => {
    if (!input.status) return
    let text = ''
    try {
      text = input.status({ calls, written })
    } catch {
      return
    }
    if (text.length === 0) return
    if (statusIndex >= 0 && statusIndex < messages.length) messages.splice(statusIndex, 1)
    messages.push({ role: 'user', content: [{ type: 'text', text: `[程序状态] ${text}` }] })
    statusIndex = messages.length - 1
  }

  for (let round = 1; round <= maxRounds; round++) {
    injectStatus()
    emit({ type: 'round', round })
    const { toolCalls, text } = await request(round, schemas)
    if (text.length > 0) lastText = text
    if (toolCalls.length === 0) {
      if (text.length === 0) throw new Error('模型没有返回任何内容')
      return { text, rounds: round, called, calls }
    }
    await runCalls(toolCalls, round)
  }

  // 轮次用尽不等于失败：查资料的窗口关掉，只留写产物的工具，再要一次结果。
  // 抛错会让上一层以为"任务没做完"，把整套活重新派一遍，白白多花几十秒。
  const writerSchemas = writers.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  const closingRound = maxRounds + 1
  messages.push({
    role: 'user',
    content: [{
      type: 'text',
      text: '（系统提示：查资料的时间已用完。请用已有材料给出最终结论；要写产物就现在写完，不要再查资料。）',
    }],
  })
  emit({ type: 'round', round: closingRound })
  const closing = await request(closingRound, writerSchemas)
  if (closing.toolCalls.length > 0) await runCalls(closing.toolCalls, closingRound)
  const closingText = closing.text

  if (written.length > 0) {
    return {
      text: closingText.length > 0 ? closingText : `本轮产物已写入系统：${[...new Set(written)].join('、')}。`,
      rounds: closingRound,
      called,
      calls,
    }
  }
  if (closingText.length > 0) return { text: closingText, rounds: closingRound, called, calls }
  if (lastText.length > 0) return { text: lastText, rounds: closingRound, called, calls }
  throw new Error(`模型在 ${maxRounds} 轮内没有结束工具调用（${[...new Set(called)].join(', ')}）`)
}
