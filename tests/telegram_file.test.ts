/**
 * The shared Telegram file fetch (P0-NET-3).
 *
 * Before this helper existed, three call sites each carried a private copy
 * of "getFile, then fetch the file URL" — none with a timeout, none with a
 * streaming size cap (the body was buffered whole before any size check).
 * These tests pin the helper's contract: bytes on success, undefined on
 * any failure, the stream abandoned at the caller's cap, and a fetch that
 * hangs being cut by the timeout. All transports are injected — no network.
 */
import { describe, expect, test } from "bun:test";
import {
  fetchTelegramFileBytes,
  TELEGRAM_FILE_TIMEOUT_MS,
  type TelegramFileApi,
} from "../src/bot/telegram_file";

const apiWithPath = (filePath: string | undefined): TelegramFileApi => ({
  getFile: async () => (filePath === undefined ? {} : { file_path: filePath }),
});

const okFetch = (body: BodyInit): typeof fetch =>
  (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

describe("fetchTelegramFileBytes", () => {
  test("returns the file's bytes on success", async () => {
    const bytes = await fetchTelegramFileBytes(apiWithPath("docs/a.bin"), "T", "f1", {
      maxBytes: 1024,
      fetchFn: okFetch(new Uint8Array([1, 2, 3, 4])),
    });
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test("builds the file URL from the token and the getFile path", async () => {
    let seenUrl = "";
    const fetchFn = (async (input: RequestInfo | URL) => {
      seenUrl = String(input);
      return new Response(new Uint8Array([9]), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchTelegramFileBytes(apiWithPath("photos/p.jpg"), "TOK123", "f1", {
      maxBytes: 10,
      fetchFn,
    });
    expect(seenUrl).toBe("https://api.telegram.org/file/botTOK123/photos/p.jpg");
  });

  test("a missing or traversing file path is refused before any fetch", async () => {
    let fetches = 0;
    const fetchFn = (async () => {
      fetches++;
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as unknown as typeof fetch;
    for (const bad of [undefined, "/etc/passwd", "../secret", "a/../../b"]) {
      const out = await fetchTelegramFileBytes(apiWithPath(bad), "T", "f1", {
        maxBytes: 10,
        fetchFn,
      });
      expect(out).toBeUndefined();
    }
    expect(fetches).toBe(0);
  });

  test("a non-OK response is a failure", async () => {
    const fetchFn = (async () =>
      new Response("no", { status: 404 })) as unknown as typeof fetch;
    const out = await fetchTelegramFileBytes(apiWithPath("x.bin"), "T", "f1", {
      maxBytes: 10,
      fetchFn,
    });
    expect(out).toBeUndefined();
  });

  test("the stream is abandoned at the cap instead of buffered whole", async () => {
    let pulls = 0;
    const chunk = new Uint8Array(64 * 1024).fill(7);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 200) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const fetchFn = (async () =>
      new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const out = await fetchTelegramFileBytes(apiWithPath("big.bin"), "T", "f1", {
      maxBytes: 1024 * 1024,
      fetchFn,
    });
    expect(out).toBeUndefined();
    // 1MB cap / 64KB chunks = abandon at ~17 pulls, never all 200.
    expect(pulls).toBeLessThan(40);
  });

  test("a fetch that never answers is cut by the timeout", async () => {
    // The endpoint accepts and never responds, but honours AbortSignal —
    // only the helper's own timeout can end this.
    const fetchFn = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("The operation was aborted")),
        );
      })) as unknown as typeof fetch;
    const started = Date.now();
    const out = await fetchTelegramFileBytes(apiWithPath("slow.bin"), "T", "f1", {
      maxBytes: 10,
      timeoutMs: 60,
      fetchFn,
    });
    expect(out).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("the default timeout is a bounded constant", () => {
    expect(TELEGRAM_FILE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(TELEGRAM_FILE_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });
});
