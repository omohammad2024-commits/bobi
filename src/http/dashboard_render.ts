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
 *
 * buildLineChartSvg is pure and dependency-free like the other two, so the
 * dashboard page embeds it verbatim via `.toString()` (see CLIENT_LIB in
 * src/http/dashboard_pages.ts) — the unit-tested code IS the browser code.
 * It references the module-level escapeHtml, which is embedded just before
 * it in the page (function declarations hoist, so order is safe). No
 * backticks or ${} in its source: it nests inside the page's <script> built
 * by string concatenation.
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

// ---------------------------------------------------------------------------
// Trend line chart (Phase 4, item 3): benchmark score trends on the dashboard.
// ---------------------------------------------------------------------------

/** One plotted point: unix-ms timestamp and a score percent. */
export interface TrendChartPoint {
  ts: number;
  value: number;
}

/** One line on the chart: aggregate average or a single task's scores. */
export interface TrendChartSeries {
  label: string;
  color: string;
  points: TrendChartPoint[];
}

export interface TrendChartOptions {
  series: TrendChartSeries[];
  width?: number;
  height?: number;
  /**
   * Right-to-left time axis (Persian): oldest on the right, newest on the
   * left. Default false (left-to-right).
   */
  rtl?: boolean;
  /** Y-axis bounds. Defaults 0..100 (score percent). */
  yMin?: number;
  yMax?: number;
  /** Label text for an x-axis tick (unix ms). */
  formatTick: (ts: number) => string;
  /** Label text for a y-axis tick. Default: rounded number. */
  formatValue?: (v: number) => string;
  /** Message rendered when there is nothing to plot. */
  emptyText: string;
}

/**
 * Hand-rolled SVG line chart — no external JS, no CDN (privacy + offline).
 *
 * Pure and dependency-free (escapeHtml aside, see the header note), so the
 * dashboard page embeds it verbatim via `.toString()` — the unit-tested code
 * IS the browser code.
 *
 * SECURITY: every label and tick string is escapeHtml'd before it reaches
 * the markup; numeric coordinates are validated finite and clamped, so a
 * hostile task title (or a corrupt row) can never break out of an attribute
 * or inject markup.
 */
export function buildLineChartSvg(opts: TrendChartOptions): string {
  // Nested (not module-level): this function is embedded in the browser via
  // `.toString()`, so everything it touches must travel with it — except
  // escapeHtml, which the page embeds separately just before it.
  function numOr(v: unknown, fallback: number): number {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  }
  function clampNum(v: unknown, min: number, max: number, fallback: number): number {
    const n = numOr(v, fallback);
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  const W = clampNum(opts.width, 280, 1100, 640);
  const H = clampNum(opts.height, 140, 520, 260);
  const rtl = opts.rtl === true;
  const yMin = numOr(opts.yMin, 0);
  const yMax = numOr(opts.yMax, 100);
  const lo = yMax > yMin ? yMin : 0;
  const hi = yMax > yMin ? yMax : 100;
  const fmtV =
    opts.formatValue ??
    ((v: number) => String(Math.round(v)));

  const padL = 46;
  const padR = 14;
  const padT = 30;
  const padB = 32;
  const plotW = Math.max(10, W - padL - padR);
  const plotH = Math.max(10, H - padT - padB);

  interface Pt {
    x: number;
    y: number;
  }
  interface Line {
    label: string;
    color: string;
    pts: Pt[];
  }

  // Sanitize: finite numbers only, values clamped to the y bounds.
  const clean: Line[] = [];
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const s of opts.series) {
    const pts: Pt[] = [];
    const points = Array.isArray(s.points) ? s.points : [];
    for (const p of points) {
      const ts = numOr(p.ts, NaN);
      const v = numOr(p.value, NaN);
      if (!Number.isFinite(ts) || !Number.isFinite(v)) continue;
      const cv = Math.min(hi, Math.max(lo, v));
      pts.push({ x: ts, y: cv });
      if (ts < tMin) tMin = ts;
      if (ts > tMax) tMax = ts;
    }
    pts.sort((a, b) => a.x - b.x);
    if (pts.length > 0) {
      clean.push({ label: String(s.label ?? ""), color: String(s.color ?? "#4da3ff"), pts });
    }
  }

  const open = '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" role="img" xmlns="http://www.w3.org/2000/svg">';
  const title = "<title>" + escapeHtml("benchmark trend") + "</title>";

  if (clean.length === 0) {
    return (
      open +
      title +
      '<text x="' +
      W / 2 +
      '" y="' +
      H / 2 +
      '" text-anchor="middle" fill="#93a0b8" font-size="13">' +
      escapeHtml(opts.emptyText) +
      "</text></svg>"
    );
  }

  if (!(tMax > tMin)) {
    tMin -= 86400000;
    tMax += 86400000;
  }

  function xPos(ts: number): number {
    const frac = (ts - tMin) / (tMax - tMin);
    return rtl ? padL + plotW - frac * plotW : padL + frac * plotW;
  }
  function yPos(v: number): number {
    const frac = (v - lo) / (hi - lo);
    return padT + plotH - frac * plotH;
  }
  function f2(n: number): string {
    return String(Math.round(n * 100) / 100);
  }

  let svg = open + title;

  // Y gridlines + labels (5 ticks).
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    const y = yPos(v);
    svg +=
      '<line x1="' + padL + '" y1="' + f2(y) + '" x2="' + (padL + plotW) + '" y2="' + f2(y) + '" stroke="#26314a" stroke-width="1"/>';
    svg +=
      '<text x="' + (padL - 6) + '" y="' + f2(y + 4) + '" text-anchor="end" fill="#93a0b8" font-size="11">' +
      escapeHtml(fmtV(v)) +
      "</text>";
  }

  // X ticks: up to 5 evenly spaced across the time range.
  const tickCount = Math.min(5, Math.max(2, clean[0]?.pts.length ?? 2));
  for (let i = 0; i < tickCount; i++) {
    const ts = tMin + ((tMax - tMin) * i) / (tickCount - 1);
    const x = xPos(ts);
    svg +=
      '<text x="' + f2(x) + '" y="' + (padT + plotH + 20) + '" text-anchor="middle" fill="#93a0b8" font-size="11">' +
      escapeHtml(String(opts.formatTick(ts))) +
      "</text>";
  }

  // Series lines + dots.
  for (const line of clean) {
    const d = line.pts
      .map((p, i) => (i === 0 ? "M" : "L") + f2(xPos(p.x)) + " " + f2(yPos(p.y)))
      .join(" ");
    svg +=
      '<path d="' + d + '" fill="none" stroke="' + escapeHtml(line.color) + '" stroke-width="2"/>';
    for (const p of line.pts) {
      svg +=
        '<circle cx="' + f2(xPos(p.x)) + '" cy="' + f2(yPos(p.y)) + '" r="3" fill="' +
        escapeHtml(line.color) + '"/>';
    }
  }

  // Legend.
  let lx = rtl ? W - padR : padL;
  const anchor = rtl ? "end" : "start";
  for (const line of clean) {
    const sw = rtl ? lx - 64 : lx;
    svg += '<rect x="' + sw + '" y="8" width="12" height="12" rx="2" fill="' + escapeHtml(line.color) + '"/>';
    svg +=
      '<text x="' + (rtl ? lx - 70 : lx + 18) + '" y="18" text-anchor="' + anchor + '" fill="#e8ecf4" font-size="12">' +
      escapeHtml(line.label) +
      "</text>";
    lx += rtl ? -180 : 180;
  }

  return svg + "</svg>";
}
