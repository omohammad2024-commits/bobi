/**
 * Bilingual parity tests — the forcing function for «ربات باید دو زبانه باشه».
 *
 * Two string homes exist in this codebase (coordinator convention):
 *
 * 1. CENTRAL PACKS (`src/i18n/fa.ts`, `src/i18n/en.ts`) — shared UI strings
 *    used through `t(key, lang, vars)`. Persian is ground truth; English
 *    mirrors it. `t()` falls back to Persian, then to the key itself.
 * 2. MODULE-LOCAL TABLES (any `*_strings.ts` file under src/) — strings owned
 *    command module, used through that module's `tr(lang, key, vars)`.
 *    Same bilingual guarantee, enforced here rather than by file location.
 *
 * This file guards BOTH homes:
 * - every fa key has an en twin and vice versa (both directions),
 * - no empty translations,
 * - `{placeholder}` sets match between the two languages per key,
 * - every literal `t("key")` call site in src resolves to a pack key,
 * - every `*_strings.ts` table is discovered by glob (no hardcoded list),
 *   so a table added later by another worker is guarded automatically.
 *
 * If you add a user-facing string: add it to BOTH languages of whichever
 * home it lives in, or this test fails. No network, no Telegram.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t, fa, en } from "../src/i18n";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../src");

/** Sorted, unique `{name}` placeholders inside a template. */
function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1] as string))].sort();
}

/** Dotted key shape every pack/table key must follow. */
const KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/** Assert the shared bilingual invariants for one fa/en key→text pair set. */
function assertBilingualPairing(
  faMap: ReadonlyMap<string, string> | Record<string, string>,
  enMap: ReadonlyMap<string, string> | Record<string, string>,
  label: string,
): void {
  const faEntries = new Map(Object.entries(faMap));
  const enEntries = new Map(Object.entries(enMap));

  const faOnly = [...faEntries.keys()].filter((k) => !enEntries.has(k));
  const enOnly = [...enEntries.keys()].filter((k) => !faEntries.has(k));
  expect(`${label}: fa keys missing from en: ${faOnly.join(", ")}`).toBe(`${label}: fa keys missing from en: `);
  expect(`${label}: en keys missing from fa: ${enOnly.join(", ")}`).toBe(`${label}: en keys missing from fa: `);

  for (const [key, faText] of faEntries) {
    expect(KEY_RE.test(key), `${label}: key shape: ${key}`).toBe(true);
    expect(faText.trim().length > 0, `${label}: empty fa value: ${key}`).toBe(true);
    const enText = enEntries.get(key)!;
    expect(enText.trim().length > 0, `${label}: empty en value: ${key}`).toBe(true);
    expect(
      placeholders(enText),
      `${label}: placeholder mismatch for ${key}: fa=${placeholders(faText)} en=${placeholders(enText)}`,
    ).toEqual(placeholders(faText));
  }
}

// ---------------------------------------------------------------------------
// 1. Central packs
// ---------------------------------------------------------------------------

describe("central packs: fa <-> en parity", () => {
  test("key sets are identical in both directions", () => {
    assertBilingualPairing(fa, en, "src/i18n");
  });

  test("t() resolves every central key in both languages", () => {
    for (const key of Object.keys(fa)) {
      expect(t(key, "fa")).toBe(fa[key] as string);
      expect(t(key, "en")).toBe(en[key] as string);
    }
  });

  test("t() falls back to Persian for a key missing in English", () => {
    // Behavioural contract of the fallback chain; not an excuse to ship gaps.
    const probe = "__parity_probe__";
    expect(t(probe, "en")).toBe(probe);
  });
});

