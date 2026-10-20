/**
 * /ai panel bug-fix & completeness audit tests (Oct 2026).
 *
 * These tests EXERCISE the flows instead of reading the code: they drive the
 * real AiAdminController with simulated owner callbacks and free-text replies
 * (fakeCtx/fakeCallbackCtx record exactly what the bot would send), then
 * assert on the rendered output, the persisted state, and the absence of dead
 * ends (buttons that decode but render nothing, silent no-ops, crashes).
 *
 * No network, no Telegram. Adapter I/O is stubbed through AdapterRegistry.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";
import { AdminBoundary } from "../src/auth/admin_boundary";
import { AuditLogger } from "../src/auth/audit";
import { AdapterRegistry, type AdapterConfig } from "../src/ai/adapter_registry";
import { AiError } from "../src/ai/provider";
import {
  PROVIDER_PRESETS,
  type AIProviderAdapter,
  type RemoteModel,
} from "../src/ai/adapter";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { ProviderHealthService } from "../src/ai/health";
import { AiAdminController } from "../src/groups/ai_controller";
import { encode, decode } from "../src/groups/callbacks";
import { AUDIT_STRING_KEYS, atr } from "../src/groups/ai_panel_audit_strings";

const OWNER_ID = 111111;

/** A fake ctx that records replies (free-text flows answer with new messages). */
function fakeCtx(from: { id: number } = { id: OWNER_ID }) {
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
  return {
    sent,
    ctx: ctx as unknown as Parameters<AiAdminController["handleCallback"]>[0],
  };
}

/** A fake callback-query ctx: panel clicks must EDIT the message in place. */
function fakeCallbackCtx(from: { id: number } = { id: OWNER_ID }) {
  const sent: Array<{ text: string; keyboard?: unknown }> = [];
  const edits: Array<{ text: string; keyboard?: unknown }> = [];
  const ctx = {
    get from() {
      return from;
    },
    callbackQuery: { data: "x" },
    editMessageText: async (text: string, other?: { reply_markup?: unknown }) => {
      edits.push({ text, keyboard: other?.reply_markup });
    },
    reply: async (text: string, other?: { reply_markup?: unknown }) => {
      sent.push({ text, keyboard: other?.reply_markup });
    },
    answerCallbackQuery: async () => {},
  };
  return {
    sent,
    edits,
    ctx: ctx as unknown as Parameters<AiAdminController["handleCallback"]>[0],
  };
}

/**
 * AdapterRegistry stub: complete() throws the given error (offline probe
 * failures), listModels() returns the given remote models when provided.
 */
class StubAdapters extends AdapterRegistry {
  constructor(
    private readonly err: unknown,
    private readonly remoteModels?: RemoteModel[],
    private readonly listModelsCapable?: boolean,
  ) {
    super();
  }
  override describes(type: string) {
    // The panel gates discovery on describes(), not on the created
    // adapter. Unset (the default) keeps the real registry's answer;
    // an explicit value pins the gate for the capability tests.
    const base = super.describes(type);
    return this.listModelsCapable === undefined
      ? base
      : { ...base, listModels: this.listModelsCapable };
  }
  override create(_type: string, _cfg: AdapterConfig): AIProviderAdapter {
    const err = this.err;
    const remoteModels = this.remoteModels;
    const adapter: Record<string, unknown> = {
      type: "openai_compatible",
      capabilities: { listModels: remoteModels !== undefined },
      label: "stub",
      complete: async (): Promise<never> => {
        throw err;
      },
    };
    if (remoteModels !== undefined) {
      adapter["listModels"] = async () => remoteModels;
    }
    return adapter as unknown as AIProviderAdapter;
  }
}

interface Harness {
  storage: Storage;
  ai: AiAdminController;
  providers: ProviderService;
  models: ModelService;
  health: ProviderHealthService;
}

function harness(
  opts: {
    adapters?: AdapterRegistry;
    prefs?: (userId: string, key: string) => string | undefined;
  } = {},
): Harness {
  const storage = Storage.open(":memory:");
  const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER_ID));
  const audit = new AuditLogger({ storage });
  const secrets = new ProviderSecretStore("audit-test-key");
  const adapters = opts.adapters ?? new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  // Short probe timeout: no test waits on a real connection deadline.
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
    ...(opts.prefs !== undefined ? { prefs: opts.prefs } : {}),
  });
  return { storage, ai, providers, models, health };
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

function lastText(c: { sent: Array<{ text: string }> }): string {
  return c.sent[c.sent.length - 1]?.text ?? "";
}

