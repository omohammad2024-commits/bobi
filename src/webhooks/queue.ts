/**
 * Bounded in-memory delivery queue with a background worker.
 *
 * Reliability contract: delivery is best-effort and NEVER fails the agent
 * turn. The worker retries a few times with exponential backoff, then drops
 * the event and moves on. A full queue drops the OLDEST events first (with a
 * counter and a log line) so a slow or dead endpoint cannot grow memory
 * without bound or starve fresh events.
 */
import { serialiseEvent, type WebhookEvent } from "./events";
import { SIGNATURE_HEADER, signBody } from "./signer";
import { resolveTarget } from "../ai/dns_guard";

/** Max events held in memory. Oldest are dropped first when exceeded. */
export const MAX_QUEUE_SIZE = 100;
/** Delivery attempts per event (initial try + retries). */
export const MAX_ATTEMPTS = 3;
/** Per-delivery HTTP timeout — a hung endpoint never holds the worker. */
export const DELIVERY_TIMEOUT_MS = 10_000;
/** Backoff before retry N (1-based): BASE * 2^(N-1). */
export const BACKOFF_BASE_MS = 1_000;

/** POST one signed event to one URL. Throws on any delivery failure. */
export type DeliverFn = (url: string, body: string, signature: string) => Promise<void>;

export interface WebhookQueueOptions {
  urls: readonly string[];
  secret: string;
  /** Override the transport (tests, or a future keepalive agent). */
  deliver?: DeliverFn;
  /**
   * Backoff sleep between retries. Injected so tests fast-forward it;
   * `drain()` always uses a real timer.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Override the capacity (tests use a small one). */
  capacity?: number;
}

export class WebhookQueue {
  private readonly urls: readonly string[];
  private readonly secret: string;
  private readonly deliver: DeliverFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly capacity: number;

  private readonly items: WebhookEvent[] = [];
  private dropped = 0;
  private pumping = false;
  private stopped = false;

  constructor(opts: WebhookQueueOptions) {
    this.urls = opts.urls;
    this.secret = opts.secret;
    this.deliver = opts.deliver ?? postWebhook;
    this.sleep = opts.sleep ?? defaultSleep;
    this.capacity = opts.capacity ?? MAX_QUEUE_SIZE;
  }

  /** Events currently waiting for delivery. */
  get size(): number {
    return this.items.length;
  }

  /** Events dropped because the queue was full. */
  get droppedCount(): number {
    return this.dropped;
  }

  /**
   * Enqueue an event for delivery. Never throws and never blocks: if the
   * queue is full the oldest event is dropped first. Delivery failures
   * (including total ones) are contained in the worker.
   */
  enqueue(event: WebhookEvent): void {
    if (this.stopped) return;
    if (this.items.length >= this.capacity) {
      this.items.shift();
      this.dropped++;
      console.warn(
        `[webhooks] Queue full; oldest event dropped (dropped: ${this.dropped}).`,
      );
    }
    this.items.push(event);
    void this.pump();
  }

