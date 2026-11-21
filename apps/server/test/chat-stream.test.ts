import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleChatStream } from '../src/chat/stream.js'
import { ApiError } from '../src/errors.js'
import { TurnRegistry } from '../src/chat/turns.js'
import type { Services } from '../src/services.js'

const FORBIDDEN = '这个资源不属于当前学号，换回自己的账号再试。'
const NOT_FOUND = '没有找到这条记录，可能已被删除。'

/** 只实现 readJson 走得到的那几个成员：异步可迭代 + headers。 */
function fakeRequest(body: unknown, token = 'tok'): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  const stream = {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield payload
    },
  }
  return stream as unknown as IncomingMessage
}

interface Recorded {
  status: number | undefined
  headers: Record<string, string>
  chunks: string[]
}

function fakeResponse(): { res: ServerResponse; recorded: Recorded } {
  const recorded: Recorded = { status: undefined, headers: {}, chunks: [] }
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      recorded.status = status
      recorded.headers = headers
      return res
    },
    write(chunk: string | Buffer) {
      recorded.chunks.push(chunk.toString())
      return true
    },
    end() {},
    on() {},
    off() {},
    writableEnded: false,
    setHeader() {},
  }
  return { res: res as unknown as ServerResponse, recorded }
}

function fakeServices(sessionOwner: string | undefined): Services {
  return {
    auth: {
      verifyToken: () => ({ studentId: 'B', name: '李四', cohort: '2023', expiresAt: '2099-01-01T00:00:00.000Z' }),
    },
    db: {
      getChatSession: (id: string) =>
        sessionOwner === undefined ? undefined : { id, student_id: sessionOwner },
    },
    metrics: {
      incSseActive() {},
      decSseActive() {},
      observeError() {},
      observeFirstToken() {},
    },
    agent: {
      handleConversation: async () => {
        throw new Error('归属校验失败时不应进入 agent')
      },
    },
  } as unknown as Services
}

async function expectRejection(services: Services, body: unknown, status: number, code: string, message: string) {
  const { res, recorded } = fakeResponse()
  await assert.rejects(
    handleChatStream(fakeRequest(body), res, services, new TurnRegistry(), {
      requestId: 'req_aaaaaaaaaaaa',
      startedAt: performance.now(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, status)
      assert.equal(error.code, code)
      assert.equal(error.message, message)
      return true
    },
  )
  // 关键：SSE 头一行都没写出去，客户端收到的仍是真实 HTTP 状态码。
  assert.equal(recorded.status, undefined)
  assert.deepEqual(recorded.chunks, [])
}

test('chat/stream：B 学生往 A 学生的会话写消息 → 403 FORBIDDEN，且未发出任何 SSE 帧', async () => {
  await expectRejection(
    fakeServices('A'),
    { sessionId: 's_a', message: '你好' },
    403,
    'FORBIDDEN',
    FORBIDDEN,
  )
})

test('chat/stream：sessionId 不存在 → 404 NOT_FOUND，且未发出任何 SSE 帧', async () => {
  await expectRejection(
    fakeServices(undefined),
    { sessionId: 's_missing', message: '你好' },
    404,
    'NOT_FOUND',
    NOT_FOUND,
  )
})

test('chat/stream：不传 sessionId 时不查归属（新会话由 agent 建立）', async () => {
  const { res, recorded } = fakeResponse()
  // agent 抛错被转成 error 帧（设计如此），所以这里 await 正常返回；
  // 关键是 SSE 头已经写出 → 证明走过了归属校验分支。
  await handleChatStream(fakeRequest({ message: '你好' }), res, fakeServices(undefined), new TurnRegistry(), {
    requestId: 'req_aaaaaaaaaaaa',
    startedAt: performance.now(),
  })
  assert.equal(recorded.status, 200)
  assert.ok(recorded.chunks.some((chunk) => chunk.includes('event: error')))
})
