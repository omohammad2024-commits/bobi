/**
 * Health endpoint.
 *
 * A hosting platform decides whether a deploy is alive by polling this URL, so
 * the properties that matter are: it answers, it answers cheaply, and it says
 * nothing an unauthenticated caller should not have.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { startHealthServer } from "../src/core/health";
import { APP_VERSION } from "../src/core/app";

/** Start a server on an ephemeral port and always close it. */
async function withServer(
  opts: Parameters<typeof startHealthServer>[0],
  fn: (base: string, server: NonNullable<Awaited<ReturnType<typeof startHealthServer>>>) => Promise<void>,
): Promise<void> {
  const server = await startHealthServer({ ...opts, port: 0, host: "127.0.0.1" });
  expect(server).toBeDefined();
  try {
    await fn(`http://127.0.0.1:${server!.port}`, server!);
  } finally {
    await server!.close();
  }
}

describe("health endpoint", () => {
  test("answers 200 with a JSON body", async () => {
    await withServer({ port: 0 }, async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["status"]).toBe("ok");
      expect(body["app"]).toBe("BOBI");
    });
  });

  test("reports the package.json version (single source of truth)", async () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
    await withServer({ port: 0 }, async (base) => {
      const body = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
      expect(body["version"]).toBe(pkg.version);
    });
  });

  test("reports an uptime that grows", async () => {
    await withServer({ port: 0, startedAt: Date.now() - 5_000 }, async (base) => {
      const body = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
      expect(body["uptimeSeconds"]).toBeGreaterThanOrEqual(5);
    });
  });

  test("includes the caller-supplied detail", async () => {
    await withServer({ port: 0, detail: () => ({ tools: 7 }) }, async (base) => {
      const body = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
      expect(body["tools"]).toBe(7);
    });
  });

  test("a trailing slash is accepted", async () => {
    await withServer({ port: 0 }, async (base) => {
      expect((await fetch(`${base}/health/`)).status).toBe(200);
    });
  });

  test("a query string is ignored rather than rejected", async () => {
    // Some platforms append one; failing on it would break the healthcheck.
    await withServer({ port: 0 }, async (base) => {
      expect((await fetch(`${base}/health?probe=1`)).status).toBe(200);
    });
  });

  test("an unknown path is 404 and reveals nothing", async () => {
    await withServer({ port: 0 }, async (base) => {
      const res = await fetch(`${base}/admin`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["error"]).toBe("not found");
      // No hint about what does exist, and no version or config detail.
      expect(JSON.stringify(body)).not.toContain("health");
    });
  });

  test("only GET is answered", async () => {
    await withServer({ port: 0 }, async (base) => {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        expect((await fetch(`${base}/health`, { method })).status).toBe(404);
      }
    });
  });

  test("the response is not cached", async () => {
    // A cached health response would hide a dead process from the platform.
    await withServer({ port: 0 }, async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  });

  test("no secret-shaped value appears in the body", async () => {
    await withServer(
      { port: 0, detail: () => ({ tools: 1, scheduler: true }) },
      async (base) => {
        const text = await (await fetch(`${base}/health`)).text();
        // The endpoint is unauthenticated by definition, so it must not carry
        // configuration, tokens, or user data.
        expect(text).not.toMatch(/token|key|secret|password/i);
        expect(text).not.toContain("TELEGRAM");
      },
    );
  });
});

describe("binding", () => {
  test("an ephemeral port is reported back", async () => {
    await withServer({ port: 0 }, async (_base, server) => {
      expect(server.port).toBeGreaterThan(0);
    });
  });

  test("a port already in use is reported, not thrown", async () => {
    // A bot that runs without a health endpoint is far better than one that
    // refuses to start because a port was taken.
    const first = await startHealthServer({ port: 0, host: "127.0.0.1" });
    expect(first).toBeDefined();
    try {
      let reported: string | undefined;
      const second = await startHealthServer({
        port: first!.port,
        host: "127.0.0.1",
        onError: (m) => {
          reported = m;
        },
      });
      expect(second).toBeUndefined();
      expect(reported).toBeDefined();
    } finally {
      await first!.close();
    }
  });

  test("close is idempotent", async () => {
    const server = await startHealthServer({ port: 0, host: "127.0.0.1" });
    await server!.close();
    await expect(server!.close()).resolves.toBeUndefined();
  });
});
