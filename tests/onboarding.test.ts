/**
 * Tests for the onboarding wizard (src/bot/onboarding.ts).
 *
 * - the onb: callback parser rejects forged/malformed data;
 * - the state machine transitions (next/prev/number), skip/cancel paths;
 * - /start routing: fresh owners get the wizard, returning owners don't,
 *   non-owners never do;
 * - the provider-key step: junk re-prompts, setup failure stays, probe
 *   failure offers retry without minting a duplicate provider;
 * - the provider-detect logic (hasConfiguredProvider) on the real
 *   AiAdminController + in-memory storage;
 * - bilingual demo keys resolve in both languages.
 *
 * No network, no Telegram.
 */
import { describe, expect, test } from "bun:test";
import {
  ONBOARDING_CALLBACK_PREFIX,
  ONBOARDING_STEP_KEY,
  ONBOARDING_PRESET_KEY,
  ONBOARDING_DONE_KEY,
  ONBOARDING_LAST_PROVIDER_KEY,
  parseOnboardingCallback,
  readOnboardingStep,
  readOnboardingDone,
  nextWizardStep,
  prevWizardStep,
  wizardStepNumber,
  WIZARD_STEP_COUNT,
  renderIntro,
  renderProvider,
  renderProviderKey,
  renderProfile,
  renderDemos,
  renderDone,
  maybeStartOnboarding,
  handleOnboardingCallback,
  handleOnboardingText,
  type OnboardingEnv,
  type WizardAi,
  type OnboardingStep,
} from "../src/bot/onboarding";
import { PERSONALITY_PREF_KEY, type UserPrefStore } from "../src/bot/bot";
import { LANG_PREF_KEY, t } from "../src/i18n";
import { Storage } from "../src/storage/storage";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";
import { AdminBoundary } from "../src/auth/admin_boundary";
import { AuditLogger } from "../src/auth/audit";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderService, ModelService } from "../src/ai/provider_service";
import { ProviderHealthService } from "../src/ai/health";
import { AiAdminController } from "../src/groups/ai_controller";
import type { SetupResult } from "../src/ai/setup";
import type { ProbeResult } from "../src/ai/health";

const OWNER = 111_111;
const NON_OWNER = 222_222;

/** In-memory per-user pref store. */
function fakePrefs(initial: Record<string, string> = {}): UserPrefStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  for (const [k, v] of Object.entries(initial)) raw.set(k, v);
  return {
    raw,
    getUserPref: (u, k) => raw.get(`${u}:${k}`),
    setUserPref: (u, k, v) => {
      raw.set(`${u}:${k}`, v);
    },
  };
}

/** Scriptable fake of the owner-only AI seams. */
function fakeAi(over: Partial<WizardAi> = {}): WizardAi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hasConfiguredProvider: () => false,
    activeProviderLabel: () => undefined,
    wizardSetupPreset: async () => {
      calls.push("setup");
      return { ok: true, message: "ok", providerId: 7, modelId: 9, notes: [] } satisfies SetupResult;
    },
    wizardProbeProvider: async () => {
      calls.push("probe");
      return { ok: true, checkedAt: 1 } satisfies ProbeResult;
    },
    ...over,
  };
}

function fakeEnv(
  opts: {
    isOwner?: boolean;
    prefs?: UserPrefStore;
    ai?: WizardAi | undefined;
    runDemo?: (text: string) => void;
    isGroupChat?: boolean;
  } = {},
): { env: OnboardingEnv; prefs: UserPrefStore & { raw: Map<string, string> }; demos: string[] } {
  const prefs = (opts.prefs as UserPrefStore & { raw: Map<string, string> }) ?? fakePrefs();
  const demos: string[] = [];
  const env: OnboardingEnv = {
    prefs,
    isOwner: opts.isOwner ?? true,
    ai: "ai" in opts ? opts.ai : fakeAi(),
    runDemo: async (_ctx, text) => {
      (opts.runDemo ?? ((t: string) => demos.push(t)))(text);
    },
    isGroupChat: opts.isGroupChat ?? false,
  };
  return { env, prefs, demos };
}

