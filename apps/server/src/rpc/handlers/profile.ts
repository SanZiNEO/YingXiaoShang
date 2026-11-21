import type { Evidence } from '@learning-agent/shared'
import { requireEvidence } from '../../ownership.js'
import type { MethodSpec } from '../types.js'
import {
  oneOf,
  optionalNumber,
  optionalString,
  requiredString,
} from '../validate.js'

const REVIEW_STATUSES = ['draft', 'reviewed', 'rejected'] as const
const CHECKPOINTS = ['pre', 'post'] as const

export const profileMethods: MethodSpec[] = [
  {
    name: 'profile.get',
    resultSchema: 'ProfileGetResult',
    validate: () => {},
    handler: (ctx) => ctx.services.profile.getProfile(ctx.studentId),
  },
  {
    name: 'profile.growth',
    resultSchema: 'ProfileGrowthResult',
    validate: (params) => {
      optionalString(params, 'chapterId', { message: 'chapterId 必须是字符串。' })
    },
    handler: (ctx, params) => {
      const chapterId = typeof params.chapterId === 'string' ? params.chapterId : undefined
      return ctx.services.profile.growthSummary(ctx.studentId, chapterId)
    },
  },
  {
    name: 'profile.evidence',
    resultSchema: 'ProfileEvidenceResult',
    validate: (params) => {
      optionalString(params, 'competencyId', { max: 64, message: 'competencyId 必须是字符串。' })
      optionalString(params, 'chapterId', { max: 64, message: 'chapterId 必须是字符串。' })
      optionalNumber(params, 'limit', { min: 1, max: 500, message: 'limit 必须是 1 到 500 的整数。' })
    },
    handler: (ctx, params) => {
      const competencyId = typeof params.competencyId === 'string' ? params.competencyId : undefined
      const chapterId = typeof params.chapterId === 'string' ? params.chapterId : undefined
      const limit = typeof params.limit === 'number' ? params.limit : 100
      return ctx.services.profile.listEvidence(ctx.studentId, { competencyId, chapterId, limit })
    },
  },
  {
    name: 'profile.snapshot',
    resultSchema: 'ProfileSnapshotResult',
    validate: (params) => {
      requiredString(params, 'chapterId', { message: 'chapterId 不能为空。' })
      const checkpoint = requiredString(params, 'checkpoint', {
        message: 'checkpoint 必须是 pre 或 post。',
      })
      oneOf(checkpoint, CHECKPOINTS, 'checkpoint 必须是 pre 或 post。', 'checkpoint')
    },
    handler: (ctx, params) => {
      const chapterId = String(params.chapterId)
      const checkpoint = oneOf(
        String(params.checkpoint),
        CHECKPOINTS,
        'checkpoint 必须是 pre 或 post。',
        'checkpoint',
      )
      return ctx.services.profile.recordSnapshot(ctx.studentId, chapterId, checkpoint)
    },
  },
  {
    name: 'profile.review',
    resultSchema: 'ProfileReviewResult',
    validate: (params) => {
      requiredString(params, 'evidenceId', { message: 'evidenceId 不能为空。' })
      const status = requiredString(params, 'status', {
        message: 'status 必须是 draft、reviewed 或 rejected。',
      })
      oneOf(status, REVIEW_STATUSES, 'status 必须是 draft、reviewed 或 rejected。', 'status')
      optionalString(params, 'note', { max: 2000, message: 'note 必须是字符串。' })
    },
    handler: (ctx, params) => {
      const evidenceId = String(params.evidenceId)
      requireEvidence(ctx.services.db, evidenceId, ctx.studentId)
      const status = oneOf(
        String(params.status),
        REVIEW_STATUSES,
        'status 必须是 draft、reviewed 或 rejected。',
        'status',
      )
      const note = typeof params.note === 'string' ? params.note : ''
      ctx.services.db.updateEvidenceReview(evidenceId, status as Evidence['review_status'], note)
      return { ok: true }
    },
  },
]
