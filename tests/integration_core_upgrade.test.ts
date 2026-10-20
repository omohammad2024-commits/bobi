/**
 * Core-upgrade integration wiring — the seams the five feature teams left
 * are composed here exactly the way src/index.ts composes them:
 *
 *  1. ONE CircuitBreakerRegistry shared between the gateway (consulted)
 *     and the health service (read-only circuit field on probe results).
 *  2. The intent router narrowing/ordering the turn's tool specs, and the
 *     AgentLoop honouring caller-routed specs.
 *  3. Schema v22: a v21-shaped database migrates (recall columns appear,
 *     rows survive), and recall telemetry updates without touching
 *     updated_at — which is what makes consolidation promotion live.
 *  4. Prompt assembly: the episode block appears when an episode exists,
 *     and the switches that gate the fetchers (episodes / proactive
 *     recall) demonstrably empty the pipeline when off.
 *
 * Everything is hermetic: temp-file DBs, scripted adapters, fake clocks.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SCHEMA_VERSION, Storage } from "../src/storage/storage";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { ProviderHealthService } from "../src/ai/health";
import { AiGateway } from "../src/ai/gateway";
import { CircuitBreakerRegistry } from "../src/ai/circuit_breaker";
import { AiError } from "../src/ai/provider";
import type { AiProvider, CompletionRequest, CompletionResponse } from "../src/ai/provider";
import { AgentLoop } from "../src/agent/loop";
import { ToolService } from "../src/tools/service";
import type { ToolActor } from "../src/tools/types";
import type { ToolSpec } from "../src/ai/provider";
import { applyIntentRouting } from "../src/routing/route_specs";
import { buildSystemPrompt, estimatePromptTokens } from "../src/agent/prompt";
import { SqliteMemoryProvider } from "../src/memory/sqlite_provider";
import { consolidateMemories } from "../src/memory/consolidate";
import { recallFor } from "../src/memory/proactive_recall";
import { isEpisodesEnabled } from "../src/memory/episodes";
import type { MemoryProvider, StoredMemory } from "../src/memory/provider";

// ---------- shared helpers ----------

async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function tempDb(tag: string): string {
  return join(
    tmpdir(),
    `bobi-wire-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(path + suffix, { force: true });
    } catch {
      // A leftover temp file must not fail the suite.
    }
  }
}

const spec = (name: string): ToolSpec => ({
  name,
  description: `${name} tool`,
  parameters: { type: "object" },
});

// ---------- 1. shared circuit-breaker registry ----------

describe("wire 1: one breaker registry shared by gateway + health", () => {
  test("gateway trips are visible on the health probe surface via the shared instance", async () => {
    await withEnv(
      { BOBI_SMART_ROUTING: "0", BOBI_GATEWAY_RETRY: "0", BOBI_CIRCUIT_BREAKER: undefined },
      async () => {
        const storage = Storage.open(":memory:");
        const secrets = new ProviderSecretStore("wire-test-master-key");
        const realAdapters = new AdapterRegistry();
        const providers = new ProviderService(storage, secrets, realAdapters);
        const models = new ModelService(storage);

        const p = providers.create({
          label: "wire-a",
          adapter: "openai_compatible",
          baseUrl: "https://wire-a.invalid/v1",
          apiKey: "<redacted>",
        });
        if (!p.ok) throw new Error("provider create failed");
        const providerId = p.data;
        const m = models.add({ providerId, modelId: "model-wire-a", label: "wire-a" });
        if (!m.ok) throw new Error("model add failed");
        models.setDefault(m.data);
        storage.setRuntimeSelection({ providerId, modelId: m.data });

        // The failing adapter the gateway will use (the health service
        // keeps the REAL registry — probes test providers directly).
        const failingAdapters = {
          create: () => ({
            name: "scripted",
            complete: async () => {
              throw new AiError("network", "down");
            },
          }),
        } as unknown as AdapterRegistry;

        let t = 5_000_000;
        const clock = { now: () => t };
        // ONE registry, both consumers — the index.ts composition.
        const breakers = new CircuitBreakerRegistry({
          now: clock.now,
          threshold: 3,
          baseCooldownMs: 30_000,
        });
        const gateway = new AiGateway({
          storage,
          adapters: failingAdapters,
          secrets,
          now: clock.now,
          breakers,
          sleep: async () => {},
          random: () => 0.5,
        });
        const health = new ProviderHealthService(
          storage,
          providers,
          secrets,
          realAdapters,
          undefined,
          breakers,
        );

        // Record one probe so last() has a row (the probe itself fails:
        // .invalid never resolves — a configuration-grade failure, fast).
        const probeResult = await health.probe(providerId, { timeoutMs: 3_000 });
        expect(probeResult.ok).toBe(false);
        expect(probeResult.circuit?.state).toBe("closed");

        // Trip the breaker through the GATEWAY (3 consecutive failures).
        const req = {
          messages: [{ role: "user" as const, content: "سلام" }],
          model: "ignored",
          timeoutMs: 1_000,
          signal: new AbortController().signal,
        };
        for (let i = 0; i < 3; i++) {
          await expect(gateway.complete(req)).rejects.toMatchObject({ kind: "network" });
        }
        expect(gateway.circuitState(providerId).state).toBe("open");

        // The SAME state, read back through the health surface: proof the
        // two services share one registry instance, not two lookalikes.
        const last = health.last(providerId);
        expect(last).toBeDefined();
        expect(last!.circuit?.state).toBe("open");
        expect(last!.circuit?.consecutiveFailures).toBe(3);

        // Contrast: a health service built WITHOUT the shared registry
        // (the pre-wiring construction) has no circuit field at all.
        const blind = new ProviderHealthService(storage, providers, secrets, realAdapters);
        expect(blind.last(providerId)!.circuit).toBeUndefined();

        storage.close();
      },
    );
  });
});

// ---------- 2. intent router → tool catalog ----------

describe("wire 3: intent router orders/advises on the turn's specs (never narrows)", () => {
  const MANIFESTS = new ToolService().pluginCatalog;
  const catalog: ToolSpec[] = [
    spec("download_media"),
    spec("fetch_url"),
    spec("calculator"),
    spec("recall"),
    spec("remember"),
    spec("commands"),
    spec("web_search"),
  ];

  test("strong intent keeps the full set, hinted first, with note", async () => {
    await withEnv({ BOBI_INTENT_ROUTER: undefined }, async () => {
      const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      const routed = applyIntentRouting(catalog, url, MANIFESTS);
      const names = routed.specs.map((s) => s.name).sort();
      expect(names).toEqual(catalog.map((s) => s.name).sort());
      expect(routed.specs[0]!.name).toBe("download_media");
      expect(routed.note).toBe(`[router] suggested: download_media(url=${url})`);
    });
  });

  test("router off → byte-identical catalog, no note", async () => {
    await withEnv({ BOBI_INTENT_ROUTER: "0" }, async () => {
      const routed = applyIntentRouting(
        catalog,
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        MANIFESTS,
      );
      expect(routed.specs.map((s) => s.name)).toEqual(catalog.map((s) => s.name));
      expect(routed.note).toBeUndefined();
    });
  });

  test("weak hint only reorders (hinted first), membership unchanged", async () => {
    await withEnv({ BOBI_INTENT_ROUTER: undefined }, async () => {
      const routed = applyIntentRouting(catalog, "do you remember my coffee order?", MANIFESTS);
      expect(routed.specs.map((s) => s.name).sort()).toEqual(
        catalog.map((s) => s.name).sort(),
      );
      expect(routed.specs[0]!.name).toBe("recall");
    });
  });

  test("a hint for a tool the actor is not offered is dropped, not narrowed to", async () => {
    await withEnv({ BOBI_INTENT_ROUTER: undefined }, async () => {
      // Public actor: download_media was filtered out of the specs upstream.
      const publicSpecs = catalog.filter((s) => s.name !== "download_media");
      const routed = applyIntentRouting(
        publicSpecs,
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        MANIFESTS,
      );
      expect(routed.specs.map((s) => s.name)).toEqual(publicSpecs.map((s) => s.name));
      expect(routed.note).toBeUndefined();
    });
  });

  test("the loop offers exactly the caller-routed specs", async () => {
    const requests: CompletionRequest[] = [];
    const provider: AiProvider = {
      name: "capture",
      complete: async (req: CompletionRequest): Promise<CompletionResponse> => {
        requests.push(req);
        return { text: "done", model: "m" };
      },
    };
    const tools = new ToolService();
    const actor: ToolActor = {
      userId: "u1",
      permissions: ["tools:calculator", "tools:date_time"],
    };
    const full = tools.toolSpecsFor(actor);
    expect(full.length).toBeGreaterThan(1);
    const narrowed = full.slice(0, 1);

    const loop = new AgentLoop({
      provider,
      model: "m",
      tools,
      callTimeoutMs: 5_000,
    });
    await loop.run({
      messages: [{ role: "user", content: "hi" }],
      systemPrompt: "sys",
      actor,
      signal: new AbortController().signal,
      toolSpecs: narrowed,
    });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]!.tools?.map((t) => t.name)).toEqual([narrowed[0]!.name]);
  });
});

// ---------- 2b. router invariant: no spec is ever removed ----------

describe("router invariant: no spec is ever removed", () => {
  const MANIFESTS = new ToolService().pluginCatalog;
  const fullSpecs: ToolSpec[] = MANIFESTS.map((m) => ({
    name: m.id,
    description: "",
    parameters: {},
  }));
  const inputNames = fullSpecs.map((s) => s.name).sort();

  const messages = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "حساب کن ۱۲*۸",
    "این لینک رو دانلود کن https://www.youtube.com/watch?v=dQw4w9WgXcQ و فردا هم یادم بنداز",
    "یادم بنداز فردا ساعت ۹ به مامانم زنگ بزنم",
    "https://www.instagram.com/reel/ABC123/ فقط صدا",
  ];

  test("every battery message keeps the full 44-spec set, tool_search included", async () => {
    await withEnv({ BOBI_INTENT_ROUTER: undefined }, async () => {
      expect(fullSpecs.length).toBe(44);
      for (const message of messages) {
        const routed = applyIntentRouting(fullSpecs, message, MANIFESTS);
        expect(routed.specs.map((s) => s.name).sort()).toEqual(inputNames);
        expect(routed.specs.map((s) => s.name)).toContain("tool_search");
      }
    });
  });

  test("download+reminder message: both hinted tools present, download_media first", async () => {
    await withEnv({ BOBI_INTENT_ROUTER: undefined }, async () => {
      const routed = applyIntentRouting(
        fullSpecs,
        "این لینک رو دانلود کن https://www.youtube.com/watch?v=dQw4w9WgXcQ و فردا هم یادم بنداز",
        MANIFESTS,
      );
      const names = routed.specs.map((s) => s.name);
      expect(names).toContain("download_media");
      expect(names).toContain("remind_nl");
      // URL hint is 0.95, the reminder hint is ≤0.9, so download_media
      // is ordered ahead of remind_nl.
      expect(names.indexOf("download_media")).toBeLessThan(names.indexOf("remind_nl"));
    });
  });
});

// ---------- 3. schema v22 ----------

describe("wire 4: schema v22 recall telemetry", () => {
  test("a v21-shaped database migrates: columns appear, rows survive, version stamps 22", () => {
    const path = tempDb("v21");
    try {
      const db = new Database(path);
      db.exec(`
        CREATE TABLE _meta(k TEXT PRIMARY KEY, v TEXT);
        CREATE TABLE memories (
          user_id    TEXT NOT NULL,
          key        TEXT NOT NULL,
          content    TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          importance INTEGER NOT NULL DEFAULT 3,
          PRIMARY KEY (user_id, key)
        );
        INSERT INTO _meta(k,v) VALUES('schema_version','21');
        INSERT INTO memories(user_id, key, content, created_at, updated_at, importance)
          VALUES('u1','fact:name','محمد',1000,2000,5);
      `);
      db.close();

      const storage = Storage.open(path);
      expect(SCHEMA_VERSION).toBe(22);
      const rec = storage.getMemory("u1", "fact:name");
      expect(rec).toBeDefined();
      expect(rec!.content).toBe("محمد");
      expect(rec!.importance).toBe(5);
      expect(rec!.recallCount).toBe(0);
      expect(rec!.lastRecalledAt).toBeUndefined();
      storage.close();

      const raw = new Database(path, { readonly: true });
      const version = raw
        .query<{ v: string }, []>("SELECT v FROM _meta WHERE k='schema_version'")
        .get();
      expect(version?.v).toBe("22");
      const cols = raw
        .query<{ name: string }, []>("PRAGMA table_info(memories)")
        .all()
        .map((r) => r.name);
      expect(cols).toContain("recall_count");
      expect(cols).toContain("last_recalled_at");
      raw.close();
    } finally {
      cleanup(path);
    }
  });

  test("bumpMemoryRecall counts recalls without touching updated_at; setMemoryImportance likewise", () => {
    const path = tempDb("bump");
    try {
      const storage = Storage.open(path);
      storage.upsertMemory({ userId: "u1", key: "k1", content: "c1" });

      // Sentinel write clock: any accidental updated_at touch is visible.
      const raw = new Database(path);
      raw.exec(`UPDATE memories SET updated_at = 424242 WHERE user_id='u1' AND key='k1'`);

      expect(storage.bumpMemoryRecall("u1", ["k1", "missing-key"])).toBe(1);
      const after1 = storage.getMemory("u1", "k1")!;
      expect(after1.recallCount).toBe(1);
      expect(after1.lastRecalledAt).toBeGreaterThan(424242);
      expect(after1.updatedAt).toBe(424242);

      expect(storage.bumpMemoryRecall("u1", ["k1"])).toBe(1);
      expect(storage.getMemory("u1", "k1")!.recallCount).toBe(2);

      expect(storage.setMemoryImportance("u1", "k1", 5)).toBe(true);
      const after2 = storage.getMemory("u1", "k1")!;
      expect(after2.importance).toBe(5);
      expect(after2.updatedAt).toBe(424242);
      expect(storage.setMemoryImportance("u1", "missing-key", 4)).toBe(false);

      raw.close();
      storage.close();
    } finally {
      cleanup(path);
    }
  });

  test("recall-tool bumps make consolidation promotion live (schema-22 glue)", async () => {
    const storage = Storage.open(":memory:");
    const provider = new SqliteMemoryProvider(storage);
    await provider.upsert("u1", "coffee", "قهوه تلخ بدون شکر", { importance: 3 });

    // Six recalls: promotionTarget(6) = 4 > current importance 3.
    for (let i = 0; i < 6; i++) storage.bumpMemoryRecall("u1", ["coffee"]);
    const listed = await provider.list("u1", 10);
    expect(listed[0]!.recallCount).toBe(6);

    const report = await consolidateMemories(provider, "u1", { prune: false });
    expect(report.promoted).toBe(1);
    expect(storage.getMemory("u1", "coffee")!.importance).toBe(4);
    storage.close();
  });
});

// ---------- 4. prompt injection ----------

describe("wire 6: prompt memory blocks", () => {
  const base = {
    tools: [],
    now: new Date("2026-10-20T00:00:00Z"),
    timezone: "Asia/Tehran",
  };

  test("episode block present when an episode exists, absent otherwise", () => {
    const withEp = buildSystemPrompt({
      ...base,
      memoryCount: 3,
      lastEpisode: "موضوع: برنامه سفر\nباز: بلیط هنوز نخریده",
    });
    expect(withEp).toContain("⟨last session⟩");
    expect(withEp).toContain("برنامه سفر");

    const without = buildSystemPrompt({ ...base, memoryCount: 3 });
    expect(without).not.toContain("⟨last session⟩");
  });

  test("an oversized episode is capped to the token budget", () => {
    const huge = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const prompt = buildSystemPrompt({ ...base, lastEpisode: huge });
    const start = prompt.indexOf("⟨last session⟩\n") + "⟨last session⟩\n".length;
    const end = prompt.indexOf("\n\n", start);
    const body = prompt.slice(start, end === -1 ? undefined : end);
    expect(estimatePromptTokens(body)).toBeLessThanOrEqual(82);
    expect(body).toContain("…");
  });

  test("recalled memories render one line each, capped at five", () => {
    const prompt = buildSystemPrompt({
      ...base,
      recalledMemories: ["a", "b\nc", "d", "e", "f", "g"],
    });
    expect(prompt).toContain("⟨relevant memories⟩");
    expect(prompt).toContain("- b c");
    const lines = prompt
      .slice(prompt.indexOf("⟨relevant memories⟩"))
      .split("\n")
      .filter((l) => l.startsWith("- "));
    expect(lines.length).toBe(5);
  });

  test("switches off: the fetchers that feed the prompt return nothing", async () => {
    await withEnv(
      { BOBI_MEMORY_PROACTIVE_RECALL: "0", BOBI_MEMORY_EPISODES: "0" },
      async () => {
        expect(isEpisodesEnabled()).toBe(false);
        const mem: StoredMemory = {
          key: "coffee",
          content: "قهوه تلخ بدون شکر",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          importance: 4,
        };
        const provider: MemoryProvider = {
          name: "fake",
          upsert: () => {},
          get: () => undefined,
          list: () => [mem],
          delete: () => false,
          count: () => 1,
        };
        const out = await recallFor({ provider }, "u1", "درباره قهوه تلخ بگو");
        expect(out).toEqual([]);
      },
    );
  });

  test("switches on: proactive recall surfaces a genuinely matching memory", async () => {
    await withEnv(
      { BOBI_MEMORY_PROACTIVE_RECALL: undefined, BOBI_MEMORY_RECALL_FLOOR: undefined },
      async () => {
        const now = Date.now();
        const mem: StoredMemory = {
          key: "coffee-order",
          content: "قهوه تلخ بدون شکر دوست دارد",
          createdAt: now,
          updatedAt: now,
          importance: 4,
        };
        const provider: MemoryProvider = {
          name: "fake",
          upsert: () => {},
          get: () => undefined,
          list: () => [mem],
          delete: () => false,
          count: () => 1,
        };
        const out = await recallFor({ provider, nowMs: now }, "u1", "درباره قهوه تلخ بگو");
        expect(out.length).toBe(1);
        expect(out[0]!.key).toBe("coffee-order");
      },
    );
  });
});
