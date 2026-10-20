import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { Storage } from "../src/storage/storage";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";
import { AdminBoundary } from "../src/auth/admin_boundary";
import { AuditLogger } from "../src/auth/audit";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { AiError } from "../src/ai/provider";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { ProviderHealthService } from "../src/ai/health";
import { AiAdminController } from "../src/groups/ai_controller";
import { encode, decode } from "../src/groups/callbacks";

const OWNER_ID = 111111;
const USER_ID = 222222;

/** A fake ctx that records exactly what the bot would send. */
function fakeCtx(from: { id: number; username?: string } | undefined) {
  const sent: Array<{ text: string; keyboard?: unknown }> = [];
  let answered = 0;
  const ctx = {
    get from() {
      return from;
    },
    reply: async (text: string, other?: { reply_markup?: unknown }) => {
      sent.push({ text, keyboard: other?.reply_markup });
    },
    answerCallbackQuery: async () => {
      answered++;
    },
  };
  return {
    sent,
    answered: () => answered,
    ctx: ctx as unknown as Parameters<AiAdminController["handleCallback"]>[0],
  };
}

interface Harness {
  storage: Storage;
  ai: AiAdminController;
  audit: AuditLogger;
  secrets: ProviderSecretStore;
  providers: ProviderService;
  models: ModelService;
  health: ProviderHealthService;
}

function harness(opts: { withKey?: boolean; probeTimeoutMs?: number } = {}): Harness {
  const storage = Storage.open(":memory:");
  const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER_ID));
  const audit = new AuditLogger({ storage });
  const secrets = new ProviderSecretStore(
    opts.withKey === false ? undefined : "phase9-test-key",
  );
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  // A short probe timeout keeps the suite fast and offline: no test waits on a
  // real connection deadline.
  const health = new ProviderHealthService(
    storage,
    providers,
    secrets,
    adapters,
    opts.probeTimeoutMs ?? 300,
  );
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
  return { storage, ai, audit, secrets, providers, models, health };
}

/** Create a provider+model and make them the live selection. */
function activeProvider(h: Harness): { providerId: number; modelId: number } {
  const p = h.providers.create({
    label: "پروایدر اصلی",
    adapter: "openai_compatible",
    baseUrl: "https://api.invalid.example/v1",
    apiKey: "sk-key-000",
  });
  if (!p.ok) throw new Error("provider failed");
  const m = h.models.add({ providerId: p.data, modelId: "model-1", label: "مدل یک" });
  if (!m.ok) throw new Error("model failed");
  h.models.setDefault(m.data);
  h.storage.setRuntimeSelection({ providerId: p.data, modelId: m.data });
  return { providerId: p.data, modelId: m.data };
}

// ---------- callback codec ----------

describe("AI callback codec", () => {
  test("round-trips every AI action within the byte limit", () => {
    const actions = [
      { kind: "ai_menu" },
      { kind: "ai_providers" },
      { kind: "ai_provider", providerId: 1 },
      { kind: "ai_add_form" },
      { kind: "ai_add_adapter", adapter: "openai_compatible" },
      { kind: "ai_toggle", providerId: 999999 },
      { kind: "ai_test", providerId: 12345 },
      { kind: "ai_discover", providerId: 7 },
      { kind: "ai_clear_key", providerId: 7 },
      { kind: "ai_delete", providerId: 7 },
      { kind: "ai_models", providerId: 7 },
      { kind: "ai_model_add_form", providerId: 7 },
      { kind: "ai_model_toggle", modelId: 7 },
      { kind: "ai_model_delete", modelId: 7 },
      { kind: "ai_model_default", modelId: 7 },
      { kind: "ai_select_menu" },
      { kind: "ai_select_provider", providerId: 7 },
      { kind: "ai_select_model", modelId: 7 },
    ] as const;
    for (const a of actions) {
      const data = encode(a);
      expect(data.length).toBeLessThanOrEqual(64);
      expect(decode(data)).toEqual(a);
    }
  });

  test("rejects tampered and malformed AI callbacks", () => {
    for (const bad of [
      "adm:aiv:notanumber",
      "adm:aiv:-1",
      "adm:aiv:0",
      "adm:aiv:1.5",
      "adm:asm:abc",
      "adm:asm:99999999999999",
      "adm:ait:not_an_adapter",
      "adm:aix:",
      "adm:zzz:1",
      "adm:unknown",
    ]) {
      expect(decode(bad)).toBeUndefined();
    }
  });
});

