/**
 * 新会话首轮失败时，界面必须已经知道真实 sessionId。
 *
 * 旧行为：sessionId 只在整轮成功后返回，失败时界面拿 undefined，
 * 重发就再建一条会话，旧的那条没人认领（F18，孤儿会话）。
 *
 * 这里有两条断言：
 *  ① 行为层：session 事件在「可能失败的调用」之前就发出去了（顺序断言）
 *  ② 接线层：渲染层收到这个事件会 setSessionId（源码断言，防删除）
 */
import { readFileSync } from 'node:fs'

let pass = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const agent = read('../packages/agent/src/index.ts')
const team = read('../packages/agent/src/team.ts')
const app = read('../apps/desktop/src/renderer/src/App.tsx')
const streamState = read('../apps/desktop/src/renderer/src/stream-state.ts')

console.log('1. 事件类型里有 session，并且能带上 sessionId')
{
  check('TeamEvent 支持 session', /'session'/.test(team))
  check('TeamEvent 有 sessionId 字段', /sessionId\?: string/.test(team))
  check('渲染层事件类型也支持 session', /'session'/.test(streamState))
}

console.log('2. 顺序：先报 sessionId，再调用可能失败的东西')
{
  const emitIndex = agent.indexOf("type: 'session'")
  const createIndex = agent.indexOf('this.db.createChatSession(')
  const runIndex = agent.indexOf('await runTeamTurn(')
  check('确实发了 session 事件', emitIndex > 0)
  check('在「建会话」之后发（此时 id 才存在）', emitIndex > createIndex, `create@${createIndex}, emit@${emitIndex}`)
  check('在「跑模型」之前发（模型失败也不影响已发出的 id）', emitIndex > 0 && emitIndex < runIndex,
    `emit@${emitIndex}, runTeamTurn@${runIndex}`)
  // 学生消息也必须落在同一个 session 上，否则失败后翻记录看不到自己那句话。
  const insertIndex = agent.indexOf('insertChatMessage({')
  check('学生消息写在同一个会话里（在 emit 之后）', insertIndex > emitIndex)
}

console.log('3. 接线：渲染层收到 session 事件会记住它')
{
  check('onChatEvent 里处理 session 事件', /item\.type === 'session'/.test(app))
  check('会调用 setSessionId', /setSessionId\(item\.sessionId\)/.test(app))
  check('空 id 不会把已有会话覆盖成空', /sessionId\.length > 0/.test(app))
}

console.log('4. 主进程把事件原样推给界面（不吞 session 事件）')
{
  const main = read('../apps/desktop/src/main/index.ts')
  check('onEvent 转发到 learning:chat-event', /learning:chat-event/.test(main))
  check('转发时带上 requestId', /requestId, \.\.\.step/.test(main))
}

console.log('')
if (failed === 0) { console.log('全部通过'); process.exit(0) }
console.log(`有 ${failed} 条不通过`)
process.exit(1)
