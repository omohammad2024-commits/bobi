/**
 * Search result parsing.
 *
 * Both parsers are pure functions over a captured payload, so these run offline.
 * The DuckDuckGo one is the fragile half — it reads public HTML rather than an
 * API — so it is tested against a realistic fixture that mirrors the markup it
 * depends on. If that layout changes, these tests fail with a clear cause
 * instead of the bot silently returning nothing.
 */
import { describe, expect, test } from "bun:test";
import { parseDuckDuckGoHtml } from "../src/search/duckduckgo";
import { parseTavilyResponse } from "../src/search/tavily";
import {
  isSearchProviderType,
  SEARCH_TEMPLATES,
  userMessageForSearch,
} from "../src/search/provider";

/** A results page shaped like the endpoint's real output. */
const DDG_HTML = `<!DOCTYPE html>
<html><body>
<div class="serp__results">
  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffirst&amp;rut=abc">First &amp; Result</a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffirst">A summary of the <b>first</b> page.</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fsecond">Second Result</a>
      </h2>
      <div class="result__snippet">The second page's summary &hellip; here.</div>
    </div>
  </div>
  <div class="result">
    <a class="result__a" href="https://direct.example.net/third">Third &mdash; direct</a>
    <a class="result__snippet">Direct link, no wrapper.</a>
  </div>
</div>
</body></html>`;

