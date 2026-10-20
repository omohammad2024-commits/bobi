/**
 * Gauntlet — pinned transport / connection warmth (Wave 3, Worker 5).
 *
 * M12: the pooled keep-alive agent used to be keyed by the SINGLE address
 * of the current fallback attempt, so every address fallback destroyed
 * the previous agent (and its warm socket) and the next request started
 * cold again. The fix keys the agent by host + the FULL validated
 * address set; per-attempt selection still happens through the
 * per-request pinned lookup, and a CHANGED validated set still rebuilds
 * the agent immediately (the DNS-rebinding defense is unchanged).
 *
 * R3: the request-level fallback loop's MIN_ATTEMPT_MS (2s) is a
 * per-attempt BUDGET, not a wait — a connect-refused address fails in
 * milliseconds, and once a warm socket is pooled the agent hands it to
 * the next request before any new connect is attempted. These tests pin
 * that pooled-path behaviour: cold fallback completes far under one
 * floor period, and a warm repeat pays no fallback cost at all.
 *
 * Hermetic: loopback only. The server binds 127.0.0.2; the same port on
 * 127.0.0.1 / 127.0.0.3 is unbound, so those validated addresses refuse
 * instantly — a dead address with no multi-second sleeps. The hostname
 * is a reserved .invalid name: every connection is made by the pinned
 * lookup from the validated address set, never by real DNS.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import {
  pinnedFetch,
  pinnedStream,
  resetKeepAliveAgents,
} from "../src/ai/pinned_transport";
import { ConnectionManager, connectionManager } from "../src/ai/connection_manager";

const DEAD_A = "127.0.0.1";
const DEAD_B = "127.0.0.3";
const ALIVE = "127.0.0.2";

interface LoopbackServer {
  port: number;
  hits: string[];
  connections: () => number;
  close: () => void;
}

async function loopbackServer(): Promise<LoopbackServer> {
  const hits: string[] = [];
  let connections = 0;
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((r) => server.listen(0, ALIVE, r));
  const port = (server.address() as { port: number }).port;
  return { port, hits, connections: () => connections, close: () => server.close() };
}

/** The singleton manager's stats entry for one loopback host:port. */
function hostStats(port: number) {
  return connectionManager
    .stats()
    .find((s) => s.host === `http://gauntlet.invalid:${port}|local`);
}

function fetchReq(port: number, path: string, addresses: readonly string[]) {
  return pinnedFetch({
    url: `http://gauntlet.invalid:${port}${path}`,
    method: "GET",
    headers: {},
    timeoutMs: 8000,
    signal: new AbortController().signal,
    addresses,
    allowLocalTargets: true,
  });
}

/** Run fn with BOBI_KEEPALIVE unset (pooling on), restoring it after. */
async function withPoolingOn(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.BOBI_KEEPALIVE;
  delete process.env.BOBI_KEEPALIVE;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.BOBI_KEEPALIVE;
    else process.env.BOBI_KEEPALIVE = prev;
  }
}

