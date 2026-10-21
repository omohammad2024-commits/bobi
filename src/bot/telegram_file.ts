/**
 * Fetching a Telegram file's bytes — the one shared implementation.
 *
 * Telegram never inlines file bytes: `getFile` resolves a file_id to a
 * server-side path, and the bytes live at
 * `https://api.telegram.org/file/bot<token>/<path>`. Three call sites used
 * to each carry a private copy of this fetch (media extraction, skill
 * install, memory import), and every copy shared the same two holes: no
 * timeout (a file endpoint that accepts the connection and never answers
 * hangs the turn forever) and no streaming size cap (the whole body was
 * buffered before any size check ran, so a lying or absent declared size
 * meant unbounded memory). This helper is the fix applied once: a hard
 * timeout on the fetch, and a reader that abandons the stream the moment
 * the caller's byte ceiling is passed.
 *
 * The contract mirrors what every copy already promised its caller:
 * bytes on success, `undefined` on ANY failure — a network fault, a
 * deleted file, an expired file id, an over-cap or timed-out download
 * are indistinguishable to the caller, deliberately.
 */

/** Hard ceiling on one Telegram file fetch, ms. */
export const TELEGRAM_FILE_TIMEOUT_MS = 30_000;

/** The slice of the Bot API this helper needs (grammy's Api satisfies it). */
export interface TelegramFileApi {
  getFile(fileId: string): Promise<{ file_path?: string }>;
}

export interface FetchTelegramFileOptions {
  /** Byte ceiling for THIS call site; the stream is abandoned past it. */
  maxBytes: number;
  /** Fetch timeout in ms. Defaults to TELEGRAM_FILE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Transport. Defaults to the global fetch. Injectable for tests. */
  fetchFn?: typeof fetch;
}

/**
 * Download one Telegram file's bytes.
 *
 * Returns undefined on any failure (see the module header). The file path
 * guard is load-bearing, not decorative: a path that is absolute or
 * traverses upward is not one this bot should fetch — the API never
 * returns such a path, so its presence means the response is not what it
 * claims to be.
 */
export async function fetchTelegramFileBytes(
  api: TelegramFileApi,
  botToken: string,
  fileId: string,
  opts: FetchTelegramFileOptions,
): Promise<Uint8Array | undefined> {
  const doFetch = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? TELEGRAM_FILE_TIMEOUT_MS,
  );
  try {
    const file = await api.getFile(fileId);
    if (file.file_path === undefined) return undefined;
    if (file.file_path.startsWith("/") || file.file_path.includes("..")) return undefined;

    const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const res = await doFetch(url, { signal: controller.signal });
    if (!res.ok) return undefined;

    // Streamed read with the ceiling enforced DURING the download: the
    // first chunk that pushes the total past maxBytes cancels the stream
    // and fails the fetch, so the body is never buffered whole.
    const reader = res.body?.getReader();
    if (reader === undefined) return undefined;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
