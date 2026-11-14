/**
 * 取消（停止按钮）的断言脚本。
 *
 * 跑法：pnpm exec tsx scripts/verify-cancel.ts
 *
 * 为什么要有：查资料一轮可能 1-3 分钟，没有停止就只能干等，
 * 学生以为卡死，重复点发送，越排越长。
 */
import { runAgentLoop } from '../packages/agent/src/tool-loop.js'

let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✅ ${name}`)
    return
  }
  failed += 1
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 假模型：慢慢吐字，用来验证中途被 abort 能不能立刻停下。 */
function slowCtx(delayMs: number) {
  return {
    llm: {
      async *stream(options: { signal?: AbortSignal }) {
        for (let i = 0; i < 50; i += 1) {
          if (options.signal?.aborted) {
            const error = new Error('aborted by signal')
            error.name = 'AbortError'
            throw error
          }
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          yield { type: 'text-delta', text: '字' }
        }
      },
    },
  } as any
}

console.log('1. 没点停止：正常跑完')
{
  const started = Date.now()
  const result = await runAgentLoop({
    ctx: slowCtx(1),
    system: 's',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    maxRounds: 3,
    maxTokens: 100,
  } as any)
  check('返回了内容', result.text.length > 0, `text=${result.text.length}`)
  check('耗时正常', Date.now() - started < 5000, `${Date.now() - started}ms`)
}

console.log('2. 中途停止：必须快速退出，而不是等模型吐完')
{
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 60)
  const started = Date.now()
  let stopped = false
  let message = ''
  try {
    await runAgentLoop({
      ctx: slowCtx(20),
      system: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      maxRounds: 3,
      maxTokens: 100,
      signal: controller.signal,
    } as any)
  } catch (error) {
    stopped = true
    message = error instanceof Error ? error.message : String(error)
  }
  const elapsed = Date.now() - started
  check('抛错而不是静默继续', stopped)
  check('一秒内就退出（50 次 × 20ms 正常要 1 秒以上）', elapsed < 900, `${elapsed}ms`)
  check('错误信息可读', /已停止|aborted/i.test(message), message)
}

console.log('3. 已经停过再调用：不发请求直接退出')
{
  const controller = new AbortController()
  controller.abort()
  let stopped = false
  try {
    await runAgentLoop({
      ctx: slowCtx(1),
      system: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      maxRounds: 3,
      maxTokens: 100,
      signal: controller.signal,
    } as any)
  } catch {
    stopped = true
  }
  check('已停止的信号不会白跑一轮', stopped)
}

console.log('')
if (failed === 0) {
  console.log('全部通过')
  process.exit(0)
}
console.log(`有 ${failed} 条不通过`)
process.exit(1)
