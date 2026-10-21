/**
 * Per-run usage and cost tracking (Hermes: agent/usage_pricing.py, credits_tracker.py).
 *
 * This is the finer-grained companion to src/core/usage.ts: that module keeps
 * daily counters (requests, tool calls, token totals), while UsageTracker
 * records every completed provider attempt — which provider and model
 * answered, and how many tokens it spent — in the `usage_ledger` table.
 *
 * RULES:
 *  - Recording must never fail a turn. `record()` wraps everything in
 *    try/catch and logs-and-continues; it is an observer, never load-bearing.
 *  - The ledger is metadata, not content: user/provider/model ids and token
 *    counts only. It NEVER stores prompts or completions.
 *  - Cost estimates are APPROXIMATE — the price table is a hint, not a bill.
 *    Prices change, and self-hosted or resold endpoints may bill differently.
 *    Callers that show a number to a human must say it is an estimate.
 *  - All Persian-facing strings live in the tool (usage_report), not here.
 */
import type { TokenUsage } from "./provider";
import type { Storage } from "../storage/storage";

/**
 * Indicative prices, US dollars per one million tokens.
 *
 * APPROXIMATE: public list prices at the time of writing, matched on a model
 * id substring. They change without notice and do not apply to every
 * endpoint (resold proxies, enterprise tiers, cached/batched variants).
 * Treat the estimate as "roughly this order of cost", never as a bill.
 */
const PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  // Anthropic
  "claude-opus": { input: 15, output: 75 },
  "claude-sonnet": { input: 3, output: 15 },
  "claude-haiku": { input: 0.8, output: 4 },
  // OpenAI-style
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "o1": { input: 15, output: 60 },
  // Google
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
};

/** Conservative fallback when the model id is not recognised. */
const DEFAULT_PRICE = { input: 5, output: 20 };

/** One completed provider attempt to record. */
export interface UsageRun {
  userId: string;
  conversationId: number;
  providerId: number;
  modelId: string;
  usage: TokenUsage;
  /** unix ms — when the attempt completed. */
  at: number;
}

/** Aggregate token totals over a window. */
export interface UsageAggregate {
  inputTokens: number;
  outputTokens: number;
  /** Number of recorded attempts in the window. */
  runs: number;
  /** Approximate cost in US dollars (APPROXIMATE — see PRICES). */
  estimatedUsd: number;
  /** True when at least one model in the window was not in the price table. */
  estimated: boolean;
}

/** Resolve a model id to a price, matching on a substring. */
export function priceFor(modelId: string): {
  input: number;
  output: number;
  /** True when the id matched no table entry (fell back to DEFAULT_PRICE). */
  fallback: boolean;
} {
  const id = modelId.toLowerCase();
  // Longest key first: "gpt-4o" is a substring of "gpt-4o-mini", so a naive
  // scan would price the mini at the full rate. Matching the most specific
  // key avoids that silent overestimate.
  const keys = Object.keys(PRICES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (id.includes(key)) {
      return { ...PRICES[key]!, fallback: false };
    }
  }
  return { ...DEFAULT_PRICE, fallback: true };
}

/**
 * Approximate cost in US dollars for the given token counts on a model.
 *
 * APPROXIMATE — the price table is a hint, not a bill. The second return
 * value is true when the model was not in the table, so callers can pass the
 * caveat through to the human reading the number.
 */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  modelId: string,
): { usd: number; estimated: boolean } {
  const price = priceFor(modelId);
  const usd =
    (Math.max(0, inputTokens) / 1_000_000) * price.input +
    (Math.max(0, outputTokens) / 1_000_000) * price.output;
  return { usd, estimated: price.fallback };
}

/** One day's usage totals (owner view, all users). */
export interface DailyUsage {
  /** Local calendar date, "YYYY-MM-DD" (server-local days). */
  date: string;
  /** unix ms of the day's start, server-local. */
  dayStartMs: number;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  /** Approximate cost in US dollars (APPROXIMATE — see PRICES). */
  estimatedUsd: number;
}

/** One provider's usage totals in a window (owner view, all users). */
export interface ProviderUsage {
  providerId: number;
  /** Provider label from ai_providers; "Removed or unknown" when the row's provider is gone. */
  providerName: string;
  runs: number;
  /**
   * null: the usage ledger records completed attempts only — failure counts
   * are not captured, so a success rate cannot be derived from it.
   */
  successRate: number | null;
  /**
   * null: the usage ledger has no per-attempt latency column, so average
   * latency cannot be derived from it.
   */
  avgLatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  /** Approximate cost in US dollars (APPROXIMATE — see PRICES). */
  estimatedUsd: number;
}

