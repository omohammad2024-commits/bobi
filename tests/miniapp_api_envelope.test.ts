/**
 * Miniapp api.js envelope rule (Phase 2, C1).
 *
 * Loads the REAL src/miniapp/web/api.js with a stubbed fetch (the pattern
 * proven by the Phase 1 audit repro) and pins the wire contract:
 *   (a) { ok:false, error }  → throws an Error carrying the REAL message,
 *       with .code / .suggestion attached when present.
 *   (b) { ok:false } with NO error field is a domain result (probe /
 *       model-test failure) → returned to the caller untouched.
 *   (c) A success body passes through.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const API_JS = fs.readFileSync(
  path.join(import.meta.dir, "../src/miniapp/web/api.js"),
  "utf8",
);

function loadApi(body: unknown) {
  const g = globalThis as Record<string, unknown>;
  g.window = g;
  g.Telegram = undefined;
  g.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  });
  // The IIFE attaches window.MiniApi (= globalThis.MiniApi here).
  eval(API_JS);
  return (g.MiniApi as { apiCall: (e: string, p?: unknown) => Promise<any> })
    .apiCall;
}

describe("miniapp api.js envelope rule", () => {
  test("(a) ok:false WITH error throws the real message + code + suggestion", async () => {
    const apiCall = loadApi({
      ok: false,
      error: {
        code: "url_type_mismatch",
        message:
          "This address is the native Gemini API, but the provider type is OpenAI-compatible.",
        suggestion:
          "Use https://generativelanguage.googleapis.com/v1beta/openai/ or the Google Gemini preset.",
      },
    });
    let caught: any = null;
    try {
      await apiCall("providers.add", {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toContain("native Gemini API");
    expect(caught.message).not.toBe("Server error");
    expect(caught.code).toBe("url_type_mismatch");
    expect(caught.suggestion).toContain("/openai/");
  });

  test("(a2) ok:false with a string error throws that string", async () => {
    const apiCall = loadApi({ ok: false, error: "Provider not found." });
    let caught: any = null;
    try {
      await apiCall("providers.probe", { id: 1 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe("Provider not found.");
  });

  test("(b) ok:false domain body (probe failure) is returned untouched", async () => {
    const probeBody = {
      ok: false,
      latencyMs: 812,
      atMs: 1760000000000,
      status: 404,
      message: "Service response was invalid.",
      ping: { ok: false, latencyMs: 812, error: "Service response was invalid." },
      real: { ok: false, error: "Service response was invalid." },
    };
    const apiCall = loadApi(probeBody);
    const r = await apiCall("providers.probe", { id: 1 });
    expect(r).toEqual(probeBody);
    expect(r.message).toBe("Service response was invalid.");
    expect(r.status).toBe(404);
    expect(r.ping.ok).toBe(false);
  });

  test("(c) success body passes through", async () => {
    const okBody = { ok: true, latencyMs: 5, message: "Connection succeeded." };
    const apiCall = loadApi(okBody);
    const r = await apiCall("providers.probe", { id: 1 });
    expect(r).toEqual(okBody);
  });
});
