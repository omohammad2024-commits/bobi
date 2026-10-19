/**
 * Runtime input validation for tool calls.
 *
 * Everything a user or a model sends is untrusted, so the Executor validates
 * against the tool's declared ToolInputSpec BEFORE the tool body runs. A tool
 * can then assume its input is well-formed.
 *
 * The validator is deliberately strict: unknown fields, wrong JSON types, and
 * values outside the declared bounds are all rejected.
 */
import { ToolError } from "./errors";
import type { FieldSpec, ToolInput, ToolInputSpec } from "./types";

/** Throws a ToolError("invalid_input") listing the offending field. */
export function validateInput(spec: ToolInputSpec, raw: unknown): ToolInput {
  if (!isPlainObject(raw)) {
    throw new ToolError("invalid_input", "Tool input must be an object.");
  }

  const rawObj = raw as Record<string, unknown>;
  const allowed = new Set(Object.keys(spec.fields));

  for (const key of Object.keys(rawObj)) {
    if (!allowed.has(key)) {
      throw new ToolError("invalid_input", `Unknown field: ${key}.`, { field: key });
    }
  }

  const out: ToolInput = {};
  for (const [field, fs] of Object.entries(spec.fields)) {
    const value = rawObj[field];

    if (value === undefined) {
      if (fs.required) {
        // NOTE: the message used to read "not required" here — a wrong
        // message for a missing REQUIRED field. Fixed (audit, Oct 2026).
        throw new ToolError("invalid_input", `Missing required field: ${field}.`, { field });
      }
      continue;
    }

    if (value === null) {
      if (fs.nullable) continue;
      throw new ToolError("invalid_input", `Field must not be null: ${field}.`, { field });
    }

    out[field] = checkField(field, fs, value);
  }

  return out;
}

function checkField(field: string, fs: FieldSpec, value: unknown): unknown {
  switch (fs.type) {
    case "string":
      return checkString(field, fs, value);
    case "number":
      return checkNumber(field, fs, value);
    case "integer":
      return checkInteger(field, fs, value);
    case "boolean":
      if (typeof value !== "boolean") {
        throw new ToolError("invalid_input", `Field must be a boolean: ${field}.`, { field });
      }
      return value;
    case "enum":
      return checkEnum(field, fs, value);
    case "array":
      return checkArray(field, fs, value);
    case "object":
      // Passed through as-is: the consumer validates it. Only the shape is
      // checked here, so a non-object cannot slip through as one.
      if (!isPlainObject(value)) {
        throw new ToolError("invalid_input", `Field must be an object: ${field}.`, { field });
      }
      return value;
  }
}

function checkString(field: string, fs: FieldSpec, value: unknown): string {
  if (typeof value !== "string") {
    throw new ToolError("invalid_input", `Field must be a string: ${field}.`, { field });
  }
  if (fs.minLength !== undefined && value.length < fs.minLength) {
    throw new ToolError("invalid_input", `Field is too short: ${field}.`, { field });
  }
  if (fs.maxLength !== undefined && value.length > fs.maxLength) {
    throw new ToolError("invalid_input", `Field is too long: ${field}.`, { field });
  }
  return value;
}

function checkNumber(
  field: string,
  fs: FieldSpec,
  value: unknown,
  requireInteger = false,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolError("invalid_input", `Field must be a number: ${field}.`, { field });
  }
  if (requireInteger && !Number.isInteger(value)) {
    throw new ToolError("invalid_input", `Field must be an integer: ${field}.`, { field });
  }
  if (fs.minimum !== undefined && value < fs.minimum) {
    throw new ToolError("invalid_input", `Value is below the allowed minimum: ${field}.`, { field });
  }
  if (fs.maximum !== undefined && value > fs.maximum) {
    throw new ToolError("invalid_input", `Value is above the allowed maximum: ${field}.`, { field });
  }
  return value;
}

function checkInteger(field: string, fs: FieldSpec, value: unknown): number {
  return checkNumber(field, fs, value, true);
}

function checkEnum(field: string, fs: FieldSpec, value: unknown): string {
  if (typeof value !== "string") {
    throw new ToolError("invalid_input", `Field must be a string: ${field}.`, { field });
  }
  if (!fs.choices?.includes(value)) {
    // Name the allowed values: the caller is usually a model that can pick
    // a valid one once it sees the list.
    const expected =
      fs.choices !== undefined && fs.choices.length > 0
        ? `: expected one of ${fs.choices.map((c) => JSON.stringify(c)).join(", ")}`
        : "";
    throw new ToolError("invalid_input", `Invalid value for ${field}${expected}.`, { field });
  }
  return value;
}

function checkArray(field: string, fs: FieldSpec, value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new ToolError("invalid_input", `Field must be an array: ${field}.`, { field });
  }
  if (fs.maxItems !== undefined && value.length > fs.maxItems) {
    throw new ToolError("invalid_input", `Array is too long: ${field}.`, { field });
  }
  return value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
