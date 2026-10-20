/**
 * Per-dialect JSON Schema sanitising for provider adapters.
 *
 * Why this module exists: `ToolSpec.parameters` (provider.ts) is ONE JSON
 * Schema, built once by src/tools/json_schema.ts and shared by every
 * adapter — the same object is handed to all of them, and retried with.
 * Sending it verbatim to every provider was wrong, because the providers
 * do not all speak the same dialect of schema:
 *
 * - Gemini's `functionDeclarations[].parameters` is NOT JSON Schema at
 *   all. It is Google's OpenAPI-subset "Schema" type, which supports only
 *   a small allowlist of keywords and rejects or silently ignores the
 *   rest. BOBI routinely emits keywords outside that subset —
 *   `additionalProperties: false` on every tool, `type: ["string",
 *   "null"]` for every nullable field — so Gemini was the adapter most
 *   likely to reject a tool definition outright, or to accept it with
 *   the constraints quietly stripped.
 * - Anthropic's `input_schema` and the OpenAI-compatible `parameters`
 *   both take near-standard JSON Schema, so they need only a light
 *   touch: the meta keywords that describe the schema document itself
 *   (`$schema`, `$id`, `$comment`) are not part of any one tool's shape
 *   and are dropped, and everything else is kept as the author wrote it.
 *
 * Each adapter therefore sanitises its own copy at the one place it
 * serialises a tool (buildBody / buildRequestBody). Sanitising is a
 * DEEP transform that never mutates its input and always returns a
 * fresh structure: the input object is shared across adapters and
 * retries, so an in-place edit here would corrupt the schema every
 * other provider — and every retry of this one — goes on to send.
 *
 * Per-dialect rules:
 *
 * GEMINI (allowlist — anything not listed is dropped, recursively):
 *   Supported keys: type, format, description, nullable, enum, items,
 *   properties, required, propertyOrdering, anyOf, default, example,
 *   pattern, minimum, maximum, minLength, maxLength, minItems,
 *   maxItems, minProperties, maxProperties. Dropping is what removes
 *   `additionalProperties`, `$schema`/`$id`/`$ref`, `$defs`/`definitions`,
 *   `exclusiveMinimum`/`exclusiveMaximum`, `patternProperties`,
 *   `if`/`then`/`else`, `not`, `contains`, `propertyNames`,
 *   `unevaluatedProperties` and `title`.
 *   - `type: ["<t>", "null"]` (the nullable widening json_schema.ts
 *     emits) becomes `{ type: "<t>", nullable: true }`; a lone `"null"`
 *     type becomes `{ nullable: true }` with no `type`. A type array
 *     with several non-null members has no single-type equivalent, so
 *     it becomes one `anyOf` branch per member.
 *   - `oneOf: [...]` becomes `anyOf: [...]` (branches sanitised
 *     recursively) — Gemini has `anyOf` but no `oneOf`.
 *   - `allOf` with one entry merges that entry into the current level.
 *     `allOf` with several OBJECT entries merges their properties and
 *     required lists into one object schema. That merge is a documented
 *     approximation: a true `allOf` also intersects every other
 *     constraint, which a single flat Schema cannot express. When the
 *     entries are not mergeable object schemas (e.g. conflicting scalar
 *     types), only the first entry is kept.
 *   - `const: v` becomes `enum: [v]`.
 *
 * ANTHROPIC / OPENAI (light touch):
 *   Strip `$schema`, `$id` and `$comment` at every schema level, recurse
 *   into nested schemas, and keep everything else — including
 *   `additionalProperties` and `type` arrays. BOBI does not use OpenAI
 *   strict mode, so no required-completion rewriting happens here.
 */

export type SchemaDialect = "gemini" | "anthropic" | "openai";

/** Sanitise `schema` for one provider dialect. See the module header. */
export function sanitizeSchemaForDialect(
  schema: Record<string, unknown>,
  dialect: SchemaDialect,
): Record<string, unknown> {
  return dialect === "gemini" ? sanitizeGeminiSchema(schema) : sanitizeLightSchema(schema);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Clone a literal value (an enum member, a default, an example) without
 * interpreting it as a schema — its keys are data, not keywords, so no
 * dialect rule applies inside it. Still a deep copy: the result must
 * never alias the shared input.
 */
function deepClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => deepClone(item));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepClone(item);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- Gemini ----

