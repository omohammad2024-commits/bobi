/**
 * Pinned HTTP transport — the connection can only go to a validated address.
 *
 * Why this exists: Bun's `fetch` ignores a custom `lookup` option (verified by
 * experiment — it still issues `getaddrinfo` itself), so resolving DNS, checking
 * the answer, and then calling ordinary `fetch()` with the hostname would leave
 * exactly the DNS-rebinding race this module is meant to close. The socket is
 * therefore created by `node:http`/`node:https` with a `lookup` that returns
 * only the addresses `dns_guard` approved. `node:net` calls that function
 * instead of the system resolver, so there is no second, unvalidated lookup
 * between validation and connect.
 *
 * TLS is unaffected: `host`/`servername` remain the original hostname, so SNI
 * and certificate verification check the name the owner configured while the
 * socket dials the validated IP. No option is passed that would relax
 * certificate checking.
 *
 * Redirects are never followed (Node does not follow them by default), so a
 * 3xx cannot move the request to another address; adapters still reject 3xx
 * explicitly.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { AiError } from "./provider";
import { classifyAddress } from "./dns_guard";

export interface PinnedRequest {
  /** Full request URL. Its hostname must be the validated one. */
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** Caller cancellation. */
  signal: AbortSignal;
  /** The validated addresses. The socket may only connect to these. */
  addresses: readonly string[];
  /**
   * The owner's local-target opt-in for this provider.
   *
   * The connection re-applies the SAME policy the DNS guard applied, so the
   * transport never dials an address that was never permitted in the first
   * place. A caller that forgets to thread this flag through cannot widen the
   * boundary to loopback/private ranges, and the mandatory blocks
   * (link-local/metadata, multicast, unspecified, broadcast, reserved) stay
   * refused either way.
   */
  allowLocalTargets?: boolean;
}

export interface PinnedResponse {
  status: number;
  headers: Record<string, string | undefined>;
  /** Response body, already read. */
  body: string;
}

/**
 * Ceiling on a response body, in bytes.
 *
 * The body is accumulated in memory, so an unbounded read lets a hostile or
 * broken provider stream until the process runs out of memory. Chat
 * completions are far smaller than this; anything past the limit is treated as
 * a response fault rather than being kept.
 */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * The `lookup` handed to `node:http`/`node:https`.
 *
 * Verified call shape on this runtime: `(hostname, options, callback)` with
 * `options.all === true`. The Node-compat surface also accepts the older
 * `(options, callback)` form, so both are handled. Either way the answer is
 * ONLY the validated addresses — the system resolver is never consulted for
 * this connection, which is what closes the rebinding race.
 */
export function pinnedLookup(addresses: readonly string[]): (...args: unknown[]) => void {
  const familyOf = (address: string): number => (address.includes(":") ? 6 : 4);
  const isV6 = (address: string): boolean => address.includes(":");

  return (...args: unknown[]): void => {
    const cb = args[args.length - 1];
    if (typeof cb !== "function") {
      // A signature this code does not understand must not fall back to a
      // system lookup; failing here is the fail-closed behaviour. The throw
      // propagates to the promise executor, so it becomes a rejection.
      throw new Error("unsupported lookup callback shape");
    }

    const options = args.find(
      (a): a is { all?: boolean; family?: number } => typeof a === "object" && a !== null,
    );
    const wantsAll = options?.all === true;
    // Observed on this runtime: `{family: 6, hints: 0}` with no `all` flag, in
    // which case the scalar (err, address, family) form is expected.
    const family = typeof options?.family === "number" ? options.family : 0;

    const eligible = addresses.filter((address) => {
      if (family === 4) return !isV6(address);
      if (family === 6) return isV6(address);
      return true;
    });

    if (eligible.length === 0) {
      // The caller asked for a family this resolution did not provide. Node's
      // own resolver reports an error here, and returning an address of the
      // wrong family would silently violate the request.
      (cb as Function)(new Error("no pinned address for requested family"));
      return;
    }

    if (wantsAll) {
      (cb as Function)(
        null,
        eligible.map((address) => ({ address, family: familyOf(address) })),
      );
      return;
    }
    const first = eligible[0]!;
    (cb as Function)(null, first, familyOf(first));
  };
}

/**
 * The pinned lookup, preferring the `all` form.
 *
 * This exists because of a REAL failure observed in production: a DNS answer set
 * routinely contains addresses that accept a TCP connection and then never
 * respond — Google's `generativelanguage.googleapis.com` resolved to eight A
 * records, the first of which black-holed every request while the second
 * answered fine. Handing Node a SINGLE address made the request die on a
 * timeout, even though working addresses were in the same answer set.
 *
 * Node's `net.connect` treats a list from the `all` form as a fallback chain:
 * it advances to the next address when a connection attempt fails. That is
 * exactly the behaviour needed here, and it does NOT widen the security
 * boundary — every address in the list was resolved and classified by
 * `dns_guard`, so the socket still cannot reach anything that was not approved.
 *
 * The single-address form remains as the fallback for a runtime that calls the
 * lookup without `all`, since dropping it would break those runtimes.
 */
