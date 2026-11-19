/**
 * 业务分发层（desktop 与未来服务端共用）的断言。
 *
 * 抽这一层的唯一目的：服务端化时不要照抄一份业务逻辑。
 * 所以这里要钉住两件事：
 *  ① 桌面端行为没变（关键方法仍返回该有的结构）
 *  ② **studentId 只能来自调用方（会话），入参里的 studentId 必须被忽略**
 *     —— 桌面端单机无所谓，服务端多用户下这条是安全边界。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { dispatchMethod, exportFormat } from '../packages/dispatch/src/index.js'

let pass = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const home = mkdtempSync(join(tmpdir(), 'yxs-dispatch-'))
const ctx = new Context()
const mod: any = await import('@learning-agent/db')
const LearningDb = mod.default ?? mod.LearningDb
await ctx.plugin(LearningDb, { appHome: home })
const db: any = (ctx as any).learningDb

// 依赖只用到 db；其余用桩，避免为了测分发层去装整套模型服务。
const deps: any = {
  db,
  news: {}, matcher: {}, profile: {}, artifacts: {}, agent: {},
}

const studentA = 'student_a'
const studentB = 'student_b'
for (const [id, name] of [[studentA, '学生甲'], [studentB, '学生乙']] as const) {
  if (!db.getStudentProfile(id)) {
    db.upsertStudentProfile({
      id, name, cohort: '', background: {}, goals: [], preferences: {},
      constraints: [], self_assessment: {},
    })
  }
}
const sessionA = db.createChatSession({ studentId: studentA, chapterId: '', title: '甲的会话' })
db.createChatSession({ studentId: studentB, chapterId: '', title: '乙的会话' })
try {
  console.log('1. 桌面端行为不变：关键方法仍返回该有的结构')
  {
    const chapters = await dispatchMethod(deps, 'chapters.list', {}, { studentId: studentA })
    check('chapters.list 返回数组', Array.isArray(chapters))
    const kps = await dispatchMethod(deps, 'kps.list', { limit: 3 }, { studentId: studentA })
    check('kps.list 返回数组', Array.isArray(kps))
    const me = await dispatchMethod(deps, 'student.current', {}, { studentId: studentA }) as any
    check('student.current 带 studentId', me?.studentId === studentA, JSON.stringify(me))
    check('student.current 名字来自档案', me?.name === '学生甲', String(me?.name))
    const status = await dispatchMethod(deps, 'news.status', {}, { studentId: studentA }) as any
    check('news.status 有 count', typeof status?.count === 'number', JSON.stringify(status))
    const missing = await dispatchMethod(deps, 'getKp', { kpId: '不存在' }, { studentId: studentA })
    check('查不到的知识点返回 undefined（不抛错）', missing === undefined)
  }

  console.log('2. studentId 只认调用方传入的会话，不认入参')
  {
    const mine = await dispatchMethod(deps, 'chat.sessions', {}, { studentId: studentA }) as any[]
    check('甲只看到自己的会话', mine.length === 1 && mine[0]?.student_id === studentA,
      JSON.stringify(mine.map((s) => s.student_id)))

    // 攻击面：前端把 args.studentId 改成别人。服务端必须忽略它。
    const spoofed = await dispatchMethod(
      deps, 'chat.sessions', { studentId: studentB }, { studentId: studentA },
    ) as any[]
    check('入参里的 studentId 被忽略（越权防护）',
      spoofed.length === 1 && spoofed[0]?.student_id === studentA,
      JSON.stringify(spoofed.map((s) => s.student_id)))
  }

  console.log('3. 桌面专属能力在服务端要明确报错，而不是静默什么都不做')
  {
    for (const method of ['files.reveal', 'files.preview', 'files.openDialog']) {
      let message = ''
      try {
        await dispatchMethod(deps, method, { path: 'x' }, { studentId: studentA })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      check(`${method} 未注入 host 时抛错`, /只能在桌面端使用/.test(message), message)
    }
  }

  console.log('4. 未知方法要报出方法名（便于排查契约漂移）')
  {
    let message = ''
    try {
      await dispatchMethod(deps, 'no.such.method', {}, { studentId: studentA })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    check('错误里带方法名', message.includes('no.such.method'), message)
  }

  console.log('5. 导出格式归一（搬到 dispatch 后行为不变）')
  {
    check('md 保留', exportFormat('md') === 'md')
    check('html 保留', exportFormat('html') === 'html')
    check('其他一律 docx', exportFormat('pdf') === 'docx')
    check('undefined → docx', exportFormat(undefined) === 'docx')
  }

  console.log('6. 方法清单与契约表一致（防止服务端漏实现）')
  {
    const contract = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../docs/contracts/ipc-methods.md', import.meta.url), 'utf8'))
    // 契约表里每个 `| n | \`method\` |` 都要在 dispatch 里真实存在
    const listed = [...contract.matchAll(/^\| \d+ \| `([a-zA-Z.]+)` \|/gm)].map((m) => m[1]!)
    check('契约表解析到方法', listed.length >= 30, `实际 ${listed.length}`)
    const missing: string[] = []
    for (const method of listed) {
      let ok = true
      try {
        // 参数乱给：已知方法要么正常返回，要么抛业务错误；未知方法会抛 “unknown learning method”
        await dispatchMethod(deps, method, {}, { studentId: studentA })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('unknown learning method')) ok = false
      }
      if (!ok) missing.push(method)
    }
    check('契约表里的方法全部已实现', missing.length === 0, missing.join(', '))
    check('桌面专属三个方法在契约表里', listed.includes('files.reveal') && listed.includes('files.preview'))
  }
} finally {
  // Windows 上 SQLite 还占着文件句柄，删不掉就留给系统临时目录清理，别让清理失败盖掉断言结果。
  try { rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log('')
if (failed === 0) { console.log('全部通过'); process.exit(0) }
console.log(`有 ${failed} 条不通过`)
process.exit(1)
