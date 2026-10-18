/**
 * Phase 3, item 5 — installable skills from chat (personal plugin marketplace).
 *
 * Owner-only. The owner installs a skill either by sending a `.md` document
 * or by passing a URL; both sources converge on the same validation pipeline
 * in `src/skills/install.ts` and both require an explicit approve on a review
 * card before anything is written. After install the SkillCache picks the new
 * file up on its next read (directory-mtime reload) — no restart.
 *
 * Management surface (all under `/skill`; the existing `/skills` list command
 * in cmd_system.ts is untouched):
 *   /skill install <url> [--confirm]   fetch, validate, review, install
 *   /skill show <name>                 show one installed skill
 *   /skill enable|disable <name>       rename into/out of the hidden-file convention
 *   /skill uninstall <name> [--confirm] two-step delete
 * Sending a `.md` document with caption "/skill install" (or replying
 * "/skill install" to a document message) runs the document install flow.
 *
 * Conventions (same as the sibling command modules):
 * - owner-only: `isOwnerSender` is checked FIRST in every handler and in the
 *   callback router; a non-owner gets the short refusal and nothing else;
 * - fa+en strings via the local `cmd_phase3_skills_strings.ts` table;
 * - logic lives in exported pure-ish `handleXxx` functions over plain values;
 *   the grammy wrappers are thin.
 *
 * This module is NOT registered in index.ts/bot.ts — the coordinator wires
 * `registerPhase3SkillsCommands` (and merges `COMMAND_DEFS` into the menu).
 */
import { randomBytes } from "node:crypto";
import { Bot, Context, InlineKeyboard } from "grammy";
import type { HermesCommandDef, HermesCommandDeps } from "./cmd_context";
import {
  commandArg,
  gateGroup,
  gateUser,
  isOwnerSender,
  senderLang,
} from "./bot";
import type { Lang } from "../i18n/types";
import type { SkillCache } from "../skills/loader";
import {
  prepareSkillInstall,
  readInstalledSkill,
  scanSkillBody,
  setSkillEnabled,
  skillFileStatus,
  uninstallSkillFile,
  writeSkillFile,
  createPinnedSkillFetcher,
  SkillFetchError,
  type InstallPlan,
  type SkillFetcher,
  type ValidatedSkill,
} from "../skills/install";
import { SKILLS_MAX_FILE_BYTES } from "../skills/types";
import { tr, type Ph3SkillsLang } from "./cmd_phase3_skills_strings";

// ------------------------------------------------------------------ defs ----

export const COMMAND_DEFS: HermesCommandDef[] = [
  {
    command: "skill",
    descriptionFa: "نصب و مدیریت مهارت‌ها",
    descriptionEn: "Install and manage skills",
    ownerOnly: true,
  },
];

/** Optional wiring the coordinator provides at registration time. */
export interface Phase3SkillsOpts {
  /** The live skill cache (index.ts). Absent = management reports unavailable. */
  skills?: SkillCache;
  /** Skills directory override; default is the cache's directory. */
  skillsDir?: string;
  /** URL fetcher; default is the SSRF-guarded pinned fetcher. */
  fetcher?: SkillFetcher;
  /** Bot token, for downloading uploaded documents (same file-URL pattern as media.ts). */
  botToken?: string;
  /**
   * Document downloader override (tests). Receives the grammy context and a
   * Telegram file_id, returns the raw bytes or undefined on failure.
   */
  downloadDocument?: (ctx: Context, fileId: string) => Promise<Uint8Array | undefined>;
  now?: () => number;
}

// --------------------------------------------------------------- helpers ----

function toLang(lang: Lang): Ph3SkillsLang {
  return lang === "en" ? "en" : "fa";
}

async function safeReply(
  ctx: { reply(text: string, extra?: unknown): Promise<unknown> },
  text: string,
  extra?: unknown,
): Promise<void> {
  try {
    await ctx.reply(text, extra as never);
  } catch {
    // The owner may have blocked the bot; that is not an error.
  }
}

