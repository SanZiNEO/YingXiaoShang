import { AsyncLocalStorage } from 'node:async_hooks'
import type { Metrics } from '../metrics.js'
import type { LlmLike } from './types.js'

/**
 * Per-request student attribution for token accounting. The HTTP handlers wrap
 * each turn / answer submission in `withStudent(studentId, ...)`, so token
 * chunks observed inside the agent chain carry that student's label. Calls
 * that are never wrapped fall back to `unattributed` instead of a fake
 * `anonymous` label.
 */
const studentStore = new AsyncLocalStorage<string>()

export function withStudent<T>(studentId: string, fn: () => T): T {
  return studentStore.run(studentId, fn)
}

function currentStudentId(): string {
  return studentStore.getStore() ?? 'unattributed'
}

/** Wraps an LLM implementation, metering prompt/completion tokens on `usage` chunks. */
export function createMeteredLlm(base: LlmLike, metrics: Metrics): LlmLike {
  return {
    async *stream(options) {
      for await (const chunk of base.stream(options)) {
        if (chunk.type === 'usage') {
          metrics.observeTokens(currentStudentId(), 'prompt', chunk.usage.inputTokens ?? 0)
          metrics.observeTokens(currentStudentId(), 'completion', chunk.usage.outputTokens ?? 0)
        }
        yield chunk
      }
    },
    async chat(messages) {
      return base.chat(messages)
    },
  }
}
