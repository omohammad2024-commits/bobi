import { InlineKeyboard, type Bot, type Context } from "grammy";
import { t, type Lang } from "../i18n";
import {
  COMMAND_HELP,
  isOwnerSender,
  senderLang,
  visibleCommandHelp,
  handleVoiceCommand,
  handleResetCommand,
  handleStopCommand,
  handleLangCommand,
  handlePersonalityCommand,
  handleCompressCommand,
  type BotDeps,
  type CommandHelpEntry,
  type UserPrefStore,
} from "./bot";
import {
  buildMainMenu,
  editMenuMessage,
  helpEntryLine,
  helpGroupTitle,
  startScreenText,
  type HelpGroup,
} from "./menu";
import { sendInteractiveDigest } from "./digest_cmd";
import { buildModelKeyboard, formatCount } from "./ux";
import { splitForTelegram, type ConversationEngine } from "../conversation/engine";
import { estimateCost } from "../ai/usage";
import {
  handleHistoryCommand,
  handleSaveCommand,
  handleRetryCommand,
  handleUndoCommand,
  handleTitleCommand,
  handleBranchCommand,
  handleResumeCommand,
  handleSessionsCommand,
  handleStatusCommand,
  handleContextCommand,
  handleBusyCommand,
  handleWhoamiCommand,
  handleFooterCommand,
  handleVersionCommand,
  handleNewCommand,
} from "./cmd_session";
import {
  handleAgents,
  handleSuggestions,
  senderOf,
  replyLong,
  type AutoDeps,
} from "./cmd_auto";
import {
  handleSnapshot,
  handleRestart,
  handleUsage,
  handleInsights,
  handleModelShow,
  handleReasoningShow,
  handleAutopruneShow,
  parseAutoprune,
  handleTools,
  handleSkills,
  handleCuratorStatus,
  handlePlugins,
  handleReloadMcp,
  handleReloadSkills,
  handleAccessList,
  listPendingAccess,
  handlePause,
  readLogTail,
  buildDebugMarkdown,
  resolveOpts,
  startOfTodayMs,
  isoDay,
  REASONING_PREF_KEY,
  AUTOPRUNE_PREF_KEY,
  type RegisterOpts,
  type ResolvedOpts,
  type UsageTotals,
  type UsageModelRow,
  type InsightDay,
  type DebugInfo,
  type ModelListItem,
  type AccessServices,
} from "./cmd_system";
import type { SysLang } from "./cmd_system_strings";
import type { Storage } from "../storage/storage";

/**
 * The inline command palette: a categorized, paginated command browser.
 *
 * Entry points: the /commands command, the main-menu «commands»/«help»
 * buttons, and /help (which now delegates here). Every screen renders from
 * COMMAND_HELP — the same single grouping source as /help — so the two can
 * never drift apart.
 *
 * Callback protocol (namespace "pal:"):
 *   pal:cats               — category overview
 *   pal:cat:<group>:<page> — one page of a category (8 commands per page)
 *   pal:cmd:<name>         — tap a command: runs it when it is a safe
 *                            no-arg command (PALETTE_DIRECT), otherwise shows
 *                            a usage card with the example
 *
 * SECURITY notes (callback forgery):
 * - parsePaletteCallback is strict: the group must be one of the four known
 *   HelpGroups, the page must be plain digits, and the command name must be
 *   lowercase/underscores AND exist in COMMAND_HELP. Anything else is
 *   rejected and safely ignored (the query is still answered so Telegram
 *   stops the spinner).
 * - Owner-only entries are filtered from every listing for non-owners, and
 *   runPaletteCommand re-checks isOwnerSender server-side before running —
 *   a forged pal:cmd:<owner-only> from a non-owner gets the owner-only
 *   reply, never execution. Hiding buttons is not the security boundary.
 * - No user-controlled text is ever interpolated into callback data or into
 *   i18n templates; all callback payloads are server-generated.
 */

// ------------------------------------------------------------ protocol ----

/** Callback-data namespace for the palette. Stable, machine-readable. */
export const PALETTE_CALLBACK_PREFIX = "pal:";

