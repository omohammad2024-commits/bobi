import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Storage } from "../src/storage/storage";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";
import { AdminBoundary } from "../src/auth/admin_boundary";
import { AuditLogger } from "../src/auth/audit";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { ProviderHealthService } from "../src/ai/health";
import { AiGateway } from "../src/ai/gateway";
import { AiAdminController } from "../src/groups/ai_controller";
import { encode } from "../src/groups/callbacks";
import { AiError } from "../src/ai/provider";

const OWNER_ID = 111111;
const USER_ID = 222222;
const KEY = "phase10-master-key";

/** A recording adapter: captures what it was asked, and can be scripted. */
function recordingAdapter(log: string[], behavior: { fail?: AiError } = {}) {
  return {
    name: "recorder",
    complete: async (req: { model: string; timeoutMs: number }) => {
      log.push(`${req.model}@${req.timeoutMs}`);
      if (behavior.fail) throw behavior.fail;
      return { text: "پاسخ", model: req.model };
    },
  };
}

function build(opts: {
  behavior?: { fail?: AiError };
  now?: () => number;
} = {}) {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore(KEY);
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const log: string[] = [];

  // Swap in a recording adapter registry so no network call is possible.
  const fakeAdapters = {
    create: (type: string, cfg: { model: string; timeoutMs?: number }) => {
      void type;
      const adapter = recordingAdapter(log, opts.behavior ?? {});
      // The gateway passes timeoutMs only through the request, so mirror that.
      return adapter as unknown as ReturnType<AdapterRegistry["create"]>;
    },
  } as unknown as AdapterRegistry;

  const gateway = new AiGateway({ storage, adapters: fakeAdapters, secrets });
  return { storage, secrets, providers, models, gateway, log };
}

function seedProvider(
  storage: Storage,
  providers: ProviderService,
  models: ModelService,
  tag: string,
): { providerId: number; modelId: number } {
  const p = providers.create({
    label: tag,
    adapter: "openai_compatible",
    baseUrl: `https://${tag}.invalid/v1`,
    apiKey: `sk-${tag}`,
  });
  if (!p.ok) throw new Error("provider failed");
  const m = models.add({ providerId: p.data, modelId: `model-${tag}`, label: tag });
  if (!m.ok) throw new Error("model failed");
  models.setDefault(m.data);
  return { providerId: p.data, modelId: m.data };
}

/** Make a specific pair the live selection. */
function activate(
  storage: Storage,
  ids: { providerId: number; modelId: number },
): void {
  storage.setRuntimeSelection(ids);
}

const REQUEST = {
  messages: [{ role: "user" as const, content: "سلام" }],
  model: "ignored",
  timeoutMs: 1000,
  signal: new AbortController().signal,
};

// ---------- failover is off by default ----------

describe("failover defaults off", () => {
  test("a fresh database never switches provider", () => {
    const h = build();
    expect(h.storage.getFailoverSettings().enabled).toBe(false);
    h.storage.close();
  });

  test("with failover off, a failing primary is not retried elsewhere", async () => {
    const h = build({ behavior: { fail: new AiError("network", "down") } });
    const a = seedProvider(h.storage, h.providers, h.models, "primary");
    const b = seedProvider(h.storage, h.providers, h.models, "backup");
    activate(h.storage, a);
    // A candidate exists, but the policy is off, so it must be ignored.
    h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

    await expect(h.gateway.complete(REQUEST)).rejects.toThrow(AiError);
    // Exactly one attempt: the primary, never the backup. The adapter gets
    // the caller's per-request budget (min of request and failover timeout).
    expect(h.log).toEqual(["model-primary@1000"]);
    h.storage.close();
  });

  test("with failover off, only the stored attempt budget of one applies", async () => {
    const h = build({ behavior: { fail: new AiError("timeout", "slow") } });
    const a = seedProvider(h.storage, h.providers, h.models, "only");
    activate(h.storage, a);
    await expect(h.gateway.complete(REQUEST)).rejects.toThrow(AiError);
    expect(h.log.length).toBe(1);
    h.storage.close();
  });
});

// ---------- failover on ----------

