/**
 * ToolInputSpec → JSON Schema.
 *
 * The Registry's declarative spec is what the Executor validates against, and
 * it is also the only description of a tool's arguments BOBI has. Model-facing
 * tool definitions need JSON Schema instead, so this module is the single
 * translation between the two — deriving both from one source means a schema
 * sent to a model can never drift from what the validator actually enforces.
 *
 * Mapping:
 *   string   → { type: "string",  minLength?, maxLength? }
 *   number   → { type: "number",  minimum?, maximum? }
 *   integer  → { type: "integer", minimum?, maximum? }
 *   boolean  → { type: "boolean" }
 *   enum     → { type: "string", enum: [...] }
 *   array    → { type: "array", maxItems? }
 *
 * A nullable field becomes `type: ["<t>", "null"]`. Fields not marked required
 * are omitted from `required`, so the model knows it may leave them out.
 */
import type { FieldSpec, ToolInputSpec } from "./types";

/** JSON Schema for a single field. */
function fieldSchema(spec: FieldSpec): Record<string, unknown> {
  const base = baseSchema(spec);

  // Bounds are copied only when the spec declares them; sending an absent
  // bound as `null` would be an invalid schema.
  if (spec.type === "string" && spec.choices === undefined) {
    if (spec.minLength !== undefined) base["minLength"] = spec.minLength;
    if (spec.maxLength !== undefined) base["maxLength"] = spec.maxLength;
  }
  if (spec.type === "number" || spec.type === "integer") {
    if (spec.minimum !== undefined) base["minimum"] = spec.minimum;
    if (spec.maximum !== undefined) base["maximum"] = spec.maximum;
  }
  if (spec.type === "array" && spec.maxItems !== undefined) {
    base["maxItems"] = spec.maxItems;
  }
  if (spec.description !== undefined && spec.description.length > 0) {
    base["description"] = spec.description;
  }

  return spec.nullable === true ? nullable(base) : base;
}

function baseSchema(spec: FieldSpec): Record<string, unknown> {
  switch (spec.type) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "integer":
      return { type: "integer" };
    case "boolean":
      return { type: "boolean" };
    case "enum":
      return { type: "string", enum: [...(spec.choices ?? [])] };
    case "array":
      return { type: "array", items: {} };
    case "object":
      // A free-form bag: `additionalProperties` must stay open, unlike the
      // closed argument object a normal tool declares.
      return { type: "object", additionalProperties: true };
  }
}

/** Widen `type` to admit null, preserving any enum alongside it. */
function nullable(schema: Record<string, unknown>): Record<string, unknown> {
  const type = schema["type"];
  if (typeof type === "string") {
    return { ...schema, type: [type, "null"] };
  }
  return schema;
}

/**
 * JSON Schema for a tool's whole argument object.
 *
 * `additionalProperties: false` mirrors the validator, which rejects unknown
 * fields — telling the model the same thing up front is what keeps a strict
 * provider from being surprised by a validation error it could have avoided.
 */
export function toJsonSchema(spec: ToolInputSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, field] of Object.entries(spec.fields)) {
    properties[name] = fieldSchema(field);
    // A nullable-but-required field still has to be present; only `required`
    // itself decides that, never `nullable`.
    if (field.required === true) required.push(name);
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
