import { InlineKeyboard, type Context } from "grammy";
import { t, type Lang } from "../i18n";
import { LANG_PREF_KEY } from "../i18n";
import { isProviderPreset, providerPreset, PROVIDER_PRESETS } from "../ai/adapter";
import { setupPrompt, parseSetupReply, type SetupResult } from "../ai/setup";
import type { ProbeResult } from "../ai/health";
import {
  BUILT_IN_PERSONALITIES,
  personalityNames,
  getPersonality,
  resolvePersonalityName,
} from "../personality/personalities";
import { PERSONALITY_PREF_KEY, type UserPrefStore } from "./bot";
import { buildMainMenu, editMenuMessage } from "./menu";
import { formatCount } from "./ux";

/**
 * Onboarding wizard — the 4-step /start flow for a fresh owner.
 *
 * The audit's biggest drop-off: the bot ships on FakeProvider with no in-chat
 * path to fix it. A fresh owner opens the bot, sees menus, but never connects
 * a real AI provider — so the bot can never actually think. This wizard is
 * that path: intro → connect provider (embedded one-message setup + live
 * hello-test) → personality/language → three tappable starter prompts that
 * actually run.
 *
 * STATE: the wizard step is persisted per user in `user_prefs` (SQLite), so a
 * restart mid-wizard resumes where the owner left off. Three keys:
 *   onboarding.step   — one of the OnboardingStep names
 *   onboarding.preset  — preset id awaiting its key (provider_key sub-state)
 *   onboarding.done    — "1" once the wizard completed
 *   onboarding.last_provider — provider id whose live test failed (retry)
 *
 * Callback protocol (namespace "onb:"):
 *   onb:step:intro|provider|profile|demos — jump to a main step
 *   onb:preset:<presetId>  — pick a service (validated against presets)
 *   onb:lang:fa|en         — switch wizard language immediately
 *   onb:pers:<name>        — pick a personality skin (validated)
 *   onb:demo:0|1|2         — run a starter prompt as a real agent turn
 *   onb:retest             — retry the failed live test
 *   onb:skip | onb:back | onb:cancel | onb:restart | onb:finish
 *
 * SECURITY notes (callback forgery, non-owner access):
 * - parseOnboardingCallback is strict: the step must be one of the four main
 *   steps, the preset must be a shipped preset id, lang is exactly fa|en, the
 *   personality name must resolve to a built-in skin, the demo index is one
 *   digit 0-2. Anything else is rejected and safely ignored (the query is
 *   still answered so Telegram stops the spinner).
 * - The wizard is OWNER-ONLY: provider keys are involved, so every entry
 *   point re-checks ownership server-side (env.isOwner, computed from
 *   isOwnerSender in bot.ts). A forged onb: callback from a non-owner is
 *   ignored — hiding buttons is not the security boundary.
 * - Key entry itself (provider_key free text) is consumed only from the
 *   owner, and the write runs inside the AdminBoundary (PERM_MANAGE) in
 *   AiAdminController.wizardSetupPreset. The key is never echoed back.
 */

// ------------------------------------------------------------ protocol ----

/** Callback-data namespace for the wizard. Stable, machine-readable. */
export const ONBOARDING_CALLBACK_PREFIX = "onb:";

/** user_prefs keys holding the wizard state. */
export const ONBOARDING_STEP_KEY = "onboarding.step";
export const ONBOARDING_PRESET_KEY = "onboarding.preset";
export const ONBOARDING_DONE_KEY = "onboarding.done";
export const ONBOARDING_LAST_PROVIDER_KEY = "onboarding.last_provider";

/** Deep-link argument for /start that (re)starts the wizard explicitly. */
export const ONBOARDING_START_ARG = "onboarding";

export type OnboardingStep =
  | "intro"
  | "provider"
  | "provider_key"
  | "profile"
  | "demos"
  | "done";

/** The four numbered steps, in order. provider_key is a sub-state of step 2. */
const MAIN_STEPS: readonly ["intro", "provider", "profile", "demos"] = [
  "intro",
  "provider",
  "profile",
  "demos",
];

