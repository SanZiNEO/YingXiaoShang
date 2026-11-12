// B11：真实题目集的交卷链路（学生反馈复现 + 修复验证）
import { Context } from '@deepseek-ai/cordis'
import { DeepSeekLlm } from '../../apps/desktop/src/main/llm.ts'

const APP_HOME = process.env.LA_PROBE_HOME ?? ''
if (!APP_HOME) throw new Error('需要 LA_PROBE_HOME')
const settings = { apiKey: process.env.DEEPSEEK_API_KEY ?? '', model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat' }
const ctx = new Context()
ctx.provide('llm', new DeepSeekLlm(() => settings))
const load = async (pkg: string, name: string) => {
  const mod = await import(`@learning-agent/${pkg}`)
  const v = (mod as any)[name] ?? (mod as any).default
  if (!v) throw new Error(`${pkg} 无 ${name}`)
  return v as any
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
const db: any = (ctx as any).learningDb

const studentId = 'student_demo'
const artifacts = db.listAllArtifacts(50).filter((a: any) => a.type === 'question_set' && a.student_id === studentId)
if (artifacts.length === 0) { console.log('❌ 数据库里没有题目集'); process.exit(1) }
const artifact = artifacts[0]
const questions = (artifact.content_json?.questions ?? []) as any[]
console.log(`题目集：${artifact.title.slice(0, 30)}… 共 ${questions.length} 题`)
console.log('前两题题型:', questions.slice(0, 2).map((q) => `${q.id}:${q.type}`).join('  '))

const before = db.listAttempts({ studentId, limit: 500 }).length
const multi = questions.find((q) => String(q.type).includes('multiple') || q.type === '多选') ?? questions[1]
const single = questions.find((q) => q.id !== multi.id)!
const answers = [
  { questionId: single.id, answer: String(single.answer ?? 'A') },
  { questionId: multi.id, answer: String(multi.answer ?? 'A') },
]
console.log('提交答案:', answers.map((a) => `${a.questionId}=${a.answer}`).join('  '))

const out = await runtime.answerQuestionSet({
  studentId, sessionId: artifact.session_id, artifactId: artifact.id, answers,
}) as any
console.log('交卷状态:', out.status, '| 判出条数:', (out.results ?? []).length)
const after = db.listAttempts({ studentId, limit: 500 }).length
console.log(`attempts: ${before} → ${after} ${after > before ? '✅ 写入成功' : '❌ 没写入'}`)
console.log('题目表行数:', db.listQuestions({ limit: 200 }).length)
const graded = (out.results ?? []).filter((r: any) => typeof r.correct === 'boolean')
console.log('可判题数:', graded.length, graded.map((r: any) => `${r.correct ? '对' : '错'}(${r.score})`).join(' '))
process.exit(0)