function lastEdit(c: {
  edits: Array<{ text: string; keyboard?: unknown }>;
}): { text: string; keyboard?: unknown } {
  return c.edits[c.edits.length - 1] ?? { text: "" };
}

function buttons(kb: unknown): Array<{ text: string; data: string }> {
  const rows =
    (
      kb as {
        inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
      }
    ).inline_keyboard ?? [];
  return rows.flatMap((r) =>
    r.map((b) => ({ text: b.text ?? "", data: b.callback_data ?? "" })),
  );
}

// ------------------------------------------------- audit strings parity ----

describe("audit strings fa/en parity", () => {
  test("every key has fa and en, non-empty, with matching placeholders", () => {
    expect(AUDIT_STRING_KEYS.length).toBeGreaterThan(0);
    for (const key of AUDIT_STRING_KEYS) {
      const fa = atr("fa", key);
      const en = atr("en", key);
      expect(fa.length, `${key} fa`).toBeGreaterThan(0);
      expect(en.length, `${key} en`).toBeGreaterThan(0);
      expect(fa, `${key} fa`).not.toBe(key);
      const vars = (s: string) =>
        [...s.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
      expect(vars(en), `${key} placeholders`).toEqual(vars(fa));
    }
  });

  test("atr substitutes vars and falls back like tr", () => {
    expect(atr("fa", "audit.select.active_model", { v: "X" })).toContain("X");
    expect(atr("en", "audit.select.active_model", { v: "X" })).toContain("X");
    expect(atr("fa", "audit.nope.missing")).toBe("audit.nope.missing");
  });
});

// ------------------------------------------- add provider via presets ----

describe("add provider via every preset", () => {
  for (const preset of PROVIDER_PRESETS) {
    test(`preset ${preset.id}: one message creates provider + model + activation`, async () => {
      const h = harness();
      const c = fakeCtx();

      await h.ai.handleCallback(c.ctx, encode({ kind: "ai_add_preset", preset: preset.id }));
      const prompt = lastText(c);
      expect(prompt).toContain(preset.label);
      expect(prompt).toContain("API key");

      const keyReply =
        preset.requiredPlaceholder !== undefined ? "sk-test-key,acct-123" : "sk-test-key";
      await h.ai.handleText(c.ctx, keyReply);

      const done = lastText(c);
      // The key is never echoed back.
      expect(done).not.toContain("sk-test-key");

      const views = h.providers.listViews();
      expect(views).toHaveLength(1);
      const v = views[0]!;
      const expectedBase =
        preset.requiredPlaceholder !== undefined
          ? preset.baseUrl.replace(`{${preset.requiredPlaceholder}}`, "acct-123")
          : preset.baseUrl;
      expect(v.baseUrl).toBe(expectedBase);
      expect(v.baseUrl).not.toContain("{");
      expect(v.hasCredential).toBe(true);

      // The suggested model is added and the pair is activated together.
      const ms = h.models.list(v.id);
      expect(preset.suggestedModel).toBeDefined();
      expect(ms.map((m) => m.modelId)).toContain(preset.suggestedModel!);
      const sel = h.storage.getRuntimeSettings();
      expect(sel.activeProviderId).toBe(v.id);
      expect(sel.activeModelId).not.toBeNull();

      // The wizard's "already connected" check agrees.
      expect(h.ai.hasConfiguredProvider()).toBe(true);
      expect(h.ai.activeProviderLabel()).toBe(v.label);

      h.storage.close();
    });
  }

  test("cloudflare junk (key without account id) re-prompts and keeps the flow", async () => {
    const h = harness();
    const c = fakeCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_add_preset", preset: "cloudflare" }));
    await h.ai.handleText(c.ctx, "sk-test-key");
    expect(lastText(c)).toContain("send it again");
    // The flow is still alive: a correct reply completes it.
    await h.ai.handleText(c.ctx, "sk-test-key,acct-123");
    expect(h.providers.listViews()).toHaveLength(1);
    h.storage.close();
  });

  test("preset setup never leaks the key and survives in English too", async () => {
    const h = harness({ prefs: () => "en" });
    const c = fakeCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_add_preset", preset: "groq" }));
    expect(lastText(c)).toContain("Send the API key");
    await h.ai.handleText(c.ctx, "sk-test-key");
    const done = lastText(c);
    expect(done).not.toContain("sk-test-key");
    expect(h.providers.listViews()).toHaveLength(1);
    h.storage.close();
  });
});

// ------------------------------------------ add provider via templates ----

describe("add provider via adapter templates", () => {
  test("openai_compatible form shows the suggested URL", async () => {
    const h = harness();
    const c = fakeCtx();
    await h.ai.handleCallback(
      c.ctx,
      encode({ kind: "ai_add_adapter", adapter: "openai_compatible" }),
    );
    expect(lastText(c)).toContain("https://api.openai.com/v1");
    h.storage.close();
  });

  test("nine_router form gives guidance, shows no bogus suggestion, keeps URL required", async () => {
    const h = harness();
    const c = fakeCtx();
    await h.ai.handleCallback(
      c.ctx,
      encode({ kind: "ai_add_adapter", adapter: "nine_router" }),
    );
    const form = lastText(c);
    // The template's own guidance note is shown...
    expect(form).toContain("Requires an address and model set by");
    // ...but no invented suggestion line...
    expect(form).not.toContain("پیشنهاد:");
    // ...and an empty URL is refused with a clear message, creating nothing.
    await h.ai.handleText(c.ctx, "نام نمایشی: 9R\nآدرس سرویس: \nکلید API: sk-9");
    expect(lastText(c)).toContain("Service address is required.");
    expect(h.providers.listViews()).toHaveLength(0);
    h.storage.close();
  });

  test("empty URL line falls back to the template suggestion; confirmation shows it", async () => {
    const h = harness();
    const c = fakeCtx();
    await h.ai.handleCallback(
      c.ctx,
      encode({ kind: "ai_add_adapter", adapter: "openai_compatible" }),
    );
    // Labelled lines with a deliberately empty URL line.
    await h.ai.handleText(c.ctx, "نام نمایشی: تست\nآدرس سرویس: \nکلید API: sk-abc");
    const views = h.providers.listViews();
    expect(views).toHaveLength(1);
    expect(views[0]!.baseUrl).toBe("https://api.openai.com/v1");
    const done = lastText(c);
    // The confirmation shows the EFFECTIVE url, never an empty one...
    expect(done).toContain("https://api.openai.com/v1");
    // ...never the key...
    expect(done).not.toContain("sk-abc");
    // ...and points at the next step (models), landing on the provider screen.
    expect(done).toContain("Models");
    const kb = buttons(c.sent[c.sent.length - 1]!.keyboard);
    expect(kb.some((b) => decode(b.data)?.kind === "ai_models")).toBe(true);
    h.storage.close();
  });

  test("explicitly typed URL wins over the suggestion", async () => {
    const h = harness();
    const c = fakeCtx();
    await h.ai.handleCallback(
      c.ctx,
      encode({ kind: "ai_add_adapter", adapter: "openai_compatible" }),
    );
    await h.ai.handleText(
      c.ctx,
      "نام نمایشی: تست\nآدرس سرویس: https://custom.example/v1\nکلید API: sk-abc",
    );
    expect(h.providers.listViews()[0]!.baseUrl).toBe("https://custom.example/v1");
    h.storage.close();
  });

  test("junk input re-prompts and the flow stays alive", async () => {
    const h = harness();
    const c = fakeCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_add_adapter", adapter: "gemini" }));
    expect(lastText(c)).toContain("https://generativelanguage.googleapis.com/v1beta");
    await h.ai.handleText(c.ctx, "just some chatter");
    expect(lastText(c)).toContain("Input is incomplete");
    // Still mid-flow: a proper submission completes it.
    await h.ai.handleText(c.ctx, "نام نمایشی: G\nآدرس سرویس: \nکلید API: sk-g");
    const views = h.providers.listViews();
    expect(views).toHaveLength(1);
    expect(views[0]!.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    h.storage.close();
  });

  test("cancel abandons the form with no write", async () => {
    const h = harness();
    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_add_adapter", adapter: "anthropic" }));
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_form_cancel" }));
    expect(h.providers.listViews()).toHaveLength(0);
    expect(lastEdit(c).text).toContain("connection type");
    h.storage.close();
  });
});

// ---------------------------------------------------------- probe ----

describe("probe outcomes", () => {
  test("missing / disabled / keyless providers give clear Persian results", async () => {
    const h = harness();
    // A stale button can name a provider that no longer exists: the panel
    // must answer plainly, never throw or stay silent.
    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_test", providerId: 999 }));
    const stale = lastEdit(c).text;
    expect(stale).toContain("Connection test failed.");
    expect(stale).toContain("Provider not found.");

    const p = h.providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://x.invalid/v1",
      apiKey: "k",
    });
    if (!p.ok) throw new Error("create failed");
    const pid = p.data;
    h.providers.setEnabled(pid, false);
    expect((await h.health.probe(pid)).message).toBe("Provider is disabled.");
    h.providers.setEnabled(pid, true);
    h.providers.clearCredential(pid);
    expect((await h.health.probe(pid)).message).toBe("Credential is not set.");
    h.storage.close();
  });

  test("adapter failures map to clear messages, are recorded, never crash", async () => {
    const cases: Array<[AiError["kind"], string]> = [
      ["auth", "Key or address was not accepted."],
      ["quota", "Service rate limit is full."],
      ["timeout", "No response arrived in time."],
      ["network", "Could not connect."],
      ["invalid_response", "Service response was invalid."],
      ["aborted", "Probe was cancelled."],
      ["unknown", "Probe failed."],
    ];
    for (const [kind, msg] of cases) {
      const h = harness({ adapters: new StubAdapters(new AiError(kind, "stub")) });
      const p = h.providers.create({
        label: "P",
        adapter: "openai_compatible",
        baseUrl: "https://x.invalid/v1",
        apiKey: "k",
      });
      if (!p.ok) throw new Error("create failed");
      // A model is required: probe() now fails fast on a model-less
      // provider (M2) before ever reaching the adapter under test.
      const added = h.models.add({ providerId: p.data, modelId: "m1", label: "M1" });
      if (!added.ok) throw new Error("model add failed");
      h.models.setDefault(added.data);
      const res = await h.health.probe(p.data);
      expect(res.ok, kind).toBe(false);
      expect(res.message, kind).toBe(msg);
      // Recorded, so the provider/status screens show the last outcome.
      expect(h.health.last(p.data)?.message, kind).toBe(msg);
      h.storage.close();
    }
  });

  test("ai_test renders progress then a clear result on the provider screen", async () => {
    const h = harness({ adapters: new StubAdapters(new AiError("network", "stub")) });
    const p = h.providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://x.invalid/v1",
      apiKey: "k",
    });
    if (!p.ok) throw new Error("create failed");
    // A model is required, or the probe stops at the no-model message (M2)
    // instead of reaching the failing adapter.
    const added = h.models.add({ providerId: p.data, modelId: "m1", label: "M1" });
    if (!added.ok) throw new Error("model add failed");
    h.models.setDefault(added.data);
    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_test", providerId: p.data }));
    // Progress first, then the result lead on the provider screen.
    expect(c.edits.length).toBeGreaterThanOrEqual(2);
    expect(c.edits[0]!.text).toContain("Testing connection");
    const last = lastEdit(c).text;
    expect(last).toContain("Connection test failed.");
    expect(last).toContain("Could not connect.");
    // Still the provider screen (test button present for a retry).
    expect(buttons(lastEdit(c).keyboard).some((b) => decode(b.data)?.kind === "ai_test")).toBe(
      true,
    );
    h.storage.close();
  });

  test("ai_test on a keyless provider names the missing credential", async () => {
    const h = harness();
    const p = h.providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://x.invalid/v1",
    });
    if (!p.ok) throw new Error("create failed");
    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_test", providerId: p.data }));
    const last = lastEdit(c).text;
    expect(last).toContain("Connection test failed.");
    expect(last).toContain("Credential is not set.");
    h.storage.close();
  });
});