/** Fake callback-query context: records replies, edits, and api edits. */
function fakeCbCtx(fromId: number, chatType = "private") {
  const sent: string[] = [];
  const edits: Array<{ text: string; keyboard: unknown }> = [];
  const apiEdits: Array<{ chatId: unknown; messageId: unknown; text: string }> = [];
  let nextId = 100;
  const ctx = {
    from: { id: fromId },
    chat: { id: 999, type: chatType },
    message: undefined,
    callbackQuery: { message: { message_id: 55 } },
    reply: async (text: string, _extra?: unknown) => {
      sent.push(text);
      return { message_id: nextId++ };
    },
    editMessageText: async (text: string, extra?: { reply_markup?: unknown }) => {
      edits.push({ text, keyboard: extra?.reply_markup });
    },
    answerCallbackQuery: async () => {},
    api: {
      editMessageText: async (chatId: unknown, messageId: unknown, text: string, _extra?: unknown) => {
        apiEdits.push({ chatId, messageId, text });
      },
    },
  };
  return { ctx: ctx as never, sent, edits, apiEdits };
}

function prefOf(prefs: { raw: Map<string, string> }, userId: number, key: string): string | undefined {
  return prefs.raw.get(`${userId}:${key}`);
}

// ---------------------------------------------------------------- parser ----

describe("parseOnboardingCallback", () => {
  test("accepts every server-generated shape", () => {
    expect(parseOnboardingCallback("onb:step:intro")).toEqual({ kind: "step", step: "intro" });
    expect(parseOnboardingCallback("onb:step:provider")).toEqual({ kind: "step", step: "provider" });
    expect(parseOnboardingCallback("onb:step:profile")).toEqual({ kind: "step", step: "profile" });
    expect(parseOnboardingCallback("onb:step:demos")).toEqual({ kind: "step", step: "demos" });
    expect(parseOnboardingCallback("onb:preset:openrouter")).toEqual({ kind: "preset", presetId: "openrouter" });
    expect(parseOnboardingCallback("onb:preset:groq")).toEqual({ kind: "preset", presetId: "groq" });
    expect(parseOnboardingCallback("onb:lang:fa")).toEqual({ kind: "lang", value: "en" });
    expect(parseOnboardingCallback("onb:lang:en")).toEqual({ kind: "lang", value: "en" });
    expect(parseOnboardingCallback("onb:pers:concise")).toEqual({ kind: "pers", name: "concise" });
    expect(parseOnboardingCallback("onb:demo:0")).toEqual({ kind: "demo", index: 0 });
    expect(parseOnboardingCallback("onb:demo:2")).toEqual({ kind: "demo", index: 2 });
    for (const k of ["skip", "back", "cancel", "restart", "finish", "retest"] as const) {
      expect(parseOnboardingCallback(`onb:${k}`)).toEqual({ kind: k });
    }
  });

  test("rejects forged and malformed data", () => {
    const forged = [
      "",
      "onb:",
      "onb",
      "pal:cats",
      "menu:chat",
      "onb:step:done", // done is not a navigable step
      "onb:step:provider_key", // sub-state, only via preset pick
      "onb:step:",
      "onb:step:intro:extra",
      "onb:preset:evil-service",
      "onb:preset:",
      "onb:preset:openrouter:x",
      "onb:lang:de",
      "onb:lang:FA",
      "onb:lang:",
      "onb:pers:notaskin",
      "onb:pers:",
      "onb:demo:3",
      "onb:demo:-1",
      "onb:demo:x",
      "onb:demo:10",
      "onb:retest:x",
      "onb:skip:x",
      "onb:DROP TABLE",
      "onb:step:provider\nonb:cancel",
    ];
    for (const d of forged) {
      expect(parseOnboardingCallback(d), d).toBeUndefined();
    }
  });

  test("personality aliases resolve to canonical names", () => {
    // resolvePersonalityName is case-insensitive for known skins.
    expect(parseOnboardingCallback("onb:pers:Concise")).toEqual({ kind: "pers", name: "concise" });
  });
});

