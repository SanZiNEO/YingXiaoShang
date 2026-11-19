import { test, expect } from '../fixtures/test.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { friendlyError } from '../../../../apps/desktop/src/main/errors.js'

/**
 * 依赖：CH-01（learning:invoke 通用通道）、CH-03（learning:chat 错误传播口径对照）、
 * LEG-05（friendlyError 文案分流纯函数）、SVC-02（错误收口基线）。
 *
 * 探针口径（03 第 4.2 节错误对象探针项）：跨 IPC 只对 err.message 是字符串做硬断言；
 * stack、cause 与自有可枚举属性是否经结构化克隆保留，只观测落盘，不断言透传。
 * 本用例不为探针修改主进程源码。
 */

test('TC-P1-18 跨 IPC 错误对象形态探针', async ({ app, client }, testInfo) => {
  // 1. 未知 invoke 方法：CH-01 default 分支 reject（index.ts:390-391）。
  const method = 'learning.__nonexistent_method__'
  let rejection: unknown
  const probe: {
    rejected: boolean
    message: unknown
    messageIsString: boolean
    stackPresent: boolean
    ownEnumerableKeys: string[]
  } = {
    rejected: false,
    message: null,
    messageIsString: false,
    stackPresent: false,
    ownEnumerableKeys: [],
  }
  try {
    await client.invoke(method)
  } catch (error) {
    rejection = error
    const err = (error ?? {}) as Record<string, unknown>
    probe.rejected = true
    probe.message = err.message
    probe.messageIsString = typeof err.message === 'string'
    probe.stackPresent = typeof err.stack === 'string' && err.stack.length > 0
    probe.ownEnumerableKeys = Object.keys(err)
  }
  expect(probe.rejected).toBe(true)
  expect(probe.messageIsString).toBe(true)
  expect(String(probe.message)).toContain('unknown learning method')

  // 2. friendlyError 纯函数分流（LEG-05）：四类输入 → 非空中文 Error，不含原始英文报错前缀。
  const cases: Array<{ label: string; input: unknown; rawToken: string; expectHint: RegExp }> = [
    {
      label: 'api-key 未配置',
      input: new Error('DEEPSEEK_API_KEY is not configured'),
      rawToken: 'DEEPSEEK_API_KEY',
      expectHint: /密钥/,
    },
    {
      label: '断网 fetch failed',
      input: new TypeError('fetch failed'),
      rawToken: 'fetch failed',
      expectHint: /网络/,
    },
    {
      label: '限流 429',
      input: new Error('429 rate limit exceeded'),
      rawToken: '429',
      expectHint: /频繁/,
    },
    {
      label: 'SQLITE 锁定',
      input: new Error('SQLITE_BUSY: database is locked'),
      rawToken: 'SQLITE',
      expectHint: /本地数据写入失败|磁盘|另一个窗口/,
    },
  ]
  const friendlyResults = cases.map(({ label, input, rawToken, expectHint }) => {
    const out = friendlyError(input)
    expect(out).toBeInstanceOf(Error)
    expect(out.message.length).toBeGreaterThan(0)
    expect(expectHint.test(out.message)).toBe(true)
    expect(out.message).not.toContain(rawToken)
    return { label, message: out.message }
  })

  // 3. 未知报错兜底：保留原文并追加可执行建议。
  const unknown = friendlyError(new Error('some weird internal thing happened'))
  expect(unknown.message).toContain('some weird internal thing happened')
  expect(unknown.message).toContain('截图发给老师')

  // 4. Electron / Chromium 版本基线（主进程 evaluate 读取，作为结构化克隆行为的版本上下文）。
  const versions = await app.app.evaluate(() => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }))
  expect(versions.electron).toBeTruthy()
  expect(versions.chrome).toBeTruthy()

  mkdirSync(testInfo.outputDir, { recursive: true })
  writeFileSync(
    join(testInfo.outputDir, 'ipc-error-probe.json'),
    JSON.stringify(
      {
        method,
        probe,
        rejectionMessage: rejection instanceof Error ? rejection.message : String(rejection),
        friendly: friendlyResults,
        unknownFallback: unknown.message,
        versions,
      },
      null,
      2,
    ),
    'utf8',
  )
})