/** Per-model latency percentiles. */
export interface ModelLatency {
  modelId: string;
  runs: number;
  /** p50/p95/max in ms. null when latency is not tracked (usage_ledger has no latency column). */
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 7;
  return Math.min(Math.max(Math.floor(days), 1), 90);
}

/** Server-local midnight (00:00) of the day containing `atMs`. */
function dayStartLocal(atMs: number): number {
  const d = new Date(atMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "YYYY-MM-DD" for a server-local day start. */
function dayLabelLocal(dayStartMs: number): string {
  const d = new Date(dayStartMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Daily usage breakdown for the last `days` days (owner view, all users),
 * oldest day first.
 *
 * The usage_ledger is append-only (no deletes), so a day's totals are the
 * difference between "everything since day start" and "everything since the
 * next day start". Blended cost uses the fallback price, the same honest
 * estimate as totalsAll().
 */
export function getDailyBreakdown(storage: Storage, days: number): DailyUsage[] {
  const n = clampDays(days);
  const todayStart = dayStartLocal(Date.now());
  const out: DailyUsage[] = [];
  try {
    for (let i = n - 1; i >= 0; i--) {
      const start = todayStart - i * DAY_MS;
      const end = start + DAY_MS;
      const t0 = storage.usage.usageTotalsAll(start);
      const t1 = storage.usage.usageTotalsAll(end);
      const inputTokens = Math.max(0, t0.inputTokens - t1.inputTokens);
      const outputTokens = Math.max(0, t0.outputTokens - t1.outputTokens);
      const runs = Math.max(0, t0.runs - t1.runs);
      const { usd } = estimateCost(inputTokens, outputTokens, "__unknown__");
      out.push({
        date: dayLabelLocal(start),
        dayStartMs: start,
        runs,
        inputTokens,
        outputTokens,
        estimatedUsd: usd,
      });
    }
  } catch {
    // Diagnostic-only data: a storage hiccup yields a partial/empty list,
    // never an exception to the API layer.
    return out;
  }
  return out;
}

/**
 * Per-provider usage totals for the last `days` days (owner view, all users),
 * most runs first. Model rows are mapped to providers via ai_models/ai_providers;
 * ledger rows whose model no longer maps to a provider land in an "unknown" bucket.
 *
 * successRate and avgLatencyMs are null: the usage ledger captures completed
 * attempts only — it records neither failures nor per-attempt latency.
 */
export function getByProvider(storage: Storage, days: number): ProviderUsage[] {
  const n = clampDays(days);
  const sinceMs = Date.now() - n * DAY_MS;
  try {
    const modelToProvider = new Map<string, { id: number; label: string }>();
    for (const p of storage.providers.listProviders()) {
      for (const m of storage.providers.listModels(p.id)) {
        if (!modelToProvider.has(m.modelId)) {
          modelToProvider.set(m.modelId, { id: p.id, label: p.label });
        }
      }
    }
    const agg = new Map<number, ProviderUsage>();
    for (const m of storage.usage.usageByModelAll(sinceMs)) {
      const prov = modelToProvider.get(m.modelId);
      const id = prov?.id ?? 0;
      const name = prov?.label ?? "Removed or unknown";
      let row = agg.get(id);
      if (!row) {
        row = {
          providerId: id,
          providerName: name,
          runs: 0,
          successRate: null,
          avgLatencyMs: null,
          inputTokens: 0,
          outputTokens: 0,
          estimatedUsd: 0,
        };
        agg.set(id, row);
      }
      row.runs += m.runs;
      row.inputTokens += m.inputTokens;
      row.outputTokens += m.outputTokens;
      row.estimatedUsd += estimateCost(m.inputTokens, m.outputTokens, m.modelId).usd;
    }
    return [...agg.values()].sort(
      (a, b) => b.runs - a.runs || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    );
  } catch {
    return [];
  }
}

/**
 * Per-model latency percentiles for the last `days` days (owner view).
 *
 * The usage ledger records no per-attempt latency, so this currently reports
 * `{ tracked: false }` with per-model run counts and null percentiles. The
 * contract is forward-compatible: when per-attempt timing is recorded, the
 * percentile fields get populated and `tracked` flips to true.
 */
export function getLatencyStats(
  storage: Storage,
  days: number,
): { tracked: boolean; perModel: ModelLatency[] } {
  const n = clampDays(days);
  const sinceMs = Date.now() - n * DAY_MS;
  try {
    const perModel = storage.usage.usageByModelAll(sinceMs).map((m) => ({
      modelId: m.modelId,
      runs: m.runs,
      p50Ms: null as number | null,
      p95Ms: null as number | null,
      maxMs: null as number | null,
    }));
    return { tracked: false, perModel };
  } catch {
    return { tracked: false, perModel: [] };
  }
}

export class UsageTracker {
  constructor(
    private readonly storage: Storage,
    private readonly log: (message: string, fields?: Record<string, unknown>) => void = () => {},
  ) {}

  /**
   * Record one completed attempt.
   *
   * Never throws: a storage hiccup is logged and swallowed, because usage
   * accounting must never fail the user's turn. Tokens default to 0 when the
   * provider did not report them (some adapters only count what they see).
   */
  record(run: UsageRun): void {
    try {
      this.storage.usage.recordUsage({
        userId: run.userId,
        conversationId: run.conversationId,
        providerId: run.providerId,
        modelId: run.modelId,
        inputTokens: Math.max(0, Math.round(run.usage.inputTokens ?? 0)),
        outputTokens: Math.max(0, Math.round(run.usage.outputTokens ?? 0)),
        atMs: run.at,
      });
    } catch (err) {
      // Diagnostic data only — a failed write is noise, not a broken turn.
      this.log("usage ledger record failed", {
        model: run.modelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * One user's totals in a window (across all models), with approximate cost.
   * sinceMs is inclusive; omit it for all-time.
   */
  totals(userId: string, sinceMs?: number): UsageAggregate {
    try {
      const t = this.storage.usage.usageTotals(userId, sinceMs);
      // The per-model prices differ, so a blended estimate uses the DEFAULT
      // fallback price: honest about being an estimate, never precision
      // theatre. usage_report refines per model where it matters.
      const { usd } = estimateCost(t.inputTokens, t.outputTokens, "__unknown__");
      return {
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        runs: t.runs,
        estimatedUsd: usd,
        estimated: true,
      };
    } catch (err) {
      this.log("usage totals failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { inputTokens: 0, outputTokens: 0, runs: 0, estimatedUsd: 0, estimated: true };
    }
  }

  /**
   * One user's totals broken down per model in a window, most-used first,
   * each with its own approximate cost. sinceMs is inclusive; omit for all-time.
   */
  byModel(
    userId: string,
    sinceMs?: number,
  ): (UsageAggregate & { modelId: string })[] {
    try {
      return this.storage.usage.usageByModel(userId, sinceMs).map((m) => {
        const { usd, estimated } = estimateCost(m.inputTokens, m.outputTokens, m.modelId);
        return {
          modelId: m.modelId,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          runs: m.runs,
          estimatedUsd: usd,
          estimated,
        };
      });
    } catch (err) {
      this.log("usage byModel failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * All-users totals in a window (owner view), with approximate cost.
   * sinceMs is inclusive; omit it for all-time.
   */
  totalsAll(sinceMs?: number): UsageAggregate {
    try {
      const t = this.storage.usage.usageTotalsAll(sinceMs);
      const { usd } = estimateCost(t.inputTokens, t.outputTokens, "__unknown__");
      return {
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        runs: t.runs,
        estimatedUsd: usd,
        estimated: true,
      };
    } catch (err) {
      this.log("usage totalsAll failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { inputTokens: 0, outputTokens: 0, runs: 0, estimatedUsd: 0, estimated: true };
    }
  }

  /**
   * All-users per-model totals in a window (owner view), most-used first,
   * each with its own approximate cost. sinceMs is inclusive; omit for all-time.
   */
  byModelAll(
    sinceMs?: number,
  ): (UsageAggregate & { modelId: string })[] {
    try {
      return this.storage.usage.usageByModelAll(sinceMs).map((m) => {
        const { usd, estimated } = estimateCost(m.inputTokens, m.outputTokens, m.modelId);
        return {
          modelId: m.modelId,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          runs: m.runs,
          estimatedUsd: usd,
          estimated,
        };
      });
    } catch (err) {
      this.log("usage byModelAll failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}
