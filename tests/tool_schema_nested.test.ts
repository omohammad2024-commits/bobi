/**
 * Phase 2 — real nested JSON schemas in the tool spec language.
 *
 * What this suite pins:
 * 1. Recursive schema emission: structured objects (`fields`) and typed
 *    array items (`items`) reach the model as real JSON Schema, with
 *    bounds, descriptions and nullability intact at every depth.
 * 2. Backward compatibility: a spec using NONE of the new features emits
 *    byte-identical schema to the pre-nesting translator — an untyped
 *    array is still `items: {}` and a fieldless object is still the
 *    free-form bag (`additionalProperties: true`).
 * 3. Recursive validation with PATH error names — the scheme chosen here:
 *    dotted for object fields (`config.port`), bracketed for array items
 *    (`tags[1]`), combined for objects in arrays (`rows[0].id`).
 * 4. The external-protocol contract: a spec's own `jsonSchema` is returned
 *    verbatim (deep-copied), and a `passthrough` spec skips strict
 *    validation beyond requiring a plain object.
 */
import { describe, expect, test } from "bun:test";
import { toJsonSchema } from "../src/tools/json_schema";
import { validateInput } from "../src/tools/validate";
import { ToolError } from "../src/tools/errors";
import type { ToolInputSpec } from "../src/tools/types";

function runErrorSync(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return err as ToolError;
  }
  throw new Error("expected a throw");
}

/** One spec exercising every nesting feature at once. */
const nestedSpec: ToolInputSpec = {
  fields: {
    name: { type: "string", required: true },
    config: {
      type: "object",
      required: true,
      description: "Connection settings.",
      fields: {
        host: { type: "string", required: true },
        port: { type: "integer", required: true, minimum: 1, maximum: 65535 },
        secure: { type: "boolean" },
        alias: { type: "string", nullable: true },
      },
    },
    tags: { type: "array", maxItems: 3, items: { type: "string", maxLength: 5 } },
    rows: {
      type: "array",
      items: {
        type: "object",
        fields: {
          id: { type: "integer", required: true },
          label: { type: "string", nullable: true },
        },
      },
    },
    scores: { type: "array", items: { type: "number", nullable: true } },
    matrix: { type: "array", items: { type: "array", items: { type: "integer" } } },
    bag: { type: "object" },
  },
};

function props(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return schema["properties"] as Record<string, Record<string, unknown>>;
}

// ---------- 1. recursive schema emission ----------

describe("toJsonSchema — nested specs", () => {
  test("a structured object emits properties, required and a closed shape", () => {
    const p = props(toJsonSchema(nestedSpec));
    expect(p["config"]).toEqual({
      type: "object",
      properties: {
        host: { type: "string" },
        port: { type: "integer", minimum: 1, maximum: 65535 },
        secure: { type: "boolean" },
        alias: { type: ["string", "null"] },
      },
      required: ["host", "port"],
      additionalProperties: false,
      description: "Connection settings.",
    });
  });

  test("typed array items are emitted, with their own bounds", () => {
    const p = props(toJsonSchema(nestedSpec));
    expect(p["tags"]).toEqual({
      type: "array",
      items: { type: "string", maxLength: 5 },
      maxItems: 3,
    });
  });

  test("an array of objects emits the objects' required fields", () => {
    const p = props(toJsonSchema(nestedSpec));
    expect(p["rows"]).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          label: { type: ["string", "null"] },
        },
        required: ["id"],
        additionalProperties: false,
      },
    });
  });

  test("nesting recurses: array of arrays, and nullable items", () => {
    const p = props(toJsonSchema(nestedSpec));
    expect(p["matrix"]).toEqual({
      type: "array",
      items: { type: "array", items: { type: "integer" } },
    });
    // A nullable ITEM widens the item schema, not the array's.
    expect(p["scores"]).toEqual({
      type: "array",
      items: { type: ["number", "null"] },
    });
  });

  test("a nullable structured object widens to allow null but keeps its shape", () => {
    const schema = toJsonSchema({
      fields: {
        cfg: {
          type: "object",
          nullable: true,
          fields: { host: { type: "string", required: true } },
        },
      },
    });
    expect(props(schema)["cfg"]).toEqual({
      type: ["object", "null"],
      properties: { host: { type: "string" } },
      required: ["host"],
      additionalProperties: false,
    });
  });
});

// ---------- 2. backward-compatibility pins ----------

