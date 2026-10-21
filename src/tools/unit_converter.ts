/**
 * unit_converter — length, mass, volume, temperature and currency.
 *
 * Correctness rules:
 * - Everything except temperature and currency converts through a canonical
 *   SI base (metres, kilograms, cubic metres), multiplied then divided. This
 *   keeps a single source of truth per unit and avoids transitive rounding
 *   drift.
 * - Temperature uses the exact formulas (°C↔°F↔K), because temperature is an
 *   affine scale, not a ratio scale — a factor-based conversion is wrong.
 * - Currency converts through a USD base when an exchange-rate source is
 *   supplied (see CurrencyRateSource / convertWithRates). The IRR↔IRT pair
 *   is a FIXED 10:1 relation (1 toman = 10 rial) and converts without any
 *   rate source. Every other currency pair needs a rate: with no source —
 *   or a source that does not know a unit — the conversion fails honestly
 *   instead of guessing a rate. Phase 9 wires the real source lazily:
 *   bootstrap registers tools/currency.ts's shared rate service through
 *   setUnitConverterRateSourceResolver below, and the tool's run resolves
 *   it per call — with no resolver set, behaviour is exactly as before.
 * - An unknown unit, or a unit from the wrong category, is rejected rather
 *   than guessed at.
 */
import { ToolError } from "./errors";
import type { Tool, ToolContext } from "./types";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";

export const UNIT_CONVERTER_PERMISSION = "tools:unit_converter";

type Category = "length" | "mass" | "volume" | "currency";

interface UnitDef {
  category: Category;
  factor: number;
}

/** Factor = how many base units one of this unit is worth. */
const BASE: Readonly<Record<string, UnitDef>> = {
  // length → metres
  nm: { category: "length", factor: 1e-9 },
  mm: { category: "length", factor: 1e-3 },
  cm: { category: "length", factor: 1e-2 },
  m: { category: "length", factor: 1 },
  km: { category: "length", factor: 1e3 },
  in: { category: "length", factor: 0.0254 },
  ft: { category: "length", factor: 0.3048 },
  yd: { category: "length", factor: 0.9144 },
  mi: { category: "length", factor: 1609.344 },

  // mass → kilograms
  mg: { category: "mass", factor: 1e-6 },
  g: { category: "mass", factor: 1e-3 },
  kg: { category: "mass", factor: 1 },
  t: { category: "mass", factor: 1e3 },
  oz: { category: "mass", factor: 0.028349523125 },
  lb: { category: "mass", factor: 0.45359237 },

  // volume → cubic metres
  ml: { category: "volume", factor: 1e-6 },
  l: { category: "volume", factor: 1e-3 },
  m3: { category: "volume", factor: 1 },
  cm3: { category: "volume", factor: 1e-6 },
  tsp: { category: "volume", factor: 4.92892159375e-6 },
  tbsp: { category: "volume", factor: 1.478676478125e-5 },
  gal: { category: "volume", factor: 0.003785411784 },
};

const TEMPERATURE_UNITS = ["c", "f", "k"] as const;
type TempUnit = (typeof TEMPERATURE_UNITS)[number];

export const CURRENCY_UNITS = [
  "usd",
  "eur",
  "gbp",
  "aed",
  "try",
  "irr",
  "irt",
] as const;
type CurrencyUnit = (typeof CURRENCY_UNITS)[number];

export const SUPPORTED_UNITS: readonly string[] = [
  ...Object.keys(BASE),
  ...TEMPERATURE_UNITS,
  ...CURRENCY_UNITS,
];

/**
 * Exchange-rate source seam for currency conversion (the real source
 * lives in tools/currency.ts; the tool below reaches it through the
 * lazy resolver registered by bootstrap — see below).
 *
 * Contract: `ratePerUsd(unit)` returns how many units of `unit` equal
 * 1 USD — e.g. ratePerUsd("eur") === 0.9 means 1 USD = 0.9 EUR, and
 * ratePerUsd("usd") should be 1. It returns `undefined` when the unit's
 * rate is unknown; it must never return a guessed rate. Implementations
 * may know IRR without knowing IRT (or vice versa): convertWithRates
 * derives the missing one through the fixed 10:1 IRR/IRT relation.
 */
export interface CurrencyRateSource {
  /** Units per 1 USD (or a documented base), for the named unit; undefined when unknown. */
  ratePerUsd(unit: string): number | undefined;
}

/**
 * Lazy rate-source resolver, following the codebase's holder pattern:
 * the statically-registered tool below cannot import tools/currency.ts
 * (that would be a cycle and a boot-order trap), so bootstrap registers
 * a resolver that hands back the shared rate service on demand. The
 * tool consults it per run; unset means no source, exactly as before.
 */