/** Owner gate: owner first, then the group/user gates. */
async function gate(
  ctx: Context,
  deps: HermesCommandDeps,
  lang: Ph3SkillsLang,
): Promise<boolean> {
  if (!isOwnerSender(ctx, deps)) {
    await safeReply(ctx, tr(lang, "ph3_skills.owner_only"));
    return false;
  }
  if (!(await gateGroup(ctx, deps.groups, lang))) return false;
  if (!(await gateUser(ctx, deps))) return false;
  return true;
}

function messageArg(ctx: Context): string | undefined {
  const text = ctx.message?.text;
  return text !== undefined ? commandArg(text) : undefined;
}

function flagSet(arg: string | undefined, flag: string): boolean {
  return (
    arg !== undefined &&
    arg.split(/\s+/).some((p) => p.toLowerCase() === flag)
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function resolveDir(opts: Phase3SkillsOpts): string | undefined {
  if (opts.skillsDir !== undefined) return opts.skillsDir;
  return opts.skills?.directory;
}

// ------------------------------------------------------ pending approvals ----

/** An install waiting on the owner's review-card decision. */
export interface PendingInstall {
  text: string;
  name: string;
  replace: boolean;
  sourceLabel: string;
}

/** An uninstall waiting on the owner's confirm decision. */
export interface PendingUninstall {
  name: string;
}

/**
 * Short-lived, in-memory approval tokens for the review cards.
 *
 * Tokens are 128-bit random hex; a forged callback cannot guess one, and the
 * callback router re-checks ownership anyway. Entries expire after 10 minutes
 * so a stale card can never install something the owner forgot about.
 */
export class PendingStore {
  private installs = new Map<string, { pending: PendingInstall; createdAt: number }>();
  private uninstalls = new Map<string, { pending: PendingUninstall; createdAt: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(now: () => number = Date.now, ttlMs: number = 10 * 60 * 1000) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  createInstall(pending: PendingInstall): string {
    const token = randomBytes(16).toString("hex");
    this.installs.set(token, { pending, createdAt: this.now() });
    return token;
  }

  /** Take (consume) a pending install; undefined when unknown or expired. */
  takeInstall(token: string): PendingInstall | undefined {
    const entry = this.installs.get(token);
    this.installs.delete(token);
    if (entry === undefined) return undefined;
    if (this.now() - entry.createdAt > this.ttlMs) return undefined;
    return entry.pending;
  }

  createUninstall(pending: PendingUninstall): string {
    const token = randomBytes(16).toString("hex");
    this.uninstalls.set(token, { pending, createdAt: this.now() });
    return token;
  }

  takeUninstall(token: string): PendingUninstall | undefined {
    const entry = this.uninstalls.get(token);
    this.uninstalls.delete(token);
    if (entry === undefined) return undefined;
    if (this.now() - entry.createdAt > this.ttlMs) return undefined;
    return entry.pending;
  }
}

// ------------------------------------------------------------ review card ----

const PREVIEW_LINES = 20;

/**
 * Render the install review card. Pure. Shows name, description, triggers,
 * size, source, the risk warnings (if any), and the first 20 body lines —
 * everything the owner needs to decide, and nothing is installed yet.
 */
export function renderReviewCard(
  lang: Ph3SkillsLang,
  validated: ValidatedSkill,
  sourceLabel: string,
): string {
  const s = validated.skill;
  const lines = [
    tr(lang, "ph3_skills.review.title"),
    "",
    tr(lang, "ph3_skills.review.name", { name: s.name }),
    tr(lang, "ph3_skills.review.description", { description: s.description }),
    tr(lang, "ph3_skills.review.triggers", {
      triggers:
        s.triggers.length > 0 ? s.triggers.join(", ") : tr(lang, "ph3_skills.review.triggers_none"),
    }),
    tr(lang, "ph3_skills.review.size", { size: formatBytes(validated.sizeBytes) }),
    tr(lang, "ph3_skills.review.source", { source: sourceLabel }),
  ];
  if (validated.replace) {
    lines.push("", tr(lang, "ph3_skills.review.replace_note", { name: s.name }));
  }
  if (validated.warnings.length > 0) {
    lines.push("", tr(lang, "ph3_skills.review.warnings_title"));
    for (const w of validated.warnings) {
      lines.push(tr(lang, "ph3_skills.review.warning_item", { detail: w.detail, snippet: w.snippet }));
    }
  }
  const preview = s.body.split("\n").slice(0, PREVIEW_LINES).join("\n").trim();
  lines.push("", tr(lang, "ph3_skills.review.preview_title"), preview, "", tr(lang, "ph3_skills.review.approve_hint"));
  return lines.join("\n");
}

/** Map a validation error to user-facing text. Pure. */
export function renderValidationError(
  lang: Ph3SkillsLang,
  error: InstallPlan & { ok: false },
  sourceLabel: string,
): string {
  const e = error.error;
  switch (e.kind) {
    case "too_large":
      return tr(lang, "ph3_skills.install.too_large", {
        bytes: formatBytes(e.bytes),
        max: formatBytes(e.maxBytes),
      });
    case "parse":
      return tr(lang, "ph3_skills.install.parse_failed", { reason: e.reason });
    case "collision":
      return tr(lang, "ph3_skills.install.collision", { name: e.name, source: sourceLabel });
    case "limit":
      return tr(lang, "ph3_skills.install.limit", { max: e.max, count: e.count });
  }
}

// ---------------------------------------------------------------- install ----

export interface InstallOutcome {
  /** "review" carries a pending token the wrapper turns into buttons. */
  outcome: "review" | "installed" | "error";
  text: string;
  pending?: PendingInstall;
}

/**
 * Plan an install from raw markdown text (either source). Pure-ish: reads the
 * skills directory, writes nothing. On "review" the caller shows
 * `renderReviewCard` with تأیید/رد buttons bound to `pending`.
 *
 * `confirm` pre-authorizes REPLACING a same-named skill (the phase-1
 * destructive-confirmation style), but it never skips the review card when
 * the scan found warnings — the owner must see those first.
 */
export function planInstallFromText(
  lang: Ph3SkillsLang,
  text: string,
  sourceLabel: string,
  dir: string,
  confirm: boolean,
): InstallOutcome {
  const plan = prepareSkillInstall({ text, source: sourceLabel, dir, allowReplace: confirm });
  if (!plan.ok) {
    // A collision without --confirm is not fatal: the owner may still approve
    // the replacement from the review card, where the risk is explicit.
    if (plan.error.kind === "collision" && !confirm) {
      const retry = prepareSkillInstall({ text, source: sourceLabel, dir, allowReplace: true });
      if (retry.ok) {
        return {
          outcome: "review",
          text: renderReviewCard(lang, retry.validated, sourceLabel),
          pending: {
            text,
            name: retry.validated.skill.name,
            replace: true,
            sourceLabel,
          },
        };
      }
      // fall through to the error render below
    }
    return { outcome: "error", text: renderValidationError(lang, plan, sourceLabel) };
  }

  const validated = plan.validated;
  // Explicit --confirm installs immediately ONLY when the scan is clean; any
  // warning forces the review card so the owner sees it before deciding.
  if (confirm && validated.warnings.length === 0) {
    return { outcome: "installed", text: installNow(lang, dir, validated) };
  }
  return {
    outcome: "review",
    text: renderReviewCard(lang, validated, sourceLabel),
    pending: { text, name: validated.skill.name, replace: validated.replace, sourceLabel },
  };
}

/** Write the file now (post-approval). Never throws user-hostile errors. */
function installNow(lang: Ph3SkillsLang, dir: string, validated: ValidatedSkill): string {
  try {
    writeSkillFile(dir, validated);
  } catch (err) {
    return tr(lang, "ph3_skills.install.write_failed", { reason: String(err) });
  }
  // The SkillCache reloads on directory mtime — no restart needed.
  return tr(
    lang,
    validated.replace ? "ph3_skills.install.done_replaced" : "ph3_skills.install.done",
    { name: validated.skill.name },
  );
}

/** The تأیید button: consume the pending install and write the file. */
export function approvePendingInstall(
  lang: Ph3SkillsLang,
  store: PendingStore,
  token: string,
  dir: string,
): string {
  const pending = store.takeInstall(token);
  if (pending === undefined) return tr(lang, "ph3_skills.review.expired");
  // Re-validate at approve time: the directory may have changed since the
  // review card was shown (another install, a manual edit).
  const plan = prepareSkillInstall({
    text: pending.text,
    source: pending.sourceLabel,
    dir,
    allowReplace: true,
  });
  if (!plan.ok) return renderValidationError(lang, plan, pending.sourceLabel);
  return installNow(lang, dir, plan.validated);
}

/** The رد button: drop the pending install. */
export function rejectPendingInstall(
  lang: Ph3SkillsLang,
  store: PendingStore,
  token: string,
): string {
  const pending = store.takeInstall(token);
  if (pending === undefined) return tr(lang, "ph3_skills.review.expired");
  return tr(lang, "ph3_skills.review.rejected", { name: pending.name });
}

/** Fetch the URL, then plan the install. The fetcher is injected (mocked in tests). */
export async function planInstallFromUrl(
  lang: Ph3SkillsLang,
  url: string,
  dir: string,
  fetcher: SkillFetcher,
  confirm: boolean,
): Promise<InstallOutcome> {
  let text: string;
  try {
    const res = await fetcher(url);
    text = res.text;
  } catch (err) {
    const reason =
      err instanceof SkillFetchError ? friendlyFetchReason(lang, err) : String(err);
    return { outcome: "error", text: tr(lang, "ph3_skills.install.fetch_failed", { reason }) };
  }
  return planInstallFromText(lang, text, url, dir, confirm);
}

function friendlyFetchReason(lang: Ph3SkillsLang, err: SkillFetchError): string {
  // Keep the technical kinds out of the user-facing text; the fa/en detail
  // lives in the message already (English diagnostics are fine here).
  void lang;
  return err.message;
}

// -------------------------------------------------------------- management ----

/** `/skill show <name>`: description, triggers, status, 20-line preview. Pure. */
export function handleSkillShow(lang: Ph3SkillsLang, dir: string, name: string): string {
  const found = readInstalledSkill(dir, name.trim().toLowerCase());
  if (found === undefined) return tr(lang, "ph3_skills.show.not_found", { name });
  const s = found.skill;
  const status = tr(
    lang,
    "ph3_skills.show.status",
    {
      status: tr(
        lang,
        found.status === "enabled"
          ? "ph3_skills.show.status_enabled"
          : "ph3_skills.show.status_disabled",
      ),
    },
  );
  const preview = s.body.split("\n").slice(0, PREVIEW_LINES).join("\n").trim();
  return [
    tr(lang, "ph3_skills.review.name", { name: s.name }),
    tr(lang, "ph3_skills.review.description", { description: s.description }),
    tr(lang, "ph3_skills.review.triggers", {
      triggers: s.triggers.length > 0 ? s.triggers.join(", ") : tr(lang, "ph3_skills.review.triggers_none"),
    }),
    status,
    "",
    tr(lang, "ph3_skills.review.preview_title"),
    preview,
  ].join("\n");
}

/** `/skill enable|disable <name>`. Pure. */
export function handleSkillToggle(
  lang: Ph3SkillsLang,
  dir: string,
  name: string,
  enable: boolean,
): string {
  const clean = name.trim().toLowerCase();
  const before = skillFileStatus(dir, clean);
  if (before === "missing") return tr(lang, "ph3_skills.toggle.missing", { name: clean });
  if (enable && before === "enabled") return tr(lang, "ph3_skills.toggle.noop_enabled", { name: clean });
  if (!enable && before === "disabled") return tr(lang, "ph3_skills.toggle.noop_disabled", { name: clean });
  const after = setSkillEnabled(dir, clean, enable);
  if (enable && after === "enabled") return tr(lang, "ph3_skills.toggle.enabled", { name: clean });
  if (!enable && after === "disabled") return tr(lang, "ph3_skills.toggle.disabled", { name: clean });
  return tr(lang, "ph3_skills.toggle.missing", { name: clean });
}

export interface UninstallOutcome {
  outcome: "confirm" | "done" | "error";
  text: string;
  pending?: PendingUninstall;
}

/** `/skill uninstall <name> [--confirm]`: two-step delete. Pure. */
export function planUninstall(
  lang: Ph3SkillsLang,
  dir: string,
  name: string,
  confirm: boolean,
  store: PendingStore,
): UninstallOutcome {
  const clean = name.trim().toLowerCase();
  if (skillFileStatus(dir, clean) === "missing") {
    return { outcome: "error", text: tr(lang, "ph3_skills.uninstall.missing", { name: clean }) };
  }
  if (!confirm) {
    return {
      outcome: "confirm",
      text: tr(lang, "ph3_skills.uninstall.confirm", { name: clean }),
      pending: { name: clean },
    };
  }
  const removed = uninstallSkillFile(dir, clean);
  return removed
    ? { outcome: "done", text: tr(lang, "ph3_skills.uninstall.done", { name: clean }) }
    : { outcome: "error", text: tr(lang, "ph3_skills.uninstall.failed", { name: clean }) };
}

/** The حذف قطعی button: consume the pending uninstall and delete. */
export function approvePendingUninstall(
  lang: Ph3SkillsLang,
  store: PendingStore,
  token: string,
  dir: string,
): string {
  const pending = store.takeUninstall(token);
  if (pending === undefined) return tr(lang, "ph3_skills.review.expired");
  const removed = uninstallSkillFile(dir, pending.name);
  return removed
    ? tr(lang, "ph3_skills.uninstall.done", { name: pending.name })
    : tr(lang, "ph3_skills.uninstall.failed", { name: pending.name });
}

/** The انصراف button. */
export function rejectPendingUninstall(
  lang: Ph3SkillsLang,
  store: PendingStore,
  token: string,
): string {
  const pending = store.takeUninstall(token);
  if (pending === undefined) return tr(lang, "ph3_skills.review.expired");
  return tr(lang, "ph3_skills.uninstall.cancelled", { name: pending.name });
}

// ------------------------------------------------------------------ wiring ----

const CB_PREFIX = "ph3skill";

function installKeyboard(lang: Ph3SkillsLang, token: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "ph3_skills.review.approve"), `${CB_PREFIX}:inst:${token}:ok`)
    .text(tr(lang, "ph3_skills.review.reject"), `${CB_PREFIX}:inst:${token}:no`);
}

function uninstallKeyboard(lang: Ph3SkillsLang, token: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "ph3_skills.uninstall.confirm_approve"), `${CB_PREFIX}:uninst:${token}:ok`)
    .text(tr(lang, "ph3_skills.uninstall.confirm_cancel"), `${CB_PREFIX}:uninst:${token}:no`);
}

