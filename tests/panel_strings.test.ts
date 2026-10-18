/**
 * Panel UI redesign tests (PANELS chunk).
 *
 * Guards the fa/en string pairing, the ban on hardcoded user-facing Persian in
 * the panel sources, and the new interaction behavior: two-tap destructive
 * confirmations, back-navigation to the originating screen, explicit cancel on
 * free-text forms with junk re-prompting, a real probe-all, and edit-in-place
 * rendering.
 *
 * No network, no Telegram.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { SearchProviderSecretStore } from "../src/search/secret_store";
import { SearchSettingsService } from "../src/search/service";
import { encode, decode } from "../src/groups/callbacks";
import { PANEL_STRINGS, tr, formatNum } from "../src/groups/panel_strings";
import {
  failoverText,
  modelsKeyboard,
  statusKeyboard,
} from "../src/groups/ai_panel";

const OWNER_ID = 111111;

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

/** A fake callback-query ctx: panel clicks must EDIT, not stack replies. */
function fakeCallbackCtx(from: { id: number }) {
  const sent: Array<{ text: string; keyboard?: unknown }> = [];
  const edits: Array<{ text: string; keyboard?: unknown }> = [];
  let answered = 0;
  const ctx = {
    get from() {
      return from;
    },
    callbackQuery: { id: "cbq-1", data: "adm:ai", message: { message_id: 7 } },
    reply: async (text: string, other?: { reply_markup?: unknown }) => {
      sent.push({ text, keyboard: other?.reply_markup });
    },
    editMessageText: async (text: string, other?: { reply_markup?: unknown }) => {
      edits.push({ text, keyboard: other?.reply_markup });
    },
    answerCallbackQuery: async () => {
      answered++;
    },
  };
  return {
    sent,
    edits,
    answered: () => answered,
    ctx: ctx as unknown as Parameters<AiAdminController["handleCallback"]>[0],
  };
}

interface Harness {
  storage: Storage;
  ai: AiAdminController;
  providers: ProviderService;
  models: ModelService;
  search: SearchSettingsService;
}

function harness(): Harness {
  const storage = Storage.open(":memory:");
  const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER_ID));
  const audit = new AuditLogger({ storage });
  const secrets = new ProviderSecretStore("phase9-test-key");
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const health = new ProviderHealthService(storage, providers, secrets, adapters, 300);
  const searchSecrets = new SearchProviderSecretStore("search-test-master-key");
  const search = new SearchSettingsService(storage, searchSecrets);
  const ai = new AiAdminController({
    auth,
    admin: new AdminBoundary({ auth, audit }),
    storage,
    providers,
    models,
    health,
    secrets,
    adapters,
    search,
  });
  return { storage, ai, providers, models, search };
}

