import { afterEach, describe, expect, test } from "bun:test";
import {
  createCurrencyRateService,
  createCurrencyRatesTool,
  currencyRatesManifest,
  CURRENCY_RATES_NOTE,
  CURRENCY_RATES_PERMISSION,
  CURRENCY_RATES_URL,
  type CurrencyFetchFn,
  type CurrencyRateService,
} from "../src/tools/currency";
import {
  convertWithRates,
  setUnitConverterRateSourceResolver,
  unitConverterTool,
} from "../src/tools/unit_converter";
import { ToolError } from "../src/tools/errors";
import { validateManifest } from "../src/tools/validate_manifest";
import type { ToolContext } from "../src/tools/types";

const T0 = Date.parse("2026-10-21T00:00:00Z");

/** open.er-api.com/v6/latest/USD payload shape (trimmed fixture). */
const ER_API_FIXTURE = {
  result: "success",
  provider: "https://www.exchangerate-api.com",
  base_code: "USD",
  time_last_update_utc: "Wed, 21 Oct 2026 00:00:01 +0000",
  rates: {
    USD: 1,
    EUR: 0.92,
    GBP: 0.79,
    AED: 3.6725,
    TRY: 34.25,
    IRR: 42000,
    JPY: 149.5,
    // Invalid entries the parser must drop, never use:
    BADZERO: 0,
    BADNEG: -5,
    BADSTR: "nope",
  },
};

function okFetch(payload: unknown, counter?: { calls: number }): CurrencyFetchFn {
  return async (url: string) => {
    expect(url).toBe(CURRENCY_RATES_URL);
    if (counter) counter.calls += 1;
    return { ok: true, status: 200, json: async () => payload };
  };
}

function failingFetch(): CurrencyFetchFn {
  return async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  });
}

function throwingFetch(): CurrencyFetchFn {
  return async () => {
    throw new Error("network is a lie in tests");
  };
}

function makeService(
  fetchFn: CurrencyFetchFn,
  opts?: { now?: () => number; ttlMs?: number },
): CurrencyRateService {
  return createCurrencyRateService({
    fetchFn,
    now: opts?.now ?? (() => T0),
    ...(opts?.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  });
}

function ctx(): ToolContext {
  return {
    clock: () => new Date(T0),
    actor: { userId: "user-1", permissions: [CURRENCY_RATES_PERMISSION] },
    signal: new AbortController().signal,
  };
}

async function expectToolRunError(
  promise: Promise<unknown>,
): Promise<ToolError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return err as ToolError;
  }
  throw new Error("expected the tool run to throw a ToolError");
}

// ---------- rate service ----------

describe("currency rate service — cache reads", () => {
  test("ratePerUsd is undefined before any fetch, except usd = 1", () => {
    const service = makeService(okFetch(ER_API_FIXTURE));
    expect(service.ratePerUsd("usd")).toBe(1);
    expect(service.ratePerUsd("eur")).toBeUndefined();
    expect(service.ratePerUsd("irr")).toBeUndefined();
    expect(service.hasRates()).toBe(false);
    expect(service.fetchedAtMs()).toBeUndefined();
  });

  test("after refresh, ratePerUsd reads usd/eur/irr from cache", async () => {
    const service = makeService(okFetch(ER_API_FIXTURE));
    await service.refreshIfStale();
    expect(service.ratePerUsd("usd")).toBe(1);
    expect(service.ratePerUsd("eur")).toBe(0.92);
    expect(service.ratePerUsd("irr")).toBe(42000);
    expect(service.ratePerUsd("EUR")).toBe(0.92); // case-insensitive
    expect(service.hasRates()).toBe(true);
    expect(service.fetchedAtMs()).toBe(T0);
    expect(service.source).toBe("open.er-api.com");
  });

  test("unknown unit stays undefined — a rate is never invented", async () => {
    const service = makeService(okFetch(ER_API_FIXTURE));
    await service.refreshIfStale();
    expect(service.ratePerUsd("xxx")).toBeUndefined();
    expect(service.ratePerUsd("irt")).toBeUndefined(); // source has no IRT
  });

  test("invalid payload entries are dropped by the defensive parser", async () => {
    const service = makeService(okFetch(ER_API_FIXTURE));
    await service.refreshIfStale();
    expect(service.ratePerUsd("badzero")).toBeUndefined();
    expect(service.ratePerUsd("badneg")).toBeUndefined();
    expect(service.ratePerUsd("badstr")).toBeUndefined();
  });

  test("a fresh cache is not refetched; a stale one is", async () => {
    const counter = { calls: 0 };
    let now = T0;
    const service = makeService(okFetch(ER_API_FIXTURE, counter), {
      now: () => now,
      ttlMs: 60_000,
    });
    await service.refreshIfStale();
    await service.refreshIfStale();
    expect(counter.calls).toBe(1);
    now = T0 + 59_999;
    await service.refreshIfStale();
    expect(counter.calls).toBe(1);
    now = T0 + 60_000;
    await service.refreshIfStale();
    expect(counter.calls).toBe(2);
  });
});