export type OnboardingAction =
  | { kind: "step"; step: "intro" | "provider" | "profile" | "demos" }
  | { kind: "preset"; presetId: string }
  | { kind: "lang"; value: Lang }
  | { kind: "pers"; name: string }
  | { kind: "demo"; index: number }
  | { kind: "retest" }
  | { kind: "skip" }
  | { kind: "back" }
  | { kind: "cancel" }
  | { kind: "restart" }
  | { kind: "finish" };

const STEP_SET: ReadonlySet<string> = new Set(MAIN_STEPS);
const DEMO_INDEX_RE = /^[012]$/;

/**
 * Strictly parse wizard callback data. Returns undefined for anything that is
 * not exactly one of the server-generated shapes — forged, truncated, or
 * mistyped payloads are rejected, never executed. Pure, for tests.
 */
export function parseOnboardingCallback(data: string): OnboardingAction | undefined {
  if (!data.startsWith(ONBOARDING_CALLBACK_PREFIX)) return undefined;
  const rest = data.slice(ONBOARDING_CALLBACK_PREFIX.length);
  if (rest === "skip") return { kind: "skip" };
  if (rest === "back") return { kind: "back" };
  if (rest === "cancel") return { kind: "cancel" };
  if (rest === "restart") return { kind: "restart" };
  if (rest === "finish") return { kind: "finish" };
  if (rest === "retest") return { kind: "retest" };
  const parts = rest.split(":");
  if (parts.length !== 2) return undefined;
  const [head, value] = parts as [string, string];
  if (head === "step") {
    if (!STEP_SET.has(value)) return undefined;
    return { kind: "step", step: value as "intro" | "provider" | "profile" | "demos" };
  }
  if (head === "preset") {
    // Must be a shipped preset — an unknown id is forgery, not a typo.
    if (!isProviderPreset(value)) return undefined;
    return { kind: "preset", presetId: value };
  }
  if (head === "lang") {
    if (value !== "fa" && value !== "en") return undefined;
    return { kind: "lang", value };
  }
  if (head === "pers") {
    // Must resolve to a built-in skin; raw names are never stored.
    const name = resolvePersonalityName(value);
    if (name === undefined) return undefined;
    return { kind: "pers", name };
  }
  if (head === "demo") {
    if (!DEMO_INDEX_RE.test(value)) return undefined;
    return { kind: "demo", index: Number(value) };
  }
  return undefined;
}

// --------------------------------------------------------------- state ----

/** Read the persisted wizard step. Junk reads as "no step". Pure, for tests. */
export function readOnboardingStep(
  get: (key: string) => string | undefined,
): OnboardingStep | undefined {
  const raw = get(ONBOARDING_STEP_KEY);
  switch (raw) {
    case "intro":
    case "provider":
    case "provider_key":
    case "profile":
    case "demos":
    case "done":
      return raw;
    default:
      return undefined;
  }
}

/** True when the owner completed the wizard. Pure, for tests. */
export function readOnboardingDone(get: (key: string) => string | undefined): boolean {
  return get(ONBOARDING_DONE_KEY) === "1";
}

/** The step after `step` (skip/continue semantics). Pure, for tests. */
export function nextWizardStep(step: OnboardingStep): OnboardingStep {
  switch (step) {
    case "intro":
      return "provider";
    case "provider":
    case "provider_key":
      return "profile";
    case "profile":
      return "demos";
    case "demos":
    case "done":
      return "done";
  }
}

/** The step before `step` (back-button semantics). Pure, for tests. */
export function prevWizardStep(step: OnboardingStep): OnboardingStep {
  switch (step) {
    case "intro":
      return "intro";
    case "provider":
    case "provider_key":
      return "intro";
    case "profile":
      return "provider";
    case "demos":
    case "done":
      return "profile";
  }
}

/** 1-based number of the main step a (sub-)step belongs to. Pure, for tests. */
export function wizardStepNumber(step: OnboardingStep): number {
  switch (step) {
    case "intro":
      return 1;
    case "provider":
    case "provider_key":
      return 2;
    case "profile":
      return 3;
    case "demos":
    case "done":
      return 4;
  }
}

export const WIZARD_STEP_COUNT = MAIN_STEPS.length;

// ----------------------------------------------------------------- env ----

