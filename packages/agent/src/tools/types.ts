import type { Context } from '@deepseek-ai/cordis'
import type { Citation } from '@learning-agent/shared'
import type { AgentTool } from '../tool-loop.js'
import type { EmitContext } from '../artifacts.js'

/** 一章教材里的一段原文。 */
export type ChapterBlock = ReturnType<Context['learningDb']['listBlocks']>[number]

/**
 * What the agent actually read this turn. Filled by the tools themselves so the
 * UI never has to trust a model-written summary (and cannot double count: every
 * set is keyed by id/name).
 */
export interface ReadLedger {
  kps: Set<string>
  blocks: Set<string>
  news: Set<string>
  queries: Set<string>
  references: Set<string>
}

/**
 * 一轮里工具能用到的一切运行时状态。只在这里组装一次，工具本身不持有状态。
 */
export interface ToolContext {
  ctx: Context
  chapterId: string
  /** 本轮引用到的出处，工具自己往里记。 */
  citations: Citation[]
  /** 程序侧记录读了什么。 */
  reads: ReadLedger
  /** 写产物用的收集区。 */
  emit: EmitContext
  /**
   * 这一轮里这份内容还没交付过 → 记下并返回 true；已经交付过 → 返回 false，
   * 由工具回一句「读过了，内容没变」。模型看见「没有新信息」才会收口。
   */
  firstTime: (key: string) => boolean
  /** 纯查询：这份内容本轮是否已经交付过，不产生副作用。 */
  seen: (key: string) => boolean
  /** 本章教材段落；一章在一轮里不会变，所以只扫一次。 */
  chapterBlocks: () => ChapterBlock[]
  /** 记一条出处（同 sourceType+sourceId 只记一次）。 */
  cite: (citation: Citation) => void
}

/**
 * 一个能力的完整声明：名字、说明、参数 schema 都在这里，
 * 模型看得懂就会用；加能力 = 往列表里加一条，不动调度代码。
 */
export interface ToolSpec {
  name: string
  /** read = 取材料（只读）；write = 写产物（落库）。 */
  kind: 'read' | 'write'
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, turn: ToolContext) => string | Promise<string>
}

/** 把声明绑定到本轮状态，得到模型真正拿到的那一版工具。 */
export function toAgentTool(spec: ToolSpec, turn: ToolContext): AgentTool {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    write: spec.kind === 'write',
    execute: (args) => spec.execute(args, turn),
  }
}