// ------------------------------------------------- model discovery ----

describe("model discovery", () => {
  function providerWithKey(h: Harness, adapter = "openai_compatible"): number {
    const p = h.providers.create({
      label: "P",
      adapter,
      baseUrl: "https://x.invalid/v1",
      apiKey: "k",
    });
    if (!p.ok) throw new Error("create failed");
    return p.data;
  }

  test("discovered models are imported (disabled), duplicates skipped, lands on models screen", async () => {
    const remote: RemoteModel[] = [{ id: "m-a", label: "Model A" }, { id: "m-b" }];
    const h = harness({ adapters: new StubAdapters(new Error("no complete"), remote) });
    const pid = providerWithKey(h);
    const pre = h.models.add({ providerId: pid, modelId: "m-b", label: "B" });
    if (!pre.ok) throw new Error("model failed");

    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_discover", providerId: pid }));

    const last = lastEdit(c);
    // 1 new, 1 already there (fa digits).
    expect(last.text).toContain("1 new models");
    expect(last.text).toContain("already in the list");

    const listed = h.models.list(pid);
    expect(listed.map((m) => m.modelId).sort()).toEqual(["m-a", "m-b"]);
    const ma = listed.find((m) => m.modelId === "m-a")!;
    // Never auto-enabled, never default: the owner picks from the list.
    expect(ma.enabled).toBe(false);
    expect(ma.isDefault).toBe(false);
    expect(ma.label).toBe("Model A");
    // The pre-existing model is untouched.
    expect(listed.find((m) => m.modelId === "m-b")!.label).toBe("B");

    // Lands on the MODELS screen so the owner can enable them right away.
    const kb = buttons(last.keyboard);
    expect(kb.some((b) => b.data === encode({ kind: "ai_model_add_form", providerId: pid }))).toBe(
      true,
    );
    h.storage.close();
  });

  test("a second discovery reports nothing new", async () => {
    const remote: RemoteModel[] = [{ id: "m-a" }];
    const h = harness({ adapters: new StubAdapters(new Error("no complete"), remote) });
    const pid = providerWithKey(h);
    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_discover", providerId: pid }));
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_discover", providerId: pid }));
    expect(lastEdit(c).text).toContain("No new models found");
    h.storage.close();
  });

  test("import is capped so one chatty service cannot flood the panel", async () => {
    const remote: RemoteModel[] = Array.from({ length: 60 }, (_, i) => ({ id: `m-${i}` }));
    const h = harness({ adapters: new StubAdapters(new Error("no complete"), remote) });
    const pid = providerWithKey(h);
    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_discover", providerId: pid }));
    expect(h.models.list(pid)).toHaveLength(50);
    expect(lastEdit(c).text).toContain("50");
    h.storage.close();
  });

  test("unsupported adapter gives a clear error, not silence", async () => {
    // Every shipped adapter type declares listModels now (anthropic
    // included), so the no-capability gate is exercised through a
    // registry that reports the capability absent.
    const h = harness({
      adapters: new StubAdapters(new Error("no complete"), undefined, false),
    });
    const pid = providerWithKey(h, "anthropic");
    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_discover", providerId: pid }));
    expect(lastEdit(c).text).toContain("does not support");
    h.storage.close();
  });

  test("missing key gives a clear error", async () => {
    const h = harness();
    const p = h.providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://x.invalid/v1",
    });
    if (!p.ok) throw new Error("create failed");
    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_discover", providerId: p.data }));
    expect(lastEdit(c).text).toContain("No credential is set");
    h.storage.close();
  });
});

