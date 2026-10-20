/**
 * Runtime input validation for tool calls.
 *
 * Everything a user or a model sends is untrusted, so the Executor validates
 * against the tool's declared ToolInputSpec BEFORE the tool body runs. A tool
 * can then assume its input is well-formed.
 *
 * The validator is deliberately strict: unknown fields, wrong JSON types, and
 * values outside the declared bounds are all rejected.
 *
 * Validation is recursive, like the spec language: array items are each
 * checked against the array's `items` spec, and an object WITH `fields` is
 * validated as a nested ToolInputSpec (unknown nested fields rejected,
 * required nested fields enforced, nullability as at the top level). An
 * object WITHOUT `fields` stays a free-form bag, passed through untouched.
 * Error messages name the offending value by path — `config.port` for a
 * nested field, `tags[1]` for an array item, `rows[0].id` for the two
 * combined — so a model caller can find the exact value to fix.
 *
 * The one deliberate exception to strictness is a `passthrough` spec (see
 * ToolInputSpec): there an external protocol is the validating authority,
 * so only the plain-object shape is checked here.
 */
import { ToolError } from "./errors";
import type { FieldSpec, ToolInput, ToolInputSpec } from "./types";

/** Throws a ToolError("invalid_input") listing the offending field. */
export function validateInput(spec: ToolInputSpec, raw: unknown): ToolInput {
  if (!isPlainObject(raw)) {
    throw new ToolError("invalid_input", "Tool input must be an object.");
  }

  if (spec.passthrough === true) {
    // The external authority validates; BOBI only guarantees the shape is
    // an object at all. A shallow copy, so the tool body mutating its
    // input cannot write back into the caller's object (nested values are
    // shared — the copy is deliberately shallow, per the contract).
    return { ...raw };
  }

  return validateFields(spec.fields, raw, "");
}

/** Join a parent path and a field name: "" + "a" → "a", "cfg" + "a" → "cfg.a". */
function fieldPath(prefix: string, field: string): string {
  return prefix === "" ? field : `${prefix}.${field}`;
}

/**
 * Validate a plain object against a field map — the top-level argument
 * object, or a structured nested object (prefix = its path, used only to
 * name errors). One implementation for both is what keeps nested rules
 * (unknown / required / nullable) from drifting away from top-level ones.
 */
function validateFields(
  fields: Record<string, FieldSpec>,
  rawObj: Record<string, unknown>,
  prefix: string,
): ToolInput {
  const allowed = new Set(Object.keys(fields));

  for (const key of Object.keys(rawObj)) {
    if (!allowed.has(key)) {
      const path = fieldPath(prefix, key);
      throw new ToolError("invalid_input", `Unknown field: ${path}.`, { field: path });
    }
  }

  const out: ToolInput = {};
  for (const [field, fs] of Object.entries(fields)) {
    const path = fieldPath(prefix, field);
    const value = rawObj[field];

    if (value === undefined) {
      if (fs.required) {
        // NOTE: the message used to read "not required" here — a wrong
        // message for a missing REQUIRED field. Fixed (audit, Oct 2026).
        throw new ToolError("invalid_input", `Missing required field: ${path}.`, { field: path });
      }
      continue;
    }

    if (value === null) {
      if (fs.nullable) continue;
      throw new ToolError("invalid_input", `Field must not be null: ${path}.`, { field: path });
    }

    out[field] = checkField(path, fs, value);
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
      if (!isPlainObject(value)) {
        throw new ToolError("invalid_input", `Field must be an object: ${field}.`, { field });
      }
      if (fs.fields === undefined) {
        // Free-form bag, passed through as-is: the consumer validates it.
        // Only the shape is checked here, so a non-object cannot slip
        // through as one.
        return value;
      }
      // Structured object: validated like a nested ToolInputSpec, which
      // also rebuilds it from declared fields only (same as the top level).
      return validateFields(fs.fields, value, field);
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
  if (fs.items === undefined) {
    // Untyped array (the pre-nesting behaviour): items pass through as-is.
    return value;
  }
  const items = fs.items;
  // Every item is checked against the item spec, named by index
  // (`tags[1]`) so an error points at the exact offending element. A null
  // item is kept only when the item spec is nullable — unlike a null
  // FIELD, a null item cannot be "omitted", so it stays in place.
  return value.map((item, i) => {
    const itemPath = `${field}[${i}]`;
    if (item === null) {
      if (items.nullable) return null;
      throw new ToolError("invalid_input", `Field must not be null: ${itemPath}.`, { field: itemPath });
    }
    return checkField(itemPath, items, item);
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
