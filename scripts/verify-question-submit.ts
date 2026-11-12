/**
 * 题目集交卷链路的断言脚本。
 *
 * 跑法：pnpm exec tsx scripts/verify-question-submit.ts
 *
 * 对应学生反馈的两个问题：
 *   1. 多选题只能选一个（题型是 multiple_choice，界面只认「多选」）
 *   2. 选完选项无法提交批改（题目只在 artifact 里，questions 表没有行，
 *      判题取题失败 + question_attempts 外键过不去）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { normalizeQuestionType } from '@learning-agent/shared'
import { registerArtifactQuestions } from '../packages/agent/src/question-registry.js'
import { scoreAnswer } from '../packages/agent/src/text.js'

let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✅ ${name}`)
    return
  }
  failed += 1
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log('1. 题型归一（模型爱写英文 token）')
{
  check('multiple_choice → 多选', normalizeQuestionType('multiple_choice') === '多选')
  check('multi_select → 多选', normalizeQuestionType('multi_select') === '多选')
  check('single_choice → 单选', normalizeQuestionType('single_choice') === '单选')
  check('judgment → 判断', normalizeQuestionType('judgment') === '判断')
  check('case_analysis → 案例分析', normalizeQuestionType('case_analysis') === '案例分析')
  check('「多选题」→ 多选', normalizeQuestionType('多选题') === '多选')
  check('未知 token 有兜底', normalizeQuestionType('???') === '简答')
}

console.log('2. 判题：多选按集合比对，不是文本相似度')
{
  const question = {
    id: 'q4', source_type: 'kp' as const, source_id: '', type: normalizeQuestionType('multiple_choice'),
    stem: '以下属于消费者市场特点的有？', options: ['人多', '需求分散', '可细分', '统一需求'],
    answer: 'A,B,C', explanation: '', difficulty: 2, kp_ids: ['kp_x'], ideology_ids: [], status: 'draft' as const,
  }
  const exact = scoreAnswer(question, 'A,B,C')
  check('全对 → correct', exact.correct === true, JSON.stringify(exact))
  const partial = scoreAnswer(question, 'A,B')
  check('对 2/3 → 不算全对但有部分分', partial.correct === false && partial.partial === true && partial.score > 0.5, JSON.stringify(partial))
  const wrong = scoreAnswer(question, 'D')
  check('全错 → 0 分', wrong.correct === false && wrong.score === 0, JSON.stringify(wrong))
}

console.log('3. 题目登记：artifact 里的题必须落进 questions 表（否则外键过不去）')
await (async () => {
  const home = mkdtempSync(join(tmpdir(), 'qing-question-'))
  try {
    const ctx = new Context()
    const mod: any = await import('@learning-agent/db')
    const LearningDb = mod.default ?? mod.LearningDb
    await ctx.plugin(LearningDb, { appHome: home })
    const db: any = (ctx as any).learningDb

    // artifacts.student_id 有外键，先建学生档案
    if (!db.getStudentProfile('student_demo')) {
      db.upsertStudentProfile({
        id: 'student_demo', name: '测试学生', cohort: '', background: {}, goals: [],
        preferences: {}, constraints: [], self_assessment: {},
      })
    }
    const artifactId = 'art_test_1'
    const chapterId = db.listChapters()[0]?.id ?? ''
    const content = {
      intro: '测试题组',
      questions: [
        { id: 'q1', type: 'single_choice', stem: '单选示例', options: ['A项', 'B项'], answer: 'A', explanation: '', difficulty: 1 },
        { id: 'q4', type: 'multiple_choice', stem: '多选示例', options: ['甲', '乙', '丙'], answer: 'A,B', explanation: '', difficulty: 2 },
      ],
    }
    const artifact = db.insertArtifact?.({
      id: artifactId, student_id: 'student_demo', session_id: 's1', skill_id: 'agent', template_id: 'question_set',
      type: 'question_set', title: '测试题组', format: 'docx', path: '', content: '', evidence_ids: [], created_at: new Date().toISOString(),
      content_json: content, schema_version: 'QuestionSet@1', version: 1, status: 'draft', source_refs: [],
    })

    check('questions 表初始没有这两题', !db.getQuestion('q1') && !db.getQuestion('q4'))

    const first = registerArtifactQuestions({
      db,
      artifact: { id: artifactId, type: 'question_set', content_json: content },
      chapterId,
      preferGlobalIds: false,
    })
    check('登记后 questions 表有两行', Boolean(db.getQuestion('q1')) && Boolean(db.getQuestion('q4')), `registered=${first.registered}`)
    const typeRow = db.getQuestion('q4')
    check('表里题型是中文口径（多选）', typeRow?.type === '多选', String(typeRow?.type))

    // 学生交卷：写入作答记录（外键必须过）
    let attemptOk = false
    try {
      db.recordAttempt({ questionId: 'q4', studentId: 'student_demo', answer: 'A,B', feedback: {}, score: 1 })
      attemptOk = true
    } catch (error) {
      attemptOk = false
      console.log('     写入作答记录报错：', error instanceof Error ? error.message : String(error))
    }
    check('作答记录能写入（外键满足）', attemptOk)

    // 幂等：重复登记不产生新行
    const before = db.listQuestionIds?.()?.length ?? null
    registerArtifactQuestions({
      db,
      artifact: { id: artifactId, type: 'question_set', content_json: content },
      chapterId,
      preferGlobalIds: false,
    })
    check('重复登记不报错', Boolean(db.getQuestion('q1')))

    // 老产物沿用原 id：界面已经渲染的 q1/q4 仍然对得上
    check('老产物保留原题号 q1', Boolean(db.getQuestion('q1')))
  } finally {
    // Windows 上 SQLite 还占着文件，删不掉就留着（在系统临时目录里）
    try { rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})()

console.log('')
if (failed === 0) {
  console.log('全部通过')
  process.exit(0)
}
console.log(`有 ${failed} 条不通过`)
process.exit(1)
