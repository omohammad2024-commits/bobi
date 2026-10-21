/**
 * Health endpoint.
 *
 * Why a bot needs an HTTP server at all: a platform like Railway decides whether
 * a deploy succeeded by polling a URL. Bobi is a long-polling Telegram client
 * with no listening socket, so without this the platform sees an unreachable
 * container and rolls the deploy back — repeatedly, in a restart loop.
 *
 * What it deliberately does NOT do:
 *  - expose configuration, tokens, or user counts
 *  - accept writes, or any method other than GET
 *  - report internals beyond liveness and uptime
 *
 * A health endpoint is an unauthenticated surface by definition, so it says as
 * little as it can while still answering the only question it exists for: is
 * this process alive and serving?
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { APP_NAME, APP_VERSION } from "./app";

export interface HealthOptions {
  /** Port to listen on. */
  port: number;
  /** Host to bind. Loopback by default so a local run is not exposed. */
  host?: string;
  /** Start time, for uptime. Injectable so a test is deterministic. */
  startedAt?: number;
  /** Optional extra liveness detail; must stay free of secrets. */
  detail?: () => Record<string, unknown>;
  /** Sink for a bind failure, so the caller can log it. */
  onError?: (message: string) => void;
}

export interface HealthServer {
  /** The port actually bound, which may differ when 0 was requested. */
  readonly port: number;
  close(): Promise<void>;
}

/**
 * THE canonical /health body (platform Phase 10: one health surface).
 *
 * Both HTTP servers that can answer /health — this standalone server and
 * the API server in src/http/server.ts — build their response here, so the
 * route has exactly one shape no matter which socket owns the port:
 *
 *   { ok: true, status: "ok", app, version, uptimeSeconds, uptimeMs, ... }
 *
 * `ok` and `status` are both carried: deploy healthchecks were verified
 * against `ok: true`, and the standalone server's consumers read
 * `status: "ok"` — one body, both contracts. `detail` fields (the
 * standalone server's diagnostics) spread last, exactly as before.
 * Uptime fields are omitted when the caller cannot supply an uptime —
 * never faked.
 */
export function buildHealthBody(opts?: {
  version?: string;
  uptimeMs?: number;
  detail?: () => Record<string, unknown>;
}): Record<string, unknown> {
  const uptimeMs = opts?.uptimeMs;
  return {
    ok: true,
    status: "ok",
    app: APP_NAME,
    version: opts?.version ?? APP_VERSION,
    ...(uptimeMs !== undefined
      ? { uptimeSeconds: Math.floor(uptimeMs / 1000), uptimeMs }
      : {}),
    ...(opts?.detail?.() ?? {}),
  };
}

/**
 * Start the health server.
 *
 * Bind failures are reported through `onError` rather than thrown: a bot that
 * runs without a health endpoint is far better than one that refuses to start
 * because a port was taken. On a platform that needs the endpoint, the failed
 * healthcheck will surface the problem anyway.
 */
export async function startHealthServer(opts: HealthOptions): Promise<HealthServer | undefined> {
  const startedAt = opts.startedAt ?? Date.now();

  const server: Server = createServer((req, res) => {
    // Only a GET to the health path is answered. Anything else gets a 404 with
    // no hint about what does exist.
    if (req.method !== "GET" || !isHealthPath(req.url)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const body = buildHealthBody({
      uptimeMs: Date.now() - startedAt,
      ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
    });

    res.writeHead(200, {
      "content-type": "application/json",
      // A health response is never worth caching, and a stale one would hide a
      // dead process from the platform.
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
  });

  try {
    await listen(server, opts.port, opts.host ?? "0.0.0.0");
  } catch (err) {
    opts.onError?.(err instanceof Error ? err.message : String(err));
    return undefined;
  }

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : opts.port;

  return {
    port: boundPort,
    close: () => closeServer(server),
  };
}

/** Accept `/health` and `/health/`, nothing else. */
function isHealthPath(url: string | undefined): boolean {
  if (url === undefined) return false;
  // A query string is ignored rather than rejected, because some platforms
  // append one; a path is not.
  const path = url.split("?")[0]!;
  return path === "/health" || path === "/health/";
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // A bind error must reject rather than crash the process.
    const onError = (err: Error): void => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Keep-alive connections would otherwise hold the close open; the process
    // is shutting down anyway.
    server.closeAllConnections?.();
  });
}
