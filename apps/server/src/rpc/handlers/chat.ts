import { optionalSession, requireSession } from '../../ownership.js'
import type { MethodSpec } from '../types.js'
import { optionalNumber, optionalString, requiredString } from '../validate.js'

export const chatMethods: MethodSpec[] = [
  {
    name: 'chat.sessions',
    resultSchema: 'ChatSessionsResult',
    validate: () => {},
    handler: (ctx) => ctx.services.db.listChatSessions(ctx.studentId),
  },
  {
    name: 'chat.messages',
    resultSchema: 'ChatMessagesResult',
    validate: (params) => {
      requiredString(params, 'sessionId', { message: 'sessionId 不能为空。' })
    },
    handler: (ctx, params) => {
      const sessionId = String(params.sessionId)
      requireSession(ctx.services.db, sessionId, ctx.studentId)
      return ctx.services.db.listChatMessages(sessionId)
    },
  },
  {
    name: 'agent.snapshot',
    resultSchema: 'AgentSnapshotResult',
    validate: (params) => {
      optionalString(params, 'sessionId', { message: 'sessionId 必须是字符串。' })
      optionalString(params, 'chapterId', { message: 'chapterId 必须是字符串。' })
    },
    handler: (ctx, params) => {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
      const chapterId = typeof params.chapterId === 'string' ? params.chapterId : undefined
      optionalSession(ctx.services.db, sessionId, ctx.studentId)
      return ctx.services.agent.getSnapshot(ctx.studentId, sessionId, chapterId)
    },
  },
  {
    name: 'agent.suggestions',
    resultSchema: 'AgentSuggestionsResult',
    validate: (params) => {
      optionalString(params, 'sessionId', { message: 'sessionId 必须是字符串。' })
    },
    handler: (ctx, params) => {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
      optionalSession(ctx.services.db, sessionId, ctx.studentId)
      return ctx.services.agent.suggestions(ctx.studentId, sessionId)
    },
  },
  {
    name: 'agent.turns',
    resultSchema: 'AgentTurnsResult',
    validate: (params) => {
      requiredString(params, 'sessionId', { message: 'sessionId 不能为空。' })
      optionalNumber(params, 'limit', { min: 1, max: 500, message: 'limit 必须是 1 到 500 的整数。' })
    },
    handler: (ctx, params) => {
      const sessionId = String(params.sessionId)
      requireSession(ctx.services.db, sessionId, ctx.studentId)
      const limit = typeof params.limit === 'number' ? params.limit : 50
      return ctx.services.agent.listTurns(sessionId, limit)
    },
  },
  {
    name: 'agent.ledger',
    resultSchema: 'AgentLedgerResult',
    validate: () => {},
    handler: (ctx) => ctx.services.agent.listLedger(ctx.studentId),
  },
  {
    name: 'agent.retry',
    resultSchema: 'AgentRetryResult',
    validate: (params) => {
      requiredString(params, 'sourceId', { message: 'sourceId 不能为空。' })
    },
    handler: async (ctx, params) => {
      const sourceId = String(params.sourceId)
      await ctx.services.agent.retryLedger(ctx.studentId, sourceId)
      return ctx.services.agent.listLedger(ctx.studentId)
    },
  },
  {
    name: 'agent.sessions',
    resultSchema: 'AgentSessionsResult',
    validate: () => {},
    handler: (ctx) => ctx.services.agent.sessionSummaries(ctx.studentId),
  },
]