let rateSourceResolver: (() => CurrencyRateSource | undefined) | undefined;

/** Register (or clear, with undefined) the lazy currency rate source. */
export function setUnitConverterRateSourceResolver(
  fn: (() => CurrencyRateSource | undefined) | undefined,
): void {
  rateSourceResolver = fn;
}

export interface UnitInput {
  value: number;
  from: string;
  to: string;
}

export interface UnitOutput {
  value: number;
  from: string;
  to: string;
  result: number;
  category: Category | "temperature";
}

export const unitConverterManifest: ToolManifest = defineManifest({
  id: "unit_converter",
  version: "1.0.0",
  title: "Unit Converter",
  description:
    "Convert length, mass, volume, temperature and currency units. Currency: the IRR/IRT (rial/toman) fixed pair converts without rates; other currency pairs need the exchange-rate source.",
  purpose: "unit conversion",
  useWhen: "convert asked",
  doNotUseWhen:
    "general arithmetic is calculator; rate-dependent currency pairs report unconfigured until the currency rate source is connected",
  confusableWith: [
    { tool: "calculator", difference: "calculator evaluates expressions; this converts units in one category" },
  ],
  latencyTier: "instant",
  outputSummary: "The converted value with source/target units and category.",
  category: "utils",
  triggers: {
    keywordPatterns: [
      "تبدیل کن",
      "تبدیل",
      "convert",
      "چند کیلو",
      "چند گرم",
    ],
  },
  costTier: "free",
});

export const unitConverterTool: Tool<UnitInput, UnitOutput> = {
  name: "unit_converter",
  manifest: unitConverterManifest,
  description:
    "Convert length, mass, volume, temperature and currency units. Currency: the IRR/IRT (rial/toman) fixed pair converts without rates; other currency pairs need the exchange-rate source.",
  enabled: true,
  permission: { requires: [UNIT_CONVERTER_PERMISSION] },
  toolset: "utils",
  input: {
    fields: {
      value: { type: "number", required: true, description: "Input value." },
      from: { type: "string", required: true, description: "Source unit.", maxLength: 8 },
      to: { type: "string", required: true, description: "Target unit.", maxLength: 8 },
    },
  },

  async run(input: UnitInput, _ctx: ToolContext): Promise<UnitOutput> {
    const from = normalizeUnit(input.from);
    const to = normalizeUnit(input.to);
    // The rate source is resolved lazily per run (bootstrap wires the
    // shared currency service via setUnitConverterRateSourceResolver).
    // With no resolver set this passes undefined, so the fixed IRR/IRT
    // pair works and rate-dependent pairs fail honestly, as before
    // (see convertCurrency).
    const result = convertWithRates(
      input.value,
      from,
      to,
      rateSourceResolver?.(),
    );

    return { value: input.value, from, to, result, category: categoryOf(from) };
  },
};

/** Lowercase a unit id and reject anything non-alphanumeric up front. */
function normalizeUnit(unit: string): string {
  const u = unit.trim().toLowerCase();
  if (u.length === 0 || !/^[a-z0-9]+$/.test(u)) {
    throw new ToolError("invalid_input", "Invalid unit.", { unit });
  }
  return u;
}

/** Pure conversion with no rate source, exported so tests can check formulas directly. */
export function convert(value: number, from: string, to: string): number {
  return convertWithRates(value, from, to);
}

/**
 * Pure conversion with an optional currency rate source.
 *
 * Non-currency categories ignore `rates`. Currency conversions go
 * through the USD base (value → USD → target) using `rates`; the
 * IRR↔IRT fixed pair and same-unit conversions need no rate at all.
 * Phase 9 only has to pass a CurrencyRateSource here — the conversion
 * path itself does not change.
 */
export function convertWithRates(
  value: number,
  fromRaw: string,
  toRaw: string,
  rates?: CurrencyRateSource,
): number {
  const from = normalizeUnit(fromRaw);
  const to = normalizeUnit(toRaw);

  const fromCategory = categoryOrUndefined(from);
  const toCategory = categoryOrUndefined(to);
  if (!fromCategory || !toCategory) {
    throw new ToolError("invalid_input", "Invalid unit.", { from, to });
  }
  if (fromCategory !== toCategory) {
    if (fromCategory === "temperature" || toCategory === "temperature") {
      throw new ToolError(
        "invalid_input",
        "Temperature cannot be converted to other scales.",
        { from, to },
      );
    }
    throw new ToolError("invalid_input", "Units are not from the same category.", { from, to });
  }

  if (fromCategory === "temperature") {
    return convertTemperature(value, from as TempUnit, to as TempUnit);
  }
  if (fromCategory === "currency") {
    return convertCurrency(value, from as CurrencyUnit, to as CurrencyUnit, rates);
  }

  const src = BASE[from];
  const dst = BASE[to];
  if (!src || !dst) {
    throw new ToolError("invalid_input", "Invalid unit.", { from, to });
  }
  const result = (value * src.factor) / dst.factor;
  if (!Number.isFinite(result)) {
    throw new ToolError("invalid_input", "The result is not a valid number.");
  }
  return result;
}

