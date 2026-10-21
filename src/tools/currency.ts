/**
 * currency_rates — current reference exchange rates from open.er-api.com.
 *
 * The backing source is https://open.er-api.com/v6/latest/USD: keyless,
 * no signup, returns a `rates` map of units per 1 USD. Rates are cached
 * in memory for a TTL (default 1h); `ratePerUsd` is a synchronous cache
 * read and `refreshIfStale` is the only network path.
 *
 * Honesty rules:
 * - A rate is NEVER invented. An unknown unit reads `undefined`, and the
 *   tool fails with a named `not_found` instead of guessing.
 * - A failed refresh keeps the previous cache (possibly empty) and is
 *   recorded, never thrown raw into the tool path. With no rates at all
 *   the tool reports itself unavailable ("disabled").
 * - The IRR figure from this source is the OFFICIAL reference rate, not
 *   the Iranian free-market (open-market) rate, which is materially
 *   different. The tool's output note says so on every run.
 *
 * This module also owns the shared singleton rate service: bootstrap
 * wires `sharedCurrencyRateSource()` into unit_converter via
 * `setUnitConverterRateSourceResolver`, so amount conversions and rate
 * lookups read the same cache.
 */
import { ToolError } from "./errors";
import type { Tool, ToolContext } from "./types";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";
import { convertWithRates, type CurrencyRateSource } from "./unit_converter";

export const CURRENCY_RATES_PERMISSION = "tools:currency_rates";

/** Backing endpoint: units per 1 USD, keyless. */
export const CURRENCY_RATES_URL = "https://open.er-api.com/v6/latest/USD";

/** Source name reported in tool output. */
export const CURRENCY_RATES_SOURCE = "open.er-api.com";

/** Default cache lifetime: rates are reference data, an hour is fresh enough. */
export const DEFAULT_RATES_TTL_MS = 60 * 60 * 1000;

/**
 * The note attached to every successful run. It must always carry the
 * official-vs-market warning for the rial: the source's IRR figure is a
 * reference rate and does not reflect what rials actually trade for.
 */
export const CURRENCY_RATES_NOTE =
  "Reference rates (open.er-api.com); the Iranian rial figure is the official reference rate, not the open-market rate.";

/** Minimal fetch shape — the global fetch satisfies this structurally. */
export interface CurrencyFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type CurrencyFetchFn = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<CurrencyFetchResponse>;

/**
 * Hard cap on one rates fetch. Without it a hung response would wedge
 * the shared in-flight refresh forever: the promise never settles, so
 * every later `refreshIfStale` awaits the same dead fetch.
 */
export const CURRENCY_FETCH_TIMEOUT_MS = 10_000;

export interface CurrencyRateServiceDeps {
  /** Test seam: replaces the network fetch. Never model-controlled. */
  fetchFn?: CurrencyFetchFn;
  /** Test seam: clock in epoch ms. Defaults to Date.now. */
  now?: () => number;
  /** Cache lifetime before a refresh is attempted. Default 1h. */
  ttlMs?: number;
  /** Per-fetch timeout in ms. Default CURRENCY_FETCH_TIMEOUT_MS. */
  fetchTimeoutMs?: number;
}

/**
 * A caching exchange-rate service implementing the unit_converter seam.
 *
 * `ratePerUsd` is synchronous and reads ONLY the cache — it never
 * triggers a fetch. Callers that can await call `refreshIfStale` first.
 */
export interface CurrencyRateService extends CurrencyRateSource {
  /** Fetch when the cache is empty or older than the TTL. Never throws. */
  refreshIfStale(): Promise<void>;
  /** Epoch ms of the last successful fetch; undefined when never fetched. */
  fetchedAtMs(): number | undefined;
  /** Epoch ms of the last failed refresh attempt; undefined when none failed. */
  lastFailureAtMs(): number | undefined;
  /** True when at least one usable rate is cached. */
  hasRates(): boolean;
  /** Source name, for output attribution. */
  readonly source: string;
}