// ------------------------------------------------ model management ----

describe("model add / toggle / delete / default", () => {
  test("manual add persists and the UI reflects it", async () => {
    const h = harness();
    const { providerId } = activeProvider(h);
    const c = fakeCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_model_add_form", providerId }));
    expect(lastText(c)).toContain("Model ID");
    await h.ai.handleText(c.ctx, "gpt-x\nمدل ایکس");
    const listed = h.models.list(providerId);
    expect(listed.map((m) => m.modelId)).toContain("gpt-x");
    // The re-rendered list shows the new model.
    expect(lastText(c)).toContain("gpt-x");
    h.storage.close();
  });

  test("junk add re-prompts and the flow stays alive", async () => {
    const h = harness();
    const { providerId } = activeProvider(h);
    const c = fakeCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_model_add_form", providerId }));
    await h.ai.handleText(c.ctx, "only-one-line");
    expect(lastText(c)).toContain("Model ID");
    await h.ai.handleText(c.ctx, "gpt-x\nمدل ایکس");
    expect(h.models.list(providerId).map((m) => m.modelId)).toContain("gpt-x");
    h.storage.close();
  });

  test("toggle disables and re-enables, and the UI reflects it", async () => {
    const h = harness();
    const { providerId, modelId } = activeProvider(h);
    const m2 = h.models.add({ providerId, modelId: "m2", label: "دو" });
    if (!m2.ok) throw new Error("model failed");
    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_model_toggle", modelId: m2.data }));
    expect(lastEdit(c).text).toContain("Model disabled");
    expect(h.models.get(m2.data)!.enabled).toBe(false);
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_model_toggle", modelId: m2.data }));
    expect(lastEdit(c).text).toContain("Model enabled.");
    expect(h.models.get(m2.data)!.enabled).toBe(true);
    void modelId;
    h.storage.close();
  });

  test("delete is two-step", async () => {
    const h = harness();
    const { providerId } = activeProvider(h);
    const m2 = h.models.add({ providerId, modelId: "m2", label: "دو" });
    if (!m2.ok) throw new Error("model failed");
    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_model_delete", modelId: m2.data }));
    expect(h.models.get(m2.data)).toBeDefined();
    expect(lastEdit(c).text).toContain("Delete model");
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_model_delete_confirm", modelId: m2.data }));
    expect(h.models.get(m2.data)).toBeUndefined();
    expect(lastEdit(c).text).toContain("Model deleted.");
    h.storage.close();
  });

  test("set default marks the model and activates the pair", async () => {
    const h = harness();
    const { providerId, modelId } = activeProvider(h);
    const m2 = h.models.add({ providerId, modelId: "m2", label: "دو" });
    if (!m2.ok) throw new Error("model failed");
    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_model_default", modelId: m2.data }));
    expect(lastEdit(c).text).toContain("default");
    expect(h.models.get(m2.data)!.isDefault).toBe(true);
    expect(h.models.get(modelId)!.isDefault).toBe(false);
    const sel = h.storage.getRuntimeSettings();
    expect(sel.activeModelId).toBe(m2.data);
    h.storage.close();
  });

  test("set default on a disabled provider's model is refused, not a dead selection", async () => {
    const h = harness();
    const { providerId, modelId } = activeProvider(h);
    const p2 = h.providers.create({
      label: "P2",
      adapter: "openai_compatible",
      baseUrl: "https://b.invalid/v1",
      apiKey: "k",
    });
    if (!p2.ok) throw new Error("create failed");
    const m = h.models.add({ providerId: p2.data, modelId: "m9", label: "نه" });
    if (!m.ok) throw new Error("model failed");
    h.providers.setEnabled(p2.data, false);

    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_model_default", modelId: m.data }));
    expect(lastEdit(c).text).toContain("is disabled");
    // The runtime still points at the live pair.
    const sel = h.storage.getRuntimeSettings();
    expect(sel.activeProviderId).toBe(providerId);
    expect(sel.activeModelId).toBe(modelId);
    void providerId;
    h.storage.close();
  });
});

