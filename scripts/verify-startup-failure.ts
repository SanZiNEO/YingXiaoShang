/**
 * 启动失败分支的断言脚本（能变红）。
 * 跑法：pnpm exec tsx scripts/verify-startup-failure.ts
 *
 * 背景：initServices 抛错时窗口还没建，学生看到的是「双击没反应」。
 * 体检实测到 'file is not a database' 时就是这种表现（P0）。
 */
import { startupFailure } from '../apps/desktop/src/main/health.js'

let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  ✅ ${name}`); return }
  failed += 1
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
}

const corrupt = startupFailure(new Error('file is not a database'))
check('数据库损坏 → 可以自己重置', corrupt.canResetLocalData)
check('数据库损坏 → 标题说清是数据坏了', /本地数据损坏/.test(corrupt.title), corrupt.title)
check('数据库损坏 → 说明旧文件会保留', /备份|保留/.test(corrupt.body), corrupt.body)

const full = startupFailure(new Error('SQLITE_FULL: disk I/O error'))
check('磁盘满 → 可以重置', full.canResetLocalData)
check('磁盘满 → 提示清理磁盘', /磁盘/.test(full.title + full.body), full.title)

const perm = startupFailure(new Error('EACCES: permission denied'))
check('权限问题 → 不给重置（重置也修不了）', !perm.canResetLocalData)
check('权限问题 → 给出换目录建议', /只读|杀毒|文件夹/.test(perm.body), perm.body)

const unknown = startupFailure(new Error('something weird'))
check('未知错误 → 不给重置', !unknown.canResetLocalData)
check('未知错误 → 保留原始信息', /something weird/.test(unknown.body), unknown.body)
check('未知错误 → 让人截图找老师', /截图/.test(unknown.body), unknown.body)

console.log('')
if (failed === 0) { console.log('全部通过'); process.exit(0) }
console.log(`有 ${failed} 条不通过`); process.exit(1)