// ---------------------------------------------------------------------------
// 2. Every literal t("key") call site resolves to a pack key
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
  test("every literal t(\"key\") in src exists in the fa pack", () => {
    const missing: string[] = [];
    for (const file of allTsFiles(SRC_ROOT)) {
      const src = readFileSync(file, "utf8");
      // t("key", ...) — the \s* covers the multiline call style too.
      // The negative lookbehind skips unrelated identifiers ending in t.
      for (const m of src.matchAll(/(?<![A-Za-z0-9_$])t\(\s*"((?:[^"\\]|\\.)*)"/g)) {
        const key = m[1] as string;
        if (!(key in fa)) missing.push(`${file}: t("${key}")`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("dynamic t() key families are fully covered", async () => {
    // help.cmd.${c.name} — every registered command needs a description.
    const { COMMAND_HELP } = await import("../src/bot/bot");
    for (const c of COMMAND_HELP as readonly { name: string }[]) {
      expect(`help.cmd.${c.name}` in fa, `help.cmd.${c.name}`).toBe(true);
    }
    // lang.label.${value} — langValueForCallback only yields fa|en.
    expect("lang.label.fa" in fa && "lang.label.en" in fa).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Module-local *_strings.ts tables (discovered by glob)
// ---------------------------------------------------------------------------

/**
 * Scan a table file's text, honouring string literals, from the first `{`
 * after `from` to its matching `}`.
 */
function braceRegion(src: string, from: number): string {
  let i = src.indexOf("{", from);
  if (i === -1) throw new Error("no object literal found");
  let depth = 0;
  let inStr: string | null = null;
  let esc = false;
  const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr !== null) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unterminated object literal");
}

/** `"key": "value"` pairs inside an object region. */
function extractPairs(region: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const m of region.matchAll(/"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    pairs.set(m[1] as string, m[2] as string);
  }
  return pairs;
}

interface StringsTable {
  file: string;
  fa: Map<string, string>;
  en: Map<string, string>;
}

/**
 * Parse one `*_strings.ts` file into its fa/en tables.
 *
 * Two shapes are supported (both are the documented module-table pattern):
 * - split tables: `const FA = {...}` / `const EN = {...}` (any capitalisation),
 * - per-key records: `"key": { fa: "...", en: "..." }`.
 */
function parseStringsTable(relPath: string, src: string): StringsTable {
  if (/"\s*:\s*\{\s*fa\s*:/.test(src)) {
    // ---- per-key bilingual records ----
    const fa = new Map<string, string>();
    const en = new Map<string, string>();
    const re =
      /"((?:[^"\\]|\\.)*)"\s*:\s*\{\s*fa\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*en\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*\}/g;
    for (const m of src.matchAll(re)) {
      fa.set(m[1] as string, m[2] as string);
      en.set(m[1] as string, m[3] as string);
    }
    if (fa.size === 0) throw new Error(`${relPath}: per-key shape detected but no records parsed`);
    return { file: relPath, fa, en };
  }
  // ---- split FA/EN tables ----
  const faDecl = src.match(/const\s+(?:FA|fa)\s*[:=]/);
  const enDecl = src.match(/const\s+(?:EN|en)\s*[:=]/);
  if (!faDecl || !enDecl || faDecl.index === undefined || enDecl.index === undefined) {
    throw new Error(`${relPath}: not a recognised *_strings.ts shape (need FA/EN tables or per-key {fa,en} records)`);
  }
  if (!(faDecl.index < enDecl.index)) {
    throw new Error(`${relPath}: fa table must come before the en table`);
  }
  const faRegion = braceRegion(src, faDecl.index);
  const enRegion = braceRegion(src, enDecl.index);
  const fa = extractPairs(faRegion);
  const en = extractPairs(enRegion);
  if (fa.size === 0 || en.size === 0) {
    throw new Error(`${relPath}: empty table parsed (fa=${fa.size}, en=${en.size})`);
  }
  return { file: relPath, fa, en };
}

describe("module-local *_strings.ts tables (glob-discovered)", () => {
  test("every table is fa/en paired, non-empty, and placeholder-consistent", async () => {
    const glob = new Bun.Glob("**/*_strings.ts");
    const files: string[] = [];
    for await (const f of glob.scan({ cwd: SRC_ROOT })) files.push(f);
    // The three Hermes-parity tables exist today; the glob (not this list)
    // is what guards tables added later.
    expect(files.length).toBeGreaterThan(0);

    for (const rel of files.sort()) {
      const src = readFileSync(join(SRC_ROOT, rel), "utf8");
      const table = parseStringsTable(rel, src);
      assertBilingualPairing(table.fa, table.en, rel);

      // Behavioural: the module's tr() serves both languages for every key.
      // A table that cannot even be parsed (e.g. still being written) fails
      // here with the file named, instead of an obscure import error.
      let mod: {
        tr?: (lang: string, key: string, vars?: Record<string, string | number>) => string;
      };
      try {
        mod = (await import(pathToFileURL(join(SRC_ROOT, rel)).href)) as typeof mod;
      } catch (err) {
        throw new Error(
          `${rel}: could not be imported (${err instanceof Error ? err.message : String(err)}). ` +
            `Finish writing the table — every *_strings.ts file must parse and export tr().`,
        );
      }
      expect(typeof mod.tr, `${rel}: must export tr(lang, key, vars)`).toBe("function");
      const tr = mod.tr!;
      for (const key of table.fa.keys()) {
        const faText = tr("fa", key);
        const enText = tr("en", key);
        expect(typeof faText === "string" && faText.length > 0, `${rel}: tr("fa", ${key})`).toBe(true);
        expect(typeof enText === "string" && enText.length > 0, `${rel}: tr("en", ${key})`).toBe(true);
      }
      // Unknown keys degrade to the key itself, never to a blank reply.
      expect(tr("fa", "__parity_missing_key__")).toBe("__parity_missing_key__");
    }
  });
});