// --------------------------------------------------- key management ----

describe("key management", () => {
  test("replace via edit works; the key never appears on screen", async () => {
    const h = harness();
    const { providerId } = activeProvider(h);
    const c = fakeCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_edit", providerId }));
    const form = lastText(c);
    // The form shows the adapter SLUG (the parser needs it) plus the hint.
    expect(form).toContain("(openai_compatible)");
    expect(form).toContain("openai_compatible, gemini, anthropic, nine_router");

    const before = h.storage.getCredential(providerId);
    await h.ai.handleText(c.ctx, "کلید API: sk-brand-new");
    const after = h.storage.getCredential(providerId);
    // The stored envelope changed (proves replacement) without decrypting.
    expect(after).toBeDefined();
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
    expect(h.providers.credentialStatus(providerId)).toBe("set");
    // Masked display: set/unset only, never the key itself.
    const shown = lastText(c);
    expect(shown).not.toContain("sk-brand-new");
    expect(shown).not.toContain("sk-key-000");
    expect(shown).toContain("Key: set");
    h.storage.close();
  });

  test("clear is two-step and actually clears", async () => {
    const h = harness();
    const { providerId } = activeProvider(h);
    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_clear_key", providerId }));
    expect(h.providers.credentialStatus(providerId)).toBe("set");
    expect(lastEdit(c).text).toContain("Clear the key");
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_clear_key_confirm", providerId }));
    expect(h.providers.credentialStatus(providerId)).toBe("unset");
    expect(lastEdit(c).text).toContain("Key cleared.");
    expect(lastEdit(c).text).toContain("Key: not set");
    h.storage.close();
  });

  test("edit label persists; bad adapter is rejected clearly; good adapter applies", async () => {
    const h = harness();
    const { providerId } = activeProvider(h);
    const p2 = h.providers.create({
      label: "P2",
      adapter: "openai_compatible",
      baseUrl: "https://b.invalid/v1",
      apiKey: "k",
    });
    if (!p2.ok) throw new Error("create failed");

    const c = fakeCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_edit", providerId: p2.data }));
    await h.ai.handleText(c.ctx, "نام نمایشی: اسم تازه");
    expect(h.providers.view(p2.data)!.label).toBe("اسم تازه");
    expect(lastText(c)).toContain("Provider updated");

    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_edit", providerId: p2.data }));
    await h.ai.handleText(c.ctx, "نوع اتصال: bogus");
    expect(lastText(c)).toContain("Invalid connection type.");
    expect(h.providers.view(p2.data)!.adapter).toBe("openai_compatible");

    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_edit", providerId: p2.data }));
    await h.ai.handleText(c.ctx, "نوع اتصال: gemini");
    expect(h.providers.view(p2.data)!.adapter).toBe("gemini");
    // ...and the edit lands on the provider screen (not the providers list).
    const kb = buttons(c.sent[c.sent.length - 1]!.keyboard);
    expect(kb.some((b) => decode(b.data)?.kind === "ai_models")).toBe(true);

    // The ACTIVE provider's endpoint/adapter change is refused, not corrupted.
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_edit", providerId }));
    await h.ai.handleText(c.ctx, "نوع اتصال: gemini");
    expect(lastText(c)).toContain("is active");
    expect(h.providers.view(providerId)!.adapter).toBe("openai_compatible");
    h.storage.close();
  });
});

