// B12：联网查新闻到底要多久（对比 爬网页 / 不爬网页）
import { Context } from '@deepseek-ai/cordis'
import { DeepSeekLlm } from '../../apps/desktop/src/main/llm.ts'

const APP_HOME = process.env.LA_PROBE_HOME ?? ''
if (!APP_HOME) throw new Error('需要 LA_PROBE_HOME')
const settings = { apiKey: process.env.DEEPSEEK_API_KEY ?? '', model: 'deepseek-chat' }
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
const news = new (await load('news', 'NewsService'))(ctx, { apiKey: () => settings.apiKey })

const query = process.env.LA_QUERY ?? '黄仁勋辞职'

// 1) 只搜不入库（网络搜索本身）
let t0 = Date.now()
const found = await news.webSearch(query, 5)
console.log(`① 搜索 API：${((Date.now() - t0) / 1000).toFixed(1)}s，${found.length} 条，首条：${found[0]?.title?.slice(0, 30)}（${found[0]?.date?.slice(0, 10)}）`)

// 2) 搜索 + 入库，不爬网页（工具现在走这条）
t0 = Date.now()
const light = await news.searchAndIngest(query, 5, { crawl: false })
const lightMs = Date.now() - t0
console.log(`② 搜索+入库（不爬网页）：${(lightMs / 1000).toFixed(1)}s，入库 ${light.articles.length} 条，跳过 ${light.errors.length} 条`)

// 3) 搜索 + 爬网页（旧行为，可能会很慢）
if (process.env.LA_CRAWL === '1') {
  t0 = Date.now()
  const heavy = await news.searchAndIngest(query, 5)
  console.log(`③ 搜索+入库（爬网页）：${((Date.now() - t0) / 1000).toFixed(1)}s，入库 ${heavy.articles.length} 条`)
}
console.log(`\n结论：${lightMs < 8000 ? '✅ 问答路径可在 8 秒内完成' : '❌ 仍然偏慢'}`)
process.exit(0)