/** Commands per category page. Telegram keyboards cap out; 8 keeps pages short. */
export const PALETTE_PAGE_SIZE = 8;

/** Groups in display order (same order as /help). */
const PALETTE_GROUPS: readonly HelpGroup[] = [
  "general",
  "session",
  "automation",
  "owner",
];

export type PaletteAction =
  | { kind: "cats" }
  | { kind: "cat"; group: HelpGroup; page: number }
  | { kind: "cmd"; name: string };

const GROUP_SET: ReadonlySet<string> = new Set(PALETTE_GROUPS);
const PAGE_RE = /^\d{1,4}$/;
const NAME_RE = /^[a-z_]{1,32}$/;

/**
 * Strictly parse palette callback data. Returns undefined for anything that
 * is not exactly one of the three server-generated shapes — forged,
 * truncated, or mistyped payloads are rejected, never executed.
 * Pure, for tests.
 */
export function parsePaletteCallback(data: string): PaletteAction | undefined {
  if (!data.startsWith(PALETTE_CALLBACK_PREFIX)) return undefined;
  const rest = data.slice(PALETTE_CALLBACK_PREFIX.length);
  if (rest === "cats") return { kind: "cats" };
  const parts = rest.split(":");
  if (parts[0] === "cat" && parts.length === 3) {
    const group = parts[1] ?? "";
    const pageRaw = parts[2] ?? "";
    if (!GROUP_SET.has(group) || !PAGE_RE.test(pageRaw)) return undefined;
    return { kind: "cat", group: group as HelpGroup, page: Number(pageRaw) };
  }
  if (parts[0] === "cmd" && parts.length === 2) {
    const name = parts[1] ?? "";
    if (!NAME_RE.test(name)) return undefined;
    // The name must be a real command — an unknown name is forgery, not a typo.
    if (!COMMAND_HELP.some((e) => e.name === name)) return undefined;
    return { kind: "cmd", name };
  }
  return undefined;
}

// ---------------------------------------------------------- pagination ----

/**
 * One page of a category. Out-of-range pages return an empty page (the
 * caller ignores them); a category with no visible entries is also empty.
 * Pure, for tests.
 */
export function palettePageEntries(
  entries: readonly CommandHelpEntry[],
  group: HelpGroup,
  page: number,
): { pageEntries: CommandHelpEntry[]; totalPages: number; total: number } {
  const inGroup = entries.filter((e) => e.group === group);
  const totalPages = Math.max(1, Math.ceil(inGroup.length / PALETTE_PAGE_SIZE));
  if (page < 0 || page >= totalPages) {
    return { pageEntries: [], totalPages, total: inGroup.length };
  }
  return {
    pageEntries: inGroup.slice(
      page * PALETTE_PAGE_SIZE,
      (page + 1) * PALETTE_PAGE_SIZE,
    ),
    totalPages,
    total: inGroup.length,
  };
}

/** Visible entry counts per group (owner-filtered upstream). Pure, for tests. */
export function paletteGroupCounts(
  entries: readonly CommandHelpEntry[],
): Record<HelpGroup, number> {
  const counts: Record<HelpGroup, number> = {
    general: 0,
    session: 0,
    automation: 0,
    owner: 0,
  };
  for (const e of entries) counts[e.group] += 1;
  return counts;
}

// ------------------------------------------------------------ rendering ----

/** One-line description for an entry, in the user's language. */
function describeEntry(entry: CommandHelpEntry, lang: Lang): string {
  return t(`help.cmd.${entry.name}`, lang);
}

/** Category overview text. Pure, for tests. */
export function paletteCategoriesText(lang: Lang = "fa"): string {
  return [t("pal.title", lang), "", t("pal.subtitle", lang)].join("\n");
}

/** Category overview keyboard: one button per group with its command count. Pure, for tests. */
export function buildCategoriesKeyboard(
  counts: Record<HelpGroup, number>,
  lang: Lang = "fa",
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const button = (group: HelpGroup): { text: string; data: string } => ({
    text: `${helpGroupTitle(group, lang)} (${formatCount(counts[group], lang)})`,
    data: `${PALETTE_CALLBACK_PREFIX}cat:${group}:0`,
  });
  const general = button("general");
  const session = button("session");
  kb.text(general.text, general.data).text(session.text, session.data).row();
  const automation = button("automation");
  if (counts.owner > 0) {
    const owner = button("owner");
    kb.text(automation.text, automation.data).text(owner.text, owner.data);
  } else {
    kb.text(automation.text, automation.data);
  }
  return kb;
}