/** Create a provider+model and make them the live selection. */
function activeProvider(h: Harness): { providerId: number; modelId: number } {
  const p = h.providers.create({
    label: "پروایدر اصلی",
    adapter: "openai_compatible",
    baseUrl: "https://api.invalid.example/v1",
apiKey: "test-key-1"
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

// ---------------------------------------------------------------- pairing ---

describe("panel string pairing", () => {
  test("every key ships a non-empty fa and en string", () => {
    const keys = Object.keys(PANEL_STRINGS);
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) {
      const pack = PANEL_STRINGS[key]!;
      expect(typeof pack.fa, key).toBe("string");
      expect(typeof pack.en, key).toBe("string");
      expect(pack.fa.length, `${key}.fa`).toBeGreaterThan(0);
      expect(pack.en.length, `${key}.en`).toBeGreaterThan(0);
    }
  });

  test("fa and en agree on every {placeholder}", () => {
    const vars = (s: string): string[] =>
      [...s.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map((m) => m[1] ?? "").sort();
    for (const [key, pack] of Object.entries(PANEL_STRINGS)) {
      expect(vars(pack.en), `${key}: en placeholders`).toEqual(vars(pack.fa));
    }
  });

  test("tr substitutes vars and falls back to fa", () => {
    expect(tr("fa", "panel.provider.deleted")).toBe("پروایدر حذف شد.");
    expect(tr("en", "panel.provider.deleted")).toBe("Provider deleted.");
    expect(tr("fa", "panel.provider.confirm_delete_q", { label: "X", n: "۱" })).toContain("«X»");
    expect(tr("fa", "panel.nope.missing")).toBe("panel.nope.missing");
  });

  test("digit locale: Persian digits in fa, Latin in en", () => {
    expect(formatNum(1234567, "fa")).toBe("۱٬۲۳۴٬۵۶۷");
    expect(formatNum(1234567, "en")).toBe("1,234,567");
    expect(formatNum(0, "fa")).toBe("۰");
  });
});

describe("no hardcoded user-facing Persian in panel sources", () => {
  // Input-contract keys: the form prompts ask the owner to type these exact
  // labels, so the parsers must match them. They are not user-facing output.
  const PARSE_KEY_ALLOWLIST = new Set([
    "نام نمایشی",
    "آدرس سرویس",
    "کلید api",
    "نوع اتصال",
    "شناسهٔ مدل",
  ]);

  const OWNED = [
    "src/groups/panel.ts",
    "src/groups/controller.ts",
    "src/groups/ai_panel.ts",
    "src/groups/ai_controller.ts",
    "src/groups/callbacks.ts",
    "src/auth/user_panel.ts",
    "src/auth/user_controller.ts",
    "src/search/panel.ts",
  ];

  const PERSIAN = /[̀-ۿﭐ-﷿ﹰ-﻿]/u;

  test("string literals carry no Persian outside panel_strings.ts", () => {
    const root = join(__dirname, "..");
    const offenders: string[] = [];
    for (const rel of OWNED) {
      const src = readFileSync(join(root, rel), "utf8");
      const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
      const noComments = noBlockComments.replace(/(^|\s)\/\/.*$/gm, "$1");
      const literals = noComments.match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/g) ?? [];
      for (const lit of literals) {
        const body = lit
          .slice(1, -1)
          .replace(/\$\{[^}]*\}/g, "")
          .replace(/\\u\{?[0-9a-fA-F]+\}?/g, "");
        if (PERSIAN.test(body) && !PARSE_KEY_ALLOWLIST.has(body)) {
          offenders.push(`${rel}: ${lit.slice(0, 60)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ------------------------------------------------- two-tap confirmations ---

describe("destructive confirmations are two-tap", () => {
  test("deleting a provider asks first, then deletes", async () => {
    const h = harness();
    const active = activeProvider(h);
    // A second, non-active provider so deletion can succeed.
    const p2 = h.providers.create({
      label: "P2",
      adapter: "openai_compatible",
      baseUrl: "https://b.invalid/v1",
apiKey: "test-key-1"
    });
    if (!p2.ok) throw new Error("p2 failed");

    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_delete", providerId: p2.data }));
    // First tap: confirmation, no deletion.
    expect(h.storage.getProvider(p2.data)).toBeDefined();
    expect(lastText(c)).toContain("حذف پروایدر");
    expect(lastText(c)).toContain("P2");

    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_delete_confirm", providerId: p2.data }));
    expect(h.storage.getProvider(p2.data)).toBeUndefined();
    expect(lastText(c)).toContain("پروایدر حذف شد.");
    void active;
    h.storage.close();
  });

  test("deleting a model asks first, then deletes", async () => {
    const h = harness();
    const active = activeProvider(h);
    const m2 = h.models.add({ providerId: active.providerId, modelId: "m2", label: "مدل دو" });
    if (!m2.ok) throw new Error("m2 failed");

    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_model_delete", modelId: m2.data }));
    expect(h.models.get(m2.data)).toBeDefined();
    expect(lastText(c)).toContain("حذف مدل");
    expect(lastText(c)).toContain("مدل دو");

    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_model_delete_confirm", modelId: m2.data }));
    expect(h.models.get(m2.data)).toBeUndefined();
    expect(lastText(c)).toContain("مدل حذف شد.");
    h.storage.close();
  });

  test("clearing a provider key asks first, then clears", async () => {
    const h = harness();
    const active = activeProvider(h);
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_clear_key", providerId: active.providerId }));
    expect(h.providers.credentialStatus(active.providerId)).toBe("set");
    expect(lastText(c)).toContain("پاک کردن کلید");

    await h.ai.handleCallback(
      c.ctx,
      encode({ kind: "ai_clear_key_confirm", providerId: active.providerId }),
    );
    expect(h.providers.credentialStatus(active.providerId)).toBe("unset");
    expect(lastText(c)).toContain("کلید پاک شد.");
    h.storage.close();
  });

  test("clearing the search key asks first, then clears", async () => {
    const h = harness();
    expect(h.search.select("tavily").ok).toBe(true);
    expect(h.search.setKey("tvly-test-key").ok).toBe(true);

    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "search_clear_key" }));
    expect(h.search.view().hasKey).toBe(true);
    expect(lastText(c)).toContain("حذف کلید جستجو");

    await h.ai.handleCallback(c.ctx, encode({ kind: "search_clear_key_confirm" }));
    expect(h.search.view().hasKey).toBe(false);
    expect(lastText(c)).toContain("حذف شد");
    h.storage.close();
  });

  test("new confirm callbacks round-trip through the codec", () => {
    for (const action of [
      { kind: "ai_delete_confirm", providerId: 7 },
      { kind: "ai_model_delete_confirm", modelId: 9 },
      { kind: "ai_clear_key_confirm", providerId: 3 },
      { kind: "search_clear_key_confirm" },
      { kind: "ai_form_cancel" },
      { kind: "ai_probe_all" },
    ] as const) {
      const data = encode(action);
      expect(data.length).toBeLessThanOrEqual(64);
      expect(decode(data)).toEqual(action);
    }
    // Forged payloads still decode to nothing.
    expect(decode("adm:aixc:0")).toBeUndefined();
    expect(decode("adm:aixc:-5")).toBeUndefined();
    expect(decode("adm:aixc:1:2")).toBeUndefined();
    expect(decode("adm:seckc:x")).toBeUndefined();
  });
});

// ------------------------------------------------------- back navigation ---

describe("set operations return to the screen they came from", () => {
  test("fo_attempts_set returns to the failover menu", async () => {
    const h = harness();
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "fo_attempts_set", value: 3 }));
    expect(lastText(c)).toContain("جایگزین خودکار (Failover)");
    expect(lastText(c)).toContain("حداکثر تلاش ۳ شد.");
    h.storage.close();
  });

  test("fo_timeout_set returns to the failover menu", async () => {
    const h = harness();
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "fo_timeout_set", value: 10000 }));
    expect(lastText(c)).toContain("جایگزین خودکار (Failover)");
    h.storage.close();
  });

  test("ai_toggle returns to the provider screen", async () => {
    const h = harness();
    const active = activeProvider(h);
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_toggle", providerId: active.providerId }));
    // The active provider cannot be disabled: the refusal lands on its screen.
    expect(lastText(c)).toContain("پروایدر: پروایدر اصلی");
    h.storage.close();
  });

  test("ai_select_model returns to the selection screen", async () => {
    const h = harness();
    const active = activeProvider(h);
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_select_model", modelId: active.modelId }));
    expect(lastText(c)).toContain("انتخاب پروایدر و مدل فعال");
    expect(lastText(c)).toContain("مدل فعال اکنون");
    h.storage.close();
  });

  test("fo_local_confirm returns to the provider screen", async () => {
    const h = harness();
    const active = activeProvider(h);
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "fo_local_confirm", providerId: active.providerId }));
    expect(lastText(c)).toContain("پروایدر: پروایدر اصلی");
    expect(lastText(c)).toContain("دسترسی محلی برای این پروایدر باز شد.");
    h.storage.close();
  });

  test("ai_test result lands on the provider screen", async () => {
    const h = harness();
    const active = activeProvider(h);
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_test", providerId: active.providerId }));
    expect(lastText(c)).toContain("پروایدر: پروایدر اصلی");
    expect(lastText(c)).toMatch(/تست اتصال (موفق|ناموفق) بود/);
    h.storage.close();
  });

  test("«افزودن مدل» sits above «بازگشت» in the models keyboard", () => {
    const kb = modelsKeyboard([], 5);
    const rows = kb.inline_keyboard.map((r) => r.map((b) => b.text).join("|"));
    const addIdx = rows.findIndex((r) => r.includes("افزودن مدل"));
    const backIdx = rows.findIndex((r) => r.includes("بازگشت"));
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(backIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeLessThan(backIdx);
  });
});

// ------------------------------------------- forms: cancel and re-prompt ---

describe("free-text forms: explicit cancel, junk re-prompts", () => {
  test("لغو clears the pending flow and returns to the adapter picker", async () => {
    const h = harness();
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_add_adapter", adapter: "openai_compatible" }));
    expect(lastText(c)).toContain("افزودن پروایدر");
    // The form now carries an explicit cancel button.
    const kb = c.sent[c.sent.length - 1]?.keyboard as { inline_keyboard: Array<Array<{ text: string }>> };
    expect(kb.inline_keyboard.flat().map((b) => b.text)).toContain("لغو");

    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_form_cancel" }));
    expect(lastText(c)).toContain("نوع اتصال پروایدر را انتخاب کن");
    // The flow is dead: a later message is not consumed as a provider.
    const consumed = await h.ai.handleText(c.ctx, "نام نمایشی: X\nآدرس سرویس: https://x\nکلید API: y");
    expect(consumed).toBe(false);
    h.storage.close();
  });

  test("junk input re-prompts instead of cancelling the add-provider flow", async () => {
    const h = harness();
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_add_adapter", adapter: "openai_compatible" }));

    const junk = await h.ai.handleText(c.ctx, "یه چیز نامرتبط");
    expect(junk).toBe(true);
    expect(lastText(c)).toContain("ورودی کامل نیست");

    // The flow is still alive: a good submission completes it.
    const ok = await h.ai.handleText(
      c.ctx,
      "نام نمایشی: تست\nآدرس سرویس: https://api.invalid.example/v1\nکلید API: k",
    );
    expect(ok).toBe(true);
    expect(lastText(c)).toContain("پروایدر اضافه شد.");
    h.storage.close();
  });

  test("junk input re-prompts the model-add flow, then succeeds", async () => {
    const h = harness();
    const active = activeProvider(h);
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_model_add_form", providerId: active.providerId }));
    expect(lastText(c)).toContain("شناسهٔ مدل");

    const junk = await h.ai.handleText(c.ctx, "فقط یه خط");
    expect(junk).toBe(true);
    expect(lastText(c)).toContain("ورودی کامل نیست");

    const ok = await h.ai.handleText(c.ctx, "gpt-x\nمدل ایکس");
    expect(ok).toBe(true);
    expect(lastText(c)).toContain("مدل «مدل ایکس» اضافه شد.");
    h.storage.close();
  });

  test("empty edit input re-prompts instead of silently succeeding", async () => {
    const h = harness();
    const active = activeProvider(h);
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_edit", providerId: active.providerId }));

    const junk = await h.ai.handleText(c.ctx, "سلام");
    expect(junk).toBe(true);
    expect(lastText(c)).toContain("چیزی برای تغییر پیدا نکردم");
    h.storage.close();
  });
});

// ------------------------------------------------------------ probe-all ---

describe("«تست همهٔ پروایدرها» performs a real probe", () => {
  test("probe-all records a result per provider and reports it", async () => {
    const h = harness();
    const active = activeProvider(h);
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_probe_all" }));
    const text = lastText(c);
    expect(text).toContain("تست همهٔ پروایدرها انجام شد.");
    expect(text).toContain("پروایدر اصلی");
    // The probe recorded its outcome, like the single-provider probe does.
    const view = h.providers.view(active.providerId);
    expect(view?.lastTestOk).toBeDefined();
    h.storage.close();
  });

  test("the status button now encodes the probe-all action", () => {
    const kb = statusKeyboard();
    const data = (
      kb.inline_keyboard.flat().find((b) => b.text.includes("تست همه")) as
        | { callback_data?: string }
        | undefined
    )?.callback_data;
    expect(data).toBeDefined();
    expect(decode(data!)).toEqual({ kind: "ai_probe_all" });
  });
});

// ---------------------------------------------------------- edit in place ---

describe("panel button clicks edit the message in place", () => {
  test("a callback click edits instead of replying", async () => {
    const h = harness();
    const c = fakeCallbackCtx({ id: OWNER_ID });
    await h.ai.handleCallback(c.ctx, encode({ kind: "ai_menu" }));
    expect(c.edits.length).toBe(1);
    expect(c.sent.length).toBe(0);
    expect(c.edits[0]!.text).toContain("مدیریت هوش مصنوعی");
    h.storage.close();
  });

  test("a /ai command still opens with a new message", async () => {
    const h = harness();
    const c = fakeCtx({ id: OWNER_ID });
    await h.ai.open(c.ctx);
    expect(c.sent.length).toBe(1);
    h.storage.close();
  });
});

// ------------------------------------------------------------------ copy ---

describe("panel copy", () => {
  test("failover is consistently «جایگزین خودکار»", () => {
    const text = failoverText({
      enabled: false,
      maxAttempts: 2,
      timeoutMs: 15000,
      primaryLabel: undefined,
      primaryModelLabel: undefined,
      rows: [],
    });
    expect(text).toContain("جایگزین خودکار (Failover)");
    expect(text).not.toContain("مطالبه");
    expect(tr("fa", "panel.ai.menu.failover")).toBe("جایگزین خودکار (Failover)");
  });

  test("menu openers are contextual, not the same generic line", () => {
    expect(tr("fa", "panel.menu.hint")).not.toBe("یک گزینه را انتخاب کنید:");
    expect(tr("fa", "panel.ai.menu_hint")).not.toBe("یک گزینه را انتخاب کنید:");
    expect(tr("fa", "panel.menu.hint")).not.toBe(tr("fa", "panel.ai.menu_hint"));
  });
});
