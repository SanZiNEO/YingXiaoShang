import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../src/errors.js'
import {
  requiredString,
  requiredNumber,
  optionalNumber,
  oneOf,
  stringArray,
} from '../src/rpc/validate.js'

function expectBadRequest(fn: () => unknown, field: string, message: string) {
  try {
    fn()
    assert.fail('应当抛出 BAD_REQUEST')
  } catch (error) {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 400)
    assert.equal(error.code, 'BAD_REQUEST')
    assert.equal(error.field, field)
    assert.equal(error.message, message)
  }
}

test('requiredString：缺失与空串都报中文消息（AC-A-06 口径）', () => {
  expectBadRequest(
    () => requiredString({}, 'articleId', { message: 'articleId 不能为空。' }),
    'articleId',
    'articleId 不能为空。',
  )
  expectBadRequest(
    () => requiredString({ articleId: '   ' }, 'articleId', { message: 'articleId 不能为空。' }),
    'articleId',
    'articleId 不能为空。',
  )
  const value = requiredString({ articleId: '  n1  ' }, 'articleId', { message: 'articleId 不能为空。' })
  assert.equal(value, '  n1  ')
})

test('requiredNumber：类型错用「必须是整数」，越界用范围消息，field 为裸参数名', () => {
  const range = 'limit 必须是 1 到 500 的整数。'
  // 类型错（字符串 / 小数 / NaN）→ 专用文案，逐字对齐冻结 §4.3。
  for (const wrong of ['10', 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expectBadRequest(
      () => requiredNumber({ limit: wrong }, 'limit', { min: 1, max: 500, message: range }),
      'limit',
      'limit 必须是整数。',
    )
  }
  // 越界（整数但小于下限 / 大于上限）→ 该方法的范围消息。
  for (const outOfRange of [0, -1, 9999]) {
    expectBadRequest(
      () => requiredNumber({ limit: outOfRange }, 'limit', { min: 1, max: 500, message: range }),
      'limit',
      range,
    )
  }
  assert.equal(requiredNumber({ limit: 20 }, 'limit', { min: 1, max: 500, message: range }), 20)
  assert.equal(requiredNumber({ limit: 1 }, 'limit', { min: 1, max: 500, message: range }), 1)
  assert.equal(requiredNumber({ limit: 500 }, 'limit', { min: 1, max: 500, message: range }), 500)
})

test('optionalNumber：未传 / null 保持 undefined，传了就按 requiredNumber 校验', () => {
  const range = 'limit 必须是 1 到 200 的整数。'
  assert.equal(optionalNumber({}, 'limit', { min: 1, max: 200, message: range }), undefined)
  assert.equal(optionalNumber({ limit: null }, 'limit', { min: 1, max: 200, message: range }), undefined)
  assert.equal(optionalNumber({ limit: 200 }, 'limit', { min: 1, max: 200, message: range }), 200)
  expectBadRequest(
    () => optionalNumber({ limit: '200' }, 'limit', { min: 1, max: 200, message: range }),
    'limit',
    'limit 必须是整数。',
  )
  expectBadRequest(
    () => optionalNumber({ limit: 201 }, 'limit', { min: 1, max: 200, message: range }),
    'limit',
    range,
  )
})

test('oneOf：非法枚举值报逐字消息（checkpoint 必须是 pre 或 post。）', () => {
  expectBadRequest(
    () => oneOf('mid', ['pre', 'post'] as const, 'checkpoint 必须是 pre 或 post。', 'checkpoint'),
    'checkpoint',
    'checkpoint 必须是 pre 或 post。',
  )
  assert.equal(oneOf('pre', ['pre', 'post'] as const, 'checkpoint 必须是 pre 或 post。', 'checkpoint'), 'pre')
})

test('stringArray：非数组、空数组、非字符串元素都拒绝', () => {
  const opts = { maxItems: 32, maxLength: 64, message: 'sources 必须是非空字符串数组。', field: 'sources' }
  expectBadRequest(() => stringArray('not-an-array', opts), 'sources', 'sources 必须是非空字符串数组。')
  expectBadRequest(() => stringArray([], opts), 'sources', 'sources 必须是非空字符串数组。')
  expectBadRequest(() => stringArray([1, 2], opts), 'sources', 'sources 必须是非空字符串数组。')
  assert.deepEqual(stringArray(['36kr'], opts), ['36kr'])
})
