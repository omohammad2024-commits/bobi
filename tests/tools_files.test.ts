/**
 * files tool — sandboxed read/write/list/send over the owner's files area.
 *
 * Pins:
 *  - list/read/write/append/delete round-trips, incl. nested paths
 *  - the root is created lazily on first use
 *  - traversal is refused: ../x, absolute paths, nested a/../../x, and
 *    symlinks (dir and file) pointing outside the root
 *  - read refuses oversize and binary files with an honest send hint
 *  - write refuses content over the 256 KB cap
 *  - send rides out-of-band via extractMedia as a document part with the
 *    right name/bytes; the model-facing data stays free of base64
 *  - delete refuses directories (no recursive dir delete)
 *  - the manifest validates, and the ownerOnly defence-in-depth check
 *    fires when an isOwner predicate is supplied (goals.ts pattern)
 *
 * Every test runs against a fresh temp dir; nothing touches the repo.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FILES_PERMISSION,
  MAX_LIST_ENTRIES,
  MAX_TEXT_BYTES,
  createFilesTool,
  filesManifest,
} from "../src/tools/files";
import { ToolError } from "../src/tools/errors";
import { validateManifest } from "../src/tools/validate_manifest";
import type { Tool, ToolContext } from "../src/tools/types";

const ctx: ToolContext = {
  clock: () => new Date("2026-10-21T12:00:00Z"),
  actor: { userId: "owner", permissions: [FILES_PERMISSION] },
  signal: new AbortController().signal,
};

const roots: string[] = [];

/** A fresh, not-yet-created sandbox root inside a fresh temp dir. */
function freshRoot(): string {
  const base = mkdtempSync(join(tmpdir(), "bobi-files-"));
  roots.push(base);
  return join(base, "files-area");
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp dir must not fail the suite.
    }
  }
});

function tool(rootDir: string): Tool<any, any> {
  return createFilesTool({ rootDir }) as Tool<any, any>;
}

async function expectToolError(
  p: Promise<unknown>,
  kind: ToolError["kind"],
  message?: string,
): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe(kind);
    if (message !== undefined) expect((err as ToolError).message).toBe(message);
    return;
  }
  throw new Error(`expected ToolError(${kind}) but the run succeeded`);
}

describe("files tool shape", () => {
  test("identity, permission, ownerOnly, tiers", () => {
    const t = tool(freshRoot());
    expect(t.name).toBe("files");
    expect(FILES_PERMISSION).toBe("tools:files");
    expect(t.permission.requires).toEqual(["tools:files"]);
    expect(t.ownerOnly).toBe(true);
    expect(t.enabled).toBe(true);
    expect(t.toolset).toBe("system");
    expect(filesManifest.category).toBe("system");
    expect(filesManifest.latencyTier).toBe("instant");
    expect(filesManifest.costTier).toBe("free");
    expect(t.input.fields["action"]?.choices).toEqual([
      "list",
      "read",
      "write",
      "append",
      "delete",
      "send",
    ]);
  });

  test("manifest validates and only references real catalog ids", () => {
    expect(validateManifest(filesManifest)).toEqual([]);
    expect(filesManifest.confusableWith.map((c) => c.tool)).toEqual(["download_media"]);
  });
});