function convertCurrency(
  value: number,
  from: CurrencyUnit,
  to: CurrencyUnit,
  rates?: CurrencyRateSource,
): number {
  // Same unit is identity — no rate needed.
  if (from === to) {
    if (!Number.isFinite(value)) {
      throw new ToolError("invalid_input", "The result is not a valid number.");
    }
    return value;
  }

  // Fixed pair: 1 toman (irt) = 10 rial (irr). No rate source needed,
  // and a supplied source never overrides this fixed relation.
  if (isIrrIrtPair(from, to)) {
    const result = from === "irr" ? value / 10 : value * 10;
    if (!Number.isFinite(result)) {
      throw new ToolError("invalid_input", "The result is not a valid number.");
    }
    return result;
  }

  if (!rates) {
    throw new ToolError(
      "invalid_input",
      "Currency conversion needs exchange rates, which are not configured yet.",
      { from, to },
    );
  }

  const fromRate = effectiveRatePerUsd(from, rates);
  const toRate = effectiveRatePerUsd(to, rates);
  if (fromRate === undefined || toRate === undefined) {
    const missing = fromRate === undefined ? from : to;
    throw new ToolError(
      "invalid_input",
      `Currency conversion needs exchange rates, which are not configured yet for '${missing}'.`,
      { from, to, missing },
    );
  }

  // Via USD base: value / ratePerUsd(from) is the USD amount, then
  // × ratePerUsd(to) is the target amount.
  const result = (value / fromRate) * toRate;
  if (!Number.isFinite(result)) {
    throw new ToolError("invalid_input", "The result is not a valid number.");
  }
  return result;
}

function isIrrIrtPair(a: string, b: string): boolean {
  return (a === "irr" && b === "irt") || (a === "irt" && b === "irr");
}

/**
 * Rate for `unit`, deriving IRR/IRT from its fixed sibling when the
 * source only knows one of them: if 1 USD = X IRR then 1 USD = X/10 IRT
 * (and conversely ×10). Invalid rates (non-finite or ≤ 0) count as
 * unknown — they are never used.
 */
function effectiveRatePerUsd(
  unit: CurrencyUnit,
  rates: CurrencyRateSource,
): number | undefined {
  const direct = rates.ratePerUsd(unit);
  if (isValidRate(direct)) return direct;
  if (unit === "irt") {
    const irr = rates.ratePerUsd("irr");
    if (isValidRate(irr)) return irr / 10;
  }
  if (unit === "irr") {
    const irt = rates.ratePerUsd("irt");
    if (isValidRate(irt)) return irt * 10;
  }
  return undefined;
}

function isValidRate(rate: number | undefined): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0;
}

function isTempUnit(u: string): u is TempUnit {
  return (TEMPERATURE_UNITS as readonly string[]).includes(u);
}

function isCurrencyUnit(u: string): u is CurrencyUnit {
  return (CURRENCY_UNITS as readonly string[]).includes(u);
}

function categoryOrUndefined(unit: string): Category | "temperature" | undefined {
  if (isTempUnit(unit)) return "temperature";
  if (isCurrencyUnit(unit)) return "currency";
  return BASE[unit]?.category;
}

function categoryOf(unit: string): Category | "temperature" {
  const category = categoryOrUndefined(unit);
  if (!category) throw new ToolError("invalid_input", "Invalid unit.", { unit });
  return category;
}

/** Exact affine conversions; below absolute zero is rejected. */
function convertTemperature(value: number, from: TempUnit, to: TempUnit): number {
  const c = toCelsius(value, from);
  if (c < -273.15) {
    throw new ToolError("invalid_input", "Temperature is below absolute zero.");
  }
  const result = fromCelsius(c, to);
  if (!Number.isFinite(result)) {
    throw new ToolError("invalid_input", "The result is not a valid number.");
  }
  return result;
}

function toCelsius(value: number, unit: TempUnit): number {
  switch (unit) {
    case "c":
      return value;
    case "f":
      return ((value - 32) * 5) / 9;
    case "k":
      return value - 273.15;
  }
}

function fromCelsius(c: number, unit: TempUnit): number {
  switch (unit) {
    case "c":
      return c;
    case "f":
      return (c * 9) / 5 + 32;
    case "k":
      return c + 273.15;
  }
}
