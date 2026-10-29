/**
 * 自查：轮次预算真的生效吗？
 *
 * R21 把「一轮最多几次模型往返」从 10 压到 3，理由是耗时几乎等于
 * 「轮数 × 单次往返」。但压轮次必须证明两件事：
 *
 *   1. 真的只跑 3 轮，不是声明了却没用上；
 *   2. 轮次用完不报错——还有一次「收口轮」，逼模型用已拿到的材料出结论。
 *      这条最重要：如果压轮次会抛错，上一层会把整套活重派一遍，反而更慢。
 *
 * 跑法：pnpm exec tsx scripts/verify-max-rounds.ts
 * 退出码 0 = 全过。
 */
import { runAgentLoop, type AgentTool } from '../packages/agent/src/tool-loop.js'

let failed = 0
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failed += 1
}

const DSML_CALL =
  '<||DSML||tool_calls><||DSML||invoke name="probe">'
  + '<||DSML||parameter name="q">再查一次</||DSML||parameter>'
  + '</||DSML||invoke></||DSML||tool_calls>'

const probe: AgentTool = {
  name: 'probe',
  description: '假工具，只为让循环有事可做',
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
  execute: () => '查到的材料',
}

/**
 * 假模型：前 `toolRounds` 次一律要工具，之后只给正文。
 * 返回统计数据，方便断言。
 */
function fakeCtx(toolRounds: number) {
  const stats = { requests: 0, streamed: 0 }
  const ctx = {
    llm: {
      stream: async function* () {
        stats.requests += 1
        if (stats.requests <= toolRounds) {
          yield { type: 'text-delta', text: '先取材料。' }
          stats.streamed += 1
          yield { type: 'text-delta', text: DSML_CALL }
          return
        }
        yield { type: 'text-delta', text: '这是最终结论。' }
        stats.streamed += 1
      },
    },
  }
  return { ctx: ctx as never, stats }
}

const system = '你是测试用的助手。'
const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: '帮我看看' }] }]

async function main(): Promise<void> {
  // ---- 0. 标记被切成两片时不能漏（流式最常见的情形）----
  {
    const streamed: string[] = []
    const splitCtx = {
      llm: {
        stream: async function* () {
          yield { type: 'text-delta', text: '结论是' }
          yield { type: 'text-delta', text: '<|' }
          yield { type: 'text-delta', text: '|DSML||tool_calls><||DSML||invoke name="probe">' }
          yield { type: 'text-delta', text: '<||DSML||parameter name="q">查</||DSML||parameter>' }
          yield { type: 'text-delta', text: '</||DSML||invoke></||DSML||tool_calls>' }
        },
      },
    }
    await runAgentLoop({
      ctx: splitCtx as never,
      system,
      messages,
      tools: [probe],
      maxRounds: 1,
      hooks: { streamText: true, onEvent: (e) => { if (e.type === 'text') streamed.push(e.text) } },
    })
    const seen = streamed.join('')
    check('标记被切成两片也不漏给学生', !seen.includes('DSML') && !seen.includes('<|'), seen || '(空)')
    check('标记前面的正文照常圈出去', seen.includes('结论是'), seen)
  }

  // ---- 1. 默认预算：模型一直要工具，也只能跑 3 轮 + 1 次收口 ----
  {
    const { ctx, stats } = fakeCtx(99)
    const streamedText: string[] = []
    const result = await runAgentLoop({
      ctx,
      system,
      messages,
      tools: [probe],
      hooks: {
        streamText: true,
        onEvent: (event) => {
          if (event.type === 'text') streamedText.push(event.text)
        },
      },
    })
    check('一直要工具时只请求 4 次（3 轮 + 收口）', stats.requests === 4, `实际 ${stats.requests} 次`)
    check('轮次用完仍然给出答复，不抛错', result.text.length > 0, result.text)
    check('rounds 记为 4', result.rounds === 4, String(result.rounds))
    check('timings 记录每轮耗时', result.timings.roundMs.length === 4, result.timings.roundMs.join('ms / ') + 'ms')
    check('firstTokenMs 有值（首字真的流出来了）', typeof result.timings.firstTokenMs === 'number')
    check('totalMs 大于等于各轮之和', result.timings.totalMs >= result.timings.roundMs.reduce((a, b) => a + b, 0))
    // 顺手把注入防护验了：DSML 标记绝不能漏到学生眼前。
    check('流式文本里不出现 DSML 标记', !streamedText.join('').includes('DSML'), streamedText.join('') || '(空)')
  }

  // ---- 2. 正常问答：第一轮就给正文，不该多跑 ----
  {
    const { ctx, stats } = fakeCtx(0)
    const result = await runAgentLoop({ ctx, system, messages, tools: [probe] })
    check('直接回答时只请求 1 次', stats.requests === 1, `实际 ${stats.requests} 次`)
    check('rounds 记为 1', result.rounds === 1, String(result.rounds))
    check('正文就是模型输出的那句', result.text.includes('这是最终结论'), result.text)
  }

  // ---- 3. 调用方显式指定：以调用方为准 ----
  {
    const { ctx, stats } = fakeCtx(99)
    await runAgentLoop({ ctx, system, messages, tools: [probe], maxRounds: 1 })
    check('显式 maxRounds=1 时请求 2 次', stats.requests === 2, `实际 ${stats.requests} 次`)
  }

  // ---- 4. 环境变量：不改代码也能调，上限 10 拦住 ----
  {
    process.env.LEARNING_AGENT_MAX_ROUNDS = '2'
    const { ctx, stats } = fakeCtx(99)
    await runAgentLoop({ ctx, system, messages, tools: [probe] })
    check('LEARNING_AGENT_MAX_ROUNDS=2 时请求 3 次', stats.requests === 3, `实际 ${stats.requests} 次`)

    process.env.LEARNING_AGENT_MAX_ROUNDS = '999'
    const capped = fakeCtx(99)
    await runAgentLoop({ ctx: capped.ctx, system, messages, tools: [probe] })
    check('环境变量超上限时封顶 10（请求 11 次）', capped.stats.requests === 11, `实际 ${capped.stats.requests} 次`)

    process.env.LEARNING_AGENT_MAX_ROUNDS = '0'
    const invalid = fakeCtx(99)
    await runAgentLoop({ ctx: invalid.ctx, system, messages, tools: [probe] })
    check('非法值回落到默认 3（请求 4 次）', invalid.stats.requests === 4, `实际 ${invalid.stats.requests} 次`)
    delete process.env.LEARNING_AGENT_MAX_ROUNDS
  }

  // ---- 5. 收口之后不会再开新一轮 ----
  {
    const stats = { requests: 0 }
    const counting = {
      llm: {
        stream: async function* () {
          stats.requests += 1
          yield { type: 'text-delta', text: '先取材料。' }
          yield { type: 'text-delta', text: DSML_CALL }
        },
      },
    }
    await runAgentLoop({ ctx: counting as never, system, messages, tools: [probe] })
    check('收口轮之后不再有第 5 次请求', stats.requests === 4, `实际 ${stats.requests} 次`)
  }
}

main()
  .then(() => {
    console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
    process.exit(failed === 0 ? 0 : 1)
  })
  .catch((error) => {
    console.error('脚本本身出错：', error)
    process.exit(1)
  })
