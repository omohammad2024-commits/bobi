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
    throw new ToolError("invalid_input", "ورودی ابزار باید یک شیء باشد.");
  }

  const rawObj = raw as Record<string, unknown>;
  const allowed = new Set(Object.keys(spec.fields));

  for (const key of Object.keys(rawObj)) {
    if (!allowed.has(key)) {
      throw new ToolError("invalid_input", `فیلد ناشناس: ${key}.`, { field: key });
    }
  }

  const out: ToolInput = {};
  for (const [field, fs] of Object.entries(spec.fields)) {
    const value = rawObj[field];

    if (value === undefined) {
      if (fs.required) {
        throw new ToolError("invalid_input", `فیلد الزامی نیست: ${field}.`, { field });
      }
      continue;
    }

    if (value === null) {
      if (fs.nullable) continue;
      throw new ToolError("invalid_input", `فیلد نمی‌تواند خالی باشد: ${field}.`, { field });
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
        throw new ToolError("invalid_input", `فیلد باید بولی باشد: ${field}.`, { field });
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
        throw new ToolError("invalid_input", `فیلد باید شیء باشد: ${field}.`, { field });
      }
      return value;
  }
}

function checkString(field: string, fs: FieldSpec, value: unknown): string {
  if (typeof value !== "string") {
    throw new ToolError("invalid_input", `فیلد باید رشته باشد: ${field}.`, { field });
  }
  if (fs.minLength !== undefined && value.length < fs.minLength) {
    throw new ToolError("invalid_input", `فیلد خیلی کوتاه است: ${field}.`, { field });
  }
  if (fs.maxLength !== undefined && value.length > fs.maxLength) {
    throw new ToolError("invalid_input", `فیلد خیلی طولانی است: ${field}.`, { field });
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
    throw new ToolError("invalid_input", `فیلد باید عدد باشد: ${field}.`, { field });
  }
  if (requireInteger && !Number.isInteger(value)) {
    throw new ToolError("invalid_input", `فیلد باید عدد صحیح باشد: ${field}.`, { field });
  }
  if (fs.minimum !== undefined && value < fs.minimum) {
    throw new ToolError("invalid_input", `مقدار کمتر از حد مجاز است: ${field}.`, { field });
  }
  if (fs.maximum !== undefined && value > fs.maximum) {
    throw new ToolError("invalid_input", `مقدار بیشتر از حد مجاز است: ${field}.`, { field });
  }
  return value;
}

function checkInteger(field: string, fs: FieldSpec, value: unknown): number {
  return checkNumber(field, fs, value, true);
}

function checkEnum(field: string, fs: FieldSpec, value: unknown): string {
  if (typeof value !== "string") {
    throw new ToolError("invalid_input", `فیلد باید رشته باشد: ${field}.`, { field });
  }
  if (!fs.choices?.includes(value)) {
    throw new ToolError("invalid_input", `مقدار نامعتبر برای ${field}.`, { field });
  }
  return value;
}

function checkArray(field: string, fs: FieldSpec, value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new ToolError("invalid_input", `فیلد باید آرایه باشد: ${field}.`, { field });
  }
  if (fs.maxItems !== undefined && value.length > fs.maxItems) {
    throw new ToolError("invalid_input", `آرایه خیلی بلند است: ${field}.`, { field });
  }
  return value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
