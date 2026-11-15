/**
 * 流式事件 → 界面状态 的断言。
 *
 * 重点只有一条：**工具事件不能清空已出正文**。
 * 这条以前写在 React 回调里，只能靠手点发现；它违反 R21:11/48/80，
 * 而代码注释还写着「收回这段，避免半截话上屏」——看起来像故意设计，
 * 所以更需要一条机器能判的断言。
 */
import { applyStreamEvent, TOOL_LABEL, type StreamState } from '../apps/desktop/src/renderer/src/stream-state.js'

let pass = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const base = (text = ''): StreamState => ({ requestId: 'r1', text, step: '' })

console.log('1. 已出正文不能被工具事件清掉')
{
  const before = base('先给你一句结论：')
  const after = applyStreamEvent(before, { requestId: 'r1', agent: 'lead', type: 'tool', tool: 'read_kp' })
  check('文字还在', after?.text === '先给你一句结论：', `实际：「${after?.text ?? '（undefined）'}」`)
  check('阶段提示变成查知识点的说法', after?.step === TOOL_LABEL['read_kp'], `实际：${after?.step}`)
}

console.log('2. 连续多次工具事件也不清字')
{
  let state: StreamState | undefined = base('第一段。')
  for (const tool of ['search_news', 'read_news', 'read_textbook']) {
    state = applyStreamEvent(state, { requestId: 'r1', agent: 'lead', type: 'tool', tool })
  }
  check('三段文字完整保留', state?.text === '第一段。', `实际：「${state?.text ?? ''}」`)
  check('阶段停在最后一个动作', state?.step === TOOL_LABEL['read_textbook'])
}

console.log('3. 文字事件是累加，不是覆盖')
{
  const first = applyStreamEvent(base(), { requestId: 'r1', agent: 'lead', type: 'text', text: '甲' })
  const second = applyStreamEvent(first, { requestId: 'r1', agent: 'lead', type: 'text', text: '乙' })
  check('两段拼起来', second?.text === '甲乙', `实际：「${second?.text ?? ''}」`)
  check('出字后阶段提示清空', second?.step === '')
}

console.log('4. 不属于本轮的事件一律忽略（晚到的上一轮事件不能串台）')
{
  const before = base('这一轮的话')
  const after = applyStreamEvent(before, { requestId: 'r2', agent: 'lead', type: 'tool', tool: 'read_kp' })
  check('text 不变', after?.text === '这一轮的话')
  check('step 不变', after?.step === '')
  check('requestId 不变', after?.requestId === 'r1')
}

console.log('5. 空状态与未知事件不炸')
{
  check('没有当前状态时返回原样', applyStreamEvent(undefined, { requestId: 'r1', agent: 'lead', type: 'text', text: 'x' }) === undefined)
  const st = base('abc')
  const same = applyStreamEvent(st, { requestId: 'r1', agent: 'lead', type: 'session', sessionId: 's1' })
  check('session 事件不动正文', same?.text === 'abc')
  const unknownTool = applyStreamEvent(base('x'), { requestId: 'r1', agent: 'lead', type: 'tool', tool: '没见过的工具' })
  check('未知工具名有兜底文案', unknownTool?.step === '查资料', `实际：${unknownTool?.step}`)
}

console.log('')
if (failed === 0) {
  console.log('全部通过')
  process.exit(0)
}
console.log(`有 ${failed} 条不通过`)
process.exit(1)
