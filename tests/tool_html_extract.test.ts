/**
 * HTML → text extraction.
 *
 * The extractor is a pure function, so it is tested directly against realistic
 * markup rather than through a network. The two things that matter: prose
 * survives legibly, and executable or chrome content never reaches the model as
 * if it were content.
 */
import { describe, expect, test } from "bun:test";
import { decodeEntities, htmlToText } from "../src/tools/html";

describe("script and style removal", () => {
  test("a script body is dropped entirely", () => {
    const html = `<html><body><p>قبل</p><script>alert("x")</script><p>بعد</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("قبل");
    expect(text).toContain("بعد");
    expect(text).not.toContain("alert");
  });

  test("a style body is dropped entirely", () => {
    const html = `<style>.a{color:red}</style><p>متن</p>`;
    const text = htmlToText(html);
    expect(text).toContain("متن");
    expect(text).not.toContain("color");
  });

  test("`</script>` inside a JS string does not end the script early", () => {
    // This is why the scanner seeks the real closing tag instead of matching
    // angle brackets: a naive stripper would leak the rest of the script.
    const html = `<script>var s = "</script>"; var secret = "LEAKED";</script><p>ok</p>`;
    const text = htmlToText(html);
    expect(text).not.toContain("LEAKED");
    expect(text).toContain("ok");
  });

  test("angled brackets inside a style body do not leak", () => {
    const html = `<style>a::after{content:"<b>"}</style><p>ok</p>`;
    const text = htmlToText(html);
    expect(text).not.toContain("content");
    expect(text).toContain("ok");
  });

  test("noscript, template, and head are dropped", () => {
    const html = `
      <head><title>عنوان</title><meta name="x" content="y"></head>
      <noscript>NOJS</noscript>
      <template>TMPL</template>
      <body><p>بدنه</p></body>`;
    const text = htmlToText(html);
    expect(text).toContain("بدنه");
    expect(text).not.toContain("NOJS");
    expect(text).not.toContain("TMPL");
  });

  test("comments are removed", () => {
    const html = `<!-- یک توضیح --><p>متن</p><!-- شرح -->`;
    const text = htmlToText(html);
    expect(text).toContain("متن");
    expect(text).not.toContain("توضیح");
  });

  test("a doctype is removed", () => {
    const text = htmlToText(`<!DOCTYPE html><html><body><p>متن</p></body></html>`);
    expect(text).toContain("متن");
    expect(text).not.toContain("DOCTYPE");
  });
});

describe("chrome removal", () => {
  test("nav, header, footer and aside are dropped", () => {
    const html = `
      <nav>منو</nav>
      <header>سرصفحه</header>
      <article><p>مقاله</p></article>
      <aside>کنار</aside>
      <footer>پاصفحه</footer>`;
    const text = htmlToText(html);
    expect(text).toContain("مقاله");
    for (const junk of ["منو", "سرصفحه", "کنار", "پاصفحه"]) {
      expect(text).not.toContain(junk);
    }
  });

  test("form controls are dropped", () => {
    const html = `<form><input value="x"><button>ارسال</button></form><p>متن</p>`;
    const text = htmlToText(html);
    expect(text).toContain("متن");
    expect(text).not.toContain("ارسال");
  });
});

describe("prose preservation", () => {
  test("paragraph structure survives as line breaks", () => {
    const html = `<p>پاراگراف یک</p><p>پاراگراف دو</p>`;
    const text = htmlToText(html);
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("پاراگراف یک");
    expect(lines[1]).toContain("پاراگراف دو");
  });

  test("heading text is kept", () => {
    expect(htmlToText(`<h1>تیتر</h1><p>متن</p>`)).toContain("تیتر");
  });

  test("list items each get a line", () => {
    const text = htmlToText(`<ul><li>یک</li><li>دو</li><li>سه</li></ul>`);
    expect(text).toContain("یک");
    expect(text).toContain("دو");
    expect(text).toContain("سه");
  });

  test("inline markup does not split a sentence", () => {
    const html = `<p>این <strong>مهم</strong> است.</p>`;
    // The words must read as one line, not three.
    const line = htmlToText(html).split("\n")[0]!;
    expect(line).toContain("این");
    expect(line).toContain("مهم");
    expect(line).toContain("است");
  });

  test("an unclosed tag does not swallow the text after it", () => {
    const text = htmlToText(`<p>متن بدون بستن`);
    expect(text).toContain("متن بدون بستن");
  });

  test("a bare `<` in text is not treated as a tag", () => {
    const text = htmlToText(`<p>۲ &lt; ۳ و ۵ > ۴</p>`);
    expect(text).toContain("<");
    expect(text).toContain(">");
  });

  test("an unterminated tag at the end is discarded, not emitted", () => {
    const text = htmlToText(`<p>متن</p><div class="unclosed`);
    expect(text).toContain("متن");
    expect(text).not.toContain("unclosed");
  });
});

