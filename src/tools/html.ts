/**
 * HTML → plain text, for feeding a fetched page to a model.
 *
 * This is a deliberately small, pure function rather than a parser dependency:
 * it converts a *page* into readable text, and does not attempt to be correct
 * HTML in general. What it must handle well is the common case — a real article
 * page — and what it must never do is let a script or style body reach the
 * model as if it were content.
 *
 * Why not regex-only: a single `<script>` inside a string literal in another
 * script would confuse naive stripping. The tag scanner below walks the input
 * once, tracking raw-text elements, so nested angle brackets inside a script or
 * style body cannot end it early.
 *
 * Anything that ends up here is UNTRUSTED. Extraction is about legibility, not
 * safety: the caller still wraps the result as tool output, which the system
 * prompt declares to be data rather than instructions.
 */

/** Elements whose content is not prose and must be dropped entirely. */
const DROPPED_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "head",
]);

/**
 * Dropped elements whose body is raw text rather than markup.
 *
 * These need extra handling: HTML5 ends a `<script>` at the FIRST `</script>`,
 * even one sitting inside a JavaScript string. A browser then renders the rest
 * of that line as page text — which for us would mean leaking JavaScript into
 * the model's context as if it were prose. So after such an element closes, the
 * text before the next tag is suppressed as well.
 */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "noscript",
  "template",
]);

/**
 * Elements HTML5 closes implicitly when another element starts.
 *
 * `<head>` is the one that matters in practice: pages routinely omit `</head>`,
 * and without this the skip would run to the end of the document and extract
 * nothing at all.
 */
const IMPLICITLY_CLOSED_BY: Readonly<Record<string, readonly string[]>> = {
  head: ["body", "html"],
};

/**
 * Elements whose content is navigation/chrome rather than the page's substance.
 * Dropping these is what makes an article readable instead of a menu dump.
 */
const CHROME_ELEMENTS: ReadonlySet<string> = new Set([
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "select",
  "option",
]);

/**
 * Elements that imply a line break in the rendered page, so their boundaries
 * become newlines in the text.
 */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  "p",
  "div",
  "section",
  "article",
  "br",
  "hr",
  "li",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "table",
  "ul",
  "ol",
  "figure",
  "figcaption",
]);

/** Named entities worth supporting, beyond numeric escapes. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  zwnj: "‌",
  zwj: "‍",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  deg: "°",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
  divide: "÷",
  plusmn: "±",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  sup2: "²",
  sup3: "³",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  dagger: "†",
  permil: "‰",
  larr: "←",
  rarr: "→",
  harr: "↔",
  crarr: "↵",
  infin: "∞",
  ne: "≠",
  le: "≤",
  ge: "≥",
  micro: "µ",
  prime: "′",
  Prime: "″",
  // A soft hyphen is invisible: it is removed rather than rendered.
  shy: "",
};

/**
 * Decode HTML entities.
 *
 * Numeric escapes are decoded by code point, with the C1 range remapped the way
 * browsers do it — a page that writes `&#146;` means a right single quote, not
 * an unprintable control character.
 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const digits = isHex ? body.slice(2) : body.slice(1);
      // A malformed escape is left exactly as written rather than guessed at.
      if (digits.length === 0) return match;
      const code = Number.parseInt(digits, isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      return codePointToString(remapC1(code));
    }
    const named = NAMED_ENTITIES[body];
    // Note: names are matched case-sensitively, as HTML5 defines both `&Amp;`
    // and `&amp;` differently — only the exact name is substituted.
    return named ?? match;
  });
}

/**
 * Windows-1252 glyphs in the C1 range, which browsers map rather than render
 * as control characters. Pages still emit these, so `&#146;` must not become an
 * invisible control code.
 */
function remapC1(code: number): number {
  if (code < 0x80 || code > 0x9f) return code;
  const table = [
    0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
    0x2039, 0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013,
    0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
  ];
  return table[code - 0x80] ?? code;
}

