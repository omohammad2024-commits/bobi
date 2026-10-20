/**
 * Provider services gauntlet (audit v2 G4/G6 + Wave-3 fixes M7/M8/L9/L10).
 *
 * Service/handler level, hermetic: in-memory storage, stub adapter
 * registries, one loopback wire double for the trailing-slash pin.
 * No network, no real keys.
 *
 *  - L10/G6: keys pasted as `Bearer …` or wrapped across lines are
 *    normalized on save (create, update, pool add) — asserted through
 *    the decrypt path and the Authorization header a fake adapter
 *    receives, never by logging a raw key.
 *  - G6: a provider created under master key A, read back under key B,
 *    surfaces the actionable SecretStoreError decrypt failure — not a
 *    raw crypto exception.
 *  - G4/M7: miniapp discovery flags stored models absent upstream as
 *    stale; the panel import reports a truncated import as
 *    "first 50 of N".
 *  - M8: miniapp models.setDefault round-trip; the health probe's
 *    default model follows.
 *  - L9: base URLs with `?`/`#` are rejected at save time (service and
 *    miniapp layers); a normal URL still saves.
 *  - G2 leftover: a stored trailing-slash base URL still completes
 *    against /v1/chat/completions.
 */
import { describe, expect, test } from "bun:test";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Storage } from "../src/storage/storage";
import {
  CredentialPoolStore,
  ProviderSecretStore,
  SecretStoreError,
} from "../src/ai/secret_store";
import { AdapterRegistry, type AdapterConfig } from "../src/ai/adapter_registry";
import {
  ModelService,
  ProviderService,
  normalizeApiKey,
} from "../src/ai/provider_service";
import { ProviderHealthService, type ProbeResult } from "../src/ai/health";
import {
  handleProviderApi,
  ProviderApiError,
  type ProviderApiDeps,
} from "../src/miniapp/api_providers";
import type { AIProviderAdapter, RemoteModel } from "../src/ai/adapter";
import type { CompletionRequest, CompletionResponse } from "../src/ai/provider";
import { AiAdminController } from "../src/groups/ai_controller";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";
import { AdminBoundary } from "../src/auth/admin_boundary";
import { AuditLogger } from "../src/auth/audit";
import { encode } from "../src/groups/callbacks";

const MASTER_A = "gauntlet-services-master-a";
const MASTER_B = "gauntlet-services-master-b";

// ------------------------------------------------------------- helpers ----

function serviceHarness(masterKey = MASTER_A): {
  storage: Storage;
  secrets: ProviderSecretStore;
  providers: ProviderService;
  models: ModelService;
} {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore(masterKey);
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  return { storage, secrets, providers, models };
}

function createProvider(
  providers: ProviderService,
  over: Partial<Parameters<ProviderService["create"]>[0]> = {},
): number {
  const r = providers.create({
    label: "P",
    adapter: "openai_compatible",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-clean-0000",
    ...over,
  });
  if (!r.ok) throw new Error(`create failed: ${r.message}`);
  return r.data;
}

function addModel(models: ModelService, providerId: number, modelId: string): number {
  const r = models.add({ providerId, modelId, label: modelId });
  if (!r.ok) throw new Error(`model add failed: ${r.message}`);
  return r.data;
}

// ------------------------------------------------------- L10 / G6 keys ----

