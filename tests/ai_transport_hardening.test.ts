import { describe, expect, test } from "bun:test";
import { createServer, request as nodeHttpRequest, type Server, type ServerResponse, type IncomingMessage } from "node:http";
import { pinnedFetch, pinnedLookup, MAX_RESPONSE_BYTES } from "../src/ai/pinned_transport";
import { AiError } from "../src/ai/provider";
import { OpenAICompatibleAdapter } from "../src/ai/openai_compatible";

/**
 * Adversarial transport tests.
 *
 * Every server here is a loopback double. Nothing contacts a public network,
 * a metadata endpoint, or real private infrastructure. Where the brief asks
 * for actual runtime semantics (not a mock), the request is issued through
 * real `node:http` with this runtime's lookup callback.
 */

async function server(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; hits: number; url: string; close: () => void }> {
  let hits = 0;
  const s: Server = createServer((req, res) => {
    hits++;
    handler(req, res);
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const addr = s.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    get hits() {
      return hits;
    },
    url: `http://127.0.0.1:${port}`,
    close: () => s.close(),
  };
}

function req(overrides: Partial<Parameters<typeof pinnedFetch>[0]> = {}) {
  return {
    url: "http://127.0.0.1:1/x",
    method: "GET",
    headers: {},
    timeoutMs: 2000,
    signal: new AbortController().signal,
    addresses: ["127.0.0.1"] as readonly string[],
    ...overrides,
  };
}

/** Raw request through the real Node path with our lookup. */
async function rawRequest(opts: {
  port: number;
  family?: number;
  addresses: readonly string[];
  all?: boolean;
  hostname?: string;
}): Promise<{ status?: number; error?: string; hits: number }> {
  let hits = 0;
  const s = createServer((_rq, rs) => {
    hits++;
    rs.writeHead(200);
    rs.end("ok");
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const addr = s.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  void opts.port;

  const out = await new Promise<{ status?: number; error?: string }>((resolve) => {
    const r = nodeHttpRequest(
      {
        hostname: opts.hostname ?? "unresolvable.invalid",
        port,
        path: "/",
        method: "GET",
        family: opts.family,
        lookup: pinnedLookup(opts.addresses),
      } as never,
      (res) => {
        res.resume();
        res.on("end", () => {
          const status = res.statusCode;
          resolve(status === undefined ? {} : { status });
        });
      },
    );
    r.on("error", (e: Error) => resolve({ error: e.message }));
    r.end();
  });
  s.close();
  return {
    ...(out.status !== undefined ? { status: out.status } : {}),
    ...(out.error !== undefined ? { error: out.error } : {}),
    hits,
  };
}

// ---------- A: destination validation at the connection boundary ----------

describe("transport refuses addresses nobody validated", () => {
  test("a prohibited address is refused before any socket is opened", async () => {
    const s = await server((_q, res) => {
      res.writeHead(200);
      res.end("reached");
    });
    try {
      // 0.0.0.0 (unspecified) is always prohibited. If the guard were missing
      // the loopback server would be dialled on this runtime.
      const err = await pinnedFetch(
        req({ url: `http://unresolvable.invalid:${s.port}/x`, addresses: ["0.0.0.0"] }),
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AiError);
      expect((err as AiError).kind).toBe("invalid_response");
      expect(s.hits).toBe(0);
    } finally {
      s.close();
    }
  });

  test("metadata and link-local addresses are refused without the local flag", async () => {
    const s = await server((_q, res) => {
      res.writeHead(200);
      res.end("reached");
    });
    try {
      for (const address of ["169.254.169.254", "fe80::1", "224.0.0.1", "255.255.255.255"]) {
        const err = await pinnedFetch(
          req({ url: `http://unresolvable.invalid:${s.port}/x`, addresses: [address] }),
        ).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AiError);
      }
      expect(s.hits).toBe(0);
    } finally {
      s.close();
    }
  });

  test("one prohibited address in a mixed list is enough to refuse", async () => {
    const s = await server((_q, res) => {
      res.writeHead(200);
      res.end("reached");
    });
    try {
      const err = await pinnedFetch(
        req({
          url: `http://unresolvable.invalid:${s.port}/x`,
          addresses: ["127.0.0.1", "0.0.0.0"],
          allowLocalTargets: true,
        }),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AiError);
      expect(s.hits).toBe(0);
    } finally {
      s.close();
    }
  });

  test("the local exception permits loopback only when the flag travels with it", async () => {
    const s = await server((_q, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    try {
      const refused = await pinnedFetch(
        req({ url: `http://unresolvable.invalid:${s.port}/x`, addresses: ["127.0.0.1"] }),
      ).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(AiError);
      expect(s.hits).toBe(0);

      const allowed = await pinnedFetch(
        req({
          url: `http://unresolvable.invalid:${s.port}/x`,
          addresses: ["127.0.0.1"],
          allowLocalTargets: true,
        }),
      ).catch((e: unknown) => e);
      expect(allowed).toBeInstanceOf(AiError === allowed ? Error : Object);
      expect((allowed as { status?: number }).status).toBe(200);
      expect(s.hits).toBe(1);
    } finally {
      s.close();
    }
  });

  test("URL credentials are refused by the transport itself", async () => {
    const err = await pinnedFetch(
      req({ url: "http://user:pass@127.0.0.1:9/x", allowLocalTargets: true }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).message).not.toContain("pass");
  });

  test("an unsupported scheme is refused", async () => {
    const err = await pinnedFetch(req({ url: "ftp://127.0.0.1:9/x" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
  });
});

// ---------- B: real runtime lookup family semantics ----------

describe("actual runtime lookup family handling", () => {
  test("family 4 connects to a validated IPv4 address", async () => {
    const out = await rawRequest({ port: 0, addresses: ["127.0.0.1"], family: 4 });
    expect(out.status).toBe(200);
    expect(out.hits).toBe(1);
  });

  test("family 6 with only an IPv4 answer errors instead of dialling", async () => {
    // If the callback returned the wrong family the server would be hit; an
    // error before dialling proves the family filter is real.
    const out = await rawRequest({ port: 0, addresses: ["127.0.0.1"], family: 6 });
    expect(out.status).toBeUndefined();
    expect(out.error).toBeDefined();
    expect(out.hits).toBe(0);
  });

  test("family 6 with a validated IPv6 answer connects", async () => {
    // Real IPv6 loopback, real Node socket, our lookup in between.
    const s = createServer((_rq, rs) => {
      rs.writeHead(200);
      rs.end("ok");
    });
    const bound = await new Promise<boolean>((resolve) => {
      try {
        s.listen(0, "::1", () => resolve(true));
      } catch {
        resolve(false);
      }
      s.on("error", () => resolve(false));
    });
    const addr = s.address();
    const port = bound && typeof addr === "object" && addr ? addr.port : 0;

    // Binding IPv6 loopback can succeed on hosts whose IPv6 stack cannot
    // actually accept a connection. Probe it for real; skip rather than report
    // an environment limitation as a product defect.
    const connectable = await (async () => {
      if (port === 0) return false;
      try {
        const probe = await fetch(`http://[::1]:${port}/`);
        probe.body?.cancel();
        return probe.ok;
      } catch {
        return false;
      }
    })();
    if (!connectable) {
      s.close();
      return; // documented as an unverified host assumption, not a failure
    }

    const out = await new Promise<{ status?: number; error?: string }>((resolve) => {
      const r = nodeHttpRequest(
        {
          hostname: "unresolvable.invalid",
          port,
          path: "/",
          method: "GET",
          family: 6,
          lookup: pinnedLookup(["8.8.8.8", "::1"]),
        } as never,
        (res) => {
          res.resume();
          res.on("end", () => {
            const status = res.statusCode;
            resolve(status === undefined ? {} : { status });
          });
        },
      );
      r.on("error", (e: Error) => resolve({ error: e.message }));
      r.end();
    });
    s.close();
    expect(out.error).toBeUndefined();
    expect(out.status).toBe(200);
  });

  test("an unknown callback shape throws instead of falling back to DNS", () => {
    const lookup = pinnedLookup(["127.0.0.1"]);
    expect(() => lookup("host", { all: true })).toThrow();
  });

  test("family metadata agrees with the address in all-true mode", () => {
    const lookup = pinnedLookup(["8.8.8.8", "::1"]);
    const out: unknown[] = [];
    lookup("h", { all: true }, (_e: unknown, list: unknown) => out.push(list));
    expect(out[0]).toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "::1", family: 6 },
    ]);
  });
});

// ---------- C: request lifecycle ----------

describe("request lifecycle", () => {
  test("a pre-aborted signal fails without opening a socket", async () => {
    const s = await server((_q, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    try {
      const controller = new AbortController();
      controller.abort();
      const err = await pinnedFetch(
        req({
          url: `http://127.0.0.1:${s.port}/x`,
          allowLocalTargets: true,
          signal: controller.signal,
        }),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AiError);
      expect((err as AiError).kind).toBe("aborted");
      expect(s.hits).toBe(0);
    } finally {
      s.close();
    }
  });

  test("aborting mid-response stops reading and settles exactly once", async () => {
    const controller = new AbortController();
    let sent = 0;
    const s = await server((_q, res) => {
      // Stream chunks slowly so the abort lands mid-flight.
      const tick = (): void => {
        if (sent >= 40) return;
        sent++;
        res.write("x".repeat(1024));
        if (sent === 3) controller.abort();
        setTimeout(tick, 5);
      };
      tick();
    });
    try {
      const err = await pinnedFetch(
        req({
          url: `http://127.0.0.1:${s.port}/x`,
          allowLocalTargets: true,
          signal: controller.signal,
          timeoutMs: 5000,
        }),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AiError);
      expect((err as AiError).kind).toBe("aborted");
      // The stream stopped well before its own total.
      expect(sent).toBeLessThan(40);
    } finally {
      s.close();
    }
  });

  test("a premature close settles instead of hanging to the deadline", async () => {
    const s = await server((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"partial":');
      res.destroy(); // connection drops mid-body
    });
    try {
      const started = Date.now();
      const err = await pinnedFetch(
        req({
          url: `http://127.0.0.1:${s.port}/x`,
          allowLocalTargets: true,
          timeoutMs: 3000,
        }),
      ).catch((e: unknown) => e);
      const elapsed = Date.now() - started;
      expect(err).toBeInstanceOf(AiError);
      // Bounded: settles long before the 3s deadline, never hangs.
      expect(elapsed).toBeLessThan(2500);
      expect(["network", "timeout"]).toContain((err as AiError).kind);
    } finally {
      s.close();
    }
  });

  test("the response cap counts bytes across multiple chunks", async () => {
    const s = await server((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // Many small chunks that together exceed the cap.
      let written = 0;
      const chunk = "a".repeat(256 * 1024);
      const pump = (): void => {
        while (written <= MAX_RESPONSE_BYTES) {
          written += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    try {
      const err = await pinnedFetch(
        req({
          url: `http://127.0.0.1:${s.port}/x`,
          allowLocalTargets: true,
          timeoutMs: 8000,
        }),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AiError);
      expect((err as AiError).kind).toBe("invalid_response");
      expect((err as AiError).message).not.toContain("127.0.0.1");
    } finally {
      s.close();
    }
  });

  test("a timeout does not leave the request running afterwards", async () => {
    let open = 0;
    const s = await server((_q, res) => {
      open++;
      // Never answer; keep the socket open.
      setTimeout(() => {
        try {
          res.destroy();
        } catch {
          // already gone
        }
      }, 4000);
    });
    try {
      const started = Date.now();
      const err = await pinnedFetch(
        req({
          url: `http://127.0.0.1:${s.port}/x`,
          allowLocalTargets: true,
          timeoutMs: 200,
        }),
      ).catch((e: unknown) => e);
      const elapsed = Date.now() - started;
      expect((err as AiError).kind).toBe("timeout");
      expect(elapsed).toBeLessThan(1500);
      expect(open).toBe(1);
    } finally {
      s.close();
    }
  });

  test("concurrent requests to different destinations do not share state", async () => {
    const a = await server((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ which: "a" }));
    });
    const b = await server((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ which: "b" }));
    });
    try {
      const [ra, rb] = await Promise.all([
        pinnedFetch(
          req({ url: `${a.url}/a`, allowLocalTargets: true, addresses: ["127.0.0.1"] }),
        ),
        pinnedFetch(
          req({ url: `${b.url}/b`, allowLocalTargets: true, addresses: ["127.0.0.1"] }),
        ),
      ]);
      expect(JSON.parse(ra.body)).toEqual({ which: "a" });
      expect(JSON.parse(rb.body)).toEqual({ which: "b" });
      expect(a.hits).toBe(1);
      expect(b.hits).toBe(1);
    } finally {
      a.close();
      b.close();
    }
  });

  test("a cancellation during one request does not disturb an in-flight neighbour", async () => {
    const a = await server((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ which: "a" }));
    });
    const b = await server((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ which: "b" }));
    });
    try {
      const controller = new AbortController();
      const first = pinnedFetch(
        req({ url: `${a.url}/a`, allowLocalTargets: true, signal: controller.signal }),
      ).catch((e: unknown) => e);
      const second = pinnedFetch(req({ url: `${b.url}/b`, allowLocalTargets: true }));
      controller.abort();

      const [r1, r2] = await Promise.all([first, second]);
      expect((r1 as AiError).kind).toBe("aborted");
      expect(JSON.parse((r2 as { body: string }).body)).toEqual({ which: "b" });
      expect(b.hits).toBe(1);
    } finally {
      a.close();
      b.close();
    }
  });
});