/** The complete keyword set of Google's OpenAPI-subset Schema type. */
const GEMINI_ALLOWED: ReadonlySet<string> = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
  "propertyOrdering",
  "anyOf",
  "default",
  "example",
  "pattern",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
]);

function sanitizeGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Plain allowlisted keywords. The schema-bearing ones (properties,
  // items, anyOf) recurse; the rest are scalars or literal values and
  // are cloned so the result shares no structure with the input.
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type" || key === "allOf" || key === "oneOf" || key === "const") continue;
    if (!GEMINI_ALLOWED.has(key)) continue;
    if (key === "properties") {
      if (isRecord(value)) out[key] = sanitizeGeminiProperties(value);
      continue;
    }
    if (key === "items") {
      out[key] = sanitizeGeminiItems(value);
      continue;
    }
    if (key === "anyOf") {
      if (Array.isArray(value)) out[key] = sanitizeGeminiBranches(value);
      continue;
    }
    out[key] = deepClone(value);
  }

  applyGeminiType(schema["type"], out);

  // `const` has no Gemini form, but a one-member enum says the same thing.
  if ("const" in schema) out["enum"] = [deepClone(schema["const"])];

  // Gemini has anyOf but no oneOf; for tool arguments the union reading
  // is the same, so the branches move over (sanitised on the way).
  const oneOf = schema["oneOf"];
  if (Array.isArray(oneOf)) {
    appendAnyOf(out, sanitizeGeminiBranches(oneOf));
  }

  const allOf = schema["allOf"];
  if (Array.isArray(allOf) && allOf.length > 0) {
    const entries = allOf
      .filter((entry) => isRecord(entry))
      .map((entry) => sanitizeGeminiSchema(entry));
    if (entries.length === 1) {
      mergeGeminiInto(out, entries[0]!);
    } else if (entries.length > 1) {
      if (entries.every((entry) => isMergeableObjectEntry(entry))) {
        mergeGeminiInto(out, mergeObjectEntries(entries));
      } else {
        // Not mergeable into one flat schema: keep the first entry
        // rather than inventing an intersection Gemini cannot express.
        mergeGeminiInto(out, entries[0]!);
      }
    }
  }

  return out;
}

/** `properties` is a name→schema map: the NAMES are data and survive verbatim. */
function sanitizeGeminiProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(properties)) {
    // A boolean schema has no Gemini form; `{}` (anything allowed) is
    // the closest representable approximation for `true`, and is used
    // for `false` too rather than dropping the property entirely.
    out[name] = isRecord(sub) ? sanitizeGeminiSchema(sub) : {};
  }
  return out;
}

function sanitizeGeminiItems(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return sanitizeGeminiSchema(value);
  // Tuple `items` (an array) has no Gemini equivalent — items there is a
  // single schema — so the first entry's schema is kept.
  if (Array.isArray(value)) {
    const first = value.find((item) => isRecord(item));
    return first !== undefined ? sanitizeGeminiSchema(first) : {};
  }
  return {};
}

function sanitizeGeminiBranches(branches: unknown[]): Array<Record<string, unknown>> {
  return branches.map((branch) => (isRecord(branch) ? sanitizeGeminiSchema(branch) : {}));
}

function appendAnyOf(out: Record<string, unknown>, branches: Array<Record<string, unknown>>): void {
  const existing = out["anyOf"];
  out["anyOf"] = [...(Array.isArray(existing) ? existing : []), ...branches];
}

/**
 * Apply the `type` keyword, translating the JSON Schema nullable
 * widening (`["<t>", "null"]`) into Gemini's `nullable` flag.
 */
function applyGeminiType(rawType: unknown, out: Record<string, unknown>): void {
  if (typeof rawType === "string") {
    if (rawType === "null") {
      out["nullable"] = true;
    } else {
      out["type"] = rawType;
    }
    return;
  }
  if (!Array.isArray(rawType)) return;

  const members = rawType.filter((t): t is string => typeof t === "string");
  const nonNull = members.filter((t) => t !== "null");
  if (members.includes("null")) out["nullable"] = true;
  if (nonNull.length === 1) {
    out["type"] = nonNull[0]!;
  } else if (nonNull.length > 1) {
    // No single `type` can name several types; one anyOf branch each
    // preserves the union instead of silently keeping only one member.
    appendAnyOf(
      out,
      nonNull.map((t) => ({ type: t })),
    );
  }
}

