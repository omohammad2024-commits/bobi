/**
 * Per-user rate limiting.
 *
 * The agent makes this necessary in a way a chat bot did not: one user message
 * can now become up to `maxIterations` provider calls and `maxToolCalls` tool
 * executions. A user who sends ten messages in a row can therefore spend far
 * more than ten times the budget, and an approved user who misbehaves can do it
 * without any further check.
 *
 * Two independent budgets are enforced because they bound different things:
 *
 *  - MESSAGES bound the effort a user can demand directly.
 *  - TOOL CALLS bound the work the MODEL can trigger on that user's behalf,
 *    which is the one that grows when a model loops.
 *
 * State is in memory. That is deliberate: this is a fairness control for a
 * single-process bot, not an accounting ledger. A restart clearing the windows
 * costs at most one burst, and avoids a database write on every message.
 */

export interface RateLimitRule {
  /** How many events are allowed inside the window. */
  limit: number;
  /** Window length, ms. */
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Events still available after this one. */
  remaining: number;
  /** When the oldest event leaves the window, ms from now. 0 when allowed. */
  retryAfterMs: number;
}

export interface RateLimiterOptions {
  /** Messages allowed per user per window. Zero disables this rule. */
  messages: RateLimitRule;
  /** Tool executions allowed per user per window. Zero disables this rule. */
  toolCalls: RateLimitRule;
  /** Injectable clock, so tests do not sleep. */
  now?: () => number;
  /**
   * How many users to retain timestamps for.
   *
   * A bot with no eviction would leak one small array per user forever. This
   * bound keeps the structure small; the least recently active user is dropped.
   */
  maxUsers?: number;
}

/** A fixed-size ring of timestamps per user. */
interface Window {
  stamps: number[];
  /** Last time this user was seen, for eviction. */
  touchedAt: number;
}

const DEFAULT_MAX_USERS = 10_000;

export class RateLimiter {
  private readonly messages: RateLimitRule;
  private readonly toolCalls: RateLimitRule;
  private readonly now: () => number;
  private readonly maxUsers: number;

  private readonly messageWindows = new Map<string, Window>();
  private readonly toolWindows = new Map<string, Window>();

  constructor(opts: RateLimiterOptions) {
    this.messages = opts.messages;
    this.toolCalls = opts.toolCalls;
    this.now = opts.now ?? (() => Date.now());
    this.maxUsers = opts.maxUsers ?? DEFAULT_MAX_USERS;
  }

  /**
   * Record one message for a user, if the budget allows.
   *
   * A refused attempt is NOT recorded, so a client that keeps retrying cannot
   * extend its own lockout — it simply continues to be refused until the
   * window drains.
   */
  takeMessage(userId: string): RateLimitDecision {
    return this.take(this.messageWindows, userId, this.messages);
  }

  /** Check the message budget without consuming it. */
  peekMessage(userId: string): RateLimitDecision {
    return this.peek(this.messageWindows, userId, this.messages);
  }

  /** Record one tool execution, if this user's budget allows. */
  takeToolCall(userId: string): RateLimitDecision {
    return this.take(this.toolWindows, userId, this.toolCalls);
  }

  /** Check the tool budget without consuming it. */
  peekToolCall(userId: string): RateLimitDecision {
    return this.peek(this.toolWindows, userId, this.toolCalls);
  }

  /** Drop every window. Used by tests and on shutdown. */
  reset(): void {
    this.messageWindows.clear();
    this.toolWindows.clear();
  }

  private take(map: Map<string, Window>, userId: string, rule: RateLimitRule): RateLimitDecision {
    if (rule.limit <= 0) return { allowed: true, remaining: Infinity, retryAfterMs: 0 };

    const now = this.now();
    const window = this.windowFor(map, userId, now, rule.windowMs);

    if (window.stamps.length >= rule.limit) {
      // The oldest event decides when a slot frees up.
      const oldest = window.stamps[0]!;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, oldest + rule.windowMs - now),
      };
    }

    window.stamps.push(now);
    window.touchedAt = now;
    return { allowed: true, remaining: rule.limit - window.stamps.length, retryAfterMs: 0 };
  }

  private peek(map: Map<string, Window>, userId: string, rule: RateLimitRule): RateLimitDecision {
    if (rule.limit <= 0) return { allowed: true, remaining: Infinity, retryAfterMs: 0 };

    const now = this.now();
    const window = map.get(userId);
    if (!window) return { allowed: true, remaining: rule.limit, retryAfterMs: 0 };

    this.prune(window, now, rule.windowMs);

    if (window.stamps.length >= rule.limit) {
      const oldest = window.stamps[0]!;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, oldest + rule.windowMs - now),
      };
    }
    return {
      allowed: true,
      remaining: rule.limit - window.stamps.length,
      retryAfterMs: 0,
    };
  }

  private windowFor(
    map: Map<string, Window>,
    userId: string,
    now: number,
    windowMs: number,
  ): Window {
    let window = map.get(userId);
    if (!window) {
      // Evict before inserting, so the map cannot grow past the bound.
      if (map.size >= this.maxUsers) this.evictOne(map);
      window = { stamps: [], touchedAt: now };
      map.set(userId, window);
    }
    this.prune(window, now, windowMs);
    window.touchedAt = now;
    return window;
  }

  /** Drop timestamps that have fallen out of the window. */
  private prune(window: Window, now: number, windowMs: number): void {
    const cutoff = now - windowMs;
    // Timestamps are appended in order, so a prefix can be dropped outright.
    let drop = 0;
    while (drop < window.stamps.length && window.stamps[drop]! <= cutoff) drop++;
    if (drop > 0) window.stamps.splice(0, drop);
  }

  /** Remove the least recently active user. */
  private evictOne(map: Map<string, Window>): void {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, window] of map) {
      if (window.touchedAt < oldestAt) {
        oldestAt = window.touchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
}

/** A limiter with every rule disabled, for tests and development. */
export function unlimitedRateLimiter(): RateLimiter {
  return new RateLimiter({
    messages: { limit: 0, windowMs: 0 },
    toolCalls: { limit: 0, windowMs: 0 },
  });
}
