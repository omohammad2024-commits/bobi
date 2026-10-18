/**
 * Named provider presets.
 *
 * A preset exists so the owner does not transcribe a URL by hand. Two things
 * have to hold: the preset list must be honest about what it is (a template,
 * not a tested endpoint), and a preset that needs a value substituted must
 * refuse to save until it is.
 */
import { describe, expect, test } from "bun:test";
import {
  isProviderPreset,
  providerPreset,
  PROVIDER_PRESETS,
} from "../src/ai/adapter";
import { encode, decode } from "../src/groups/callbacks";

describe("the preset list", () => {
  test("every preset has a usable base URL or names its placeholder", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.baseUrl.startsWith("https://")).toBe(true);
      // A URL that cannot work as-is must say so, so the panel can warn.
      if (p.baseUrl.includes("{")) {
        expect(p.requiredPlaceholder).toBeDefined();
        expect(p.baseUrl).toContain(`{${p.requiredPlaceholder}}`);
      }
    }
  });

  test("every preset explains what was verified", () => {
    // The list must not imply a live test it did not perform.
    for (const p of PROVIDER_PRESETS) {
      expect(p.note.length).toBeGreaterThan(0);
    }
  });

  test("ids are unique and slug-shaped", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(/^[a-z][a-z0-9-]*$/.test(id)).toBe(true);
  });

  test("lookup by id works, and an unknown id is refused", () => {
    expect(providerPreset("cloudflare")?.label).toBe("Cloudflare Workers AI");
    expect(providerPreset("nope")).toBeUndefined();
    expect(isProviderPreset("openrouter")).toBe(true);
    expect(isProviderPreset("not-a-service")).toBe(false);
  });

  test("the gated services are not offered", () => {
    // OpenCode Zen's free tier refuses requests from outside its own client:
    // "OpenCode's free tier can only be used from within OpenCode". Listing it
    // would send the owner into a wall they cannot get past.
    expect(isProviderPreset("opencode")).toBe(false);
  });
});

describe("preset callbacks", () => {
  test("a preset action round-trips", () => {
    const action = { kind: "ai_add_preset", preset: "cloudflare" } as const;
    const data = encode(action as never);
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    expect(decode(data)).toEqual(action);
  });

  test("every preset can be encoded and decoded", () => {
    for (const p of PROVIDER_PRESETS) {
      const data = encode({ kind: "ai_add_preset", preset: p.id } as never);
      expect(decode(data)).toEqual({ kind: "ai_add_preset", preset: p.id });
    }
  });

  test("an unknown preset never decodes", () => {
    // The slug comes from callback data, which is user-controlled.
    expect(decode("adm:aipr:nope")).toBeUndefined();
    expect(decode("adm:aipr:")).toBeUndefined();
    expect(decode("adm:aipr:cloudflare:extra")).toBeUndefined();
    expect(decode("adm:aipr:'; DROP TABLE ai_providers;--")).toBeUndefined();
  });

  test("preset actions do not collide with adapter actions", () => {
    expect(decode(encode({ kind: "ai_add_adapter", adapter: "gemini" } as never))).toEqual({
      kind: "ai_add_adapter",
      adapter: "gemini",
    });
    expect(decode(encode({ kind: "ai_add_preset", preset: "groq" } as never))).toEqual({
      kind: "ai_add_preset",
      preset: "groq",
    });
  });
});

describe("cloudflare needs its account id", () => {
  test("the placeholder is named, so the panel can say what to substitute", () => {
    const cf = providerPreset("cloudflare")!;
    expect(cf.requiredPlaceholder).toBe("ACCOUNT_ID");
    expect(cf.baseUrl).toContain("{ACCOUNT_ID}");
  });

  test("the URL is a template until it is filled in", () => {
    const cf = providerPreset("cloudflare")!;
    // The literal placeholder is what the form shows; the guard refuses to save
    // it unchanged, so a provider is never created pointing at a broken URL.
    expect(cf.baseUrl).toContain("{ACCOUNT_ID}");
    const filled = cf.baseUrl.replace("{ACCOUNT_ID}", "abc123");
    expect(filled).not.toContain("{");
    expect(filled).toContain("abc123");
  });
});
