import type { Context } from '@deepseek-ai/cordis'
import { loadAgent } from './prompts.js'
import { runAgentLoop, type AgentLoopEvent, type AgentMessage, type AgentTool } from './tool-loop.js'
import { finalizeArtifacts, type EmitContext } from './artifacts.js'
import { agentTools, createToolContext, emptyLedger, READ_TOOL_NAMES } from './tools/index.js'
import { prefetchMaterial } from './tools/material.js'
import type { Artifact, Citation } from '@learning-agent/shared'

export interface TeamScope {
  chapterId: string
  chapterTitle: string
  phase: string
  studentId: string
  sessionId: string
}

/** One progress step, already attributed to whoever is working. */
export interface TeamEvent {
  agent: string
  type: 'round' | 'text' | 'tool' | 'tool-end'
  round?: number
  text?: string
  tool?: string
  chars?: number
  preview?: string
  cached?: boolean
}

export interface TeamHooks {
  onEvent?: (event: TeamEvent) => void
}

/** Program-side record of the turn: what ran, what was read. Never model-written. */
export interface TurnTrace {
  modelCalls: number
  leadRounds: number
  members: Array<{ name: string; rounds: number; tools: number }>
  reads: {
    kps: string[]
    blocks: number
    news: number
    queries: string[]
    references: string[]
  }
  citations: number
  toolCalls: number
  artifacts: number
  /** Character accounting by role, mirroring DSH's system/tools/message split. */
  context: {
    systemChars: number
    toolsChars: number
    messageChars: number
    totalChars: number
    toolResultChars: number
    prunedCalls: number
    prunedChars: number
  }
}

export interface TeamTurnInput {
  ctx: Context
  scope: TeamScope
  message: string
  /** Every earlier user/assistant message in this session, in order. */
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  hooks?: TeamHooks
}

export interface TeamFinding {
  member: string
  text: string
}

export interface TeamTurnResult {
  text: string
  findings: TeamFinding[]
  called: string[]
  artifacts: Artifact[]
  citations: Citation[]
  warnings: string[]
  trace: TurnTrace
}

/** Facts about the turn. No rules, no routing hints — the lead decides. */
function environment(input: TeamTurnInput): string {
  const { ctx, scope } = input
  const sections = ctx.learningDb.listSections(scope.chapterId)
  const points = ctx.learningDb.listKpsByChapter(scope.chapterId)
  return [
    '## 当前环境',
    `学生：${scope.studentId}`,
    `章节：${scope.chapterTitle}（${scope.chapterId}）`,
    `学情阶段：${scope.phase}`,
    sections.length > 0 ? `本章小节：${sections.map((section) => section.title).join(' / ')}` : '',
    points.length > 0 ? `本章知识点（${points.length} 个）：${points.slice(0, 40).map((point) => point.name).join('、')}` : '',
  ].filter((line) => line.length > 0).join('\n')
}

/**
 * Conversation history stays in messages, not in the system prompt — the same
 * shape as DSH's derived history. A leading assistant message is dropped so the
 * sequence always starts with a user turn.
 */
function initialMessages(input: TeamTurnInput): AgentMessage[] {
  const history = [...input.history]
  while (history.length > 0 && history[0]!.role === 'assistant') history.shift()
  return [
    ...history.map((item): AgentMessage => ({
      role: item.role,
      content: [{ type: 'text', text: item.content }],
    })),
    { role: 'user', content: [{ type: 'text', text: input.message }] },
  ]
}


/** 哪些工具算"读材料"：用来算进度，也用来判断本章是不是已经翻完了。 */
const READ_TOOL = new Set(READ_TOOL_NAMES)

function forward(input: TeamTurnInput, agent: string, event: AgentLoopEvent): void {
  if (!input.hooks?.onEvent) return
  try {
    if (event.type === 'round') {
      input.hooks.onEvent({ agent, type: 'round', round: event.round })
      return
    }
    if (event.type === 'text') {
      input.hooks.onEvent({ agent, type: 'text', text: event.text })
      return
    }
    if (event.type === 'tool-start') {
      input.hooks.onEvent({ agent, type: 'tool', tool: event.name })
      return
    }
    if (event.type === 'tool-end') {
      input.hooks.onEvent({
        agent,
        type: 'tool-end',
        tool: event.name,
        chars: event.chars,
        preview: event.preview,
        cached: event.cached,
      })
    }
  } catch {
    // A broken sink never breaks the turn.
  }
}