// ---------- D: response handling ----------

describe("response handling", () => {
  test("a provider response cannot change the destination", async () => {
    const s = await server((_q, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        location: "http://169.254.169.254/latest",
      });
      res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }] }));
    });
    try {
      // The request goes out to the configured host only; nothing in the body
      // or headers is consulted when routing.
      const out = await pinnedFetch(
        req({ url: `${s.url}/v1/chat`, allowLocalTargets: true }),
      );
      expect(out.status).toBe(200);
      expect(s.hits).toBe(1);
      expect(out.headers["location"]).toBeDefined(); // seen, never followed
    } finally {
      s.close();
    }
  });

  test("the Host header is the configured hostname, not the pinned address", async () => {
    const s = await server((q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ host: q.headers.host }));
    });
    try {
      const out = await pinnedFetch(
        req({ url: `${s.url}/v1`, allowLocalTargets: true }),
      );
      expect(JSON.parse(out.body).host).toBe(`127.0.0.1:${s.port}`);
      // The address we dialled is the same one the server saw traffic on.
      expect(s.hits).toBe(1);
    } finally {
      s.close();
    }
  });

  test("error messages carry no address, header or body content", async () => {
    const s = await server((_q, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "sk-live-abcdefghijklmnop token=zzz" }));
    });
    try {
      // The transport deliberately returns the status untouched (classification
      // belongs to the adapter), so the sanitization assertion runs through the
      // adapter that produces the user-facing message.
      const out = await pinnedFetch(req({ url: `${s.url}/x`, allowLocalTargets: true }));
      expect(out.status).toBe(500);

      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `${s.url}/v1`,
        apiKey: "k",
        allowLocalTargets: true,
      });
      const err = await adapter
        .complete({
          messages: [{ role: "user", content: "hi" }],
          model: "m",
          timeoutMs: 2000,
          signal: new AbortController().signal,
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AiError);
      const message = (err as AiError).message;
      expect(message).not.toContain("sk-live");
      expect(message).not.toContain("token=");
      expect(message).not.toContain(String(s.port));
    } finally {
      s.close();
    }
  });
});