export function pinnedLookupAll(addresses: readonly string[]): (...args: unknown[]) => void {
  const scalar = pinnedLookup(addresses);

  return (...args: unknown[]): void => {
    const options = args.find(
      (a): a is { all?: boolean; family?: number } => typeof a === "object" && a !== null,
    );
    // Only the `all` shape is handled here; anything else defers to the scalar
    // implementation so both call conventions keep working.
    if (options?.all !== true) {
      scalar(...args);
      return;
    }

    const cb = args[args.length - 1];
    if (typeof cb !== "function") {
      throw new Error("unsupported lookup callback shape");
    }

    const family = typeof options.family === "number" ? options.family : 0;
    const eligible = addresses.filter((address) => {
      const isV6 = address.includes(":");
      if (family === 4) return !isV6;
      if (family === 6) return isV6;
      return true;
    });

    if (eligible.length === 0) {
      (cb as Function)(new Error("no pinned address for requested family"));
      return;
    }

    (cb as Function)(
      null,
      eligible.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      })),
    );
  };
}

/**
 * Send one request, bound to a validated address set.
 *
 * @throws AiError: `invalid_response` for an unusable URL, `timeout` when the
 * deadline passes, `aborted` when the caller cancels, `network` on a transport
 * failure. Messages never contain the pinned address or headers.
 */
export async function pinnedFetch(req: PinnedRequest): Promise<PinnedResponse> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new AiError("invalid_response", "آدرس سرویس نامعتبر است.");
  }
  if (req.addresses.length === 0) {
    throw new AiError("invalid_response", "آدرس اتصال پروایدر مشخص نیست.");
  }
  // Credentials in a URL would be echoed by error paths; the transport never
  // uses them, so refuse rather than silently drop them.
  if (url.username.length > 0 || url.password.length > 0) {
    throw new AiError("invalid_response", "آدرس سرویس نباید شامل نام کاربری باشد.");
  }

  const secure = url.protocol === "https:";
  // Only the two schemes this transport implements. Anything else would fall
  // through to a plain HTTP socket, so it is refused instead.
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AiError("invalid_response", "آدرس سرویس باید http یا https باشد.");
  }

  // Re-apply the address policy here, at the connection boundary. The DNS
  // guard already checked these, but this is the last place a socket can be
  // opened, so a caller that passes an address nobody validated is refused
  // rather than trusted. No socket exists yet when this throws.
  for (const address of req.addresses) {
    if (!classifyAddress(address, req.allowLocalTargets === true).allowed) {
      throw new AiError("invalid_response", "آدرس اتصال پروایدر مجاز نیست.");
    }
  }

  return attemptAddresses(req, url);
}

/**
 * Try each validated address in turn until one answers.
 *
 * WHY THIS LOOPS RATHER THAN LETTING NODE FALL THROUGH:
 *
 * A DNS answer set routinely contains addresses that accept a TCP connection and
 * then never reply — a black hole. This was observed against
 * `generativelanguage.googleapis.com`, where the first of eight A records
 * swallowed every request while later ones answered in under a second.
 *
 * Node's `lookup` supports returning a list, and for a connection attempt it
 * will advance to the next entry — but only for the CONNECT phase. Once a
 * request body has been written to a black-holed socket, Node will not re-send
 * it elsewhere, because it cannot know how much of it the peer received. A
 * `GET` therefore recovers on its own and a `POST` does not, which is exactly
 * what was measured: GET succeeded against the full set while POST timed out.
 *
 * So the retry has to happen up here, at the request level, where a fresh
 * attempt sends a fresh body. Every address tried was already classified by the
 * DNS guard, so the security boundary is unchanged: the socket still cannot
 * reach anything that was not approved.
 */
async function attemptAddresses(req: PinnedRequest, url: URL): Promise<PinnedResponse> {
  const deadline = Date.now() + Math.max(1, req.timeoutMs);
  let lastError: AiError | undefined;

  for (const [index, address] of req.addresses.entries()) {
    // Stop when the caller's deadline has passed. A timeout is reported as
    // such rather than as a network fault, because that is what it is.
    if (Date.now() >= deadline) {
      throw lastError ?? new AiError("timeout", "پاسخ سرویس به‌موقع نرسید.");
    }
    if (req.signal.aborted) throw new AiError("aborted", "درخواست لغو شد.");

    // Each attempt gets a share of what is left, so no single dead address can
    // consume the whole budget. The last address gets the remainder.
    const remaining = deadline - Date.now();
    const share = Math.max(
      MIN_ATTEMPT_MS,
      Math.floor(remaining / (req.addresses.length - index)),
    );

    try {
      return await attemptOne(req, url, [address], Math.min(share, remaining));
    } catch (err) {
      const mapped = err instanceof AiError ? err : new AiError("network", "ارتباط با سرویس برقرار نشد.");
      // A cancellation or a caller-imposed expiry ends the whole attempt: the
      // remaining addresses cannot fix either.
      if (mapped.kind === "aborted") throw mapped;
      lastError = mapped;
    }
  }

  throw lastError ?? new AiError("network", "ارتباط با سرویس برقرار نشد.");
}

