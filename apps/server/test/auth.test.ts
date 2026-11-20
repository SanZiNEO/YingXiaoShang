import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AuthStore } from '../src/auth/store.js'

let store: AuthStore
let tempDir: string

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'yxs-auth-test-'))
  store = new AuthStore(join(tempDir, 'auth.db'))
  store.upsertStudent({ studentId: '20230001', password: 'abc12345', name: '张三', cohort: '2023' })
})

after(() => {
  store.close()
  rmSync(tempDir, { recursive: true, force: true })
})

test('登录成功后 token 为 43 字符 base64url，且能换回学号', () => {
  const issued = store.issueToken('20230001', 7)
  assert.equal(issued.token.length, 43)
  assert.match(issued.token, /^[A-Za-z0-9_-]+$/)
  const session = store.verifyToken(issued.token)
  assert.ok(session)
  assert.equal(session.studentId, '20230001')
  assert.equal(session.name, '张三')
})

test('口令正确放行、错误口令拒绝（防枚举：store 层不区分原因）', () => {
  assert.ok(store.verifyCredentials('20230001', 'abc12345'))
  assert.equal(store.verifyCredentials('20230001', 'wrong'), undefined)
  assert.equal(store.verifyCredentials('99999999', 'abc12345'), undefined)
})

test('不存在的 token、篡改过的 token 都校验失败', () => {
  assert.equal(store.verifyToken('nonexistent-token-value'.padEnd(43, 'x')), undefined)
  const issued = store.issueToken('20230001', 7)
  const tampered = issued.token.slice(0, -1) + (issued.token.endsWith('A') ? 'B' : 'A')
  assert.notEqual(tampered, issued.token)
  assert.equal(store.verifyToken(tampered), undefined)
})

test('登出（撤销）后同一 token 立刻失效（AC-A-05）', () => {
  const issued = store.issueToken('20230001', 7)
  assert.ok(store.verifyToken(issued.token))
  store.revokeToken(issued.token)
  assert.equal(store.verifyToken(issued.token), undefined)
})

test('过期 token 校验失败', () => {
  const issued = store.issueToken('20230001', 7)
  assert.ok(store.verifyToken(issued.token))
  // 直接把最新一条 token 记录的过期时间改成过去，验证过期分支（不经过签发路径）。
  const raw = new DatabaseSync(join(tempDir, 'auth.db'))
  try {
    raw
      .prepare(
        'UPDATE auth_tokens SET expires_at = ? WHERE token_hash = (SELECT token_hash FROM auth_tokens WHERE student_id = ? ORDER BY issued_at DESC LIMIT 1)',
      )
      .run(new Date(Date.now() - 1000).toISOString(), '20230001')
  } finally {
    raw.close()
  }
  assert.equal(store.verifyToken(issued.token), undefined)
})
