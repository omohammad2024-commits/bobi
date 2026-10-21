/**
 * In-flight turn registry (Phase G1), extracted from bot.ts in Phase 5
 * step B2 so cmd_session.ts (and anything else) can stop a turn without
 * importing bot.ts — this is a leaf module: it imports nothing.
 *
 * Per-conversation registry of in-flight turns, so /stop can abort
 * exactly the turn running in the chat that sent it.
 *
 * runTurn enters a controller when the turn's work begins and removes it when
 * the turn completes (success, failure, or supersession), so a finished turn
 * never looks in-flight. /stop aborts the controller and cancels the engine's
 * run for that conversation; the agent loop already honors the abort signal,
 * and the abandoned run stays silent (it surfaces as "superseded").
 */
const stopControllers = new Map<string, AbortController>();

/** Register an in-flight turn for a conversation. Exported for tests. */
export function enterTurn(conversationId: string): AbortController {
  const controller = new AbortController();
  stopControllers.set(conversationId, controller);
  return controller;
}

/** Remove a finished turn from the registry. Exported for tests. */
export function exitTurn(conversationId: string): void {
  stopControllers.delete(conversationId);
}

/**
 * Abort the in-flight turn for a conversation, if any.
 * Returns true when something was aborted. Exported for tests.
 */
export function stopTurn(conversationId: string): boolean {
  const controller = stopControllers.get(conversationId);
  if (controller === undefined) return false;
  stopControllers.delete(conversationId);
  controller.abort();
  return true;
}