// ----------------------------------------------------------------- state ----

describe("wizard state machine", () => {
  test("next/prev walk the four steps; provider_key belongs to step 2", () => {
    expect(nextWizardStep("intro")).toBe("provider");
    expect(nextWizardStep("provider")).toBe("profile");
    expect(nextWizardStep("provider_key")).toBe("profile");
    expect(nextWizardStep("profile")).toBe("demos");
    expect(nextWizardStep("demos")).toBe("done");
    expect(prevWizardStep("provider")).toBe("intro");
    expect(prevWizardStep("provider_key")).toBe("intro");
    expect(prevWizardStep("profile")).toBe("provider");
    expect(prevWizardStep("demos")).toBe("profile");
    expect(prevWizardStep("intro")).toBe("intro");
  });

  test("step numbers map to 4 numbered steps", () => {
    expect(WIZARD_STEP_COUNT).toBe(4);
    expect(wizardStepNumber("intro")).toBe(1);
    expect(wizardStepNumber("provider")).toBe(2);
    expect(wizardStepNumber("provider_key")).toBe(2);
    expect(wizardStepNumber("profile")).toBe(3);
    expect(wizardStepNumber("demos")).toBe(4);
    expect(wizardStepNumber("done")).toBe(4);
  });

  test("readOnboardingStep rejects junk; readOnboardingDone needs exactly \"1\"", () => {
    const get = (m: Record<string, string>) => (k: string) => m[k];
    expect(readOnboardingStep(get({}))).toBeUndefined();
    expect(readOnboardingStep(get({ [ONBOARDING_STEP_KEY]: "provider" }))).toBe("provider");
    expect(readOnboardingStep(get({ [ONBOARDING_STEP_KEY]: "rm -rf" }))).toBeUndefined();
    expect(readOnboardingStep(get({ [ONBOARDING_STEP_KEY]: "done" }))).toBe("done");
    expect(readOnboardingDone(get({}))).toBe(false);
    expect(readOnboardingDone(get({ [ONBOARDING_DONE_KEY]: "1" }))).toBe(true);
    expect(readOnboardingDone(get({ [ONBOARDING_DONE_KEY]: "true" }))).toBe(false);
  });
});

// --------------------------------------------------------------- renders ----