describe("failover enabled", () => {
  test("a retryable failure advances to the next candidate in order", async () => {
    // Primary fails, second succeeds: use a per-call scripted adapter.
    const storage = Storage.open(":memory:");
    const secrets = new ProviderSecretStore(KEY);
    const adapters = new AdapterRegistry();
    const providers = new ProviderService(storage, secrets, adapters);
    const models = new ModelService(storage);
    const log: string[] = [];

    const a = seedProvider(storage, providers, models, "a");
    const b = seedProvider(storage, providers, models, "b");
    storage.setRuntimeSelection(a);

    let call = 0;
    const scripted = {
      create: (type: string, cfg: { model: string }) => {
        void type;
        return {
          name: "scripted",
          complete: async (req: { model: string; timeoutMs: number }) => {
            log.push(`${cfg.model}@${req.timeoutMs}`);
            call++;
            if (call === 1) throw new AiError("network", "down");
            return { text: "ok", model: req.model };
          },
        } as unknown as ReturnType<AdapterRegistry["create"]>;
      },
    } as unknown as AdapterRegistry;

    const gateway = new AiGateway({ storage, adapters: scripted, secrets });
    storage.setFailoverSettings({ enabled: true, maxAttempts: 2 });
    storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

    const res = await gateway.complete(REQUEST);
    expect(res.text).toBe("ok");
    // The scripted adapter records the resolved model. Each candidate gets
    // min(request timeout, failover timeout) — here the request's 1000ms.
    expect(log).toEqual(["model-a@1000", "model-b@1000"]);
    storage.close();
  });

  test("a tighter failover timeout caps each candidate below the request budget", async () => {
    const h = build();
    const a = seedProvider(h.storage, h.providers, h.models, "a");
    activate(h.storage, a);
    h.storage.setFailoverSettings({ enabled: false, timeoutMs: 2000 });

    await h.gateway.complete({
      ...REQUEST,
      // A generous caller budget: the tighter failover per-candidate
      // timeout (2000) must still bound the attempt.
      timeoutMs: 5000,
    });
    expect(h.log).toEqual(["model-a@2000"]);
    h.storage.close();
  });

  test("a non-retryable failure is never retried through another provider", async () => {
    const h = build({ behavior: { fail: new AiError("auth", "bad key") } });
    const a = seedProvider(h.storage, h.providers, h.models, "a");
    const b = seedProvider(h.storage, h.providers, h.models, "b");
    activate(h.storage, a);
    h.storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
    h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

    await expect(h.gateway.complete(REQUEST)).rejects.toThrow(AiError);
    // One attempt only: an auth failure is a local misconfiguration, and
    // retrying would spend another service's quota to hide it.
    expect(h.log.length).toBe(1);
    h.storage.close();
  });

  test("a quota failure is not retried", async () => {
    const h = build({ behavior: { fail: new AiError("quota", "rate limited") } });
    const a = seedProvider(h.storage, h.providers, h.models, "a");
    const b = seedProvider(h.storage, h.providers, h.models, "b");
    activate(h.storage, a);
    h.storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
    h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);
    await expect(h.gateway.complete(REQUEST)).rejects.toThrow(AiError);
    expect(h.log.length).toBe(1);
    h.storage.close();
  });

  test("a validation failure is not retried", async () => {
    const h = build({ behavior: { fail: new AiError("invalid_response", "bad request") } });
    const a = seedProvider(h.storage, h.providers, h.models, "a");
    const b = seedProvider(h.storage, h.providers, h.models, "b");
    activate(h.storage, a);
    h.storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
    h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);
    await expect(h.gateway.complete(REQUEST)).rejects.toThrow(AiError);
    expect(h.log.length).toBe(1);
    h.storage.close();
  });

  test("an aborted request is never retried", async () => {
    const h = build({ behavior: { fail: new AiError("aborted", "cancelled") } });
    const a = seedProvider(h.storage, h.providers, h.models, "a");
    const b = seedProvider(h.storage, h.providers, h.models, "b");
    activate(h.storage, a);
    h.storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
    h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);
    await expect(h.gateway.complete(REQUEST)).rejects.toThrow(AiError);
    expect(h.log.length).toBe(1);
    h.storage.close();
  });

  test("the attempt budget is bounded no matter how many candidates", async () => {
    const h = build({ behavior: { fail: new AiError("network", "down") } });
    // One active plus four candidates, all failing.
    activate(h.storage, seedProvider(h.storage, h.providers, h.models, "p0"));
    const candidates = [1, 2, 3, 4].map((n) => {
      const ids = seedProvider(h.storage, h.providers, h.models, `p${n}`);
      return ids;
    });
    h.storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
    h.storage.setFailoverCandidates(candidates);

    await expect(h.gateway.complete(REQUEST)).rejects.toThrow(AiError);
    // Never more than maxAttempts tries in one request.
    expect(h.log.length).toBe(3);
    h.storage.close();
  });

  test("a candidate whose provider is disabled is skipped", async () => {
    const storage = Storage.open(":memory:");
    const secrets = new ProviderSecretStore(KEY);
    const adapters = new AdapterRegistry();
    const providers = new ProviderService(storage, secrets, adapters);
    const models = new ModelService(storage);
    const log: string[] = [];

    const a = seedProvider(storage, providers, models, "a");
    const b = seedProvider(storage, providers, models, "b");
    const c = seedProvider(storage, providers, models, "c");
    storage.setRuntimeSelection(a);
    // b is disabled, so only c is eligible.
    storage.setProviderEnabled(b.providerId, false);
    storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
    storage.setFailoverCandidates([
      { providerId: b.providerId, modelId: b.modelId },
      { providerId: c.providerId, modelId: c.modelId },
    ]);

    let call = 0;
    const scripted = {
      create: (type: string, cfg: { model: string }) => {
        void type;
        return {
          name: "s",
          complete: async (req: { model: string }) => {
            log.push(cfg.model);
            call++;
            if (call === 1) throw new AiError("network", "down");
            return { text: "ok", model: req.model };
          },
        } as unknown as ReturnType<AdapterRegistry["create"]>;
      },
    } as unknown as AdapterRegistry;

    const gateway = new AiGateway({ storage, adapters: scripted, secrets });
    const res = await gateway.complete(REQUEST);
    expect(res.text).toBe("ok");
    // The disabled candidate is never contacted.
    expect(log).toEqual(["model-a", "model-c"]);
    storage.close();
  });

  test("a candidate whose credential was removed is refused, not attempted", async () => {
    const storage = Storage.open(":memory:");
    const secrets = new ProviderSecretStore(KEY);
    const adapters = new AdapterRegistry();
    const providers = new ProviderService(storage, secrets, adapters);
    const models = new ModelService(storage);
    const log: string[] = [];

    const a = seedProvider(storage, providers, models, "a");
    const b = seedProvider(storage, providers, models, "b");
    storage.setRuntimeSelection(a);
    storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
    storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

    // Remove b's credential after the plan would be built.
    providers.clearCredential(b.providerId);

    let call = 0;
    const scripted = {
      create: (type: string, cfg: { model: string }) => {
        void type;
        return {
          name: "s",
          complete: async (req: { model: string }) => {
            log.push(cfg.model);
            call++;
            if (call === 1) throw new AiError("network", "down");
            return { text: "ok", model: req.model };
          },
        } as unknown as ReturnType<AdapterRegistry["create"]>;
      },
    } as unknown as AdapterRegistry;

    const gateway = new AiGateway({ storage, adapters: scripted, secrets });
    await expect(gateway.complete(REQUEST)).rejects.toThrow(AiError);
    // b's adapter is never constructed: its credential was revalidated first.
    expect(log).toEqual(["model-a"]);
    storage.close();
  });

  test("a clear normalized error is returned when every candidate fails", async () => {
    const h = build({ behavior: { fail: new AiError("network", "all down") } });
    const a = seedProvider(h.storage, h.providers, h.models, "a");
    const b = seedProvider(h.storage, h.providers, h.models, "b");
    activate(h.storage, a);
    h.storage.setFailoverSettings({ enabled: true, maxAttempts: 2 });
    h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

    // The last error surfaces, and it is a normalized AiError, not a raw one.
    const err = await h.gateway.complete(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).kind).toBe("network");
    expect(h.log.length).toBe(2);
    h.storage.close();
  });

  test("with no eligible candidates and no selection, a clear error is returned", async () => {
    const h = build();
    h.storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
    // No active selection and no candidates at all.
    await expect(h.gateway.complete(REQUEST)).rejects.toThrow(/No active provider/);
    h.storage.close();
  });
});

