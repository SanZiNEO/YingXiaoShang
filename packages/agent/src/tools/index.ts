import type { Context } from '@deepseek-ai/cordis'
import type { Citation } from '@learning-agent/shared'
import type { EmitContext } from '../artifacts.js'
import type { AgentTool } from '../tool-loop.js'
import { READ_TOOLS } from './read-tools.js'
import { WRITE_TOOLS } from './write-tools.js'
import { toAgentTool, type ChapterBlock, type ReadLedger, type ToolContext, type ToolSpec } from './types.js'

/**
 * 全部能力。加一个能力 = 往这里加一条声明 + 需要时改一句提示词，
 * 不牵动调度代码，也不用碰别处的参数列表。
 */
export const AGENT_TOOLS: ToolSpec[] = [...READ_TOOLS, ...WRITE_TOOLS]

export const READ_TOOL_NAMES: string[] = READ_TOOLS.map((spec) => spec.name)
export const WRITE_TOOL_NAMES: string[] = WRITE_TOOLS.map((spec) => spec.name)

export function emptyLedger(): ReadLedger {
  return {
    kps: new Set(),
    blocks: new Set(),
    news: new Set(),
    queries: new Set(),
    references: new Set(),
  }
}

export interface ToolTurnInput {
  ctx: Context
  chapterId: string
  emit: EmitContext
  citations?: Citation[]
  reads?: ReadLedger
  /** 已经由调用方送到模型眼前的材料，这些再读一次就没有意义。 */
  seed?: string[]
}

/** 组装这一轮的工具运行环境。状态只在这里，工具自己不持有。 */
export function createToolContext(input: ToolTurnInput): ToolContext {
  const delivered = new Set<string>(input.seed ?? [])
  const citations = input.citations ?? []
  const reads = input.reads ?? emptyLedger()
  let blockCache: ChapterBlock[] | undefined
  return {
    ctx: input.ctx,
    chapterId: input.chapterId,
    citations,
    reads,
    emit: input.emit,
    firstTime(key) {
      if (delivered.has(key)) return false
      delivered.add(key)
      return true
    },
    seen: (key) => delivered.has(key),
    chapterBlocks() {
      if (!blockCache) blockCache = input.ctx.learningDb.listBlocks(input.chapterId)
      return blockCache
    },
    cite(citation) {
      const key = `${citation.sourceType}:${citation.sourceId}`
      if (citations.some((item) => `${item.sourceType}:${item.sourceId}` === key)) return
      citations.push(citation)
    },
  }
}

/** 把声明绑定到本轮状态，得到模型看到的那一版工具。 */
export function agentTools(turn: ToolContext): AgentTool[] {
  return AGENT_TOOLS.map((spec) => toAgentTool(spec, turn))
}

export { READ_TOOLS, WRITE_TOOLS }
export type { ReadLedger, ToolContext, ToolSpec }