describe("L10 key paste hygiene (G6)", () => {
  test("normalizeApiKey strips one Bearer prefix and all interior whitespace", () => {
    expect(normalizeApiKey("Bearer sk-abc-1234")).toBe("sk-abc-1234");
    expect(normalizeApiKey("bearer sk-abc-1234")).toBe("sk-abc-1234");
    expect(normalizeApiKey("  BEARER   sk-abc-1234  ")).toBe("sk-abc-1234");
    expect(normalizeApiKey("sk-ab\ncd\tef gh")).toBe("sk-abcdefgh");
    expect(normalizeApiKey("sk-plain")).toBe("sk-plain");
  });

  test("create: a `Bearer …` pasted key is stored without the prefix", () => {
    const h = serviceHarness();
    try {
      const pid = createProvider(h.providers, { apiKey: "Bearer sk-live-9876wxyz" });
      expect(h.providers.credentialFor(pid)).toBe("sk-live-9876wxyz");
      // The masked hint path (tail of the STORED key) is unaffected.
      expect(h.providers.credentialFor(pid)?.slice(-4)).toBe("wxyz");
    } finally {
      h.storage.close();
    }
  });

  test("create: a key wrapped across lines is stored joined", () => {
    const h = serviceHarness();
    try {
      const pid = createProvider(h.providers, { apiKey: "sk-ab\ncd  ef\tgh-1111" });
      expect(h.providers.credentialFor(pid)).toBe("sk-abcdefgh-1111");
    } finally {
      h.storage.close();
    }
  });

  test("update: replacing the key normalizes the same way", () => {
    const h = serviceHarness();
    try {
      const pid = createProvider(h.providers);
      const r = h.providers.update(pid, { apiKey: "bearer sk-new-2222\n" });
      expect(r.ok).toBe(true);
      expect(h.providers.credentialFor(pid)).toBe("sk-new-2222");
    } finally {
      h.storage.close();
    }
  });

  test("pool add: same normalization on the backup-key path", () => {
    const h = serviceHarness();
    try {
      const pid = createProvider(h.providers);
      const added = h.providers.addPoolKey(pid, "backup", "Bearer pool-key-3333\n");
      if (!added.ok) throw new Error(`pool add failed: ${added.message}`);
      const pool = new CredentialPoolStore(h.storage, h.secrets);
      expect(pool.loadPoolCredential(added.data)).toBe("pool-key-3333");
    } finally {
      h.storage.close();
    }
  });
});

describe("G6 master-key mismatch", () => {
  test("primary credential: reopening under another master key surfaces the actionable decrypt error", () => {
    const h = serviceHarness(MASTER_A);
    try {
      const pid = createProvider(h.providers, { apiKey: "sk-under-key-a" });
      const reopened = new ProviderService(
        h.storage,
        new ProviderSecretStore(MASTER_B),
        new AdapterRegistry(),
      );
      let caught: unknown;
      try {
        reopened.credentialFor(pid);
      } catch (err) {
        caught = err;
      }
      // Actionable, typed, and free of raw crypto internals.
      expect(caught).toBeInstanceOf(SecretStoreError);
      const e = caught as SecretStoreError;
      expect(e.kind).toBe("decrypt_failed");
      expect(e.message).toBe("Credential could not be decrypted.");
      expect(e.message).not.toContain("aes");
      expect(e.message).not.toContain("Unsupported state");
    } finally {
      h.storage.close();
    }
  });

  test("pool credential: same actionable error on the pool path", () => {
    const h = serviceHarness(MASTER_A);
    try {
      const pid = createProvider(h.providers);
      const added = h.providers.addPoolKey(pid, "backup", "sk-pool-under-a");
      if (!added.ok) throw new Error("pool add failed");
      const poolB = new CredentialPoolStore(
        h.storage,
        new ProviderSecretStore(MASTER_B),
      );
      let caught: unknown;
      try {
        poolB.loadPoolCredential(added.data);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SecretStoreError);
      expect((caught as SecretStoreError).kind).toBe("decrypt_failed");
    } finally {
      h.storage.close();
    }
  });
});

// ------------------------------------------------------------ L9 URLs ----

