/**
 * Platform Phase 10 — Mini App additions that close the web dashboard's
 * coverage (see docs/DASHBOARD_COVERAGE.md):
 * - users.mute / users.unmute (the dashboard's restrict actions),
 * - bench.live (polling replacement for the dashboard's SSE stream),
 * - bench.report (the run report .md, dashboard allowlist discipline),
 * - desk.list / desk.toggle (the owner's view of the model's tool desk).
 *
 * Harness mirrors tests/miniapp_manage.test.ts: real :memory: Storage,
 * signed initData for the owner, injected deps for bench/desk.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Storage } from "../src/storage/storage";
import {
  handleManageApi,
  type DeskControl,
  type DeskToolView,
  type ManageApiDeps,
} from "../src/miniapp/api_manage";
import { ProposalStore } from "../src/curator/proposals";
import { BenchHistory } from "../src/bench/history";

const BOT_TOKEN = "123456:test-token-for-miniapps";
const OWNER_ID = "777001";

function makeInitData(userId: string): string {
  const params = new URLSearchParams();
  params.set("auth_date", String(Math.floor(Date.now() / 1000)));
  params.set("query_id", "q1");
  params.set("user", JSON.stringify({ id: Number(userId), first_name: "T" }));
  const pairs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort();
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN, "utf8").digest();
  const hash = createHmac("sha256", secret).update(pairs.join("\n"), "utf8").digest("hex");
  params.set("hash", hash);
  return params.toString();
}

let storage: Storage;
let deps: ManageApiDeps;
let initData: string;
let deskState: Map<string, DeskToolView>;
let deskControl: DeskControl;

beforeEach(() => {
  storage = Storage.open(":memory:");
  const benchDbPath = join(mkdtempSync(join(tmpdir(), "bobi-bench-")), "bench.db");
  deskState = new Map([
    [
      "calculator",
      {
        name: "calculator",
        description: "Calculator",
        enabled: true,
        ownerOnly: false,
        offDesk: false,
      },
    ],
    [
      "run_bench",
      {
        name: "run_bench",
        description: "Run benchmarks",
        enabled: true,
        ownerOnly: true,
        offDesk: true,
      },
    ],
  ]);
  deskControl = {
    listTools: () => [...deskState.values()],
    setToolEnabled: (name, enabled) => {
      const t = deskState.get(name);
      if (t === undefined) return false;
      deskState.set(name, { ...t, enabled });
      return true;
    },
  };
  deps = {
    storage,
    dbPath: benchDbPath,
    botToken: BOT_TOKEN,
    ownerId: OWNER_ID,
    proposalStore: new ProposalStore(new Database(":memory:")),
    benchHistory: new BenchHistory(new Database(benchDbPath)),
    desk: deskControl,
    benchWorker: {
      snapshot: () =>
        ({
          state: "running",
          runStamp: "run-42",
          done: 3,
          total: 10,
        }) as never,
    },
  };
  initData = makeInitData(OWNER_ID);
});

afterEach(() => {
  storage.close();
});

async function call(
  path: string,
  body: Record<string, unknown> = {},
  d: ManageApiDeps = deps,
): Promise<{ status: number; json: any }> {
  const res = await handleManageApi(path, { initData, ...body }, d);
  if (res === undefined) throw new Error(`expected a Response for ${path}`);
  return { status: res.status, json: await res.json() };
}

describe("users.mute / users.unmute", () => {
  test("mute moves the user to revoked; unmute restores approved", async () => {
    storage.createPendingUser({ userId: "424242" });
    const muted = await call("/miniapp/api/users.mute", { id: "424242" });
    expect(muted.status).toBe(200);
    expect(muted.json).toMatchObject({ ok: true, userId: "424242", state: "revoked" });
    expect(storage.userAccess("424242")?.state).toBe("revoked");

    const unmuted = await call("/miniapp/api/users.unmute", { id: "424242" });
    expect(unmuted.json).toMatchObject({ ok: true, state: "approved" });
    expect(storage.userAccess("424242")?.state).toBe("approved");
  });

  test("mute refuses the owner themself and bad ids", async () => {
    expect((await call("/miniapp/api/users.mute", { id: OWNER_ID })).status).toBe(400);
    expect((await call("/miniapp/api/users.mute", { id: "abc" })).status).toBe(400);
    expect((await call("/miniapp/api/users.unmute", { id: OWNER_ID })).status).toBe(400);
  });
});

describe("bench.live", () => {
  test("returns the worker snapshot", async () => {
    const { status, json } = await call("/miniapp/api/bench.live");
    expect(status).toBe(200);
    expect(json.snapshot).toMatchObject({ state: "running", runStamp: "run-42" });
  });

  test("503 when no bench worker is wired", async () => {
    const { benchWorker: _drop, ...rest } = deps;
    const { status } = await call("/miniapp/api/bench.live", {}, rest as ManageApiDeps);
    expect(status).toBe(503);
  });
});

describe("bench.report", () => {
  test("serves the report markdown for a real run; 404/400 otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bobi-results-"));
    writeFileSync(join(dir, "run1.json"), "{}");
    writeFileSync(join(dir, "run1.md"), "# Report\npassed");
    const prev = process.env["BOBI_BENCH_RESULTS_DIR"];
    process.env["BOBI_BENCH_RESULTS_DIR"] = dir;
    try {
      const okRes = await call("/miniapp/api/bench.report", { name: "run1" });
      expect(okRes.status).toBe(200);
      expect(okRes.json.markdown).toContain("# Report");

      expect((await call("/miniapp/api/bench.report", { name: "nope" })).status).toBe(404);
      expect((await call("/miniapp/api/bench.report", { name: "../secret" })).status).toBe(400);
      expect((await call("/miniapp/api/bench.report", { name: "a/b" })).status).toBe(400);
    } finally {
      if (prev === undefined) delete process.env["BOBI_BENCH_RESULTS_DIR"];
      else process.env["BOBI_BENCH_RESULTS_DIR"] = prev;
    }
  });
});

describe("desk.list / desk.toggle", () => {
  test("list returns every tool with its card state, including off-desk ones", async () => {
    const { status, json } = await call("/miniapp/api/desk.list");
    expect(status).toBe(200);
    expect(json.tools.map((t: DeskToolView) => t.name)).toEqual(["calculator", "run_bench"]);
    expect(json.tools[1]).toMatchObject({ ownerOnly: true, offDesk: true, enabled: true });
  });

  test("toggle flips state through the control; unknown tool 404s", async () => {
    const off = await call("/miniapp/api/desk.toggle", { name: "calculator", enabled: false });
    expect(off.json).toMatchObject({ ok: true, name: "calculator", enabled: false });
    expect(deskState.get("calculator")?.enabled).toBe(false);

    const missing = await call("/miniapp/api/desk.toggle", { name: "nope", enabled: true });
    expect(missing.status).toBe(404);
    expect((await call("/miniapp/api/desk.toggle", { name: "calculator" })).status).toBe(400);
  });

  test("503 when the desk is not wired", async () => {
    const { desk: _drop, ...rest } = deps;
    expect((await call("/miniapp/api/desk.list", {}, rest as ManageApiDeps)).status).toBe(503);
    expect(
      (await call("/miniapp/api/desk.toggle", { name: "calculator", enabled: true }, rest as ManageApiDeps)).status,
    ).toBe(503);
  });

  test("non-owner initData is rejected before the desk is touched", async () => {
    const res = await handleManageApi(
      "/miniapp/api/desk.toggle",
      { initData: makeInitData("999"), name: "calculator", enabled: false },
      deps,
    );
    expect(res!.status).toBe(401);
    expect(deskState.get("calculator")?.enabled).toBe(true);
  });
});
