import { beforeEach, describe, expect, test } from "bun:test";
import {
  convert,
  convertWithRates,
  setUnitConverterRateSourceResolver,
  SUPPORTED_UNITS,
  unitConverterManifest,
  unitConverterTool,
  type CurrencyRateSource,
} from "../src/tools/unit_converter";
import { ToolError } from "../src/tools/errors";
import type { ToolContext } from "../src/tools/types";

function ctx(): ToolContext {
  return {
    clock: () => new Date("2026-10-21T00:00:00Z"),
    actor: { userId: "user-1", permissions: ["tools:unit_converter"] },
    signal: new AbortController().signal,
  };
}

function expectToolError(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return err as ToolError;
  }
  throw new Error("expected function to throw a ToolError");
}

async function expectToolRunError(input: {
  value: number;
  from: string;
  to: string;
}): Promise<ToolError> {
  try {
    await unitConverterTool.run(input, ctx());
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return err as ToolError;
  }
  throw new Error("expected unit_converter tool to throw a ToolError");
}

/** Stub rate source: units per 1 USD. */
function stubRates(table: Record<string, number>): CurrencyRateSource {
  return { ratePerUsd: (unit: string) => table[unit] };
}

// ---------- pre-existing conversions (unchanged) ----------

describe("unit_converter — pre-existing categories", () => {
  test("length: km to mi", () => {
    expect(convert(1, "km", "mi")).toBeCloseTo(0.6213711922, 9);
  });

  test("mass: g to kg", () => {
    expect(convert(1000, "g", "kg")).toBe(1);
  });

  test("volume: gal to l and l to ml", () => {
    expect(convert(1, "gal", "l")).toBeCloseTo(3.785411784, 9);
    expect(convert(2.5, "l", "ml")).toBeCloseTo(2500, 6);
  });

  test("same unit is identity and cm to m works", () => {
    expect(convert(42, "cm", "cm")).toBe(42);
    expect(convert(2500, "cm", "m")).toBe(25);
  });

  test("temperature conversions", () => {
    expect(convert(100, "c", "f")).toBe(212);
    expect(convert(32, "f", "c")).toBe(0);
    expect(convert(0, "c", "k")).toBeCloseTo(273.15, 9);
    expect(convert(273.15, "k", "c")).toBeCloseTo(0, 9);
  });

  test("temperature below absolute zero is rejected", () => {
    const err = expectToolError(() => convert(-300, "c", "k"));
    expect(err.kind).toBe("invalid_input");
  });

  test("unknown unit is rejected as invalid unit", () => {
    for (const [from, to] of [
      ["xyz", "m"],
      ["m", "xyz"],
      ["parsec", "m"],
    ] as const) {
      const err = expectToolError(() => convert(1, from, to));
      expect(err.kind).toBe("invalid_input");
      expect(err.message).toBe("Invalid unit.");
    }
  });

  test("category mismatch is rejected (length vs mass)", () => {
    const err = expectToolError(() => convert(1, "km", "kg"));
    expect(err.kind).toBe("invalid_input");
    expect(err.message).toBe("Units are not from the same category.");
  });

  test("temperature vs non-temperature is rejected", () => {
    const err = expectToolError(() => convert(1, "c", "kg"));
    expect(err.kind).toBe("invalid_input");
  });

  test("convertWithRates without rates matches convert for non-currency", () => {
    expect(convertWithRates(1, "km", "m")).toBe(1000);
    expect(convertWithRates(100, "c", "f")).toBe(212);
  });
});

// ---------- currency: fixed IRR/IRT pair ----------

