import { requireMemoryFact } from '../../ownership.js'
import type { MethodSpec } from '../types.js'
import { fail, optionalNumber, requiredString } from '../validate.js'

const KIND_ALLOWED = ['goal', 'preference', 'constraint', 'background', 'self_assessment', 'open_question'] as const
type MemoryKind = (typeof KIND_ALLOWED)[number]
const MAX_VALUE_BYTES = 64 * 1024

function normalizeKind(value: unknown): MemoryKind {
  return typeof value === 'string' && (KIND_ALLOWED as readonly string[]).includes(value)
    ? (value as MemoryKind)
    : 'goal'
}

export const memoryMethods: MethodSpec[] = [
  {
    name: 'memory.facts',
    resultSchema: 'MemoryFactsResult',
    validate: () => {},
    handler: (ctx) => ctx.services.db.listMemoryFacts(ctx.studentId),
  },
  {
    name: 'memory.episodes',
    resultSchema: 'MemoryEpisodesResult',
    validate: (params) => {
      optionalNumber(params, 'limit', { min: 1, max: 200, message: 'limit 必须是 1 到 200 的整数。' })
    },
    handler: (ctx, params) => {
      const limit = typeof params.limit === 'number' ? params.limit : 50
      return ctx.services.db.listMemoryEpisodes(ctx.studentId, limit)
    },
  },
  {
    name: 'memory.summary',
    resultSchema: 'MemorySummaryResult',
    validate: () => {},
    handler: (ctx) => ctx.services.profile.memorySummary(ctx.studentId),
  },
  {
    name: 'memory.upsert',
    resultSchema: 'MemoryUpsertResult',
    validate: (params) => {
      requiredString(params, 'key', { max: 120, message: 'key 不能为空。' })
      const value = params.value
      if (value === null || value === undefined) fail('value 不能为空。', 'value')
      const serialized = JSON.stringify(value)
      if (Buffer.byteLength(serialized, 'utf8') > MAX_VALUE_BYTES) {
        fail('value 太大了（上限 64 KB）。', 'value')
      }
    },
    handler: (ctx, params) => {
      const key = String(params.key)
      const value = params.value
      const kind = normalizeKind(params.kind)
      return ctx.services.profile.upsertMemoryFact({ studentId: ctx.studentId, kind, key, value })
    },
  },
  {
    name: 'memory.delete',
    resultSchema: 'MemoryDeleteResult',
    validate: (params) => {
      requiredString(params, 'factId', { message: 'factId 不能为空。' })
    },
    handler: (ctx, params) => {
      const factId = String(params.factId)
      requireMemoryFact(ctx.services.db, factId, ctx.studentId)
      ctx.services.profile.deleteMemoryFact(factId)
      return { ok: true }
    },
  },
]