// ---------- snapshot consistency ----------

describe("snapshot consistency", () => {
  test("a config change mid-request does not change that request's model", async () => {
    const storage = Storage.open(":memory:");
    const secrets = new ProviderSecretStore(KEY);
    const adapters = new AdapterRegistry();
    const providers = new ProviderService(storage, secrets, adapters);
    const models = new ModelService(storage);

    const a = seedProvider(storage, providers, models, "a");
    const b = seedProvider(storage, providers, models, "b");
    storage.setRuntimeSelection(a);

    const seen: string[] = [];
    const recording = {
      create: (type: string, cfg: { model: string }) => {
        void type;
        const model = cfg.model;
        return {
          name: "r",
          complete: async () => {
            seen.push(model);
            return { text: "ok", model };
          },
        } as unknown as ReturnType<AdapterRegistry["create"]>;
      },
    } as unknown as AdapterRegistry;

    const gateway = new AiGateway({ storage, adapters: recording, secrets });

    const inFlight = gateway.complete(REQUEST);
    // Switch the live selection while the request is in flight.
    storage.setRuntimeSelection(b);
    await inFlight;

    expect(seen).toEqual(["model-a"]);
    storage.close();
  });

  test("a concurrent selection change is visible to the NEXT request", async () => {
    const h = build();
    const a = seedProvider(h.storage, h.providers, h.models, "a");
    const b = seedProvider(h.storage, h.providers, h.models, "b");
    activate(h.storage, a);

    await h.gateway.complete(REQUEST);
    expect(h.log).toEqual(["model-a@1000"]);

    // The next request sees the new selection immediately, no restart.
    activate(h.storage, b);
    await h.gateway.complete(REQUEST);
    expect(h.log[1]).toBe("model-b@1000");
    h.storage.close();
  });

  test("settings persist across a simulated restart", async () => {
    const path = `${tmpdir()}/sol-failover-${Date.now()}.db`;
    try {
      const first = Storage.open(path);
      const secrets = new ProviderSecretStore(KEY);
      const adapters = new AdapterRegistry();
      const providers = new ProviderService(first, secrets, adapters);
      const models = new ModelService(first);
      const a = seedProvider(first, providers, models, "a");
      const b = seedProvider(first, providers, models, "b");
      first.setRuntimeSelection(b);
      first.setFailoverSettings({ enabled: true, maxAttempts: 3 });
      first.setFailoverCandidates([{ providerId: a.providerId, modelId: a.modelId }]);
      first.close();

      // A fresh "process": the settings and selection must be identical.
      const second = Storage.open(path);
      const settings = second.getFailoverSettings();
      expect(settings.enabled).toBe(true);
      expect(settings.maxAttempts).toBe(3);
      expect(second.getRuntimeSettings().activeModelId).toBe(b.modelId);
      expect(second.listFailoverCandidates().length).toBe(1);
      second.close();
    } finally {
      // SQLite leaves -wal/-shm sidecars, and Windows holds them briefly after
      // close. Remove all of them, best effort, so the repo stays clean.
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(path + suffix, { force: true });
        } catch {
          // A leftover temp file must not fail the suite.
        }
      }
    }
  });

  test("failover bounds are clamped against a hostile configuration", () => {
    const h = build();
    h.storage.setFailoverSettings({ enabled: true, maxAttempts: 999, timeoutMs: 1 });
    const s = h.storage.getFailoverSettings();
    // Never an unbounded attempt count, and never a zero timeout.
    expect(s.maxAttempts).toBeLessThanOrEqual(4);
    expect(s.timeoutMs).toBeGreaterThanOrEqual(1000);
    h.storage.close();
  });
});

