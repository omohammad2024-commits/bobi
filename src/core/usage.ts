/**
 * Usage accounting.
 *
 * The agent can spend real money: one user message may become several provider
 * calls, and a tool-using run sends far more tokens than a chat turn. Without a
 * counter the owner has no way to see what the bot costs or which user is
 * responsible.
 *
 * Only counts are stored — requests, tool calls, and token totals. No message
 * content, no prompts, no completions.
 *
 * Cost is an ESTIMATE and is labelled as one in the UI: prices change, and a
 * self-hosted or resold endpoint may not bill the way the default table assumes.
 */
import type { Storage, UsageRecord } from "../storage/storage";

/**
 * Indicative prices, US dollars per one million tokens.
 *
 * Deliberately a small table with a conservative (higher) default, so an
 * estimate errs toward "this costs more than you think" rather than the
 * opposite. A key that is not listed uses DEFAULT_PRICE.
 */
const PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  // Anthropic
  "claude-opus": { input: 15, output: 75 },
  "claude-sonnet": { input: 3, output: 15 },
  "claude-haiku": { input: 0.8, output: 4 },
  // OpenAI-style
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  // Google
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
};

/** Used when the model id is not recognised. */
const DEFAULT_PRICE = { input: 5, output: 20 };

export interface UsageSummary {
  day: string;
  /** This user's counters. */
  user: UsageRecord;
  /** Every user's counters for the day. */
  all: UsageRecord;
  /** The model the estimate was computed for. */
  model: string;
  /** Estimated cost in US dollars. */
  estimatedUsd: number;
  /** True when the model was not in the price table. */
  estimated: boolean;
}

export class UsageService {
  constructor(
    private readonly storage: Storage,
    private readonly today: () => string = () => new Date().toISOString().slice(0, 10),
  ) {}

  /**
   * Record one completed run.
   *
   * Called after the reply is sent, so a failed delivery still records the
   * spend that was already made.
   */
  record(run: {
    userId: string;
    requests: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
  }): void {
    try {
      this.storage.addUsage({
        userId: run.userId,
        day: this.today(),
        requests: run.requests,
        toolCalls: run.toolCalls,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
      });
    } catch {
      // Accounting must never fail a user's request. The counters are
      // diagnostic, not load-bearing.
    }
  }

  /** Today's summary for one user, plus the day's total. */
  summary(userId: string, model: string): UsageSummary {
    const day = this.today();
    let user: UsageRecord = {
      userId,
      day,
      requests: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    let all: UsageRecord = { ...user, userId: "*" };

    try {
      user = this.storage.usageFor(userId, day);
      all = this.storage.usageForDay(day);
    } catch {
      // A storage problem reports zeros rather than failing the panel.
    }

    const price = priceFor(model);
    const cost =
      (user.inputTokens / 1_000_000) * price.input +
      (user.outputTokens / 1_000_000) * price.output;

    return {
      day,
      user,
      all,
      model,
      estimatedUsd: cost,
      estimated: price === DEFAULT_PRICE,
    };
  }
}

/** Resolve a model id to a price, matching on a prefix. */
function priceFor(model: string): { input: number; output: number } {
  const id = model.toLowerCase();
  for (const [key, price] of Object.entries(PRICES)) {
    if (id.includes(key)) return price;
  }
  return DEFAULT_PRICE;
}

/** Format an estimated cost for display. */
const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

/** Format a USD cost with the right digits for the language. */
export function formatCost(usd: number, lang: "fa" | "en" = "fa"): string {
  const digits = (s: string): string =>
    lang === "en"
      ? s
      : s.replace(/\./g, "٫").replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)] ?? d);
  if (usd <= 0) return lang === "en" ? "$0" : "۰ دلار";
  if (usd < 0.01)
    return lang === "en" ? "less than $0.01" : `کمتر از ${digits("0.01")} دلار`;
  return lang === "en" ? `$${usd.toFixed(2)}` : `${digits(usd.toFixed(2))} دلار`;
}

/** Format a token count with thousands separators. */
export function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}
