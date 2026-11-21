import { ApiError } from '../../errors.js'
import type { MethodSpec } from '../types.js'
import {
  fail,
  optionalNumber,
  optionalString,
  requiredString,
  stringArray,
} from '../validate.js'

const NOT_FOUND_MESSAGE = '没有找到这条记录，可能已被删除。'
const UPSTREAM_MESSAGE = '上游服务没响应（新闻服务 / 模型），稍后重试。'
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2}))?$/

function notFound(): never {
  throw new ApiError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE)
}

function validateSince(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    fail('since 必须是 ISO 日期，例如 2026-11-01。', 'since')
  }
  return value
}

export const contentMethods: MethodSpec[] = [
  {
    name: 'chapters.list',
    resultSchema: 'ChaptersListResult',
    validate: () => {},
    handler: (ctx) => ctx.services.db.listChapters(),
  },
  {
    name: 'kps.list',
    resultSchema: 'KpsListResult',
    validate: (params) => {
      optionalString(params, 'chapter', { message: 'chapter 必须是字符串。' })
      optionalString(params, 'query', { max: 200, message: 'query 最多 200 个字符。' })
      optionalNumber(params, 'limit', { min: 1, max: 500, message: 'limit 必须是 1 到 500 的整数。' })
    },
    handler: (ctx, params) => {
      const chapter = typeof params.chapter === 'string' ? params.chapter : undefined
      const query = typeof params.query === 'string' ? params.query : ''
      const limit = typeof params.limit === 'number' ? params.limit : 80
      if (query) return ctx.services.db.searchKps(query, chapter, limit)
      if (chapter) return ctx.services.db.listKpsByChapter(chapter).slice(0, limit)
      return ctx.services.db.searchKps('', undefined, limit)
    },
  },
  {
    name: 'news.list',
    resultSchema: 'NewsListResult',
    validate: (params) => {
      optionalString(params, 'source', { max: 64, message: 'source 必须是字符串。' })
      validateSince(params.since)
      optionalNumber(params, 'limit', { min: 1, max: 200, message: 'limit 必须是 1 到 200 的整数。' })
    },
    handler: (ctx, params) => {
      const source = typeof params.source === 'string' ? params.source : undefined
      const since = typeof params.since === 'string' ? params.since : undefined
      const limit = typeof params.limit === 'number' ? params.limit : 20
      return ctx.services.db.listNews({ source, since, limit })
    },
  },
  {
    name: 'news.status',
    resultSchema: 'NewsStatusResult',
    validate: () => {},
    handler: (ctx) => ({
      count: ctx.services.db.countNews(),
      newestFetchedAt: ctx.services.db.newestNewsFetchedAt() ?? '',
    }),
  },
  {
    name: 'news.refresh',
    resultSchema: 'NewsRefreshResult',
    validate: (params) => {
      if (params.sources !== undefined && params.sources !== null) {
        stringArray(params.sources, {
          maxItems: 32,
          maxLength: 64,
          message: 'sources 必须是非空字符串数组。',
          field: 'sources',
        })
      }
    },
    handler: async (ctx, params) => {
      if (ctx.services.env.newsOffline) {
        throw new ApiError(502, 'UPSTREAM_FAILED', UPSTREAM_MESSAGE)
      }
      const sources = Array.isArray(params.sources) ? params.sources.map(String) : undefined
      try {
        const outcome = await ctx.services.news.refresh(sources, { wait: false, signal: ctx.signal })
        await ctx.services.matcher.backfill(20)
        return {
          results: outcome.results,
          queued: outcome.queued,
          accepted: outcome.accepted,
          count: ctx.services.db.countNews(),
          newestFetchedAt: ctx.services.db.newestNewsFetchedAt() ?? '',
        }
      } catch {
        throw new ApiError(502, 'UPSTREAM_FAILED', UPSTREAM_MESSAGE)
      }
    },
  },
  {
    name: 'news.get',
    resultSchema: 'NewsGetResult',
    validate: (params) => {
      requiredString(params, 'articleId', { message: 'articleId 不能为空。' })
    },
    handler: (ctx, params) => {
      const article = ctx.services.db.getNews(String(params.articleId))
      if (!article) notFound()
      return {
        article,
        matches: ctx.services.db.getMatches(article.id),
        ideology: ctx.services.db.getIdeologyMatches(article.id),
      }
    },
  },
  {
    name: 'news.match',
    resultSchema: 'NewsMatchResult',
    validate: (params) => {
      requiredString(params, 'articleId', { message: 'articleId 不能为空。' })
      optionalNumber(params, 'topK', { min: 1, max: 10, message: 'topK 必须是 1 到 10 的整数。' })
    },
    handler: async (ctx, params) => {
      const articleId = String(params.articleId)
      if (!ctx.services.db.getNews(articleId)) notFound()
      const topK = typeof params.topK === 'number' ? params.topK : 3
      const result = await ctx.services.matcher.match({ articleId, topK }, ctx.signal)
      return { matches: result.matches }
    },
  },
  {
    name: 'questions.attempts',
    resultSchema: 'QuestionsAttemptsResult',
    validate: (params) => {
      if (params.questionIds !== undefined && params.questionIds !== null) {
        stringArray(params.questionIds, {
          maxItems: 500,
          maxLength: 200,
          message: 'questionIds 必须是非空字符串数组。',
          field: 'questionIds',
        })
      }
      optionalNumber(params, 'limit', { min: 1, max: 1000, message: 'limit 必须是 1 到 1000 的整数。' })
    },
    handler: (ctx, params) => {
      const questionIds = Array.isArray(params.questionIds)
        ? params.questionIds.map(String)
        : undefined
      const limit = typeof params.limit === 'number' ? params.limit : 200
      return ctx.services.db.listAttempts({ studentId: ctx.studentId, questionIds, limit })
    },
  },
]