describe("wizard renders", () => {
  test("every screen carries a progress indicator and a cancel button", () => {
    const get = (_k: string) => undefined;
    const screens = [
      renderIntro("en"),
      renderProvider("en", {}),
      renderProviderKey("en", "openrouter", false),
      renderProfile("en", get),
      renderDemos("en"),
    ];
    const bodies = screens.map((s) => s.text);
    expect(bodies[0]).toContain("Step 1 of 4");
    expect(bodies[1]).toContain("Step 2 of 4");
    expect(bodies[2]).toContain("Step 2 of 4");
    expect(bodies[3]).toContain("Step 3 of 4");
    expect(bodies[4]).toContain("Step 4 of 4");
    for (const s of screens) {
      const labels = JSON.stringify(s.keyboard);
      expect(labels).toContain("onb:cancel");
    }
    // English mirrors the structure.
    expect(renderIntro("en").text).toContain("Step 1 of 4");
  });

  test("intro starts the wizard; provider lists presets when unconfigured", () => {
    const intro = renderIntro("en");
    expect(JSON.stringify(intro.keyboard)).toContain("onb:step:provider");
    const provider = renderProvider("en", {});
    const kb = JSON.stringify(provider.keyboard);
    expect(kb).toContain("onb:preset:openrouter");
    expect(kb).toContain("onb:preset:groq");
    expect(kb).toContain("onb:skip");
  });

  test("provider shows a checkmark and continue when already configured", () => {
    const screen = renderProvider("en", { configuredLabel: "OpenRouter" });
    expect(screen.text).toContain("OpenRouter");
    const kb = JSON.stringify(screen.keyboard);
    expect(kb).toContain("onb:step:profile");
    expect(kb).not.toContain("onb:preset:");
  });

  test("demos expose three runnable prompts plus finish", () => {
    const screen = renderDemos("en");
    const kb = JSON.stringify(screen.keyboard);
    expect(kb).toContain("onb:demo:0");
    expect(kb).toContain("onb:demo:1");
    expect(kb).toContain("onb:demo:2");
    expect(kb).toContain("onb:finish");
  });

  test("done screen carries the main menu plus a re-run row", () => {
    const screen = renderDone("en");
    const kb = JSON.stringify(screen.keyboard);
    expect(kb).toContain("menu:chat");
    expect(kb).toContain("onb:restart");
  });

  test("profile marks the current personality and language", () => {
    const get = (k: string) =>
      k === PERSONALITY_PREF_KEY ? "playful" : k === LANG_PREF_KEY ? "en" : undefined;
    const screen = renderProfile("en", get);
    const kb = JSON.stringify(screen.keyboard);
    expect(kb).toContain("onb:pers:playful");
    expect(kb).toContain("✅");
  });

  test("provider_key shows the group hint only in groups", () => {
    expect(renderProviderKey("en", "openrouter", false).text).not.toContain("private chat");
    expect(renderProviderKey("en", "openrouter", true).text).toContain("private chat");
  });

  test("dynamic demo keys resolve in English", () => {
    for (let i = 0; i < 3; i++) {
      const p = t(`onb.demo.p${i}`, "en");
      const l = t(`onb.demo.l${i}`, "en");
      expect(p).not.toBe(`onb.demo.p${i}`);
      expect(l).not.toBe(`onb.demo.l${i}`);
      expect(p.length).toBeGreaterThan(0);
      expect(p).not.toMatch(/[\u0600-\u06FF]/);
    }
  });
});

// ------------------------------------------------------------ /start ----

describe("maybeStartOnboarding", () => {
  test("non-owners never get the wizard", async () => {
    const { env } = fakeEnv({ isOwner: false });
    const { ctx } = fakeCbCtx(NON_OWNER);
    const r = await maybeStartOnboarding(ctx, env, "en", undefined);
    expect(r.handled).toBe(false);
  });

  test("fresh owner starts at the intro and the step persists", async () => {
    const { env, prefs } = fakeEnv();
    const { ctx, edits } = fakeCbCtx(OWNER);
    const r = await maybeStartOnboarding(ctx, env, "en", undefined);
    expect(r.handled).toBe(true);
    expect(prefOf(prefs, OWNER, ONBOARDING_STEP_KEY)).toBe("intro");
    expect(edits[0]!.text).toContain(t("onb.intro.title", "en"));
  });

  test("returning owner (done + provider) keeps the normal /start", async () => {
    const prefs = fakePrefs({ [`${OWNER}:${ONBOARDING_DONE_KEY}`]: "1" });
    const ai = fakeAi({ hasConfiguredProvider: () => true });
    const { env } = fakeEnv({ prefs, ai });
    const { ctx } = fakeCbCtx(OWNER);
    const r = await maybeStartOnboarding(ctx, env, "en", undefined);
    expect(r.handled).toBe(false);
  });

  test("completed owner without a provider jumps to the provider step", async () => {
    const prefs = fakePrefs({ [`${OWNER}:${ONBOARDING_DONE_KEY}`]: "1" });
    const { env } = fakeEnv({ prefs });
    const { ctx, edits } = fakeCbCtx(OWNER);
    const r = await maybeStartOnboarding(ctx, env, "en", undefined);
    expect(r.handled).toBe(true);
    expect(edits[0]!.text).toContain(t("onb.provider.title", "en"));
  });

  test("mid-wizard owner resumes at the persisted step", async () => {
    const prefs = fakePrefs({ [`${OWNER}:${ONBOARDING_STEP_KEY}`]: "profile" });
    const { env } = fakeEnv({ prefs });
    const { ctx, edits } = fakeCbCtx(OWNER);
    const r = await maybeStartOnboarding(ctx, env, "en", undefined);
    expect(r.handled).toBe(true);
    expect(edits[0]!.text).toContain(t("onb.profile.title", "en"));
  });

  test("explicit /start onboarding restarts from the top", async () => {
    const prefs = fakePrefs({
      [`${OWNER}:${ONBOARDING_DONE_KEY}`]: "1",
      [`${OWNER}:${ONBOARDING_STEP_KEY}`]: "done",
    });
    const ai = fakeAi({ hasConfiguredProvider: () => true });
    const { env } = fakeEnv({ prefs, ai });
    const { ctx, edits } = fakeCbCtx(OWNER);
    const r = await maybeStartOnboarding(ctx, env, "en", "onboarding");
    expect(r.handled).toBe(true);
    expect(edits[0]!.text).toContain(t("onb.intro.title", "en"));
    expect(prefOf(prefs, OWNER, ONBOARDING_DONE_KEY)).toBe("");
  });

  test("wizard is unavailable without the AI seams (falls through to /start)", async () => {
    const { env } = fakeEnv({ ai: undefined });
    const { ctx } = fakeCbCtx(OWNER);
    const r = await maybeStartOnboarding(ctx, env, "en", undefined);
    expect(r.handled).toBe(false);
  });
});