describe("toJsonSchema — specs without nesting are unchanged", () => {
  const flatSpec: ToolInputSpec = {
    fields: {
      name: { type: "string", required: true, minLength: 1, maxLength: 10, description: "Display name." },
      count: { type: "integer", minimum: 0, maximum: 5 },
      ratio: { type: "number", minimum: 0 },
      flag: { type: "boolean" },
      mode: { type: "enum", choices: ["a", "b"], required: true },
      tags: { type: "array", maxItems: 3 },
      bag: { type: "object" },
      maybe: { type: "string", nullable: true },
    },
  };

  // The literal the pre-nesting translator produced for this spec, key
  // order included: `items: {}` for the untyped array, the open bag for
  // the fieldless object. If a nesting change alters ANY of this, a tool
  // that never opted into nesting changes what models see — a regression.
  const expected = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 10, description: "Display name." },
      count: { type: "integer", minimum: 0, maximum: 5 },
      ratio: { type: "number", minimum: 0 },
      flag: { type: "boolean" },
      mode: { type: "string", enum: ["a", "b"] },
      tags: { type: "array", items: {}, maxItems: 3 },
      bag: { type: "object", additionalProperties: true },
      maybe: { type: ["string", "null"] },
    },
    required: ["name", "mode"],
    additionalProperties: false,
  };

  test("deep-equal to the pre-nesting literal", () => {
    expect(toJsonSchema(flatSpec)).toEqual(expected);
  });

  test("byte-identical (same key order) to the pre-nesting literal", () => {
    expect(JSON.stringify(toJsonSchema(flatSpec))).toBe(JSON.stringify(expected));
  });
});

// ---------- 3. recursive validation ----------

describe("validateInput — nested specs", () => {
  const valid = {
    name: "x",
    config: { host: "h", port: 443, secure: true },
    tags: ["a", "bb"],
    rows: [{ id: 1, label: "one" }, { id: 2 }],
    scores: [1.5, null],
    matrix: [[1, 2], [3]],
    bag: { anything: [1, { deep: true }] },
  };

  test("accepts valid nested input and returns it intact", () => {
    expect(validateInput(nestedSpec, valid)).toEqual(valid);
  });

  test("a free-form bag object still passes through as-is (same reference)", () => {
    const bag = { anything: [1, { deep: true }] };
    const out = validateInput(nestedSpec, { ...valid, bag });
    expect(out["bag"]).toBe(bag);
  });

  test("rejects a wrong type in a nested field, named by dotted path", () => {
    const err = runErrorSync(() =>
      validateInput(nestedSpec, { ...valid, config: { host: "h", port: "443" } }),
    );
    expect(err.message).toBe("Field must be a number: config.port.");
  });

  test("rejects a wrong array item type, named by index", () => {
    const err = runErrorSync(() =>
      validateInput(nestedSpec, { ...valid, tags: ["ok", 7] }),
    );
    expect(err.message).toBe("Field must be a string: tags[1].");
  });

  test("rejects a wrong field inside an object inside an array", () => {
    const err = runErrorSync(() =>
      validateInput(nestedSpec, { ...valid, rows: [{ id: "x" }] }),
    );
    expect(err.message).toBe("Field must be a number: rows[0].id.");

    const frac = runErrorSync(() =>
      validateInput(nestedSpec, { ...valid, rows: [{ id: 1.5 }] }),
    );
    expect(frac.message).toBe("Field must be an integer: rows[0].id.");

    const cell = runErrorSync(() =>
      validateInput(nestedSpec, { ...valid, matrix: [[1, "x"]] }),
    );
    expect(cell.message).toBe("Field must be a number: matrix[0][1].");
  });

  test("rejects unknown nested fields", () => {
    const err = runErrorSync(() =>
      validateInput(nestedSpec, { ...valid, config: { host: "h", port: 1, bogus: 1 } }),
    );
    expect(err.message).toBe("Unknown field: config.bogus.");

    const inRow = runErrorSync(() =>
      validateInput(nestedSpec, { ...valid, rows: [{ id: 1, nope: 1 }] }),
    );
    expect(inRow.message).toBe("Unknown field: rows[0].nope.");
  });

  test("rejects missing required nested fields", () => {
    const err = runErrorSync(() =>
      validateInput(nestedSpec, { ...valid, config: { port: 443 } }),
    );
    expect(err.message).toBe("Missing required field: config.host.");

    const inRow = runErrorSync(() =>
      validateInput(nestedSpec, { ...valid, rows: [{ label: "x" }] }),
    );
    expect(inRow.message).toBe("Missing required field: rows[0].id.");
  });

  test("rejects an oversized array of typed items", () => {
    const err = runErrorSync(() =>
      validateInput(nestedSpec, { ...valid, tags: ["a", "b", "c", "d"] }),
    );
    expect(err.message).toBe("Array is too long: tags.");
  });

  test("nested bounds are enforced, not just nested types", () => {
    const err = runErrorSync(() =>
      validateInput(nestedSpec, { ...valid, config: { host: "h", port: 70000 } }),
    );
    expect(err.message).toBe("Value is above the allowed maximum: config.port.");

    const long = runErrorSync(() =>
      validateInput(nestedSpec, { ...valid, tags: ["toolong"] }),
    );
    expect(long.message).toBe("Field is too long: tags[0].");
  });
});

