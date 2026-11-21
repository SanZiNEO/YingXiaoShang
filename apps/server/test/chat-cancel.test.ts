import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApp } from '../src/app.js'
import type { Services } from '../src/services.js'

const TOKEN = 'tok_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

/** Minimal services surface: the cancel route only needs auth + a metrics sink. */
function fakeServices(): Services {
  return {
    auth: {
      verifyToken: (token: string) =>
        token === TOKEN
          ? { studentId: '20230001', name: '张三', cohort: '2023', expiresAt: '2099-01-01T00:00:00.000Z' }
          : undefined,
    },
    metrics: {
      observeHttp() {},
      observeRpc() {},
      observeError() {},
      render: async () => '',
      contentType: 'text/plain',
    },
    log: { info() {}, warn() {}, error() {} },
  } as unknown as Services
}

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server: Server = createApp(fakeServices(), { corsOrigins: [] })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

async function cancel(baseUrl: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/v1/chat/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

test('chat/cancel：未知 requestId 仍 200 且 cancelled=false（冻结 §7.2）', async () => {
  await withServer(async (baseUrl) => {
    const { status, json } = await cancel(baseUrl, { requestId: 'req_contract_tests_unknown' })
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.deepEqual(json.result, { cancelled: false })
  })
})

test('chat/cancel：requestId 缺失或空串 → 400 BAD_REQUEST', async () => {
  await withServer(async (baseUrl) => {
    for (const body of [{}, { requestId: '' }, { requestId: 42 }]) {
      const { status, json } = await cancel(baseUrl, body)
      assert.equal(status, 400, `body=${JSON.stringify(body)}`)
      const error = json.error as { code: string; message: string; field: string }
      assert.equal(error.code, 'BAD_REQUEST')
      assert.equal(error.message, 'requestId 不能为空。')
      assert.equal(error.field, 'requestId')
    }
  })
})
