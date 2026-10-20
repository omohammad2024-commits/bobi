/**
 * Provider type ↔ URL mismatch guard (checkProviderUrl).
 *
 * The incident this guards against: a native Gemini base URL stored under
 * the openai_compatible type, so every request POSTed
 * /v1beta/chat/completions to Google's native API and 404'd. The guard is
 * data-driven over known vendor hosts and must NEVER block an unknown or
 * custom endpoint — only a known host paired with the wrong wire format.
 */
import { describe, expect, test } from "bun:test";
import { checkProviderUrl } from "../src/ai/provider_url_guard";

const GEMINI_NATIVE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_OPENAI = "https://generativelanguage.googleapis.com/v1beta/openai/";

describe("checkProviderUrl — Gemini host", () => {
  test("the incident combo is flagged, with the /openai/ suggestion", () => {
    const issue = checkProviderUrl("openai_compatible", GEMINI_NATIVE);
    expect(issue).not.toBeNull();
    expect(issue!.code).toBe("gemini_native_under_openai");
    expect(issue!.suggestion).toBe(GEMINI_OPENAI);
    // The message names BOTH fixes: the Gemini preset and the compat URL.
    expect(issue!.message).toContain("Google Gemini");
    expect(issue!.message).toContain("OpenAI-compatible");
  });

  test("native Gemini type + native URL passes", () => {
    expect(checkProviderUrl("gemini", GEMINI_NATIVE)).toBeNull();
  });

  test("openai_compatible + the /openai/ Gemini URL passes", () => {
    expect(checkProviderUrl("openai_compatible", GEMINI_OPENAI)).toBeNull();
    expect(
      checkProviderUrl(
        "openai_compatible",
        "https://generativelanguage.googleapis.com/v1beta/openai",
      ),
    ).toBeNull();
  });

  test("native Gemini type + the /openai/ URL is flagged the other way", () => {
    const issue = checkProviderUrl("gemini", GEMINI_OPENAI);
    expect(issue).not.toBeNull();
    expect(issue!.suggestion).toBe(GEMINI_NATIVE);
  });
});

describe("checkProviderUrl — Anthropic host", () => {
  test("openai_compatible at api.anthropic.com is flagged toward the native preset", () => {
    const issue = checkProviderUrl("openai_compatible", "https://api.anthropic.com/v1");
    expect(issue).not.toBeNull();
    expect(issue!.message).toContain("Anthropic");
  });

  test("native Anthropic type + Anthropic URL passes", () => {
    expect(checkProviderUrl("anthropic", "https://api.anthropic.com/v1")).toBeNull();
  });
});

describe("checkProviderUrl — native type at another vendor's host", () => {
  test("gemini type at api.openai.com is a mismatch", () => {
    const issue = checkProviderUrl("gemini", "https://api.openai.com/v1");
    expect(issue).not.toBeNull();
    expect(issue!.suggestion).toBe(GEMINI_NATIVE);
  });

  test("anthropic type at the Gemini host is a mismatch", () => {
    const issue = checkProviderUrl("anthropic", GEMINI_NATIVE);
    expect(issue).not.toBeNull();
    expect(issue!.suggestion).toBe("https://api.anthropic.com/v1");
  });

  test("gemini type at api.anthropic.com is a mismatch", () => {
    expect(checkProviderUrl("gemini", "https://api.anthropic.com/v1")).not.toBeNull();
  });

  test("openai_compatible at api.openai.com passes", () => {
    expect(checkProviderUrl("openai_compatible", "https://api.openai.com/v1")).toBeNull();
  });
});

describe("checkProviderUrl — custom endpoints are never blocked", () => {
  test("unknown hosts pass for every adapter type", () => {
    for (const type of ["openai_compatible", "gemini", "anthropic", "nine_router"]) {
      expect(checkProviderUrl(type, "https://llm.internal.example:8443/v1")).toBeNull();
      expect(checkProviderUrl(type, "http://127.0.0.1:11434/v1")).toBeNull();
    }
  });

  test("an unparseable URL is not this guard's problem", () => {
    expect(checkProviderUrl("openai_compatible", "not a url")).toBeNull();
    expect(checkProviderUrl("gemini", "")).toBeNull();
  });
});