describe("L9 query/fragment base URLs rejected at save time", () => {
  test("service create rejects `?` and `#`, accepts a normal URL", () => {
    const h = serviceHarness();
    try {
      const q = h.providers.create({
        label: "Q",
        adapter: "openai_compatible",
        baseUrl: "https://api.example.com/v1?key=x",
      });
      expect(q.ok).toBe(false);
      if (!q.ok) expect(q.message).toContain("query string or fragment");

      const f = h.providers.create({
        label: "F",
        adapter: "openai_compatible",
        baseUrl: "https://api.example.com/v1#frag",
      });
      expect(f.ok).toBe(false);
      if (!f.ok) expect(f.message).toContain("query string or fragment");

      const ok = h.providers.create({
        label: "OK",
        adapter: "openai_compatible",
        baseUrl: "https://api.example.com/v1",
      });
      expect(ok.ok).toBe(true);
    } finally {
      h.storage.close();
    }
  });

  test("service update rejects a query-bearing base URL and keeps the old one", () => {
    const h = serviceHarness();
    try {
      const pid = createProvider(h.providers);
      const r = h.providers.update(pid, {
        baseUrl: "https://api.example.com/v1?key=x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("query string or fragment");
      expect(h.storage.getProvider(pid)?.baseUrl).toBe("https://api.example.com/v1");
    } finally {
      h.storage.close();
    }
  });

  test("miniapp providers.add rejects a query-bearing base URL with a 400", async () => {
    const h = serviceHarness();
    try {
      const deps = miniappDeps(h);
      let caught: unknown;
      try {
        await handleProviderApi(
          "providers.add",
          {
            kind: "custom",
            label: "Bad URL",
            baseUrl: "https://api.example.com/v1?key=x",
            key: "sk-1",
          },
          deps,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderApiError);
      const e = caught as ProviderApiError;
      expect(e.status).toBe(400);
      expect(e.message).toContain("query string or fragment");
      expect(h.storage.listProviders()).toHaveLength(0);
    } finally {
      h.storage.close();
    }
  });
});

// ------------------------------------------- miniapp deps / stub registry ----

/** Registry whose adapter serves a scripted remote model list. */
class ListRegistry extends AdapterRegistry {
  constructor(private readonly remote: readonly { id: string }[]) {
    super();
  }
  override create(_type: string, _cfg: AdapterConfig): AIProviderAdapter {
    const remote = this.remote;
    return {
      name: "stub",
      type: "openai_compatible",
      capabilities: { listModels: true },
      label: "stub",
      complete: async (_req: CompletionRequest): Promise<CompletionResponse> => ({
        text: "ok",
        model: "m1",
      }),
      listModels: async () => remote.map((r) => ({ ...r })),
    };
  }
}

function miniappDeps(
  h: ReturnType<typeof serviceHarness>,
  adapters?: AdapterRegistry,
): ProviderApiDeps {
  const health = {
    probe: async (_id: number): Promise<ProbeResult> => ({
      ok: true,
      checkedAt: Date.now(),
    }),
    probeModel: async (_id: number, _modelId: string): Promise<ProbeResult> => ({
      ok: true,
      checkedAt: Date.now(),
    }),
  };
  return {
    storage: h.storage,
    providerSvc: h.providers,
    modelSvc: h.models,
    health,
    ...(adapters !== undefined ? { adapters } : {}),
  };
}

// ------------------------------------------------- G4 / M7 miniapp stale ----

describe("G4/M7 miniapp discovery flags stale stored models", () => {
  test("a stored model absent upstream is returned in `stale`; present ones are flagged imported", async () => {
    const h = serviceHarness();
    try {
      const deps = miniappDeps(h, new ListRegistry([{ id: "m1" }, { id: "m2" }]));
      const pid = createProvider(h.providers);
      addModel(h.models, pid, "m1");
      const retired = addModel(h.models, pid, "retired-1");

      const res = await handleProviderApi("models.discover", { providerId: pid }, deps);
      const models = res["models"] as { modelId: string; imported: boolean }[];
      expect(models.map((m) => [m.modelId, m.imported])).toEqual([
        ["m1", true],
        ["m2", false],
      ]);
      expect(res["stale"]).toEqual([
        { id: retired, modelId: "retired-1", label: "retired-1" },
      ]);
      // Flagging only: the stale row is NOT deleted or disabled.
      const row = h.models.get(retired);
      expect(row?.enabled).toBe(true);
    } finally {
      h.storage.close();
    }
  });

  test("no stale field when every stored model is still offered", async () => {
    const h = serviceHarness();
    try {
      const deps = miniappDeps(h, new ListRegistry([{ id: "m1" }]));
      const pid = createProvider(h.providers);
      addModel(h.models, pid, "m1");
      const res = await handleProviderApi("models.discover", { providerId: pid }, deps);
      expect(res["stale"]).toBeUndefined();
    } finally {
      h.storage.close();
    }
  });
});

// ------------------------------------------------------------- M8 default ----

describe("M8 miniapp models.setDefault", () => {
  test("round-trip: default changes and the health probe targets the new default", async () => {
    const storage = Storage.open(":memory:");
    try {
      const secrets = new ProviderSecretStore(MASTER_A);
      const seenProbeModels: string[] = [];
      class ProbeRegistry extends AdapterRegistry {
        override create(_type: string, cfg: AdapterConfig): AIProviderAdapter {
          seenProbeModels.push(cfg.model);
          return {
            name: "stub",
            type: "openai_compatible",
            capabilities: { listModels: true },
            label: "stub",
            complete: async (req: CompletionRequest): Promise<CompletionResponse> => ({
              text: "ok",
              model: req.model,
            }),
          };
        }
      }
      const adapters = new ProbeRegistry();
      const providers = new ProviderService(storage, secrets, adapters);
      const models = new ModelService(storage);
      const pid = createProvider(providers);
      const first = addModel(models, pid, "model-first");
      const second = addModel(models, pid, "model-second");
      models.setDefault(first);

      const health = new ProviderHealthService(storage, providers, secrets, adapters, 300);
      const deps: ProviderApiDeps = {
        storage,
        providerSvc: providers,
        modelSvc: models,
        health: {
          probe: (id: number) => health.probe(id),
          probeModel: (id: number, m: string) => health.probeModel(id, m),
        },
        adapters,
      };

      const res = await handleProviderApi("models.setDefault", { id: second }, deps);
      expect(res["ok"]).toBe(true);
      expect(models.list(pid).find((m) => m.isDefault)?.modelId).toBe("model-second");
      // models.list surfaces the flag the Models tab renders.
      const listed = await handleProviderApi("models.list", { providerId: pid }, deps);
      const rows = listed["models"] as { modelId: string; isDefault: boolean }[];
      expect(rows.find((r) => r.modelId === "model-second")?.isDefault).toBe(true);
      expect(rows.find((r) => r.modelId === "model-first")?.isDefault).toBe(false);

      // The provider probe tests the DEFAULT model — it must now be the
      // new one, not the model chat happens to have active.
      seenProbeModels.length = 0;
      const probe = await health.probe(pid);
      expect(probe.ok).toBe(true);
      expect(seenProbeModels).toContain("model-second");
      expect(seenProbeModels).not.toContain("model-first");
    } finally {
      storage.close();
    }
  });

  test("invalid model id is a clean API error, not a crash", async () => {
    const h = serviceHarness();
    try {
      const deps = miniappDeps(h);
      let caught: unknown;
      try {
        await handleProviderApi("models.setDefault", { id: 424242 }, deps);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderApiError);
      expect((caught as ProviderApiError).status).toBe(404);

      let caughtBad: unknown;
      try {
        await handleProviderApi("models.setDefault", { id: "nope" }, deps);
      } catch (err) {
        caughtBad = err;
      }
      expect(caughtBad).toBeInstanceOf(ProviderApiError);
      expect((caughtBad as ProviderApiError).status).toBe(400);
    } finally {
      h.storage.close();
    }
  });
});

// ------------------------------------------------- G4 / M7 panel cap report ----

const PANEL_OWNER = 111111;

class PanelStubAdapters extends AdapterRegistry {
  constructor(private readonly remoteModels: RemoteModel[]) {
    super();
  }
  override create(_type: string, _cfg: AdapterConfig): AIProviderAdapter {
    const remoteModels = this.remoteModels;
    return {
      name: "stub",
      type: "openai_compatible",
      capabilities: { listModels: true },
      label: "stub",
      complete: async (): Promise<never> => {
        throw new Error("no complete in stub");
      },
      listModels: async () => remoteModels,
    } as unknown as AIProviderAdapter;
  }
}

function panelHarness(remote: RemoteModel[]): {
  storage: Storage;
  ai: AiAdminController;
  providers: ProviderService;
  models: ModelService;
} {
  const storage = Storage.open(":memory:");
  const auth = new AuthorizationService(OwnerIdentity.fromNumber(PANEL_OWNER));
  const audit = new AuditLogger({ storage });
  const secrets = new ProviderSecretStore(MASTER_A);
  const adapters = new PanelStubAdapters(remote);
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const health = new ProviderHealthService(storage, providers, secrets, adapters, 300);
  const ai = new AiAdminController({
    auth,
    admin: new AdminBoundary({ auth, audit }),
    storage,
    providers,
    models,
    health,
    secrets,
    adapters,
  });
  return { storage, ai, providers, models };
}

function fakeCallbackCtx(): {
  edits: Array<{ text: string; keyboard?: unknown }>;
  ctx: Parameters<AiAdminController["handleCallback"]>[0];
} {
  const edits: Array<{ text: string; keyboard?: unknown }> = [];
  const ctx = {
    get from() {
      return { id: PANEL_OWNER };
    },
    callbackQuery: { data: "x" },
    editMessageText: async (text: string, other?: { reply_markup?: unknown }) => {
      edits.push({ text, keyboard: other?.reply_markup });
    },
    reply: async () => {},
    answerCallbackQuery: async () => {},
  };
  return {
    edits,
    ctx: ctx as unknown as Parameters<AiAdminController["handleCallback"]>[0],
  };
}

describe("G4/M7 panel import reports the cap as first 50 of N", () => {
  test("60 upstream models import 50 and the message names the total", async () => {
    const remote: RemoteModel[] = Array.from({ length: 60 }, (_, i) => ({
      id: `m-${i}`,
    }));
    const h = panelHarness(remote);
    try {
      const pid = createProvider(h.providers);
      const c = fakeCallbackCtx();
      await h.ai.handleCallback(c.ctx, encode({ kind: "ai_discover", providerId: pid }));
      expect(h.models.list(pid)).toHaveLength(50);
      const text = c.edits[c.edits.length - 1]?.text ?? "";
      expect(text).toContain("first 50 of 60");
    } finally {
      h.storage.close();
    }
  });

  test("the truncation note survives a run where nothing in the first 50 is new", async () => {
    const remote: RemoteModel[] = Array.from({ length: 60 }, (_, i) => ({
      id: `m-${i}`,
    }));
    const h = panelHarness(remote);
    try {
      const pid = createProvider(h.providers);
      const c = fakeCallbackCtx();
      await h.ai.handleCallback(c.ctx, encode({ kind: "ai_discover", providerId: pid }));
      await h.ai.handleCallback(c.ctx, encode({ kind: "ai_discover", providerId: pid }));
      const text = c.edits[c.edits.length - 1]?.text ?? "";
      expect(text).toContain("No new models found");
      expect(text).toContain("first 50 of 60");
    } finally {
      h.storage.close();
    }
  });
});

// ------------------------------------- G2 leftover: trailing-slash base URL ----

describe("G2 leftover: trailing-slash base URL end to end", () => {
  test("stored https://host/v1/ completes against /v1/chat/completions with the normalized key", async () => {
    const seen: { pathname: string; authorization: string | undefined }[] = [];
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({
          pathname: new URL(req.url ?? "/", "http://127.0.0.1").pathname,
          authorization: req.headers["authorization"],
        });
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(
            JSON.stringify({
              id: "chatcmpl-slash",
              object: "chat.completion",
              model: "m1",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "ok" },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const h = serviceHarness();
    try {
      // Saved through the service exactly as an owner would: trailing
      // slash on the URL, Bearer-prefixed key — both must come out clean
      // at the adapter seam.
      const pid = createProvider(h.providers, {
        baseUrl: `http://127.0.0.1:${port}/v1/`,
        apiKey: "Bearer sk-slash-5555",
        allowLocal: true,
      });
      const row = h.storage.getProvider(pid);
      if (!row) throw new Error("provider row missing");
      expect(row.baseUrl.endsWith("/v1/")).toBe(true);

      const adapter = new AdapterRegistry().create("openai_compatible", {
        baseUrl: row.baseUrl,
        apiKey: h.providers.credentialFor(pid) ?? "",
        model: "m1",
        allowLocalTargets: true,
      });
      const out = await adapter.complete({
        messages: [{ role: "user", content: "hi" }],
        model: "m1",
        timeoutMs: 2000,
        signal: new AbortController().signal,
      });
      expect(out.text).toBe("ok");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.pathname).toBe("/v1/chat/completions");
      expect(seen[0]?.authorization).toBe("Bearer sk-slash-5555");
    } finally {
      h.storage.close();
      server.close();
    }
  });
});