describe("entity decoding", () => {
  test("named entities decode", () => {
    expect(htmlToText(`<p>&amp; &lt; &gt; &quot; &nbsp; &hellip;</p>`)).toContain("& < >");
  });

  test("numeric and hex escapes decode", () => {
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
  });

  test("the C1 range is remapped to real glyphs, not control codes", () => {
    // `&#146;` means a right single quote in every browser.
    expect(decodeEntities("&#146;")).toBe("’");
    expect(decodeEntities("&#151;")).toBe("—");
  });

  test("an unknown entity is left as written rather than dropped", () => {
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;");
  });

  test("a malformed numeric escape is left as written", () => {
    expect(decodeEntities("&#;")).toBe("&#;");
    expect(decodeEntities("&#x;")).toBe("&#x;");
  });

  test("an out-of-range code point does not throw", () => {
    expect(() => decodeEntities("&#9999999999;")).not.toThrow();
    expect(() => decodeEntities("&#xD800;")).not.toThrow();
  });

  test("a soft hyphen is removed", () => {
    expect(decodeEntities("a&shy;b")).toBe("ab");
  });
});

describe("whitespace normalisation", () => {
  test("source indentation does not become leading whitespace", () => {
    const html = `
      <div>
        <p>متن</p>
      </div>`;
    const text = htmlToText(html);
    expect(text).toBe("متن");
  });

  test("a run of blank lines collapses to one", () => {
    const text = htmlToText(`<p>یک</p><br><br><br><br><p>دو</p>`);
    expect(text).not.toMatch(/\n{3,}/);
  });

  test("a non-breaking space is treated as a space", () => {
    const text = htmlToText(`<p>یک&nbsp;&nbsp;دو</p>`);
    expect(text).toBe("یک دو");
  });
});

describe("truncation", () => {
  test("long text is cut with an ellipsis, within the cap", () => {
    const html = `<p>${"کلمه ".repeat(2_000)}</p>`;
    const text = htmlToText(html, { maxChars: 500 });
    expect(text.length).toBeLessThanOrEqual(501);
    expect(text.endsWith("…")).toBe(true);
  });

  test("short text is returned unchanged", () => {
    const text = htmlToText(`<p>کوتاه</p>`, { maxChars: 500 });
    expect(text).toBe("کوتاه");
    expect(text.endsWith("…")).toBe(false);
  });

  test("truncation prefers a word boundary", () => {
    const html = `<p>${"alpha ".repeat(500)}</p>`;
    const text = htmlToText(html, { maxChars: 200 });
    // The cut lands on a space, so no partial word is left dangling.
    expect(text.slice(0, -1).trimEnd()).toBe(text.slice(0, -1).trimEnd().trim());
    expect(text).not.toMatch(/alph…$/);
  });
});

describe("robustness", () => {
  test("empty input yields empty output", () => {
    expect(htmlToText("")).toBe("");
  });

  test("markup-only input yields empty output", () => {
    expect(htmlToText("<div><span></span></div>")).toBe("");
  });

  test("plain text passes through", () => {
    expect(htmlToText("فقط متن ساده")).toBe("فقط متن ساده");
  });

  test("deeply nested markup does not throw", () => {
    const html = `${"<div>".repeat(500)}متن${"</div>".repeat(500)}`;
    expect(() => htmlToText(html)).not.toThrow();
    expect(htmlToText(html)).toContain("متن");
  });

  test("a malformed closing tag does not throw", () => {
    expect(() => htmlToText("<p>متن</>")).not.toThrow();
    expect(() => htmlToText("</div></p></html>")).not.toThrow();
  });

  test("extraction is deterministic", () => {
    const html = `<html><body><h1>ت</h1><p>متن &amp; بیشتر</p></body></html>`;
    expect(htmlToText(html)).toBe(htmlToText(html));
  });
});
