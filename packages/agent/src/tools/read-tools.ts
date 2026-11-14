import { REFERENCE_NAMES, loadReference } from '../prompts.js'
import {
  chapterTitle,
  findKp,
  keywordTerms,
  kpLine,
  matchesTerms,
  sectionTitle,
} from './material.js'
import type { ToolSpec } from './types.js'

const MAX_BODY = 4_000

/**
 * 取材料的工具。它们只把教材、知识点、新闻库摊开，不判断什么跟当前任务相关。
 * 工具对外说人话（「给我这一章的材料」），内部怎么查表是工具自己的事。
 */
const ONLINE_NEWS_TIMEOUT_MS = 45_000

/**
 * 新闻检索排序：关键词命中 > 新鲜度 > 发布时间。
 * 之前是「拉 500 条关键词过滤」，同一关键词下最新的一条可能排在很后面，
 * 模型因此常常判断成"库里没有"，转头去联网。
 */
export function rankNews<T extends { title: string; summary: string; content: string; published_at: string }>(
  articles: T[],
  terms: string[],
  now = Date.now(),
): Array<{ article: T; score: number }> {
  const days = (iso: string): number => {
    const at = Date.parse(iso)
    if (!Number.isFinite(at)) return 999
    return Math.max(0, (now - at) / 86_400_000)
  }
  return articles
    .map((article) => {
      let score = 0
      for (const term of terms) {
        if (article.title.includes(term)) score += 6
        if (article.summary.includes(term)) score += 3
        if (article.content.includes(term)) score += 1
      }
      // 有查询词时，只有真的命中才谈新鲜度；否则「今天发的无关新闻」
      // 会靠时间加分混进结果（这就是测试 5 抓到的那个错）。
      if (terms.length === 0) {
        score += 1
        const age = days(article.published_at)
        if (age <= 7) score += 3
        else if (age <= 30) score += 1
        return { article, score }
      }
      if (score === 0) return { article, score: 0 }
      const age = days(article.published_at)
      if (age <= 7) score += 3
      else if (age <= 30) score += 1
      return { article, score }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return right.article.published_at.localeCompare(left.article.published_at)
    })
}

