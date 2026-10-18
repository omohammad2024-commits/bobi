/**
 * Outbound webhooks — public surface.
 *
 * The engine calls `webhooksEnabled()` on the turn's hot path: it is a single
 * cached boolean check, so an unconfigured bot pays essentially nothing.
 * When enabled, `emitWebhookEvent` enqueues fire-and-forget and NEVER throws
 * — a webhook problem must never become a turn problem.
 */
import { loadWebhookConfig, type WebhookConfig } from "./config";
import { WebhookQueue, type DeliverFn } from "./queue";
import type { WebhookEvent } from "./events";

export { loadWebhookConfig, type WebhookConfig } from "./config";
export { signBody, verifySignature, SIGNATURE_HEADER } from "./signer";
export {
  agentStartEvent,
  agentEndEvent,
  toolEndEvent,
  serialiseEvent,
  type WebhookEvent,
  type WebhookEventName,
  type WebhookEventData,
} from "./events";
export {
  WebhookQueue,
  postWebhook,
  MAX_QUEUE_SIZE,
  MAX_ATTEMPTS,
  DELIVERY_TIMEOUT_MS,
  BACKOFF_BASE_MS,
  type DeliverFn,
  type WebhookQueueOptions,
} from "./queue";

// Lazily parsed once; `initWebhooks` re-parses (startup, tests).
let cached: WebhookConfig | undefined;
let queue: WebhookQueue | undefined;
/** Test-only transport override. Never set outside tests. */
let testDeliver: DeliverFn | undefined;

/** (Re)read the environment and rebuild the queue. Idempotent. */
export function initWebhooks(env: Record<string, string | undefined> = process.env): WebhookConfig {
  cached = loadWebhookConfig(env);
  queue = undefined;
  return cached;
}

/**
 * Hot-path guard: one cached boolean, no env parsing, no allocation.
 * Everything webhook-related in the engine sits behind this call.
 */
export function webhooksEnabled(): boolean {
  if (cached === undefined) cached = loadWebhookConfig();
  return cached.enabled;
}

/** Current config, for diagnostics (never logs the secret — see config.ts). */
export function webhookConfig(): WebhookConfig {
  if (cached === undefined) cached = loadWebhookConfig();
  return cached;
}

/**
 * Enqueue an event for background delivery. Fire-and-forget: never throws,
 * never awaits, never blocks the caller. No-op when webhooks are disabled.
 */
export function emitWebhookEvent(event: WebhookEvent): void {
  try {
    if (!webhooksEnabled()) return;
    getQueue().enqueue(event);
  } catch {
    // The queue never throws by contract; this is belt and suspenders so a
    // future change cannot turn webhook observation into a turn failure.
  }
}

/** Stop the background worker. Used on shutdown. */
export function shutdownWebhooks(): void {
  queue?.stop();
  queue = undefined;
}

function getQueue(): WebhookQueue {
  if (queue === undefined) {
    const cfg = webhookConfig();
    queue = new WebhookQueue({
      urls: cfg.urls,
      secret: cfg.secret,
      ...(testDeliver !== undefined ? { deliver: testDeliver } : {}),
    });
  }
  return queue;
}

/**
 * Test seam: replace the HTTP transport with a recorder. Pass undefined to
 * restore the real transport. Resets the queue so the override takes effect
 * immediately; tests should also call `initWebhooks` to control the env.
 */
export function setWebhookDeliverForTests(fn: DeliverFn | undefined): void {
  testDeliver = fn;
  queue = undefined;
}
