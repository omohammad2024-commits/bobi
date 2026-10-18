/**
 * Document text extraction (Phase B5).
 *
 * No network, no new dependencies at test time: minimal .docx/.xlsx/.pdf
 * fixtures are built in-test from raw bytes (a tiny ZIP writer below, a
 * hand-rolled minimal PDF). The suite pins:
 *
 *  - correct text from real minimal .docx / .xlsx files
 *  - the ZIP-BOMB GUARDS (entry count, per-entry cap incl. the streaming
 *    check, total cap) — each trips with its own reason
 *  - the 200KB truncation with a named note
 *  - maybeExtractDocuments: native support → untouched, unsupported +
 *    extractable → text part, failure → original part kept, never throws
 *  - the pdf-parse verdict: the pure-JS parser works under Bun
 */
import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import {
  shouldExtractLocally,
  extractDocumentText,
  maybeExtractDocuments,
  parseZipCentralDirectory,
  readZipEntryForTest,
  DOCX_MIME,
  XLSX_MIME,
  PDF_MIME,
  type DocPipelinePart,
} from "../src/tools/extract_document";

// ---------------------------------------------------------------------------
// In-test ZIP builder (no dependencies)
// ---------------------------------------------------------------------------

interface ZipSpec {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  /** Lie about the declared uncompressed size (for bomb-guard tests). */
  declaredSize?: number;
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
    const declared = spec.declaredSize ?? spec.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    fileParts.push(local, nameBuf, raw);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(raw.length, 20);
    cen.writeUInt32LE(declared, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += 30 + nameBuf.length + raw.length;
  }
  const cd = Buffer.concat(central);
  const cdStart = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...fileParts, cd, eocd]);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function docxBytes(paragraphsXml: string): Buffer {
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<w:document xmlns:w="${NS_W}"><w:body>${paragraphsXml}</w:body></w:document>`;
  return buildZip([{ name: "word/document.xml", data: Buffer.from(xml, "utf8") }]);
}

const SAMPLE_DOCX = docxBytes(
  `<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t xml:space="preserve">Fish &amp; Chips</w:t></w:r><w:br/><w:r><w:t>second line</w:t></w:r></w:p>`,
);

const SAMPLE_XLSX = buildZip([
  {
    name: "xl/sharedStrings.xml",
    data: Buffer.from(
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<si><t>Alice</t></si>` +
        `<si><t>Bob &amp; Co</t></si>` +
        `</sst>`,
      "utf8",
    ),
  },
  {
    name: "xl/worksheets/sheet1.xml",
    data: Buffer.from(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row>` +
        `<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="inlineStr"><is><t>inline</t></is></c></row>` +
        `</sheetData></worksheet>`,
      "utf8",
    ),
  },
]);

/** Minimal hand-rolled single-page PDF with one text line. */
function pdfBytes(text: string): Buffer {
  const esc = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const content = `BT /F1 24 Tf 100 700 Td (${esc}) Tj ET`;
  const objects: string[] = [];
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

const SAMPLE_PDF = pdfBytes("Hello BOBI pdf test");

function docPart(base64: string, mediaType: string, name?: string): DocPipelinePart {
  return {
    type: "document",
    mediaType,
    base64,
    ...(name !== undefined ? { name } : {}),
  };
}

// ---------------------------------------------------------------------------
// shouldExtractLocally
// ---------------------------------------------------------------------------

describe("shouldExtractLocally", () => {
  test("docx, xlsx and pdf are locally extractable", () => {
    expect(shouldExtractLocally(DOCX_MIME)).toBe(true);
    expect(shouldExtractLocally(XLSX_MIME)).toBe(true);
    expect(shouldExtractLocally(PDF_MIME)).toBe(true);
  });

  test("anything else is not", () => {
    expect(shouldExtractLocally("application/msword")).toBe(false);
    expect(shouldExtractLocally("image/png")).toBe(false);
    expect(shouldExtractLocally("text/plain")).toBe(false);
    expect(shouldExtractLocally("")).toBe(false);
  });

  test("media-type parameters and case are normalized", () => {
    expect(shouldExtractLocally("Application/PDF; charset=binary")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DOCX / XLSX extraction
// ---------------------------------------------------------------------------

describe("extractDocumentText — office formats", () => {
  test("a minimal docx yields its paragraphs, entities decoded, breaks kept", async () => {
    const res = await extractDocumentText(SAMPLE_DOCX, DOCX_MIME, "note.docx");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toBe("Hello world\nFish & Chips\nsecond line");
    }
  });

  test("a minimal xlsx yields shared strings, inline strings and numbers", async () => {
    const res = await extractDocumentText(SAMPLE_XLSX, XLSX_MIME, "s.xlsx");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toBe("Alice\t42\nBob & Co\tinline");
    }
  });

  test("garbage bytes fail honestly instead of throwing", async () => {
    const res = await extractDocumentText(Buffer.from("not a zip at all"), DOCX_MIME);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not-a-zip");
  });

  test("a zip missing word/document.xml fails with a named reason", async () => {
    const zip = buildZip([{ name: "word/other.xml", data: Buffer.from("<x/>", "utf8") }]);
    const res = await extractDocumentText(zip, DOCX_MIME);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("missing-document-part");
  });

  test("an unsupported media type is refused", async () => {
    const res = await extractDocumentText(SAMPLE_DOCX, "application/msword");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unsupported-type");
  });
});

// ---------------------------------------------------------------------------
// ZIP-BOMB GUARDS
// ---------------------------------------------------------------------------

describe("zip-bomb guards", () => {
  test("more than 200 entries are refused", async () => {
    const specs: ZipSpec[] = [];
    for (let i = 0; i < 201; i++) {
      specs.push({ name: `f${i}.txt`, data: Buffer.from("x", "utf8"), method: 0 });
    }
    const res = await extractDocumentText(buildZip(specs), DOCX_MIME);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("zip-too-many-entries");
  });

  test("a lying declared size trips the per-entry guard before inflating", async () => {
    const zip = buildZip([
      {
        name: "word/document.xml",
        data: Buffer.from("<w:document/>", "utf8"),
        declaredSize: 100 * 1024 * 1024, // classic bomb lie: tiny stream, huge claim
      },
    ]);
    const res = await extractDocumentText(zip, DOCX_MIME);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("zip-entry-too-large");
  });

  test("an entry that really inflates past 5MB trips the guard", async () => {
    const big = Buffer.from("x".repeat(6 * 1024 * 1024), "utf8");
    const zip = buildZip([{ name: "word/document.xml", data: big }]);
    const res = await extractDocumentText(zip, DOCX_MIME);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("zip-entry-too-large");
  });

  test("an unsupported compression method is refused", async () => {
    const zip = buildZip([{ name: "f.bin", data: Buffer.from("x", "utf8"), method: 0 }]);
    const u8 = new Uint8Array(zip.buffer, zip.byteOffset, zip.byteLength);
    const entries = parseZipCentralDirectory(u8);
    entries[0]!.method = 12; // forge an unknown method in the central directory
    await expect(readZipEntryForTest(u8, entries[0]!, { total: 0 })).rejects.toThrow(
      "unsupported-compression",
    );
  });

  test("the streaming cap trips when the header understates the real size", async () => {
    // Declared 4MB passes the header pre-check; the stream really inflates to
    // 6MB, so the WHILE-inflating guard must catch it.
    const zip = buildZip([
      {
        name: "f.bin",
        data: Buffer.from("x".repeat(6 * 1024 * 1024), "utf8"),
        declaredSize: 4 * 1024 * 1024,
      },
    ]);
    const u8 = new Uint8Array(zip.buffer, zip.byteOffset, zip.byteLength);
    const entries = parseZipCentralDirectory(u8);
    await expect(readZipEntryForTest(u8, entries[0]!, { total: 0 })).rejects.toThrow(
      "zip-entry-too-large",
    );
  });

  test("the total budget trips across several individually-fine entries", async () => {
    const specs: ZipSpec[] = [];
    for (let i = 0; i < 5; i++) {
      specs.push({ name: `f${i}.bin`, data: Buffer.from("x".repeat(4_718_592), "utf8") });
    }
    const zip = buildZip(specs);
    const u8 = new Uint8Array(zip.buffer, zip.byteOffset, zip.byteLength);
    const entries = parseZipCentralDirectory(u8);
    const budget = { total: 0 };
    for (let i = 0; i < 4; i++) {
      await readZipEntryForTest(u8, entries[i]!, budget); // 4 × 4.5MB = 18MB, fine
    }
    await expect(readZipEntryForTest(u8, entries[4]!, budget)).rejects.toThrow(
      "zip-total-too-large",
    );
  });
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe("extracted-text cap", () => {
  test("text past 200KB is truncated with a named note", async () => {
    const long = "کلمه ".repeat(60_000); // ~300KB of text
    const zip = docxBytes(`<w:p><w:r><w:t>${long}</w:t></w:r></w:p>`);
    const res = await extractDocumentText(zip, DOCX_MIME, "long.docx");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text.length).toBeLessThanOrEqual(200_000 + 200);
      expect(res.text).toContain("long.docx");
      expect(res.text).toContain("حذف شد");
    }
  });
});

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

describe("extractDocumentText — pdf", () => {
  test("pdf-parse verdict: the pure-JS parser works under Bun", async () => {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(SAMPLE_PDF) });
    try {
      const result = await parser.getText();
      expect(result.text).toContain("Hello BOBI pdf test");
    } finally {
      await parser.destroy();
    }
  });

  test("a minimal pdf yields its text", async () => {
    const res = await extractDocumentText(SAMPLE_PDF, PDF_MIME, "a.pdf");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain("Hello BOBI pdf test");
  });

  test("a corrupt pdf fails honestly instead of throwing", async () => {
    const res = await extractDocumentText(Buffer.from("%PDF-1.4 garbage"), PDF_MIME);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// maybeExtractDocuments
// ---------------------------------------------------------------------------

describe("maybeExtractDocuments", () => {
  const docxPart = () =>
    docPart(SAMPLE_DOCX.toString("base64"), DOCX_MIME, "note.docx");

  test("native provider support → parts pass through untouched", async () => {
    const parts: DocPipelinePart[] = [
      { type: "text", text: "hi" },
      docxPart(),
    ];
    const out = await maybeExtractDocuments(parts, true);
    expect(out).toEqual(parts);
  });

  test("unsupported provider + extractable document → text part", async () => {
    const out = await maybeExtractDocuments([{ type: "text", text: "see:" }, docxPart()], false);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ type: "text", text: "see:" });
    const second = out[1]!;
    expect(second.type).toBe("text");
    if (second.type === "text") {
      expect(second.text.startsWith("[متن سند «note.docx»]:\n")).toBe(true);
      expect(second.text).toContain("Hello world");
    }
  });

  test("an unnamed document gets a generic label", async () => {
    const out = await maybeExtractDocuments(
      [docPart(SAMPLE_DOCX.toString("base64"), DOCX_MIME)],
      false,
    );
    const first = out[0]!;
    expect(first.type).toBe("text");
    if (first.type === "text") {
      expect(first.text.startsWith("[متن سند «پیوست»]:\n")).toBe(true);
    }
  });

  test("extraction failure → the original part is kept", async () => {
    const broken = docPart(Buffer.from("not a zip").toString("base64"), DOCX_MIME, "b.docx");
    const out = await maybeExtractDocuments([broken], false);
    expect(out).toEqual([broken]);
  });

  test("a non-extractable document type is left alone", async () => {
    const part = docPart(Buffer.from("x").toString("base64"), "application/msword", "old.doc");
    const out = await maybeExtractDocuments([part], false);
    expect(out).toEqual([part]);
  });

  test("non-document parts pass through", async () => {
    const parts: DocPipelinePart[] = [
      { type: "text", text: "hello" },
      { type: "image", mediaType: "image/png", base64: "QUJD" },
    ];
    const out = await maybeExtractDocuments(parts, false);
    expect(out).toEqual(parts);
  });

  test("an empty list stays empty and nothing throws", async () => {
    await expect(maybeExtractDocuments([], false)).resolves.toEqual([]);
  });
});
