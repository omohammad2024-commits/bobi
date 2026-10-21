/**
 * Document text extraction — a LOCAL fallback for document attachments.
 *
 * When the active AI provider cannot read documents natively
 * (`AdapterCapabilities.documentInput === false`), the coordinator runs
 * `maybeExtractDocuments` over the message parts BEFORE the request is built:
 * a .docx/.xlsx/.pdf the model could not otherwise see becomes plain text the
 * model can read. When the provider DOES support documents, parts pass through
 * untouched — native support is always preferred.
 *
 * SECURITY MODEL:
 * - The document comes from the USER's own message, so it is untrusted input.
 *   Everything it yields is treated as DATA (wrapped as tool/message text),
 *   never as instructions. The text is scraped, not interpreted: no scripts,
 *   no macros, no embedded objects are ever executed or even read.
 * - ZIP parsing is manual and bounded (see the guards below): a hostile file
 *   cannot exhaust memory via a zip bomb, and a corrupt file yields an honest
 *   `{ok:false}` instead of an exception.
 * - No XML parser is used on purpose. OOXML parts are machine-generated with
 *   a fixed schema, and the text we need lives in `<w:t>` / `<t>` runs.
 *   Pulling in an XML parser would add a dependency and an XXE/DTD attack
 *   surface for no benefit — targeted regex scraping of these known elements
 *   is sufficient, and malformed XML simply yields less text.
 * - PDFs are parsed with pdf-parse (pure JS, no native deps; verified working
 *   under Bun). A PDF that fails to parse yields `{ok:false}` — the caller
 *   keeps the original document part, so nothing is silently dropped.
 *
 * This module is intentionally dependency-free with respect to the bot: pure
 * functions only, no imports from bot/storage/provider code. The coordinator
 * wires `maybeExtractDocuments` into the pipeline at merge time.
 */
import { PDFParse } from "pdf-parse";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { ToolError } from "./errors";
import { ensureSandboxRoot, resolveSandboxPath } from "./sandbox";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";
import type { Tool, ToolContext } from "./types";

/**
 * Structural mirror of the provider's ContentPart union, defined locally so
 * this module imports nothing from the ai/ tree. Assignable both ways with
 * the real ContentPart.
 */
export type DocPipelinePart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; base64: string }
  | { type: "audio"; mediaType: string; base64: string }
  | { type: "document"; mediaType: string; base64: string; name?: string };

export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PDF_MIME = "application/pdf";

export type ExtractResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Stable machine-readable failure reasons. The Persian UI copy lives with the
 * caller; these strings are for logs and tests.
 */
export type ExtractFailureReason =
  | "unsupported-type"
  | "not-a-zip"
  | "zip-too-many-entries"
  | "zip-entry-too-large"
  | "zip-total-too-large"
  | "unsupported-compression"
  | "missing-document-part"
  | "no-text"
  | "pdf-too-large"
  | "pdf-not-supported"
  | "parse-failed";

/**
 * True when this module can extract the document locally, without any
 * provider support.
 */
export function shouldExtractLocally(mediaType: string): boolean {
  const mt = normalizeMediaType(mediaType);
  return mt === DOCX_MIME || mt === XLSX_MIME || mt === PDF_MIME;
}

/**
 * Extract readable text from a document's raw bytes. Never throws: every
 * failure mode returns `{ok:false, reason}` so the caller can keep the
 * original part instead.
 */
export async function extractDocumentText(
  data: Buffer,
  mediaType: string,
  name?: string,
): Promise<ExtractResult> {
  try {
    const mt = normalizeMediaType(mediaType);
    if (mt === DOCX_MIME) return await extractOfficeText(data, "docx", name);
    if (mt === XLSX_MIME) return await extractOfficeText(data, "xlsx", name);
    if (mt === PDF_MIME) return await extractPdfText(data, name);
    return { ok: false, reason: "unsupported-type" satisfies ExtractFailureReason };
  } catch {
    // A corrupt file, a hostile file, a parser bug — all surface the same
    // way. The caller keeps the original document part.
    return { ok: false, reason: "parse-failed" satisfies ExtractFailureReason };
  }
}