/** The owner-only AI seams the wizard needs (AiAdminController). */
export interface WizardAi {
  hasConfiguredProvider(): boolean;
  activeProviderLabel(): string | undefined;
  wizardSetupPreset(
    from: { id?: number | null; username?: string } | undefined,
    presetId: string,
    apiKey: string,
    baseUrlOverride?: string,
  ): Promise<SetupResult>;
  wizardProbeProvider(
    from: { id?: number | null; username?: string } | undefined,
    providerId: number,
  ): Promise<ProbeResult>;
}

export interface OnboardingEnv {
  prefs: UserPrefStore;
  /** Server-side owner check, computed by the caller from ctx. */
  isOwner: boolean;
  /** Owner-only AI seams; undefined when the /ai controller is not wired. */
  ai: WizardAi | undefined;
  /** Run one starter prompt as a real agent turn. */
  runDemo: (ctx: Context, text: string) => Promise<void>;
  /** True when the update arrived in a group/supergroup chat. */
  isGroupChat: boolean;
}

type PrefGet = (userId: string, key: string) => string | undefined;

function prefReader(env: OnboardingEnv, userId: string): (key: string) => string | undefined {
  return (key) => {
    try {
      return env.prefs.getUserPref(userId, key);
    } catch {
      return undefined;
    }
  };
}

function persistStep(prefs: UserPrefStore, userId: string, step: OnboardingStep): void {
  prefs.setUserPref(userId, ONBOARDING_STEP_KEY, step);
}

function clearWizardState(prefs: UserPrefStore, userId: string): void {
  for (const key of [
    ONBOARDING_STEP_KEY,
    ONBOARDING_PRESET_KEY,
    ONBOARDING_DONE_KEY,
    ONBOARDING_LAST_PROVIDER_KEY,
  ]) {
    try {
      prefs.setUserPref(userId, key, "");
    } catch {
      // Best effort: a failed clear just leaves the wizard resumable.
    }
  }
}

async function safeReply(ctx: { reply(text: string): Promise<unknown> }, text: string): Promise<void> {
  try {
    await ctx.reply(text);
  } catch {
    // A user who blocked the bot cannot be told anything; not an error.
  }
}

function progressLine(lang: Lang, step: OnboardingStep): string {
  return t("onb.progress", lang, {
    n: formatCount(wizardStepNumber(step), lang),
    total: formatCount(WIZARD_STEP_COUNT, lang),
  });
}

// -------------------------------------------------------------- renders ----

/** One rendered wizard screen. Pure-ish (reads prefs for the profile marks). */
export interface WizardScreen {
  text: string;
  keyboard: InlineKeyboard;
}

function navRow(kb: InlineKeyboard, lang: Lang, opts: { back?: boolean; skip?: boolean }): InlineKeyboard {
  if (opts.back) kb.text(t("onb.back", lang), `${ONBOARDING_CALLBACK_PREFIX}back`);
  if (opts.skip) kb.text(t("onb.skip", lang), `${ONBOARDING_CALLBACK_PREFIX}skip`);
  kb.text(t("onb.cancel", lang), `${ONBOARDING_CALLBACK_PREFIX}cancel`);
  return kb;
}

export function renderIntro(lang: Lang): WizardScreen {
  const text = [
    progressLine(lang, "intro"),
    "",
    t("onb.intro.title", lang),
    "",
    t("onb.intro.body", lang),
  ].join("\n");
  const keyboard = new InlineKeyboard()
    .text(t("onb.intro.start", lang), `${ONBOARDING_CALLBACK_PREFIX}step:provider`)
    .row()
    .text(t("onb.cancel", lang), `${ONBOARDING_CALLBACK_PREFIX}cancel`);
  return { text, keyboard };
}

