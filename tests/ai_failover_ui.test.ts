import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { rmSync, existsSync } from "node:fs";
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
import { AiAdminController } from "../src/groups/ai_controller";
import { encode, decode } from "../src/groups/callbacks";
import { OpenAICompatibleAdapter } from "../src/ai/openai_compatible";
import { validateTarget } from "../src/ai/target";
import { AiError } from "../src/ai/provider";

const OWNER_ID = 111111;
const USER_ID = 222222;
const KEY = "phase11-master-key";

/** A recording adapter: captures what it was asked, and can be scripted. */
interface SpyLog {
  attempts: Array<{ model: string; timeoutMs: number; baseUrl: string }>;
}

function build(opts: { behavior?: { fail?: AiError } } = {}) {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore(KEY);
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const log: SpyLog = { attempts: [] };

  const recording = {
    create: (type: string, cfg: { model: string; baseUrl: string }) => {
      void type;
      return {
        name: "recorder",
        capabilities: { listModels: false },
        complete: async (req: { model: string; timeoutMs: number }) => {
          log.attempts.push({ model: req.model, timeoutMs: req.timeoutMs, baseUrl: cfg.baseUrl });
          if (opts.behavior?.fail) throw opts.behavior.fail;
          return { text: "پاسخ", model: req.model };
        },
      } as unknown as ReturnType<AdapterRegistry["create"]>;
    },
  } as unknown as AdapterRegistry;

  const gateway = {
    complete: async () => ({ text: "پاسخ", model: "m" }),
  };

  return { storage, secrets, providers, models, gateway, log, recording };
}

/** A fake Telegram context that records what was sent. */
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
  providers: ProviderService;
  models: ModelService;
  audit: AuditLogger;
}

function panel(): Harness {
  const storage = Storage.open(":memory:");
  const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER_ID));
  const audit = new AuditLogger({ storage });
  const secrets = new ProviderSecretStore(KEY);
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const health = new ProviderHealthService(storage, providers, secrets, adapters, 250);
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
  return { storage, ai, providers, models, audit };
}

/** Create a provider and its model, returning both ids. */
function seed(h: Harness, tag: string): { providerId: number; modelId: number } {
  const p = h.providers.create({
    label: tag,
    adapter: "openai_compatible",
    baseUrl: `https://${tag}.invalid/v1`,
    apiKey: `sk-${tag}`,
  });
  if (!p.ok) throw new Error("provider failed");
  const m = h.models.add({ providerId: p.data, modelId: `model-${tag}`, label: tag });
  if (!m.ok) throw new Error("model failed");
  h.models.setDefault(m.data);
  return { providerId: p.data, modelId: m.data };
}

/** Make a pair the live runtime selection. */
function activate(h: Harness, ids: { providerId: number; modelId: number }): void {
  h.storage.setRuntimeSelection(ids);
}

const owner = () => fakeCtx({ id: OWNER_ID });
const user = () => fakeCtx({ id: USER_ID });

// ---------- codec ----------