// --------------------------------------- provider enable/disable/delete ----

describe("provider enable / disable / delete", () => {
  test("disabling the active provider is refused; a spare toggles cleanly", async () => {
    const h = harness();
    const { providerId } = activeProvider(h);
    const p2 = h.providers.create({
      label: "P2",
      adapter: "openai_compatible",
      baseUrl: "https://b.invalid/v1",
      apiKey: "k",
    });
    if (!p2.ok) throw new Error("create failed");

    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_toggle", providerId }));
    expect(lastEdit(c).text).toContain("is active");
    expect(h.providers.view(providerId)!.enabled).toBe(true);

    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_toggle", providerId: p2.data }));
    expect(lastEdit(c).text).toContain("Provider disabled.");
    expect(h.providers.view(p2.data)!.enabled).toBe(false);
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_toggle", providerId: p2.data }));
    expect(h.providers.view(p2.data)!.enabled).toBe(true);
    h.storage.close();
  });

  test("deleting the active provider is refused; a spare deletes in two steps", async () => {
    const h = harness();
    const { providerId } = activeProvider(h);
    const p2 = h.providers.create({
      label: "P2",
      adapter: "openai_compatible",
      baseUrl: "https://b.invalid/v1",
      apiKey: "k",
    });
    if (!p2.ok) throw new Error("create failed");

    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_delete", providerId }));
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_delete_confirm", providerId }));
    expect(lastEdit(c).text).toContain("is in use");
    expect(h.providers.view(providerId)).toBeDefined();

    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_delete", providerId: p2.data }));
    expect(h.providers.view(p2.data)).toBeDefined();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_delete_confirm", providerId: p2.data }));
    expect(h.providers.view(p2.data)).toBeUndefined();
    expect(lastEdit(c).text).toContain("Provider deleted.");
    h.storage.close();
  });
});