/**
 * The category overview as text + keyboard. Pure, for tests and for the
 * /commands handler and menu-button routing in bot.ts.
 */
export function paletteCategoriesRender(
  isOwner: boolean,
  lang: Lang = "fa",
): { text: string; keyboard: InlineKeyboard } {
  const entries = visibleCommandHelp(isOwner);
  return {
    text: paletteCategoriesText(lang),
    keyboard: buildCategoriesKeyboard(paletteGroupCounts(entries), lang),
  };
}

/** One category page: title, page indicator, one /name — description line each. Pure, for tests. */
export function paletteCategoryText(
  group: HelpGroup,
  pageEntries: readonly CommandHelpEntry[],
  page: number,
  totalPages: number,
  lang: Lang = "fa",
): string {
  const lines = pageEntries.map((e) =>
    helpEntryLine(
      e.name,
      describeEntry(e, lang),
      lang === "fa" ? e.exampleFa : e.exampleEn,
      lang,
    ),
  );
  return [
    `${t("pal.title", lang)} — ${helpGroupTitle(group, lang)}`,
    t("pal.page", lang, {
      page: formatCount(page + 1, lang),
      pages: formatCount(totalPages, lang),
    }),
    "",
    ...lines,
  ].join("\n");
}

/** Keyboard for a category page: command buttons, prev/next, back. Pure, for tests. */
export function buildCategoryKeyboard(
  group: HelpGroup,
  pageEntries: readonly CommandHelpEntry[],
  page: number,
  totalPages: number,
  lang: Lang = "fa",
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const e of pageEntries) {
    kb.text(`/${e.name}`, `${PALETTE_CALLBACK_PREFIX}cmd:${e.name}`).row();
  }
  if (page > 0 || page < totalPages - 1) {
    if (page > 0) {
      kb.text(
        t("pal.prev", lang),
        `${PALETTE_CALLBACK_PREFIX}cat:${group}:${page - 1}`,
      );
    }
    if (page < totalPages - 1) {
      kb.text(
        t("pal.next", lang),
        `${PALETTE_CALLBACK_PREFIX}cat:${group}:${page + 1}`,
      );
    }
    kb.row();
  }
  kb.text(t("pal.back_cats", lang), `${PALETTE_CALLBACK_PREFIX}cats`);
  return kb;
}

/**
 * Usage card for a command that needs arguments: description, the
 * needs-arguments hint, and the one-line example where one exists.
 * Pure, for tests.
 */
export function paletteUsageCardText(
  entry: CommandHelpEntry,
  lang: Lang = "fa",
): string {
  const example = lang === "fa" ? entry.exampleFa : entry.exampleEn;
  const parts = [
    `/${entry.name} — ${describeEntry(entry, lang)}`,
    "",
    t("pal.usage.needs_args", lang),
  ];
  if (example !== undefined && example.length > 0) {
    parts.push(t("pal.usage.example", lang, { example: `/${entry.name} ${example}` }));
  }
  return parts.join("\n");
}

/** Usage-card keyboard: a single back button to the command's category. Pure, for tests. */
export function buildUsageCardKeyboard(
  entry: CommandHelpEntry,
  lang: Lang = "fa",
): InlineKeyboard {
  return new InlineKeyboard().text(
    t("pal.back_group", lang),
    `${PALETTE_CALLBACK_PREFIX}cat:${entry.group}:0`,
  );
}

// --------------------------------------------------------------- run ----

/**
 * Everything a palette tap-run needs.
 *
 * `deps` is the bot-wide BotDeps (storage, engine, prefs, auth, panels…);
 * `sysOpts` is the same options object index.ts passes to
 * registerSystemCommands, so the system runners reuse the same defaults.
 */
export interface PaletteEnv {
  deps: BotDeps;
  sysOpts: RegisterOpts;
}