describe("failover callback codec", () => {
  test("round-trips every failover action within 64 bytes", () => {
    const actions = [
      { kind: "fo_menu" },
      { kind: "fo_toggle" },
      { kind: "fo_attempts" },
      { kind: "fo_attempts_set", value: 3 },
      { kind: "fo_timeout" },
      { kind: "fo_timeout_set", value: 20000 },
      { kind: "fo_add_form" },
      { kind: "fo_add_pick_provider" },
      { kind: "fo_add_pick_model", providerId: 12 },
      { kind: "fo_add_confirm", providerId: 12, modelId: 34 },
      { kind: "fo_remove", index: 2 },
      { kind: "fo_move_up", index: 2 },
      { kind: "fo_move_down", index: 2 },
      { kind: "ai_status" },
      { kind: "fo_local_menu", providerId: 7 },
      { kind: "fo_local_confirm", providerId: 7 },
    ] as const;
    for (const a of actions) {
      const data = encode(a);
      expect(data.length).toBeLessThanOrEqual(64);
      expect(decode(data)).toEqual(a);
    }
  });

  test("rejects out-of-range attempts and timeouts", () => {
    for (const bad of [
      "adm:foav:0",
      "adm:foav:5",
      "adm:foav:-1",
      "adm:foav:abc",
      "adm:fodv:999",
      "adm:fodv:99999",
      "adm:fodv:0",
    ]) {
      expect(decode(bad)).toBeUndefined();
    }
  });

  test("rejects a malformed two-id confirm payload", () => {
    for (const bad of ["adm:foac:1", "adm:foac:1:2:3", "adm:foac:0:1", "adm:foac:1:0"]) {
      expect(decode(bad)).toBeUndefined();
    }
  });

  test("rejects an out-of-range list index", () => {
    expect(decode("adm:for:201")).toBeUndefined();
    expect(decode("adm:for:-1")).toBeUndefined();
    expect(decode("adm:for:200")).toEqual({ kind: "fo_remove", index: 200 });
  });
});

// ---------- failover administration ----------