// ---------- 3b. nullable nested fields ----------

describe("validateInput — nullable nesting", () => {
  test("a null nullable nested field is accepted (and omitted, as at the top level)", () => {
    const out = validateInput(nestedSpec, {
      name: "x",
      config: { host: "h", port: 443, alias: null },
    });
    expect(out["config"]).toEqual({ host: "h", port: 443 });
  });

  test("a null for a non-nullable nested field is rejected by path", () => {
    const err = runErrorSync(() =>
      validateInput(nestedSpec, { name: "x", config: { host: null, port: 443 } }),
    );
    expect(err.message).toBe("Field must not be null: config.host.");
  });

  test("nullable items keep their null in place; non-nullable items reject it", () => {
    const out = validateInput(nestedSpec, {
      name: "x",
      config: { host: "h", port: 443 },
      scores: [null, 2],
      rows: [{ id: 1, label: null }],
    });
    expect(out["scores"]).toEqual([null, 2]);
    // A nullable field inside an array item follows field rules: omitted.
    expect(out["rows"]).toEqual([{ id: 1 }]);

    const err = runErrorSync(() =>
      validateInput(nestedSpec, {
        name: "x",
        config: { host: "h", port: 443 },
        tags: [null],
      }),
    );
    expect(err.message).toBe("Field must not be null: tags[0].");
  });
});

// ---------- 4. jsonSchema override + passthrough ----------

describe("ToolInputSpec.jsonSchema override", () => {
  const external = {
    type: "object",
    properties: { ext: { type: "number" } },
    required: ["ext"],
    additionalProperties: true,
    nested: { deep: [1, 2, { three: 3 }] },
  };
  const spec: ToolInputSpec = {
    // Deliberately unrelated: when jsonSchema is set, fields are ignored
    // for schema purposes.
    fields: { ignored: { type: "string" } },
    jsonSchema: external,
  };

  test("is returned verbatim, ignoring fields", () => {
    expect(toJsonSchema(spec)).toEqual(external);
  });

  test("mutating the result does not corrupt the spec's copy", () => {
    const first = toJsonSchema(spec);
    (first["properties"] as Record<string, unknown>)["ext"] = "corrupted";
    ((first["nested"] as Record<string, unknown>)["deep"] as unknown[]).push(99);
    first["required"] = [];

    expect(spec.jsonSchema).toEqual(external);
    expect(toJsonSchema(spec)).toEqual(external);
  });
});

describe("ToolInputSpec.passthrough", () => {
  const spec: ToolInputSpec = { fields: {}, passthrough: true };

  test("accepts arbitrary plain objects, unknown fields included", () => {
    const raw = { anything: 1, nested: { x: [1, 2] }, s: "hi", flag: true };
    const out = validateInput(spec, raw);
    expect(out).toEqual(raw);
    // A shallow copy: replacing a top-level key on the result must not
    // write back into the caller's object.
    expect(out).not.toBe(raw);
    out["anything"] = 999;
    expect(raw.anything).toBe(1);
  });

  test("rejects non-objects", () => {
    for (const bad of ["nope", [1, 2], null, 42]) {
      const err = runErrorSync(() => validateInput(spec, bad));
      expect(err.message).toBe("Tool input must be an object.");
    }
  });

  test("without passthrough, the same unknown fields are still rejected", () => {
    const err = runErrorSync(() =>
      validateInput({ fields: {} }, { anything: 1 }),
    );
    expect(err.message).toBe("Unknown field: anything.");
  });
});
