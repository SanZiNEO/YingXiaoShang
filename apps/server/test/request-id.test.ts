import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { REQUEST_ID_PATTERN, newRequestId } from '../src/http/request-id.js'
import { runWithTimeout, timeoutFor, TIMEOUT_MESSAGE } from '../src/rpc/timeout.js'
import { ApiError } from '../src/errors.js'

test('newRequestId：恒为 req_ + 12 位 base36，且通过契约正则', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 20_000; i += 1) {
    const id = newRequestId()
    assert.equal(id.length, 'req_'.length + 12, `长度不对：${id}`)
    assert.match(id, /^req_[0-9a-z]{12}$/)
    assert.ok(REQUEST_ID_PATTERN.test(id), `未通过契约正则：${id}`)
    seen.add(id)
  }
  // 12 位 base36 ≈ 4.7e18，两万次抽样里撞车就说明熵源坏了。
  assert.ok(seen.size > 19_990, `随机性不足：${seen.size}/20000`)
})

test('timeoutFor：默认 10s，news.refresh 30s，artifacts.export 20s', () => {
  assert.equal(timeoutFor('news.list'), 10_000)
  assert.equal(timeoutFor('chat.messages'), 10_000)
  assert.equal(timeoutFor('news.refresh'), 30_000)
  assert.equal(timeoutFor('artifacts.export'), 20_000)
})

test('runWithTimeout：到点抛 504 TIMEOUT 并中断下游 signal', async () => {
  // 假计时器：超时判定是纯定时器行为，不需要真的等 20ms，也不该让 CI 为它付真实延迟。
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const controller = new AbortController()
    let aborted = false
    const pending = runWithTimeout(20, controller, (signal) => {
      signal.addEventListener('abort', () => {
        aborted = true
      })
      return new Promise<never>(() => {})
    })
    mock.timers.tick(20)
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 504)
      assert.equal(error.code, 'TIMEOUT')
      assert.equal(error.message, TIMEOUT_MESSAGE)
      return true
    })
    assert.equal(controller.signal.aborted, true)
    assert.equal(aborted, true)
  } finally {
    mock.timers.reset()
  }
})

test('runWithTimeout：未超时正常返回，且不触发中断', async () => {
  const controller = new AbortController()
  const value = await runWithTimeout(5_000, controller, async () => 'ok')
  assert.equal(value, 'ok')
  assert.equal(controller.signal.aborted, false)
})

test('runWithTimeout：下游自己抛错时原样冒泡，不被超时覆盖', async () => {
  const controller = new AbortController()
  await assert.rejects(
    runWithTimeout(5_000, controller, async () => {
      throw new ApiError(404, 'NOT_FOUND', '没有找到这条记录，可能已被删除。')
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, 'NOT_FOUND')
      return true
    },
  )
})