export function renderProvider(
  lang: Lang,
  opts: { configuredLabel?: string; notice?: string },
): WizardScreen {
  const lines = [progressLine(lang, "provider"), "", t("onb.provider.title", lang), ""];
  const keyboard = new InlineKeyboard();
  if (opts.configuredLabel !== undefined) {
    lines.push(t("onb.provider.configured", lang, { label: opts.configuredLabel }));
  } else {
    lines.push(t("onb.provider.body", lang), "", t("onb.provider.pick", lang));
    for (const p of PROVIDER_PRESETS) {
      keyboard.text(p.label, `${ONBOARDING_CALLBACK_PREFIX}preset:${p.id}`).row();
    }
  }
  if (opts.notice !== undefined) {
    lines.push("", opts.notice);
    if (opts.configuredLabel === undefined) {
      keyboard.text(t("onb.provider.retry", lang), `${ONBOARDING_CALLBACK_PREFIX}retest`).row();
    }
  }
  if (opts.configuredLabel !== undefined) {
    keyboard
      .text(t("onb.continue", lang), `${ONBOARDING_CALLBACK_PREFIX}step:profile`)
      .row();
  }
  navRow(keyboard, lang, { back: true, skip: opts.configuredLabel === undefined });
  return { text: lines.join("\n"), keyboard };
}

export function renderProviderKey(lang: Lang, presetId: string, isGroupChat: boolean): WizardScreen {
  const preset = providerPreset(presetId);
  const lines = [progressLine(lang, "provider_key"), ""];
  if (preset !== undefined) lines.push(setupPrompt(preset, lang));
  if (isGroupChat) lines.push("", t("onb.group_key_hint", lang));
  const keyboard = new InlineKeyboard();
  navRow(keyboard, lang, { back: true, skip: true });
  return { text: lines.join("\n"), keyboard };
}

/** Setup failed but the key-entry state is intact: retry or pick another service. */
export function renderKeyFailed(lang: Lang, note: string): WizardScreen {
  const text = [progressLine(lang, "provider_key"), "", note, "", t("onb.key.retry_hint", lang)].join("\n");
  const keyboard = new InlineKeyboard();
  navRow(keyboard, lang, { back: true });
  return { text, keyboard };
}

export function renderProfile(lang: Lang, get: (key: string) => string | undefined): WizardScreen {
  const lines = [
    progressLine(lang, "profile"),
    "",
    t("onb.profile.title", lang),
    "",
    t("onb.profile.body", lang),
    "",
    t("onb.profile.pers_label", lang),
  ];
  const current = resolvePersonalityName(get(PERSONALITY_PREF_KEY)) ?? "default";
  const keyboard = new InlineKeyboard();
  for (const name of personalityNames()) {
    const skin = getPersonality(name) ?? BUILT_IN_PERSONALITIES.default!;
    const label = lang === "en" ? skin.labelEn : skin.labelFa;
    const mark = name === current ? " ✅" : "";
    keyboard.text(`${label}${mark}`, `${ONBOARDING_CALLBACK_PREFIX}pers:${name}`).row();
  }
  lines.push("", t("onb.profile.lang_label", lang));
  const curLang = get(LANG_PREF_KEY) === "en" ? "en" : "fa";
  keyboard
    .text(`${t("lang.label.fa", curLang)}${curLang === "fa" ? " ✅" : ""}`, `${ONBOARDING_CALLBACK_PREFIX}lang:fa`)
    .text(`${t("lang.label.en", curLang)}${curLang === "en" ? " ✅" : ""}`, `${ONBOARDING_CALLBACK_PREFIX}lang:en`)
    .row();
  keyboard.text(t("onb.continue", lang), `${ONBOARDING_CALLBACK_PREFIX}step:demos`).row();
  navRow(keyboard, lang, { back: true, skip: true });
  return { text: lines.join("\n"), keyboard };
}

export function renderDemos(lang: Lang): WizardScreen {
  const text = [progressLine(lang, "demos"), "", t("onb.demos.title", lang), "", t("onb.demos.body", lang)].join("\n");
  const keyboard = new InlineKeyboard();
  for (let i = 0; i < 3; i++) {
    keyboard
      .text(t(`onb.demo.l${i}`, lang), `${ONBOARDING_CALLBACK_PREFIX}demo:${i}`)
      .row();
  }
  keyboard.text(t("onb.demos.finish", lang), `${ONBOARDING_CALLBACK_PREFIX}finish`).row();
  navRow(keyboard, lang, { back: true });
  return { text, keyboard };
}

export function renderDone(lang: Lang): WizardScreen {
  const text = [t("onb.done.title", lang), "", t("onb.done.body", lang)].join("\n");
  // The main menu, plus a re-run row — buildMainMenu itself is untouched.
  const keyboard = buildMainMenu(lang)
    .row()
    .text(t("onb.again", lang), `${ONBOARDING_CALLBACK_PREFIX}restart`);
  return { text, keyboard };
}