// ------------------------------------------------- quick-switch flow ----

describe("quick-switch (provider → model picker)", () => {
  test("tapping a model switches the ACTIVE model without flipping the default", async () => {
    const h = harness();
    const { providerId, modelId } = activeProvider(h);
    const m2 = h.models.add({ providerId, modelId: "m2", label: "دو" });
    if (!m2.ok) throw new Error("model failed");

    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_select_menu" }));
    // The menu shows the actually-active model...
    expect(lastEdit(c).text).toContain("Active model: مدل یک");

    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_select_provider", providerId }));
    const pickerKb = buttons(lastEdit(c).keyboard);
    const modelBtns = pickerKb.filter((b) => b.text !== "Back");
    expect(modelBtns).toHaveLength(2);
    // ...every model button activates (no default side effect)...
    for (const b of modelBtns) {
      expect(decode(b.data)).toMatchObject({ kind: "ai_select_model" });
    }
    // ...and the active one carries the check mark.
    expect(modelBtns.find((b) => b.text.includes("مدل یک"))!.text).toContain("✓");
    expect(modelBtns.find((b) => b.text.includes("دو"))!.text).not.toContain("✓");

    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_select_model", modelId: m2.data }));
    const sel = h.storage.getRuntimeSettings();
    expect(sel.activeModelId).toBe(m2.data);
    // The default did NOT move.
    expect(h.models.get(modelId)!.isDefault).toBe(true);
    expect(h.models.get(m2.data)!.isDefault).toBe(false);
    // The menu now shows the new active model.
    expect(lastEdit(c).text).toContain("Active model: دو");
    h.storage.close();
  });

  test("a provider with no models explains instead of showing an empty picker", async () => {
    const h = harness();
    const { providerId } = activeProvider(h);
    const p2 = h.providers.create({
      label: "P2",
      adapter: "openai_compatible",
      baseUrl: "https://b.invalid/v1",
      apiKey: "k",
    });
    if (!p2.ok) throw new Error("create failed");

    const c = fakeCallbackCtx();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_select_menu" }));
    // The model-less provider is still listed, marked as such on its button.
    const menuBtns = buttons(lastEdit(c).keyboard);
    expect(menuBtns.some((b) => b.text.includes("(no models)"))).toBe(true);
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_select_provider", providerId: p2.data }));
    const screen = lastEdit(c);
    expect(screen.text).toContain("has no enabled models");
    expect(screen.text).toContain("Models");
    // A way back, not a dead end.
    const back = buttons(screen.keyboard).find((b) => b.text === "Back");
    expect(back).toBeDefined();
    expect(decode(back!.data)).toMatchObject({ kind: "ai_select_menu" });
    void providerId;
    h.storage.close();
  });

  test("legacy fo_add_pick_provider renders the picker instead of silently no-op", async () => {
    const h = harness();
    activeProvider(h);
    const c = fakeCallbackCtx();
    const before = c.edits.length + c.sent.length;
    const handled = await h.ai.handleCallback(c.ctx, encode({ kind: "fo_add_pick_provider" }));
    expect(handled).toBe(true);
    expect(c.edits.length + c.sent.length).toBeGreaterThan(before);
    h.storage.close();
  });
});

