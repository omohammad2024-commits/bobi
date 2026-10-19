/**
 * unit_converter — length, mass, volume and temperature.
 *
 * Correctness rules:
 * - Everything except temperature converts through a canonical SI base
 *   (metres, kilograms, cubic metres), multiplied then divided. This keeps a
 *   single source of truth per unit and avoids transitive rounding drift.
 * - Temperature uses the exact formulas (°C↔°F↔K), because temperature is an
 *   affine scale, not a ratio scale — a factor-based conversion is wrong.
 * - An unknown unit, or a unit from the wrong category, is rejected rather
 *   than guessed at.
 */
import { ToolError } from "./errors";
import type { Tool, ToolContext } from "./types";

export const UNIT_CONVERTER_PERMISSION = "tools:unit_converter";

type Category = "length" | "mass" | "volume";

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

export const SUPPORTED_UNITS: readonly string[] = [
  ...Object.keys(BASE),
  ...TEMPERATURE_UNITS,
];

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

export const unitConverterTool: Tool<UnitInput, UnitOutput> = {
  name: "unit_converter",
  description: "Convert length, mass, volume and temperature units.",
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
    const result = convert(input.value, from, to);

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

/** Pure conversion, exported so tests can check formulas directly. */
export function convert(value: number, from: string, to: string): number {
  if (isTempUnit(from) && isTempUnit(to)) {
    return convertTemperature(value, from, to);
  }
  if (isTempUnit(from) !== isTempUnit(to)) {
    throw new ToolError(
      "invalid_input",
      "Temperature cannot be converted to other scales.",
      { from, to },
    );
  }

  const src = BASE[from];
  const dst = BASE[to];
  if (!src || !dst) {
    throw new ToolError("invalid_input", "Invalid unit.", { from, to });
  }
  if (src.category !== dst.category) {
    throw new ToolError("invalid_input", "Units are not from the same category.", { from, to });
  }

  const result = (value * src.factor) / dst.factor;
  if (!Number.isFinite(result)) {
    throw new ToolError("invalid_input", "The result is not a valid number.");
  }
  return result;
}

function isTempUnit(u: string): u is TempUnit {
  return (TEMPERATURE_UNITS as readonly string[]).includes(u);
}

function categoryOf(unit: string): Category | "temperature" {
  if (isTempUnit(unit)) return "temperature";
  const entry = BASE[unit];
  if (!entry) throw new ToolError("invalid_input", "Invalid unit.", { unit });
  return entry.category;
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