/**
 * Pipeline step for the coordinator: replace locally-extractable document
 * parts with their text when the provider cannot read documents itself.
 *
 * - `supportsDocuments === true` → parts returned untouched (native support
 *   wins; local extraction would only lose fidelity).
 * - extraction succeeds → the document part becomes
 *   `{type:"text", text:"[متن سند <name>]:\n<text>"}`.
 * - extraction fails → the ORIGINAL part is kept. The adapter attaches its
 *   own named note for unreadable documents, so the failure is visible rather
 *   than silent.
 *
 * Never throws.
 */
export async function maybeExtractDocuments(
  parts: readonly DocPipelinePart[],
  supportsDocuments: boolean,
): Promise<DocPipelinePart[]> {
  const out: DocPipelinePart[] = [];
  for (const part of parts) {
    if (part.type !== "document" || supportsDocuments || !shouldExtractLocally(part.mediaType)) {
      out.push(part);
      continue;
    }
    try {
      const data = Buffer.from(part.base64, "base64");
      const res = await extractDocumentText(data, part.mediaType, part.name);
      if (res.ok) {
        const label = part.name ?? "attachment";
        out.push({ type: "text", text: `[Document "${label}" text]:\n${res.text}` });
      } else {
        out.push(part);
      }
    } catch {
      out.push(part);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function normalizeMediaType(mediaType: string): string {
  const semi = mediaType.indexOf(";");
  return (semi === -1 ? mediaType : mediaType.slice(0, semi)).trim().toLowerCase();
}

/** Cap on extracted text, in characters. Longer documents are truncated with a named note. */
const MAX_TEXT_CHARS = 200_000;

function capText(text: string, name?: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  const label = name ?? "document";
  return text.slice(0, MAX_TEXT_CHARS) + `\n\n["${label}" text was too long; the rest was removed.]`;
}

/** Decode the five XML entities plus numeric character references. */
function decodeXmlEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#[0-9]+|#[xX][0-9a-fA-F]+);/g, (m, e: string) => {
    switch (e) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const num = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        if (!Number.isSafeInteger(num) || num <= 0 || num > 0x10ffff) return m;
        return String.fromCodePoint(num);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Manual ZIP reader (DOCX / XLSX are ZIPs)
// ---------------------------------------------------------------------------

/**
 * ZIP-BOMB GUARDS — all mandatory, all tested:
 * - at most 200 central-directory entries are iterated;
 * - no single inflated entry may exceed 5MB (checked against the header's
 *   declared size first, then enforced WHILE inflating, because the header can lie);
 * - total inflated bytes across the entries one document needs stay ≤ 20MB.
 */
const MAX_ZIP_ENTRIES = 200;
const MAX_INFLATED_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_INFLATED_TOTAL_BYTES = 20 * 1024 * 1024;

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

interface ZipEntryInfo {
  name: string;
  method: number;
  compressedSize: number;
  declaredSize: number;
  localHeaderOffset: number;
}

type ZipReadError = { error: ExtractFailureReason };

/** Narrow the `Uint8Array | { error }` union without relying on Array.isArray. */
function isZipError(v: unknown): v is ZipReadError {
  return (
    typeof v === "object" &&
    v !== null &&
    !(v instanceof Uint8Array) &&
    "error" in v
  );
}

function readU16(data: Uint8Array, off: number): number {
  return data[off]! | (data[off + 1]! << 8);
}

function readU32(data: Uint8Array, off: number): number {
  return (
    data[off]! |
    (data[off + 1]! << 8) |
    (data[off + 2]! << 16) |
    data[off + 3]! * 0x1000000
  );
}

/** Locate the end-of-central-directory record by scanning the file tail. */
function findEocd(data: Uint8Array): number {
  const tail = Math.min(data.length, 65557 + 22);
  for (let i = data.length - 22; i >= data.length - tail; i--) {
    if (i < 0) break;
    if (
      data[i] === 0x50 &&
      data[i + 1] === 0x4b &&
      data[i + 2] === 0x05 &&
      data[i + 3] === 0x06
    ) {
      return i;
    }
  }
  return -1;
}

function readCentralDirectory(
  data: Uint8Array,
): ZipEntryInfo[] | { error: ExtractFailureReason } {
  const eocd = findEocd(data);
  if (eocd === -1) return { error: "not-a-zip" };
  const count = readU16(data, eocd + 10);
  const cdOffset = readU32(data, eocd + 16);
  if (count > MAX_ZIP_ENTRIES) return { error: "zip-too-many-entries" };
  if (cdOffset >= data.length) return { error: "not-a-zip" };

  const entries: ZipEntryInfo[] = [];
  let off = cdOffset;
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (off + 46 > data.length || readU32(data, off) !== ZIP_CENTRAL_SIG) {
      return { error: "not-a-zip" };
    }
    const method = readU16(data, off + 10);
    const compressedSize = readU32(data, off + 20);
    const declaredSize = readU32(data, off + 24);
    const nameLen = readU16(data, off + 28);
    const extraLen = readU16(data, off + 30);
    const commentLen = readU16(data, off + 32);
    const localHeaderOffset = readU32(data, off + 42);
    if (off + 46 + nameLen > data.length) return { error: "not-a-zip" };
    const name = decoder.decode(data.subarray(off + 46, off + 46 + nameLen));
    entries.push({ name, method, compressedSize, declaredSize, localHeaderOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Inflate one entry's deflate stream, enforcing the per-entry byte cap WHILE
 * reading — a zip bomb's declared size lies, so the cap cannot rely on the
 * header alone.
 */
async function inflateBounded(
  compressed: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  let stream: ReadableStream<Uint8Array>;
  try {
    const ds = new DecompressionStream("deflate-raw");
    stream = new Blob([compressed as BlobPart]).stream().pipeThrough(ds);
  } catch {
    return undefined;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

async function readEntryBytes(
  data: Uint8Array,
  entry: ZipEntryInfo,
  budget: { total: number },
): Promise<Uint8Array | ZipReadError> {
  if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
    return { error: "unsupported-compression" };
  }
  const lho = entry.localHeaderOffset;
  if (lho + 30 > data.length || readU32(data, lho) !== ZIP_LOCAL_SIG) {
    return { error: "not-a-zip" };
  }
  const nameLen = readU16(data, lho + 26);
  const extraLen = readU16(data, lho + 28);
  const start = lho + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (start > data.length || end > data.length) return { error: "not-a-zip" };
  const raw = data.subarray(start, end);

  // Declared-size pre-check: the classic zip bomb stores a tiny stream while
  // claiming gigabytes. Reject on the claim before spending any CPU.
  if (entry.declaredSize > MAX_INFLATED_ENTRY_BYTES || raw.length > MAX_INFLATED_ENTRY_BYTES) {
    return { error: "zip-entry-too-large" };
  }

  let bytes: Uint8Array;
  if (entry.method === METHOD_STORED) {
    bytes = raw;
  } else {
    const inflated = await inflateBounded(raw, MAX_INFLATED_ENTRY_BYTES);
    if (inflated === undefined) return { error: "zip-entry-too-large" };
    bytes = inflated;
  }

  budget.total += bytes.byteLength;
  if (budget.total > MAX_INFLATED_TOTAL_BYTES) return { error: "zip-total-too-large" };
  return bytes;
}

// ---------------------------------------------------------------------------
// DOCX / XLSX text scraping
// ---------------------------------------------------------------------------

const DOCX_DOCUMENT_XML = "word/document.xml";
const XLSX_SHARED_STRINGS = "xl/sharedStrings.xml";
const XLSX_SHEET1 = "xl/worksheets/sheet1.xml";

async function extractOfficeText(
  data: Buffer,
  kind: "docx" | "xlsx",
  name?: string,
): Promise<ExtractResult> {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const dir = readCentralDirectory(bytes);
  if (!Array.isArray(dir)) return { ok: false, reason: dir.error };
  const byName = new Map(dir.map((e) => [e.name, e]));
  const budget = { total: 0 };

  async function need(path: string): Promise<Uint8Array | ZipReadError> {
    const entry = byName.get(path);
    if (entry === undefined) return { error: "missing-document-part" };
    return readEntryBytes(bytes, entry, budget);
  }

  const textDecoder = new TextDecoder();
  if (kind === "docx") {
    const doc = await need(DOCX_DOCUMENT_XML);
    if (isZipError(doc)) return { ok: false, reason: doc.error };
    const text = extractDocxText(textDecoder.decode(doc));
    if (text.length === 0) return { ok: false, reason: "no-text" };
    return { ok: true, text: capText(text, name) };
  }

  // xlsx: shared strings are optional (a sheet of pure numbers has none).
  const stringsRes = byName.has(XLSX_SHARED_STRINGS)
    ? await need(XLSX_SHARED_STRINGS)
    : new Uint8Array(0);
  if (isZipError(stringsRes)) return { ok: false, reason: stringsRes.error };
  const sheet = await need(XLSX_SHEET1);
  if (isZipError(sheet)) return { ok: false, reason: sheet.error };
  const shared = extractSharedStrings(textDecoder.decode(stringsRes));
  const text = extractSheetText(textDecoder.decode(sheet), shared);
  if (text.length === 0) return { ok: false, reason: "no-text" };
  return { ok: true, text: capText(text, name) };
}

/**
 * Scrape Word text runs in document order.
 *
 * Tokens are matched in a single pass so `<w:br/>` and paragraph boundaries
 * land in the right positions relative to the text around them. `xml:space`
 * attributes are accepted but irrelevant — whitespace is preserved as-is.
 */
function extractDocxText(xml: string): string {
  const token =
    /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/>|<w:tab\s*\/>|<\/w:p>/g;
  const paragraphs: string[] = [];
  let current = "";
  let m: RegExpExecArray | null;
  for (;;) {
    m = token.exec(xml);
    if (m === null) break;
    const [full, t] = m;
    if (full === "</w:p>") {
      paragraphs.push(current);
      current = "";
    } else if (full.startsWith("<w:br")) {
      current += "\n";
    } else if (full.startsWith("<w:tab")) {
      current += "\t";
    } else {
      current += decodeXmlEntities(t ?? "");
    }
  }
  if (current.length > 0) paragraphs.push(current);
  return paragraphs
    .map((p) => p.replace(/[ \t\u00a0]+/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Collect shared strings in order: each `<si>` may hold several `<t>` runs (rich text). */
function extractSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let si: RegExpExecArray | null;
  for (;;) {
    si = siRe.exec(xml);
    if (si === null) break;
    const runs: string[] = [];
    let t: RegExpExecArray | null;
    tRe.lastIndex = 0;
    for (;;) {
      t = tRe.exec(si[1]!);
      if (t === null) break;
      runs.push(decodeXmlEntities(t[1]!));
    }
    out.push(runs.join(""));
  }
  return out;
}

/**
 * Scrape the first worksheet: shared-string references (`t="s"` → `<v>` index
 * into the shared table), inline strings, and numbers as-is. Cells in a row
 * are tab-joined; rows are newline-joined.
 */
function extractSheetText(xml: string, shared: string[]): string {
  const rows: string[] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
  let row: RegExpExecArray | null;
  for (;;) {
    row = rowRe.exec(xml);
    if (row === null) break;
    const cells: string[] = [];
    const body = row[1]!;
    let cell: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    for (;;) {
      cell = cellRe.exec(body);
      if (cell === null) break;
      const attrs = cell[1] ?? cell[3] ?? "";
      const inner = cell[2] ?? "";
      const tMatch = /\bt="([a-zA-Z]+)"/.exec(attrs);
      const t = tMatch?.[1] ?? "";
      if (t === "s") {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const idx = v !== null ? parseInt(v[1]!.trim(), 10) : NaN;
        cells.push(Number.isSafeInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx]! : "");
      } else if (t === "inlineStr") {
        const tEl = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(inner);
        cells.push(tEl !== null ? decodeXmlEntities(tEl[1]!) : "");
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        cells.push(v !== null ? decodeXmlEntities(v[1]!.trim()) : "");
      }
    }
    const line = cells.join("\t").replace(/\t+$/g, "");
    if (line.length > 0) rows.push(line);
  }
  return rows.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/**
 * Exported for tests: parse a zip's central directory without extracting.
 *
 * Lets the suite assert the zip-bomb guards directly — including the TOTAL
 * budget, which no supported document format can reach on its own (a document
 * needs at most two entries), and the streaming cap, which needs a header
 * that understates the real inflated size.
 */
export function parseZipCentralDirectory(data: Uint8Array): ZipEntryInfo[] {
  const dir = readCentralDirectory(data);
  if (isZipError(dir)) throw new Error(dir.error);
  return dir;
}

/**
 * Exported for tests: read one entry's bytes against a shared byte budget.
 * Throws an Error whose message is the ExtractFailureReason on refusal.
 */
export async function readZipEntryForTest(
  data: Uint8Array,
  entry: ZipEntryInfo,
  budget: { total: number },
): Promise<Uint8Array> {
  const res = await readEntryBytes(data, entry, budget);
  if (isZipError(res)) throw new Error(res.error);
  return res;
}

// ---------------------------------------------------------------------------
// PDF text extraction (pdf-parse, pure JS — verified working under Bun)
// ---------------------------------------------------------------------------

/** Refuse absurdly large PDFs before the parser ever sees them. */
const MAX_PDF_BYTES = 20 * 1024 * 1024;

async function extractPdfText(data: Buffer, name?: string): Promise<ExtractResult> {
  if (data.byteLength > MAX_PDF_BYTES) {
    return { ok: false, reason: "pdf-too-large" satisfies ExtractFailureReason };
  }
  try {
    // NOTE: pdf-parse takes ownership of the passed array in some paths, so
    // hand it a copy and keep the caller's buffer intact.
    const parser = new PDFParse({ data: new Uint8Array(data) });
    try {
      const result = await parser.getText();
      const text = (result.text ?? "").trim();
      if (text.length === 0) return { ok: false, reason: "no-text" };
      return { ok: true, text: capText(text, name) };
    } finally {
      await parser.destroy();
    }
  } catch {
    // Encrypted, corrupt, or otherwise unparseable: an honest failure the
    // caller converts into keeping the original document part.
    return { ok: false, reason: "parse-failed" satisfies ExtractFailureReason };
  }
}

// ---------------------------------------------------------------------------
// extract_document TOOL (platform Phase 9 — the pipeline above as a callable
// tool over the owner's files sandbox)
// ---------------------------------------------------------------------------
//
// The extraction pipeline above stays exactly as it was: pure functions over
// attachment bytes. This section wraps it in a Tool the model can call on a
// document the owner has ALREADY saved in the files area (the sandbox the
// `files` tool manages). It is the only part of this module that touches the
// tool layer or the filesystem.
//
// Sandbox discipline mirrors files.ts (its helpers are module-private, so
// the same checks are implemented here): absolute paths and `..` escapes are
// refused lexically before any I/O, symlinks are refused as an escape route
// via a realpath check on the deepest existing ancestor, and no error
// message ever echoes a path.

export const EXTRACT_DOCUMENT_PERMISSION = "tools:extract_document";

/** File-size ceiling for one extraction, bytes (the PDF cap above matches). */
export const MAX_EXTRACT_FILE_BYTES = 20 * 1024 * 1024;

/** Character ceiling on the text one run hands back to the model. */
export const MAX_EXTRACT_OUTPUT_CHARS = 16_000;

export interface ExtractDocumentInput {
  /** Path inside the files area, e.g. "reports/annual.pdf". */
  path: string;
}

export interface ExtractDocumentOutput {
  /** Base name of the file — never a path. */
  name: string;
  mediaType: string;
  /** Characters in `text` as returned (after the output cap). */
  chars: number;
  /** The extracted readable text, capped at MAX_EXTRACT_OUTPUT_CHARS. */
  text: string;
  /** True when the full text was longer than the cap and `text` was cut. */
  truncated: boolean;
}

export interface ExtractDocumentDeps {
  /** Root of the files sandbox. Created lazily on first use. */
  rootDir: string;
  /**
   * Server-supplied owner predicate. Supplied by bootstrap and re-checked
   * in run() as defence in depth alongside the ownerOnly flag (the files.ts
   * pattern, with the predicate required rather than optional).
   */
  isOwner: (userId: string) => boolean;
}

/**
 * Plugin discovery manifest for `extract_document`.
 *
 * Category "media": like download_media and generate_image, this tool
 * processes a media/document file into something the user/model consumes —
 * it does not manage the sandbox itself (that is files, category "system").
 */
export const extractDocumentManifest: ToolManifest = defineManifest({
  id: "extract_document",
  version: "1.0.0",
  title: "Extract Document",
  description:
    "Extract readable text from a PDF, Word (.docx) or Excel (.xlsx) document, or a plain text file, saved in the owner's files area. Returns the text capped at 16,000 characters. Owner only.",
  purpose: "readable text from documents",
  useWhen: "document file already saved",
  doNotUseWhen:
    "a plain web page — that is fetch_url; a file that is not saved in the files area yet — download it first",
  confusableWith: [
    {
      tool: "files",
      difference:
        "files reads plain text files raw; this extracts readable text from PDF/Office documents",
    },
    {
      tool: "fetch_url",
      difference: "fetch_url reads web pages; this reads a document file",
    },
  ],
  latencyTier: "seconds",
  outputSummary:
    "The document's text (capped at 16,000 characters), with its name, media type, character count and truncation flag.",
  category: "media",
  costTier: "free",
});

export function createExtractDocumentTool(
  deps: ExtractDocumentDeps,
): Tool<ExtractDocumentInput, ExtractDocumentOutput> {
  return {
    name: "extract_document",
    manifest: extractDocumentManifest,
    description:
      "Extract readable text from a document saved in the files area (.pdf, .docx, .xlsx, .txt, .md, .csv). Returns the text capped at 16,000 characters. Owner only.",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [EXTRACT_DOCUMENT_PERMISSION] },
    toolset: "media",
    input: {
      fields: {
        path: {
          type: "string",
          required: true,
          description:
            "Path of the document inside the files area, e.g. 'reports/annual.pdf'. Supported: .pdf, .docx, .xlsx, .txt, .md, .csv.",
          maxLength: 1024,
        },
      },
    },

    async run(
      input: ExtractDocumentInput,
      ctx: ToolContext,
    ): Promise<ExtractDocumentOutput> {
      assertExtractOwner(ctx, deps);
      const raw = typeof input.path === "string" ? input.path.trim() : "";
      if (raw.length === 0) {
        throw new ToolError("invalid_input", "A file path is required.");
      }
      const mediaType = mediaTypeForDocumentExtension(extname(raw).toLowerCase());
      if (mediaType === undefined) {
        throw new ToolError(
          "invalid_input",
          "Only PDF, Word (.docx), Excel (.xlsx) and plain text (.txt, .md, .csv) files can be extracted.",
        );
      }
      const root = await ensureSandboxRoot(deps.rootDir);
      const target = await resolveSandboxPath(root, raw, {
        mustExist: true,
        notFoundMessage: "That file doesn't exist.",
      });
      const st = await stat(target).catch(() => undefined);
      if (st === undefined) throw new ToolError("not_found", "That file doesn't exist.");
      if (st.isDirectory()) {
        throw new ToolError("invalid_input", "That path is a folder, not a document file.");
      }
      if (st.size > MAX_EXTRACT_FILE_BYTES) {
        throw new ToolError(
          "invalid_input",
          "That file is larger than the 20 MB limit for extraction.",
        );
      }
      const bytes = await readFile(target).catch(() => {
        throw new ToolError("internal", "The file couldn't be read.");
      });

      let fullText: string;
      if (shouldExtractLocally(mediaType)) {
        const res = await extractDocumentText(bytes, mediaType, basename(target));
        if (!res.ok) {
          throw new ToolError("invalid_input", extractFailureMessage(res.reason));
        }
        fullText = res.text;
      } else {
        // Plain-text kinds (.txt/.md/.csv) need no parser — but the bytes
        // must really be UTF-8 text, not a binary wearing a text extension.
        fullText = decodePlainText(bytes);
      }

      const { text, truncated } = capOutputText(fullText);
      return { name: basename(target), mediaType, chars: text.length, text, truncated };
    },
  };
}

// ------------------------------------------------------------- tool glue ----

/** Map a supported file extension onto the media type the pipeline speaks. */
function mediaTypeForDocumentExtension(ext: string): string | undefined {
  switch (ext) {
    case ".pdf":
      return PDF_MIME;
    case ".docx":
      return DOCX_MIME;
    case ".xlsx":
      return XLSX_MIME;
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".csv":
      return "text/csv";
    default:
      return undefined;
  }
}

/**
 * Turn an ExtractFailureReason into user-facing copy.
 *
 * Reason-safety verdict: every reason `extractDocumentText` can return is a
 * member of the closed ExtractFailureReason enum — stable machine tokens
 * ("not-a-zip", "pdf-too-large", …) that carry no paths, no parser output
 * and no provider text, so none of them can leak internals. They are still
 * machine tokens rather than sentences, so each is translated here; an
 * unrecognized reason falls back to a generic safe message.
 */
const EXTRACT_FAILURE_MESSAGES: Readonly<Partial<Record<ExtractFailureReason, string>>> = {
  "unsupported-type": "That document type can't be extracted.",
  "not-a-zip": "That document is damaged and couldn't be read.",
  "zip-too-many-entries": "That document has too many parts and couldn't be read safely.",
  "zip-entry-too-large": "Part of that document is too large to read safely.",
  "zip-total-too-large": "That document is too large inside to read safely.",
  "unsupported-compression": "That document uses a compression this reader can't open.",
  "missing-document-part": "That document is missing its main content.",
  "no-text": "That document contains no readable text.",
  "pdf-too-large": "That PDF is larger than the 20 MB limit.",
  "pdf-not-supported": "That PDF couldn't be read.",
  "parse-failed": "That document couldn't be read.",
};

function extractFailureMessage(reason: string): string {
  return (
    EXTRACT_FAILURE_MESSAGES[reason as ExtractFailureReason] ??
    "That document couldn't be read."
  );
}

/** Strict UTF-8 decode for the plain-text kinds; an empty file has no text. */
function decodePlainText(bytes: Buffer): string {
  if (bytes.length === 0) {
    throw new ToolError("invalid_input", "That file contains no readable text.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ToolError(
      "invalid_input",
      "That file isn't readable text (not valid UTF-8).",
    );
  }
}

/**
 * Cap the returned text at MAX_EXTRACT_OUTPUT_CHARS, cutting at a line
 * boundary when one falls in the second half of the budget (a boundary
 * right at the start would waste the cap, so a hard cut wins there).
 */
function capOutputText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_EXTRACT_OUTPUT_CHARS) return { text, truncated: false };
  const head = text.slice(0, MAX_EXTRACT_OUTPUT_CHARS);
  const lastBreak = head.lastIndexOf("\n");
  const cut =
    lastBreak >= MAX_EXTRACT_OUTPUT_CHARS / 2 ? head.slice(0, lastBreak) : head;
  return { text: cut, truncated: true };
}

/** The defence-in-depth owner check: the actor id comes from server code, never the model. */
function assertExtractOwner(ctx: ToolContext, deps: ExtractDocumentDeps): void {
  const id = ctx.actor.userId;
  if (typeof id !== "string" || id.length === 0 || id === "unknown") {
    throw new ToolError("not_allowed", "Identity is unknown.");
  }
  if (!deps.isOwner(id)) {
    throw new ToolError("not_allowed", "Document extraction is owner only.");
  }
}

// ------------------------------------------------------------- sandbox ----
//
// Path safety uses the shared helper (./sandbox): absolute paths refused,
// lexical `..` escapes refused before any I/O, and the deepest existing
// ancestor realpath'd and required to stay inside the root's real path
// (symlink escapes refused). Error messages never echo the resolved path.