// ------------------------------------------------------------- callbacks ----

describe("handleOnboardingCallback", () => {
  test("non-owner callbacks are ignored: no state change, no reply", async () => {
    const { env, prefs } = fakeEnv({ isOwner: false });
    const { ctx, sent, edits } = fakeCbCtx(NON_OWNER);
    await handleOnboardingCallback(ctx, env, "onb:step:provider", "en");
    await handleOnboardingCallback(ctx, env, "onb:preset:openrouter", "en");
    await handleOnboardingCallback(ctx, env, "onb:demo:0", "en");
    expect(sent).toEqual([]);
    expect(edits).toEqual([]);
    expect(prefs.raw.size).toBe(0);
  });

  test("forged callbacks are ignored safely", async () => {
    const { env, prefs } = fakeEnv();
    const { ctx, sent, edits } = fakeCbCtx(OWNER);
    for (const d of [
      "onb:step:done",
      "onb:preset:evil",
      "onb:lang:de",
      "onb:pers:notaskin",
      "onb:demo:9",
      "onb:bogus",
    ]) {
      await handleOnboardingCallback(ctx, env, d, "en");
    }
    expect(sent).toEqual([]);
    expect(edits).toEqual([]);
    expect(prefs.raw.size).toBe(0);
  });

  test("cancel clears the wizard state and shows the main menu", async () => {
    const prefs = fakePrefs({
      [`${OWNER}:${ONBOARDING_STEP_KEY}`]: "profile",
      [`${OWNER}:${ONBOARDING_PRESET_KEY}`]: "groq",
    });
    const { env } = fakeEnv({ prefs });
    const { ctx, edits } = fakeCbCtx(OWNER);
    await handleOnboardingCallback(ctx, env, "onb:cancel", "en");
    expect(prefOf(prefs, OWNER, ONBOARDING_STEP_KEY)).toBe("");
    expect(prefOf(prefs, OWNER, ONBOARDING_PRESET_KEY)).toBe("");
    expect(edits[0]!.text).toContain(t("onb.cancelled", "en"));
    expect(JSON.stringify(edits[0]!.keyboard)).toContain("menu:chat");
  });

  test("skip advances, back retreats", async () => {
    const prefs = fakePrefs({ [`${OWNER}:${ONBOARDING_STEP_KEY}`]: "intro" });
    const { env } = fakeEnv({ prefs });
    const { ctx, edits } = fakeCbCtx(OWNER);
    await handleOnboardingCallback(ctx, env, "onb:skip", "en");
    expect(prefOf(prefs, OWNER, ONBOARDING_STEP_KEY)).toBe("provider");
    await handleOnboardingCallback(ctx, env, "onb:back", "en");
    expect(prefOf(prefs, OWNER, ONBOARDING_STEP_KEY)).toBe("intro");
    expect(edits.length).toBe(2);
  });

  test("skip on the last step finishes the wizard", async () => {
    const prefs = fakePrefs({ [`${OWNER}:${ONBOARDING_STEP_KEY}`]: "demos" });
    const { env } = fakeEnv({ prefs });
    const { ctx, edits } = fakeCbCtx(OWNER);
    await handleOnboardingCallback(ctx, env, "onb:skip", "en");
    expect(prefOf(prefs, OWNER, ONBOARDING_DONE_KEY)).toBe("1");
    expect(edits[0]!.text).toContain(t("onb.done.title", "en"));
  });

  test("personality tap persists the canonical skin name", async () => {
    const { env, prefs } = fakeEnv();
    const { ctx } = fakeCbCtx(OWNER);
    await handleOnboardingCallback(ctx, env, "onb:pers:concise", "en");
    expect(prefOf(prefs, OWNER, PERSONALITY_PREF_KEY)).toBe("concise");
  });

  test("language tap is a harmless no-op: re-renders the current step in English", async () => {
    const prefs = fakePrefs({ [`${OWNER}:${ONBOARDING_STEP_KEY}`]: "profile" });
    const { env } = fakeEnv({ prefs });
    const { ctx, edits } = fakeCbCtx(OWNER);
    // In-flight keyboards from before the English-only switch still carry
    // onb:lang taps; they re-render the step instead of switching language.
    await handleOnboardingCallback(ctx, env, "onb:lang:en", "en");
    expect(prefOf(prefs, OWNER, LANG_PREF_KEY)).toBeUndefined();
    expect(edits[0]!.text).toContain("Step 3 of 4");
  });

  test("preset pick stores the preset and asks for the key", async () => {
    const { env, prefs } = fakeEnv();
    const { ctx, edits } = fakeCbCtx(OWNER);
    await handleOnboardingCallback(ctx, env, "onb:preset:deepseek", "en");
    expect(prefOf(prefs, OWNER, ONBOARDING_PRESET_KEY)).toBe("deepseek");
    expect(prefOf(prefs, OWNER, ONBOARDING_STEP_KEY)).toBe("provider_key");
    expect(edits[0]!.text).toContain("DeepSeek");
  });

  test("demo tap runs the prompt and finishes the wizard", async () => {
    const { env, prefs, demos } = fakeEnv();
    const { ctx, sent } = fakeCbCtx(OWNER);
    await handleOnboardingCallback(ctx, env, "onb:demo:1", "en");
    expect(demos).toEqual([t("onb.demo.p1", "en")]);
    expect(prefOf(prefs, OWNER, ONBOARDING_DONE_KEY)).toBe("1");
    expect(sent.some((s) => s.includes(t("onb.done.title", "en")))).toBe(true);
  });

  test("restart clears progress and shows the intro", async () => {
    const prefs = fakePrefs({
      [`${OWNER}:${ONBOARDING_DONE_KEY}`]: "1",
      [`${OWNER}:${ONBOARDING_STEP_KEY}`]: "done",
    });
    const { env } = fakeEnv({ prefs });
    const { ctx, edits } = fakeCbCtx(OWNER);
    await handleOnboardingCallback(ctx, env, "onb:restart", "en");
    expect(prefOf(prefs, OWNER, ONBOARDING_DONE_KEY)).toBe("");
    expect(prefOf(prefs, OWNER, ONBOARDING_STEP_KEY)).toBe("intro");
    expect(edits[0]!.text).toContain(t("onb.intro.title", "en"));
  });

  test("retest with no pending provider falls back to the provider step", async () => {
    const { env } = fakeEnv();
    const { ctx, edits } = fakeCbCtx(OWNER);
    await handleOnboardingCallback(ctx, env, "onb:retest", "en");
    expect(edits[0]!.text).toContain(t("onb.provider.title", "en"));
  });
});

