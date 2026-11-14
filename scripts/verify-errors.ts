/**
 * 错误文案的断言脚本（能变红）。
 *
 * 跑法：pnpm exec tsx scripts/verify-errors.ts
 *
 * 为什么单独测：学生看到的只有这一句话。英文栈/「transport failed」
 * 会让人以为是自己弄坏了，或者干脆不知道下一步做什么。
 */
import { friendlyError } from '../apps/desktop/src/main/errors.js'

let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✅ ${name}`)
    return
  }
  failed += 1
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 文案不能出现「裸英文技术词」，否则等于没翻译。 */
function isHuman(text: string): boolean {
  return !/fetch failed|ENOTFOUND|ECONNRESET|transport failed|SQLITE|TypeError|at .*\.ts:/i.test(text)
}

const cases: Array<[string, unknown, RegExp]> = [
  ['没配 key', new Error('DEEPSEEK_API_KEY is not configured'), /设置/],
  ['key 无效', new Error('401 Unauthorized: Invalid credential'), /密钥无效/],
  ['余额不足', new Error('402 Insufficient Balance'), /余额/],
  ['限流', new Error('429 rate limit exceeded'), /太频繁/],
  ['模型名错', new Error('DeepSeek API 400: {"error":{"message":"Model Not Exist"}}'), /deepseek-chat/],
  ['断网', new TypeError('fetch failed'), /网络/],
  ['DNS 失败', new Error('getaddrinfo EAI_AGAIN api.deepseek.com'), /网络/],
  ['连接被重置', new Error('ECONNRESET socket hang up'), /网络/],
  ['超时', new Error('The operation was aborted due to timeout'), /等太久/],
  ['流中断', new Error('DeepSeek Messages transport failed'), /连接中途断了/],
  ['磁盘写满', new Error('SQLITE_FULL: disk I/O error'), /磁盘/],
  ['模型空返回', new Error('模型没有返回任何内容'), /没有返回内容/],
]

for (const [label, error, expected] of cases) {
  const friendly = friendlyError(error)
  const ok = expected.test(friendly.message) && isHuman(friendly.message)
  check(`${label} → ${friendly.message.slice(0, 28)}…`, ok, friendly.message)
}

console.log('')
{
  const chat = friendlyError(new Error('fetch failed'), { context: 'chat' })
  const answer = friendlyError(new Error('fetch failed'), { context: 'answer' })
  check('聊天场景提示「没有保存成结果」', /没有保存成结果/.test(chat.message), chat.message)
  check('交卷场景提示「没有记成成绩」', /没有记成成绩/.test(answer.message), answer.message)
}

{
  const unknown = friendlyError(new Error('some weird internal thing happened'))
  check('未知错误也带回退建议', /截图发给老师/.test(unknown.message), unknown.message)
  check('未知错误不乱吞内容', /some weird internal thing/.test(unknown.message), unknown.message)
}

console.log('')
if (failed === 0) {
  console.log('全部通过')
  process.exit(0)
}
console.log(`有 ${failed} 条不通过`)
process.exit(1)
