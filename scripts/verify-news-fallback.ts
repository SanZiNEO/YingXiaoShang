/**
 * 桌面交付包的新闻兜底。
 *
 * 背景：`apps/desktop/electron-builder.yml` 只打包 out/**、templates/**、种子库与提示词，
 * **不含 services/news-crawler-py 与 .venv**。所以学生机器上 Python 采集服务一定不存在，
 * 联网查新闻必须能退回 DeepSeek 搜索 API，否则学生看到的是「联网补抓失败」。
 *
 * 这里测三件事：
 *  ① 后端不可用能被识别（该退）；后端明确报错不该退（不该绕过服务）
 *  ② 正文太短的条目不入库，只作线索
 *  ③ 入库的条目字段完整（外键/去重依赖 url 与 id）
 */
import { isBackendUnavailable, toFallbackArticle, searchFallback, FALLBACK_MIN_CONTENT } from '../packages/news/src/fallback.js'

let pass = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const item = (over: Partial<Record<string, unknown>> = {}) => ({
  title: '黄仁勋辞职传闻',
  url: 'https://example.com/news/1',
  snippet: '摘要',
  summary: '摘要',
  content: '正'.repeat(500),
  siteName: '示例媒体',
  date: '2026-11-11',
  authority: 3,
  rerankScore: 0.9,
  ...over,
}) as never

console.log('1. 什么情况该退回 API（连不上/超时），什么情况不该退（服务在但报错）')
{
  check('连接被拒绝 → 退', isBackendUnavailable(new Error('connect ECONNREFUSED 127.0.0.1:8788')))
  check('DNS 失败 → 退', isBackendUnavailable(new Error('getaddrinfo ENOTFOUND 127.0.0.1')))
  check('fetch failed → 退', isBackendUnavailable(new Error('fetch failed')))
  check('超时 → 退', isBackendUnavailable(new Error('news backend timed out after 3000ms: /query')))
  check('HTTP 500 不退回（服务在，只是这台机器的问题）',
    !isBackendUnavailable(new Error('news backend HTTP 500')))
  check('后端业务错误不退回', !isBackendUnavailable(new Error('news query failed: bad param')))
}

console.log('2. 正文太短的条目不入库（宁可当线索，也不造假材料）')
{
  const short = toFallbackArticle(item({ content: '短'.repeat(FALLBACK_MIN_CONTENT - 1) }))
  check('不足门槛 → undefined', short === undefined)
  const ok = toFallbackArticle(item({ content: '正'.repeat(FALLBACK_MIN_CONTENT) }))
  check('刚好到门槛 → 入库', ok !== undefined)
  check('没有 url → 不入库', toFallbackArticle(item({ url: '' })) === undefined)
  check('没有标题也能入（用 url 兜底展示）', toFallbackArticle(item({ title: '' })) !== undefined)
}

console.log('3. 入库字段完整、id 稳定（同一 url 两次结果一致，才能 upsert 去重）')
{
  const a = toFallbackArticle(item())!
  const b = toFallbackArticle(item())!
  check('有 id', a.id.length > 0)
  check('同一 url 的 id 相同', a.id === b.id, `${a.id} vs ${b.id}`)
  check('有 url', a.url === 'https://example.com/news/1')
  check('有 published_at', a.published_at === '2026-11-11')
  check('content_status 与长度一致（500 字 → partial）', a.content_status === 'partial', a.content_status)
  const long = toFallbackArticle(item({ content: '正'.repeat(1500) }))!
  check('长文 → full', long.content_status === 'full', long.content_status)
  check('有 fetched_at', a.fetched_at.length > 0)
  check('summary 不超过 400 字', a.summary.length <= 400)
}

console.log('4. 整条兜底链路：过滤 + 错误说明')
{
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    results: [
      { title: '长文', url: 'https://example.com/a', content: '正'.repeat(800), date: '2026-11-11', site_name: '媒体A' },
      { title: '短文', url: 'https://example.com/b', content: '短'.repeat(50) },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as never
  try {
    const result = await searchFallback({ apiKey: 'test-key', query: '测试', count: 5 })
    check('只入 1 条（长文）', result.articles.length === 1, `实际 ${result.articles.length}`)
    check('短文的跳过原因写进 errors', result.errors.some((e) => /正文太短/.test(e)), result.errors.join('|'))
    check('候选仍然返回 2 条（短文可作为线索）', result.results.length === 2, `实际 ${result.results.length}`)
  } finally {
    globalThis.fetch = original
  }
}

console.log('5. 没有 key 时不乱发请求')
{
  const original = globalThis.fetch
  let called = 0
  globalThis.fetch = (async () => { called += 1; throw new Error('不该被调用') }) as never
  try {
    let message = ''
    try {
      await searchFallback({ apiKey: '', query: 'x', count: 1 })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    check('抛错说明缺密钥', /401|key|密钥/i.test(message) || called === 0)
    check('没有真的发请求', called === 0)
  } finally {
    globalThis.fetch = original
  }
}

console.log('')
if (failed === 0) { console.log('全部通过'); process.exit(0) }
console.log(`有 ${failed} 条不通过`)
process.exit(1)
