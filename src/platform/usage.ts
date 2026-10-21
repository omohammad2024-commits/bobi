/**
 * UsageFacade — the platform's usage surface: presents BOTH usage services
 * under one surface, distinctly.
 *
 * ⚠️ The two services are NOT merged or unified. UsageService (core/usage)
 * and UsageTracker (ai/usage) keep their own implementations — including
 * their DIFFERENT priceFor matching semantics (core = insertion order,
 * ai = longest-key-first). Unifying them would be a behavior change and is
 * explicitly out of scope; this facade only presents both.
 */
import type { UsageService, UsageSummary } from "../core/usage";
import type { UsageTracker } from "../ai/usage";

export class UsageFacade {
  constructor(
    /** Per-user daily counters (src/core/usage). */
    readonly service: UsageService,
    /** Per-run token/cost ledger (src/ai/usage). */
    readonly tracker: UsageTracker,
  ) {}

  /** The core UsageService handle (kept distinct from the tracker). */
  get coreHandle(): UsageService {
    return this.service;
  }

  /** The ai UsageTracker handle (kept distinct from the core service). */
  get trackerHandle(): UsageTracker {
    return this.tracker;
  }

  /** Delegates to UsageService.summary (core priceFor semantics). */
  coreSummary(userId: string, model: string): UsageSummary {
    return this.service.summary(userId, model);
  }

  /** Delegates to UsageService.record (core daily counters). */
  coreRecord(run: {
    userId: string;
    requests: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
  }): void {
    this.service.record(run);
  }
}