describe("round-trips", () => {
  test("write → read → append → list → delete", async () => {
    const root = freshRoot();
    const t = tool(root);

    const w = await t.run({ action: "write", path: "notes/todo.txt", content: "buy milk" }, ctx);
    expect(w).toEqual({ action: "write", path: "notes/todo.txt", sizeBytes: 8 });
    expect(readFileSync(join(root, "notes/todo.txt"), "utf8")).toBe("buy milk");

    const a = await t.run({ action: "append", path: "notes/todo.txt", content: "\nand eggs" }, ctx);
    expect(a.sizeBytes).toBe(17);

    const r = await t.run({ action: "read", path: "notes/todo.txt" }, ctx);
    expect(r).toEqual({
      action: "read",
      path: "notes/todo.txt",
      content: "buy milk\nand eggs",
      sizeBytes: 17,
    });

    const l = await t.run({ action: "list", path: "notes" }, ctx);
    expect(l.path).toBe("notes");
    expect(l.entries).toEqual([{ name: "todo.txt", kind: "file", sizeBytes: 17 }]);
    expect(l.count).toBe(1);

    const d = await t.run({ action: "delete", path: "notes/todo.txt" }, ctx);
    expect(d).toEqual({ action: "delete", path: "notes/todo.txt", deleted: true });
    expect(existsSync(join(root, "notes/todo.txt"))).toBe(false);
    await expectToolError(t.run({ action: "read", path: "notes/todo.txt" }, ctx), "not_found");
  });

  test("write overwrites; append creates a missing file", async () => {
    const root = freshRoot();
    const t = tool(root);
    await t.run({ action: "write", path: "a.txt", content: "first" }, ctx);
    await t.run({ action: "write", path: "a.txt", content: "second" }, ctx);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("second");
    await t.run({ action: "append", path: "new.txt", content: "born by append" }, ctx);
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("born by append");
  });

  test("root is created lazily; list of the root defaults and shows dirs", async () => {
    const root = freshRoot();
    const t = tool(root);
    expect(existsSync(root)).toBe(false);
    const empty = await t.run({ action: "list" }, ctx);
    expect(existsSync(root)).toBe(true);
    expect(empty).toMatchObject({ action: "list", path: ".", entries: [], count: 0 });

    await t.run({ action: "write", path: "sub/deep/f.txt", content: "x" }, ctx);
    const l = await t.run({ action: "list", path: "" }, ctx);
    expect(l.entries).toEqual([{ name: "sub", kind: "dir", sizeBytes: 0 }]);
  });

  test("list caps at 200 entries and flags truncation", async () => {
    const root = freshRoot();
    const t = tool(root);
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < MAX_LIST_ENTRIES + 5; i++) {
      writeFileSync(join(root, `f${String(i).padStart(3, "0")}.txt`), "x");
    }
    const l = await t.run({ action: "list" }, ctx);
    expect(l.entries).toHaveLength(MAX_LIST_ENTRIES);
    expect(l.count).toBe(MAX_LIST_ENTRIES);
    expect(l.truncated).toBe(true);
  });

  test("list on a file, read on a dir → invalid_input", async () => {
    const root = freshRoot();
    const t = tool(root);
    await t.run({ action: "write", path: "d/f.txt", content: "x" }, ctx);
    await expectToolError(t.run({ action: "list", path: "d/f.txt" }, ctx), "invalid_input");
    await expectToolError(t.run({ action: "read", path: "d" }, ctx), "invalid_input");
  });
});

describe("sandbox escapes", () => {
  const OUTSIDE = "That path is outside the files area.";

  test("dot-dot, absolute and nested escapes are refused for every action", async () => {
    const root = freshRoot();
    const t = tool(root);
    await expectToolError(t.run({ action: "read", path: "../x" }, ctx), "not_allowed", OUTSIDE);
    await expectToolError(
      t.run({ action: "read", path: "/etc/passwd" }, ctx),
      "not_allowed",
      OUTSIDE,
    );
    await expectToolError(
      t.run({ action: "read", path: "a/../../x" }, ctx),
      "not_allowed",
      OUTSIDE,
    );
    await expectToolError(
      t.run({ action: "write", path: "../evil.txt", content: "x" }, ctx),
      "not_allowed",
      OUTSIDE,
    );
    await expectToolError(
      t.run({ action: "delete", path: "../x" }, ctx),
      "not_allowed",
      OUTSIDE,
    );
    await expectToolError(t.run({ action: "list", path: ".." }, ctx), "not_allowed", OUTSIDE);
    await expectToolError(
      t.run({ action: "send", path: "../x" }, ctx),
      "not_allowed",
      OUTSIDE,
    );
    // Nothing was written outside (or inside) by the refused write.
    expect(existsSync(join(root, "..", "evil.txt"))).toBe(false);
  });

  test("a symlinked dir or file pointing outside is refused", async () => {
    const base = mkdtempSync(join(tmpdir(), "bobi-files-link-"));
    roots.push(base);
    const root = join(base, "area");
    const outsideDir = join(base, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "secret.txt"), "top secret");
    symlinkSync(outsideDir, join(root, "linkdir"));
    symlinkSync(join(outsideDir, "secret.txt"), join(root, "linkfile.txt"));

    const t = tool(root);
    await expectToolError(
      t.run({ action: "read", path: "linkdir/secret.txt" }, ctx),
      "not_allowed",
      OUTSIDE,
    );
    await expectToolError(
      t.run({ action: "read", path: "linkfile.txt" }, ctx),
      "not_allowed",
      OUTSIDE,
    );
    await expectToolError(
      t.run({ action: "write", path: "linkdir/new.txt", content: "x" }, ctx),
      "not_allowed",
      OUTSIDE,
    );
    await expectToolError(
      t.run({ action: "send", path: "linkfile.txt" }, ctx),
      "not_allowed",
      OUTSIDE,
    );
    expect(existsSync(join(outsideDir, "new.txt"))).toBe(false);
  });

  test("an in-sandbox `a/../b` path that stays inside is allowed", async () => {
    const root = freshRoot();
    const t = tool(root);
    await t.run({ action: "write", path: "a/../b.txt", content: "ok" }, ctx);
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("ok");
  });
});