function renderScreen(
  env: OnboardingEnv,
  step: OnboardingStep,
  lang: Lang,
  userId: string,
  notice?: string,
): WizardScreen {
  const get = prefReader(env, userId);
  switch (step) {
    case "intro":
      return renderIntro(lang);
    case "provider": {
      const opts: { configuredLabel?: string; notice?: string } = {};
      if (env.ai?.hasConfiguredProvider() === true) {
        const label = env.ai.activeProviderLabel();
        if (label !== undefined) opts.configuredLabel = label;
      }
      if (notice !== undefined) opts.notice = notice;
      return renderProvider(lang, opts);
    }
    case "provider_key": {
      const presetId = get(ONBOARDING_PRESET_KEY) ?? "";
      return renderProviderKey(lang, presetId, env.isGroupChat);
    }
    case "profile":
      return renderProfile(lang, get);
    case "demos":
      return renderDemos(lang);
    case "done":
      return renderDone(lang);
  }
}

async function showStep(
  ctx: Context,
  env: OnboardingEnv,
  userId: string,
  step: OnboardingStep,
  lang: Lang,
  notice?: string,
): Promise<void> {
  try {
    persistStep(env.prefs, userId, step);
  } catch {
    // A failed write just means the step won't survive a restart.
  }
  const screen = renderScreen(env, step, lang, userId, notice);
  await editMenuMessage(ctx, screen.text, screen.keyboard);
}

// ---------------------------------------------------------------- entry ----

export interface StartDecision {
  /** True when the wizard took over (the caller must not send /start's reply). */
  handled: boolean;
}

/**
 * /start entry point for the wizard. Returns handled=true when the wizard
 * took over this /start.
 *
 * - Owner-only: a non-owner always gets handled=false (normal /start).
 * - Fresh owner (no provider configured, never completed): starts at intro.
 * - Mid-wizard owner: resumes at the persisted step.
 * - Completed owner whose provider is gone: jumps to the provider step.
 * - Returning owner (done + provider): handled=false (normal intro).
 * - "/start onboarding": explicit re-run from the top, whatever the state.
 *
 * Requires prefs (state) and the AI seams; without them the wizard cannot
 * run, so /start falls through to the normal screen.
 */
export async function maybeStartOnboarding(
  ctx: Context,
  env: OnboardingEnv,
  lang: Lang,
  startArg: string | undefined,
): Promise<StartDecision> {
  if (!env.isOwner || ctx.from === undefined) return { handled: false };
  if (env.ai === undefined) return { handled: false };
  const userId = String(ctx.from.id);
  const get = prefReader(env, userId);

  if (startArg === ONBOARDING_START_ARG) {
    clearWizardState(env.prefs, userId);
    await showStep(ctx, env, userId, "intro", lang);
    return { handled: true };
  }

  const step = readOnboardingStep(get);
  const done = readOnboardingDone(get);
  const hasProvider = env.ai.hasConfiguredProvider();

  if (step !== undefined && step !== "done" && !done) {
    // Mid-wizard: resume where the owner left off.
    await showStep(ctx, env, userId, step, lang);
    return { handled: true };
  }
  if (done && !hasProvider) {
    // Completed before, but the provider is gone — back to the money step.
    await showStep(ctx, env, userId, "provider", lang);
    return { handled: true };
  }
  if (!done && !hasProvider) {
    await showStep(ctx, env, userId, "intro", lang);
    return { handled: true };
  }
  return { handled: false };
}

// -------------------------------------------------------------- callbacks ----

