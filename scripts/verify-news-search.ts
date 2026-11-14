/**
 * 新闻检索的断言脚本（能变红）。
 *
 * 跑法：pnpm exec tsx scripts/verify-news-search.ts
 *
 * 对应现象：只要涉及联网查证就慢、时快时慢。
 * 根因之一：库里没有命中时会静默转去实时抓网页（60-200 秒、无超时）。
 * 现在的约定：默认只查本地库，联网要显式 online:true，并且有超时上限。
 */
import { rankNews, withTimeout } from '../packages/agent/src/tools/read-tools.js'

let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✅ ${name}`)
    return
  }
  failed += 1
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
}

const now = Date.parse('2026-11-07T00:00:00Z')
function article(title: string, daysAgo: number, summary = '', content = '') {
  return {
    title,
    summary,
    content: content.length > 0 ? content : '正'.repeat(400),
    published_at: new Date(now - daysAgo * 86_400_000).toISOString(),
  }
}

console.log('1. 关键词命中优先于新鲜度')
{
  const ranked = rankNews([
    article('今天的行业综述', 1),
    article('双十一营销观察', 40),
  ], ['双十一'], now)
  check('命中关键词的老文章排第一', ranked[0]?.article.title === '双十一营销观察', ranked.map((r) => r.article.title).join('|'))
}

console.log('2. 同分时新的在前（之前是纯关键词，最新一条可能排很后）')
{
  const ranked = rankNews([
    article('营销观察 A', 40),
    article('营销观察 B', 2),
  ], ['营销观察'], now)
  check('评分相同时按发布时间倒序', ranked[0]?.article.title === '营销观察 B', ranked.map((r) => `${r.article.title}:${r.score}`).join('|'))
}

console.log('3. 七天内的新闻有权重加成')
{
  const ranked = rankNews([
    article('关键词 旧', 20, '关键词'),
    article('关键词 新', 1, '关键词'),
  ], ['关键词'], now)
  check('新文章分数更高', (ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0), JSON.stringify(ranked.map((r) => r.score)))
}

console.log('4. 空查询也要给出东西（最新新闻）')
{
  const ranked = rankNews([article('甲', 30), article('乙', 1)], [], now)
  check('空查询不返回空列表', ranked.length === 2, String(ranked.length))
  check('空查询下新的在前', ranked[0]?.article.title === '乙')
}

console.log('5. 完全不相关就别硬凑')
{
  const ranked = rankNews([article('苹果发布新机', 1)], ['汽车销量'], now)
  check('无命中返回空', ranked.length === 0)
}

console.log('6. 联网必须有超时兜底（否则就是干等）')
{
  const slow = new Promise<string>((resolve) => setTimeout(() => resolve('迟到的结果'), 5000))
  let timedOut = false
  try {
    await withTimeout(slow, 120, '超时了')
  } catch (error) {
    timedOut = error instanceof Error && error.message === '超时了'
  }
  check('超时会抛错而不是无限等', timedOut)
  const fast = await withTimeout(Promise.resolve('及时的结果'), 2000, '超时了')
  check('正常结果不被超时误伤', fast === '及时的结果')
}

console.log('')
if (failed === 0) {
  console.log('全部通过')
  process.exit(0)
}
console.log(`有 ${failed} 条不通过`)
process.exit(1)