describe("currency rate service — failure honesty", () => {
  test("HTTP failure: no throw, empty cache, failure recorded", async () => {
    const service = makeService(failingFetch());
    await service.refreshIfStale(); // must not throw
    expect(service.hasRates()).toBe(false);
    expect(service.ratePerUsd("eur")).toBeUndefined();
    expect(service.fetchedAtMs()).toBeUndefined();
    expect(service.lastFailureAtMs()).toBe(T0);
  });

  test("thrown fetch error: swallowed, old cache kept", async () => {
    let fail = false;
    let now = T0;
    const fetchFn: CurrencyFetchFn = async () => {
      if (fail) throw new Error("boom");
      return { ok: true, status: 200, json: async () => ER_API_FIXTURE };
    };
    const service = makeService(fetchFn, { now: () => now, ttlMs: 1000 });
    await service.refreshIfStale();
    expect(service.ratePerUsd("eur")).toBe(0.92);
    fail = true;
    now = T0 + 5000; // past TTL → refresh attempted and fails
    await service.refreshIfStale();
    expect(service.ratePerUsd("eur")).toBe(0.92); // old cache survives
    expect(service.fetchedAtMs()).toBe(T0);
    expect(service.lastFailureAtMs()).toBe(T0 + 5000);
  });

  test("garbage payload shape counts as failure, not rates", async () => {
    const service = makeService(okFetch({ result: "error", rates: null }));
    await service.refreshIfStale();
    expect(service.hasRates()).toBe(false);
    expect(service.lastFailureAtMs()).toBe(T0);
  });
});

// ---------- the currency_rates tool ----------

describe("currency_rates tool", () => {
  test("output shape: base, rates, source, fetchedAt, note", async () => {
    const service = makeService(okFetch(ER_API_FIXTURE));
    const tool = createCurrencyRatesTool({ service });
    const out = await tool.run({ targets: ["eur", "gbp"] }, ctx());
    expect(out.base).toBe("usd");
    expect(out.rates).toEqual({ eur: 0.92, gbp: 0.79 });
    expect(out.source).toBe("open.er-api.com");
    expect(out.fetchedAt).toBe(new Date(T0).toISOString());
    expect(out.note).toBe(CURRENCY_RATES_NOTE);
    expect(out.converted).toBeUndefined();
  });

  test("the note always carries the official-vs-market rial warning", async () => {
    const service = makeService(okFetch(ER_API_FIXTURE));
    const tool = createCurrencyRatesTool({ service });
    const out = await tool.run({ targets: ["irr"] }, ctx());
    expect(out.rates["irr"]).toBe(42000);
    expect(out.note).toContain("official reference rate");
    expect(out.note).toContain("not the open-market rate");
  });

  test("irt (toman) is derived through the fixed IRR pair", async () => {
    const service = makeService(okFetch(ER_API_FIXTURE));
    const tool = createCurrencyRatesTool({ service });
    const out = await tool.run({ targets: ["irt"] }, ctx());
    expect(out.rates["irt"]).toBeCloseTo(4200, 9); // 42000 IRR / 10
  });

  test("non-usd base re-expresses rates against the base", async () => {
    const service = makeService(okFetch(ER_API_FIXTURE));
    const tool = createCurrencyRatesTool({ service });
    const out = await tool.run({ from: "eur", targets: ["usd", "gbp"] }, ctx());
    expect(out.base).toBe("eur");
    expect(out.rates["usd"]).toBeCloseTo(1 / 0.92, 9);
    expect(out.rates["gbp"]).toBeCloseTo(0.79 / 0.92, 9);
  });

  test("amount conversion equals convertWithRates with the same service", async () => {
    const service = makeService(okFetch(ER_API_FIXTURE));
    const tool = createCurrencyRatesTool({ service });
    const out = await tool.run(
      { from: "usd", targets: ["eur", "irr", "irt"], amount: 250 },
      ctx(),
    );
    expect(out.converted).toBeDefined();
    for (const target of ["eur", "irr", "irt"] as const) {
      expect(out.converted![target]).toBeCloseTo(
        convertWithRates(250, "usd", target, service),
        9,
      );
    }
    expect(out.converted!["eur"]).toBeCloseTo(230, 9);
    expect(out.converted!["irr"]).toBeCloseTo(10_500_000, 6);
  });

  test("unknown target fails with not_found naming the unit", async () => {
    const service = makeService(okFetch(ER_API_FIXTURE));
    const tool = createCurrencyRatesTool({ service });
    const err = await expectToolRunError(
      tool.run({ targets: ["eur", "zzz"] }, ctx()),
    );
    expect(err.kind).toBe("not_found");
    expect(err.message).toContain("zzz");
  });

  test("fetch failure with empty cache is the honest disabled error", async () => {
    const service = makeService(throwingFetch());
    const tool = createCurrencyRatesTool({ service });
    const err = await expectToolRunError(tool.run({ targets: ["eur"] }, ctx()));
    expect(err.kind).toBe("disabled");
    expect(err.message).toBe("Currency rates are not available right now.");
  });

  test("empty targets are invalid input", async () => {
    const service = makeService(okFetch(ER_API_FIXTURE));
    const tool = createCurrencyRatesTool({ service });
    const err = await expectToolRunError(tool.run({ targets: [] }, ctx()));
    expect(err.kind).toBe("invalid_input");
  });

  test("tool identity: id, permission, not ownerOnly, desk card valid", () => {
    const service = makeService(okFetch(ER_API_FIXTURE));
    const tool = createCurrencyRatesTool({ service });
    expect(tool.name).toBe("currency_rates");
    expect(tool.permission.requires).toEqual([CURRENCY_RATES_PERMISSION]);
    expect(CURRENCY_RATES_PERMISSION).toBe("tools:currency_rates");
    expect(tool.ownerOnly).toBeUndefined();
    expect(tool.manifest).toBe(currencyRatesManifest);
    expect(currencyRatesManifest.id).toBe("currency_rates");
    expect(currencyRatesManifest.category).toBe("utils");
    expect(currencyRatesManifest.latencyTier).toBe("seconds");
    expect(currencyRatesManifest.costTier).toBe("free");
    expect(validateManifest(currencyRatesManifest)).toEqual([]);
    const confusables = currencyRatesManifest.confusableWith.map((c) => c.tool);
    expect(confusables).toContain("unit_converter");
    expect(confusables).toContain("web_search");
  });
});