async function handleKeySubmission(
  ctx: Context,
  env: OnboardingEnv,
  userId: string,
  lang: Lang,
  text: string,
): Promise<boolean> {
  const get = prefReader(env, userId);
  if (readOnboardingStep(get) !== "provider_key") return false;
  const presetId = get(ONBOARDING_PRESET_KEY);
  const preset = presetId !== undefined ? providerPreset(presetId) : undefined;
  if (preset === undefined || env.ai === undefined || ctx.from === undefined) {
    // Corrupt state — drop back to the picker rather than trapping the owner.
    await showStep(ctx, env, userId, "provider", lang);
    return true;
  }

  const needsExtra = preset.requiredPlaceholder !== undefined;
  const parsed = parseSetupReply(text, needsExtra);
  if (parsed === undefined) {
    await safeReply(ctx, t("onb.key.junk", lang));
    return true;
  }

  const baseUrl =
    parsed.extra !== undefined && preset.requiredPlaceholder !== undefined
      ? preset.baseUrl.replace(`{${preset.requiredPlaceholder}}`, parsed.extra)
      : undefined;

  let testingId: number | undefined;
  try {
    const sent = await ctx.reply(t("onb.key.testing", lang));
    testingId = sent.message_id;
  } catch {
    // No progress line; the result still lands.
  }
  const finalize = async (screen: WizardScreen): Promise<void> => {
    if (testingId !== undefined && ctx.chat !== undefined) {
      try {
        await ctx.api.editMessageText(ctx.chat.id, testingId, screen.text, {
          reply_markup: screen.keyboard,
        });
        return;
      } catch {
        // Fall through to a fresh reply.
      }
    }
    try {
      await ctx.reply(screen.text, { reply_markup: screen.keyboard });
    } catch {
      // Best effort.
    }
  };

  let result: SetupResult;
  try {
    result = await env.ai.wizardSetupPreset(ctx.from, preset.id, parsed.apiKey, baseUrl);
  } catch {
    result = { ok: false, message: t("onb.key.setup_fail", lang, { msg: "…" }), notes: [] };
  }

  if (!result.ok || result.providerId === undefined) {
    // Stay in provider_key: the owner gets another try, not a dead flow.
    // The key itself is never echoed back.
    const note = t("onb.key.setup_fail", lang, { msg: result.message });
    await finalize(renderKeyFailed(lang, note));
    try {
      persistStep(env.prefs, userId, "provider_key");
    } catch {
      // Best effort.
    }
    return true;
  }

  // The provider exists now — verify with a live hello-test before advancing.
  let probe: ProbeResult;
  try {
    probe = await env.ai.wizardProbeProvider(ctx.from, result.providerId);
  } catch {
    probe = { ok: false, checkedAt: Date.now() };
  }

  try {
    env.prefs.setUserPref(userId, ONBOARDING_PRESET_KEY, "");
  } catch {
    // Best effort.
  }

  if (probe.ok) {
    try {
      env.prefs.setUserPref(userId, ONBOARDING_LAST_PROVIDER_KEY, "");
    } catch {
      // Best effort.
    }
    try {
      persistStep(env.prefs, userId, "profile");
    } catch {
      // Best effort.
    }
    await finalize(renderProfile(lang, get));
    return true;
  }

  // Probe failed: the provider is created, so do NOT ask for the key again
  // (that would mint a duplicate). Stay on the provider step with the
  // failure, offering retry or continue-anyway — the owner decides.
  try {
    env.prefs.setUserPref(userId, ONBOARDING_LAST_PROVIDER_KEY, String(result.providerId));
    persistStep(env.prefs, userId, "provider");
  } catch {
    // Best effort.
  }
  const notice = t("onb.provider.test_fail_note", lang, { msg: probe.message ?? "—" });
  await finalize(renderProvider(lang, { notice }));
  return true;
}

/**
 * Free-text consumption for the wizard's provider-key step. Returns true when
 * the message was consumed (the caller must not pass it to the engine).
 * Owner-only and state-gated: anything but the owner's key-shaped message in
 * the provider_key step falls through.
 */
export async function handleOnboardingText(
  ctx: Context,
  env: OnboardingEnv,
  text: string,
  lang: Lang,
): Promise<boolean> {
  if (!env.isOwner || ctx.from === undefined) return false;
  return handleKeySubmission(ctx, env, String(ctx.from.id), lang, text);
}

/**
 * Wizard callback handler (the onb: namespace). The caller answers the query
 * and re-runs the group/user gates first, mirroring the palette; ownership is
 * re-checked here via env.isOwner, so a forged callback from a non-owner is
 * silently ignored. Payloads are strictly parsed; junk is ignored.
 */
