import type { Logger } from '../log.js'
import type { Services } from '../services.js'

export interface HandlerCtx {
  services: Services
  studentId: string
  requestId: string
  /** Aborted when the RPC deadline expires; forward it to anything cancellable. */
  signal: AbortSignal
  log: Logger
}

export interface MethodSpec {
  name: string
  /** Present only for the four Electron-era compatibility methods. */
  legacy?: boolean
  /** Schema name in docs/contracts/openapi.yaml. */
  resultSchema: string
  validate: (params: Record<string, unknown>) => void
  handler: (ctx: HandlerCtx, params: Record<string, unknown>) => unknown | Promise<unknown>
}