// ---------- authorization ----------

describe("AI admin authorization", () => {
  test("the owner can open the AI section", async () => {
    const h = harness();
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.open(c.ctx);
    expect(c.sent[0]?.text).toContain("AI management");
    h.storage.close();
  });

  test("an ordinary user cannot open the AI section", async () => {
    const h = harness();
    const c = fakeCtx({ id: USER_ID });
    await h.ai.open(c.ctx);
    expect(c.sent[0]?.text).toContain("فقط برای مالک");
    expect(c.sent[0]?.text).not.toContain("AI management");
    h.storage.close();
  });

  test("a missing identity is denied", async () => {
    const h = harness();
    const c = fakeCtx(undefined);
    await h.ai.open(c.ctx);
    expect(c.sent[0]?.text).toContain("فقط برای مالک");
    h.storage.close();
  });

  test("a normal user cannot add, toggle, delete or test via callbacks", async () => {
    const h = harness();
    const active = activeProvider(h);
    const actions = [
      encode({ kind: "ai_add_form" }),
      encode({ kind: "ai_toggle", providerId: active.providerId }),
      encode({ kind: "ai_test", providerId: active.providerId }),
      encode({ kind: "ai_delete", providerId: active.providerId }),
      encode({ kind: "ai_clear_key", providerId: active.providerId }),
      encode({ kind: "ai_model_default", modelId: active.modelId }),
    ];
    for (const data of actions) {
      const c = fakeCtx({ id: USER_ID });
      await h.ai.handleCallback(c.ctx, data);
      expect(c.sent[0]?.text).toContain("فقط برای مالک");
    }
    // Nothing changed in the database.
    expect(h.providers.view(active.providerId)?.enabled).toBe(true);
    expect(h.storage.getProvider(active.providerId)).toBeDefined();
    expect(h.storage.hasCredential(active.providerId)).toBe(true);
    expect(h.storage.getRuntimeSettings().activeModelId).toBe(active.modelId);
    h.storage.close();
  });

  test("a normal user cannot act through a callback naming the owner's id", async () => {
    const h = harness();
    const active = activeProvider(h);
    // A forged payload using a numeric id equal to the owner's.
    const c = fakeCtx({ id: USER_ID });
    await h.ai.handleCallback(
      c.ctx,
      encode({ kind: "ai_toggle", providerId: active.providerId }),
    );
    expect(c.sent[0]?.text).toContain("فقط برای مالک");
    // Denial is audited and no state moved.
    const rows = h.storage.auditEvents(20);
    expect(rows.some((r) => r.outcome === "denied" && r.operation === "ai.toggle")).toBe(true);
    expect(h.providers.view(active.providerId)?.enabled).toBe(true);
    h.storage.close();
  });

  test("callbacks naming a deleted provider are handled safely", async () => {
    const h = harness();
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_provider", providerId: 424242 }));
    expect(c.sent[0]?.text).toContain("قدیمی");
    h.storage.close();
  });

  test("a callback for a deleted model is handled safely", async () => {
    const h = harness();
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_model_toggle", modelId: 424242 }));
    expect(c.sent[0]?.text).toContain("قدیمی");
    h.storage.close();
  });

  test("free-text add is only consumed for a user mid-flow", async () => {
    const h = harness();
    // No pending flow: the text must NOT be consumed.
    const c = fakeCtx({ id: OWNER_ID });
    const consumed = await h.ai.handleText(c.ctx, "سلام");
    expect(consumed).toBe(false);
    expect(c.sent.length).toBe(0);
    h.storage.close();
  });

  test("a normal user's text is never consumed as an AI form", async () => {
    const h = harness();
    const c = fakeCtx({ id: USER_ID });
    expect(await h.ai.handleText(c.ctx, "نام: X\nآدرس: Y\nکلید: Z")).toBe(false);
    h.storage.close();
  });
});

// ---------- credential safety ----------