/**
 * Floor for one address attempt.
 *
 * Below this a slow-but-working address would be abandoned before it could
 * answer, turning a healthy service into a failure.
 */
const MIN_ATTEMPT_MS = 2_000;

/**
 * Send one request, bound to the given addresses.
 *
 * @throws AiError: `invalid_response` for an unusable URL, `timeout` when the
 * deadline passes, `aborted` when the caller cancels, `network` on a transport
 * failure. Messages never contain the pinned address or headers.
 */
function attemptOne(
  req: PinnedRequest,
  url: URL,
  addresses: readonly string[],
  timeoutMs: number,
): Promise<PinnedResponse> {
  const secure = url.protocol === "https:";
  const requestFn = secure ? httpsRequest : httpRequest;
  const port = url.port ? Number(url.port) : secure ? 443 : 80;

  return new Promise<PinnedResponse>((resolve, reject) => {
    // Declared first so the abort and timeout callbacks below can always tear
    // them down: an already-aborted signal must not hit a temporal dead zone
    // or schedule a request that was cancelled before it was built.
    let settled = false;
    let outgoing: ReturnType<typeof requestFn> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    const teardown = (): void => {
      if (deadline !== undefined) clearTimeout(deadline);
      req.signal.removeEventListener("abort", onAbort);
      outgoing?.destroy();
    };

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      teardown();
      reject(new AiError("aborted", "درخواست لغو شد."));
    };

    const deadlineFn = (): void => {
      if (settled) return;
      settled = true;
      teardown();
      reject(new AiError("timeout", "پاسخ سرویس به‌موقع نرسید."));
    };

    deadline = setTimeout(deadlineFn, Math.max(1, timeoutMs));
    // An already-aborted signal never fires its "abort" listener (the DOM
    // rule), so the aborted state has to be read directly. Without this the
    // cancelled request would still open a socket and wait for the timeout.
    if (req.signal.aborted) {
      settled = true;
      clearTimeout(deadline);
      reject(new AiError("aborted", "درخواست لغو شد."));
      return;
    }
    req.signal.addEventListener("abort", onAbort, { once: true });

    try {
      outgoing = requestFn({
        hostname: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers: req.headers,
        // The connection target comes from here and nowhere else.
        lookup: pinnedLookup(addresses),
        // Keep SNI/cert verification on the configured hostname. `servername`
        // must equal the original name or the certificate check would compare
        // against the IP instead.
        servername: secure ? url.hostname : undefined,
        // `rejectUnauthorized` is intentionally absent: it stays enabled.
      } as never);
    } catch (err) {
      // A synchronous failure (for example an unrecognised lookup signature)
      // must surface as a rejected request with a deadline still cleaned up,
      // not as a stray timer or an unhandled throw.
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      req.signal.removeEventListener("abort", onAbort);
      const message = err instanceof Error ? err.message : String(err);
      reject(
        message.includes("pinned") || message.includes("family")
          ? new AiError("network", "اتصال به آدرس اعتبارسنجی‌شده برقرار نشد.")
          : new AiError("network", "ارتباط با سرویس برقرار نشد."),
      );
      return;
    }

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      teardown();
      fn();
    };

    outgoing.on("error", (err: NodeJS.ErrnoException) => {
      settle(() => {
        if (err.name === "AbortError" || err.code === "ABORT_ERR") {
          reject(new AiError("aborted", "درخواست لغو شد."));
          return;
        }
        // A getaddrinfo failure would mean our pinned lookup was bypassed;
        // either way the request did not reach a validated address, so it
        // fails closed rather than being retried by name.
        reject(new AiError("network", "ارتباط با سرویس برقرار نشد."));
      });
    });

    outgoing.on("timeout", () => {
      settle(() => {
        outgoing?.destroy();
        reject(new AiError("timeout", "پاسخ سرویس به‌موقع نرسید."));
      });
    });

    outgoing.on("response", (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let received = 0;
      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) {
          // Stop accumulating and drop the socket rather than let an
          // unbounded body exhaust memory.
          settle(() =>
            reject(new AiError("invalid_response", "پاسخ سرویس بیش از حد بزرگ است.")),
          );
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", () => {
        settle(() => reject(new AiError("network", "ارتباط با سرویس برقرار نشد.")));
      });
      res.on("end", () => {
        settle(() => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | undefined>,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });
    });

    if (req.body !== undefined) {
      outgoing.write(req.body);
    }
    outgoing.end();
  });
}