// ---------- edit flow through the panel ----------

/** Build a full panel harness with a short probe timeout. */
function panel() {
  const storage = Storage.open(":memory:");
  const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER_ID));
  const audit = new AuditLogger({ storage });
  const secrets = new ProviderSecretStore(KEY);
  const adapters = new AdapterRegistry();
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
  return { storage, ai, providers, models, storage2: storage };
}

function fakeCtx(from: { id: number } | undefined) {
  const sent: Array<{ text: string; keyboard?: unknown }> = [];
  const ctx = {
    get from() {
      return from;
    },
    reply: async (text: string, other?: { reply_markup?: unknown }) => {
      sent.push({ text, keyboard: other?.reply_markup });
    },
    answerCallbackQuery: async () => {},
  };
  return { sent, ctx: ctx as unknown as Parameters<AiAdminController["handleCallback"]>[0] };
}

describe("edit-provider flow", () => {
  const owner = () => fakeCtx({ id: OWNER_ID });

  test("the owner renames a provider without a restart", async () => {
    const h = panel();
    const p = h.providers.create({
      label: "قدیمی",
      adapter: "openai_compatible",
      baseUrl: "https://a.invalid/v1",
      apiKey: "sk-1",
    });
    if (!p.ok) throw new Error("create failed");

    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_edit", providerId: p.data }));
    // The form was rendered, and the store is unchanged so far.
    expect(c.sent[0]?.text).toContain("Edit provider");
    expect(h.storage.getProvider(p.data)?.label).toBe("قدیمی");

    const c2 = owner();
    await h.ai.handleText(c2.ctx, "نام نمایشی: تازه");
    expect(h.storage.getProvider(p.data)?.label).toBe("تازه");
    expect(c2.sent[0]?.text).toContain("تازه");
    h.storage.close();
  });

  test("the owner replaces a credential through the edit form", async () => {
    const h = panel();
    const p = h.providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://a.invalid/v1",
      apiKey: "sk-old",
    });
    if (!p.ok) throw new Error("create failed");

    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_edit", providerId: p.data }));
    const c2 = owner();
    await h.ai.handleText(c2.ctx, "کلید API: sk-rotated");

    expect(h.providers.credentialFor(p.data)).toBe("sk-rotated");
    // The confirmation never shows the key.
    expect(c2.sent.map((s) => s.text).join("\n")).not.toContain("sk-rotated");
    h.storage.close();
  });

  test("an empty key line keeps the current credential", async () => {
    const h = panel();
    const p = h.providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://a.invalid/v1",
      apiKey: "sk-keep",
    });
    if (!p.ok) throw new Error("create failed");

    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_edit", providerId: p.data }));
    const c2 = owner();
    await h.ai.handleText(c2.ctx, "نام نمایشی: نو\nکلید API:");
    expect(h.providers.credentialFor(p.data)).toBe("sk-keep");
    h.storage.close();
  });

  test("editing the active provider's endpoint is refused with a reason", async () => {
    const h = panel();
    const p = h.providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://a.invalid/v1",
      apiKey: "sk-1",
    });
    if (!p.ok) throw new Error("create failed");
    const m = h.models.add({ providerId: p.data, modelId: "m1", label: "M1" });
    if (!m.ok) throw new Error("model failed");
    h.storage.setRuntimeSelection({ providerId: p.data, modelId: m.data });

    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_edit", providerId: p.data }));
    const c2 = owner();
    await h.ai.handleText(c2.ctx, "آدرس سرویس: https://other.invalid/v1");

    // Refused, the stored endpoint is unchanged, and the reason is shown.
    expect(h.storage.getProvider(p.data)?.baseUrl).toBe("https://a.invalid/v1");
    expect(c2.sent[0]?.text).toContain("is active");
    h.storage.close();
  });

  test("an edit against a deleted provider is stale", async () => {
    const h = panel();
    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_edit", providerId: 4242 }));
    expect(c.sent[0]?.text).toContain("قدیمی");
    h.storage.close();
  });
});

