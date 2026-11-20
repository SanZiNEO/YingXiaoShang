import { ApiError } from '../../errors.js'
import type { MethodSpec } from '../types.js'
import { fail, requiredString } from '../validate.js'

const NOT_FOUND_MESSAGE = '没有找到这条记录，可能已被删除。'

function notFound(): never {
  throw new ApiError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE)
}

/** `student.current` plus the four Electron-era read-only compatibility methods. */
export const studentMethods: MethodSpec[] = [
  {
    name: 'student.current',
    resultSchema: 'StudentCurrentResult',
    validate: () => {},
    handler: (ctx) => {
      const profile = ctx.services.db.getStudentProfile(ctx.studentId)
      return {
        studentId: ctx.studentId,
        name: profile?.name ?? '学生',
        cohort: profile?.cohort ?? '',
      }
    },
  },
]

export const legacyMethods: MethodSpec[] = [
  {
    name: 'getKp',
    legacy: true,
    resultSchema: 'GetKpResult',
    validate: (params) => {
      requiredString(params, 'kpId', { message: 'kpId 不能为空。' })
    },
    handler: (ctx, params) => {
      const kp = ctx.services.db.getKp(String(params.kpId))
      if (!kp) notFound()
      return kp
    },
  },
  {
    name: 'getBlock',
    legacy: true,
    resultSchema: 'GetBlockResult',
    validate: (params) => {
      requiredString(params, 'blockId', { message: 'blockId 不能为空。' })
    },
    handler: (ctx, params) => {
      const block = ctx.services.db.getBlock(String(params.blockId))
      if (!block) notFound()
      return {
        block,
        chapter: ctx.services.db.listChapters().find((item) => item.id === block.chapter_id),
        section: ctx.services.db
          .listSections(block.chapter_id)
          .find((item) => item.id === block.section_id),
      }
    },
  },
  {
    name: 'getResource',
    legacy: true,
    resultSchema: 'GetResourceResult',
    validate: (params) => {
      const resourceId =
        typeof params.resourceId === 'string'
          ? params.resourceId
          : typeof params.sourceId === 'string'
            ? params.sourceId
            : ''
      if (resourceId.trim().length === 0) fail('resourceId 不能为空。', 'resourceId')
    },
    handler: (ctx, params) => {
      const resourceId = String(params.resourceId ?? params.sourceId ?? '')
      const guide = ctx.services.db.getState<unknown>('resource', `guide/${resourceId}`)
      if (!guide || typeof guide !== 'object' || Array.isArray(guide)) notFound()
      const record = guide as Record<string, unknown>
      const chapterId =
        'chapter_id' in record && typeof record.chapter_id === 'string' ? record.chapter_id : resourceId
      return {
        guide,
        chapter: ctx.services.db.listChapters().find((item) => item.id === chapterId),
      }
    },
  },
  {
    name: 'listIdeology',
    legacy: true,
    resultSchema: 'ListIdeologyResult',
    validate: () => {},
    handler: (ctx) => ctx.services.db.listIdeology(),
  },
]