describe("caps", () => {
  test("write over 256 KB is refused; exactly 256 KB is fine", async () => {
    const root = freshRoot();
    const t = tool(root);
    await expectToolError(
      t.run({ action: "write", path: "big.txt", content: "x".repeat(MAX_TEXT_BYTES + 1) }, ctx),
      "invalid_input",
    );
    expect(existsSync(join(root, "big.txt"))).toBe(false);
    const ok = await t.run(
      { action: "write", path: "max.txt", content: "x".repeat(MAX_TEXT_BYTES) },
      ctx,
    );
    expect(ok.sizeBytes).toBe(MAX_TEXT_BYTES);
  });

  test("read of an oversize text file points at send", async () => {
    const root = freshRoot();
    const t = tool(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "big.txt"), "x".repeat(MAX_TEXT_BYTES + 1));
    await expectToolError(
      t.run({ action: "read", path: "big.txt" }, ctx),
      "invalid_input",
      "That file is too large to read as text (over 256 KB); use send to deliver it.",
    );
  });

  test("read of a binary file is refused as invalid_input", async () => {
    const root = freshRoot();
    const t = tool(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00]));
    try {
      await t.run({ action: "read", path: "blob.bin" }, ctx);
      throw new Error("expected the read to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).kind).toBe("invalid_input");
      expect((err as ToolError).message).toContain("use send to deliver it");
    }
  });

  test("delete refuses a directory", async () => {
    const root = freshRoot();
    const t = tool(root);
    await t.run({ action: "write", path: "dir/f.txt", content: "x" }, ctx);
    await expectToolError(t.run({ action: "delete", path: "dir" }, ctx), "invalid_input");
    expect(existsSync(join(root, "dir/f.txt"))).toBe(true);
  });
});

describe("send", () => {
  test("extractMedia returns a document part; data carries no base64", async () => {
    const root = freshRoot();
    const t = tool(root);
    const payload = Buffer.from("hello files area", "utf8");
    await t.run({ action: "write", path: "docs/hello.txt", content: payload.toString("utf8") }, ctx);

    const data = await t.run({ action: "send", path: "docs/hello.txt" }, ctx);
    expect(data).toEqual({ action: "send", sent: true, name: "hello.txt", sizeBytes: payload.length });
    expect(JSON.stringify(data)).not.toContain(payload.toString("base64"));

    const media = t.extractMedia!(data);
    expect(media).toHaveLength(1);
    const part = media![0]!;
    expect(part.type).toBe("document");
    if (part.type !== "document") return;
    expect(part.name).toBe("hello.txt");
    expect(part.mediaType).toBe("text/plain");
    expect(Buffer.from(part.base64, "base64")).toEqual(payload);
  });

  test("send guesses media type from extension, defaulting to octet-stream", async () => {
    const root = freshRoot();
    const t = tool(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "pic.png"), Buffer.from([0x89, 0x50]));
    writeFileSync(join(root, "mystery.zzz"), Buffer.from([1, 2, 3]));
    const png = await t.run({ action: "send", path: "pic.png" }, ctx);
    expect(t.extractMedia!(png)![0]).toMatchObject({ mediaType: "image/png", name: "pic.png" });
    const zzz = await t.run({ action: "send", path: "mystery.zzz" }, ctx);
    expect(t.extractMedia!(zzz)![0]).toMatchObject({
      mediaType: "application/octet-stream",
      name: "mystery.zzz",
    });
  });

  test("send of a missing file → not_found; of a dir → invalid_input", async () => {
    const root = freshRoot();
    const t = tool(root);
    await expectToolError(t.run({ action: "send", path: "nope.txt" }, ctx), "not_found");
    await t.run({ action: "write", path: "d/f.txt", content: "x" }, ctx);
    await expectToolError(t.run({ action: "send", path: "d" }, ctx), "invalid_input");
  });

  test("non-send results produce no media", async () => {
    const root = freshRoot();
    const t = tool(root);
    const data = await t.run({ action: "write", path: "a.txt", content: "x" }, ctx);
    expect(t.extractMedia!(data)).toBeUndefined();
  });
});

describe("owner defence in depth (isOwner dep, goals.ts pattern)", () => {
  test("a supplied predicate refuses non-owners and unknown ids in run()", async () => {
    const root = freshRoot();
    const t = createFilesTool({
      rootDir: root,
      isOwner: (id) => id === "owner",
    }) as Tool<any, any>;
    await expectToolError(
      t.run({ action: "list" }, { ...ctx, actor: { userId: "intruder", permissions: [FILES_PERMISSION] } }),
      "not_allowed",
    );
    await expectToolError(
      t.run({ action: "list" }, { ...ctx, actor: { userId: "unknown", permissions: [FILES_PERMISSION] } }),
      "not_allowed",
    );
    const ok = await t.run({ action: "list" }, ctx);
    expect(ok.action).toBe("list");
  });
});