// ---------- unit_converter resolver wiring ----------

describe("unit_converter — rate source resolver wiring", () => {
  afterEach(() => {
    setUnitConverterRateSourceResolver(undefined);
  });

  test("with the resolver set, eur→usd converts through the static tool", async () => {
    const service = makeService(okFetch(ER_API_FIXTURE));
    await service.refreshIfStale();
    setUnitConverterRateSourceResolver(() => service);

    const out = await unitConverterTool.run(
      { value: 92, from: "eur", to: "usd" },
      {
        clock: () => new Date(T0),
        actor: { userId: "user-1", permissions: ["tools:unit_converter"] },
        signal: new AbortController().signal,
      },
    );
    expect(out.category).toBe("currency");
    expect(out.result).toBeCloseTo(100, 9); // 92 EUR / 0.92 = 100 USD
  });

  test("with the resolver unset, the honest not-configured error is preserved", async () => {
    setUnitConverterRateSourceResolver(undefined);
    const err = await expectToolRunError(
      unitConverterTool.run(
        { value: 100, from: "usd", to: "eur" },
        {
          clock: () => new Date(T0),
          actor: { userId: "user-1", permissions: ["tools:unit_converter"] },
          signal: new AbortController().signal,
        },
      ),
    );
    expect(err.kind).toBe("invalid_input");
    expect(err.message).toBe(
      "Currency conversion needs exchange rates, which are not configured yet.",
    );
  });

  test("resolver returning undefined behaves exactly like no resolver", async () => {
    setUnitConverterRateSourceResolver(() => undefined);
    const err = await expectToolRunError(
      unitConverterTool.run(
        { value: 100, from: "usd", to: "eur" },
        {
          clock: () => new Date(T0),
          actor: { userId: "user-1", permissions: ["tools:unit_converter"] },
          signal: new AbortController().signal,
        },
      ),
    );
    expect(err.kind).toBe("invalid_input");
    expect(err.message).toContain("not configured");
  });

  test("non-currency conversions are untouched by the resolver", async () => {
    const service = makeService(okFetch(ER_API_FIXTURE));
    await service.refreshIfStale();
    setUnitConverterRateSourceResolver(() => service);
    const out = await unitConverterTool.run(
      { value: 1, from: "km", to: "m" },
      {
        clock: () => new Date(T0),
        actor: { userId: "user-1", permissions: ["tools:unit_converter"] },
        signal: new AbortController().signal,
      },
    );
    expect(out.result).toBe(1000);
    expect(out.category).toBe("length");
  });
});
