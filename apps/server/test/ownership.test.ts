import { test } from 'node:test'
import assert from 'node:assert/strict'
import type LearningDb from '@learning-agent/db'
import { ApiError } from '../src/errors.js'
import {
  requireSession,
  requireArtifact,
  requireEvidence,
  requireMemoryFact,
} from '../src/ownership.js'

const FORBIDDEN = '这个资源不属于当前学号，换回自己的账号再试。'
const NOT_FOUND = '没有找到这条记录，可能已被删除。'

const db = {
  getChatSession: (id: string) => (id === 's_own' ? { id, student_id: 'A' } : undefined),
  getArtifact: (id: string) => (id === 'a_own' ? { id, student_id: 'A' } : undefined),
  listEvidence: (opts: { studentId: string }) =>
    [{ id: 'e_own', student_id: 'A' }].filter((item) => item.student_id === opts.studentId),
  listMemoryFacts: (studentId: string) =>
    [{ id: 'f_own', student_id: 'A' }].filter((item) => item.student_id === studentId),
} as unknown as LearningDb

function expectError(fn: () => unknown, status: number, code: string, message: string) {
  try {
    fn()
    assert.fail('应当抛出归属错误')
  } catch (error) {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, status)
    assert.equal(error.code, code)
    assert.equal(error.message, message)
  }
}

test('会话归属：本人放行；他人 403；不存在 404', () => {
  assert.equal(requireSession(db, 's_own', 'A').student_id, 'A')
  expectError(() => requireSession(db, 's_own', 'B'), 403, 'FORBIDDEN', FORBIDDEN)
  expectError(() => requireSession(db, 's_missing', 'A'), 404, 'NOT_FOUND', NOT_FOUND)
})

test('产物归属：本人放行；他人 403；不存在 404', () => {
  assert.equal(requireArtifact(db, 'a_own', 'A').student_id, 'A')
  expectError(() => requireArtifact(db, 'a_own', 'B'), 403, 'FORBIDDEN', FORBIDDEN)
  expectError(() => requireArtifact(db, 'a_missing', 'A'), 404, 'NOT_FOUND', NOT_FOUND)
})

test('证据归属：查不到本人名下记录一律 403（不暴露存在与否）', () => {
  assert.equal(requireEvidence(db, 'e_own', 'A').id, 'e_own')
  expectError(() => requireEvidence(db, 'e_own', 'B'), 403, 'FORBIDDEN', FORBIDDEN)
  expectError(() => requireEvidence(db, 'e_missing', 'A'), 403, 'FORBIDDEN', FORBIDDEN)
})

test('记忆事实归属：查不到本人名下记录一律 403', () => {
  assert.equal(requireMemoryFact(db, 'f_own', 'A').id, 'f_own')
  expectError(() => requireMemoryFact(db, 'f_own', 'B'), 403, 'FORBIDDEN', FORBIDDEN)
  expectError(() => requireMemoryFact(db, 'f_missing', 'A'), 403, 'FORBIDDEN', FORBIDDEN)
})
