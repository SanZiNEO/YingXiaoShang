import { requireArtifact } from '../../ownership.js'
import type { MethodSpec } from '../types.js'
import { oneOf, optionalNumber, requiredString } from '../validate.js'

const FORMATS = ['md', 'docx', 'html'] as const

export const artifactMethods: MethodSpec[] = [
  {
    name: 'artifacts.list',
    resultSchema: 'ArtifactsListResult',
    validate: (params) => {
      optionalNumber(params, 'limit', { min: 1, max: 200, message: 'limit 必须是 1 到 200 的整数。' })
    },
    handler: (ctx, params) => {
      const limit = typeof params.limit === 'number' ? params.limit : 50
      return ctx.services.artifacts.list(ctx.studentId, limit)
    },
  },
  {
    name: 'artifacts.get',
    resultSchema: 'ArtifactsGetResult',
    validate: (params) => {
      requiredString(params, 'artifactId', { message: 'artifactId 不能为空。' })
    },
    handler: (ctx, params) => {
      const artifactId = String(params.artifactId)
      requireArtifact(ctx.services.db, artifactId, ctx.studentId)
      return ctx.services.artifacts.get(artifactId)
    },
  },
  {
    name: 'artifacts.export',
    resultSchema: 'ArtifactsExportResult',
    validate: (params) => {
      requiredString(params, 'artifactId', { message: 'artifactId 不能为空。' })
      if (params.format !== undefined && params.format !== null) {
        oneOf(String(params.format), FORMATS, 'format 必须是 md、docx 或 html。', 'format')
      }
    },
    handler: async (ctx, params) => {
      const artifactId = String(params.artifactId)
      requireArtifact(ctx.services.db, artifactId, ctx.studentId)
      const format =
        params.format === undefined || params.format === null
          ? 'docx'
          : oneOf(String(params.format), FORMATS, 'format 必须是 md、docx 或 html。', 'format')
      // Writing a docx cannot be interrupted mid-file, but a call whose deadline
      // already fired must not start a new write at all.
      ctx.signal.throwIfAborted()
      const out = await ctx.services.artifacts.export(artifactId, format)
      return { path: out.path }
    },
  },
]
