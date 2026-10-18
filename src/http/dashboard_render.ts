/**
 * Phase 3, item 3 — owner web dashboard: safe rendering primitives.
 *
 * These are PURE functions with zero imports, deliberately so the browser
 * bundle can embed them verbatim via `escapeHtml.toString()` /
 * `renderSafeMarkdown.toString()` (see src/http/dashboard_pages.ts). That
 * guarantees the client-side renderer is byte-identical to the code the unit
 * tests exercise — there is no separate JS copy to drift.
 *
 * `renderSafeMarkdown` keeps every helper NESTED inside it, so its
 * `.toString()` output is fully self-contained in the browser (no module
 * scope to resolve).
 *
 * SECURITY: every string that reaches the DOM from owner data (memory
 * content, provider labels, bench markdown) goes through escapeHtml first.
 * renderSafeMarkdown escapes BEFORE applying markdown transforms, so raw
 * HTML in a bench report or a memory can never become live markup.
 */

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Minimal, SAFE markdown renderer for the Persian bench reports.
 *
 * Supported: fenced code blocks, #/##/###/#### headings, `- ` lists, pipe
 * tables, paragraphs, and inline `code` / **bold** / *italic*. Everything
 * else (links, images, raw HTML, autolinks) is rendered as escaped plain
 * text — deliberately, so a hostile or sloppy report can never inject markup
 * or script. There is intentionally no link support: the reports never need
 * it, and `javascript:` URLs are a classic XSS vector.
 */
export function renderSafeMarkdown(md: string): string {
  /** Inline markup on already-escaped text: `code`, **bold**, *italic*. */
  function renderInline(escaped: string): string {
    let s = escaped;
    s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w_])_([^_\n]+)_/g, "$1<em>$2</em>");
    return s;
  }

  function isTableSeparator(line: string): boolean {
    return /^\|[\s:|-]+\|$/.test(line.trim());
  }

  function isTableRow(line: string): boolean {
    const t = line.trim();
    return t.startsWith("|") && t.endsWith("|") && t.length >= 2;
  }

  function splitRow(line: string): string[] {
    return line
      .trim()
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
  }

  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let code: string[] | undefined;

  const flushPara = (): void => {
    if (para.length > 0) {
      out.push("<p>" + para.map((l) => renderInline(escapeHtml(l))).join("<br>") + "</p>");
      para = [];
    }
  };
  const flushList = (): void => {
    if (list.length > 0) {
      out.push("<ul>" + list.map((l) => "<li>" + renderInline(escapeHtml(l)) + "</li>").join("") + "</ul>");
      list = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // Fenced code block.
    if (trimmed.startsWith("```")) {
      if (code === undefined) {
        flushPara();
        flushList();
        code = [];
      } else {
        out.push("<pre><code>" + code.map((l) => escapeHtml(l)).join("\n") + "</code></pre>");
        code = undefined;
      }
      i += 1;
      continue;
    }
    if (code !== undefined) {
      code.push(line);
      i += 1;
      continue;
    }

    // Pipe table: header row + separator row, then body rows.
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? "")) {
      flushPara();
      flushList();
      const head = splitRow(line);
      let html =
        "<table><thead><tr>" +
        head.map((c) => "<th>" + renderInline(escapeHtml(c)) + "</th>").join("") +
        "</tr></thead><tbody>";
      i += 2;
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        const cells = splitRow(lines[i] ?? "");
        html +=
          "<tr>" + cells.map((c) => "<td>" + renderInline(escapeHtml(c)) + "</td>").join("") + "</tr>";
        i += 1;
      }
      out.push(html + "</tbody></table>");
      continue;
    }

    // Headings.
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading !== undefined && heading !== null) {
      flushPara();
      flushList();
      const level = Math.min((heading[1] ?? "#").length, 4);
      out.push("<h" + level + ">" + renderInline(escapeHtml(heading[2] ?? "")) + "</h" + level + ">");
      i += 1;
      continue;
    }

    // List items.
    const item = /^-\s+(.*)$/.exec(trimmed);
    if (item !== null && item !== undefined) {
      flushPara();
      list.push(item[1] ?? "");
      i += 1;
      continue;
    }

    // Blank line ends blocks.
    if (trimmed === "") {
      flushPara();
      flushList();
      i += 1;
      continue;
    }

    flushList();
    para.push(trimmed);
    i += 1;
  }
  flushPara();
  flushList();
  if (code !== undefined) {
    out.push("<pre><code>" + code.map((l) => escapeHtml(l)).join("\n") + "</code></pre>");
  }
  return out.join("\n");
}