export function withTimeout<T>(task: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    task.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

export const READ_TOOLS: ToolSpec[] = [
  {
    name: 'list_chapter_kps',
    kind: 'read',
    description: '列出当前章节的全部知识点（中文名 + 所属小节 + 教材定义）。需要知道这一章有哪些概念时先调它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chapterId: { type: 'string', description: '章节 id，如 ch04；省略则用当前章节' },
      },
    },
    execute(args, turn) {
      const id = typeof args.chapterId === 'string' && args.chapterId.length > 0 ? args.chapterId : turn.chapterId
      const points = turn.ctx.learningDb.listKpsByChapter(id)
      if (points.length === 0) return `章节 ${id} 没有知识点记录。`
      const head = `# ${chapterTitle(turn.ctx, id)}（${id}）共 ${points.length} 个知识点`
      return [head, ...points.map((point) => kpLine(turn.ctx, point))].join('\n')
    },
  },
  {
    name: 'read_kp',
    kind: 'read',
    description: '读知识点的完整定义：别名、关键词、教材例子、非例子、所属章节与小节。需要几个概念就一次给几个（names），不要一个概念调一次。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '知识点中文名或 id（只读一个时用）' },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: '知识点中文名或 id 的列表。要同时看几个概念时，把它们一次放进 names',
        },
      },
    },
    execute(args, turn) {
      const batch = Array.isArray(args.names)
        ? (args.names as unknown[]).filter((item): item is string => typeof item === 'string')
        : typeof args.names === 'string' && (args.names as string).trim().length > 0
          // 模型常把 names 写成字符串，按单个处理，不要报「缺少参数」。
          ? [args.names as string]
          : []
      const queries = batch.length > 0
        ? batch
        : [typeof args.name === 'string' ? (args.name as string) : '']
      const filled = queries.map((item) => item.trim()).filter((item) => item.length > 0)
      if (filled.length === 0) return '缺少参数 name 或 names。'

      const readOne = (query: string): string => {
        const point = findKp(turn.ctx, turn.chapterId, query)
        if (!point) return `当前章节里没有找到知识点「${query}」。可先调用 list_chapter_kps。`
        if (!turn.firstTime(`kp:${point.name}`)) {
          return `「${point.name}」这个知识点的定义、别名、例子你在本轮已经读过一次，内容完全相同，不再重复返回。直接用手上已有的材料写结论。`
        }
        turn.cite({ sourceType: 'kp', sourceId: point.id, quote: point.definition, locator: { name: point.name, chapterId: point.chapter_id } })
        turn.reads.kps.add(point.name)
        return [
          `# ${point.name}`,
          `章节：${chapterTitle(turn.ctx, point.chapter_id)}（${point.chapter_id}）`,
          `小节：${sectionTitle(turn.ctx, point.chapter_id, point.section_id)}`,
          `定义：${point.definition}`,
          point.aliases.length > 0 ? `别名：${point.aliases.join('、')}` : '',
          point.keywords.length > 0 ? `关键词：${point.keywords.join('、')}` : '',
          point.examples.length > 0 ? `教材例子：${point.examples.join('；')}` : '',
          point.non_examples.length > 0 ? `非例子：${point.non_examples.join('；')}` : '',
          `难度：${point.difficulty}`,
        ].filter((line) => line.length > 0).join('\n')
      }

      return filled.map(readOne).join('\n\n---\n\n')
    },
  },
  {
    name: 'read_textbook',
    kind: 'read',
    description: '读教材原文。给 kps（可一次给多个知识点）取它们对应的原文段落，或给 query 按关键词检索本章教材。返回逐字原文与出处。要同时看几个概念的原文时，把它们一起放进 kps，不要一个概念调一次。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kps: {
          type: 'array',
          items: { type: 'string' },
          description: '知识点中文名，可一次给多个（最多 4 个）',
        },
        kp: { type: 'string', description: '单个知识点中文名（等价于只放一个的 kps）' },
        query: { type: 'string', description: '关键词，按原文检索' },
        limit: { type: 'integer', description: '每个知识点最多返回几段，默认 3' },
      },
    },
    execute(args, turn) {
      const limit = Math.min(Math.max(Number(args.limit ?? 3), 1), 6)
      const listed = Array.isArray(args.kps)
        ? args.kps.filter((item): item is string => typeof item === 'string')
        : []
      const single = typeof args.kp === 'string' ? args.kp : ''
      const wanted = [...new Set([...listed, single].map((item) => item.trim()).filter((item) => item.length > 0))].slice(0, 4)
      const keyword = typeof args.query === 'string' ? args.query.trim() : ''
      const blocks = turn.chapterBlocks()
      const byId = new Map(blocks.map((block) => [block.id, block]))
      const { ctx, chapterId } = turn

      const picked: Array<{ text: string; sourceTitle: string; sourceId: string }> = []
      /** 教材里确实没有原文段落的知识点：要明确告诉模型"别找了"。 */
      const noSource: string[] = []
      for (const name of wanted) {
        const point = findKp(ctx, chapterId, name)
        if (!point) continue
        let taken = 0
        const tags = ctx.learningDb.listContentTags({ chapterId, limit: 100000 })
          .filter((tag) => tag.tag_key === point.id || tag.tag_key === point.name)
        for (const tag of tags) {
          if (taken >= limit) break
          const block = byId.get(tag.block_id)
          if (!block || picked.some((item) => item.sourceId === block.id)) continue
          taken += 1
          picked.push({
            text: block.text,
            sourceId: block.id,
            sourceTitle: `教材 · ${point.name} · ${sectionTitle(ctx, chapterId, block.section_id)}`,
          })
        }
        if (taken === 0) {
          // 没有标签就用知识点名去正文里找一次，很多段落正文里写的就是这个概念。
          for (const block of blocks) {
            if (picked.some((item) => item.sourceId === block.id)) continue
            if (!block.text.includes(point.name)) continue
            taken += 1
            picked.push({
              text: block.text,
              sourceId: block.id,
              sourceTitle: `教材 · ${point.name}（按名称匹配）· ${sectionTitle(ctx, chapterId, block.section_id)}`,
            })
            break
          }
        }
        if (taken === 0) noSource.push(point.name)
      }
      if (picked.length === 0 && keyword.length > 0) {
        const terms = keywordTerms(keyword)
        for (const block of blocks) {
          if (!matchesTerms(block.text, terms)) continue
          picked.push({
            text: block.text,
            sourceId: block.id,
            sourceTitle: `教材 · ${chapterTitle(ctx, chapterId)} · ${sectionTitle(ctx, chapterId, block.section_id)}`,
          })
          if (picked.length >= limit) break
        }
      }
      const note = noSource.length > 0
        ? `教材里没有「${noSource.join('、')}」的原文段落，只有定义——这几个点不要再检索了，引用定义即可。`
        : ''
      if (picked.length === 0) {
        if (note.length > 0) return note
        return `本章教材里没有找到${wanted.length > 0 ? `「${wanted.join('、')}」` : ''}${keyword ? `含「${keyword}」的` : ''}段落。可换关键词，或先调用 list_chapter_kps。`
      }
      const fresh = picked.filter((item) => turn.firstTime(`block:${item.sourceId}`))
      if (fresh.length === 0) {
        // 章节级判断：整章原文都已经交付过了，就明说"没有更多可读"。
        // 只说"这段读过了"不够——模型会换一段继续读，永远有下一段。
        if (blocks.length > 0 && blocks.every((block) => turn.seen(`block:${block.id}`))) {
          return `本章教材原文（共 ${blocks.length} 段）你已经全部读过了，没有任何新段落可读。停止检索，直接用已有的定义和原文写结论。`
        }
        return `这几段教材原文你在本轮已经读过，内容一字不差，不再重复返回。上面那次工具结果就在对话里，直接引用它，不要重读。`
      }
      picked.length = 0
      picked.push(...fresh)
      for (const name of wanted) turn.reads.kps.add(name)
      if (keyword.length > 0) turn.reads.queries.add(keyword)
      for (const item of picked) {
        turn.reads.blocks.add(item.sourceId)
        turn.cite({
          sourceType: 'textbook',
          sourceId: item.sourceId,
          quote: item.text.slice(0, 240),
          locator: { sourceTitle: item.sourceTitle, chapterId },
        })
      }
      return picked
        .map((item, index) => `【${index + 1}】${item.sourceTitle}\n${item.text}`)
        .concat(note.length > 0 ? [note] : [])
        .join('\n\n')
    },
  },
  {
    name: 'read_material',
    kind: 'read',
    description: '一次取齐材料：给 1–4 个知识点名，直接返回它们的定义、别名、教材例子和对应教材原文段落；也可附一个关键词检索本章原文。要讲清一个概念时，优先用这一次调用代替「read_kp + read_textbook」两次往返。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kps: {
          type: 'array',
          items: { type: 'string' },
          description: '知识点中文名或 id，1–4 个',
        },
        query: { type: 'string', description: '可选关键词，按原文检索本章教材' },
        limit: { type: 'integer', description: '每个知识点最多取几段原文，默认 2' },
      },
      required: ['kps'],
    },
    execute(args, turn) {
      const { ctx, chapterId } = turn
      const requested = Array.isArray(args.kps)
        ? args.kps.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter((item) => item.length > 0)
        : []
      const keyword = typeof args.query === 'string' ? args.query.trim() : ''
      if (requested.length === 0 && keyword.length === 0) return '缺少参数 kps（知识点名），或给一个 query 关键词。'
      const perKp = Math.min(Math.max(Number(args.limit ?? 2), 1), 4)
      const blocks = turn.chapterBlocks()
      const byId = new Map(blocks.map((block) => [block.id, block]))
      const tags = ctx.learningDb.listContentTags({ chapterId, limit: 100000 })
      const seenBlocks = new Set<string>()
      const sections: string[] = []
      const missing: string[] = []
      const repeated: string[] = []

      for (const name of requested.slice(0, 4)) {
        const point = findKp(ctx, chapterId, name)
        if (!point) { missing.push(name); continue }
        if (!turn.firstTime(`kp:${point.name}`)) { repeated.push(point.name); continue }
        turn.reads.kps.add(point.name)
        turn.cite({ sourceType: 'kp', sourceId: point.id, quote: point.definition, locator: { name: point.name, chapterId: point.chapter_id } })
        const lines = [
          `## ${point.name}`,
          `小节：${sectionTitle(ctx, point.chapter_id, point.section_id)}`,
          `定义：${point.definition}`,
          point.aliases.length > 0 ? `别名：${point.aliases.join('、')}` : '',
          point.examples.length > 0 ? `教材例子：${point.examples.join('；')}` : '',
          point.non_examples.length > 0 ? `非例子：${point.non_examples.join('；')}` : '',
        ].filter((line) => line.length > 0)
        let taken = 0
        for (const tag of tags.filter((item) => item.tag_key === point.id || item.tag_key === point.name)) {
          if (taken >= perKp) break
          const block = byId.get(tag.block_id)
          if (!block || seenBlocks.has(block.id)) continue
          seenBlocks.add(block.id)
          taken += 1
          turn.reads.blocks.add(block.id)
          turn.cite({
            sourceType: 'textbook',
            sourceId: block.id,
            quote: block.text.slice(0, 240),
            locator: {
              sourceTitle: `教材 · ${chapterTitle(ctx, chapterId)} · ${sectionTitle(ctx, chapterId, block.section_id)}`,
              chapterId,
            },
          })
          lines.push(`原文（${sectionTitle(ctx, chapterId, block.section_id)}）：${block.text}`)
        }
        if (taken === 0) lines.push('原文：教材里没有这个知识点的原文段落（只有定义），不用再检索。')
        sections.push(lines.join('\n'))
      }

      if (keyword.length > 0) {
        turn.reads.queries.add(keyword)
        const terms = keywordTerms(keyword)
        const hits: string[] = []
        for (const block of blocks) {
          if (hits.length >= perKp || seenBlocks.has(block.id)) continue
          if (!matchesTerms(block.text, terms)) continue
          seenBlocks.add(block.id)
          turn.reads.blocks.add(block.id)
          turn.cite({
            sourceType: 'textbook',
            sourceId: block.id,
            quote: block.text.slice(0, 240),
            locator: {
              sourceTitle: `教材 · ${chapterTitle(ctx, chapterId)} · ${sectionTitle(ctx, chapterId, block.section_id)}`,
              chapterId,
            },
          })
          hits.push(`原文（${sectionTitle(ctx, chapterId, block.section_id)}）：${block.text}`)
        }
        sections.push([`## 关键词「${keyword}」的原文`, ...(hits.length > 0 ? hits : ['本章没有含该关键词的段落。'])].join('\n'))
      }

      if (missing.length > 0) sections.unshift(`没找到的知识点：${missing.join('、')}（可先调用 list_chapter_kps 看准确名称）`)
      if (repeated.length > 0) sections.unshift(`这些知识点你在本轮已经读过，内容完全相同，不再重复返回：${repeated.join('、')}`)
      if (sections.length === 0) {
        if (blocks.length > 0 && blocks.every((block) => turn.seen(`block:${block.id}`))) {
          return `本章教材原文（共 ${blocks.length} 段）你已经全部读过了，没有任何新内容可读。停止检索，直接用已有的定义和原文写结论。`
        }
        return '这一批内容和本轮已经读过的一模一样，没有新信息。直接用手上的材料写结论。'
      }
      return sections.join('\n\n').slice(0, 12_000)
    },
  },
  {
    name: 'read_reference',
    kind: 'read',
    description: `读手册：${REFERENCE_NAMES.join(' / ')}。teaching-playbook 讲教学与对话策略；case-playbook 讲怎么精讲案例与新闻；question-playbook 讲怎么出题与批改；research-bp-playbook 讲调研与 BP；competency-rubric 讲四维能力与证据分级；counterexample-playbook 讲怎么找反例与失败模式；artifact-schemas 讲产物结构。动笔做专业内容前先查对应那份。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', enum: [...REFERENCE_NAMES], description: '要读哪一份' },
      },
      required: ['name'],
    },
    execute(args, turn) {
      const name = typeof args.name === 'string' ? args.name : ''
      if (!REFERENCE_NAMES.includes(name as typeof REFERENCE_NAMES[number])) {
        return `没有这份资料：${name || '(空)'}。可选：${REFERENCE_NAMES.join(' / ')}`
      }
      if (!turn.firstTime(`ref:${name}`)) {
        return `《${name}》你在本轮已经读过，内容完全相同，不再重复返回。直接按它的要求做。`
      }
      turn.reads.references.add(name)
      return loadReference(name)
    },
  },
  {
    name: 'search_news',
    kind: 'read',
    description: [
      '在本地新闻库里检索，返回候选（标题、来源、时间、摘要）。选哪条由你判断。',
      '默认只查本地库，很快；库里没有就如实说没有，不要自己编。',
      '只有学生明确要「最新 / 今天 / 最近 / 联网查」时，才把 online 设 true：',
      '那会实时联网补抓，通常 30 秒以上，还可能失败。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词，可留空表示最新新闻' },
        limit: { type: 'integer', description: '最多返回几条，默认 8' },
        online: {
          type: 'boolean',
          description: '是否允许联网补抓（默认 false；只有学生明确要求最新/联机时才用）',
        },
      },
    },
    async execute(args, turn) {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const limit = Math.min(Math.max(Number(args.limit ?? 8), 1), 20)
      const online = args.online === true
      const terms = query.split(/[\s,，、]+/).filter((term) => term.length >= 2)

      const search = () =>
        rankNews(turn.ctx.learningDb.listNews({ limit: 500 }).filter((article) => article.content.length >= 300), terms)

      let scored = search()
      let onlineNote = ''
      if (scored.length === 0 && online) {
        // 联网只在显式要求时发生，并且有上限：宁可说「没查到」，也不让学生等两分钟。
        const started = Date.now()
        try {
          const result = await withTimeout(
            turn.ctx.news.searchAndIngest(query, 3),
            ONLINE_NEWS_TIMEOUT_MS,
            `联网检索超过 ${Math.round(ONLINE_NEWS_TIMEOUT_MS / 1000)} 秒，已放弃（没有把这次等待算成答案）。`,
          )
          const failed = result.errors.slice(0, 2)
          onlineNote = failed.length > 0
            ? `联网补抓部分失败：${failed.join('；')}`
            : `联网补抓到 ${result.articles.length} 条（用时 ${((Date.now() - started) / 1000).toFixed(0)} 秒）。`
          scored = search()
        } catch (error) {
          onlineNote = error instanceof Error ? error.message : String(error)
        }
      }

      if (scored.length === 0) {
        if (query.length === 0) return '新闻库里还没有入库文章。'
        return online
          ? `联网也没查到与「${query}」相关的可用文章${onlineNote ? `（${onlineNote}）` : ''}。不要编造新闻。`
          : `本地新闻库里没有与「${query}」相关的文章（这里只查本地库）。`
            + `如果学生确实需要最新资讯，可以再调一次 search_news 并把 online 设为 true（会联网，约 30 秒以上）。`
      }
      if (query.length > 0) turn.reads.queries.add(query)
      const body = scored
        .slice(0, limit)
        .map((item, index) => [
          `【${index + 1}】${item.article.title}`,
          `id：${item.article.id}｜${item.article.source}｜${item.article.published_at.slice(0, 10)}`,
          item.article.summary.slice(0, 160),
        ].join('\n'))
        .join('\n\n')
      return onlineNote.length > 0 ? `${onlineNote}\n\n${body}` : body
    },
  },
  {
    name: 'read_news',
    kind: 'read',
    description: '读一条新闻的正文原文，用 id 或标题定位。引用时必须逐字来自这里。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '新闻 id，来自 search_news' },
        title: { type: 'string', description: '新闻标题片段' },
      },
    },
    execute(args, turn) {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      const article = id.length > 0
        ? turn.ctx.learningDb.getNews(id)
        : turn.ctx.learningDb.listNews({ limit: 500 }).find((item) => item.title.includes(title))
      if (!article) return `没有找到这条新闻（id=${id || '空'}，title=${title || '空'}）。`
      if (!turn.firstTime(`news:${article.id}`)) {
        return `《${article.title}》的正文你在本轮已经读过，内容完全相同，不再重复返回。`
      }
      turn.reads.news.add(article.id)
      turn.cite({
        sourceType: 'news',
        sourceId: article.id,
        quote: article.content.slice(0, 240),
        locator: { title: article.title, source: article.source, publishedAt: article.published_at, url: article.url },
      })
      return [
        `# ${article.title}`,
        `来源：${article.source}｜${article.published_at.slice(0, 10)}`,
        article.url ? `链接：${article.url}` : '',
        '',
        article.content.slice(0, MAX_BODY),
      ].filter((line) => line.length > 0).join('\n')
    },
  },
]
