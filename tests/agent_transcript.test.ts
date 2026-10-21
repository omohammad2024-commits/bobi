import { describe, expect, test } from "bun:test";
import {
  describeMediaForModel,
  truncateJsonForModel,
  MAX_RESULT_CHARS,
} from "../src/agent/transcript";
import type { ContentPart } from "../src/ai/provider";

// ---------- structure-aware truncation (§4.7) ----------

describe("truncateJsonForModel", () => {
  test("a small result is returned byte-identical", () => {
    const data = { a: 1, b: [1, 2, 3], s: "hi", nested: { ok: true } };
    expect(truncateJsonForModel(data)).toBe(JSON.stringify(data));
    expect(truncateJsonForModel("short")).toBe(JSON.stringify("short"));
    expect(truncateJsonForModel(42)).toBe("42");
    expect(truncateJsonForModel(null)).toBe("null");
  });

  test("a huge string field: valid JSON, marker on the object root, fits", () => {
    const data = { title: "x".repeat(50_000), n: 1 };
    const originalChars = JSON.stringify(data).length;
    const out = truncateJsonForModel(data);
    expect(out.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    const parsed = JSON.parse(out) as {
      title: string;
      n: number;
      truncated: { fields: string[]; originalChars: number };
    };
    expect(parsed.n).toBe(1);
    expect(parsed.truncated.originalChars).toBe(originalChars);
    expect(parsed.truncated.fields).toContain("title");
    // The clip note lives INSIDE the string, so the JSON stayed valid.
    expect(parsed.title).toContain("[truncated: 50000 chars total]");
    expect(parsed.title.startsWith("x")).toBe(true);
  });

  test("deep nesting still parses and fits", () => {
    let deep: unknown = { v: "leaf" };
    for (let i = 0; i < 50; i++) deep = { a: deep, s: "y".repeat(300) };
    const out = truncateJsonForModel(deep);
    expect(out.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    const parsed = JSON.parse(out) as { truncated: { originalChars: number } };
    expect(parsed.truncated.originalChars).toBeGreaterThan(MAX_RESULT_CHARS);
  });

  test("an array-of-objects root is wrapped with fields [\"$\"]", () => {
    const data = Array.from({ length: 500 }, (_, i) => ({ i, txt: "z".repeat(200) }));
    const out = truncateJsonForModel(data);
    expect(out.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    const parsed = JSON.parse(out) as {
      truncated_result: unknown[];
      truncated: { fields: string[]; originalChars: number };
    };
    expect(Array.isArray(parsed.truncated_result)).toBe(true);
    expect(parsed.truncated_result.length).toBeLessThan(500);
    expect(parsed.truncated.fields).toEqual(["$"]);
    expect(parsed.truncated.originalChars).toBe(JSON.stringify(data).length);
  });

  test("a string root is wrapped, with the clip note inside the string", () => {
    const out = truncateJsonForModel("q".repeat(100_000));
    expect(out.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    const parsed = JSON.parse(out) as {
      truncated_result: string;
      truncated: { fields: string[]; originalChars: number };
    };
    expect(typeof parsed.truncated_result).toBe("string");
    expect(parsed.truncated_result).toContain("[truncated: 100000 chars total]");
    expect(parsed.truncated.fields).toEqual(["$"]);
    expect(parsed.truncated.originalChars).toBe(100_002);
  });

  test("a number root that cannot fit degrades to the bare marker object", () => {
    // Numbers pass through unclipped, so with a tiny cap even the wrapper
    // cannot fit: the minimal structural form is the bare marker, which
    // still parses and still reports the original size.
    const out = truncateJsonForModel(123456789012345, 10);
    const parsed = JSON.parse(out) as {
      truncated: { fields: string[]; originalChars: number };
    };
    expect(parsed.truncated.fields).toEqual(["$"]);
    expect(parsed.truncated.originalChars).toBe(15);
  });

  test("a long array field records its dotted path on the object root", () => {
    const data = { items: Array.from({ length: 300 }, (_, i) => ({ i })), keep: "yes" };
    const out = truncateJsonForModel(data, 2_000);
    expect(out.length).toBeLessThanOrEqual(2_000);
    const parsed = JSON.parse(out) as {
      items: unknown[];
      keep: string;
      truncated: { fields: string[] };
    };
    expect(parsed.keep).toBe("yes");
    expect(parsed.items.length).toBeLessThan(300);
    expect(parsed.truncated.fields).toContain("items");
  });

  test("a custom maxChars is honoured", () => {
    const out = truncateJsonForModel({ data: "y".repeat(5_000) }, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test("circular data keeps the could-not-be-displayed fallback", () => {
    const circ: Record<string, unknown> = {};
    circ["self"] = circ;
    expect(truncateJsonForModel(circ)).toBe("(result could not be displayed)");
  });

  test("the output is never cut mid-JSON the way the old slice was", () => {
    const data = { rows: Array.from({ length: 100 }, (_, i) => ({ i, v: "r".repeat(150) })) };
    const out = truncateJsonForModel(data);
    expect(out.endsWith("}")).toBe(true);
    expect(out).not.toContain("…(truncated)");
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

// ---------- media description handles (§4.7) ----------

describe("describeMediaForModel", () => {
  test("image: kind, media type and approximate size", () => {
    // 114688 base64 chars ≈ 86016 bytes = 84 KB.
    const part: ContentPart = { type: "image", mediaType: "image/png", base64: "A".repeat(114_688) };
    expect(describeMediaForModel(part)).toBe("image (image/png, ~84 KB)");
  });

  test("audio: kind, media type and approximate size", () => {
    // 16384 base64 chars ≈ 12288 bytes = 12 KB.
    const part: ContentPart = { type: "audio", mediaType: "audio/ogg", base64: "A".repeat(16_384) };
    expect(describeMediaForModel(part)).toBe("audio (audio/ogg, ~12 KB)");
  });

  test("document with a name quotes the name", () => {
    // 313000 base64 chars ≈ 234750 bytes ≈ 229.2 KB.
    const part: ContentPart = {
      type: "document",
      mediaType: "application/pdf",
      base64: "A".repeat(313_000),
      name: "name.pdf",
    };
    expect(describeMediaForModel(part)).toBe('document "name.pdf" (application/pdf, ~229.2 KB)');
  });

  test("document without a name omits it", () => {
    // 4000 base64 chars = 3000 bytes ≈ 2.9 KB.
    const part: ContentPart = { type: "document", mediaType: "application/pdf", base64: "A".repeat(4_000) };
    expect(describeMediaForModel(part)).toBe("document (application/pdf, ~2.9 KB)");
  });

  test("megabyte sizes format as MB with one decimal", () => {
    // 2097152 base64 chars = 1572864 bytes = 1.5 MB.
    const part: ContentPart = { type: "image", mediaType: "image/jpeg", base64: "A".repeat(2_097_152) };
    expect(describeMediaForModel(part)).toBe("image (image/jpeg, ~1.5 MB)");
  });

  test("a handle never contains base64 content", () => {
    const part: ContentPart = { type: "image", mediaType: "image/png", base64: "QUJD".repeat(10_000) };
    const handle = describeMediaForModel(part);
    expect(handle).not.toContain("QUJD");
    expect(handle).not.toContain("\n");
  });
});