describe("unit_converter — currency fixed IRR/IRT pair", () => {
  test("SUPPORTED_UNITS gains every currency unit", () => {
    for (const unit of ["usd", "eur", "gbp", "aed", "try", "irr", "irt"]) {
      expect(SUPPORTED_UNITS).toContain(unit);
    }
    // Pre-existing units are still there.
    for (const unit of ["km", "kg", "l", "c", "f", "k"]) {
      expect(SUPPORTED_UNITS).toContain(unit);
    }
  });

  test("irr to irt is exact: 10000 irr = 1000 irt", () => {
    expect(convert(10000, "irr", "irt")).toBe(1000);
    expect(convertWithRates(10000, "irr", "irt")).toBe(1000);
  });

  test("irt to irr is exact: 1000 irt = 10000 irr", () => {
    expect(convert(1000, "irt", "irr")).toBe(10000);
    expect(convertWithRates(1000, "irt", "irr")).toBe(10000);
  });

  test("fixed pair works through the tool and reports the currency category", async () => {
    const out = await unitConverterTool.run(
      { value: 10000, from: "irr", to: "irt" },
      ctx(),
    );
    expect(out.result).toBe(1000);
    expect(out.category).toBe("currency");
    const back = await unitConverterTool.run(
      { value: 1000, from: "IRT", to: "IRR" },
      ctx(),
    );
    expect(back.result).toBe(10000);
    expect(back.category).toBe("currency");
  });

  test("fixed pair is not overridden by a supplied rate source", () => {
    const bogus = stubRates({ irr: 999, irt: 1 });
    expect(convertWithRates(10000, "irr", "irt", bogus)).toBe(1000);
  });
});

// ---------- currency: identity and the honest no-source failure ----------

describe("unit_converter — currency identity and missing rates", () => {
  // This block's premise is "no rate source wired". Since Phase 9 the
  // composition root installs a module-level resolver when a platform is
  // built, and other suites in the same process may have built one —
  // pin the resolver off before each test so the premise stays hermetic.
  // (Suites that exercise the wired path set their own resolver.)
  beforeEach(() => {
    setUnitConverterRateSourceResolver(undefined);
  });

  test("usd to usd is identity with no rate source", () => {
    expect(convert(42, "usd", "usd")).toBe(42);
    expect(convertWithRates(42, "usd", "usd")).toBe(42);
    expect(convert(7, "eur", "eur")).toBe(7);
    expect(convert(7, "irt", "irt")).toBe(7);
  });

  test("usd to eur without a source throws the honest named error", () => {
    const err = expectToolError(() => convert(100, "usd", "eur"));
    expect(err.kind).toBe("invalid_input");
    expect(err.message).toBe(
      "Currency conversion needs exchange rates, which are not configured yet.",
    );
  });

  test("convertWithRates without a source throws the same honest error", () => {
    const err = expectToolError(() => convertWithRates(100, "usd", "eur"));
    expect(err.kind).toBe("invalid_input");
    expect(err.message).toContain("exchange rates");
    expect(err.message).toContain("not configured");
  });

  test("the tool itself has no source wired: usd to eur fails honestly", async () => {
    const err = await expectToolRunError({ value: 100, from: "usd", to: "eur" });
    expect(err.kind).toBe("invalid_input");
    expect(err.message).toBe(
      "Currency conversion needs exchange rates, which are not configured yet.",
    );
  });

  test("other cross pairs without a source fail honestly too", () => {
    for (const [from, to] of [
      ["eur", "gbp"],
      ["usd", "irr"],
      ["irt", "usd"],
      ["aed", "try"],
    ] as const) {
      const err = expectToolError(() => convert(1, from, to));
      expect(err.kind).toBe("invalid_input");
      expect(err.message).toContain("exchange rates");
    }
  });
});

// ---------- currency: conversion via a stub rate source ----------

