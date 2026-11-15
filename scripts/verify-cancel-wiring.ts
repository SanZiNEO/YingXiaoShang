/**
 * 「停止按钮真的停下」的接线断言。
 *
 * 为什么需要这个文件：`verify-cancel.ts` 只测 `runAgentLoop({signal})`。
 * 复核时做过实验——把 `main/index.ts` 里 `signal: turn.signal` 整行删掉
 * （即复现那个「假停」P1），`verify-cancel.ts` **仍然 6 条全绿**。
 * 也就是说，那条测试防不住它自己要防的 bug。
 *
 * 这里补两个层次：
 *  ① 行为层：TurnCanceller 的 begin/cancel/done 语义（信号真的会 abort）
 *  ② 源码层：models 主进程必须把 signal 传进 handleConversation
 *     （结构断言很土，但正是它能抓住「删掉一行」这类回归）
 */
import { readFileSync } from 'node:fs'
import { TurnCanceller } from '../apps/desktop/src/main/turn-canceller.js'

let pass = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('1. 点停止 → 这一轮的 signal 立刻 aborted')
{
  const canceller = new TurnCanceller()
  const turn = canceller.begin('req_1')
  check('还没点之前没 aborted', !turn.signal.aborted)
  const cancelled = canceller.cancel('req_1')
  check('cancel 返回 true（界面才提示「已停止」）', cancelled === true)
  check('signal 真的 aborted', turn.signal.aborted === true)
}

console.log('2. 停止之后这一轮从表里移除，重复点不会误报')
{
  const canceller = new TurnCanceller()
  const turn = canceller.begin('req_2')
  canceller.cancel('req_2')
  check('再点一次返回 false', canceller.cancel('req_2') === false)
  check('表里清空了', canceller.size === 0, `size=${canceller.size}`)
  turn.done()
}

console.log('3. 轮次正常结束：signal 不会被误 abort')
{
  const canceller = new TurnCanceller()
  const turn = canceller.begin('req_3')
  turn.done()
  check('结束后 signal 仍是未中断', !turn.signal.aborted)
  check('结束后 cancel 返回 false', canceller.cancel('req_3') === false)
  check('表里清空了', canceller.size === 0)
}

console.log('4. 两轮并行：只停被点的那一轮')
{
  const canceller = new TurnCanceller()
  const first = canceller.begin('req_a')
  const second = canceller.begin('req_b')
  canceller.cancel('req_a')
  check('A 停了', first.signal.aborted)
  check('B 还在跑', !second.signal.aborted)
  check('表里剩 1 条', canceller.size === 1, `size=${canceller.size}`)
  second.done()
}

console.log('5. 没有 requestId 的一轮：能跑，但不可停止（不报错）')
{
  const canceller = new TurnCanceller()
  const turn = canceller.begin('')
  check('拿到 signal', turn.signal instanceof AbortSignal)
  check('空 id 不进表', canceller.size === 0)
  turn.done()
}

console.log('6. 源码层：主进程必须把 signal 交给执行链（防「假停」回归）')
{
  const source = readFileSync(new URL('../apps/desktop/src/main/index.ts', import.meta.url), 'utf8')
  check('创建了这一轮的控制器', /turnCanceller\.begin\(/.test(source))
  check('cancel 通道接在 canceller 上', /turnCanceller\.cancel\(/.test(source))
  // 这一行就是复核实验里被删掉的那一行：删了它，停止按钮变成假停。
  check('signal 传进了 handleConversation 的 hooks',
    /signal:\s*turn\.signal/.test(source),
    '找不到 `signal: turn.signal`——删掉它就会假停（界面上停了，模型还在跑）')
  const chatBlock = source.slice(source.indexOf("ipcMain.handle('learning:chat'"))
  const signalIndex = chatBlock.indexOf('signal: turn.signal')
  const conversationIndex = chatBlock.indexOf('handleConversation(')
  check('signal 出现在 handleConversation 调用之后（确实传给它了）',
    conversationIndex >= 0 && signalIndex > conversationIndex,
    `handleConversation@${conversationIndex}, signal@${signalIndex}`)
  check('结束后释放控制器', /turn\.done\(\)/.test(source))
}

console.log('')
if (failed === 0) { console.log('全部通过'); process.exit(0) }
console.log(`有 ${failed} 条不通过`)
process.exit(1)
