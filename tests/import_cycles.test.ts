/**
 * Import-cycle gate (platform Phase 5, step H).
 *
 * src/ must stay ACYCLIC. Phase 5's layering (starters → bootstrap /
 * platform facades → core → storage) only holds while no module can
 * reach back up the graph; a single new cycle silently re-couples the
 * layers and makes module evaluation order load-bearing again.
 *
 * This test builds the import graph of every src/**\/*.ts file from
 * filesystem reads only (hermetic, no module is ever loaded), covering:
 *   - static imports:            import ... from "./x", import "./x"
 *   - re-exports:                export ... from "./x"
 *   - dynamic imports:           import("./x")
 * Relative specifiers are resolved against the importing file
 * ("./x" → x.ts or x/index.ts; a ".js" suffix maps to ".ts").
 * Specifiers that do not resolve to a file under the scanned root are
 * ignored: bare package names ("grammy", "bun:sqlite", ...) are not
 * graph nodes, and neither are paths that leave the root (src/bench
 * imports ../../bench/run, which lives outside src/) or examples quoted
 * in doc comments (src/memory/index.ts shows `from "./memory"` as
 * documentation — it resolves to nothing and must not become an edge).
 *
 * Strongly connected components are computed with Tarjan's algorithm.
 * On failure the assertion message NAMES every file in every offending
 * component, so the cycle is debuggable from the test output alone.
 *
 * The fixture tests at the bottom are the gate's self-check: they prove
 * the scanner actually detects a static cycle, an export-from edge, a
 * dynamic-import cycle and a self-import — a scanner that silently
 * stopped extracting specifiers would pass the src/ test while the gate
 * rotted, so the fixtures pin the extraction itself.
 */
import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

// ---------- graph construction ----------

/** Every .ts file under `root`, sorted for deterministic output. */
function collectTsFiles(root: string, dir: string = root, out: string[] = []): string[] {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(root, path, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/**
 * Module specifiers used by one source file: static import (with or
 * without a `from` clause — the side-effect form `import "./x"` has
 * none), export-from, and dynamic import(). Regex extraction over the
 * raw text: quoted specifiers only, so prose cannot produce an edge
 * unless it literally spells an import statement AND the specifier
 * resolves to a real file under the root (see resolveSpecifier).
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bimport\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/**
 * Resolve a relative specifier to a file in `fileSet`, or undefined when
 * it does not name one (outside the root, a non-.ts asset, or a doc
 * example). Tries, in order: the path itself, + ".ts", "/index.ts",
 * and the same with a ".js" suffix rewritten to ".ts".
 */
function resolveSpecifier(
  fromFile: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    join(base, "index.ts"),
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, "/index.ts"),
  ];
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    if (absolute.endsWith(".ts") && fileSet.has(absolute)) return absolute;
  }
  return undefined;
}

/** The import graph: absolute file path → absolute paths it imports. */
function buildGraph(root: string): Map<string, Set<string>> {
  const files = collectTsFiles(root);
  const fileSet = new Set(files.map((f) => resolve(f)));
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const targets = new Set<string>();
    for (const specifier of extractSpecifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      const target = resolveSpecifier(file, specifier, fileSet);
      if (target !== undefined) targets.add(target);
    }
    graph.set(resolve(file), targets);
  }
  return graph;
}

// ---------- Tarjan SCC ----------

/**
 * Cyclic components of the graph: every SCC with more than one file,
 * plus any file that imports itself (a 1-file cycle Tarjan reports as a
 * size-1 SCC, kept only when the self-edge exists). Paths are relative
 * to `root` with forward slashes, sorted inside each component.
 */
function findCycles(root: string): { files: number; edges: number; cycles: string[][] } {
  const graph = buildGraph(root);
  const display = (absolute: string): string =>
    relative(root, absolute).replaceAll("\\", "/");

  let edges = 0;
  for (const targets of graph.values()) edges += targets.size;

  const indexOf = new Map<string, number>();
  const lowlinkOf = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let nextIndex = 0;

  const strongConnect = (v: string): void => {
    indexOf.set(v, nextIndex);
    lowlinkOf.set(v, nextIndex);
    nextIndex += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of graph.get(v) ?? []) {
      if (!indexOf.has(w)) {
        strongConnect(w);
        lowlinkOf.set(v, Math.min(lowlinkOf.get(v)!, lowlinkOf.get(w)!));
      } else if (onStack.has(w)) {
        lowlinkOf.set(v, Math.min(lowlinkOf.get(v)!, indexOf.get(w)!));
      }
    }

    if (lowlinkOf.get(v) === indexOf.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) {
        cycles.push(component.map(display).sort());
      } else if (graph.get(v)?.has(v) === true) {
        cycles.push([display(v)]); // self-import: a cycle of one
      }
    }
  };

  for (const v of graph.keys()) {
    if (!indexOf.has(v)) strongConnect(v);
  }
  cycles.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
  return { files: graph.size, edges, cycles };
}

