/**
 * Mini App router + providers/models API.
 *
 * Uses the REAL ProviderService / ModelService / Storage (in-memory SQLite)
 * so validation, masking, and two-step flows are exercised end to end; only
 * the live probe is faked (no network in tests).
 */
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMiniAppHandler, type MiniAppDeps } from "../src/miniapp/api";
import { Storage } from "../src/storage/storage";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import type { ProbeResult } from "../src/ai/health";

const BOT_TOKEN = "fixed-test-bot-token-123";
const OWNER_ID = "777000";

function signInitData(fields: Record<string, string>): string {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const dataCheckString = pairs.join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN, "utf8").digest();
  const hash = createHmac("sha256", secret).update(dataCheckString, "utf8").digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

function initData(userId = OWNER_ID): string {
  return signInitData({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: Number(userId) }),
  });
}

function makeWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "miniapp-web-"));
  mkdirSync(join(dir, "static"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<html><body>miniapp</body></html>");
  writeFileSync(join(dir, "static", "app.js"), "console.log(1);");
  return dir;
}

interface CapturedTurn {
  conversationId: string;
  userId: string;
  userText: string;
  actor: unknown;
}

function makeDeps(): { deps: MiniAppDeps; turns: CapturedTurn[] } {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore("test-master-key");
  const adapters = new AdapterRegistry();
  const providerSvc = new ProviderService(storage, secrets, adapters);
  const modelSvc = new ModelService(storage);
  const health = {
    probe: async (id: number): Promise<ProbeResult> => {
      // Mirrors the real ProviderHealthService: the outcome is recorded via
      // storage so providers.list shows it in lastProbe.
      const result: ProbeResult = {
        ok: true,
        message: "اتصال برقرار بود.",
        checkedAt: Date.now(),
      };
      storage.setProviderHealth(
        result.message !== undefined
          ? { providerId: id, ok: result.ok, message: result.message }
          : { providerId: id, ok: result.ok },
      );
      return result;
    },
    probeModel: async (_id: number, _modelId: string): Promise<ProbeResult> => {
      // Mirrors the real ProviderHealthService.probeModel: a model test is
      // NOT recorded to provider health, so no storage write happens here.
      return { ok: true, checkedAt: Date.now() };
    },
  };
  const turns: CapturedTurn[] = [];
  const actor = { kind: "owner-test-actor" };
  const deps: MiniAppDeps = {
    storage,
    providerSvc,
    modelSvc,
    health,
    engineFactory: () => ({
      respond: async (a: {
        conversationId: string;
        userId: string;
        userText: string;
        actor: unknown;
      }) => {
        turns.push({
          conversationId: a.conversationId,
          userId: a.userId,
          userText: a.userText,
          actor: a.actor,
        });
        return { chunks: ["chunk1", "chunk2"] };
      },
    }),
    actorForOwner: () => actor,
    ownerId: OWNER_ID,
    botToken: BOT_TOKEN,
    webDir: makeWebDir(),
  };
  return { deps, turns };
}

function apiReq(action: string, body: Record<string, unknown>, headers?: Record<string, string>) {
  return new Request(`http://localhost/miniapp/api/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
}

async function apiJson(
  handler: (req: Request) => Promise<Response | undefined> | undefined,
  action: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handler(apiReq(action, body, headers));
  if (!res) throw new Error(`no response for ${action}`);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------- routing ----

describe("miniapp router", () => {
  test("returns undefined for non-/miniapp paths", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    expect(handler(new Request("http://localhost/health"))).toBeUndefined();
    expect(handler(new Request("http://localhost/api/v1/turn", { method: "POST" }))).toBeUndefined();
    expect(handler(new Request("http://localhost/miniapp-other"))).toBeUndefined();
  });

  test("GET /miniapp/ serves index.html", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const res = await handler(new Request("http://localhost/miniapp/"));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toContain("text/html");
    expect(await res?.text()).toContain("miniapp");
  });

  test("GET /miniapp/static/<file> serves with a content type", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const res = await handler(new Request("http://localhost/miniapp/static/app.js"));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toContain("javascript");
    const missing = await handler(new Request("http://localhost/miniapp/static/nope.js"));
    expect(missing?.status).toBe(404);
  });

  test("unknown /miniapp subpaths answer a bare 404", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    // The handler answers unknown /miniapp/* paths itself (bare 404, same as
    // the main server's) so its return type stays Response — it only returns
    // undefined for non-/miniapp paths.
    const res = await handler(new Request("http://localhost/miniapp/does-not-exist.xyz"));
    expect(res?.status).toBe(404);
    const res2 = handler(new Request("http://localhost/other"));
    expect(res2).toBeUndefined();
  });
});

// ------------------------------------------------------------------ auth ----

describe("miniapp api auth", () => {
  test("a missing initData is a generic 401", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const { status, json } = await apiJson(handler, "turn", { text: "hi" });
    expect(status).toBe(401);
    expect(typeof json["error"]).toBe("string");
  });

  test("a bad signature is a generic 401 that hides the reason", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const { status, json } = await apiJson(handler, "turn", {
      initData: "auth_date=1&hash=nope",
      text: "hi",
    });
    expect(status).toBe(401);
    expect(json["error"]).toBe("احراز هویت نامعتبر است.");
  });

  test("a non-owner initData is rejected with the same generic 401", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const { status, json } = await apiJson(handler, "turn", {
      initData: initData("999111"),
      text: "hi",
    });
    expect(status).toBe(401);
    expect(json["error"]).toBe("احراز هویت نامعتبر است.");
  });

  test("initData is accepted from the header when the body omits it", async () => {
    const { deps, turns } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const { status } = await apiJson(
      handler,
      "turn",
      { text: "hi" },
      { "x-telegram-init-data": initData() },
    );
    expect(status).toBe(200);
    expect(turns.length).toBe(1);
  });

  test("rate limiting fires before auth", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const { status } = await apiJson(handler, "turn", { text: "hi" });
      last = status;
    }
    expect(last).toBe(429);
  });
});

// ------------------------------------------------------------------- turn ----

describe("miniapp turn", () => {
  test("runs the engine as the owner with the default conversation", async () => {
    const { deps, turns } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const { status, json } = await apiJson(handler, "turn", {
      initData: initData(),
      text: "سلام",
    });
    expect(status).toBe(200);
    expect(json["reply"]).toBe("chunk1\n\nchunk2");
    expect(turns[0]?.conversationId).toBe("miniapp");
    expect(turns[0]?.userId).toBe(OWNER_ID);
    expect(turns[0]?.userText).toBe("سلام");
    expect(turns[0]?.actor).toEqual({ kind: "owner-test-actor" });
  });

  test("a custom conversationId is honored", async () => {
    const { deps, turns } = makeDeps();
    const handler = createMiniAppHandler(deps);
    await apiJson(handler, "turn", {
      initData: initData(),
      conversationId: "chat-tab-1",
      text: "hi",
    });
    expect(turns[0]?.conversationId).toBe("chat-tab-1");
  });

  test("text is required and capped", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const empty = await apiJson(handler, "turn", { initData: initData(), text: " " });
    expect(empty.status).toBe(400);
    const long = await apiJson(handler, "turn", {
      initData: initData(),
      text: "x".repeat(4001),
    });
    expect(long.status).toBe(400);
  });

  test("an oversized body is rejected", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const res = await handler(
      new Request("http://localhost/miniapp/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initData: initData(), text: "x".repeat(70 * 1024) }),
      }),
    );
    expect(res?.status).toBe(413);
  });
});

// -------------------------------------------------------------- providers ----

describe("miniapp providers api", () => {
  test("providers.presets returns the 8 presets plus all adapter templates (incl. native gemini/anthropic)", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const { status, json } = await apiJson(handler, "providers.presets", {
      initData: initData(),
    });
    expect(status).toBe(200);
    const presets = json["presets"] as Record<string, unknown>[];
    expect(presets.length).toBe(8);
    expect(presets.map((p) => p["id"])).toContain("openrouter");
    const templates = json["templates"] as Record<string, unknown>[];
    expect(templates.map((t) => t["type"]).sort()).toEqual([
      "anthropic",
      "gemini",
      "nine_router",
      "openai_compatible",
    ]);
  });

  test("providers.add accepts plain http (self-hosted) but rejects bad schemes", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const ok = await apiJson(handler, "providers.add", {
      initData: initData(),
      kind: "custom",
      label: "Plain",
      baseUrl: "http://api.example.com/v1",
    });
    expect(ok.status).toBe(200);

    const bad = await apiJson(handler, "providers.add", {
      initData: initData(),
      kind: "custom",
      label: "Ftp",
      baseUrl: "ftp://api.example.com/v1",
    });
    expect(bad.status).toBe(400);
    expect(typeof bad.json["error"]).toBe("string");
  });

  test("providers.add rejects an SSRF target (private IP)", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    for (const baseUrl of [
      "https://169.254.169.254/v1",
      "https://127.0.0.1:8443/v1",
      "https://10.0.0.5/v1",
    ]) {
      const { status, json } = await apiJson(handler, "providers.add", {
        initData: initData(),
        kind: "custom",
        label: `SSRF ${baseUrl}`,
        baseUrl,
      });
      expect(status).toBe(400);
      expect(typeof json["error"]).toBe("string");
    }
  });

  test("providers.add rejects a URL carrying credentials", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const { status } = await apiJson(handler, "providers.add", {
      initData: initData(),
      kind: "custom",
      label: "Cred",
      baseUrl: "https://user:pass@api.example.com/v1",
    });
    expect(status).toBe(400);
  });

  test("providers.add creates a provider and never returns the key", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const key = "sk-live-secret-key-abcdef1234";
    const added = await apiJson(handler, "providers.add", {
      initData: initData(),
      kind: "custom",
      label: "MyProv",
      baseUrl: "https://api.example.com/v1",
      key,
      model: "gpt-x",
    });
    expect(added.status).toBe(200);
    const id = added.json["id"] as number;
    expect(id).toBeGreaterThan(0);

    const listed = await apiJson(handler, "providers.list", { initData: initData() });
    const providers = listed.json["providers"] as Record<string, unknown>[];
    const view = providers.find((p) => p["id"] === id);
    expect(view?.["label"]).toBe("MyProv");
    expect(view?.["adapterType"]).toBe("openai_compatible");
    expect(view?.["keyPresent"]).toBe(true);
    expect(view?.["keyHint"]).toBe("••••1234");
    expect(JSON.stringify(listed.json)).not.toContain(key);

    const models = await apiJson(handler, "models.list", {
      initData: initData(),
      providerId: id,
    });
    const rows = models.json["models"] as Record<string, unknown>[];
    expect(rows.map((m) => m["modelId"])).toContain("gpt-x");
  });

  test("providers.add refuses a duplicate label", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const body = {
      initData: initData(),
      kind: "custom",
      label: "Dup",
      baseUrl: "https://api.example.com/v1",
    };
    expect((await apiJson(handler, "providers.add", body)).status).toBe(200);
    const second = await apiJson(handler, "providers.add", body);
    expect(second.status).toBe(400);
    expect(String(second.json["error"])).toContain("already registered");
  });

  test("providers.add preset rejects the cloudflare placeholder URL", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const { status, json } = await apiJson(handler, "providers.add", {
      initData: initData(),
      kind: "preset",
      preset: "cloudflare",
    });
    expect(status).toBe(400);
    expect(String(json["error"])).toContain("ACCOUNT_ID");
  });

  test("providers.delete is two-step", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const added = await apiJson(handler, "providers.add", {
      initData: initData(),
      kind: "custom",
      label: "Gone",
      baseUrl: "https://api.example.com/v1",
    });
    const id = added.json["id"] as number;
    const first = await apiJson(handler, "providers.delete", {
      initData: initData(),
      id,
    });
    expect(first.json["needsConfirm"]).toBe(true);
    const second = await apiJson(handler, "providers.delete", {
      initData: initData(),
      id,
      confirm: true,
    });
    expect(second.json["ok"]).toBe(true);
    const listed = await apiJson(handler, "providers.list", { initData: initData() });
    const providers = listed.json["providers"] as Record<string, unknown>[];
    expect(providers.some((p) => p["id"] === id)).toBe(false);
  });

  test("providers.probe reuses the health probe and reports latency", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const added = await apiJson(handler, "providers.add", {
      initData: initData(),
      kind: "custom",
      label: "ProbeMe",
      baseUrl: "https://api.example.com/v1",
      key: "sk-x",
    });
    const { status, json } = await apiJson(handler, "providers.probe", {
      initData: initData(),
      id: added.json["id"],
    });
    expect(status).toBe(200);
    expect(json["ok"]).toBe(true);
    expect(typeof json["latencyMs"]).toBe("number");
    expect(typeof json["message"]).toBe("string");

    // The probe persisted: providers.list shows the lastProbe view.
    const listed = await apiJson(handler, "providers.list", { initData: initData() });
    const providers = listed.json["providers"] as Record<string, unknown>[];
    const view = providers.find((p) => p["id"] === added.json["id"]);
    const lastProbe = view?.["lastProbe"] as Record<string, unknown>;
    expect(lastProbe["ok"]).toBe(true);
  });

  test("providers.setKey / clearKey are write-only and two-step", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const added = await apiJson(handler, "providers.add", {
      initData: initData(),
      kind: "custom",
      label: "Keyed",
      baseUrl: "https://api.example.com/v1",
    });
    const id = added.json["id"] as number;
    const secret = "sk-brand-new-secret-zz99";
    const set = await apiJson(handler, "providers.setKey", {
      initData: initData(),
      id,
      key: secret,
    });
    expect(set.json["ok"]).toBe(true);
    const listed = await apiJson(handler, "providers.list", { initData: initData() });
    const providers = listed.json["providers"] as Record<string, unknown>[];
    const view = providers.find((p) => p["id"] === id);
    expect(view?.["keyPresent"]).toBe(true);
    expect(view?.["keyHint"]).toBe("••••zz99");
    expect(JSON.stringify(listed.json)).not.toContain(secret);

    const first = await apiJson(handler, "providers.clearKey", {
      initData: initData(),
      id,
    });
    expect(first.json["needsConfirm"]).toBe(true);
    const second = await apiJson(handler, "providers.clearKey", {
      initData: initData(),
      id,
      confirm: true,
    });
    expect(second.json["ok"]).toBe(true);
  });

  test("nine_router add requires key and model", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const missing = await apiJson(handler, "providers.add", {
      initData: initData(),
      kind: "nine_router",
      label: "Nine",
      baseUrl: "https://nine.example.com/v1",
    });
    expect(missing.status).toBe(400);
    const ok = await apiJson(handler, "providers.add", {
      initData: initData(),
      kind: "nine_router",
      label: "Nine",
      baseUrl: "https://nine.example.com/v1",
      key: "nine-key",
      model: "nine-model",
    });
    expect(ok.status).toBe(200);
    const listed = await apiJson(handler, "providers.list", { initData: initData() });
    const providers = listed.json["providers"] as Record<string, unknown>[];
    const view = providers.find((p) => p["id"] === ok.json["id"]);
    expect(view?.["adapterType"]).toBe("nine_router");
  });
});

// ----------------------------------------------------------------- models ----

describe("miniapp models api", () => {
  test("models.add / list / toggle / delete / setActive", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const added = await apiJson(handler, "providers.add", {
      initData: initData(),
      kind: "custom",
      label: "Models",
      baseUrl: "https://api.example.com/v1",
      key: "sk-x",
    });
    const providerId = added.json["id"] as number;

    const m1 = await apiJson(handler, "models.add", {
      initData: initData(),
      providerId,
      modelId: "model-a",
      label: "A",
    });
    const m2 = await apiJson(handler, "models.add", {
      initData: initData(),
      providerId,
      modelId: "model-b",
    });
    expect(m1.status).toBe(200);
    expect(m2.status).toBe(200);
    // A duplicate model id is refused.
    const dup = await apiJson(handler, "models.add", {
      initData: initData(),
      providerId,
      modelId: "model-a",
    });
    expect(dup.status).toBe(400);

    const list = await apiJson(handler, "models.list", {
      initData: initData(),
      providerId,
    });
    const rows = list.json["models"] as Record<string, unknown>[];
    expect(rows.length).toBe(2);

    const active = await apiJson(handler, "models.setActive", {
      initData: initData(),
      id: m1.json["id"],
    });
    expect(active.json["ok"]).toBe(true);

    // Disabling the active model is refused by the service.
    const toggleActive = await apiJson(handler, "models.toggle", {
      initData: initData(),
      id: m1.json["id"],
      enabled: false,
    });
    expect(toggleActive.status).toBe(400);

    // Delete is two-step.
    const del1 = await apiJson(handler, "models.delete", {
      initData: initData(),
      id: m2.json["id"],
    });
    expect(del1.json["needsConfirm"]).toBe(true);
    const del2 = await apiJson(handler, "models.delete", {
      initData: initData(),
      id: m2.json["id"],
      confirm: true,
    });
    expect(del2.json["ok"]).toBe(true);

    // The provider can be activated (has credential + enabled model).
    const setActive = await apiJson(handler, "providers.setActive", {
      initData: initData(),
      id: providerId,
    });
    expect(setActive.json["ok"]).toBe(true);
    expect(setActive.json["modelId"]).toBe(m1.json["id"]);
  });

  test("models.discover reports a clear error for adapters without listModels", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const added = await apiJson(handler, "providers.add", {
      initData: initData(),
      kind: "nine_router",
      label: "NineD",
      baseUrl: "https://nine.example.com/v1",
      key: "nine-key",
      model: "nine-model",
    });
    const { status, json } = await apiJson(handler, "models.discover", {
      initData: initData(),
      providerId: added.json["id"],
    });
    expect(status).toBe(400);
    expect(String(json["error"])).toContain("cannot list models");
  });

  test("models.import skips duplicates and counts imports", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const added = await apiJson(handler, "providers.add", {
      initData: initData(),
      kind: "custom",
      label: "Import",
      baseUrl: "https://api.example.com/v1",
    });
    const providerId = added.json["id"] as number;
    await apiJson(handler, "models.add", {
      initData: initData(),
      providerId,
      modelId: "existing",
    });
    const res = await apiJson(handler, "models.import", {
      initData: initData(),
      providerId,
      modelIds: ["existing", "new-one", "new-two"],
    });
    expect(res.json["imported"]).toBe(2);
    expect(res.json["skipped"]).toBe(1);
  });

  test("unknown actions are a 404 with the generic shape", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    const { status, json } = await apiJson(handler, "providers.nope", {
      initData: initData(),
    });
    expect(status).toBe(404);
    expect(typeof json["error"]).toBe("string");
  });

  test("models.discoverDraft lists models from a preset key without saving", async () => {
    const { deps } = makeDeps();
    deps.adapters = {
      describes: () => ({
        label: "x",
        listModels: true,
        audioInput: false,
        documentInput: false,
        embeddings: false,
      }),
      create: () => ({
        listModels: async () => [
          { id: "gpt-4o-mini", label: "GPT-4o mini" },
          { id: "gpt-4o" },
        ],
      }),
    } as unknown as AdapterRegistry;
    const handler = createMiniAppHandler(deps);
    const { status, json } = await apiJson(handler, "models.discoverDraft", {
      initData: initData(),
      kind: "preset",
      preset: "openrouter",
      key: "sk-draft",
    });
    expect(status).toBe(200);
    const models = json["models"] as { modelId: string; label: string }[];
    expect(models.map((m) => m.modelId).sort()).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(models.find((m) => m.modelId === "gpt-4o-mini")?.label).toBe("GPT-4o mini");
    // Nothing was saved: the provider list is still empty.
    const list = await apiJson(handler, "providers.list", { initData: initData() });
    expect((list.json["providers"] as unknown[]).length).toBe(0);
  });

  test("models.discoverDraft works for custom base URLs and validates input", async () => {
    const { deps } = makeDeps();
    deps.adapters = {
      describes: () => ({
        label: "x",
        listModels: true,
        audioInput: false,
        documentInput: false,
        embeddings: false,
      }),
      create: () => ({ listModels: async () => [{ id: "m1" }] }),
    } as unknown as AdapterRegistry;
    const handler = createMiniAppHandler(deps);

    const ok = await apiJson(handler, "models.discoverDraft", {
      initData: initData(),
      kind: "custom",
      baseUrl: "https://api.example.com/v1",
      key: "sk-draft",
    });
    expect(ok.status).toBe(200);

    const noKey = await apiJson(handler, "models.discoverDraft", {
      initData: initData(),
      kind: "custom",
      baseUrl: "https://api.example.com/v1",
    });
    expect(noKey.status).toBe(400);

    const badUrl = await apiJson(handler, "models.discoverDraft", {
      initData: initData(),
      kind: "custom",
      baseUrl: "ftp://example.com/v1",
      key: "sk-draft",
    });
    expect(badUrl.status).toBe(400);

    const badPreset = await apiJson(handler, "models.discoverDraft", {
      initData: initData(),
      kind: "preset",
      preset: "nope-not-a-preset",
      key: "sk-draft",
    });
    expect(badPreset.status).toBe(400);

    const badKind = await apiJson(handler, "models.discoverDraft", {
      initData: initData(),
      kind: "nine_router",
      key: "sk-draft",
    });
    expect(badKind.status).toBe(400);
  });

  test("plain http base URLs are accepted but private hosts are rejected", async () => {
    const { deps } = makeDeps();
    const handler = createMiniAppHandler(deps);
    // Self-hosted router on a public IP over http (no public CA for bare IPs).
    const ok = await apiJson(handler, "providers.add", {
      initData: initData(),
      kind: "nine_router",
      label: "NineHttp",
      baseUrl: "http://45.32.171.49:20128/v1",
      key: "nine-key",
      model: "nine-model",
    });
    expect(ok.status).toBe(200);

    const privateHost = await apiJson(handler, "providers.add", {
      initData: initData(),
      kind: "custom",
      label: "Local",
      baseUrl: "http://127.0.0.1:8080/v1",
      key: "k",
    });
    expect(privateHost.status).toBe(400);

    const badScheme = await apiJson(handler, "providers.add", {
      initData: initData(),
      kind: "custom",
      label: "Ftp",
      baseUrl: "ftp://example.com/v1",
      key: "k",
    });
    expect(badScheme.status).toBe(400);
  });
});
