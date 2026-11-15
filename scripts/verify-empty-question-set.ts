/**
 * 空题目集：既不能落库，也不能在界面上变成一句死话。
 *
 * 两条防线：
 *  ① 写入侧：schema 拒绝 `questions: []`，这一轮不生成附件（并给模型可读的退回说明）
 *  ② 界面侧：万一拿到空集（老数据），必须给两个能点的下一步
 */
import { QuestionSetContentSchema } from '@learning-agent/shared'
import { emptyQuestionSetAction } from '../apps/desktop/src/renderer/src/question-set.js'

let pass = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const validQuestion = {
  id: 'q1', type: '单选', stem: '题干', options: ['A', 'B'], answer: 'A', explanation: '', kpIds: [], difficulty: 2,
}

console.log('1. 写入侧：空题目集不通过校验（不会落成空白附件）')
{
  const empty = QuestionSetContentSchema.safeParse({ intro: '看这一章', questions: [] })
  check('questions 为空数组 → 校验失败', !empty.success)
  const missing = QuestionSetContentSchema.safeParse({ intro: '看这一章' })
  check('没给 questions → 校验失败（不再默认为空）', !missing.success)
  const ok = QuestionSetContentSchema.safeParse({ intro: '', questions: [validQuestion] })
  check('一道题 → 通过', ok.success)
}

console.log('2. 界面侧：空集必须给可点的下一步，而不是一句死话')
{
  check('有正文 → 直接显示正文（不打扰）',
    emptyQuestionSetAction({ content: '## 题目\n1. ...' }) === 'markdown')
  check('没正文 → 给重新出题的入口',
    emptyQuestionSetAction({ content: '' }) === 'retry')
  check('只有空白字符也算没正文',
    emptyQuestionSetAction({ content: '   \n  ' }) === 'retry')
}

console.log('')
if (failed === 0) { console.log('全部通过'); process.exit(0) }
console.log(`有 ${failed} 条不通过`)
process.exit(1)