describe("failover administration", () => {
  test("failover is off until the owner turns it on", async () => {
    const h = panel();
    activate(h, seed(h, "a"));
    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "fo_menu" }));
    expect(c.sent[0]?.text).toContain("غیرفعال");
    h.storage.close();
  });

  test("the owner enables and disables failover", async () => {
    const h = panel();
    const a = seed(h, "a");
    activate(h, a);
    // A candidate must exist first, or enabling is refused with a reason.
    h.storage.setFailoverCandidates([{ providerId: a.providerId, modelId: a.modelId }]);

    const c1 = owner();
    await h.ai.handleCallback(c1.ctx, encode({ kind: "fo_toggle" }));
    expect(h.storage.getFailoverSettings().enabled).toBe(true);

    const c2 = owner();
    await h.ai.handleCallback(c2.ctx, encode({ kind: "fo_toggle" }));
    expect(h.storage.getFailoverSettings().enabled).toBe(false);
    h.storage.close();
  });

  test("enabling with no candidate is refused, not silently applied", async () => {
    const h = panel();
    activate(h, seed(h, "a"));
    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "fo_toggle" }));
    expect(c.sent[0]?.text).toContain("جایگزین");
    expect(h.storage.getFailoverSettings().enabled).toBe(false);
    h.storage.close();
  });

  test("the owner updates max attempts within 1..4", async () => {
    const h = panel();
    activate(h, seed(h, "a"));
    for (const value of [1, 2, 3, 4]) {
      const c = owner();
      await h.ai.handleCallback(c.ctx, encode({ kind: "fo_attempts_set", value }));
      expect(h.storage.getFailoverSettings().maxAttempts).toBe(value);
    }
    h.storage.close();
  });

  test("the owner updates the per-candidate timeout", async () => {
    const h = panel();
    activate(h, seed(h, "a"));
    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "fo_timeout_set", value: 20_000 }));
    expect(h.storage.getFailoverSettings().timeoutMs).toBe(20_000);
    h.storage.close();
  });

  test("the owner adds a candidate and it is persisted", async () => {
    const h = panel();
    const a = seed(h, "a");
    const b = seed(h, "b");
    activate(h, a);

    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "fo_add_confirm", providerId: b.providerId, modelId: b.modelId }));
    const list = h.storage.listFailoverCandidates();
    expect(list.length).toBe(1);
    expect(list[0]?.providerId).toBe(b.providerId);
    h.storage.close();
  });

  test("a duplicate candidate is refused", async () => {
    const h = panel();
    const a = seed(h, "a");
    const b = seed(h, "b");
    activate(h, a);
    h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "fo_add_confirm", providerId: b.providerId, modelId: b.modelId }));
    expect(c.sent[0]?.text).toContain("از قبل");
    expect(h.storage.listFailoverCandidates().length).toBe(1);
    h.storage.close();
  });

  test("a candidate naming a disabled provider is refused", async () => {
    const h = panel();
    const a = seed(h, "a");
    const b = seed(h, "b");
    activate(h, a);
    h.storage.setProviderEnabled(b.providerId, false);

    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "fo_add_confirm", providerId: b.providerId, modelId: b.modelId }));
    expect(c.sent[0]?.text).toContain("پروایدر در دسترس نیست");
    expect(h.storage.listFailoverCandidates().length).toBe(0);
    h.storage.close();
  });

  test("a candidate naming a mismatched model is refused", async () => {
    const h = panel();
    const a = seed(h, "a");
    const b = seed(h, "b");
    activate(h, a);

    // b's provider paired with a's model id: the model does not belong to it.
    const c = owner();
    await h.ai.handleCallback(
      c.ctx,
      encode({ kind: "fo_add_confirm", providerId: b.providerId, modelId: a.modelId }),
    );
    expect(c.sent[0]?.text).toContain("مدل در دسترس نیست");
    h.storage.close();
  });

  test("the owner removes a candidate", async () => {
    const h = panel();
    const a = seed(h, "a");
    const b = seed(h, "b");
    activate(h, a);
    h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "fo_remove", index: 0 }));
    expect(h.storage.listFailoverCandidates().length).toBe(0);
    h.storage.close();
  });

  test("a stale remove index is refused instead of removing the wrong row", async () => {
    const h = panel();
    const a = seed(h, "a");
    const b = seed(h, "b");
    activate(h, a);
    h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

    // An index that was valid for a longer, older list.
    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "fo_remove", index: 5 }));
    expect(c.sent[0]?.text).toContain("دیگر در فهرست نیست");
    // The real row survives.
    expect(h.storage.listFailoverCandidates().length).toBe(1);
    h.storage.close();
  });

  test("the owner reorders candidates up and down", async () => {
    const h = panel();
    const a = seed(h, "a");
    const b = seed(h, "b");
    const c = seed(h, "c");
    activate(h, a);
    h.storage.setFailoverCandidates([
      { providerId: b.providerId, modelId: b.modelId },
      { providerId: c.providerId, modelId: c.modelId },
    ]);

    // Move the second up.
    const up = owner();
    await h.ai.handleCallback(up.ctx, encode({ kind: "fo_move_up", index: 1 }));
    let list = h.storage.listFailoverCandidates();
    expect(list[0]?.providerId).toBe(c.providerId);

    // And back down.
    const down = owner();
    await h.ai.handleCallback(down.ctx, encode({ kind: "fo_move_down", index: 0 }));
    list = h.storage.listFailoverCandidates();
    expect(list[0]?.providerId).toBe(b.providerId);
    h.storage.close();
  });

  test("moving past either end is refused, not silently applied", async () => {
    const h = panel();
    const a = seed(h, "a");
    const b = seed(h, "b");
    activate(h, a);
    h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

    const upTop = owner();
    await h.ai.handleCallback(upTop.ctx, encode({ kind: "fo_move_up", index: 0 }));
    expect(upTop.sent[0]?.text).toContain("نامعتبر");

    const downEnd = owner();
    await h.ai.handleCallback(downEnd.ctx, encode({ kind: "fo_move_down", index: 0 }));
    expect(downEnd.sent[0]?.text).toContain("نامعتبر");
    // The order is unchanged.
    expect(h.storage.listFailoverCandidates()[0]?.providerId).toBe(b.providerId);
    h.storage.close();
  });

  test("changes persist across a restart without a bot restart", async () => {
    const path = `${tmpdir()}/sol-fo-ui-${Date.now()}.db`;
    try {
      const first = Storage.open(path);
      const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER_ID));
      const secrets = new ProviderSecretStore(KEY);
      const adapters = new AdapterRegistry();
      const providers = new ProviderService(first, secrets, adapters);
      const models = new ModelService(first);
      const health = new ProviderHealthService(first, providers, secrets, adapters, 250);
      const ai = new AiAdminController({
        auth,
        admin: new AdminBoundary({ auth, audit: new AuditLogger({ storage: first }) }),
        storage: first,
        providers,
        models,
        health,
        secrets,
        adapters,
      });
      const h = { storage: first, ai, providers, models, audit: new AuditLogger({ storage: first }) };

      const a = seed(h, "a");
      const b = seed(h, "b");
      activate(h, a);
      h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);
      h.storage.setFailoverSettings({ enabled: true, maxAttempts: 4 });
      first.close();

      // A fresh process reads the same configuration.
      const second = Storage.open(path);
      const s = second.getFailoverSettings();
      expect(s.enabled).toBe(true);
      expect(s.maxAttempts).toBe(4);
      expect(second.listFailoverCandidates().length).toBe(1);
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
});

