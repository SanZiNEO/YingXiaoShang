/**
 * DeepSeek 偶尔不按 JSON 的 tool_calls 返回，而是把工具调用写成一段正文
 * （DSML 标记，形如 `<｜｜DSML｜｜ calls>`）。这段标记必须当成工具调用解析，
 * 否则学生会在聊天里直接看到这堆乱码。
 *
 * 它有两种竖线：半角 `||` 和全角 `｜｜`，两种都要认。
 */
const MARKER = '[|｜]{2}'
const OPEN = `<${MARKER}DSML${MARKER}\\s*(?:tool_calls|calls)>`
const CLOSE = `<\\/${MARKER}DSML${MARKER}\\s*(?:tool_calls|calls)>`
const INVOKE = new RegExp(
  `<${MARKER}DSML${MARKER}\\s*invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)<\\/${MARKER}DSML${MARKER}\\s*invoke>`,
  'g',
)
const PARAM = new RegExp(
  `<${MARKER}DSML${MARKER}\\s*parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)<\\/${MARKER}DSML${MARKER}\\s*parameter>`,
  'g',
)
const BLOCK = new RegExp(`${OPEN}([\\s\\S]*?)${CLOSE}`, 'g')
/** 任何残留的 DSML 标记（包括没闭合的尾巴）。 */
const RESIDUE = new RegExp(`<[|｜]{2}DSML[\\s\\S]*$`)

export const DSML_OPEN_HINT = /<[|｜]{2}DSML/

export interface TextToolCall {
  name: string
  arguments: string
}

function decodeValue(raw: string, typed: string | undefined): unknown {
  const text = raw.trim()
  if (typed === 'true') return text
  if (text.length === 0) return ''
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/**
 * Pull tool calls out of a text block. Returns the calls plus whatever prose was
 * around them — the prose is all the student should ever see.
 */
export function parseDsml(text: string): { calls: TextToolCall[]; rest: string } {
  if (!DSML_OPEN_HINT.test(text)) return { calls: [], rest: text }
  const calls: TextToolCall[] = []
  BLOCK.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BLOCK.exec(text)) !== null) {
    const body = match[1] ?? ''
    INVOKE.lastIndex = 0
    let invoke: RegExpExecArray | null
    while ((invoke = INVOKE.exec(body)) !== null) {
      const name = (invoke[1] ?? '').trim()
      if (name.length === 0) continue
      const args: Record<string, unknown> = {}
      PARAM.lastIndex = 0
      let parameter: RegExpExecArray | null
      while ((parameter = PARAM.exec(invoke[2] ?? '')) !== null) {
        const key = (parameter[1] ?? '').trim()
        if (key.length === 0) continue
        args[key] = decodeValue(parameter[3] ?? '', parameter[2])
      }
      calls.push({ name, arguments: JSON.stringify(args) })
    }
  }
  let rest = text.replace(BLOCK, '')
  // 没闭合的半截标记也要清掉，不能漏给学生。
  rest = rest.replace(RESIDUE, '')
  return { calls, rest: rest.trim() }
}