type Runner = (ctx: Context, env: PaletteEnv, lang: Lang) => Promise<void>;

/**
 * Commands the palette runs immediately when tapped.
 *
 * A tap behaves exactly like typing the bare `/command` in chat: read-only
 * commands answer, commands that need arguments show their own usage hint,
 * and destructive commands (reset/new/restart) show their confirm screen —
 * nothing runs unconfirmed. Every other command shows a usage card with its
 * example instead, so no tap is ever a dead end.
 */
export const PALETTE_DIRECT: ReadonlySet<string> = new Set([
  // Session (15): bare invocations are safe — defaults, usage hints, confirms.
  "history", "save", "retry", "undo", "title", "branch", "resume",
  "sessions", "status", "context", "busy", "whoami", "footer", "version", "new",
  // Builtins (10): toggles/pickers/panels; start/help/commands open screens.
  "start", "help", "commands", "voice", "reset", "stop", "lang",
  "personality", "compress", "admin", "ai",
  // Automation (3): read-only listings, plus the interactive digest.
  "agents", "suggestions", "digest",
  // System (17): read-only reports, or bare forms that only describe the
  // confirm step (restart, pause) — never a blind mutation.
  "debug", "usage", "insights", "model", "reasoning", "autoprune", "tools",
  "skills", "curator", "plugins", "snapshot", "restart", "reload_mcp",
  "reload_skills", "approve", "deny", "pause",
]);

/** Reply, splitting on Telegram's length limit. Never throws. */
async function replyText(
  ctx: Pick<Context, "reply">,
  text: string,
): Promise<void> {
  for (const chunk of splitForTelegram(text)) {
    try {
      await ctx.reply(chunk);
    } catch {
      return;
    }
  }
}

/** Env shape every session runner passes: storage is guaranteed present. */
interface SessionRunnerEnv {
  engine: ConversationEngine;
  storage: Storage;
  prefs?: UserPrefStore;
}

/** Shared session env; every session handler degrades honestly without storage. */
function sessionEnv(env: PaletteEnv): SessionRunnerEnv | undefined {
  const storage = env.deps.storage;
  if (storage === undefined) return undefined;
  if (env.deps.prefs !== undefined) {
    return { engine: env.deps.engine, storage, prefs: env.deps.prefs };
  }
  return { engine: env.deps.engine, storage };
}

/** Wrap a session handler: missing storage gets an honest reply, never a crash. */
const runSession = (
  fn: (
    ctx: Context,
    env: SessionRunnerEnv,
    lang: Lang,
    full: PaletteEnv,
  ) => Promise<void>,
): Runner => {
  return async (ctx, env, lang) => {
    const senv = sessionEnv(env);
    if (senv === undefined) {
      await replyText(ctx, t("pal.storage_unavailable", lang));
      return;
    }
    await fn(ctx, senv, lang, env);
  };
};

const autoDepsOf = (env: PaletteEnv): AutoDeps => ({
  engine: env.deps.engine,
  ...(env.deps.storage !== undefined ? { storage: env.deps.storage } : {}),
  ...(env.deps.tools !== undefined ? { tools: env.deps.tools } : {}),
  ...(env.deps.prefs !== undefined ? { prefs: env.deps.prefs } : {}),
  ...(env.deps.auth !== undefined ? { auth: env.deps.auth } : {}),
});

/** System runners share the resolved opts; each mirrors its bot.command wrapper's no-arg branch. */
const sysRun = (
  fn: (ctx: Context, env: PaletteEnv, o: ResolvedOpts, lang: Lang, sysLang: SysLang) => Promise<void>,
): Runner => {
  return async (ctx, env, lang) => {
    await fn(ctx, env, resolveOpts(env.sysOpts), lang, lang);
  };
};

const needStorage = async (
  ctx: Context,
  env: PaletteEnv,
  lang: Lang,
): Promise<Storage | undefined> => {
  const storage = env.deps.storage;
  if (storage === undefined) {
    await replyText(ctx, t("pal.storage_unavailable", lang));
    return undefined;
  }
  return storage;
};

