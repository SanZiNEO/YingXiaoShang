import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { SseWriter } from '../src/http/sse.js'

class FakeResponse {
  headers: Record<string, string> = {}
  chunks: string[] = []
  ended = false
  statusCode = 0

  writeHead(status: number, headers: Record<string, string>): void {
    this.statusCode = status
    this.headers = headers
  }

  write(chunk: string | Buffer): boolean {
    this.chunks.push(chunk.toString())
    return true
  }

  end(): void {
    this.ended = true
  }
}

const writers: SseWriter[] = []

afterEach(() => {
  for (const writer of writers.splice(0)) writer.close()
})

function makeWriter(): { writer: SseWriter; res: FakeResponse } {
  const res = new FakeResponse()
  const writer = new SseWriter(res as unknown as ServerResponse, 'req_test123')
  writers.push(writer)
  return { writer, res }
}

test('start() 写出 SSE 响应头，首帧 id 从 1 递增', () => {
  const { writer, res } = makeWriter()
  writer.start()
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['Content-Type'] ?? res.headers['content-type'] ?? '', /text\/event-stream/)
  writer.send('session', { requestId: 'req_test123', sessionId: 's_1' })
  writer.send('text', { requestId: 'req_test123', agent: 'lead', text: '第一段' })
  const [first, second] = res.chunks
  assert.match(first, /^id: 1\nevent: session\ndata: /)
  assert.match(second, /^id: 2\nevent: text\ndata: /)
})

test('done 只能发一次：第二次 done() 不再写帧、不重复关闭', () => {
  const { writer, res } = makeWriter()
  writer.start()
  writer.send('session', { requestId: 'req_test123', sessionId: 's_1' })
  const payload = { requestId: 'req_test123', turnId: 't_1', sessionId: 's_1', text: '全量', artifacts: [], citations: [], warnings: [] }
  writer.done(payload)
  const chunkCountAfterFirstDone = res.chunks.length
  assert.ok(res.ended)
  assert.ok(res.chunks.some((chunk) => chunk.includes('event: done')))
  writer.done(payload)
  assert.equal(res.chunks.length, chunkCountAfterFirstDone)
})

test('关闭后 error 帧不再写出', () => {
  const { writer, res } = makeWriter()
  writer.start()
  writer.done({ requestId: 'req_test123', turnId: 't_1', sessionId: 's_1', text: 'x', artifacts: [], citations: [], warnings: [] })
  const count = res.chunks.length
  writer.error('CANCELLED', '已停止这一轮（你点的停止）。这次没有保存结果，可以重新提问。')
  assert.equal(res.chunks.length, count)
})

test('帧之间以空行分隔，data 为 JSON', () => {
  const { writer, res } = makeWriter()
  writer.start()
  writer.send('text', { requestId: 'req_test123', agent: 'lead', text: '你好' })
  const frame = res.chunks[0]
  assert.match(frame, /\n\n$/)
  const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
  assert.ok(dataLine)
  const parsed = JSON.parse(dataLine.slice('data: '.length))
  assert.equal(parsed.text, '你好')
})
