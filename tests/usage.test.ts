/**
 * Per-run usage/cost tracking tests.
 *
 * Covers the schema 17 `usage_ledger` table (round-trip, aggregates, the
 * 16→17 migration preserving existing data), the UsageTracker contract
 * (recording never throws, approximate cost), the gateway's optional onUsage
 * listener (fires per attempt that returns usage; a throwing listener can
 * never break a turn), and the owner-only usage_report tool (permission,
 * Persian output, approximate-cost disclaimer).
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Storage, SCHEMA_VERSION } from "../src/storage/storage";
import { UsageTracker, estimateCost, priceFor } from "../src/ai/usage";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { AiGateway } from "../src/ai/gateway";
import { AiError } from "../src/ai/provider";
import { createUsageReportTool } from "../src/tools/usage_report";
import { ToolError } from "../src/tools/errors";
import type { ToolContext } from "../src/tools/types";

const KEY = "usage-test-master-key";
const DAY_MS = 24 * 60 * 60 * 1000;

function ctxFor(userId: string): ToolContext {
  return {
    clock: () => new Date(),
    actor: { userId, permissions: [] },
    signal: new AbortController().signal,
  };
}

function tempPath(tag: string): string {
  return `${tmpdir()}/usage-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = path + suffix;
    try {
      if (existsSync(file)) rmSync(file, { force: true });
    } catch {
      // Best effort; a leftover temp file must not fail the suite.
    }
  }
}

// ---------- schema version ----------

describe("schema version", () => {
  test("is at least 17 (usage_ledger present)", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(17);
  });
});

// ---------- usage_ledger round-trip and aggregates ----------

describe("usage_ledger", () => {
  test("recordUsage round-trips and aggregates per user and per model", () => {
    const storage = Storage.open(":memory:");
    const tracker = new UsageTracker(storage);

    tracker.record({
      userId: "u1",
      conversationId: 1,
      providerId: 7,
      modelId: "gpt-4o-mini",
      usage: { inputTokens: 1000, outputTokens: 500 },
      at: 1_000,
    });
    tracker.record({
      userId: "u1",
      conversationId: 1,
      providerId: 7,
      modelId: "claude-sonnet-4-5",
      usage: { inputTokens: 2000, outputTokens: 1000 },
      at: 2_000,
    });
    tracker.record({
      userId: "u2",
      conversationId: 2,
      providerId: 7,
      modelId: "gpt-4o-mini",
      usage: { inputTokens: 4000, outputTokens: 0 },
      at: 3_000,
    });

    // Per-user totals are scoped: u1 never sees u2's rows.
    const t1 = tracker.totals("u1");
    expect(t1.inputTokens).toBe(3000);
    expect(t1.outputTokens).toBe(1500);
    expect(t1.runs).toBe(2);
    const t2 = tracker.totals("u2");
    expect(t2.inputTokens).toBe(4000);
    expect(t2.runs).toBe(1);

    // Per-model breakdown for u1, each with its own approximate cost.
    const byModel = tracker.byModel("u1");
    expect(byModel).toHaveLength(2);
    const sonnet = byModel.find((m) => m.modelId === "claude-sonnet-4-5")!;
    expect(sonnet.inputTokens).toBe(2000);
    expect(sonnet.runs).toBe(1);
    expect(sonnet.estimatedUsd).toBeGreaterThan(0);

    // A user with no rows gets zeros, not an error.
    const empty = tracker.totals("nobody");
    expect(empty.runs).toBe(0);
    expect(empty.estimatedUsd).toBe(0);

    storage.close();
  });

  test("sinceMs filters the window (inclusive)", () => {
    const storage = Storage.open(":memory:");
    const tracker = new UsageTracker(storage);

    tracker.record({
      userId: "u1", conversationId: 1, providerId: 7, modelId: "gpt-4o-mini",
      usage: { inputTokens: 100, outputTokens: 10 }, at: 1_000,
    });
    tracker.record({
      userId: "u1", conversationId: 1, providerId: 7, modelId: "gpt-4o-mini",
      usage: { inputTokens: 200, outputTokens: 20 }, at: 2_000,
    });

    expect(tracker.totals("u1", 2_000).inputTokens).toBe(200);
    expect(tracker.totals("u1", 2_001).runs).toBe(0);
    expect(tracker.byModel("u1", 2_000)).toHaveLength(1);
    expect(tracker.byModel("u1", 2_001)).toHaveLength(0);

    storage.close();
  });

  test("missing token counts default to zero", () => {
    const storage = Storage.open(":memory:");
    const tracker = new UsageTracker(storage);
    tracker.record({
      userId: "u1", conversationId: 1, providerId: 7, modelId: "mystery-model",
      usage: {}, at: 1_000,
    });
    const t = tracker.totals("u1");
    expect(t.inputTokens).toBe(0);
    expect(t.outputTokens).toBe(0);
    expect(t.runs).toBe(1);
    storage.close();
  });

  test("record never throws, even when storage is dead", () => {
    const storage = Storage.open(":memory:");
    storage.close();
    const tracker = new UsageTracker(storage);
    expect(() =>
      tracker.record({
        userId: "u1", conversationId: 1, providerId: 7, modelId: "x",
        usage: { inputTokens: 1 }, at: 1,
      }),
    ).not.toThrow();
  });
});

// ---------- 16 -> 17 migration ----------

/**
 * A hand-built schema-16 database stands in for one written by an earlier
 * release, so these tests prove the upgrade preserves what was already
 * there and lands the new usage_ledger table.
 */