/** Failure message naming every file in every offending component. */
function cycleMessage(cycles: readonly string[][]): string {
  const parts = cycles.map((component) =>
    component.length === 1
      ? `self-import: ${component[0]}`
      : `cycle: ${component.join(" -> ")} -> ${component[0]}`,
  );
  return (
    `src/ import graph must be acyclic, but ${cycles.length} cyclic ` +
    `component(s) were found: ${parts.join("; ")}. Break the cycle by ` +
    `moving the shared contract to a leaf module (the tools/types / ` +
    `delegate_manifest pattern) instead of importing across the loop.`
  );
}

// ---------- the gate ----------

describe("import cycles: src/ graph", () => {
  test("zero strongly-connected components with more than one file", () => {
    const { files, edges, cycles } = findCycles(SRC_ROOT);
    // Scanner sanity: the gate is meaningless if the walk silently found
    // nothing. Observed at pinning time (Phase 5 step H): 240 files,
    // 951 resolved intra-src edges. Floors, not exact counts, so adding
    // files never breaks this test — only a broken scanner does.
    expect(files).toBeGreaterThanOrEqual(200);
    expect(edges).toBeGreaterThan(files);
    expect(cycles, cycleMessage(cycles)).toEqual([]);
  });
});

// ---------- fixture self-checks (the gate must be able to fail) ----------

function withFixture(
  files: Record<string, string>,
  fn: (root: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "bobi-import-cycles-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(root, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("import cycles: fixture self-checks", () => {
  test("detects a static 2-cycle and an export-from edge into it", () => {
    withFixture(
      {
        // a -> b (static import), b -> a (export-from): one 2-cycle.
        "a.ts": `import { b } from "./b";\nexport const a = b;\n`,
        "b.ts": `export { a } from "./a";\nexport const b = 1;\n`,
        // c reaches the cycle but is not part of it; d is isolated.
        "c.ts": `import { a } from "./a";\nexport const c = a;\n`,
        "d.ts": `export const d = 1;\n`,
      },
      (root) => {
        const { cycles } = findCycles(root);
        expect(cycles).toEqual([["a.ts", "b.ts"]]);
      },
    );
  });

  test("detects a cycle closed by a dynamic import()", () => {
    withFixture(
      {
        "d.ts": `export async function load(): Promise<unknown> {\n  return import("./e");\n}\n`,
        "e.ts": `import { load } from "./d";\nexport const e = load;\n`,
      },
      (root) => {
        const { cycles } = findCycles(root);
        expect(cycles).toEqual([["d.ts", "e.ts"]]);
      },
    );
  });

  test("detects a self-import and resolves ./dir to dir/index.ts", () => {
    withFixture(
      {
        "self.ts": `import { s } from "./self";\nexport const s = 1;\n`,
        // sub/index.ts imports ../top and top imports ./sub (→ sub/index.ts):
        // a 2-cycle that only exists if directory resolution works.
        "top.ts": `import { x } from "./sub";\nexport const top = x;\n`,
        "sub/index.ts": `import { top } from "../top";\nexport const x = top;\n`,
      },
      (root) => {
        const { cycles } = findCycles(root);
        expect(cycles).toEqual([["self.ts"], ["sub/index.ts", "top.ts"]]);
      },
    );
  });

  test("an acyclic fixture (incl. side-effect import) reports no cycles", () => {
    withFixture(
      {
        "x.ts": `import "./y";\nimport { z } from "./z";\nexport const x = z;\n`,
        "y.ts": `import { z } from "./z";\nexport const y = z;\n`,
        "z.ts": `export const z = 1;\n`,
      },
      (root) => {
        const { files, cycles } = findCycles(root);
        expect(files).toBe(3);
        expect(cycles).toEqual([]);
      },
    );
  });
});