/**
 * Run one conversational turn: the agent reads course material when it needs to,
 * consults a playbook when the task calls for one, writes any artifact the
 * student asked for, and writes the single reply. Nothing here pre-selects
 * material or picks a role.
 */
export async function runTeamTurn(input: TeamTurnInput): Promise<TeamTurnResult> {
  const findings: TeamFinding[] = []
  const emit: EmitContext = {
    ctx: input.ctx,
    studentId: input.scope.studentId,
    sessionId: input.scope.sessionId,
    chapterId: input.scope.chapterId,
    pending: new Map(),
    created: [],
  }
  const citations: Citation[] = []
  const reads = emptyLedger()
  const env = environment(input)
  // 材料先备到手边，省掉几轮"再读一段"。备了也可以不用——要不要写产物是模型自己的判断，
  // 代码不替它猜学生想要什么。
  const material = prefetchMaterial(input.ctx, input.scope.chapterId, input.message, reads)
  const turn = createToolContext({
    ctx: input.ctx,
    chapterId: input.scope.chapterId,
    emit,
    citations,
    reads,
    seed: material.keys,
  })
  const tools: AgentTool[] = agentTools(turn)
  const system = [
    loadAgent(),
    '',
    env,
    '',
    '## 本轮工具',
    '取材料、查手册、写产物都用工具，怎么用写在工具说明里。动笔做专业内容之前先把手册读一遍。',
    material.text.length > 0
      ? [
          '## 已经备好的材料',
          '这些是系统按任务取好的：知识点定义 + 教材原文整段（带 blockId）。原文可以直接逐字引用，不用再调工具读一遍。',
          material.text,
        ].join('\n')
      : '',
    '要调用工具时不要先写正文：正文只在不再调用工具的那一轮写。',
    '同一个材料只读一次；已经读到的原文直接接着用。',
    '产物写入后，回复里只给结构摘要、关键取舍和下一步，不要把附件正文（尤其是题目全文）抄进聊天。',
    '附件会在右栏打开，可以告诉学生「附件在右栏」。',
  ].filter((line) => line.length > 0).join('\n')

  let rounds = 0
  const result = await runAgentLoop({
    ctx: input.ctx,
    system,
    messages: initialMessages(input),
    tools,
    // 单代理要自己读材料、读手册、写产物，轮次给够；收口靠"程序告诉它走到哪一步了"。
    maxRounds: 10,
    maxTokens: 8192,
    // 不强制写：学生没要产物的一轮，一段正文就是完整答复。
    // 逼它写只会让「谢谢你」也变成一份附件。
    // 它反复读材料，是因为不知道自己走到第几步。把事实摊开给它看。
    status: ({ calls, written }) => {
      const readCount = calls.filter((call) => READ_TOOL.has(call.name)).length
      const made = [...new Set(written)]
      const stage = made.length > 0
        ? `产物已写入 ${made.join('、')}——不用再写，直接给结论`
        : '还没写产物（学生没要就不用写）'
      return `你在第 ${calls.length + 1} 步；已读材料 ${readCount} 次；${stage}。`
    },
    hooks: {
      streamText: true,
      onEvent: (event: AgentLoopEvent) => {
        if (event.type === 'round') rounds = Math.max(rounds, event.round)
        forward(input, 'lead', event)
      },
    },
  })
  const warnings: string[] = []
  await finalizeArtifacts(emit, warnings)
  const trace: TurnTrace = {
    modelCalls: rounds,
    leadRounds: rounds,
    // 单代理没有成员；字段留着，前端与落库格式不变。
    members: [],
    reads: {
      kps: [...reads.kps],
      blocks: reads.blocks.size,
      news: reads.news.size,
      queries: [...reads.queries],
      references: [...reads.references],
    },
    citations: citations.length,
    toolCalls: result.calls.length,
    artifacts: emit.created.length,
    context: {
      systemChars: system.length,
      toolsChars: result.context.toolsChars,
      messageChars: result.context.messageChars,
      totalChars: system.length + result.context.toolsChars + result.context.messageChars,
      toolResultChars: result.context.toolDeliveredChars,
      prunedCalls: result.context.toolPrunedCalls,
      prunedChars: result.context.toolPrunedChars,
    },
  }
  return { text: result.text, findings, called: result.called, artifacts: emit.created, citations, warnings, trace }
}