/** String.fromCodePoint with a guard against lone surrogates. */
function codePointToString(code: number): string {
  if (code >= 0xd800 && code <= 0xdfff) return "�";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "�";
  }
}

export interface ExtractOptions {
  /** Ceiling on the returned text. Truncation happens on a word boundary. */
  maxChars?: number;
  /** Collapse runs of blank lines. Default true. */
  collapseWhitespace?: boolean;
}

/**
 * Convert an HTML document to readable text.
 *
 * Pure: same input yields the same output, so it is tested against captured
 * fixtures without a network.
 */
export function htmlToText(html: string, opts: ExtractOptions = {}): string {
  const maxChars = opts.maxChars ?? 8_000;
  const collapse = opts.collapseWhitespace !== false;

  const withBreaks = scanTags(html);
  const decoded = decodeEntities(withBreaks);
  const normalised = collapse ? normaliseSpace(decoded) : decoded;
  return truncateOnWord(normalised, maxChars);
}

/**
 * Walk the input once, dropping unwanted element bodies and turning block
 * boundaries into newlines.
 *
 * Three properties this had to be rewritten for:
 *
 *  1. NO STACK. The previous version tracked open elements in an array and
 *     searched it on every closing tag, which is O(n²) — a 2 MB page of
 *     repeated tags froze the process for minutes, stalling every chat and the
 *     reminder scheduler. A closing tag now only needs to decide "is this a
 *     block?", so no stack is kept at all.
 *
 *  2. A SELF-CLOSING DROP ELEMENT IS STILL A DROP. `<script/>` is not valid
 *     HTML, but a parser must not treat it as "open a script and then close it
 *     immediately": doing so let the JavaScript after it through as page prose.
 *     It now enters the raw-text skip like any other `<script>`.
 *
 *  3. RAW-TEXT BODIES END AT THEIR IMPORTANT CLOSE. HTML5 ends a `<script>` at
 *     the first `</script>`, which an attacker can exploit with
 *     `var s = "</script>"; <b>payload</b>`. Everything after such a close, up
 *     to the next tag, is suppressed — so the remainder of the JavaScript
 *     cannot be read as prose.
 *
 * An implied end is also honoured: `<head>` is closed by `<body>`, because
 * HTML5 says so and a page that omits `</head>` would otherwise produce no
 * text at all.
 */
function scanTags(html: string): string {
  let out = "";
  let i = 0;
  // When set, we are inside a raw-text element and only look for its end.
  let skipping: string | undefined;
  // Set after a raw-text element closes, so the remainder of its line is
  // dropped too. Cleared when a tag is consumed rather than when one is seen.
  let suppressingRun = false;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      // Only capture trailing text when we are not inside a dropped element.
      if (skipping === undefined && !suppressingRun) out += html.slice(i);
      break;
    }
    // The text run before this tag belongs to the model only when the current
    // element is one whose content is prose. Appending before the skip check
    // would leak a <script> body as if it were page text.
    if (skipping === undefined && !suppressingRun) out += html.slice(i, lt);

    // Comment, doctype or CDATA: skip to its terminator.
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    const gt = html.indexOf(">", lt);
    // An unterminated tag is discarded rather than emitted as text.
    if (gt === -1) break;
    const rawTag = html.slice(lt + 1, gt);
    i = gt + 1;

    const parsed = parseTag(rawTag);
    if (!parsed) continue;
    const { name, closing, selfClosing } = parsed;

    if (skipping !== undefined) {
      // An element that HTML5 closes implicitly ends the skip even without its
      // closing tag. A page that omits `</head>` is common, and without this the
      // whole document would be discarded and `fetch_url` would report that no
      // text was found.
      if (IMPLICITLY_CLOSED_BY[skipping]?.includes(name) === true) {
        skipping = undefined;
        // Fall through: this tag is processed normally below.
      } else if (closing && name === skipping) {
        // Inside a raw-text element, only its own closing tag ends the skip. A
        // self-closing form does not, because its body still follows.
        skipping = undefined;
        // The remainder of a raw-text element's body is JavaScript or CSS that
        // HTML5 left as page text; it must not reach the model as prose.
        if (RAW_TEXT_ELEMENTS.has(name)) suppressingRun = true;
        if (BLOCK_ELEMENTS.has(name)) out += "\n";
        continue;
      } else {
        continue;
      }
    }

    if (DROPPED_ELEMENTS.has(name) || CHROME_ELEMENTS.has(name)) {
      if (!closing) {
        // A self-closing form still opens a raw-text skip. `<script/>` must not
        // be read as "an empty script", because the text that follows it is the
        // script's body as far as a browser is concerned.
        skipping = name;
      } else if (BLOCK_ELEMENTS.has(name)) {
        out += "\n";
      }
      continue;
    }

    // A suppressed run resumes only at a BLOCK-level tag.
    //
    // Clearing it on any tag was the bug: given `<script>x="</script>"; a=<b>FAKE</b>`
    // the inline `<b>` ended suppression and the leftover script fragment became
    // page prose. Inline tags are exactly what appears inside a JavaScript
    // string, so they cannot be trusted to mark the end of one; a block element
    // is a real structural boundary and does end it.
    if (suppressingRun && !BLOCK_ELEMENTS.has(name)) {
      continue;
    }
    suppressingRun = false;

    if (selfClosing) {
      // `<br/>` and friends separate lines; a stray `<img/>` should not.
      if (BLOCK_ELEMENTS.has(name)) out += "\n";
      continue;
    }

    if (BLOCK_ELEMENTS.has(name)) out += "\n";
  }

  return out;
}