describe("credential safety in the panel", () => {
  test("a provider view shows set/unset, never the key", async () => {
    const h = harness();
    const active = activeProvider(h);
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(
      c.ctx,
      encode({ kind: "ai_provider", providerId: active.providerId }),
    );
    const text = c.sent.map((s) => s.text).join("\n");
    expect(text).toContain("Key: set");
    expect(text).not.toContain("sk-key-000");
    h.storage.close();
  });

  test("the provider list never leaks a key", async () => {
    const h = harness();
    activeProvider(h);
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_providers" }));
    expect(JSON.stringify(c.sent)).not.toContain("sk-key-000");
    h.storage.close();
  });

  test("the audit trail records an AI op without the key", async () => {
    const h = harness();
    const active = activeProvider(h);
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(
      c.ctx,
      encode({ kind: "ai_toggle", providerId: active.providerId }),
    );
    const rows = h.storage.auditEvents(20);
    const row = rows.find((r) => r.operation === "ai.toggle");
    expect(row?.outcome).toBe("success");
    expect(row?.actorId).toBe(String(OWNER_ID));
    expect(row?.targetId).toBe(String(active.providerId));
    expect(JSON.stringify(rows)).not.toContain("sk-key-000");
    h.storage.close();
  });

  test("audit records a denial without the key", async () => {
    const h = harness();
    const active = activeProvider(h);
    const c = fakeCtx({ id: USER_ID });
    await h.ai.handleCallback(
      c.ctx,
      encode({ kind: "ai_test", providerId: active.providerId }),
    );
    const rows = h.storage.auditEvents(20);
    expect(rows.some((r) => r.outcome === "denied" && r.operation === "ai.test")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("sk-key-000");
    h.storage.close();
  });

  test("a missing master key fails closed in the panel too", async () => {
    const h = harness({ withKey: false });
    const c = fakeCtx({ id: OWNER_ID });
    // Start the add flow.
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_add_adapter", adapter: "openai_compatible" }));
    // Then submit a provider with a key.
    const c2 = fakeCtx({ id: OWNER_ID });
    await h.ai.handleText(c2.ctx, "نام: تست\nآدرس سرویس: https://x.invalid/v1\nکلید API: sk-key");
    expect(c2.sent[0]?.text).not.toContain("sk-key");
    expect(c2.sent[0]?.text).toContain("credential encryption key");
    // No provider was written.
    expect(h.storage.listProviders().length).toBe(0);
    h.storage.close();
  });
});

// ---------- owner workflow ----------

describe("AI admin workflow", () => {
  test("the owner adds a provider and the key is stored encrypted", async () => {
    const h = harness();
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_add_adapter", adapter: "openai_compatible" }));

    const c2 = fakeCtx({ id: OWNER_ID });
    const consumed = await h.ai.handleText(
      c2.ctx,
      "نام نمایشی: سرویس من\nآدرس سرویس: https://api.invalid.example/v1\nکلید API: sk-live-abc",
    );
    expect(consumed).toBe(true);

    const list = h.storage.listProviders();
    expect(list.length).toBe(1);
    expect(list[0]?.label).toBe("سرویس من");
    // The key is set, and the raw row does not hold the plaintext.
    expect(h.storage.hasCredential(list[0]!.id)).toBe(true);
    expect(JSON.stringify(h.storage.getCredential(list[0]!.id))).not.toContain("sk-live-abc");
    // The confirmation never echoes the key.
    expect(c2.sent.map((s) => s.text).join("\n")).not.toContain("sk-live-abc");
    h.storage.close();
  });

  test("an incomplete submission is refused without a partial write", async () => {
    const h = harness();
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_add_adapter", adapter: "gemini" }));
    const c2 = fakeCtx({ id: OWNER_ID });
    await h.ai.handleText(c2.ctx, "نام: X");
    expect(h.storage.listProviders().length).toBe(0);
    h.storage.close();
  });

  test("disabling the active provider is refused, then allowed after switching", async () => {
    const h = harness();
    const active = activeProvider(h);

    // The active provider cannot be disabled: that would leave the runtime
    // with no selection and produce an unexplained failure.
    const c1 = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c1.ctx, encode({ kind: "ai_toggle", providerId: active.providerId }));
    expect(c1.sent[0]?.text).toContain("is active");
    expect(h.providers.view(active.providerId)?.enabled).toBe(true);

    // Once another provider is active, disabling works.
    const p2 = h.providers.create({
      label: "P2",
      adapter: "openai_compatible",
      baseUrl: "https://b.invalid/v1",
      apiKey: "k",
    });
    if (!p2.ok) throw new Error("p2 failed");
    const m2 = h.models.add({ providerId: p2.data, modelId: "m2", label: "M2" });
    if (!m2.ok) throw new Error("m2 failed");
    h.storage.setRuntimeSelection({ providerId: p2.data, modelId: m2.data });

    const c2 = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c2.ctx, encode({ kind: "ai_toggle", providerId: active.providerId }));
    expect(h.providers.view(active.providerId)?.enabled).toBe(false);
    h.storage.close();
  });

  test("editing the active provider's endpoint is refused", () => {
    const h = harness();
    const active = activeProvider(h);
    // Renaming is always fine...
    expect(h.providers.update(active.providerId, { label: "نام نو" }).ok).toBe(true);
    // ...but repointing the endpoint the runtime is using is not.
    const res = h.providers.update(active.providerId, {
      baseUrl: "https://elsewhere.invalid/v1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("in_use");
    // The stored endpoint is unchanged.
    expect(h.storage.getProvider(active.providerId)?.baseUrl).toBe(
      "https://api.invalid.example/v1",
    );
    // Replacing the credential IS allowed, since it repairs rather than breaks.
    expect(h.providers.update(active.providerId, { apiKey: "sk-rotated" }).ok).toBe(true);
    h.storage.close();
  });

  test("disabling the active model is refused", () => {
    const h = harness();
    const active = activeProvider(h);
    const res = h.models.setEnabled(active.modelId, false);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("in_use");
    expect(h.storage.getModel(active.modelId)?.enabled).toBe(true);
    h.storage.close();
  });

  test("removing the last enabled model names the exact reason", () => {
    const h = harness();
    const p = h.providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://a.invalid/v1",
      apiKey: "k",
    });
    if (!p.ok) throw new Error("provider failed");
    const m = h.models.add({ providerId: p.data, modelId: "only", label: "تنها" });
    if (!m.ok) throw new Error("model failed");

    const res = h.models.remove(m.data);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("last_enabled");
      expect(res.message).toContain("only enabled model");
    }
    h.storage.close();
  });

  test("the owner clears a credential", async () => {
    const h = harness();
    const active = activeProvider(h);
    const c = fakeCtx({ id: OWNER_ID });
    // First tap only asks: the key must survive until the confirmation.
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_clear_key", providerId: active.providerId }));
    expect(h.providers.credentialStatus(active.providerId)).toBe("set");
    expect(c.sent.map((s) => s.text).join("\n")).toContain("Clear key");
    // Second tap clears.
    await h.ai.handleCallback(
      c.ctx,
      encode({ kind: "ai_clear_key_confirm", providerId: active.providerId }),
    );
    expect(h.providers.credentialStatus(active.providerId)).toBe("unset");
    h.storage.close();
  });

  test("selecting a model activates it and persists across a reopen", async () => {
    const path = `${tmpdir()}/sol-ai-persist-${Date.now()}.db`;
    try {
      const first = Storage.open(path);
      const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER_ID));
      const audit = new AuditLogger({ storage: first });
      const secrets = new ProviderSecretStore("phase9-test-key");
      const adapters = new AdapterRegistry();
      const providers = new ProviderService(first, secrets, adapters);
      const models = new ModelService(first);
      const health = new ProviderHealthService(first, providers, secrets, adapters);
      const ai = new AiAdminController({
        auth,
        admin: new AdminBoundary({ auth, audit }),
        storage: first,
        providers,
        models,
        health,
        secrets,
        adapters,
      });

      const p = providers.create({
        label: "P",
        adapter: "openai_compatible",
        baseUrl: "https://a.invalid/v1",
        apiKey: "sk-1",
      });
      if (!p.ok) throw new Error("provider failed");
      const a = models.add({ providerId: p.data, modelId: "m-a", label: "مدل الف" });
      const b = models.add({ providerId: p.data, modelId: "m-b", label: "مدل ب" });
      if (!a.ok || !b.ok) throw new Error("models failed");

      const c = fakeCtx({ id: OWNER_ID });
      await ai.handleCallback(c.ctx, encode({ kind: "ai_select_model", modelId: b.data }));
      expect(first.getRuntimeSettings().activeModelId).toBe(b.data);
      first.close();

      // A fresh process sees the same selection.
      const second = Storage.open(path);
      expect(second.getRuntimeSettings().activeModelId).toBe(b.data);
      expect(second.getModel(b.data)?.modelId).toBe("m-b");
      second.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(path + suffix, { force: true });
        } catch {
          // best effort on Windows
        }
      }
    }
  });

  test("the owner cannot delete the active provider, then can after switching", async () => {
    const h = harness();
    const active = activeProvider(h);

    const c1 = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c1.ctx, encode({ kind: "ai_delete", providerId: active.providerId }));
    expect(h.storage.getProvider(active.providerId)).toBeDefined();
    // The first tap only asks for confirmation, even for a deletable provider.
    await h.ai.handleCallback(
      c1.ctx,
      encode({ kind: "ai_delete_confirm", providerId: active.providerId }),
    );
    // Still the active provider: the confirmation refuses, it does not delete.
    expect(h.storage.getProvider(active.providerId)).toBeDefined();
    expect(c1.sent.map((s) => s.text).join("\n")).toContain("is in use");

    // Add a second provider and switch to it.
    const p2 = h.providers.create({
      label: "P2",
      adapter: "openai_compatible",
      baseUrl: "https://b.invalid/v1",
      apiKey: "k",
    });
    if (!p2.ok) throw new Error("p2 failed");
    const m2 = h.models.add({ providerId: p2.data, modelId: "m2", label: "M2" });
    if (!m2.ok) throw new Error("m2 failed");
    h.storage.setRuntimeSelection({ providerId: p2.data, modelId: m2.data });

    const c2 = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c2.ctx, encode({ kind: "ai_delete", providerId: active.providerId }));
    expect(h.storage.getProvider(active.providerId)).toBeDefined();
    await h.ai.handleCallback(
      c2.ctx,
      encode({ kind: "ai_delete_confirm", providerId: active.providerId }),
    );
    expect(h.storage.getProvider(active.providerId)).toBeUndefined();
    h.storage.close();
  });

  test("a model view shows both the real id and the display label", async () => {
    const h = harness();
    const active = activeProvider(h);
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_models", providerId: active.providerId }));
    const text = c.sent.map((s) => s.text).join("\n");
    expect(text).toContain("model-1");
    expect(text).toContain("مدل یک");
    h.storage.close();
  });

  test("an anthropic provider offers the discover button (adapter declares listModels)", async () => {
    const h = harness();
    const p = h.providers.create({
      label: "P",
      adapter: "anthropic",
      baseUrl: "https://api.invalid/v1",
      apiKey: "k",
    });
    if (!p.ok) throw new Error("provider failed");
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_provider", providerId: p.data }));
    const labels = labelsOf(c.sent[0]?.keyboard);
    // Anthropic's adapter declares listModels (GET /models), so the
    // discover affordance is offered like every other adapter's.
    expect(labels).toContain("Fetch models");
    h.storage.close();
  });
});

