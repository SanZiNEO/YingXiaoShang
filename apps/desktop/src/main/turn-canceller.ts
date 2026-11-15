/**
 * 每一轮对话一个 AbortController：学生点「停止」就中断在途模型请求。
 *
 * 为什么要单独成文件：这段接线曾经出过一个很贵的 bug——主进程建了
 * `AbortController`，却没把 `signal` 传进执行链，于是「停止」只是界面上停了，
 * 模型还在跑（假停，1393ms vs 141ms）。补上之后，`verify-cancel.ts` **仍然全绿**，
 * 因为它只测 `runAgentLoop({signal})`，没测「cancel → controller → hooks.signal」
 * 这条接线。把它抽出来，至少 controller 的生命周期可以被直接断言。
 */

export class TurnCanceller {
  private readonly controllers = new Map<string, AbortController>()

  /** 开始一轮：拿到这一轮的 signal，交给执行链。 */
  begin(requestId: string): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController()
    if (requestId.length > 0) this.controllers.set(requestId, controller)
    return {
      signal: controller.signal,
      done: () => {
        if (requestId.length > 0) this.controllers.delete(requestId)
      },
    }
  }

  /**
   * 学生点了停止。
   * 返回 false 表示这一轮已经结束或不存在——界面不该提示「已停止」。
   */
  cancel(requestId: string): boolean {
    const controller = this.controllers.get(requestId)
    if (!controller) return false
    controller.abort()
    this.controllers.delete(requestId)
    return true
  }

  /** 仅供测试与排查：还有几轮在跑。 */
  get size(): number {
    return this.controllers.size
  }
}