/** A caption (or reply text) counts as a skill-install request when it starts with /skill install. */
export function isSkillInstallCaption(caption: string | undefined): boolean {
  if (caption === undefined) return false;
  const first = caption.trim().split(/\s+/, 2);
  if (first.length < 2) return false;
  if (!/^\/skill(@\w+)?$/i.test(first[0]!)) return false;
  return first[1]!.toLowerCase() === "install";
}

interface DocumentRef {
  fileId: string;
  fileName: string | undefined;
  fileSize: number | undefined;
}

/**
 * Register the phase-3 skill commands. The coordinator calls this; nothing
 * here is wired in index.ts/bot.ts by this module.
 */
export function registerPhase3SkillsCommands(
  bot: Bot,
  deps: HermesCommandDeps,
  opts: Phase3SkillsOpts = {},
): void {
  const store = new PendingStore(opts.now ?? Date.now);
  const fetcher: SkillFetcher = opts.fetcher ?? createPinnedSkillFetcher();

  const dirOf = (): string | undefined => resolveDir(opts);

  /**
   * Download an uploaded document's bytes. Default follows the repo's own
   * pattern (media.ts): getFile, then fetch the file URL with the bot token.
   * The path guard (no leading "/" or "..") is copied from there too.
   */
  const downloadDocument = async (
    c: Context,
    fileId: string,
  ): Promise<Uint8Array | undefined> => {
    if (opts.downloadDocument !== undefined) return opts.downloadDocument(c, fileId);
    if (opts.botToken === undefined) return undefined;
    try {
      const file = await c.api.getFile(fileId);
      if (file.file_path === undefined) return undefined;
      if (file.file_path.startsWith("/") || file.file_path.includes("..")) return undefined;
      const res = await fetch(
        `https://api.telegram.org/file/bot${opts.botToken}/${file.file_path}`,
      );
      if (!res.ok) return undefined;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return undefined;
    }
  };

  // ------------------------------------------------------------- /skill ----
  bot.command("skill", async (ctx) => {
    const lang = toLang(senderLang(ctx, deps.prefs));
    if (!(await gate(ctx, deps, lang))) return;
    const dir = dirOf();
    if (dir === undefined) {
      await safeReply(ctx, tr(lang, "ph3_skills.unavailable"));
      return;
    }
    const arg = messageArg(ctx);
    const parts = (arg ?? "").trim().split(/\s+/).filter((p) => p.length > 0);
    const sub = parts[0]?.toLowerCase();

    // Reply-to-document install: "/skill install" as a reply to the file.
    const repliedDoc = documentOf(ctx.message?.reply_to_message);
    if ((sub === "install" || sub === undefined) && repliedDoc !== undefined) {
      await installFromDocument(ctx, deps, lang, dir, repliedDoc, store, downloadDocument);
      return;
    }

    switch (sub) {
      case "install": {
        const rest = parts.slice(1).filter((p) => p.toLowerCase() !== "--confirm");
        const confirm = flagSet(arg, "--confirm");
        const url = rest[0];
        if (url === undefined) {
          await safeReply(ctx, tr(lang, "ph3_skills.install.no_source"));
          return;
        }
        const outcome = await planInstallFromUrl(lang, url, dir, fetcher, confirm);
        if (outcome.outcome === "review" && outcome.pending !== undefined) {
          const token = store.createInstall(outcome.pending);
          await safeReply(ctx, outcome.text, { reply_markup: installKeyboard(lang, token) });
          return;
        }
        await safeReply(ctx, outcome.text);
        return;
      }
      case "show": {
        const name = parts[1];
        if (name === undefined) {
          await safeReply(ctx, tr(lang, "ph3_skills.usage"));
          return;
        }
        await safeReply(ctx, handleSkillShow(lang, dir, name));
        return;
      }
      case "enable":
      case "disable": {
        const name = parts[1];
        if (name === undefined) {
          await safeReply(ctx, tr(lang, "ph3_skills.usage"));
          return;
        }
        await safeReply(ctx, handleSkillToggle(lang, dir, name, sub === "enable"));
        return;
      }
      case "uninstall": {
        const name = parts[1];
        if (name === undefined) {
          await safeReply(ctx, tr(lang, "ph3_skills.usage"));
          return;
        }
        const outcome = planUninstall(lang, dir, name, flagSet(arg, "--confirm"), store);
        if (outcome.outcome === "confirm" && outcome.pending !== undefined) {
          const token = store.createUninstall(outcome.pending);
          await safeReply(ctx, outcome.text, { reply_markup: uninstallKeyboard(lang, token) });
          return;
        }
        await safeReply(ctx, outcome.text);
        return;
      }
      default:
        await safeReply(ctx, tr(lang, "ph3_skills.usage"));
        return;
    }
  });

  // --------------------------------------- document install (.md upload) ----
  bot.on("message:document", async (ctx) => {
    const lang = toLang(senderLang(ctx, deps.prefs));
    if (!(await gate(ctx, deps, lang))) return;
    const dir = dirOf();
    if (dir === undefined) {
      await safeReply(ctx, tr(lang, "ph3_skills.unavailable"));
      return;
    }
    const doc = documentOf(ctx.message);
    if (doc === undefined) return;
    if (!isSkillInstallCaption(ctx.message?.caption)) return; // not ours; other handlers proceed
    await installFromDocument(ctx, deps, lang, dir, doc, store, downloadDocument);
  });

  // ------------------------------------------------------- review buttons ----
  bot.callbackQuery(new RegExp(`^${CB_PREFIX}:(inst|uninst):([0-9a-f]{32}):(ok|no)$`), async (ctx) => {
    const lang = toLang(senderLang(ctx, deps.prefs));
    try {
      await ctx.answerCallbackQuery();
    } catch {
      // Best effort.
    }
    // Forged callbacks from non-owners die here: the token alone is not
    // authority, and the pending entry is NOT consumed on refusal.
    if (!isOwnerSender(ctx, deps)) {
      await safeReply(ctx, tr(lang, "ph3_skills.owner_only"));
      return;
    }
    const dir = dirOf();
    if (dir === undefined) {
      await safeReply(ctx, tr(lang, "ph3_skills.unavailable"));
      return;
    }
    const match = ctx.callbackQuery.data.match(/^ph3skill:(inst|uninst):([0-9a-f]{32}):(ok|no)$/);
    if (match === null) return;
    const [, kind, token, decision] = match;
    let text: string;
    if (kind === "inst") {
      text =
        decision === "ok"
          ? approvePendingInstall(lang, store, token!, dir)
          : rejectPendingInstall(lang, store, token!);
    } else {
      text =
        decision === "ok"
          ? approvePendingUninstall(lang, store, token!, dir)
          : rejectPendingUninstall(lang, store, token!);
    }
    // Collapse the review card into the result so the buttons cannot be
    // pressed twice.
    try {
      await ctx.editMessageText(text);
    } catch {
      await safeReply(ctx, text);
    }
  });
}

