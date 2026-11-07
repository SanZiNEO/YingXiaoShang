// B9：学情档案闭环验证（两种数据形态：老用户旧库 / 新用户种子库）
// 跑法：
//   LA_PROBE_HOME=<数据目录> pnpm exec tsx probe/a0-dsh/b9-archive-sync.mts
// 断言：record_json 非空、ledger 水位前进、learning_states 有行、episode 生成
import { Context } from '@deepseek-ai/cordis'
import { DeepSeekLlm } from '../../apps/desktop/src/main/llm.ts'

const APP_HOME = process.env.LA_PROBE_HOME ?? ''
if (!APP_HOME) throw new Error('需要 LA_PROBE_HOME')
const settings = {
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
  model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
}

const ctx = new Context()
ctx.provide('llm', new DeepSeekLlm(() => settings))
const load = async (pkg: string, name: string) => {
  const mod = await import(`@learning-agent/${pkg}`)
  const value = (mod as any)[name] ?? (mod as any).default
  if (!value) throw new Error(`${pkg} 没有导出 ${name}`)
  return value as any
}

const LearningDb = await load('db', 'LearningDb')
await ctx.plugin(LearningDb, { appHome: APP_HOME })
new (await load('matcher', 'Matcher'))(ctx)
new (await load('questions', 'QuestionSmith'))(ctx)
new (await load('research', 'ResearchService'))(ctx)
new (await load('bp', 'BpService'))(ctx)
new (await load('profile', 'ProfileService'))(ctx)
new (await load('artifacts', 'ArtifactService'))(ctx, {
  appHome: APP_HOME,
  templatesDir: process.env.LA_TEMPLATES ?? '../../apps/desktop/templates',
})
new (await load('news', 'NewsService'))(ctx, { apiKey: () => settings.apiKey })
const runtime = new (await load('agent', 'AgentService'))(ctx)
const db = (ctx as any).learningDb

function dataStudent(): string {
  return process.env.LA_STUDENT ?? 'student_demo'
}

// 打印基线
const baseline = (label: string) => {
  const ledgers = db.listSummaryLedgers(dataStudent()) ?? []
  console.log(`\n[${label}] 会话数 ${ledgers.length}｜ledger 水位:`,
    ledgers.map((l: any) => `${l.summarized_seq}/${l.source_seq}:${l.status}`).join(' '))
}

const studentId = dataStudent()
baseline('改前')

// 已有会话就用它（复现老用户场景），否则新建
const existing = (db.listChatSessions?.(studentId) ?? [])[0]
const sessionId = existing?.id ?? db.createChatSession({
  studentId,
  chapterId: process.env.LA_CHAPTER ?? 'ch04',
  title: 'b9 档案同步',
})
console.log('使用会话:', sessionId, '章节:', existing?.chapter_id || '(空)')

const t0 = Date.now()
const out = await runtime.handleConversation(
  { studentId, sessionId, message: '我的理解是：消费者市场的特点就是人多但需求分散，所以要先做细分再谈定位。你看我这个说法对吗？' },
  { onEvent: () => {} },
)
console.log(`\n本轮 ${((Date.now() - t0) / 1000).toFixed(1)}s，正文 ${out.text.length} 字`)

// 等记录器把后台活干完（它是异步的，不等就看不到结果）
await runtime.flushRecorder()
await new Promise((r) => setTimeout(r, 1200))

const turns = db.listTurns(sessionId, 50)
const last = turns.find((row: any) => row.turn_id === out.turnId) ?? turns[0]
console.log('\n=== 断言 ===')
const recordLen = typeof last?.record_json === 'string'
  ? last.record_json.length
  : JSON.stringify(last?.record_json ?? {}).length
console.log(`1. record_json 长度: ${recordLen}  ${recordLen > 2 ? '✅ 非空' : '❌ 仍是空对象'}`)

const ledgers = db.listSummaryLedgers(studentId) ?? []
const mine = ledgers.find((l: any) => l.source_id === sessionId)
console.log(`2. 本会话 ledger: ${mine?.summarized_seq}/${mine?.source_seq} status=${mine?.status} ${
  mine && mine.summarized_seq > 0 ? '✅ 水位前进' : '❌ 水位仍是 0'}`)

let states: any[] = []
try { states = db.listLearningStates?.(studentId) ?? [] } catch { states = [] }
console.log(`3. learning_states 行数: ${states.length} ${states.length > 0 ? '✅' : '⚠️ 本次没写入（章节为空时不写）'}`)

const episodes = db.listMemoryEpisodes?.(studentId) ?? []
console.log(`4. memory_episodes 行数: ${episodes.length}`)
const evidence = db.listEvidence?.({ studentId, limit: 500 }) ?? []
console.log(`5. evidence 行数: ${evidence.length}（本轮若抽到证据会 +N）`)
const pendingFail = ledgers.filter((l: any) => l.status === 'failed')
console.log(`6. failed ledger: ${pendingFail.length} ${pendingFail.length === 0 ? '✅' : '❌ ' + JSON.stringify(pendingFail[0]?.last_error)}`)

process.exit(0)