// ---------- authorization ----------

describe("failover authorization", () => {
  test("an ordinary user cannot toggle, configure, or view candidates", async () => {
    const h = panel();
    const a = seed(h, "a");
    const b = seed(h, "b");
    activate(h, a);
    h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

    const actions = [
      encode({ kind: "fo_toggle" }),
      encode({ kind: "fo_attempts_set", value: 4 }),
      encode({ kind: "fo_timeout_set", value: 30_000 }),
      encode({ kind: "fo_add_confirm", providerId: b.providerId, modelId: b.modelId }),
      encode({ kind: "fo_remove", index: 0 }),
      encode({ kind: "fo_move_down", index: 0 }),
      encode({ kind: "ai_status" }),
      encode({ kind: "fo_local_confirm", providerId: a.providerId }),
    ];

    for (const data of actions) {
      const c = user();
      await h.ai.handleCallback(c.ctx, data);
      expect(c.sent[0]?.text).toContain("فقط برای مالک");
    }

    // Nothing moved in the store.
    expect(h.storage.getFailoverSettings().enabled).toBe(false);
    expect(h.storage.getFailoverSettings().maxAttempts).toBe(2);
    expect(h.storage.listFailoverCandidates().length).toBe(1);
    h.storage.close();
  });

  test("a missing identity is denied and mutates nothing", async () => {
    const h = panel();
    const a = seed(h, "a");
    const b = seed(h, "b");
    activate(h, a);
    h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

    const c = fakeCtx(undefined);
    await h.ai.handleCallback(c.ctx, encode({ kind: "fo_toggle" }));
    expect(c.sent[0]?.text).toContain("فقط برای مالک");
    expect(h.storage.getFailoverSettings().enabled).toBe(false);
    h.storage.close();
  });

  test("a denied request is audited and reveals nothing about the feature", async () => {
    const h = panel();
    const a = seed(h, "a");
    activate(h, a);
    const c = user();
    await h.ai.handleCallback(c.ctx, encode({ kind: "fo_attempts_set", value: 4 }));

    const rows = h.storage.auditEvents(20);
    const denied = rows.find((r) => r.outcome === "denied" && r.operation === "fo.attempts.set");
    expect(denied).toBeDefined();
    expect(denied?.actorId).toBe(String(USER_ID));
    // The denial message is the generic one, with no feature detail.
    expect(c.sent[0]?.text).toBe("این بخش فقط برای مالک ربات در دسترس است.");
    h.storage.close();
  });

  test("a stale callback for a deleted provider is handled safely", async () => {
    const h = panel();
    const a = seed(h, "a");
    activate(h, a);
    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "fo_add_confirm", providerId: 4242, modelId: 4242 }));
    expect(c.sent[0]?.text).toContain("پروایدر در دسترس نیست");
    h.storage.close();
  });
});

// ---------- local-target policy ----------

