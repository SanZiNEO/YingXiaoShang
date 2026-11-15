/**
 * 交卷重试：学生改过的答案必须被判，顺序必须沿用旧记录。
 *
 * 这条以前只能靠「造假数据库 + 假模型」才能测，所以一直没测；抽成纯函数后
 * 至少能把最容易写反的两件事钉住：内容取新的、顺序取旧的。
 */
import { mergeRetryAnswers } from '../packages/agent/src/answer-merge.js'

let pass = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const q = (questionId: string, answer: string) => ({ questionId, answer })

console.log('1. 学生改了答案：判新的，不是库里的旧的')
{
  const merged = mergeRetryAnswers([q('q1', '旧答案A'), q('q2', '旧答案B')], [q('q2', '新答案B')])
  check('第 2 题用新答案', merged[1]?.answer === '新答案B', `实际：${merged[1]?.answer}`)
  check('第 1 题没被改动', merged[0]?.answer === '旧答案A', `实际：${merged[0]?.answer}`)
  check('题数不变（还是 2 题）', merged.length === 2, `实际：${merged.length}`)
}

console.log('2. 顺序必须沿用旧记录（判分结果按下标复用）')
{
  const merged = mergeRetryAnswers(
    [q('q1', 'a'), q('q2', 'b'), q('q3', 'c')],
    [q('q3', 'c2'), q('q1', 'a2')],
  )
  check('仍是 q1,q2,q3 的顺序', merged.map((item) => item.questionId).join(',') === 'q1,q2,q3',
    `实际：${merged.map((item) => item.questionId).join(',')}`)
  check('q1 用新答案', merged[0]?.answer === 'a2')
  check('q2 保留旧答案', merged[1]?.answer === 'b')
  check('q3 用新答案', merged[2]?.answer === 'c2')
}

console.log('3. 第一次交卷（没有旧记录）：用提交的')
{
  const merged = mergeRetryAnswers([], [q('q1', 'x'), q('q2', 'y')])
  check('原样返回', merged.length === 2 && merged[0]?.answer === 'x')
}

console.log('4. 重试但没传答案：保留旧的（不能凭空清空）')
{
  const merged = mergeRetryAnswers([q('q1', 'a')], [])
  check('旧答案还在', merged.length === 1 && merged[0]?.answer === 'a')
}

console.log('5. 出现旧记录里没有的题：不静默丢掉')
{
  const merged = mergeRetryAnswers([q('q1', 'a')], [q('q1', 'a2'), q('q9', 'z')])
  check('追加到末尾', merged.map((item) => item.questionId).join(',') === 'q1,q9',
    `实际：${merged.map((item) => item.questionId).join(',')}`)
  check('新答案生效', merged[0]?.answer === 'a2')
}

console.log('')
if (failed === 0) { console.log('全部通过'); process.exit(0) }
console.log(`有 ${failed} 条不通过`)
process.exit(1)