describe("DuckDuckGo parsing", () => {
  test("all three results parse", () => {
    const results = parseDuckDuckGoHtml(DDG_HTML, 10);
    expect(results).toHaveLength(3);
  });

  test("the title keeps its decoded ampersand", () => {
    const results = parseDuckDuckGoHtml(DDG_HTML, 10);
    expect(results[0]!.title).toBe("First & Result");
  });

  test("redirect-wrapped links are unwrapped to the real target", () => {
    const results = parseDuckDuckGoHtml(DDG_HTML, 10);
    expect(results[0]!.url).toBe("https://example.com/first");
    expect(results[1]!.url).toBe("https://example.org/second");
  });

  test("a direct link is kept as-is", () => {
    const results = parseDuckDuckGoHtml(DDG_HTML, 10);
    expect(results[2]!.url).toBe("https://direct.example.net/third");
    expect(results[2]!.title).toBe("Third — direct");
  });

  test("snippets are extracted and stripped of markup", () => {
    const results = parseDuckDuckGoHtml(DDG_HTML, 10);
    expect(results[0]!.snippet).toBe("A summary of the first page.");
    expect(results[1]!.snippet).toBe("The second page's summary … here.");
  });

  test("a snippet rendered as a div is still found", () => {
    const results = parseDuckDuckGoHtml(DDG_HTML, 10);
    expect(results[1]!.snippet.length).toBeGreaterThan(0);
  });

  test("the limit is respected", () => {
    expect(parseDuckDuckGoHtml(DDG_HTML, 1)).toHaveLength(1);
    expect(parseDuckDuckGoHtml(DDG_HTML, 2)).toHaveLength(2);
  });

  test("no results yields an empty list rather than throwing", () => {
    expect(parseDuckDuckGoHtml("<html><body>no results</body></html>", 5)).toEqual([]);
  });

  test("empty input yields an empty list", () => {
    expect(parseDuckDuckGoHtml("", 5)).toEqual([]);
  });

  test("a duplicate target appears once", () => {
    const dup = DDG_HTML + DDG_HTML;
    const results = parseDuckDuckGoHtml(dup, 10);
    const urls = results.map((r) => r.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  test("a non-http redirect target is dropped", () => {
    // A `uddg` pointing at javascript: or file: must never reach the model.
    const html = `<a class="result__a" href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)">bad</a><a class="result__snippet">x</a>`;
    expect(parseDuckDuckGoHtml(html, 5)).toEqual([]);
  });

  test("an unparseable href is dropped, not passed through", () => {
    const html = `<a class="result__a" href="ht tp://bad">bad</a><a class="result__snippet">x</a>`;
    expect(parseDuckDuckGoHtml(html, 5)).toEqual([]);
  });

  test("a result with no title but a valid link is skipped", () => {
    // An empty title would leave the model nothing to cite.
    const html = `<a class="result__a" href="https://example.com/x"></a><a class="result__snippet">x</a>`;
    expect(parseDuckDuckGoHtml(html, 5)).toEqual([]);
  });

  test("a missing snippet falls back to the title", () => {
    const html = `<a class="result__a" href="https://example.com/x">Only Title</a>`;
    const results = parseDuckDuckGoHtml(html, 5);
    expect(results[0]!.snippet).toBe("Only Title");
  });

  test("whitespace in the title and snippet is collapsed", () => {
    const html = `<a class="result__a" href="https://e.com/x">  A
      multi-line   title </a><a class="result__snippet"> spaced   out </a>`;
    const results = parseDuckDuckGoHtml(html, 5);
    expect(results[0]!.title).toBe("A multi-line title");
    expect(results[0]!.snippet).toBe("spaced out");
  });

  test("parsing is deterministic", () => {
    expect(parseDuckDuckGoHtml(DDG_HTML, 5)).toEqual(parseDuckDuckGoHtml(DDG_HTML, 5));
  });
});

describe("Tavily parsing", () => {
  const payload = JSON.stringify({
    results: [
      { title: "One", url: "https://example.com/1", content: "First content" },
      { title: "Two", url: "https://example.com/2", content: "Second content" },
    ],
  });

  test("results parse", () => {
    const results = parseTavilyResponse(payload);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "One",
      url: "https://example.com/1",
      snippet: "First content",
    });
  });

  test("a malformed body is a parse failure", () => {
    expect(() => parseTavilyResponse("{not json")).toThrow();
  });

  test("a non-object body is a parse failure", () => {
    expect(() => parseTavilyResponse("[]")).toThrow();
    expect(() => parseTavilyResponse('"str"')).toThrow();
  });

  test("a missing results array yields an empty list", () => {
    expect(parseTavilyResponse("{}")).toEqual([]);
  });

  test("a non-http url is dropped", () => {
    const bad = JSON.stringify({
      results: [
        { title: "bad", url: "javascript:alert(1)", content: "x" },
        { title: "file", url: "file:///etc/passwd", content: "x" },
        { title: "ok", url: "https://example.com/ok", content: "x" },
      ],
    });
    const results = parseTavilyResponse(bad);
    expect(results).toHaveLength(1);
    expect(results[0]!.url).toBe("https://example.com/ok");
  });

  test("an entry with no title falls back to its url", () => {
    const p = JSON.stringify({ results: [{ url: "https://e.com/x", content: "c" }] });
    expect(parseTavilyResponse(p)[0]!.title).toBe("https://e.com/x");
  });

  test("an entry with no content falls back to its title", () => {
    const p = JSON.stringify({ results: [{ title: "T", url: "https://e.com/x" }] });
    expect(parseTavilyResponse(p)[0]!.snippet).toBe("T");
  });

  test("entries that are not objects are skipped", () => {
    const p = JSON.stringify({ results: [null, "str", 42, { url: "https://e.com/x" }] });
    const results = parseTavilyResponse(p);
    expect(results).toHaveLength(1);
  });
});

describe("provider metadata", () => {
  test("only the known provider slugs are accepted", () => {
    expect(isSearchProviderType("duckduckgo")).toBe(true);
    expect(isSearchProviderType("tavily")).toBe(true);
    expect(isSearchProviderType("google")).toBe(false);
    expect(isSearchProviderType("")).toBe(false);
  });

  test("every template declares whether it needs a key", () => {
    for (const t of SEARCH_TEMPLATES) {
      expect(typeof t.needsKey).toBe("boolean");
      expect(t.label.length).toBeGreaterThan(0);
    }
    // The keyless one comes first, so the panel's default is the usable option.
    expect(SEARCH_TEMPLATES[0]!.needsKey).toBe(false);
  });

  test("every failure kind has a user-safe message", () => {
    for (const kind of ["config", "auth", "network", "timeout", "parse", "rate_limited"] as const) {
      const message = userMessageForSearch(kind);
      expect(message.length).toBeGreaterThan(0);
      // No internals leak into a user-facing string.
      expect(message).not.toContain("undefined");
    }
  });
});
