/**
 * Phase 7 — one config surface.
 *
 * Pins:
 * 1. GREP GATE: the literal `process.env` appears nowhere under src/
 *    outside src/config/ (and inside config/, only in env.ts).
 * 2. INVENTORY COMPLETENESS: every env-name literal used in src/ is
 *    registered in KNOBS (primary spelling or a chain-derived alias).
 * 3. CHAIN SEMANTICS: the three historical chains resolve exactly as the
 *    pre-Phase-7 implementations did.
 * 4. VALIDATION: invalid typed values are reported; valid ones are not.
 * 5. DEMO: a knob changed through the new surface changes behaviour —
 *    loadConfig reflects BOBI_AI_TIMEOUT_MS, and a per-call kill switch
 *    reflects its variable on the next call, no rewiring.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  KNOBS,
  flagUnlessOff,
  flagUnlessZero,
  knobNames,
  optInFlag,
  readChained,
} from "../src/config/env";
import { loadConfig } from "../src/config/config";
import { validateEnv } from "../src/config/validate";
import { streamingEnabled } from "../src/agent/stream";

const SRC = join(import.meta.dir, "../src");

function* tsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* tsFiles(p);
    else if (entry.name.endsWith(".ts")) yield p;
  }
}

describe("phase 7 grep gate", () => {
  test("process.env lives only in src/config/env.ts", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const rel = file.slice(SRC.length + 1);
      const text = readFileSync(file, "utf8");
      if (!text.includes("process.env")) continue;
      if (rel !== "config/env.ts") offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test("every env-name literal in src/ is registered in KNOBS", () => {
    const registered = new Set<string>();
    for (const knob of KNOBS) for (const n of knobNames(knob)) registered.add(n);
    const used = new Set<string>();
    const pattern = /["'`](BOBI_[A-Z0-9_]+|SOL_[A-Z0-9_]+|TELEGRAM_BOT_TOKEN|OWNER_TELEGRAM_ID|AI_MODEL|AI_MAX_CONCURRENT|AI_KEY_MASTER_KEY|SKILLS_DIR|PORT)["'`]/g;
    for (const file of tsFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(pattern)) used.add(m[1]!);
    }
    const missing = [...used].filter((n) => !registered.has(n)).sort();
    expect(missing).toEqual([]);
  });
});

describe("phase 7 chain semantics (preserved exactly)", () => {
  test("full chain: BOBI_ wins, SOL_ next, bare last", () => {
    expect(readChained({ BOBI_X: "b", SOL_X: "s", X: "bare" }, "X", "full")).toBe("b");
    expect(readChained({ SOL_X: "s", X: "bare" }, "X", "full")).toBe("s");
    expect(readChained({ X: "bare" }, "X", "full")).toBe("bare");
    expect(readChained({}, "X", "full")).toBeUndefined();
  });

  test("prefixed chain: no bare step (video_gen semantics)", () => {
    expect(readChained({ X: "bare" }, "X", "prefixed")).toBeUndefined();
    expect(readChained({ SOL_X: "s" }, "X", "prefixed")).toBe("s");
  });

  test("flag idioms match the historical readers", () => {
    expect(flagUnlessOff(undefined)).toBe(true);
    expect(flagUnlessOff("0")).toBe(false);
    expect(flagUnlessOff(" OFF ")).toBe(false);
    expect(flagUnlessOff("anything")).toBe(true);
    expect(flagUnlessZero(undefined)).toBe(true);
    expect(flagUnlessZero("0")).toBe(false);
    expect(flagUnlessZero(" 0")).toBe(true); // no trimming in this idiom
    expect(optInFlag("yes", false)).toBe(true);
    expect(optInFlag("on", false)).toBe(false);
    expect(optInFlag("on", true)).toBe(true);
  });
});

describe("phase 7 validation", () => {
  test("invalid typed values are reported with the spelling that carried them", () => {
    const problems = validateEnv({
      BOBI_AI_TIMEOUT_MS: "abc",
      BOBI_ENV: "staging",
      BOBI_BREAKER_THRESHOLD: "0",
      SOL_AI_TIMEOUT_MS: "also-bad-but-bobi-wins-so-never-read",
      BOBI_LOG_LEVEL: "info",
    });
    const names = problems.map((p) => p.name).sort();
    expect(names).toEqual(["BOBI_AI_TIMEOUT_MS", "BOBI_BREAKER_THRESHOLD", "BOBI_ENV"]);
  });

  test("secrets and strings are never validated (nor echoed)", () => {
    expect(validateEnv({ BOBI_API_TOKEN: "not-a-number" })).toEqual([]);
    expect(validateEnv({})).toEqual([]);
  });
});

describe("phase 7 demo: change a knob through the new surface, behaviour follows", () => {
  test("loadConfig reflects BOBI_AI_TIMEOUT_MS with the historical clamp", () => {
    expect(loadConfig({ BOBI_AI_TIMEOUT_MS: "45000" } as NodeJS.ProcessEnv).aiTimeoutMs).toBe(45000);
    expect(loadConfig({ BOBI_AI_TIMEOUT_MS: "99999999" } as NodeJS.ProcessEnv).aiTimeoutMs).toBe(600000);
    expect(loadConfig({ SOL_AI_TIMEOUT_MS: "51000" } as NodeJS.ProcessEnv).aiTimeoutMs).toBe(51000);
  });

  test("per-call kill switch reads through the config touchpoint", () => {
    const prev = process.env.BOBI_STREAMING;
    try {
      delete process.env.BOBI_STREAMING;
      expect(streamingEnabled()).toBe(true);
      process.env.BOBI_STREAMING = "0";
      expect(streamingEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.BOBI_STREAMING;
      else process.env.BOBI_STREAMING = prev;
    }
  });
});
