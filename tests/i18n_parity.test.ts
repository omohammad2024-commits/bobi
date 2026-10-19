/**
 * English-only parity tests — the forcing function for «the UI is English».
 *
 * English-only since v1.0: there is a single central pack (`src/i18n/en.ts`).
 * This file guards it:
 * - every key has a valid shape and a non-empty value,
 * - no value contains Persian/Arabic script,
 * - every literal `t("key")` call site in src resolves to a pack key,
 * - dynamic key families (`help.cmd.<name>`) are fully covered.
 *
 * Module-local `*_strings.ts` tables are their owners' responsibility now;
 * each module's own tests assert its English copy.
 *
 * No network, no Telegram.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { t, en } from "../src/i18n";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../src");

/** Persian/Arabic script block — must never appear in user-facing copy. */
const ARABIC_RE = /[\u0600-\u06FF]/u;

/** Dotted key shape every pack key must follow. */
const KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

describe("central en pack", () => {
  test("keys are well-shaped and values are non-empty", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(KEY_RE.test(key), `key shape: ${key}`).toBe(true);
      expect(value.trim().length > 0, `empty value: ${key}`).toBe(true);
    }
  });

  test("no value contains Persian/Arabic script", () => {
    const hits = Object.entries(en)
      .filter(([, v]) => ARABIC_RE.test(v))
      .map(([k]) => k);
    expect(hits).toEqual([]);
  });

  test("t() resolves every central key", () => {
    for (const key of Object.keys(en)) {
      expect(t(key, "en")).toBe(en[key] as string);
    }
  });

  test("unknown keys degrade to the key itself, never blank", () => {
    expect(t("__parity_probe__", "en")).toBe("__parity_probe__");
  });
});

// ---------------------------------------------------------------------------
// Every literal t("key") call site resolves to a pack key
// ---------------------------------------------------------------------------

/** All .ts files under src/, recursively. */
function allTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...allTsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("t() call-site coverage", () => {
  test("every literal t(\"key\") in src exists in the en pack", () => {
    const missing: string[] = [];
    for (const file of allTsFiles(SRC_ROOT)) {
      const src = readFileSync(file, "utf8");
      // t("key", ...) — the \s* covers the multiline call style too.
      // The negative lookbehind skips unrelated identifiers ending in t.
      // Template-literal keys (t(`help.cmd.${c.name}`)) are covered by the
      // dynamic-family test below.
      for (const m of src.matchAll(/(?<![A-Za-z0-9_$])t\(\s*"((?:[^"\\]|\\.)*)"/g)) {
        const key = m[1] as string;
        if (!(key in en)) missing.push(`${file}: t("${key}")`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("dynamic t() key families are fully covered", async () => {
    // help.cmd.${c.name} — every registered command needs a description.
    const { COMMAND_HELP } = await import("../src/bot/bot");
    for (const c of COMMAND_HELP as readonly { name: string }[]) {
      expect(`help.cmd.${c.name}` in en, `help.cmd.${c.name}`).toBe(true);
    }
    // error.tool.${kind} — every tool error kind renders.
    for (const kind of [
      "invalid_input",
      "not_found",
      "disabled",
      "not_allowed",
      "timeout",
      "aborted",
      "overloaded",
      "invalid_result",
      "internal",
    ]) {
      expect(`error.tool.${kind}` in en, `error.tool.${kind}`).toBe(true);
    }
  });
});