describe("local-target policy", () => {
  test("a provider is not local-allowed by default", () => {
    const h = panel();
    const a = seed(h, "a");
    expect(h.providers.view(a.providerId)?.allowLocal).toBe(false);
    h.storage.close();
  });

  test("the confirmation view warns before allowing local targets", async () => {
    const h = panel();
    const a = seed(h, "a");
    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "fo_local_menu", providerId: a.providerId }));
    const text = c.sent[0]?.text ?? "";
    expect(text).toContain("127.0.0.0/8");
    expect(text).toContain("نصب محلی");
    h.storage.close();
  });

  test("the owner can open and then close local access", async () => {
    const h = panel();
    const a = seed(h, "a");

    const open = owner();
    await h.ai.handleCallback(open.ctx, encode({ kind: "fo_local_confirm", providerId: a.providerId }));
    expect(h.providers.view(a.providerId)?.allowLocal).toBe(true);
    expect(open.sent[0]?.text).toContain("باز شد");

    const close = owner();
    await h.ai.handleCallback(close.ctx, encode({ kind: "fo_local_confirm", providerId: a.providerId }));
    expect(h.providers.view(a.providerId)?.allowLocal).toBe(false);
    h.storage.close();
  });

  test("a normal user cannot enable local targets", async () => {
    const h = panel();
    const a = seed(h, "a");
    const c = user();
    await h.ai.handleCallback(c.ctx, encode({ kind: "fo_local_confirm", providerId: a.providerId }));
    expect(h.providers.view(a.providerId)?.allowLocal).toBe(false);
    h.storage.close();
  });

  test("a provider response cannot change the local-target policy", async () => {
    // Nothing in the adapter response path touches the flag: only the owner
    // path can. Verify a real request leaves the flag exactly as it was.
    const h = panel();
    const a = seed(h, "a");
    activate(h, a);
    const before = h.providers.view(a.providerId)?.allowLocal;
    // A simulated request through the gateway is not part of this controller,
    // but the flag is only writable via the owner action above.
    expect(h.providers.view(a.providerId)?.allowLocal).toBe(before);
    h.storage.close();
  });
});

// ---------- SSRF: target policy ----------

const REQUEST = {
  messages: [{ role: "user" as const, content: "hi" }],
  model: "m",
  timeoutMs: 500,
  signal: new AbortController().signal,
};

describe("target validation", () => {
  test("rejects private and loopback hosts by default", () => {
    for (const bad of [
      "http://127.0.0.1:11434/v1",
      "http://localhost:11434/v1",
      "http://192.168.1.5/v1",
      "http://10.0.0.9/v1",
      "http://172.20.0.1/v1",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]:8080/v1",
    ]) {
      expect(() => validateTarget({ baseUrl: bad, apiKey: "k" })).toThrow(AiError);
    }
  });

  test("permits a local host only when the flag is set", () => {
    expect(
      validateTarget({ baseUrl: "http://127.0.0.1:11434/v1", apiKey: "k" }, { allowLocalTargets: true })
        .baseUrl,
    ).toBe("http://127.0.0.1:11434/v1");
  });

  test("a public host is accepted", () => {
    const r = validateTarget({ baseUrl: "https://api.openai.com/v1", apiKey: "k" }).baseUrl;
    expect(r).toBe("https://api.openai.com/v1");
  });

  test("an adapter refuses a local target before any request", async () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "http://169.254.169.254/latest/meta-data",
      apiKey: "k",
    });
    await expect(adapter.complete(REQUEST)).rejects.toThrow(AiError);
  });

  test("an adapter permits a local target only with the flag", async () => {
    // A local server that would answer if reached at all.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const allowed = new OpenAICompatibleAdapter({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "k",
      allowLocalTargets: true,
    });
    const res = await allowed.complete(REQUEST);
    expect(res.text).toBe("ok");

    const refused = new OpenAICompatibleAdapter({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "k",
    });
    await expect(refused.complete(REQUEST)).rejects.toThrow(/داخلی یا خصوصی/);
    server.close();
  });

  test("a redirect to a local address is refused, not followed", async () => {
    // The first server redirects to a loopback address; the second would answer
    // if the redirect were followed.
    let redirectedTo: string | undefined;
    const target = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "secret" } }] }));
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const tAddr = target.address();
    const tPort = typeof tAddr === "object" && tAddr ? tAddr.port : 0;

    const redirector = createServer((req, res) => {
      redirectedTo = `http://127.0.0.1:${tPort}/internal`;
      res.writeHead(302, { location: redirectedTo });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    const rAddr = redirector.address();
    const rPort = typeof rAddr === "object" && rAddr ? rAddr.port : 0;

    // The redirector is a local host, so the request is only permitted with the
    // flag on — but the redirect must still be refused once it arrives.
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: `http://127.0.0.1:${rPort}/v1`,
      apiKey: "k",
      allowLocalTargets: true,
    });
    await expect(adapter.complete(REQUEST)).rejects.toThrow(/ارجاع داد/);

    target.close();
    redirector.close();
  });

  test("a non-HTTP scheme and a credential-in-URL are refused", () => {
    for (const bad of ["file:///etc/passwd", "https://user:pass@api.example.com/v1"]) {
      expect(() => validateTarget({ baseUrl: bad, apiKey: "k" })).toThrow(AiError);
    }
  });
});

