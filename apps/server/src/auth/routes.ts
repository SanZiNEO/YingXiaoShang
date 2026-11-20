import { ApiError } from '../errors.js'
import type { Services } from '../services.js'

const STUDENT_ID = /^[A-Za-z0-9]{4,20}$/

export interface LoginResult {
  token: string
  expiresAt: string
  student: {
    studentId: string
    name: string
    cohort: string
  }
}

export async function handleLogin(
  services: Services,
  body: Record<string, unknown>,
  limited: boolean,
): Promise<LoginResult> {
  if (limited) {
    services.metrics.observeLogin('rate_limited')
    throw new ApiError(429, 'RATE_LIMITED', '尝试太频繁，请等一分钟再试。')
  }
  const studentId = body.studentId
  if (typeof studentId !== 'string' || !STUDENT_ID.test(studentId)) {
    throw new ApiError(400, 'BAD_REQUEST', '学号格式不对。', 'studentId')
  }
  const password = body.password
  if (typeof password !== 'string' || password.length === 0) {
    services.metrics.observeLogin('fail')
    throw new ApiError(401, 'AUTH_FAILED', '学号或口令不对，请检查后再试。')
  }
  const student = services.auth.verifyCredentials(studentId, password)
  if (!student) {
    services.metrics.observeLogin('fail')
    throw new ApiError(401, 'AUTH_FAILED', '学号或口令不对，请检查后再试。')
  }
  const issued = services.auth.issueToken(student.student_id, services.env.tokenTtlDays)
  services.metrics.observeLogin('ok')
  return {
    token: issued.token,
    expiresAt: issued.expiresAt,
    student: {
      studentId: student.student_id,
      name: student.name || '学生',
      cohort: student.cohort || '',
    },
  }
}

export function handleLogout(services: Services, token: string): void {
  services.auth.revokeToken(token)
}