const RUNNERS: Record<string, Runner> = {
  // ---- session ----
  history: runSession(handleHistoryCommand),
  save: runSession(handleSaveCommand),
  retry: runSession(handleRetryCommand),
  undo: runSession(handleUndoCommand),
  title: runSession(handleTitleCommand),
  branch: runSession(handleBranchCommand),
  resume: runSession(handleResumeCommand),
  sessions: runSession(handleSessionsCommand),
  status: runSession(handleStatusCommand),
  context: runSession(handleContextCommand),
  busy: runSession(handleBusyCommand),
  footer: runSession(handleFooterCommand),
  new: runSession(handleNewCommand),
  whoami: runSession(async (ctx, _senv, lang, env) =>
    handleWhoamiCommand(ctx, isOwnerSender(ctx, env.deps), lang),
  ),
  version: async (ctx, env, lang) => {
    await handleVersionCommand(
      ctx,
      env.deps.version !== undefined ? { version: env.deps.version } : {},
      lang,
    );
  },

  // ---- builtins ----
  start: async (ctx, _env, lang) => {
    await editMenuMessage(ctx, startScreenText(lang), buildMainMenu(lang));
  },
  help: async (ctx, env, lang) => {
    const render = paletteCategoriesRender(isOwnerSender(ctx, env.deps), lang);
    await editMenuMessage(ctx, render.text, render.keyboard);
  },
  commands: async (ctx, env, lang) => {
    const render = paletteCategoriesRender(isOwnerSender(ctx, env.deps), lang);
    await editMenuMessage(ctx, render.text, render.keyboard);
  },
  voice: async (ctx, env, lang) => {
    await handleVoiceCommand(
      ctx,
      {
        ...(env.deps.tts !== undefined ? { tts: env.deps.tts } : {}),
        ...(env.deps.prefs !== undefined ? { prefs: env.deps.prefs } : {}),
      },
      lang,
    );
  },
  reset: async (ctx, env, lang) => {
    await handleResetCommand(ctx, env.deps, lang);
  },
  stop: async (ctx, env, lang) => {
    await handleStopCommand(ctx, { engine: env.deps.engine }, lang);
  },
  lang: async (ctx, env, lang) => {
    await handleLangCommand(
      ctx,
      env.deps.prefs !== undefined ? { prefs: env.deps.prefs } : {},
      lang,
    );
  },
  personality: async (ctx, env, lang) => {
    await handlePersonalityCommand(
      ctx,
      env.deps.prefs !== undefined ? { prefs: env.deps.prefs } : {},
      lang,
    );
  },
  compress: async (ctx, env, lang) => {
    await handleCompressCommand(ctx, { engine: env.deps.engine }, lang);
  },
  admin: async (ctx, env, _lang) => {
    if (env.deps.panel) await env.deps.panel.openPanel(ctx);
  },
  ai: async (ctx, env, _lang) => {
    if (env.deps.aiAdmin) await env.deps.aiAdmin.open(ctx);
  },

  // ---- automation ----
  agents: async (ctx, env, lang) => {
    const sender = senderOf(ctx);
    if (!sender) return;
    await replyLong(ctx, handleAgents(autoDepsOf(env), sender, lang));
  },
  suggestions: async (ctx, env, lang) => {
    const sender = senderOf(ctx);
    if (!sender) return;
    await replyLong(
      ctx,
      handleSuggestions(autoDepsOf(env), sender, isOwnerSender(ctx, env.deps), lang),
    );
  },
  digest: async (ctx, env, lang) => {
    await sendInteractiveDigest(
      ctx,
      { deps: env.deps, sysOpts: env.sysOpts },
      lang,
    );
  },

  // ---- system (owner-only; ownership re-checked in runPaletteCommand) ----
  debug: sysRun(async (ctx, env, o, lang, sysLang) => {
    const storage = await needStorage(ctx, env, lang);
    if (!storage) return;
    const rs = storage.getRuntimeSettings();
    const provider =
      rs.activeProviderId != null ? storage.getProvider(rs.activeProviderId) : undefined;
    const model =
      rs.activeModelId != null ? storage.getModel(rs.activeModelId) : undefined;
    const logFile = (process.env.BOBI_LOG_FILE ?? "").trim();
    const logTail = logFile.length > 0 ? readLogTail(logFile) : undefined;
    const info: DebugInfo = {
      version: env.deps.version ?? "?",
      uptimeSec: process.uptime(),
      pendingUsers: env.deps.users?.countPending() ?? 0,
      approvedUsers: env.deps.users?.countApproved() ?? 0,
      pendingGroups: env.deps.groups?.countPending() ?? 0,
      approvedGroups: env.deps.groups?.countApproved() ?? 0,
    };
    if (provider !== undefined) info.providerLabel = provider.label;
    if (model !== undefined) info.modelLabel = model.label;
    if (logTail !== undefined) info.logTail = logTail;
    await replyText(ctx, buildDebugMarkdown(sysLang, info));
  }),
  usage: sysRun(async (ctx, env, o, lang, sysLang) => {
    const storage = await needStorage(ctx, env, lang);
    if (!storage) return;
    const todayStart = startOfTodayMs(o.now());
    const weekStart = todayStart - 6 * 86400000;
    const costOf = (rows: UsageModelRow[]): number =>
      rows.reduce(
        (s, r) => s + estimateCost(r.inputTokens, r.outputTokens, r.modelId).usd,
        0,
      );
    const todayRows = storage.usageByModelAll(todayStart);
    const weekRows = storage.usageByModelAll(weekStart);
    const today = storage.usageTotalsAll(todayStart);
    const week = storage.usageTotalsAll(weekStart);
    await replyText(
      ctx,
      handleUsage(
        sysLang,
        { ...today, costUsd: costOf(todayRows) },
        { ...week, costUsd: costOf(weekRows) },
        weekRows,
      ),
    );
  }),
  insights: sysRun(async (ctx, env, o, lang, sysLang) => {
    const storage = await needStorage(ctx, env, lang);
    if (!storage) return;
    const days = 7;
    const now = o.now();
    const todayStart = startOfTodayMs(now);
    const windowTotals = (sinceMs: number, untilMs?: number): UsageTotals => {
      const a = storage.usageTotalsAll(sinceMs);
      if (untilMs === undefined) return a;
      const b = storage.usageTotalsAll(untilMs);
      return {
        inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
        outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
        runs: Math.max(0, a.runs - b.runs),
      };
    };
    const cur: InsightDay[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const start = todayStart - i * 86400000;
      cur.push({ day: isoDay(start), ...windowTotals(start, start + 86400000) });
    }
    const prev = windowTotals(todayStart - days * 86400000, todayStart);
    const byModel = storage.usageByModelAll(todayStart - days * 86400000);
    await replyText(ctx, handleInsights(sysLang, days, cur, prev, byModel));
  }),
  model: sysRun(async (ctx, env, _o, lang, sysLang) => {
    const storage = await needStorage(ctx, env, lang);
    if (!storage) return;
    const rs = storage.getRuntimeSettings();
    const provider =
      rs.activeProviderId != null ? storage.getProvider(rs.activeProviderId) : undefined;
    const model =
      rs.activeModelId != null ? storage.getModel(rs.activeModelId) : undefined;
    const items: ModelListItem[] = [];
    for (const p of storage.listProviders()) {
      for (const m of storage.listModels(p.id)) {
        items.push({
          id: m.id,
          providerLabel: p.label,
          label: m.label,
          modelId: m.modelId,
          enabled: m.enabled,
          isActive: m.id === rs.activeModelId,
        });
      }
    }
    const text = handleModelShow(
      sysLang,
      {
        ...(provider !== undefined ? { providerLabel: provider.label } : {}),
        ...(model !== undefined ? { modelLabel: model.label } : {}),
      },
      items,
    );
    // Quick-switch buttons, exactly like /model: the mdl: callbacks are
    // handled by cmd_system's own namespace, from any message.
    const switchable = items.filter((i) => i.enabled);
    if (switchable.length === 0) {
      await replyText(ctx, text);
      return;
    }
    const keyboard = buildModelKeyboard(
      switchable.map((i) => ({ id: i.id, label: i.label, isActive: i.isActive })),
      lang,
    );
    try {
      await ctx.reply(text, { reply_markup: keyboard });
    } catch {
      await replyText(ctx, text);
    }
  }),
  reasoning: sysRun(async (ctx, env, _o, lang, sysLang) => {
    const ownerId = ctx.from !== undefined ? String(ctx.from.id) : "";
    const stored = env.deps.prefs?.getUserPref(ownerId, REASONING_PREF_KEY);
    await replyText(ctx, handleReasoningShow(sysLang, stored));
  }),
  autoprune: sysRun(async (ctx, env, _o, lang, sysLang) => {
    const ownerId = ctx.from !== undefined ? String(ctx.from.id) : "";
    const raw = env.deps.prefs?.getUserPref(ownerId, AUTOPRUNE_PREF_KEY);
    await replyText(ctx, handleAutopruneShow(sysLang, parseAutoprune(raw)));
  }),
  tools: sysRun(async (ctx, env, _o, lang, sysLang) => {
    await replyText(ctx, handleTools(sysLang, env.deps.tools));
  }),
  skills: sysRun(async (ctx, env, _o, lang, sysLang) => {
    const ownerId = ctx.from !== undefined ? String(ctx.from.id) : "";
    await replyText(
      ctx,
      await handleSkills(sysLang, {
        ...(env.deps.tools !== undefined ? { tools: env.deps.tools } : {}),
        ...(env.sysOpts.skills !== undefined ? { skills: env.sysOpts.skills } : {}),
        ownerId,
      }),
    );
  }),
  curator: sysRun(async (ctx, env, _o, lang, sysLang) => {
    const ownerId = ctx.from !== undefined ? String(ctx.from.id) : "";
    let pending = 0;
    try {
      pending = env.sysOpts.proposalStore?.listPending(ownerId).length ?? 0;
    } catch {
      // Unreadable store = report what we know (zero), honestly.
    }
    await replyText(ctx, handleCuratorStatus(sysLang, env.deps.tools, pending));
  }),
  plugins: sysRun(async (ctx, env, o, lang, sysLang) => {
    await replyText(ctx, handlePlugins(sysLang, o.pluginsDir));
  }),
  snapshot: sysRun(async (ctx, env, o, lang, sysLang) => {
    const turnRunning = o.isAnyTurnRunning?.() ?? false;
    const result = handleSnapshot(
      sysLang,
      { dbPath: o.dbPath, snapshotDir: o.snapshotDir },
      undefined,
      turnRunning,
      o.now(),
    );
    await replyText(ctx, result.text);
  }),
  restart: sysRun(async (ctx, env, o, lang, sysLang) => {
    // Bare form only ever describes the confirm step — same as typing /restart.
    const result = handleRestart(sysLang, {
      turnRunning: o.isAnyTurnRunning?.() ?? false,
      force: false,
      confirmed: false,
    });
    await replyText(ctx, result.text);
  }),
  reload_mcp: sysRun(async (ctx, env, o, lang, sysLang) => {
    await replyText(ctx, await handleReloadMcp(sysLang, o.mcp));
  }),
  reload_skills: sysRun(async (ctx, env, o, lang, sysLang) => {
    await replyText(ctx, handleReloadSkills(sysLang, o.skills));
  }),
  approve: sysRun(async (ctx, env, _o, lang, sysLang) => {
    const svc: AccessServices = {
      ...(env.deps.users !== undefined ? { users: env.deps.users } : {}),
      ...(env.deps.groups !== undefined ? { groups: env.deps.groups } : {}),
    };
    await replyText(ctx, handleAccessList(sysLang, listPendingAccess(svc)));
  }),
  deny: sysRun(async (ctx, env, _o, lang, sysLang) => {
    const svc: AccessServices = {
      ...(env.deps.users !== undefined ? { users: env.deps.users } : {}),
      ...(env.deps.groups !== undefined ? { groups: env.deps.groups } : {}),
    };
    await replyText(ctx, handleAccessList(sysLang, listPendingAccess(svc)));
  }),
  pause: sysRun(async (ctx, env, _o, lang, sysLang) => {
    const ownerId = ctx.from !== undefined ? String(ctx.from.id) : "";
    await replyText(
      ctx,
      handlePause(sysLang, env.deps.prefs, ownerId, undefined),
    );
  }),
};