export async function handleOnboardingCallback(
  ctx: Context,
  env: OnboardingEnv,
  data: string,
  lang: Lang,
): Promise<void> {
  if (!env.isOwner || ctx.from === undefined) return;
  const action = parseOnboardingCallback(data);
  if (action === undefined) return;
  const userId = String(ctx.from.id);
  const get = prefReader(env, userId);
  const cur = readOnboardingStep(get) ?? "intro";

  switch (action.kind) {
    case "cancel": {
      clearWizardState(env.prefs, userId);
      await editMenuMessage(ctx, t("onb.cancelled", lang), buildMainMenu(lang));
      return;
    }
    case "restart": {
      clearWizardState(env.prefs, userId);
      await showStep(ctx, env, userId, "intro", lang);
      return;
    }
    case "finish": {
      try {
        env.prefs.setUserPref(userId, ONBOARDING_DONE_KEY, "1");
        persistStep(env.prefs, userId, "done");
      } catch {
        // Best effort.
      }
      const screen = renderDone(lang);
      await editMenuMessage(ctx, screen.text, screen.keyboard);
      return;
    }
    case "skip": {
      const next = nextWizardStep(cur);
      if (next === "done") {
        try {
          env.prefs.setUserPref(userId, ONBOARDING_DONE_KEY, "1");
        } catch {
          // Best effort.
        }
        const screen = renderDone(lang);
        await editMenuMessage(ctx, screen.text, screen.keyboard);
        return;
      }
      await showStep(ctx, env, userId, next, lang);
      return;
    }
    case "back": {
      await showStep(ctx, env, userId, prevWizardStep(cur), lang);
      return;
    }
    case "step": {
      await showStep(ctx, env, userId, action.step, lang);
      return;
    }
    case "preset": {
      try {
        env.prefs.setUserPref(userId, ONBOARDING_PRESET_KEY, action.presetId);
      } catch {
        await safeReply(ctx, t("onb.key.junk", lang));
        return;
      }
      await showStep(ctx, env, userId, "provider_key", lang);
      return;
    }
    case "lang": {
      try {
        env.prefs.setUserPref(userId, LANG_PREF_KEY, action.value);
      } catch {
        // Best effort: still re-render, just in the old language.
        await showStep(ctx, env, userId, cur === "provider_key" ? "provider" : cur, lang);
        return;
      }
      // Re-render the current screen in the NEW language immediately.
      const step = cur === "provider_key" ? "provider_key" : cur;
      await showStep(ctx, env, userId, step, action.value);
      return;
    }
    case "pers": {
      try {
        env.prefs.setUserPref(userId, PERSONALITY_PREF_KEY, action.name);
      } catch {
        // Best effort.
      }
      await showStep(ctx, env, userId, "profile", lang);
      return;
    }
    case "retest": {
      if (env.ai === undefined) return;
      const rawId = get(ONBOARDING_LAST_PROVIDER_KEY);
      const providerId = rawId !== undefined && /^\d{1,10}$/.test(rawId) ? Number(rawId) : undefined;
      if (providerId === undefined) {
        await showStep(ctx, env, userId, "provider", lang);
        return;
      }
      let probe: ProbeResult;
      try {
        probe = await env.ai.wizardProbeProvider(ctx.from, providerId);
      } catch {
        probe = { ok: false, checkedAt: Date.now() };
      }
      if (probe.ok) {
        try {
          env.prefs.setUserPref(userId, ONBOARDING_LAST_PROVIDER_KEY, "");
        } catch {
          // Best effort.
        }
        await showStep(ctx, env, userId, "profile", lang, t("onb.key.ok", lang));
        return;
      }
      const notice = t("onb.provider.test_fail_note", lang, { msg: probe.message ?? "—" });
      await showStep(ctx, env, userId, "provider", lang, notice);
      return;
    }
    case "demo": {
      const prompt = t(`onb.demo.p${action.index}`, lang);
      await env.runDemo(ctx, prompt);
      try {
        env.prefs.setUserPref(userId, ONBOARDING_DONE_KEY, "1");
        persistStep(env.prefs, userId, "done");
      } catch {
        // Best effort.
      }
      const screen = renderDone(lang);
      try {
        await ctx.reply(screen.text, { reply_markup: screen.keyboard });
      } catch {
        // Best effort: the demo turn already answered.
      }
      return;
    }
  }
}