// ------------------------------------------------------- dead buttons ----

describe("no dead buttons on the /ai screens", () => {
  test("every button on every core screen decodes, dispatches, and renders", async () => {
    // Real adapters here: probes/discoveries fail offline but must still
    // render a clear result, never hang or stay silent.
    const h = harness();
    const { providerId, modelId } = activeProvider(h);
    const p2 = h.providers.create({
      label: "P2",
      adapter: "openai_compatible",
      baseUrl: "https://b.invalid/v1",
      apiKey: "k",
    });
    if (!p2.ok) throw new Error("create failed");
    const m2 = h.models.add({ providerId: p2.data, modelId: "m2", label: "دو" });
    if (!m2.ok) throw new Error("model failed");
    void modelId;

    const c = fakeCallbackCtx();
    const screens: Array<{ name: string; data: string }> = [
      { name: "ai_menu", data: encode({ kind: "ai_menu" }) },
      { name: "ai_providers", data: encode({ kind: "ai_providers" }) },
      { name: "ai_provider", data: encode({ kind: "ai_provider", providerId }) },
      { name: "ai_models", data: encode({ kind: "ai_models", providerId }) },
      { name: "ai_select_menu", data: encode({ kind: "ai_select_menu" }) },
      {
        name: "ai_select_provider",
        data: encode({ kind: "ai_select_provider", providerId }),
      },
      { name: "fo_menu", data: encode({ kind: "fo_menu" }) },
      { name: "ai_status", data: encode({ kind: "ai_status" }) },
      { name: "ai_add_form", data: encode({ kind: "ai_add_form" }) },
    ];

    // Every rendered button carries decodable callback data.
    const captured = new Map<string, ReturnType<typeof buttons>>();
    for (const s of screens) {
      await h.ai.handleCallback(c.ctx, s.data);
      const kb = lastEdit(c).keyboard;
      expect(kb, `${s.name} keyboard`).toBeDefined();
      const bs = buttons(kb);
      expect(bs.length, `${s.name} has buttons`).toBeGreaterThan(0);
      for (const b of bs) {
        expect(decode(b.data), `${s.name} button "${b.text}" decodes`).toBeDefined();
      }
      captured.set(s.name, bs);
    }

    // Every one of those buttons dispatches to a render — no silent no-ops.
    // Buttons outside the ai_/fo_/search_ family (e.g. the group panel's
    // "menu") belong to other controllers and are skipped here.
    for (const s of screens) {
      for (const b of captured.get(s.name)!) {
        const kind = decode(b.data)?.kind ?? "";
        if (kind === "search_menu") continue; // not wired here
        if (!/^(ai_|fo_|search_)/.test(kind)) continue; // another controller's
        const before = c.edits.length + c.sent.length;
        const handled = await h.ai.handleCallback(c.ctx, b.data);
        expect(handled, `${s.name} button "${b.text}" handled`).toBe(true);
        expect(
          c.edits.length + c.sent.length,
          `${s.name} button "${b.text}" rendered nothing`,
        ).toBeGreaterThan(before);
      }
    }
    h.storage.close();
  });
});