function buildV16Database(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      user_id        TEXT NOT NULL,
      day            TEXT NOT NULL,
      requests       INTEGER NOT NULL DEFAULT 0,
      tool_calls     INTEGER NOT NULL DEFAULT 0,
      input_tokens   INTEGER NOT NULL DEFAULT 0,
      output_tokens  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _meta(k TEXT PRIMARY KEY, v TEXT);
    INSERT INTO _meta(k,v) VALUES('schema_version','16');
    INSERT INTO usage(user_id, day, requests, tool_calls, input_tokens, output_tokens)
      VALUES('u1','2026-10-17',3,12,5000,1500);
    INSERT INTO messages(conversation_id, role, content, created_at)
      VALUES(1,'user','سلام دنیا',1001);
  `);
  db.close();
}

describe("migration 16 -> 17", () => {
  test("preserves existing data and adds usage_ledger", () => {
    const path = tempPath("v16");
    buildV16Database(path);
    try {
      const storage = Storage.open(path);
      // Schema version stamped forward (asserted by floor, never equality).
      const raw = new Database(path, { readonly: true });
      const v = raw.query<{ v: string }, []>(`SELECT v FROM _meta WHERE k='schema_version'`).get()!;
      raw.close();
      expect(Number(v.v)).toBeGreaterThanOrEqual(17);

      // Pre-existing daily counters survived the upgrade untouched.
      const kept = storage.usageFor("u1", "2026-10-17");
      expect(kept.requests).toBe(3);
      expect(kept.toolCalls).toBe(12);
      expect(kept.inputTokens).toBe(5000);
      expect(kept.outputTokens).toBe(1500);

      // The new table exists and works; empty before any record.
      expect(storage.usageTotals("u1").runs).toBe(0);
      const id = storage.recordUsage({
        userId: "u1",
        conversationId: 1,
        providerId: 7,
        modelId: "gpt-4o-mini",
        inputTokens: 10,
        outputTokens: 5,
        atMs: 9_999,
      });
      expect(id).toBeGreaterThan(0);
      expect(storage.usageTotals("u1").inputTokens).toBe(10);
      storage.close();
    } finally {
      cleanup(path);
    }
  });

  test("running the migration twice is idempotent", () => {
    const path = tempPath("v16x2");
    buildV16Database(path);
    try {
      const a = Storage.open(path);
      a.close();
      // A second open on the migrated database must not fail or duplicate.
      const b = Storage.open(path);
      expect(b.usageFor("u1", "2026-10-17").requests).toBe(3);
      b.close();
    } finally {
      cleanup(path);
    }
  });
});

// ---------- cost estimates ----------

describe("estimateCost", () => {
  test("known model ids get a table price, unknown ids get the fallback", () => {
    const known = estimateCost(1_000_000, 1_000_000, "gpt-4o-mini");
    expect(known.estimated).toBe(false);
    expect(known.usd).toBeCloseTo(0.15 + 0.6, 10);

    const unknown = estimateCost(1_000_000, 1_000_000, "some-future-model");
    expect(unknown.estimated).toBe(true);
    expect(unknown.usd).toBeCloseTo(5 + 20, 10);

    expect(priceFor("claude-sonnet-4-5").fallback).toBe(false);
    expect(priceFor("whatever").fallback).toBe(true);
  });
});

// ---------- gateway onUsage ----------

const REQUEST = {
  messages: [{ role: "user" as const, content: "سلام" }],
  model: "ignored",
  timeoutMs: 1000,
  signal: new AbortController().signal,
};

/** Recording adapter that reports (or omits) usage on demand. */
function recordingAdapter(log: string[], usage?: { inputTokens: number; outputTokens: number }) {
  return {
    name: "recorder",
    complete: async (req: { model: string; timeoutMs: number }) => {
      log.push(`${req.model}@${req.timeoutMs}`);
      return usage !== undefined
        ? { text: "پاسخ", model: req.model, usage }
        : { text: "پاسخ", model: req.model };
    },
  };
}

function buildGateway(opts: {
  onUsage?: (info: { providerId: number; modelId: string; usage: unknown }) => void;
  usage?: { inputTokens: number; outputTokens: number };
}) {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore(KEY);
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const log: string[] = [];

  const fakeAdapters = {
    create: (type: string, cfg: { model: string; timeoutMs?: number }) => {
      void type;
      return recordingAdapter(log, opts.usage) as unknown as ReturnType<
        AdapterRegistry["create"]
      >;
    },
  } as unknown as AdapterRegistry;

  const p = providers.create({
    label: "primary",
    adapter: "openai_compatible",
    baseUrl: "https://primary.invalid/v1",
    apiKey: "sk-primary",
  });
  if (!p.ok) throw new Error("provider failed");
  const m = models.add({ providerId: p.data, modelId: "model-primary", label: "primary" });
  if (!m.ok) throw new Error("model failed");
  models.setDefault(m.data);
  storage.setRuntimeSelection({ providerId: p.data, modelId: m.data });

  const gateway = new AiGateway({
    storage,
    adapters: fakeAdapters,
    secrets,
    ...(opts.onUsage !== undefined ? { onUsage: opts.onUsage } : {}),
  });
  return { storage, gateway, providerId: p.data, log };
}

describe("gateway onUsage", () => {
  test("fires for the attempt that returns usage, with provider/model ids", async () => {
    const seen: { providerId: number; modelId: string; usage: unknown }[] = [];
    const h = buildGateway({
      onUsage: (info) => {
        seen.push(info);
      },
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const res = await h.gateway.complete(REQUEST);
    expect(res.text).toBe("پاسخ");
    expect(h.log).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.providerId).toBe(h.providerId);
    expect(seen[0]!.modelId).toBe("model-primary");
    expect(seen[0]!.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    h.storage.close();
  });

  test("a throwing listener never breaks the turn", async () => {
    const h = buildGateway({
      onUsage: () => {
        throw new Error("listener exploded");
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const res = await h.gateway.complete(REQUEST);
    expect(res.text).toBe("پاسخ");
    h.storage.close();
  });

  test("does not fire when the attempt returns no usage", async () => {
    const seen: unknown[] = [];
    const h = buildGateway({ onUsage: (info) => seen.push(info) });
    const res = await h.gateway.complete(REQUEST);
    expect(res.text).toBe("پاسخ");
    expect(seen).toHaveLength(0);
    h.storage.close();
  });

  test("works without a listener at all (option is optional)", async () => {
    const h = buildGateway({ usage: { inputTokens: 1, outputTokens: 1 } });
    const res = await h.gateway.complete(REQUEST);
    expect(res.text).toBe("پاسخ");
    h.storage.close();
  });

  test("a failing attempt never fires the listener", async () => {
    const seen: unknown[] = [];
    const storage = Storage.open(":memory:");
    const secrets = new ProviderSecretStore(KEY);
    const adapters = new AdapterRegistry();
    const providers = new ProviderService(storage, secrets, adapters);
    const models = new ModelService(storage);
    const fakeAdapters = {
      create: () => ({
        name: "failer",
        complete: async () => {
          throw new AiError("network", "down");
        },
      }),
    } as unknown as AdapterRegistry;
    const p = providers.create({
      label: "primary",
      adapter: "openai_compatible",
      baseUrl: "https://primary.invalid/v1",
      apiKey: "sk-primary",
    });
    if (!p.ok) throw new Error("provider failed");
    const m = models.add({ providerId: p.data, modelId: "model-primary", label: "primary" });
    if (!m.ok) throw new Error("model failed");
    models.setDefault(m.data);
    storage.setRuntimeSelection({ providerId: p.data, modelId: m.data });
    const gateway = new AiGateway({
      storage,
      adapters: fakeAdapters,
      secrets,
      onUsage: (info) => seen.push(info),
    });
    await expect(gateway.complete(REQUEST)).rejects.toThrow(AiError);
    expect(seen).toHaveLength(0);
    storage.close();
  });
});

// ---------- usage_report tool ----------

describe("usage_report tool", () => {
  test("is ownerOnly and requires its permission key", () => {
    const storage = Storage.open(":memory:");
    const tool = createUsageReportTool({ storage, isOwner: () => true });
    expect(tool.name).toBe("usage_report");
    expect(tool.ownerOnly).toBe(true);
    expect(tool.permission.requires).toContain("tools:usage_report");
    storage.close();
  });

  test("refuses a non-owner", async () => {
    const storage = Storage.open(":memory:");
    const tool = createUsageReportTool({ storage, isOwner: (id) => id === "owner-1" });
    const err = await tool.run({}, ctxFor("intruder")).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe("not_allowed");
    storage.close();
  });

  test("owner gets a Persian report with today/week totals, top models, and the estimate disclaimer", async () => {
    const storage = Storage.open(":memory:");
    // Fixed clock: 2026-10-18 12:00 UTC.
    const now = Date.UTC(2026, 9, 18, 12, 0, 0);
    const tracker = new UsageTracker(storage);

    const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
    // One row today, one yesterday (inside the 7-day window), one 8 days
    // back (outside it), two users — the owner sees all.
    tracker.record({
      userId: "owner-1", conversationId: 1, providerId: 1, modelId: "gpt-4o-mini",
      usage: { inputTokens: 1_000_000, outputTokens: 0 }, at: todayStart + 1_000,
    });
    tracker.record({
      userId: "user-2", conversationId: 2, providerId: 1, modelId: "claude-sonnet-4-5",
      usage: { inputTokens: 0, outputTokens: 1000 }, at: todayStart - DAY_MS,
    });
    tracker.record({
      userId: "owner-1", conversationId: 1, providerId: 1, modelId: "gpt-4o-mini",
      usage: { inputTokens: 9_999_999, outputTokens: 0 }, at: now - 8 * DAY_MS,
    });

    const tool = createUsageReportTool({
      storage,
      isOwner: (id) => id === "owner-1",
      now: () => now,
    });
    const out = await tool.run({}, ctxFor("owner-1"));
    const text = out.text;

    // Persian sections.
    expect(text).toContain("امروز");
    expect(text).toContain("۷ روز اخیر");
    // Today has exactly the one row (۱ run); the 8-day-old row is excluded.
    expect(text).toContain("توکن ورودی: ۱٬۰۰۰٬۰۰۰");
    // Top models over the week include both model ids.
    expect(text).toContain("gpt-4o-mini");
    expect(text).toContain("claude-sonnet-4-5");
    // The approximate-cost disclaimer is always present.
    expect(text).toContain("تقریبی");
    expect(text).toContain("صورتحساب واقعی نیست");
    storage.close();
  });

  test("an empty ledger still reports zeros in Persian", async () => {
    const storage = Storage.open(":memory:");
    const tool = createUsageReportTool({
      storage,
      isOwner: () => true,
      now: () => Date.UTC(2026, 9, 18, 12, 0, 0),
    });
    const out = await tool.run({}, ctxFor("owner-1"));
    expect(out.text).toContain("۰");
    expect(out.text).toContain("تقریبی");
    storage.close();
  });
});
