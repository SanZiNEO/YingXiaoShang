// B10：历史压缩的端到端验证——同一会话连问 8 轮，看每轮请求里的历史大小
// 跑法：LA_PROBE_HOME=<数据目录> pnpm exec tsx probe/a0-dsh/b10-history-budget.mts
import { Context } from '@deepseek-ai/cordis'
import { DeepSeekLlm } from '../../apps/desktop/src/main/llm.ts'

const APP_HOME = process.env.LA_PROBE_HOME ?? ''
if (!APP_HOME) throw new Error('需要 LA_PROBE_HOME')
const settings = { apiKey: process.env.DEEPSEEK_API_KEY ?? '', model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat' }

const ctx = new Context()
ctx.provide('llm', new DeepSeekLlm(() => settings))
const load = async (pkg: string, name: string) => {
  const mod = await import(`@learning-agent/${pkg}`)
  const value = (mod as any)[name] ?? (mod as any).default
  if (!value) throw new Error(`${pkg} 没有导出 ${name}`)
  return value as any
}
await ctx.plugin(await load('db', 'LearningDb'), { appHome: APP_HOME })
new (await load('matcher', 'Matcher'))(ctx)
new (await load('questions', 'QuestionSmith'))(ctx)
new (await load('research', 'ResearchService'))(ctx)
new (await load('bp', 'BpService'))(ctx)
new (await load('profile', 'ProfileService'))(ctx)
new (await load('artifacts', 'ArtifactService'))(ctx, { appHome: APP_HOME, templatesDir: process.env.LA_TEMPLATES ?? '../../apps/desktop/templates' })
new (await load('news', 'NewsService'))(ctx, { apiKey: () => settings.apiKey })
const runtime = new (await load('agent', 'AgentService'))(ctx)
const db = (ctx as any).learningDb

const studentId = process.env.LA_STUDENT ?? 'student_demo'
// 数据副本可能没有该学生档案，先补一条，否则 chat_sessions 外键失败
if (!db.getStudentProfile(studentId)) {
  db.upsertStudentProfile({
    id: studentId,
    name: '演示学生',
    cohort: '',
    background: {},
    goals: [],
    preferences: {},
    constraints: [],
    self_assessment: {},
  })
}
const sessionId = db.createChatSession({ studentId, chapterId: 'ch04', title: 'b10 历史预算' })
console.log('会话:', sessionId)

const QUESTIONS = [
  '消费者市场的特点是什么？',
  '那它和消费者购买行为有什么关系？',
  '举个生活里的例子。',
  '再举个相反的例子。',
  '这两个例子差别在哪？',
  '如果我做零食品牌，该怎么用？',
  '刚才第一个问题你说了什么？',
  '把上面几轮串起来总结一下。',
]

let maxKept = 0
for (let i = 0; i < QUESTIONS.length; i += 1) {
  const question = QUESTIONS[i]!
  // 「改前」的对照：把已有历史原样相加
  const raw = db.listChatMessages(sessionId)
    .filter((m: any) => m.role === 'user' || m.role === 'assistant')
    .reduce((sum: number, m: any) => sum + m.content.length, 0)
  const t0 = Date.now()
  const out = await runtime.handleConversation({ studentId, sessionId, message: question }, { onEvent: () => {} })
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  const kept = out.trace?.context?.messageChars ?? -1
  maxKept = Math.max(maxKept, kept)
  const digestOn = (out.trace?.context?.systemChars ?? 0) > 0
  console.log(
    `第 ${i + 1} 轮 ${dt.padStart(4)}s | 若全量重放 ${String(raw).padStart(6)} 字 | 实际历史 ${String(kept).padStart(5)} 字 | 调用 ${out.trace?.modelCalls} 次 | 正文 ${out.text.length} 字`,
  )
}

console.log(`\n峰值历史: ${maxKept} 字 ${maxKept <= 9000 ? '✅ 有界' : '❌ 超界'}`)
await runtime.flushRecorder()
const episodes = db.listMemoryEpisodes(studentId, 50).filter((e: any) => e.session_id === sessionId)
console.log(`本会话摘要条数: ${episodes.length}（会进 system 作为压缩历史）`)
process.exit(0)
