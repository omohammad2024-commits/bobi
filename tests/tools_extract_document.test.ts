/**
 * extract_document tool (platform Phase 9) — the document pipeline as a
 * callable tool over the owner's files sandbox.
 *
 * Pins:
 *  - identity / permission / ownerOnly / manifest validity + tiers
 *  - real extraction: .txt decoded directly, a minimal .docx and a minimal
 *    .pdf through the module's own pipeline (fixtures copied from
 *    tests/extract_document.test.ts — the cheap in-test recipes)
 *  - sandbox discipline: missing file (no path echo), traversal, absolute
 *    paths, directories, the 20 MB cap (sparse file)
 *  - unsupported extensions are refused with the supported kinds named
 *  - a corrupt .docx surfaces the pipeline failure as a safe invalid_input
 *  - the 16,000-char output cap cuts at a line boundary and flags truncation
 *  - the owner gate fires for non-owners and unknown identities
 *
 * Every test runs against a fresh temp dir; nothing touches the repo,
 * no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXTRACT_DOCUMENT_PERMISSION,
  MAX_EXTRACT_FILE_BYTES,
  MAX_EXTRACT_OUTPUT_CHARS,
  createExtractDocumentTool,
  extractDocumentManifest,
  DOCX_MIME,
  PDF_MIME,
} from "../src/tools/extract_document";
import { ToolError } from "../src/tools/errors";
import { validateManifest } from "../src/tools/validate_manifest";
import type { ToolContext } from "../src/tools/types";

const isOwner = (userId: string): boolean => userId === "owner";

function ctxFor(userId: string): ToolContext {
  return {
    clock: () => new Date("2026-10-21T12:00:00Z"),
    actor: { userId, permissions: [EXTRACT_DOCUMENT_PERMISSION] },
    signal: new AbortController().signal,
  };
}
const ownerCtx = ctxFor("owner");

const bases: string[] = [];

/** A fresh temp base; the sandbox root lives (not yet created) inside it. */
function freshRoot(): string {
  const base = mkdtempSync(join(tmpdir(), "bobi-extract-tool-"));
  bases.push(base);
  return join(base, "files-area");
}

afterEach(() => {
  for (const dir of bases.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp dir must not fail the suite.
    }
  }
});

function tool(rootDir: string) {
  return createExtractDocumentTool({ rootDir, isOwner });
}

/** Write a fixture into the sandbox, creating parent dirs as needed. */
function put(rootDir: string, rel: string, data: string | Buffer): void {
  const abs = join(rootDir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, data);
}

async function expectToolError(
  p: Promise<unknown>,
  kind: ToolError["kind"],
  message?: string,
): Promise<ToolError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe(kind);
    if (message !== undefined) expect((err as ToolError).message).toBe(message);
    return err as ToolError;
  }
  throw new Error(`expected ToolError(${kind}) but the run succeeded`);
}

// ---------------------------------------------------------------------------
// Fixtures — the cheap recipes from tests/extract_document.test.ts
// ---------------------------------------------------------------------------

interface ZipSpec {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
}