describe("unit_converter — currency via USD base with a rate source", () => {
  test("stub {usd:1, eur:0.9}: 100 usd = 90 eur", () => {
    const rates = stubRates({ usd: 1, eur: 0.9 });
    expect(convertWithRates(100, "usd", "eur", rates)).toBeCloseTo(90, 9);
  });

  test("stub converts back through the USD base: 90 eur = 100 usd", () => {
    const rates = stubRates({ usd: 1, eur: 0.9 });
    expect(convertWithRates(90, "eur", "usd", rates)).toBeCloseTo(100, 9);
  });

  test("stub converts a non-USD cross pair via USD", () => {
    const rates = stubRates({ usd: 1, eur: 0.9, gbp: 0.8 });
    // 90 eur = 100 usd = 80 gbp
    expect(convertWithRates(90, "eur", "gbp", rates)).toBeCloseTo(80, 9);
  });

  test("stub missing a unit gives the honest error, naming the unit", () => {
    const rates = stubRates({ usd: 1 });
    const err = expectToolError(() => convertWithRates(100, "usd", "eur", rates));
    expect(err.kind).toBe("invalid_input");
    expect(err.message).toContain("exchange rates");
    expect(err.message).toContain("not configured");
    expect(err.message).toContain("eur");
  });

  test("stub missing the source-side unit also gives the honest error", () => {
    const rates = stubRates({ eur: 0.9 });
    const err = expectToolError(() => convertWithRates(100, "usd", "eur", rates));
    expect(err.kind).toBe("invalid_input");
    expect(err.message).toContain("usd");
  });

  test("irt is derived from an irr-only source via the fixed relation", () => {
    const rates = stubRates({ usd: 1, irr: 500000 });
    // 1 USD = 500000 IRR = 50000 IRT
    expect(convertWithRates(1, "usd", "irt", rates)).toBeCloseTo(50000, 9);
    expect(convertWithRates(50000, "irt", "usd", rates)).toBeCloseTo(1, 9);
  });

  test("an invalid rate from a source is never used", () => {
    const rates = stubRates({ usd: 1, eur: 0 });
    const err = expectToolError(() => convertWithRates(100, "usd", "eur", rates));
    expect(err.kind).toBe("invalid_input");
    expect(err.message).toContain("exchange rates");
  });
});

// ---------- currency: category boundaries ----------

describe("unit_converter — currency category boundaries", () => {
  test("currency to length is a category mismatch", () => {
    for (const [from, to] of [
      ["usd", "m"],
      ["km", "eur"],
      ["irr", "cm"],
    ] as const) {
      const err = expectToolError(() => convert(1, from, to));
      expect(err.kind).toBe("invalid_input");
      expect(err.message).toBe("Units are not from the same category.");
    }
  });

  test("currency to mass / temperature is rejected", () => {
    expect(expectToolError(() => convert(1, "usd", "kg")).kind).toBe("invalid_input");
    expect(expectToolError(() => convert(1, "eur", "c")).kind).toBe("invalid_input");
  });

  test("currency mismatch also fails through the tool", async () => {
    const err = await expectToolRunError({ value: 1, from: "usd", to: "m" });
    expect(err.kind).toBe("invalid_input");
  });

  test("unknown currency-like units are invalid units, not rates errors", () => {
    for (const bad of ["btc", "eurr", "usdd"]) {
      const err = expectToolError(() => convert(1, bad, "usd"));
      expect(err.kind).toBe("invalid_input");
      expect(err.message).toBe("Invalid unit.");
      const err2 = expectToolError(() => convert(1, "usd", bad));
      expect(err2.message).toBe("Invalid unit.");
    }
  });
});

// ---------- desk card ----------

describe("unit_converter — desk card", () => {
  test("card stays unit_converter and tells the truth about currency", () => {
    expect(unitConverterManifest.id).toBe("unit_converter");
    expect(unitConverterTool.name).toBe("unit_converter");
    expect(unitConverterManifest.description.toLowerCase()).toContain("currency");
    expect(unitConverterManifest.description).toContain("IRR/IRT");
    expect(unitConverterManifest.doNotUseWhen).not.toContain("not supported");
    expect(unitConverterManifest.doNotUseWhen).toContain("unconfigured");
    expect(unitConverterManifest.doNotUseWhen).toContain(
      "currency rate source is connected",
    );
  });
});