/** Extract the button labels of an inline keyboard. */
function labelsOf(kb: unknown): string[] {
  const rows = (kb as { inline_keyboard?: Array<Array<{ text: string }>> } | undefined)
    ?.inline_keyboard;
  return rows ? rows.flat().map((b) => b.text) : [];
}

// ---------- health ----------

describe("provider health", () => {
  test("a missing credential is reported, not attempted", async () => {
    const h = harness();
    const p = h.providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://api.invalid.example/v1",
    });
    if (!p.ok) throw new Error("provider failed");

    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_test", providerId: p.data }));
    const text = c.sent.map((s) => s.text).join("\n");
    expect(text).toContain("failed");
    expect(text).toContain("Credential");
    h.storage.close();
  });

  test("a failing probe records an outcome and never stores a key", async () => {
    const h = harness();
    const active = activeProvider(h);
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_test", providerId: active.providerId }));

    const health = h.storage.getProviderHealth(active.providerId);
    expect(health).toBeDefined();
    expect(health?.ok).toBe(false);
    expect(JSON.stringify(h.storage.auditEvents(20))).not.toContain("sk-key-000");
    h.storage.close();
  });

  test("a missing credential is reported, not attempted", async () => {
    const h = harness();
    const p = h.providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://api.invalid.example/v1",
    });
    if (!p.ok) throw new Error("provider failed");

    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_test", providerId: p.data }));
    const text = c.sent.map((s) => s.text).join("\n");
    expect(text).toContain("failed");
    expect(text).toContain("Credential");
    h.storage.close();
  });

  test("a probe deadline is diagnosed as a timeout, not a cancellation", async () => {
    const h = harness();
    const active = activeProvider(h);

    // The health service deliberately supplies a signal it never fires, so the
    // ADAPTER owns the deadline (a racing timer would misreport a slow service
    // as a cancellation). A faithful stand-in therefore enforces timeoutMs
    // itself and rejects with AiError("timeout"), exactly as a real adapter does.
    const stalling = {
      create: () =>
        ({
          name: "stall",
          capabilities: { listModels: true },
          listModels: (req: { timeoutMs: number }) =>
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new AiError("timeout", "deadline")), req.timeoutMs);
            }),
          complete: (req: { timeoutMs: number }) =>
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new AiError("timeout", "deadline")), req.timeoutMs);
            }),
        }) as unknown as ReturnType<AdapterRegistry["create"]>,
    } as unknown as AdapterRegistry;

    const health = new ProviderHealthService(h.storage, h.providers, h.secrets, stalling, 200);
    const probe = await health.probe(active.providerId);
    expect(probe.ok).toBe(false);
    expect(probe.message).toContain("No response arrived in time.");
    h.storage.close();
  });

  test("a normal user cannot trigger a probe", async () => {
    const h = harness();
    const active = activeProvider(h);
    const before = h.storage.getProviderHealth(active.providerId);
    const c = fakeCtx({ id: USER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_test", providerId: active.providerId }));
    // No probe result was recorded: the handler never ran.
    expect(h.storage.getProviderHealth(active.providerId)?.checkedAt).toBe(
      before?.checkedAt,
    );
    h.storage.close();
  });
});

