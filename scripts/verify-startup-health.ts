/**
 * 启动自检的断言脚本（能变红）。
 * 跑法：pnpm exec tsx scripts/verify-startup-health.ts
 */
import { startupHealth } from '../apps/desktop/src/main/health.js'

let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  ✅ ${name}`); return }
  failed += 1
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
}

const normal = startupHealth({ chapters: 12, knowledgePoints: 400, newsArticles: 30 })
check('正常安装包不报错', normal.ok && normal.warnings.length === 0, JSON.stringify(normal))

const empty = startupHealth({ chapters: 0, knowledgePoints: 0, newsArticles: 0 })
check('空库会报错', !empty.ok)
check('空库提示重新解压', /重新解压/.test(empty.warnings[0] ?? ''), empty.warnings[0])

const partial = startupHealth({ chapters: 12, knowledgePoints: 0, newsArticles: 50 })
check('有章节没知识点也报错', !partial.ok, JSON.stringify(partial))

const noNews = startupHealth({ chapters: 12, knowledgePoints: 400, newsArticles: 0 })
check('没新闻不算致命，但要说明', noNews.ok && /本地新闻库/.test(noNews.notices[0] ?? ''), JSON.stringify(noNews))

console.log('')
if (failed === 0) { console.log('全部通过'); process.exit(0) }
console.log(`有 ${failed} 条不通过`); process.exit(1)
