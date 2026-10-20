/**
 * Per-dialect JSON Schema sanitising (src/ai/schema_sanitize.ts).
 *
 * One `ToolSpec.parameters` object is shared by every adapter, but the
 * providers do not speak the same schema dialect: Gemini's
 * functionDeclarations take Google's OpenAPI-subset Schema type (an
 * allowlist, no `additionalProperties`, no nullable type arrays), while
 * Anthropic and OpenAI take near-standard JSON Schema. These tests pin
 * each dialect's transform on one representative nested schema, prove
 * the shared input is never mutated, and assert the sanitised shape is
 * what each adapter's exported body builder actually puts on the wire —
 * hermetically, with no network, like the rest of the adapter suite.
 */
import { describe, expect, test } from "bun:test";
import { sanitizeSchemaForDialect } from "../src/ai/schema_sanitize";
import type { SchemaDialect } from "../src/ai/schema_sanitize";
import { buildBody as buildGeminiBody } from "../src/ai/gemini";
import { buildBody as buildAnthropicBody } from "../src/ai/anthropic";
import { buildRequestBody as buildOpenAIBody } from "../src/ai/openai_compatible";
import type { CompletionRequest } from "../src/ai/provider";

/** A nested schema exercising every construct the sanitizer rewrites. */
const SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://example.test/lookup",
  $comment: "document meta, not tool shape",
  title: "Lookup",
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: ["string", "null"], description: "Search text", $comment: "nested meta" },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    mode: { type: "string", enum: ["fast", "deep"] },
    fixed: { const: "always" },
    choice: { oneOf: [{ type: "string" }, { type: "integer", minimum: 0 }] },
    nothing: { type: "null" },
    address: {
      type: "object",
      additionalProperties: false,
      title: "Address",
      properties: {
        city: { type: "string" },
        zip: { type: ["string", "null"] },
      },
      required: ["city"],
    },
    entries: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { label: { type: "string" } },
        required: ["label"],
      },
    },
  },
  required: ["query"],
};

/** Every object key appearing anywhere in a value, at any depth. */
function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      into.add(key);
      collectKeys(item, into);
    }
  }
  return into;
}

const DIALECTS: SchemaDialect[] = ["gemini", "anthropic", "openai"];

// ----------------------------------------------------------------- Gemini ----

describe("sanitizeSchemaForDialect — gemini", () => {
  test("the representative schema becomes exactly the allowlisted shape", () => {
    expect(sanitizeSchemaForDialect(SCHEMA, "gemini")).toEqual({
      type: "object",
      properties: {
        query: { description: "Search text", type: "string", nullable: true },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        mode: { type: "string", enum: ["fast", "deep"] },
        fixed: { enum: ["always"] },
        choice: { anyOf: [{ type: "string" }, { type: "integer", minimum: 0 }] },
        nothing: { nullable: true },
        address: {
          type: "object",
          properties: {
            city: { type: "string" },
            zip: { type: "string", nullable: true },
          },
          required: ["city"],
        },
        entries: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
          },
        },
      },
      required: ["query"],
    });
  });

  test("no unsupported or $-prefixed key survives anywhere, at any depth", () => {
    const keys = collectKeys(sanitizeSchemaForDialect(SCHEMA, "gemini"));
    for (const forbidden of [
      "additionalProperties",
      "$schema",
      "$id",
      "$comment",
      "$ref",
      "$defs",
      "definitions",
      "title",
      "oneOf",
      "allOf",
      "const",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "patternProperties",
      "not",
      "contains",
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
    for (const key of keys) expect(key.startsWith("$")).toBe(false);
  });

  test("unsupported keywords are dropped even alongside supported ones", () => {
    expect(
      sanitizeSchemaForDialect(
        {
          type: "string",
          $ref: "#/$defs/x",
          $defs: { x: { type: "string" } },
          exclusiveMinimum: 0,
          not: { type: "integer" },
          pattern: "^a",
        },
        "gemini",
      ),
    ).toEqual({ type: "string", pattern: "^a" });
  });

  test("a multi-member type array becomes anyOf branches plus nullable", () => {
    expect(sanitizeSchemaForDialect({ type: ["string", "integer", "null"] }, "gemini")).toEqual({
      nullable: true,
      anyOf: [{ type: "string" }, { type: "integer" }],
    });
  });

  test("allOf with a single entry merges that entry into the current level", () => {
    expect(
      sanitizeSchemaForDialect(
        {
          description: "merged",
          allOf: [
            { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          ],
        },
        "gemini",
      ),
    ).toEqual({
      description: "merged",
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
  });

  test("allOf with several object entries merges properties and required", () => {
    expect(
      sanitizeSchemaForDialect(
        {
          allOf: [
            { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
            { type: "object", properties: { b: { type: "integer" } }, required: ["b"] },
          ],
        },
        "gemini",
      ),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "integer" } },
      required: ["a", "b"],
    });
  });

  test("allOf that cannot be merged keeps the first entry", () => {
    expect(
      sanitizeSchemaForDialect(
        { allOf: [{ type: "string", minLength: 2 }, { type: "integer", minimum: 1 }] },
        "gemini",
      ),
    ).toEqual({ type: "string", minLength: 2 });
  });

  test("oneOf and const inside nested properties are rewritten too", () => {
    const out = sanitizeSchemaForDialect(SCHEMA, "gemini");
    const properties = out["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["choice"]).toEqual({
      anyOf: [{ type: "string" }, { type: "integer", minimum: 0 }],
    });
    expect(properties["fixed"]).toEqual({ enum: ["always"] });
    expect(properties["nothing"]).toEqual({ nullable: true });
  });
});