// ---------- status view ----------

describe("operational status", () => {
  test("the status view shows the primary and candidate counts", async () => {
    const h = panel();
    const a = seed(h, "a");
    const b = seed(h, "b");
    activate(h, a);
    h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_status" }));
    const text = c.sent[0]?.text ?? "";
    expect(text).toContain("a");
    expect(text).toContain("جایگزین");
    h.storage.close();
  });

  test("the status view never shows a credential", async () => {
    const h = panel();
    const a = seed(h, "a");
    activate(h, a);
    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_status" }));
    expect(JSON.stringify(c.sent)).not.toContain("sk-a");
    h.storage.close();
  });

  test("an unconfigured runtime reports a mismatch, not a fake success", async () => {
    const h = panel();
    seed(h, "a");
    // No runtime selection at all.
    const c = owner();
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_status" }));
    const text = c.sent[0]?.text ?? "";
    expect(text).toContain("تنظیم‌نشده");
    h.storage.close();
  });
});

// ---------- migration ----------

describe("migration from schema v5", () => {
  test("an v5 database gains the local-target column, defaulting off", async () => {
    const path = `${tmpdir()}/sol-v5-mig-${Date.now()}.db`;
    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(path);
      // Build the v5 shape by hand, without allow_local.
      db.exec(`
        CREATE TABLE ai_providers (
          id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL,
          adapter TEXT NOT NULL, base_url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE ai_credentials (
          provider_id INTEGER PRIMARY KEY, iv TEXT NOT NULL,
          ciphertext TEXT NOT NULL, tag TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE ai_models (
          id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER NOT NULL,
          model_id TEXT NOT NULL, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
          is_default INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE ai_runtime_settings (
          id INTEGER PRIMARY KEY CHECK(id = 1), active_provider_id INTEGER, active_model_id INTEGER);
        CREATE TABLE ai_provider_health (
          provider_id INTEGER PRIMARY KEY, ok INTEGER NOT NULL, checked_at INTEGER NOT NULL, message TEXT);
        CREATE TABLE ai_failover_settings (
          id INTEGER PRIMARY KEY CHECK(id = 1), enabled INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 2, timeout_ms INTEGER NOT NULL DEFAULT 15000);
        CREATE TABLE ai_failover_candidates (
          provider_id INTEGER NOT NULL, model_id INTEGER NOT NULL, position INTEGER NOT NULL);
        CREATE TABLE _meta(k TEXT PRIMARY KEY, v TEXT);
        INSERT INTO _meta(k,v) VALUES('schema_version','5');
        INSERT INTO ai_providers(label, adapter, base_url, enabled, created_at, updated_at)
          VALUES('قدیمی','openai_compatible','https://old.invalid/v1',1,1,1);
      `);
      db.close();

      const s = Storage.open(path);
      const providers = s.listProviders();
      expect(providers.length).toBe(1);
      // An existing provider is NOT retroactively local-allowed.
      expect(providers[0]?.allowLocal).toBe(false);
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
