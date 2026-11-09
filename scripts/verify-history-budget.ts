/**
 * 历史压缩的断言脚本（可以真的变红的那种）。
 *
 * 跑法：pnpm exec tsx scripts/verify-history-budget.ts
 *
 * 为什么不是"打印一下看看"：只要实现把上限去掉、或者把最近几轮也折进摘要，
 * 下面任一条就会失败。这是给未来改这块的人留的护栏。
 */
import { buildHistoryView } from '../packages/agent/src/history.js'

let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✅ ${name}`)
    return
  }
  failed += 1
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
}

function message(role: 'user' | 'assistant', content: string): { role: 'user' | 'assistant'; content: string } {
  return { role, content }
}

console.log('1. 长历史必须有上限（200 轮也不能无限膨胀）')
{
  const messages = []
  for (let i = 0; i < 200; i += 1) {
    messages.push(message('user', `第${i}个问题：`.padEnd(20, '问') + '详细描述'.repeat(20)))
    messages.push(message('assistant', `第${i}个回答：`.padEnd(20, '答') + '解释'.repeat(200)))
  }
  const view = buildHistoryView({ messages })
  // 用绝对阈值而不是常量本身：改常量时这条必须还能报警。
  check('逐字部分不超过 8000 字符', view.stats.keptChars <= 8000, `实际 ${view.stats.keptChars}`)
  check('摘要不超过 800 字符', view.stats.digestChars <= 800, `实际 ${view.stats.digestChars}`)
  check('确实折掉了大部分消息', view.stats.foldedMessages > 380, `实际 ${view.stats.foldedMessages}`)
  check('保留的是最后几条', view.messages.at(-1)?.content.startsWith('第199个回答'), view.messages.at(-1)?.content.slice(0, 20))
  check('逐字部分以学生发言开头', view.messages[0]?.role === 'user')
  // 注意：HISTORY_MAX_CHARS 是第二道闸，只有在单条助手消息上限被调大时才咬合
  // （默认 1200 字 × 3 轮 ≈ 3600 < 7000）。所以这里断言「总量」这个真正的约束，
  // 7000 那条路径由 2b 用显式 maxChars 覆盖。
  check('逐字 + 摘要总量不超过 9000', view.stats.keptChars + view.stats.digestChars <= 9000,
    `实际 ${view.stats.keptChars + view.stats.digestChars}`)
}

console.log('2. 最近 3 轮必须逐字保留（否则"刚才那个"就断指代）')
{
  const messages = [
    message('user', '很久以前的问题'),
    message('assistant', '很久以前的回答'),
    message('user', '第二个问题'),
    message('assistant', '第二个回答'),
    message('user', '第三个问题'),
    message('assistant', '第三个回答'),
    message('user', '最近一个问题'),
    message('assistant', '最近一个回答'),
  ]
  const view = buildHistoryView({ messages })
  const texts = view.messages.map((item) => item.content)
  check('最近 3 轮共 6 条都在', ['第二个问题', '第三个问题', '最近一个问题'].every((text) => texts.includes(text)), texts.join('|'))
  check('更早的进了摘要', view.digest.includes('很久以前的问题'), view.digest)
}

console.log('2b. 最近几轮本身超预算时，必须继续往前折（不能只靠条数）')
{
  const messages = []
  for (let i = 0; i < 6; i += 1) {
    messages.push(message('user', `问题${i}` + '问'.repeat(400)))
    // 关掉单条截断，专门逼出 maxChars 这条路径
    messages.push(message('assistant', `回答${i}` + '答'.repeat(5000)))
  }
  const view = buildHistoryView({ messages, assistantMaxChars: 6000, maxChars: 7000 })
  check('超预算时逐字部分被压到 7000 以内', view.stats.keptChars <= 7000, `实际 ${view.stats.keptChars}`)
  check('被搬走的轮次进了摘要', view.stats.foldedMessages > 0 && view.digest.length > 0)
  check('仍然以学生发言开头', view.messages[0]?.role === 'user')
}

console.log('3. 助手长回答要截断（答案可能几千字，没必要整段重发）')
{
  const long = '原'.repeat(5000)
  const view = buildHistoryView({
    messages: [message('user', '问题'), message('assistant', long), message('user', '继续'), message('assistant', '短答案')],
  })
  const kept = view.messages.find((item) => item.role === 'assistant')
  check('被截断的条数被记下', view.stats.truncatedMessages === 1, String(view.stats.truncatedMessages))
  check('截断后不超过 1300 字符', (kept?.content.length ?? 0) <= 1300, String(kept?.content.length))
  check('保留了开头内容', kept?.content.startsWith('原原原') ?? false)
}

console.log('4. 空历史 / 极短历史不产生摘要')
{
  const empty = buildHistoryView({ messages: [] })
  check('空历史没有消息', empty.messages.length === 0)
  check('空历史没有摘要', empty.digest === '')
  const short = buildHistoryView({ messages: [message('user', '你好'), message('assistant', '在的')] })
  check('短历史不生成摘要', short.digest === '', short.digest)
  check('短历史原样保留', short.messages.length === 2)
}

console.log('5. 会话摘要优先于机械拼接')
{
  const messages = []
  for (let i = 0; i < 12; i += 1) {
    messages.push(message('user', `早期问题${i}`))
    messages.push(message('assistant', `早期回答${i}`))
  }
  const view = buildHistoryView({
    messages,
    episodeSummaries: ['第1轮「消费者行为」learning→learning；章节 ch04；主 Agent 直接回应'],
  })
  check('摘要里带上一轮会话结论', view.digest.includes('消费者行为'), view.digest)
  check('摘要仍有 800 字符上限', view.digest.length <= 800, String(view.digest.length))
}

console.log('6. 同样的输入必须给出同样的输出（可复现）')
{
  const messages = []
  for (let i = 0; i < 40; i += 1) {
    messages.push(message('user', `q${i}`.padEnd(30, 'x')))
    messages.push(message('assistant', `a${i}`.padEnd(500, 'y')))
  }
  const a = JSON.stringify(buildHistoryView({ messages }))
  const b = JSON.stringify(buildHistoryView({ messages }))
  check('两次结果一致', a === b)
}

console.log('')
if (failed === 0) {
  console.log('全部通过')
  process.exit(0)
}
console.log(`有 ${failed} 条不通过`)
process.exit(1)