// ------------------------------------------------------- anthropic / openai ----

/** SCHEMA as the light-touch dialects must return it: only meta keys gone. */
const LIGHT_EXPECTED: Record<string, unknown> = {
  title: "Lookup",
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: ["string", "null"], description: "Search text" },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    mode: { type: "string", enum: ["fast", "deep"] },
    fixed: { const: "always" },
    choice: { oneOf: [{ type: "string" }, { type: "integer", minimum: 0 }] },
    nothing: { type: "null" },
    address: {
      type: "object",
      additionalProperties: false,
      title: "Address",
      properties: {
        city: { type: "string" },
        zip: { type: ["string", "null"] },
      },
      required: ["city"],
    },
    entries: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { label: { type: "string" } },
        required: ["label"],
      },
    },
  },
  required: ["query"],
};

describe("sanitizeSchemaForDialect — anthropic and openai", () => {
  for (const dialect of ["anthropic", "openai"] as const) {
    test(`${dialect}: additionalProperties and type arrays are kept, $-keys are stripped`, () => {
      const out = sanitizeSchemaForDialect(SCHEMA, dialect);
      expect(out).toEqual(LIGHT_EXPECTED);
      expect(out["additionalProperties"]).toBe(false);
      const properties = out["properties"] as Record<string, Record<string, unknown>>;
      expect(properties["query"]!["type"]).toEqual(["string", "null"]);
      const keys = collectKeys(out);
      for (const meta of ["$schema", "$id", "$comment"]) {
        expect(keys.has(meta)).toBe(false);
      }
    });

    test(`${dialect}: meta keys are stripped from schemas nested under combinators`, () => {
      expect(
        sanitizeSchemaForDialect(
          {
            type: "object",
            oneOf: [{ $id: "https://example.test/a", type: "string" }],
            properties: { a: { $schema: "https://example.test/s", type: "number" } },
          },
          dialect,
        ),
      ).toEqual({
        type: "object",
        oneOf: [{ type: "string" }],
        properties: { a: { type: "number" } },
      });
    });
  }
});

// ------------------------------------------------------------- cross-cutting ----