function buildZip(specs: ZipSpec[]): Buffer {
  const fileParts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const spec of specs) {
    const method = spec.method ?? 8;
    const raw =
      method === 8 ? deflateRawSync(Buffer.from(spec.data)) : Buffer.from(spec.data);
    const nameBuf = Buffer.from(spec.name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(spec.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    fileParts.push(local, nameBuf, raw);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(raw.length, 20);
    cen.writeUInt32LE(spec.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += 30 + nameBuf.length + raw.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...fileParts, cd, eocd]);
}

const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const SAMPLE_DOCX = buildZip([
  {
    name: "word/document.xml",
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<w:document xmlns:w="${NS_W}"><w:body>` +
        `<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t xml:space="preserve">Fish &amp; Chips</w:t></w:r></w:p>` +
        `</w:body></w:document>`,
      "utf8",
    ),
  },
]);

/** Minimal hand-rolled single-page PDF with one text line. */
function pdfBytes(text: string): Buffer {
  const esc = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const content = `BT /F1 24 Tf 100 700 Td (${esc}) Tj ET`;
  const offsets: number[] = [];
  let pdf = "%PDF-1.4\n";
  const push = (body: string) => {
    offsets.push(pdf.length);
    pdf += `${offsets.length} 0 obj\n${body}\nendobj\n`;
  };
  push("<< /Type /Catalog /Pages 2 0 R >>");
  push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  push(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  );
  push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("extract_document tool shape", () => {
  test("identity, permission, ownerOnly, tiers, category", () => {
    const t = tool(freshRoot());
    expect(t.name).toBe("extract_document");
    expect(EXTRACT_DOCUMENT_PERMISSION).toBe("tools:extract_document");
    expect(t.permission.requires).toEqual(["tools:extract_document"]);
    expect(t.ownerOnly).toBe(true);
    expect(t.enabled).toBe(true);
    expect(t.manifest).toBe(extractDocumentManifest);
    expect(extractDocumentManifest.latencyTier).toBe("seconds");
    expect(extractDocumentManifest.costTier).toBe("free");
    expect(extractDocumentManifest.category).toBe("media");
    expect(t.input.fields["path"]?.required).toBe(true);
  });

  test("manifest validates and names the specified confusables", () => {
    expect(validateManifest(extractDocumentManifest)).toEqual([]);
    expect(extractDocumentManifest.confusableWith.map((c) => c.tool)).toEqual([
      "files",
      "fetch_url",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

describe("extract_document extraction", () => {
  test("a .txt file is decoded directly, in a nested folder", async () => {
    const root = freshRoot();
    put(root, "notes/hello.txt", "first line\nsecond line\n");
    const out = await tool(root).run({ path: "notes/hello.txt" }, ownerCtx);
    expect(out.name).toBe("hello.txt");
    expect(out.mediaType).toBe("text/plain");
    expect(out.text).toBe("first line\nsecond line\n");
    expect(out.chars).toBe(out.text.length);
    expect(out.truncated).toBe(false);
  });

  test("a .md file maps to text/markdown", async () => {
    const root = freshRoot();
    put(root, "readme.md", "# Title\n");
    const out = await tool(root).run({ path: "readme.md" }, ownerCtx);
    expect(out.mediaType).toBe("text/markdown");
    expect(out.text).toBe("# Title\n");
  });

  test("a minimal .docx goes through the pipeline", async () => {
    const root = freshRoot();
    put(root, "note.docx", SAMPLE_DOCX);
    const out = await tool(root).run({ path: "note.docx" }, ownerCtx);
    expect(out.mediaType).toBe(DOCX_MIME);
    expect(out.text).toBe("Hello world\nFish & Chips");
    expect(out.truncated).toBe(false);
  });

  test("a minimal .pdf goes through the pipeline", async () => {
    const root = freshRoot();
    put(root, "a.pdf", pdfBytes("Hello BOBI pdf test"));
    const out = await tool(root).run({ path: "a.pdf" }, ownerCtx);
    expect(out.mediaType).toBe(PDF_MIME);
    expect(out.text).toContain("Hello BOBI pdf test");
  });

  test("a corrupt .docx surfaces a safe invalid_input, no internals", async () => {
    const root = freshRoot();
    put(root, "broken.docx", Buffer.from("not a zip at all"));
    const err = await expectToolError(
      tool(root).run({ path: "broken.docx" }, ownerCtx),
      "invalid_input",
      "That document is damaged and couldn't be read.",
    );
    expect(err.message).not.toContain("not-a-zip");
    expect(err.message).not.toContain(root);
  });

  test("text over the 16k cap is cut at a line boundary and flagged", async () => {
    const root = freshRoot();
    const line = "x".repeat(99); // 99 chars + \n = 100 per line
    const full = Array.from({ length: 300 }, () => line).join("\n");
    expect(full.length).toBeGreaterThan(MAX_EXTRACT_OUTPUT_CHARS);
    put(root, "big.txt", full);
    const out = await tool(root).run({ path: "big.txt" }, ownerCtx);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(MAX_EXTRACT_OUTPUT_CHARS);
    expect(out.chars).toBe(out.text.length);
    // Cut at a line boundary: the returned text is a prefix of the original
    // and the very next character in the original is the newline.
    expect(full.startsWith(out.text)).toBe(true);
    expect(full[out.text.length]).toBe("\n");
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("extract_document refusals", () => {
  test("unsupported extension names the supported kinds", async () => {
    const root = freshRoot();
    put(root, "data.bin", Buffer.from([1, 2, 3]));
    await expectToolError(
      tool(root).run({ path: "data.bin" }, ownerCtx),
      "invalid_input",
      "Only PDF, Word (.docx), Excel (.xlsx) and plain text (.txt, .md, .csv) files can be extracted.",
    );
  });

  test("missing file is not_found and never echoes the path", async () => {
    const root = freshRoot();
    const err = await expectToolError(
      tool(root).run({ path: "secret-name.pdf" }, ownerCtx),
      "not_found",
      "That file doesn't exist.",
    );
    expect(err.message).not.toContain("secret-name.pdf");
  });

  test("traversal and absolute paths are refused before any read", async () => {
    const root = freshRoot();
    // A real document OUTSIDE the sandbox that traversal would reach.
    const base = join(root, "..");
    writeFileSync(join(base, "outside.pdf"), pdfBytes("outside"));
    await expectToolError(
      tool(root).run({ path: "../outside.pdf" }, ownerCtx),
      "not_allowed",
      "That path is outside the files area.",
    );
    await expectToolError(
      tool(root).run({ path: join(base, "outside.pdf") }, ownerCtx),
      "not_allowed",
    );
  });

  test("a folder wearing a document extension is invalid_input", async () => {
    const root = freshRoot();
    mkdirSync(join(root, "weird.pdf"), { recursive: true });
    await expectToolError(
      tool(root).run({ path: "weird.pdf" }, ownerCtx),
      "invalid_input",
      "That path is a folder, not a document file.",
    );
  });

  test("a file over the 20 MB cap is refused, naming the cap (sparse file)", async () => {
    const root = freshRoot();
    put(root, "huge.txt", "seed");
    truncateSync(join(root, "huge.txt"), MAX_EXTRACT_FILE_BYTES + 1);
    await expectToolError(
      tool(root).run({ path: "huge.txt" }, ownerCtx),
      "invalid_input",
      "That file is larger than the 20 MB limit for extraction.",
    );
  });

  test("a binary file wearing a .txt extension is refused", async () => {
    const root = freshRoot();
    put(root, "fake.txt", Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    await expectToolError(
      tool(root).run({ path: "fake.txt" }, ownerCtx),
      "invalid_input",
      "That file isn't readable text (not valid UTF-8).",
    );
  });

  test("owner gate: non-owner and unknown identity are refused", async () => {
    const root = freshRoot();
    put(root, "a.txt", "hello");
    await expectToolError(
      tool(root).run({ path: "a.txt" }, ctxFor("stranger")),
      "not_allowed",
      "Document extraction is owner only.",
    );
    await expectToolError(
      tool(root).run({ path: "a.txt" }, ctxFor("unknown")),
      "not_allowed",
      "Identity is unknown.",
    );
  });
});
