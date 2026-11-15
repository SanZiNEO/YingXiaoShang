/**
 * 空返回的两条底线：
 *  ① 已经流出去的字不能消失（R21:11）
 *  ② 这一轮已经收齐的产物不能跟着作废（写工具对模型承诺过「会在本轮结束时生成」）
 *
 * 关键是**必须真的走到「下一轮还空返回」那条路**：如果假模型第一轮就没工具调用，
 * 循环会当场结束，那根本没测到空返回分支。所以要第一轮吐字 + 一个工具调用，
 * 第二轮什么都不给。
 */
import { runAgentLoop } from '../packages/agent/src/tool-loop.js'

let pass = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const textChunk = (index: number, text: string) => ({ type: 'text-delta', index, text })
const callChunk = (index: number, id: string, name: string) =>
  ({ type: 'tool-call-delta', index, id, name, argumentsDelta: '{}' })
/**
 * 按脚本逐轮吐内容的假模型。每一轮是一个 chunk 数组；空数组 = 这一轮什么都没说。
 */
function fakeCtx(script: Array<Array<Record<string, unknown>>>) {
  let index = 0
  return {
    llm: {
      async *stream() {
        const chunks = script[index] ?? []
        index++
        for (const chunk of chunks) yield chunk
      },
    },
  } as any
}

const fakeTool = {
  name: 'read_kp',
  kind: 'read',
  description: '假工具',
  parameters: { type: 'object', properties: {} },
  write: false,
  execute: () => '材料读到了',
}

const baseInput = (ctx: unknown, tools: unknown[] = [fakeTool]) => ({
  ctx: ctx as never,
  system: 'test',
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  tools: tools as never,
  maxRounds: 4,
  maxTokens: 256,
})

// 不传 block-end：组装器支持 delta-only 协议，会自己从 delta 组装块。
const roundWithCall = [
  textChunk(0, '我先说结论：这个概念的核心是交换价值。'),
  callChunk(1, 'call_1', 'read_kp'),
]

console.log('1. 上一轮已出正文、这一轮空返回：返回那段正文，而不是报「没有返回」')
{
  const ctx = fakeCtx([roundWithCall, []])
  let result: { text: string; rounds: number } | undefined
  let thrown = ''
  try {
    result = await runAgentLoop(baseInput(ctx) as never)
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error)
  }
  check('没有把这一轮判成失败', thrown.length === 0, thrown)
  check('拿到了上一轮的文字', (result?.text ?? '').includes('交换价值'), `实际：「${result?.text ?? ''}」`)
  check('确实走了两轮（证明真的进了空返回分支）', (result?.rounds ?? 0) === 2, `rounds=${result?.rounds}`)
}

console.log('2. 第一轮就空返回：确实没有内容，必须报错（不能假装成功）')
{
  const ctx = fakeCtx([[]])
  let message = ''
  try {
    await runAgentLoop(baseInput(ctx) as never)
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check('抛错且说清是空返回', /没有返回任何内容/.test(message), `实际：${message}`)
}

console.log('3. 正常返回不受影响')
{
  const ctx = fakeCtx([[textChunk(0, '正常回答')]])
  const result = await runAgentLoop(baseInput(ctx) as never)
  check('原样返回', result.text === '正常回答', `实际：「${result.text}」`)
}

console.log('4. 轮次用尽后的收口轮空返回：也要给最后一句话，不能报错')
{
  const ctx = fakeCtx([
    [textChunk(0, '第一轮的话。'), callChunk(1, 'c1', 'read_kp')],
    [textChunk(0, '第二轮的话。'), callChunk(1, 'c2', 'read_kp')],
    [],
  ])
  let result: { text: string } | undefined
  let thrown = ''
  try {
    // maxRounds 2 → 第 2 轮后还有收口轮，收口轮空返回
    result = await runAgentLoop({ ...baseInput(ctx), maxRounds: 2 } as never)
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error)
  }
  check('没有抛错', thrown.length === 0, thrown)
  check('给了话（第二轮或第一轮）', (result?.text ?? '').length > 0, `实际：「${result?.text ?? ''}」`)
}

console.log('')
if (failed === 0) { console.log('全部通过'); process.exit(0) }
console.log(`有 ${failed} 条不通过`)
process.exit(1)