// ------------------------------------------------------------ key entry ----

describe("handleOnboardingText (provider key)", () => {
  function keyEnv(over: Parameters<typeof fakeEnv>[0] = {}) {
    const prefs = fakePrefs({
      [`${OWNER}:${ONBOARDING_STEP_KEY}`]: "provider_key",
      [`${OWNER}:${ONBOARDING_PRESET_KEY}`]: "openrouter",
    });
    return { ...fakeEnv({ prefs, ...over }), prefs };
  }

  test("ignores non-owners and non-key states", async () => {
    const { env } = keyEnv({ isOwner: false });
    const { ctx } = fakeCbCtx(NON_OWNER);
    expect(await handleOnboardingText(ctx, env, "sk-abc", "en")).toBe(false);

    const idle = fakeEnv();
    const { ctx: ctx2 } = fakeCbCtx(OWNER);
    expect(await handleOnboardingText(ctx2, idle.env, "sk-abc", "en")).toBe(false);
  });

  test("junk input re-prompts without calling setup", async () => {
    const { env, prefs } = keyEnv();
    const ai = env.ai as WizardAi & { calls: string[] };
    const { ctx, sent } = fakeCbCtx(OWNER);
    // Cloudflare-style preset needs "key, ACCOUNT_ID"; use it for the junk case.
    prefs.raw.set(`${OWNER}:${ONBOARDING_PRESET_KEY}`, "cloudflare");
    const consumed = await handleOnboardingText(ctx, env, "just-a-key", "en");
    expect(consumed).toBe(true);
    expect(sent.some((s) => s.includes(t("onb.key.junk", "en")))).toBe(true);
    expect(ai.calls).toEqual([]);
    expect(prefOf(prefs, OWNER, ONBOARDING_STEP_KEY)).toBe("provider_key");
  });

  test("valid key runs setup + live probe and advances to profile", async () => {
    const { env, prefs } = keyEnv();
    const ai = env.ai as WizardAi & { calls: string[] };
    const { ctx, apiEdits } = fakeCbCtx(OWNER);
    const consumed = await handleOnboardingText(ctx, env, "sk-live-key", "en");
    expect(consumed).toBe(true);
    expect(ai.calls).toEqual(["setup", "probe"]);
    expect(prefOf(prefs, OWNER, ONBOARDING_STEP_KEY)).toBe("profile");
    expect(prefOf(prefs, OWNER, ONBOARDING_PRESET_KEY)).toBe("");
    // The progress note was edited into the profile screen.
    expect(apiEdits[0]!.text).toContain(t("onb.profile.title", "en"));
  });

  test("setup failure stays in provider_key without echoing the key", async () => {
    const ai = fakeAi({
      wizardSetupPreset: async () => ({ ok: false, message: "bad key", notes: [] }),
    });
    const { env, prefs } = keyEnv({ ai });
    const { ctx, apiEdits } = fakeCbCtx(OWNER);
    const consumed = await handleOnboardingText(ctx, env, "sk-bad", "en");
    expect(consumed).toBe(true);
    expect(prefOf(prefs, OWNER, ONBOARDING_STEP_KEY)).toBe("provider_key");
    expect(apiEdits[0]!.text).toContain("bad key");
    expect(apiEdits[0]!.text).not.toContain("sk-bad");
  });

  test("probe failure keeps the created provider and offers retry (no duplicate)", async () => {
    const ai = fakeAi({
      wizardProbeProvider: async () => ({ ok: false, checkedAt: 1, message: "timeout" }),
    });
    const { env, prefs } = keyEnv({ ai });
    const { ctx, apiEdits } = fakeCbCtx(OWNER);
    const consumed = await handleOnboardingText(ctx, env, "sk-live-key", "en");
    expect(consumed).toBe(true);
    // Setup ran once; the failure path does not ask for the key again.
    const setupCalls = (ai.calls as string[]).filter((c) => c === "setup");
    expect(setupCalls).toHaveLength(1);
    expect(prefOf(prefs, OWNER, ONBOARDING_STEP_KEY)).toBe("provider");
    expect(prefOf(prefs, OWNER, ONBOARDING_LAST_PROVIDER_KEY)).toBe("7");
    expect(apiEdits[0]!.text).toContain("timeout");
    expect(JSON.stringify(apiEdits[0]).length).toBeGreaterThan(0);
  });

  test("corrupt preset state drops back to the picker instead of trapping", async () => {
    const prefs = fakePrefs({
      [`${OWNER}:${ONBOARDING_STEP_KEY}`]: "provider_key",
      [`${OWNER}:${ONBOARDING_PRESET_KEY}`]: "nope",
    });
    const { env } = fakeEnv({ prefs });
    const { ctx, edits } = fakeCbCtx(OWNER);
    const consumed = await handleOnboardingText(ctx, env, "sk-x", "en");
    expect(consumed).toBe(true);
    expect(prefOf(prefs, OWNER, ONBOARDING_STEP_KEY)).toBe("provider");
    expect(edits[0]!.text).toContain(t("onb.provider.title", "en"));
  });
});

