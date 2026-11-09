/**
 * 对话历史的压缩视图。
 *
 * 为什么要有这一层：每一轮都把全部历史原样重发，输入会一直变长，
 * 越聊越慢（实测同一会话 2.8s → 61.3s → 76.4s）。这里把历史折成
 * 「最近几轮逐字 + 更早的压缩成一段摘要」，让单轮请求的大小有上限。
 *
 * 纯函数，不读数据库、不碰网络，方便单独验证。
 */

export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface HistoryStats {
  /** 逐字保留的消息条数 */
  keptMessages: number
  /** 被折进摘要的消息条数 */
  foldedMessages: number
  /** 逐字保留部分的字符数 */
  keptChars: number
  /** 摘要字符数 */
  digestChars: number
  /** 因过长被截断的助手消息条数 */
  truncatedMessages: number
}

export interface HistoryView {
  messages: HistoryMessage[]
  /** 更早对话的压缩摘要；为空表示不需要（历史本来就短）。 */
  digest: string
  stats: HistoryStats
}

export interface BuildHistoryInput {
  messages: HistoryMessage[]
  /** 会话级摘要（时间正序，越靠后越新）。来自 memory_episodes。 */
  episodeSummaries?: string[]
  /** 逐字保留最近几轮；一轮 = 学生一句 + 助手一句。 */
  keepTurns?: number
  /** 逐字部分的总字符上限。 */
  maxChars?: number
  /** 单条助手消息的字符上限（回答可能很长，但没必要整段重发）。 */
  assistantMaxChars?: number
  /** 摘要的字符上限。 */
  digestMaxChars?: number
}

export const HISTORY_KEEP_TURNS = 3
export const HISTORY_MAX_CHARS = 7000
export const HISTORY_ASSISTANT_MAX_CHARS = 1200
export const HISTORY_DIGEST_MAX_CHARS = 700

const ELLIPSIS = '…（后略）'

function chars(text: string): number {
  return text.length
}

function clip(text: string, max: number): string {
  if (max <= 0) return ''
  const trimmed = text.trim()
  if (chars(trimmed) <= max) return trimmed
  return `${trimmed.slice(0, max)}${ELLIPSIS}`
}

/** 从学生原话里取一句可认的摘要行。 */
function userLine(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return ''
  return clip(flat, 40)
}

/**
 * 摘要优先级：会话摘要（recorder 写的，带阶段与产出）> 老消息的首句拼接。
 * 两者都有时先放摘要，再用老消息补足条数，避免摘要还没生成时丢掉上下文。
 */
function buildDigest(input: {
  folded: HistoryMessage[]
  episodeSummaries: string[]
  maxChars: number
}): string {
  const parts: string[] = []
  for (const summary of input.episodeSummaries) {
    const line = summary.replace(/\s+/g, ' ').trim()
    if (line.length > 0) parts.push(clip(line, 200))
  }
  const asks = input.folded
    .filter((message) => message.role === 'user')
    .map((message) => userLine(message.content))
    .filter((line) => line.length > 0)
  if (asks.length > 0) {
    // 只留最近 8 句，避免摘要自己变成新的膨胀源。
    parts.push(`学生之前问过：${asks.slice(-8).join(' / ')}`)
  }
  const joined = parts.join('\n')
  return clip(joined, input.maxChars)
}

export function buildHistoryView(input: BuildHistoryInput): HistoryView {
  const keepTurns = Math.max(1, input.keepTurns ?? HISTORY_KEEP_TURNS)
  const maxChars = Math.max(400, input.maxChars ?? HISTORY_MAX_CHARS)
  const assistantMaxChars = Math.max(200, input.assistantMaxChars ?? HISTORY_ASSISTANT_MAX_CHARS)
  const digestMaxChars = Math.max(0, input.digestMaxChars ?? HISTORY_DIGEST_MAX_CHARS)

  let truncatedMessages = 0
  const prepared: HistoryMessage[] = input.messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content.trim().length > 0)
    .map((message) => {
      if (message.role !== 'assistant') return { role: message.role, content: message.content }
      if (chars(message.content) <= assistantMaxChars) return { role: message.role, content: message.content }
      truncatedMessages += 1
      return { role: message.role, content: clip(message.content, assistantMaxChars) }
    })

  // 最近几轮逐字保留；一条助手消息开头时，它属于更早的那一轮。
  const keepCount = keepTurns * 2
  let start = Math.max(0, prepared.length - keepCount)
  while (start < prepared.length && prepared[start]!.role !== 'user') start += 1

  const kept = prepared.slice(start)
  const folded = prepared.slice(0, start)

  // 逐字部分仍然超预算时，从最老的对话往摘要里搬。
  let trimmed = [...kept]
  let total = trimmed.reduce((sum, message) => sum + chars(message.content), 0)
  while (total > maxChars && trimmed.length > 2) {
    trimmed = trimmed.slice(2)
    total = trimmed.reduce((sum, message) => sum + chars(message.content), 0)
  }
  while (trimmed.length > 0 && trimmed[0]!.role !== 'user') trimmed = trimmed.slice(1)

  const movedOut = kept.slice(0, kept.length - trimmed.length)
  const foldedAll = [...folded, ...movedOut]
  const digest = digestMaxChars === 0
    ? ''
    : buildDigest({
        folded: foldedAll,
        episodeSummaries: input.episodeSummaries ?? [],
        maxChars: digestMaxChars,
      })

  return {
    messages: trimmed,
    digest,
    stats: {
      keptMessages: trimmed.length,
      foldedMessages: foldedAll.length,
      keptChars: total,
      digestChars: chars(digest),
      truncatedMessages,
    },
  }
}