export function createCurrencyRateService(
  deps: CurrencyRateServiceDeps = {},
): CurrencyRateService {
  const fetchFn: CurrencyFetchFn =
    deps.fetchFn ?? ((url: string, init?: { signal?: AbortSignal }) => fetch(url, init));
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? DEFAULT_RATES_TTL_MS;
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? CURRENCY_FETCH_TIMEOUT_MS;

  let cache: ReadonlyMap<string, number> | undefined;
  let fetchedAt: number | undefined;
  let lastFailureAt: number | undefined;
  let inFlight: Promise<void> | undefined;

  function ratePerUsd(unitRaw: string): number | undefined {
    const unit = unitRaw.trim().toLowerCase();
    if (unit === "usd") return 1;
    return cache?.get(unit);
  }

  async function refreshIfStale(): Promise<void> {
    if (
      cache !== undefined &&
      fetchedAt !== undefined &&
      now() - fetchedAt < ttlMs
    ) {
      return;
    }
    // Concurrent callers share one fetch instead of stampeding the source.
    if (inFlight !== undefined) return inFlight;
    inFlight = (async () => {
      try {
        // The abort timeout guarantees this promise settles even when
        // the source hangs: the catch records the failure and the
        // finally clears inFlight, so the next refresh retries cleanly.
        const res = await fetchFn(CURRENCY_RATES_URL, {
          signal: AbortSignal.timeout(fetchTimeoutMs),
        });
        if (!res.ok) {
          throw new Error(`rates fetch failed with status ${res.status}`);
        }
        const parsed = parseRatesPayload(await res.json());
        if (parsed === undefined) {
          throw new Error("rates payload had no usable rates");
        }
        cache = parsed;
        fetchedAt = now();
      } catch {
        // Keep the old cache (possibly empty) and record the failure.
        // The raw error never leaves this function: it may carry URLs
        // or transport internals that are not model/user-safe.
        lastFailureAt = now();
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  }

  return {
    source: CURRENCY_RATES_SOURCE,
    ratePerUsd,
    refreshIfStale,
    fetchedAtMs: () => fetchedAt,
    lastFailureAtMs: () => lastFailureAt,
    hasRates: () => cache !== undefined && cache.size > 0,
  };
}

/**
 * Validate the open.er-api payload shape and extract the rates map.
 *
 * Defensive on purpose: the payload is third-party data. Only finite,
 * positive numeric entries survive; keys are lowercased to the tool
 * layer's unit spelling. Returns undefined when nothing usable remains.
 */
function parseRatesPayload(payload: unknown): ReadonlyMap<string, number> | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const rec = payload as Record<string, unknown>;
  // The API marks failures with result: "error"; anything explicitly
  // not "success" is not trusted as a rates payload.
  const result = rec["result"];
  if (typeof result === "string" && result !== "success") return undefined;
  const rates = rec["rates"];
  if (typeof rates !== "object" || rates === null || Array.isArray(rates)) {
    return undefined;
  }
  const out = new Map<string, number>();
  for (const [key, value] of Object.entries(rates as Record<string, unknown>)) {
    const unit = key.trim().toLowerCase();
    if (unit.length === 0) continue;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      out.set(unit, value);
    }
  }
  return out.size > 0 ? out : undefined;
}

// ---------- shared singleton (wired into unit_converter by bootstrap) ----------

let sharedService: CurrencyRateService | undefined;

/** The process-wide rate service. One cache, shared by tool + converter. */
export function getSharedCurrencyRateService(): CurrencyRateService {
  sharedService ??= createCurrencyRateService();
  return sharedService;
}

/**
 * The singleton as a plain CurrencyRateSource — what bootstrap hands to
 * unit_converter's `setUnitConverterRateSourceResolver`.
 */
export function sharedCurrencyRateSource(): CurrencyRateSource {
  return getSharedCurrencyRateService();
}

// ---------- the tool ----------

export interface CurrencyRatesInput {
  /** Base currency code the rates are expressed against. Default "usd". */
  from?: string;
  /** Target currency codes, 1–10. */
  targets: string[];
  /** When present, amounts of `from` converted into each target. */
  amount?: number;
}

export interface CurrencyRatesOutput {
  /** Base currency code the rates are expressed against. */
  base: string;
  /** Units of each target per 1 unit of `base`. */
  rates: Record<string, number>;
  /** `amount` of `base` expressed in each target, when amount was given. */
  converted?: Record<string, number>;
  source: string;
  /** ISO timestamp of the fetch the rates came from. */
  fetchedAt: string;
  note: string;
}

export const currencyRatesManifest: ToolManifest = defineManifest({
  id: "currency_rates",
  version: "1.0.0",
  title: "Currency Rates",
  description:
    "Report current reference exchange rates from open.er-api.com (units per 1 USD, or per a chosen base), optionally converting an amount. The Iranian rial figure is the official reference rate, not the open-market rate.",
  purpose: "current exchange rates",
  useWhen: "rate or price in another currency asked",
  doNotUseWhen:
    "converting between non-currency units is unit_converter; general questions about money or news are web_search",
  confusableWith: [
    {
      tool: "unit_converter",
      difference: "unit_converter converts amounts between units; this reports current rates",
    },
    {
      tool: "web_search",
      difference: "this returns structured rates without a web search",
    },
  ],
  latencyTier: "seconds",
  outputSummary:
    "Rates for the requested currencies with source and fetch time; converted amounts when an amount was given.",
  category: "utils",
  triggers: {
    keywordPatterns: ["ارز", "دلار", "یورو", "نرخ ارز", "نرخ", "currency", "exchange rate"],
  },
  costTier: "free",
});

export function createCurrencyRatesTool(deps: {
  service: CurrencyRateService;
}): Tool<CurrencyRatesInput, CurrencyRatesOutput> {
  const { service } = deps;

  return {
    name: "currency_rates",
    manifest: currencyRatesManifest,
    description:
      "Report current reference exchange rates (units per 1 USD, or per a chosen base) and optionally convert an amount. The rial rate is the official reference rate, not the open-market rate.",
    enabled: true,
    permission: { requires: [CURRENCY_RATES_PERMISSION] },
    toolset: "utils",
    input: {
      fields: {
        from: {
          type: "string",
          description: "Base currency code (default usd).",
          maxLength: 8,
        },
        targets: {
          type: "array",
          required: true,
          description: "Currency codes to report rates for (1-10).",
          maxItems: 10,
          items: { type: "string", maxLength: 8 },
        },
        amount: {
          type: "number",
          description: "Optional amount of the base currency to also convert.",
        },
      },
    },

    async run(
      input: CurrencyRatesInput,
      _ctx: ToolContext,
    ): Promise<CurrencyRatesOutput> {
      const base = normalizeCode(input.from ?? "usd", "from");
      const targets = normalizeTargets(input.targets);
      if (
        input.amount !== undefined &&
        (typeof input.amount !== "number" || !Number.isFinite(input.amount))
      ) {
        throw new ToolError("invalid_input", "Amount must be a valid number.");
      }

      await service.refreshIfStale();

      const fetchedAtMs = service.fetchedAtMs();
      if (!service.hasRates() || fetchedAtMs === undefined) {
        // No rates at all: the fetch failed (or never produced data).
        // Fail honestly instead of fabricating numbers.
        throw new ToolError(
          "disabled",
          "Currency rates are not available right now.",
        );
      }

      const basePerUsd = perUsd(base, service);
      if (basePerUsd === undefined) {
        throw new ToolError(
          "not_found",
          `No exchange rate is available for '${base}'.`,
          { unit: base },
        );
      }

      const rates: Record<string, number> = {};
      for (const target of targets) {
        const targetPerUsd = perUsd(target, service);
        if (targetPerUsd === undefined) {
          throw new ToolError(
            "not_found",
            `No exchange rate is available for '${target}'.`,
            { unit: target },
          );
        }
        rates[target] = targetPerUsd / basePerUsd;
      }

      const out: CurrencyRatesOutput = {
        base,
        rates,
        source: service.source,
        fetchedAt: new Date(fetchedAtMs).toISOString(),
        note: CURRENCY_RATES_NOTE,
      };

      if (input.amount !== undefined) {
        // Conversion math goes through unit_converter's convertWithRates
        // with this service — never re-implemented here.
        const converted: Record<string, number> = {};
        for (const target of targets) {
          converted[target] = convertWithRates(
            input.amount,
            base,
            target,
            service,
          );
        }
        out.converted = converted;
      }

      return out;
    },
  };
}

/**
 * Units of `unit` per 1 USD, or undefined when unknown.
 *
 * The direct cache read covers every code the source publishes. IRR/IRT
 * are the exception: the source publishes IRR only, so IRT (toman) is
 * derived through unit_converter's fixed 10:1 pair via convertWithRates
 * — derivation lives there, not re-implemented here.
 */
function perUsd(unit: string, service: CurrencyRateService): number | undefined {
  const direct = service.ratePerUsd(unit);
  if (direct !== undefined && Number.isFinite(direct) && direct > 0) {
    return direct;
  }
  if (unit === "irr" || unit === "irt") {
    try {
      const derived = convertWithRates(1, "usd", unit, service);
      return Number.isFinite(derived) && derived > 0 ? derived : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Lowercase a currency code and reject anything non-alphanumeric up front. */
function normalizeCode(raw: string, field: string): string {
  const code = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (code.length === 0 || !/^[a-z0-9]+$/.test(code)) {
    throw new ToolError("invalid_input", `Invalid currency code for '${field}'.`, {
      field,
    });
  }
  return code;
}

/** Normalize, dedupe and bound the targets list (validator caps it first). */
function normalizeTargets(raw: string[]): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ToolError(
      "invalid_input",
      "At least one target currency is required.",
    );
  }
  if (raw.length > 10) {
    throw new ToolError(
      "invalid_input",
      "At most 10 target currencies are allowed.",
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const code = normalizeCode(item, "targets");
    if (!seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}