describe("M12 — pooled agent survives address fallback", () => {
  test("fallback request + repeat request reuse ONE agent and its warm socket", async () => {
    const s = await loopbackServer();
    try {
      await withPoolingOn(async () => {
        resetKeepAliveAgents();
        try {
          // First request: first validated address is dead (refused),
          // the second serves.
          const first = await fetchReq(s.port, "/first", [DEAD_A, ALIVE]);
          expect(first.status).toBe(200);

          // Second request, same validated set: the SAME pooled agent
          // must serve it — no destroy/rebuild — and the warm socket
          // pooled during the first request is reused, so the server
          // sees no new connection at all.
          const second = await fetchReq(s.port, "/second", [DEAD_A, ALIVE]);
          expect(second.status).toBe(200);

          expect(s.hits).toEqual(["/first", "/second"]);
          expect(s.connections()).toBe(1);
          expect(connectionManager.agentCount()).toBe(1);
          const stats = hostStats(s.port);
          expect(stats).toBeDefined();
          expect(stats!.connectCount).toBe(1);
          expect(stats!.reusedCount).toBeGreaterThanOrEqual(1);
        } finally {
          resetKeepAliveAgents();
        }
      });
    } finally {
      s.close();
    }
  });

  test("streamed requests pool under the same full-set key", async () => {
    const s = await loopbackServer();
    try {
      await withPoolingOn(async () => {
        resetKeepAliveAgents();
        try {
          for (const path of ["/s1", "/s2"]) {
            const res = await pinnedStream({
              url: `http://gauntlet.invalid:${s.port}${path}`,
              method: "GET",
              headers: {},
              timeoutMs: 8000,
              signal: new AbortController().signal,
              addresses: [DEAD_A, ALIVE],
              allowLocalTargets: true,
            });
            expect(res.status).toBe(200);
            let body = "";
            for await (const chunk of res.chunks) body += chunk.toString("utf8");
            expect(body).toContain('"ok":true');
          }
          expect(s.hits).toEqual(["/s1", "/s2"]);
          expect(connectionManager.agentCount()).toBe(1);
          // The second stream was handed the already-pooled agent (the
          // pre-fix keying left reusedCount at 0 after every fallback).
          expect(hostStats(s.port)!.reusedCount).toBeGreaterThanOrEqual(1);
        } finally {
          resetKeepAliveAgents();
        }
      });
    } finally {
      s.close();
    }
  });

  test("a CHANGED validated set rebuilds the agent immediately (rebinding defense)", async () => {
    const s = await loopbackServer();
    try {
      await withPoolingOn(async () => {
        resetKeepAliveAgents();
        try {
          await fetchReq(s.port, "/a", [DEAD_A, ALIVE]);
          await fetchReq(s.port, "/b", [DEAD_A, ALIVE]);
          expect(s.connections()).toBe(1);
          expect(hostStats(s.port)!.reusedCount).toBeGreaterThanOrEqual(1);

          // Same host, but dns_guard now approves a DIFFERENT set: the
          // old agent (and its warm socket) must be destroyed and a new
          // agent built, even though the old one was warm and young.
          const res = await fetchReq(s.port, "/c", [ALIVE]);
          expect(res.status).toBe(200);
          expect(connectionManager.agentCount()).toBe(1);
          // Fresh entry: the reuse counter starts over, and the request
          // paid a new connection because the old socket was destroyed
          // with its agent.
          expect(hostStats(s.port)!.reusedCount).toBe(0);
          expect(s.connections()).toBe(2);
          expect(s.hits).toEqual(["/a", "/b", "/c"]);
        } finally {
          resetKeepAliveAgents();
        }
      });
    } finally {
      s.close();
    }
  });

  test("agentFor with the same set in a different order still reuses (set keying, not list keying)", () => {
    const manager = new ConnectionManager({ disableReaper: true, connector: async () => {} });
    const url = new URL("https://api.example.com/v1");
    const first = manager.agentFor(url, ["93.184.216.34", "93.184.216.35"], true, false);
    const reordered = manager.agentFor(url, ["93.184.216.35", "93.184.216.34"], true, false);
    expect(reordered).toBe(first);
    expect(manager.agentCount()).toBe(1);
    manager.reset();
  });
});

describe("warm() — one agent per host, not per address", () => {
  test("multi-address warm builds ONE agent and falls back inside it", async () => {
    const agentsSeen: unknown[] = [];
    const addressesTried: string[] = [];
    const manager = new ConnectionManager({
      disableReaper: true,
      connector: async ({ address, agent }) => {
        agentsSeen.push(agent);
        addressesTried.push(address);
        // First validated address is dead; the second warms fine.
        if (address === "93.184.216.34") throw new Error("refused");
      },
    });
    const ok = await manager.warm({
      baseUrl: "https://api.example.com/v1",
      addresses: ["93.184.216.34", "93.184.216.35"],
      allowLocalTargets: false,
    });
    expect(ok).toBe(true);
    expect(addressesTried).toEqual(["93.184.216.34", "93.184.216.35"]);
    expect(manager.agentCount()).toBe(1);
    expect(agentsSeen).toHaveLength(2);
    // Both fallback steps ran through the SAME agent — the pre-fix code
    // destroyed and rebuilt it between addresses.
    expect(agentsSeen[1]).toBe(agentsSeen[0]);
    expect(manager.isWarm(new URL("https://api.example.com/v1"), false)).toBe(true);
    manager.reset();
  });
});

describe("R3 — pooled-path fallback timing pin", () => {
  test("cold fallback over two dead addresses completes far under the 2s-per-address floor", async () => {
    const s = await loopbackServer();
    try {
      await withPoolingOn(async () => {
        resetKeepAliveAgents();
        try {
          // Two refused addresses ahead of the live one. If the pooled
          // path paid MIN_ATTEMPT_MS (2000ms) per dead address this
          // would take >= 4000ms; connect-refused fails immediately, so
          // the whole cold fallback is milliseconds. Bounded attempts:
          // exactly one server connection and one server hit.
          const started = Date.now();
          const res = await fetchReq(s.port, "/cold", [DEAD_A, DEAD_B, ALIVE]);
          const elapsed = Date.now() - started;
          expect(res.status).toBe(200);
          expect(elapsed).toBeLessThan(2000);
          expect(s.connections()).toBe(1);
          expect(s.hits).toEqual(["/cold"]);

          // Warm repeat: the pooled socket serves the request, so no
          // address is dialled at all — no fallback cost, no new
          // connection, still fast.
          const warmStart = Date.now();
          const again = await fetchReq(s.port, "/warm", [DEAD_A, DEAD_B, ALIVE]);
          expect(again.status).toBe(200);
          expect(Date.now() - warmStart).toBeLessThan(2000);
          expect(s.connections()).toBe(1);
          expect(s.hits).toEqual(["/cold", "/warm"]);
        } finally {
          resetKeepAliveAgents();
        }
      });
    } finally {
      s.close();
    }
  });
});