describe("sanitizeSchemaForDialect — cross-cutting", () => {
  test("the input is never mutated, for any dialect", () => {
    const snapshot = structuredClone(SCHEMA);
    for (const dialect of DIALECTS) sanitizeSchemaForDialect(SCHEMA, dialect);
    expect(SCHEMA).toEqual(snapshot);
  });

  test("the result is a fresh structure, not the shared input", () => {
    for (const dialect of DIALECTS) {
      const out = sanitizeSchemaForDialect(SCHEMA, dialect);
      expect(out).not.toBe(SCHEMA);
      expect(out["properties"]).not.toBe(SCHEMA["properties"]);
      const outAddress = (out["properties"] as Record<string, unknown>)["address"];
      const inAddress = (SCHEMA["properties"] as Record<string, unknown>)["address"];
      expect(outAddress).not.toBe(inAddress);
    }
  });

  test("sanitising is idempotent, for any dialect", () => {
    for (const dialect of DIALECTS) {
      const once = sanitizeSchemaForDialect(SCHEMA, dialect);
      expect(sanitizeSchemaForDialect(once, dialect)).toEqual(once);
    }
  });

  test("an empty schema stays empty, for any dialect", () => {
    for (const dialect of DIALECTS) {
      expect(sanitizeSchemaForDialect({}, dialect)).toEqual({});
    }
  });
});

// ------------------------------------------------------------------ wire-in ----

const TARGET = { baseUrl: "https://example.test/v1", apiKey: "k", settings: {} };

const WIRE_PARAMETERS: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: { q: { type: ["string", "null"] } },
  required: ["q"],
};

const reqWithTool = (parameters: Record<string, unknown>): CompletionRequest => ({
  messages: [{ role: "user", content: "hi" }],
  model: "test-model",
  timeoutMs: 1_000,
  signal: new AbortController().signal,
  tools: [{ name: "lookup", description: "Look up", parameters }],
});

describe("adapter wire-in", () => {
  test("gemini buildBody sends sanitised functionDeclarations parameters", () => {
    const body = buildGeminiBody(TARGET, reqWithTool(WIRE_PARAMETERS));
    const tools = body["tools"] as Array<Record<string, unknown>>;
    const decls = tools[0]!["functionDeclarations"] as Array<Record<string, unknown>>;
    const parameters = decls[0]!["parameters"] as Record<string, unknown>;
    expect(parameters).toEqual({
      type: "object",
      properties: { q: { type: "string", nullable: true } },
      required: ["q"],
    });
    expect("additionalProperties" in parameters).toBe(false);
  });

  test("anthropic buildBody keeps additionalProperties in input_schema", () => {
    const body = buildAnthropicBody(TARGET, reqWithTool(WIRE_PARAMETERS));
    const tools = body["tools"] as Array<Record<string, unknown>>;
    const inputSchema = tools[0]!["input_schema"] as Record<string, unknown>;
    expect(inputSchema["additionalProperties"]).toBe(false);
    expect(inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { q: { type: ["string", "null"] } },
      required: ["q"],
    });
    // The wire copy is sanitised, not the shared object itself.
    expect(inputSchema).not.toBe(WIRE_PARAMETERS);
  });

  test("openai buildRequestBody keeps additionalProperties in parameters", () => {
    const body = buildOpenAIBody(TARGET, reqWithTool(WIRE_PARAMETERS));
    const tools = body["tools"] as Array<Record<string, unknown>>;
    const fn = tools[0]!["function"] as Record<string, unknown>;
    const parameters = fn["parameters"] as Record<string, unknown>;
    expect(parameters["additionalProperties"]).toBe(false);
    expect(parameters).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { q: { type: ["string", "null"] } },
      required: ["q"],
    });
    expect(parameters).not.toBe(WIRE_PARAMETERS);
  });

  test("building every adapter's body leaves the shared parameters untouched", () => {
    const snapshot = structuredClone(WIRE_PARAMETERS);
    buildGeminiBody(TARGET, reqWithTool(WIRE_PARAMETERS));
    buildAnthropicBody(TARGET, reqWithTool(WIRE_PARAMETERS));
    buildOpenAIBody(TARGET, reqWithTool(WIRE_PARAMETERS));
    expect(WIRE_PARAMETERS).toEqual(snapshot);
  });
});