// ---------- migration from v3 ----------

/** Build a schema-v3 database by hand, as an earlier release would have. */
function buildV3Database(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(user_id, chat_id));
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS _meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
      operation TEXT NOT NULL, actor_id TEXT,
      outcome TEXT NOT NULL, target_id TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS group_access (
      chat_id TEXT PRIMARY KEY, title TEXT, chat_type TEXT NOT NULL,
      state TEXT NOT NULL, requested_by TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT, notified_at INTEGER);
    INSERT INTO _meta(k,v) VALUES('schema_version','3');
    INSERT INTO conversations(user_id, chat_id, created_at) VALUES('u1','c1',1000);
    INSERT INTO messages(conversation_id, role, content, created_at)
      VALUES(1,'user','سلام قدیمی',1001);
    INSERT INTO audit_log(created_at, operation, actor_id, outcome)
      VALUES(1002,'panel.open','111111','success');
    INSERT INTO group_access(chat_id, chat_type, state, created_at, updated_at)
      VALUES('-100999','supergroup','approved',1003,1003);
  `);
  db.close();
}

describe("schema migration to v4", () => {
  test("preserves messages, audit rows and group access", () => {
    const path = `${tmpdir()}/sol-ai-mig-${Date.now()}.db`;
    try {
      buildV3Database(path);
      const s = Storage.open(path);

      expect(s.history("u1", "c1")[0]?.content).toBe("سلام قدیمی");
      expect(s.auditEvents(10).length).toBe(1);
      expect(s.groupAccess("-100999")?.state).toBe("approved");

      // And the new tables exist and are usable.
      const id = s.createProvider({ label: "بعد مهاجرت", adapter: "gemini", baseUrl: "https://g.invalid" });
      expect(s.getProvider(id)).toBeDefined();
      s.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(path + suffix, { force: true });
        } catch {
          // best effort
        }
      }
    }
  });
});