// ---------- authorization on the new paths ----------

describe("edit authorization", () => {
  test("a normal user cannot open the edit form", async () => {
    const h = panel();
    const p = h.providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://a.invalid/v1",
      apiKey: "sk-1",
    });
    if (!p.ok) throw new Error("create failed");
    const c = fakeCtx({ id: USER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_edit", providerId: p.data }));
    expect(c.sent[0]?.text).toContain("فقط برای مالک");
    h.storage.close();
  });

  test("a normal user's edit text is never consumed", async () => {
    const h = panel();
    const p = h.providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://a.invalid/v1",
      apiKey: "sk-1",
    });
    if (!p.ok) throw new Error("create failed");

    // The owner opens the form; a different user then replies with text.
    const c1 = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c1.ctx, encode({ kind: "ai_edit", providerId: p.data }));
    const c2 = fakeCtx({ id: USER_ID });
    const consumed = await h.ai.handleText(c2.ctx, "نام نمایشی: دستکاری");
    expect(consumed).toBe(false);
    expect(h.storage.getProvider(p.data)?.label).toBe("P");
    h.storage.close();
  });

  test("edits are audited without the key", async () => {
    const h = panel();
    const p = h.providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://a.invalid/v1",
      apiKey: "sk-secret-key-x",
    });
    if (!p.ok) throw new Error("create failed");

    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_edit", providerId: p.data }));
    const c2 = fakeCtx({ id: OWNER_ID });
    await h.ai.handleText(c2.ctx, "نام نمایشی: نو\nکلید API: sk-secret-key-x");

    const rows = JSON.stringify(h.storage.auditEvents(20));
    expect(rows).not.toContain("sk-secret-key-x");
    h.storage.close();
  });
});