function documentOf(
  msg: { document?: { file_id: string; file_name?: string; file_size?: number } } | undefined,
): DocumentRef | undefined {
  const d = msg?.document;
  if (d === undefined) return undefined;
  return { fileId: d.file_id, fileName: d.file_name, fileSize: d.file_size };
}

async function installFromDocument(
  ctx: Context,
  deps: HermesCommandDeps,
  lang: Ph3SkillsLang,
  dir: string,
  doc: DocumentRef,
  store: PendingStore,
  downloadDocument: (c: Context, fileId: string) => Promise<Uint8Array | undefined>,
): Promise<void> {
  void deps;
  const fileName = doc.fileName ?? "";
  if (!fileName.toLowerCase().endsWith(".md")) {
    await safeReply(ctx, tr(lang, "ph3_skills.install.not_markdown"));
    return;
  }
  // Size cap BEFORE download.
  if (doc.fileSize !== undefined && doc.fileSize > SKILLS_MAX_FILE_BYTES) {
    await safeReply(ctx, tr(lang, "ph3_skills.install.too_large", {
      bytes: formatBytes(doc.fileSize),
      max: formatBytes(SKILLS_MAX_FILE_BYTES),
    }));
    return;
  }
  const bytes = await downloadDocument(ctx, doc.fileId);
  if (bytes === undefined) {
    await safeReply(ctx, tr(lang, "ph3_skills.install.fetch_failed", { reason: fileName }));
    return;
  }
  // ...and re-checked AFTER download (a lying file_size must not smuggle more).
  if (bytes.byteLength > SKILLS_MAX_FILE_BYTES) {
    await safeReply(
      ctx,
      tr(lang, "ph3_skills.install.too_large", {
        bytes: formatBytes(bytes.byteLength),
        max: formatBytes(SKILLS_MAX_FILE_BYTES),
      }),
    );
    return;
  }
  const text = Buffer.from(bytes).toString("utf8");
  const confirm = flagSet(ctx.message?.caption ?? ctx.message?.text, "--confirm");
  const outcome = planInstallFromText(
    lang,
    text,
    tr(lang, "ph3_skills.review.source_file"),
    dir,
    confirm,
  );
  if (outcome.outcome === "review" && outcome.pending !== undefined) {
    const token = store.createInstall(outcome.pending);
    await safeReply(ctx, outcome.text, { reply_markup: installKeyboard(lang, token) });
    return;
  }
  await safeReply(ctx, outcome.text);
}

// Re-exported for tests: the scan is what the review card surfaces.
export { scanSkillBody };