  /** Stop the worker. Events already in flight finish; the rest are dropped. */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Wait until the queue drains (or the worker stops). For tests and for a
   * graceful shutdown hook — never called on the agent turn's hot path.
   *
   * Uses a real timer, not the injected backoff sleep, so a test that records
   * backoff intervals is not polluted by drain polling.
   */
  async drain(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // The pump removes the head when it TAKES it, so `items` can be empty
    // while one delivery is still in flight — wait for the worker too.
    while ((this.items.length > 0 || this.pumping) && !this.stopped && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Single-flight worker: pulls events head-first, retries, never throws. */
  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      while (!this.stopped) {
        // The head is REMOVED when taken, not after delivery: an event that
        // is already being delivered must never be the victim of a
        // drop-oldest eviction from a concurrent enqueue. Eviction only ever
        // applies to events still waiting in the queue.
        const event = this.items.shift();
        if (event === undefined) break;
        try {
          await this.deliverWithRetry(event);
        } catch {
          // deliverWithRetry already logged; the event is dropped either way.
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async deliverWithRetry(event: WebhookEvent): Promise<void> {
    const body = serialiseEvent(event);
    const signature = signBody(this.secret, body);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (this.stopped) return;
      try {
        // Fan out to every configured URL; one bad endpoint must not
        // cancel the others.
        await Promise.all(this.urls.map((url) => this.deliver(url, body, signature)));
        return;
      } catch (err) {
        const last = attempt === MAX_ATTEMPTS;
        console.warn(
          `[webhooks] Failed to deliver event "${event.event}" (attempt ${attempt} of ${MAX_ATTEMPTS})${
            last ? "; event dropped." : "; retrying."
          }`,
        );
        void err;
        if (!last) await this.sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }
}

/**
 * Ceiling on the response body a delivery will drain.
 *
 * The body of a webhook response is an acknowledgement nobody reads; it is
 * drained only so a keepalive connection can be reused. An endpoint that
 * streams forever (or a hostile one that answers a POST with gigabytes)
 * must not be able to grow this process's memory — past the ceiling the
 * stream is cancelled and the delivery still counts as delivered.
 */
export const MAX_RESPONSE_DRAIN_BYTES = 64 * 1024;

/** Injectable seams for {@link postWebhook}; production uses the defaults. */
export interface PostWebhookOptions {
  /**
   * Target validator, run before any connection. Defaults to the SSRF
   * guard (`resolveTarget`, public-only policy). Injectable for tests.
   */
  validate?: (url: string) => Promise<void>;
  /** Transport. Defaults to the global fetch. Injectable for tests. */
  fetchFn?: typeof fetch;
}

/**
 * Default target validation: the same SSRF guard the AI transports and
 * fetch_url use, under its default public-only policy.
 *
 * Webhook URLs are owner-configured, but "owner-configured" is exactly how
 * a mistyped or pasted URL would otherwise aim signed event POSTs at a
 * loopback service, a LAN address, or the cloud metadata endpoint — and a
 * hostname that rebinds to one of those is refused by the guard's address
 * classification. Refusal is a fixed message: the resolved address is
 * infrastructure detail and never travels into an error.
 */
async function validateWebhookTarget(url: string): Promise<void> {
  try {
    await resolveTarget({ baseUrl: url, apiKey: undefined });
  } catch {
    throw new Error("webhook delivery failed: target not allowed");
  }
}

/** Drain a response body with a hard size ceiling (see the constant). */
async function drainResponseCapped(res: Response): Promise<void> {
  const reader = res.body?.getReader();
  if (reader === undefined) return;
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_DRAIN_BYTES) {
      await reader.cancel();
      break;
    }
  }
}

/**
 * Default transport: one POST per URL with a 10s abort timeout.
 *
 * Hardening (P0-NET-2), all three parts deliberate:
 * - the target is validated with `resolveTarget` before connecting;
 * - redirects are NEVER followed (`redirect: "manual"`): a 307/308 would
 *   otherwise re-send the event body AND the HMAC signature header to a
 *   host the owner never configured — a 3xx is a delivery failure here;
 * - the response body is drained through a size cap, not buffered whole.
 *
 * One honest caveat, shared with the downloader: the plain fetch re-resolves
 * DNS after validation, so the connection is not pinned to the validated
 * addresses; the guard's classification still blocks the direct internal
 * target and the 60s DNS cache makes a same-name rebind race impractical.
 */
export async function postWebhook(
  url: string,
  body: string,
  signature: string,
  opts: PostWebhookOptions = {},
): Promise<void> {
  await (opts.validate ?? validateWebhookTarget)(url);
  const doFetch = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  // Unref so a hanging endpoint cannot keep the process alive past shutdown.
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  if (typeof (timer as unknown as { unref?: unknown }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signature,
      },
      body,
      signal: controller.signal,
      redirect: "manual",
    });
    if (!res.ok) throw new Error(`webhook delivery failed: HTTP ${res.status}`);
    // Drain the body so a keepalive connection can be reused — capped, so
    // an endless or enormous acknowledgement cannot grow memory.
    await drainResponseCapped(res);
  } finally {
    clearTimeout(timer);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as unknown as { unref?: unknown }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
  });
}