// ------------------------------------------------------ provider detect ----

describe("hasConfiguredProvider (AiAdminController)", () => {
  function harness() {
    const storage = Storage.open(":memory:");
    const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER));
    const audit = new AuditLogger({ storage });
    const secrets = new ProviderSecretStore("onboarding-test-key");
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
    return { storage, providers, models, ai };
  }

  function activate(h: ReturnType<typeof harness>, withKey: boolean): number {
    const p = h.providers.create({
      label: "Test Provider",
      adapter: "openai_compatible",
      baseUrl: "https://api.invalid.example/v1",
      ...(withKey ? { apiKey: "sk-test-key" } : {}),
    });
    if (!p.ok) throw new Error("provider create failed");
    const m = h.models.add({ providerId: p.data, modelId: "m1", label: "M1" });
    if (!m.ok) throw new Error("model add failed");
    h.storage.setRuntimeSelection({ providerId: p.data, modelId: m.data });
    return p.data;
  }

  test("empty storage reads as not configured", () => {
    expect(harness().ai.hasConfiguredProvider()).toBe(false);
  });

  test("active provider with credential and model reads as configured", () => {
    const h = harness();
    activate(h, true);
    expect(h.ai.hasConfiguredProvider()).toBe(true);
    expect(h.ai.activeProviderLabel()).toBe("Test Provider");
  });

  test("provider without a stored key reads as not configured", () => {
    const h = harness();
    activate(h, false);
    expect(h.ai.hasConfiguredProvider()).toBe(false);
  });

  test("disabled provider reads as not configured", () => {
    const h = harness();
    const id = activate(h, true);
    // The service refuses to disable the active provider (correct product
    // behavior); simulate the state through storage instead.
    h.storage.setProviderEnabled(id, false);
    expect(h.ai.hasConfiguredProvider()).toBe(false);
  });

  test("provider with no models reads as not configured", () => {
    const h = harness();
    const p = h.providers.create({
      label: "Key Only",
      adapter: "openai_compatible",
      baseUrl: "https://api.invalid.example/v1",
apiKey: "sk-test-key"
    });
    if (!p.ok) throw new Error("provider create failed");
    h.storage.setRuntimeSelection({ providerId: p.data, modelId: 999 });
    expect(h.ai.hasConfiguredProvider()).toBe(false);
  });
});