/** True when an allOf entry reads as an object schema that can be flattened. */
function isMergeableObjectEntry(entry: Record<string, unknown>): boolean {
  const type = entry["type"];
  if (type !== undefined && type !== "object") return false;
  return type === "object" || "properties" in entry || "required" in entry;
}

/**
 * Flatten several object entries into one: properties and required are
 * unioned, every other keyword is taken from the first entry that sets
 * it (on a conflict there is no flat representation of "both", so the
 * earliest constraint wins and the rest is the documented approximation
 * named in the module header).
 */
function mergeObjectEntries(
  entries: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const entry of entries) {
    for (const [key, value] of Object.entries(entry)) {
      if (key === "properties" && isRecord(value)) {
        const existing = merged["properties"];
        merged["properties"] = { ...(isRecord(existing) ? existing : {}), ...value };
      } else if (key === "required" && Array.isArray(value)) {
        merged["required"] = unionStrings(merged["required"], value);
      } else if (key === "propertyOrdering" && Array.isArray(value)) {
        merged["propertyOrdering"] = unionStrings(merged["propertyOrdering"], value);
      } else if (!(key in merged)) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

/**
 * Merge a sanitised allOf entry into the current level. The current
 * level's own keywords win on conflict (they were stated directly on
 * this schema); properties are combined name by name and required is
 * unioned, since those two merge without contradiction.
 */
function mergeGeminiInto(
  out: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === "properties" && isRecord(value)) {
      const existing = out["properties"];
      out["properties"] =
        isRecord(existing) ? { ...value, ...existing } : { ...value };
    } else if (key === "required" && Array.isArray(value)) {
      out["required"] = unionStrings(out["required"], value);
    } else if (key === "propertyOrdering" && Array.isArray(value)) {
      out["propertyOrdering"] = unionStrings(out["propertyOrdering"], value);
    } else if (!(key in out)) {
      out[key] = value;
    }
  }
}

/** Union of two string lists, first-seen order, either side optional. */
function unionStrings(a: unknown, b: unknown): string[] {
  const out: string[] = [];
  for (const list of [a, b]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === "string" && !out.includes(item)) out.push(item);
    }
  }
  return out;
}

// ------------------------------------------------------- Anthropic / OpenAI ----

/** Meta keywords describing the schema document, not the tool's shape. */
const META_KEYS: ReadonlySet<string> = new Set(["$schema", "$id", "$comment"]);

/** Keywords whose value is a name→schema map (names are data, not keywords). */
const MAP_KEYS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

/** Keywords whose value is a list of schemas. */
const SCHEMA_ARRAY_KEYS: ReadonlySet<string> = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/** Keywords whose value is a single schema (or, for some, a boolean). */
const SINGLE_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "items",
  "additionalProperties",
  "additionalItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "unevaluatedItems",
]);

function sanitizeLightSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (META_KEYS.has(key)) continue;
    if (MAP_KEYS.has(key) && isRecord(value)) {
      const map: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value)) {
        map[name] = isRecord(sub) ? sanitizeLightSchema(sub) : deepClone(sub);
      }
      out[key] = map;
      continue;
    }
    if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      out[key] = value.map((item) => (isRecord(item) ? sanitizeLightSchema(item) : deepClone(item)));
      continue;
    }
    if (SINGLE_SCHEMA_KEYS.has(key)) {
      if (isRecord(value)) {
        out[key] = sanitizeLightSchema(value);
      } else if (Array.isArray(value)) {
        // Legacy tuple form of `items`: a list of schemas.
        out[key] = value.map((item) =>
          isRecord(item) ? sanitizeLightSchema(item) : deepClone(item),
        );
      } else {
        // A boolean schema (e.g. `additionalProperties: true`) is kept as-is.
        out[key] = deepClone(value);
      }
      continue;
    }
    if (key === "enum" || key === "const" || key === "default" || key === "example" || key === "examples") {
      // Literal values, not schemas: cloned verbatim, never interpreted.
      out[key] = deepClone(value);
      continue;
    }
    // Everything else (type, required, description, bounds, and any
    // keyword this module does not enumerate) is kept — with meta keys
    // still stripped from any schema nested inside it.
    out[key] = sanitizeLightValue(value);
  }
  return out;
}

function sanitizeLightValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeLightValue(item));
  if (isRecord(value)) return sanitizeLightSchema(value);
  return value;
}
