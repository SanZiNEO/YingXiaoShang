// B8：把应用的完整链路搬进探针，同一会话连跑 6 轮
// 目的：复现「连续问三四次就卡住」，并指出卡在哪一步
// 跑法：pnpm exec tsx probe/a0-dsh/b8-app-turns.mts
import { Context } from '@deepseek-ai/cordis'
import { DeepSeekLlm } from '../../apps/desktop/src/main/llm.ts'

const APP_HOME = process.env.LA_PROBE_HOME ?? ''
if (!APP_HOME) throw new Error('需要 LA_PROBE_HOME（数据副本目录）')

const settings = {
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
  model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
}

const ctx = new Context()
ctx.provide('llm', new DeepSeekLlm(() => settings))

const load = async (pkg: string, name: string) => {
  const mod = await import(`@learning-agent/${pkg}`)
  const value = mod[name] ?? mod.default
  if (!value) throw new Error(`${pkg} 没有导出 ${name}`)
  return value as any
}

const LearningDb = await load('db', 'LearningDb')
await ctx.plugin(LearningDb, { appHome: APP_HOME })

const Matcher = await load('matcher', 'Matcher')
const QuestionSmith = await load('questions', 'QuestionSmith')
const ResearchService = await load('research', 'ResearchService')
const BpService = await load('bp', 'BpService')
const ProfileService = await load('profile', 'ProfileService')
const ArtifactService = await load('artifacts', 'ArtifactService')
const NewsService = await load('news', 'NewsService')
const AgentService = await load('agent', 'AgentService')

new Matcher(ctx)
new QuestionSmith(ctx)
new ResearchService(ctx)
new BpService(ctx)
new ProfileService(ctx)
new ArtifactService(ctx, { appHome: APP_HOME, templatesDir: process.env.LA_TEMPLATES ?? '../../apps/desktop/templates' })
new NewsService(ctx, { apiKey: () => settings.apiKey })
const runtime = new AgentService(ctx)

// 先建会话，否则 chat_messages 外键失败
const sessionId = (ctx as any).learningDb.createChatSession({
  studentId: 'student_demo',
  title: 'probe 连续多轮',
})
const QUESTIONS = [
  '消费者、消费者市场、消费者市场的特点这三个概念，一起讲一遍，并说明它们的关系。',
  '再加上「消费者购买行为」和「消费者行为的一般过程」，五个概念横向对比。',
]

for (let i = 0; i < QUESTIONS.length; i += 1) {
  const q = QUESTIONS[i]
  const t0 = Date.now()
  let timedOut = false
  const work = runtime.handleConversation(
    { studentId: 'student_demo', sessionId, message: q },
    { onEvent: (step: unknown) => { process.stdout.write('.') } },
  )
  const result = await Promise.race([
    work.then((r: any) => ({ ok: true as const, r })),
    new Promise((res) => setTimeout(() => res({ ok: false as const, r: null }), 180_000)),
  ])
  if (!result.ok) timedOut = true
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  if (timedOut) {
    console.log(`\n第 ${i + 1} 轮 ⛔ 180s 未返回，卡住 | 问题：${q}`)
    process.exit(0)
  }
  const r = result.r as any
  const t = r?.trace ?? {}
  console.log(`\n第 ${i + 1} 轮 ✅ ${dt}s | 模型调用 ${t.modelCalls ?? '?'} 次 | 工具 ${t.toolCalls ?? '?'} 次 | 正文 ${String(r?.text ?? '').length} 字`)
}

console.log('\n6 轮全部完成，未复现。')
process.exit(0)
