/**
 * In-flight turn registry: one AbortController per accepted `requestId`.
 *
 * The controller's signal is handed all the way into the agent execution chain
 * (`handleConversation(..., { signal })`), so a cancel really interrupts the
 * model request instead of only closing the HTTP connection. Mirrors the
 * Electron-era `TurnCanceller` (`apps/desktop/src/main/turn-canceller.ts`).
 */
export class TurnRegistry {
  private readonly controllers = new Map<string, AbortController>()

  /** Begin a turn: register its controller and return it for the signal chain. */
  begin(requestId: string): AbortController {
    const controller = new AbortController()
    if (requestId.length > 0) this.controllers.set(requestId, controller)
    return controller
  }

  /**
   * Cancel an in-flight turn. Returns `false` when the id is unknown or the
   * turn already finished; that is a normal outcome, not an error.
   */
  cancel(requestId: string): boolean {
    if (requestId.length === 0) return false
    const controller = this.controllers.get(requestId)
    if (!controller) return false
    controller.abort()
    this.controllers.delete(requestId)
    return true
  }

  /** Remove the turn from the registry after it settles (success or failure). */
  done(requestId: string): void {
    if (requestId.length > 0) this.controllers.delete(requestId)
  }
}
