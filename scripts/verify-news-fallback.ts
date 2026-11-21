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
import { Context } from '@deepseek-ai/cordis'
import { NewsService } from '../packages/news/src/index.js'
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

console.log('6. 接线：后端拒绝时，NewsService 真的走兜底并入库（不是只测纯函数）')
{
  // 复核抓到的坑：上一版只 import fallback.ts 的纯函数，把 searchAndIngest 里的
  // catch 整条删掉，脚本照样全绿。这里构造真实的 NewsService，按 URL 分流：
  // 8788 拒绝、api.deepseek.com 正常，才能证明「包里联网查新闻真的能退回去」。
  const upserts: Array<{ url?: string; id?: string }> = []
  const ctx = new Context()
  ctx.provide('learningDb', {
    upsertNews: (articles: Array<{ url?: string; id?: string }>) => { upserts.push(...articles); return articles.length },
    // 兜底入库后会按 url 回查真实 id（撞 url 时 upsertNews 不更新 id）。
    listNews: () => upserts,
  })
  const service = new NewsService(ctx as never, {
    baseUrl: 'http://127.0.0.1:8788',
    apiKey: () => 'test-key',
    queryTimeoutMs: 300,
  })

  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url.includes('127.0.0.1:8788')) {
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED 127.0.0.1:8788') })
    }
    return new Response(JSON.stringify({
      results: [
        { title: '兜底长文', url: 'https://example.com/f1', content: '正'.repeat(600), date: '2026-11-11', site_name: '媒体' },
        { title: '兜底短文', url: 'https://example.com/f2', content: '短'.repeat(20) },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as never

  try {
    let thrown = ''
    let result: { articles: unknown[]; errors: string[] } | undefined
    try {
      result = await service.searchAndIngest('黄仁勋辞职', 5)
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error)
    }
    check('后端拒绝时不抛错（真的退回去了）', thrown.length === 0, thrown)
    check('兜底拿到了条目', (result?.articles.length ?? 0) === 1, `实际 ${result?.articles.length}`)
    check('兜底结果写进了库（upsertNews 被调用）', upserts.length === 1, `实际 ${upserts.length}`)
    check('入库的是长文那条', upserts[0]?.url === 'https://example.com/f1', String(upserts[0]?.url))

    // 反例：后端 500 说明服务在，不该绕过它去花 API 的钱。
    upserts.length = 0
    globalThis.fetch = (async (input: unknown) => {
      if (String(input).includes('127.0.0.1:8788')) {
        return new Response(JSON.stringify({ ok: false, message: 'boom' }), { status: 500 })
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as never
    let message = ''
    try {
      await service.searchAndIngest('x', 1)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    check('后端 500 时抛错、不偷偷走兜底', /boom|500/.test(message), message)
    check('后端 500 时没有入库', upserts.length === 0, `实际 ${upserts.length}`)
  } finally {
    globalThis.fetch = original
  }
}

console.log('7. 开关：服务端部署（显式配了外部 URL）不许偷偷改道')
{
  const ctx = new Context()
  const upserts: unknown[] = []
  ctx.provide('learningDb', { upsertNews: (a: unknown[]) => { upserts.push(...a); return a.length } })
  const service = new NewsService(ctx as never, {
    baseUrl: 'http://127.0.0.1:8788',
    apiKey: () => 'test-key',
    queryTimeoutMs: 300,
    allowFallback: false,
  })
  const original = globalThis.fetch
  let searched = 0
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes('127.0.0.1:8788')) {
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED') })
    }
    searched += 1
    return new Response(JSON.stringify({ results: [] }), { status: 200 })
  }) as never
  try {
    let message = ''
    try { await service.searchAndIngest('x', 1) } catch (error) { message = error instanceof Error ? error.message : String(error) }
    check('allowFallback=false 时直接抛错', message.length > 0, message)
    check('没有偷偷去调搜索 API', searched === 0, `实际调用 ${searched} 次`)
    check('没有入库', upserts.length === 0)
  } finally { globalThis.fetch = original }
}

console.log('8. 撞 url：返回的 id 必须是库里真实 id（否则 get_news 查不到）')
{
  const ctx = new Context()
  const rows: Array<{ url: string; id: string }> = [{ url: 'https://example.com/dup', id: 'socialbeta-article-999' }]
  ctx.provide('learningDb', {
    upsertNews: (articles: Array<{ url: string }>) => {
      for (const a of articles) {
        // 模拟 ON CONFLICT(url) DO UPDATE：url 已存在时 id 不变
        if (!rows.some((r) => r.url === a.url)) rows.push({ url: a.url, id: 'web_new' })
      }
      return articles.length
    },
    listNews: () => rows.map((r) => ({ ...r })),
  })
  const service = new NewsService(ctx as never, { baseUrl: 'http://127.0.0.1:8788', apiKey: () => 'k', queryTimeoutMs: 300 })
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes('127.0.0.1:8788')) {
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED') })
    }
    return new Response(JSON.stringify({
      results: [{ title: '重复', url: 'https://example.com/dup', content: '正'.repeat(600) }],
    }), { status: 200 })
  }) as never
  try {
    const result = await service.searchAndIngest('x', 1)
    check('返回的是库里已有的 id', result.articles[0]?.id === 'socialbeta-article-999', `实际 ${result.articles[0]?.id}`)
  } finally { globalThis.fetch = original }
}

console.log('9. 刷新按钮在桌面包里不能报错（采集服务本来就不在包里）')
{
  const ctx = new Context()
  ctx.provide('learningDb', { upsertNews: () => 0, listNews: () => [] })
  const service = new NewsService(ctx as never, {
    baseUrl: 'http://127.0.0.1:8788',
    apiKey: () => 'test-key',
    queryTimeoutMs: 300,
  })
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED 127.0.0.1:8788') })
  }) as never
  try {
    let thrown = ''
    let outcome: any
    try {
      outcome = await service.refresh(undefined, { wait: false })
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error)
    }
    check('不抛错（否则界面每次点刷新都报错）', thrown.length === 0, thrown)
    check('标记为降级', outcome?.degraded === true, JSON.stringify(outcome))
    check('没有假装排上队', outcome?.queued === false, JSON.stringify(outcome))

    // 服务端部署（allowFallback=false）必须仍然报错：那是真故障，不能吞。
    // 同一个 Context 只能 provide 一个 'news'，所以这里单独建一个。
    const strictCtx = new Context()
    strictCtx.provide('learningDb', { upsertNews: () => 0, listNews: () => [] })
    const strict = new NewsService(strictCtx as never, {
      baseUrl: 'http://127.0.0.1:8788',
      apiKey: () => 'k',
      refreshTimeoutMs: 300,
      allowFallback: false,
    })
    let strictMessage = ''
    try { await strict.refresh(undefined, { wait: false }) } catch (error) { strictMessage = error instanceof Error ? error.message : String(error) }
    check('服务端部署仍然抛错（不吞故障）', strictMessage.length > 0, strictMessage)
  } finally { globalThis.fetch = original }
}

console.log('')
if (failed === 0) { console.log('全部通过'); process.exit(0) }
console.log(`有 ${failed} 条不通过`)
process.exit(1)
