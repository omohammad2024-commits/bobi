/**
 * Mock web_search / fetch_url data for bench runs.
 *
 * Offline bench runs cannot hit the network, so web tasks carry canned
 * results in their YAML (`mocks:`). These functions serve that canned data.
 *
 * Two consumption paths:
 *  1. The Tool objects below (same names + input shapes as the real tools,
 *     for any direct use).
 *  2. BenchToolService in run.ts intercepts `execute()` for "web_search" /
 *     "fetch_url" and serves the mocks there, because the real fetch_url is
 *     already registered in DEFAULT_TOOLS and the registry rejects duplicate
 *     names. Interception keeps the model's view (specs) identical while
 *     making execution deterministic and offline.
 *
 * The runner sets the active mocks before each task (single-threaded,
 * sequential execution). Never used in production.
 */
import type { Tool } from "../src/tools/types";
import type { MockWebSearchResult, TaskMocks } from "./schema";

let current: TaskMocks | undefined;

/** Canned data the mocks serve for the task currently running. */
export function setTaskMocks(mocks: TaskMocks | undefined): void {
  current = mocks;
}

/** Mocks for the task currently running (undefined when none). */
export function getTaskMocks(): TaskMocks | undefined {
  return current;
}

/** Canned web_search response data (mirrors the real tool's output shape). */
export function serveMockWebSearch(
  query: string,
  mocks: TaskMocks | undefined = current,
): { query: string; provider: string; results: MockWebSearchResult[] } {
  const results = mocks?.web_search?.results ?? [];
  return {
    query,
    provider: "bench-mock",
    results: results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
  };
}

/** Canned fetch_url response data (mirrors the real tool's output shape). */
export function serveMockFetchUrl(
  url: string,
  mocks: TaskMocks | undefined = current,
): {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
} {
  const pages = mocks?.fetch_url ?? {};
  const text =
    pages[url] ?? "این صفحه در حالت بنچ‌مارک آفلاین شبیه‌سازی شده و محتوای واقعی ندارد.";
  return {
    url,
    finalUrl: url,
    status: pages[url] !== undefined ? 200 : 404,
    contentType: "text/html",
    text,
    truncated: false,
  };
}

const PERM_WEB = "tools:web_search";
const PERM_FETCH = "tools:fetch_url";

/** Mock web_search tool object (same name/input shape as the real tool). */
export function createMockWebSearchTool(): Tool<{ query: string }, unknown> {
  return {
    name: "web_search",
    description:
      "جستجوی وب. برای پیدا کردن اطلاعات تازه یا منابع بیرون از دانش مدل استفاده کن.",
    enabled: true,
    permission: { requires: [PERM_WEB] },
    toolset: "web",
    input: {
      fields: {
        query: { type: "string", required: true, description: "عبارت جستجو." },
        limit: { type: "number", description: "حداکثر نتایج." },
      },
    },
    async run(input) {
      return serveMockWebSearch(String(input.query ?? "").trim());
    },
  } as Tool<{ query: string }, unknown>;
}

/** Mock fetch_url tool object (same name/input shape as the real tool). */
export function createMockFetchUrlTool(): Tool<{ url: string }, unknown> {
  return {
    name: "fetch_url",
    description:
      "محتوای یک صفحهٔ وب را می‌خواند و به متن تبدیل می‌کند. برای خواندن جزئیات یک لینک.",
    enabled: true,
    permission: { requires: [PERM_FETCH] },
    toolset: "web",
    input: {
      fields: {
        url: { type: "string", required: true, description: "نشانی صفحه." },
        raw: { type: "boolean", description: "متن خام." },
        maxChars: { type: "number", description: "سقف نویسه." },
      },
    },
    async run(input) {
      return serveMockFetchUrl(String(input.url ?? "").trim());
    },
  } as Tool<{ url: string }, unknown>;
}
