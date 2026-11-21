import type { IncomingMessage } from 'node:http'
import { ApiError } from '../errors.js'
import type { AuthSession, AuthStore } from './store.js'

export interface AuthedStudent extends AuthSession {
  token: string
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+([A-Za-z0-9._~-]+)$/.exec(header.trim())
  return match?.[1]
}

export function requireStudent(req: IncomingMessage, auth: AuthStore): AuthedStudent {
  const token = bearerToken(req)
  if (!token) throw new ApiError(401, 'AUTH_REQUIRED', '请先登录。')
  const session = auth.verifyToken(token)
  if (!session) throw new ApiError(401, 'AUTH_INVALID', '登录已失效，请重新登录。')
  return { ...session, token }
}