interface ParsedTag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
}

/** Parse a tag body (`div class="x"`, `/p`, `br /`) into its name and flags. */
function parseTag(raw: string): ParsedTag | undefined {
  let body = raw.trim();
  if (body.length === 0) return undefined;

  const closing = body.startsWith("/");
  if (closing) body = body.slice(1).trimStart();
  if (body.length === 0) return undefined;

  // The element name ends at whitespace, `/`, or the end.
  const match = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(body);
  if (!match) return undefined;
  const name = match[0].toLowerCase();

  // A trailing slash marks a self-closing tag, but only when it is the last
  // character: `<a href="x/">` is not self-closing.
  return {
    name,
    closing,
    selfClosing: !closing && body.endsWith("/"),
  };
}

/**
 * Collapse whitespace the way rendered HTML behaves.
 *
 * Runs of spaces and tabs become one space; runs of blank lines become at most
 * one blank line, so paragraph separation survives without the page's source
 * indentation bloating the result.
 *
 * The character class is written with escapes on purpose. Several of the
 * characters it matches are invisible in an editor, and U+2028/U+2029 are
 * literal line terminators in JavaScript source — spelling them out is the only
 * way this file stays readable and unambiguous.
 */
const SPACE_RUN = new RegExp("[\\t\\f\\v\\u00a0\\u2000-\\u200b\\u2028\\u2029]+", "g");
const MULTI_SPACE = / {2,}/g;
const SPACE_AROUND_NEWLINE = new RegExp(" ?\\n ?", "g");
const BLANK_RUN = new RegExp("\\n{3,}", "g");
const CRLF = new RegExp("\\r\\n?", "g");

function normaliseSpace(text: string): string {
  return text
    .replace(CRLF, "\n")
    .replace(SPACE_RUN, " ")
    .replace(MULTI_SPACE, " ")
    .replace(SPACE_AROUND_NEWLINE, "\n")
    .replace(BLANK_RUN, "\n\n")
    .trim();
}


/** Cut at or below `maxChars`, preferring the last word boundary. */
function truncateOnWord(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;

  const slice = text.slice(0, maxChars);
  // Prefer a boundary in the last quarter, so the result is not cut mid-word
  // whenever a reasonable break exists.
  const floor = Math.floor(maxChars * 0.75);
  for (const boundary of ["\n", ". ", " "]) {
    const at = slice.lastIndexOf(boundary);
    if (at >= floor) return `${slice.slice(0, at).trimEnd()}…`;
  }
  return `${slice.trimEnd()}…`;
}
