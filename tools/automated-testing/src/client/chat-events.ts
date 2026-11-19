import type { Page } from 'playwright'
import { delay } from '../driver/ports.js'
import type { ChatEvent } from './types.js'

export interface CollectedChatEvent {
  at: number
  event: ChatEvent
}

/**
 * `learning:chat-event` 流式采集器。
 * 渲染层自己的订阅不动；这里另挂一个监听，只做记录，避免和界面状态互相影响。
 */
export class ChatEventCollector {
  readonly events: CollectedChatEvent[] = []
  private attached = false

  async attach(page: Page): Promise<void> {
    if (this.attached) return
    await page.exposeFunction('__yxsCaptureChatEvent', (payload: unknown) => {
      const event = payload as ChatEvent
      if (!event || typeof event.requestId !== 'string') return
      this.events.push({ at: Date.now(), event })
    })
    await page.evaluate(() => {
      const api = (window as unknown as { learning?: { onChatEvent?: unknown } }).learning
      if (!api || typeof api.onChatEvent !== 'function') {
        throw new Error('window.learning.onChatEvent 不可用，preload 契约变了')
      }
      const w = window as unknown as { __yxsDisposeChatEvent?: () => void }
      w.__yxsDisposeChatEvent?.()
      w.__yxsDisposeChatEvent = (api.onChatEvent as (handler: (event: unknown) => void) => () => void)((
        event: unknown,
      ) => {
        ;(window as unknown as { __yxsCaptureChatEvent: (payload: unknown) => void }).__yxsCaptureChatEvent(event)
      })
    })
    this.attached = true
  }

  clear(): void {
    this.events.length = 0
  }

  forRequest(requestId: string): CollectedChatEvent[] {
    return this.events.filter((item) => item.event.requestId === requestId)
  }

  textOf(requestId: string): string {
    return this.forRequest(requestId)
      .filter((item) => item.event.type === 'text' && item.event.agent === 'lead')
      .map((item) => item.event.text ?? '')
      .join('')
  }

  async waitFor(
    predicate: (event: ChatEvent) => boolean,
    timeoutMs = 60000,
  ): Promise<ChatEvent> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = this.events.find((item) => predicate(item.event))
      if (hit) return hit.event
      await delay(40)
    }
    throw new Error(`等待流式事件超时（${timeoutMs}ms）`)
  }

  /** 等待某个 requestId 的事件数量稳定下来（用于取消后确认“不再产字”）。 */
  async waitQuiet(requestId: string, quietMs = 1500, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastCount = -1
    let quietSince = Date.now()
    while (Date.now() < deadline) {
      const count = this.forRequest(requestId).length
      if (count !== lastCount) {
        lastCount = count
        quietSince = Date.now()
      }
      if (Date.now() - quietSince >= quietMs) return
      await delay(50)
    }
    throw new Error(`事件流在 ${timeoutMs}ms 内没有静默（requestId=${requestId}）`)
  }
}