/**
 * Run a palette command by name: the single choke point for tap-to-run.
 *
 * - Unknown names are ignored (never throw, never reply).
 * - Owner-only commands re-check ownership server-side on every tap: a
 *   non-owner with a forged callback gets the owner-only reply, never
 *   execution — even when the command has no tap-to-run runner (the tier
 *   check runs before the runner lookup). Button hiding is not the boundary.
 */
export async function runPaletteCommand(
  name: string,
  ctx: Context,
  env: PaletteEnv,
  lang: Lang = "fa",
): Promise<void> {
  const entry = COMMAND_HELP.find((e) => e.name === name);
  if (entry === undefined) return;
  if (entry.ownerOnly && !isOwnerSender(ctx, env.deps)) {
    await replyText(ctx, t("pal.owner_only", lang));
    return;
  }
  const runner = RUNNERS[name];
  if (runner === undefined) return;
  await runner(ctx, env, lang);
}

// ------------------------------------------------------------ wiring ----

/**
 * Handle one palette callback. The caller answers the callback query and
 * runs the group/user gates first (same as the menu buttons); this only
 * routes the validated action. Returns true when the data was palette
 * data (valid or forged — forged data is consumed, never executed).
 */
export async function handlePaletteCallback(
  ctx: Context,
  env: PaletteEnv,
  data: string,
  lang: Lang = "fa",
): Promise<boolean> {
  if (!data.startsWith(PALETTE_CALLBACK_PREFIX)) return false;
  const action = parsePaletteCallback(data);
  if (action === undefined) return true; // forged/malformed — safely ignored
  const isOwner = isOwnerSender(ctx, env.deps);
  const entries = visibleCommandHelp(isOwner);
  switch (action.kind) {
    case "cats": {
      const render = paletteCategoriesRender(isOwner, lang);
      await editMenuMessage(ctx, render.text, render.keyboard);
      return true;
    }
    case "cat": {
      const { pageEntries, totalPages } = palettePageEntries(
        entries,
        action.group,
        action.page,
      );
      // Empty page = out-of-range page, or a group the sender may not see
      // (e.g. a forged pal:cat:owner:0 from a non-owner) — ignore it.
      if (pageEntries.length === 0) return true;
      await editMenuMessage(
        ctx,
        paletteCategoryText(action.group, pageEntries, action.page, totalPages, lang),
        buildCategoryKeyboard(action.group, pageEntries, action.page, totalPages, lang),
      );
      return true;
    }
    case "cmd": {
      const entry = entries.find((e) => e.name === action.name);
      if (entry === undefined) {
        // Not visible to this sender. If it exists but is owner-only, say
        // so (same reply the typed command would give); forged names stay
        // silent.
        const real = COMMAND_HELP.find((e) => e.name === action.name);
        if (real?.ownerOnly && !isOwner) {
          await replyText(ctx, t("pal.owner_only", lang));
        }
        return true;
      }
      if (PALETTE_DIRECT.has(entry.name)) {
        await runPaletteCommand(entry.name, ctx, env, lang);
      } else {
        await editMenuMessage(
          ctx,
          paletteUsageCardText(entry, lang),
          buildUsageCardKeyboard(entry, lang),
        );
      }
      return true;
    }
  }
}

/** Open the palette as a fresh message (the /commands entry point). Never throws. */
export async function openPaletteMessage(
  ctx: Pick<Context, "reply">,
  isOwner: boolean,
  lang: Lang = "fa",
): Promise<void> {
  const render = paletteCategoriesRender(isOwner, lang);
  try {
    await ctx.reply(render.text, { reply_markup: render.keyboard });
  } catch {
    // Best effort: the user cannot be reached.
  }
}

/**
 * Register the /commands command. Deliberately ungated like /help: the
 * listing is harmless, and owner-only entries are hidden from non-owners.
 */
export function registerPaletteCommands(bot: Bot, env: PaletteEnv): void {
  bot.command("commands", async (ctx) => {
    const lang = senderLang(ctx, env.deps.prefs);
    await openPaletteMessage(ctx, isOwnerSender(ctx, env.deps), lang);
  });
}
