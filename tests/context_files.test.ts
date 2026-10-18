/**
 * Tests for src/context/loader.ts (Phase D3): owner-authored markdown
 * context files with an mtime cache. No network, no Telegram.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContextFileCache,
  contextFilePaths,
  formatContextFiles,
  loadContextFiles,
  CONTEXT_MAX_FILE_BYTES,
  CONTEXT_MAX_TOTAL_CHARS,
} from "../src/context/loader";

let dir = "";
let warnings: { message: string; fields?: Record<string, unknown> }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bobi-context-"));
  warnings = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function warn(message: string, fields?: Record<string, unknown>): void {
  if (fields !== undefined) warnings.push({ message, fields });
  else warnings.push({ message });
}

function write(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("contextFilePaths", () => {
  test("defaults to ./AGENTS.md,./SOUL.md when unset", () => {
    expect(contextFilePaths({})).toEqual(["./AGENTS.md", "./SOUL.md"]);
  });

  test("blank value falls back to the default", () => {
    expect(contextFilePaths({ BOBI_CONTEXT_FILES: "   " })).toEqual([
      "./AGENTS.md",
      "./SOUL.md",
    ]);
  });

  test("parses comma-separated paths and drops blanks", () => {
    expect(
      contextFilePaths({ BOBI_CONTEXT_FILES: "a.md, b.md ,,c.md" }),
    ).toEqual(["a.md", "b.md", "c.md"]);
  });
});

describe("loadContextFiles", () => {
  test("missing files are skipped silently", () => {
    const files = loadContextFiles([join(dir, "nope.md")], { warn });
    expect(files).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("loads files in listed order", () => {
    const a = write("a.md", "# A");
    const b = write("b.md", "# B");
    const files = loadContextFiles([a, b], { warn });
    expect(files.map((f) => f.path)).toEqual([a, b]);
    expect(files[0]!.content).toBe("# A");
    expect(warnings).toEqual([]);
  });

  test("oversize files are skipped with a warning", () => {
    const big = write("big.md", "x".repeat(CONTEXT_MAX_FILE_BYTES + 1));
    const ok = write("ok.md", "fine");
    const files = loadContextFiles([big, ok], { warn });
    expect(files.map((f) => f.path)).toEqual([ok]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.message).toContain("too large");
  });

  test("a file exactly at the byte cap is kept", () => {
    const p = write("edge.md", "x".repeat(CONTEXT_MAX_FILE_BYTES));
    const files = loadContextFiles([p], { warn });
    expect(files.length).toBe(1);
  });

  test("total char cap truncates the crossing file and skips the rest", () => {
    const a = write("a.md", "a".repeat(5000));
    const b = write("b.md", "b".repeat(5000));
    const c = write("c.md", "c".repeat(100));
    const files = loadContextFiles([a, b, c], { warn });
    const total = files.reduce((n, f) => n + f.content.length, 0);
    expect(total).toBeLessThanOrEqual(CONTEXT_MAX_TOTAL_CHARS);
    expect(total).toBe(CONTEXT_MAX_TOTAL_CHARS);
    // b was truncated to fill the remaining room; c never made it in.
    expect(files.map((f) => f.path)).toEqual([a, b]);
    expect(warnings.some((w) => w.message.includes("truncated"))).toBe(true);
    expect(warnings.some((w) => w.message.includes("cap reached"))).toBe(true);
  });
});

describe("formatContextFiles", () => {
  test("sections are headed by basename", () => {
    const text = formatContextFiles([
      { path: "/x/AGENTS.md", content: "rules" },
      { path: "SOUL.md", content: "vibe" },
    ]);
    expect(text).toBe("### AGENTS.md\nrules\n\n### SOUL.md\nvibe");
  });
});

describe("ContextFileCache", () => {
  test("snapshot returns undefined when nothing loads", () => {
    const cache = new ContextFileCache([join(dir, "missing.md")], { warn });
    expect(cache.snapshot()).toBeUndefined();
  });

  test("a file appearing later is picked up", () => {
    const p = join(dir, "late.md");
    const cache = new ContextFileCache([p], { warn });
    expect(cache.snapshot()).toBeUndefined();
    write("late.md", "hello");
    expect(cache.snapshot()).toContain("hello");
  });

  test("re-reads only when mtime changes", () => {
    const p = write("f.md", "v1");
    // Pin to a known whole-millisecond mtime BEFORE the first snapshot, so
    // the recorded state and the re-pinned state can actually be equal
    // (utimesSync cannot set the fractional part statSync may report).
    const t0 = new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000);
    utimesSync(p, t0, t0);
    const cache = new ContextFileCache([p], { warn });

    expect(cache.snapshot()).toContain("v1");

    // Rewrite with the mtime pinned back: the cache must NOT re-read.
    writeFileSync(p, "v2", "utf8");
    utimesSync(p, t0, t0);
    expect(cache.snapshot()).toContain("v1");
    expect(cache.snapshot()).not.toContain("v2");

    // A real mtime change is picked up on the next snapshot.
    writeFileSync(p, "v3", "utf8");
    const later = new Date(Date.now() + 5000);
    utimesSync(p, later, later);
    expect(cache.snapshot()).toContain("v3");
  });

  test("a deleted file drops out of the snapshot", () => {
    const p = write("gone.md", "here");
    const cache = new ContextFileCache([p], { warn });
    expect(cache.snapshot()).toContain("here");
    rmSync(p);
    expect(cache.snapshot()).toBeUndefined();
  });

  test("the returned snapshot string is frozen (no mid-turn swap)", () => {
    const p = write("f.md", "before");
    const cache = new ContextFileCache([p], { warn });
    const snap = cache.snapshot()!;
    writeFileSync(p, "after", "utf8");
    const later = new Date(Date.now() + 5000);
    utimesSync(p, later, later);
    // The old string is untouched; only a NEW snapshot() call sees "after".
    expect(snap).toContain("before");
    expect(snap).not.toContain("after");
    expect(cache.snapshot()).toContain("after");
  });

  test("exposes the configured paths", () => {
    const cache = new ContextFileCache(["x.md", "y.md"]);
    expect(cache.filePaths).toEqual(["x.md", "y.md"]);
  });
});
