/**
 * Phase 5, item 6 — `/memory` (owner-only): automatic event extraction
 * control + memory export/import between instances.
 *
 * Subcommands:
 *   /memory auto on|off|status|scan
 *   /memory export
 *   /memory import [--review]     (reply to the package file, or send the
 *                                  file with this caption, or reply to the
 *                                  pasted package text)
 *
 * Conventions (same as the sibling command modules):
 * - owner-only: `isOwnerSender` is checked FIRST in every handler and in the
 *   document handler; a non-owner gets the short refusal and nothing else.
 *   The command is also `ownerOnly` in COMMAND_DEFS, so the public Telegram
 *   menu never shows it (menu hiding is not the security boundary — the
 *   runtime gate is).
 * - fa+en strings via the local `cmd_phase5_memory_strings.ts` table
 *   (prefix `ph5_mem.*`); Persian is ground truth.
 * - logic lives in exported pure-ish `handleXxx` functions over plain
 *   values; the grammy wrappers are thin.
 *
 * This module is NOT registered in index.ts/bot.ts — the coordinator wires
 * `registerPhase5MemoryCommands` (and merges `COMMAND_DEFS` into the menu).
 */
import { Bot, Context, InputFile } from "grammy";
import type { HermesCommandDef, HermesCommandDeps } from "./cmd_context";
import {
  commandArg,
  gateGroup,
  gateUser,
  isOwnerSender,
  senderLang,
} from "./deps";
import type { Lang } from "../i18n/types";
import type { MemoryProvider } from "../memory/provider";
import type { ProposalStore } from "../curator/proposals";
import {
  isAutoExtractEnabled,
  scanForEventCandidates,
  setAutoExtractEnabled,
  type ConversationReader,
  type PrefStore,
} from "../memory/auto_extract";
import {
  applyMemoryImport,
  buildMemoryPackage,
  importProposalsFromPlan,
  MEMORY_PACKAGE_EXT,
  MEMORY_PACKAGE_MAX_BYTES,
  planMemoryImport,
  verifyMemoryPackage,
  type MemoryPackageError,
} from "../memory/mem_share";
import { tr, type Ph5MemLang } from "../i18n/strings/cmd_phase5_memory_strings";
import { fetchTelegramFileBytes } from "./telegram_file";

// ------------------------------------------------------------------ defs ----

export const COMMAND_DEFS: HermesCommandDef[] = [
  {
    command: "memory",
    descriptionEn: "Memory: auto-extract events and sharing",
    ownerOnly: true,
  },
];

/** Optional wiring the coordinator provides at registration time. */
export interface Phase5MemoryOpts {
  /** Per-user prefs (the auto-extract on/off switch). */
  prefs?: PrefStore;
  /** Conversation history reader (the sweep scan). */
  conversations?: ConversationReader;
  /** Long-term memory backend (export/import). */
  provider?: MemoryProvider;
  /** Curator proposal store (import conflicts, auto-extract candidates). */
  proposalStore?: ProposalStore;
  /** Bot token, for downloading uploaded documents. */
  botToken?: string;
  /**
   * Document downloader override (tests). Receives the grammy context and a
   * Telegram file_id, returns the raw bytes or undefined on failure.
   */
  downloadDocument?: (ctx: Context, fileId: string) => Promise<Uint8Array | undefined>;
  /** Injectable clock. */
  now?: () => number;
}

// --------------------------------------------------------------- helpers ----

function toLang(_lang: Lang): Ph5MemLang {
  return "en"; // English-only UI
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
  lang: Ph5MemLang,
): Promise<boolean> {
  if (!isOwnerSender(ctx, deps)) {
    await safeReply(ctx, tr(lang, "ph5_mem.owner_only"));
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
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface DocumentRef {
  fileId: string;
  fileName: string | undefined;
  fileSize: number | undefined;
}

function documentOf(
  msg: { document?: { file_id: string; file_name?: string; file_size?: number } } | undefined,
): DocumentRef | undefined {
  const d = msg?.document;
  if (d === undefined) return undefined;
  return { fileId: d.file_id, fileName: d.file_name, fileSize: d.file_size };
}

/** A caption (or reply text) counts as a memory-import request when it starts with /memory import. */
export function isMemoryImportCaption(caption: string | undefined): boolean {
  if (caption === undefined) return false;
  const first = caption.trim().split(/\s+/, 2);
  if (first.length < 2) return false;
  if (!/^\/memory(@\w+)?$/i.test(first[0]!)) return false;
  return first[1]!.toLowerCase() === "import";
}

// ------------------------------------------------------------------ auto ----

export interface MemoryAutoEnv {
  prefs?: PrefStore;
  conversations?: ConversationReader;
  proposalStore?: ProposalStore;
  provider?: MemoryProvider;
  ownerId?: string;
  now?: () => number;
}

export function memoryAutoAvailable(env: MemoryAutoEnv): boolean {
  return (
    env.prefs !== undefined &&
    env.conversations !== undefined &&
    env.proposalStore !== undefined &&
    env.provider !== undefined &&
    env.ownerId !== undefined
  );
}

/**
 * `/memory auto on|off|status|scan`. Pure-ish over the env: no grammy.
 * `scan` runs the same sweep pass the background timer runs, but as a
 * deeper one-shot over the last 90 days.
 */
export async function handleMemoryAuto(
  lang: Ph5MemLang,
  sub: string | undefined,
  env: MemoryAutoEnv,
): Promise<string> {
  if (!memoryAutoAvailable(env)) return tr(lang, "ph5_mem.unavailable");
  const prefs = env.prefs!;
  const ownerId = env.ownerId!;
  const nowMs = env.now?.() ?? Date.now();
  switch ((sub ?? "status").toLowerCase()) {
    case "on": {
      setAutoExtractEnabled(prefs, ownerId, true);
      return tr(lang, "ph5_mem.auto.on");
    }
    case "off": {
      setAutoExtractEnabled(prefs, ownerId, false);
      return tr(lang, "ph5_mem.auto.off");
    }
    case "status": {
      const state = isAutoExtractEnabled(prefs, ownerId)
        ? tr(lang, "ph5_mem.auto.state_on")
        : tr(lang, "ph5_mem.auto.state_off");
      let pending = 0;
      try {
        pending = env
          .proposalStore!.listPending(ownerId)
          .filter((p) => p.kind === "event").length;
      } catch {
        // Unreadable store = report what we know (zero), honestly.
      }
      return tr(lang, "ph5_mem.auto.status", { state, pending });
    }
    case "scan": {
      if (!isAutoExtractEnabled(prefs, ownerId)) {
        return tr(lang, "ph5_mem.auto.scan_disabled");
      }
      const report = await scanForEventCandidates({
        prefs,
        conversations: env.conversations!,
        provider: env.provider!,
        proposalStore: env.proposalStore!,
        ownerId,
        nowMs,
        // One-shot deep scan: 90 days back, independent of the watermark.
        sinceMs: nowMs - 90 * 24 * 60 * 60 * 1000,
      });
      return tr(lang, "ph5_mem.auto.scan_done", {
        convs: report.conversationsScanned,
        messages: report.messagesScanned,
        candidates: report.candidatesFound,
        proposals: report.newProposals,
      });
    }
    default:
      return tr(lang, "ph5_mem.usage");
  }
}

// ---------------------------------------------------------------- export ----

/**
 * `/memory export`: build a portable `.bobimem` package. Pure over the
 * provider: reads everything, writes nothing. The grammy wrapper sends
 * `text` back as a document named `fileName`.
 */
export async function handleMemoryExport(
  provider: MemoryProvider | undefined,
  userId: string,
  nowMs?: number,
): Promise<
  | { ok: true; fileName: string; text: string; memoryCount: number; eventCount: number }
  | { ok: false; error: "unavailable" | "too_large"; count?: number }
> {
  if (provider === undefined) return { ok: false, error: "unavailable" };
  const res = await buildMemoryPackage(provider, userId, nowMs !== undefined ? { now: () => nowMs } : {});
  if (!res.ok) return { ok: false, error: "too_large", count: res.error.count };
  return {
    ok: true,
    fileName: res.pkg.fileName,
    text: res.pkg.text,
    memoryCount: res.pkg.memoryCount,
    eventCount: res.pkg.eventCount,
  };
}

// ---------------------------------------------------------------- import ----

export interface MemoryImportEnv {
  provider?: MemoryProvider;
  proposalStore?: ProposalStore;
  ownerId?: string;
}

function renderImportError(lang: Ph5MemLang, error: MemoryPackageError): string {
  switch (error.kind) {
    case "too_large":
      return tr(lang, "ph5_mem.import.too_large", {
        bytes: formatBytes(error.bytes),
        max: formatBytes(error.maxBytes),
      });
    case "not_json":
      return tr(lang, "ph5_mem.import.not_json");
    case "bad_envelope":
      return tr(lang, "ph5_mem.import.bad_envelope", { reason: error.reason });
    case "checksum_mismatch":
      return tr(lang, "ph5_mem.import.checksum_mismatch");
    case "bad_entry":
      return tr(lang, "ph5_mem.import.bad_entry", {
        index: error.index,
        reason: error.reason,
      });
  }
}

/**
 * Import a package's text. Verifies → plans (dedup/merge) → applies the
 * direct-write half → files the review half as curator proposals (kind
 * "import"). Conflicts are never silently overwritten; with `reviewAll`
 * even new entries go through proposals.
 */
export async function handleMemoryImportText(
  lang: Ph5MemLang,
  text: string,
  env: MemoryImportEnv,
  reviewAll: boolean,
): Promise<string> {
  if (env.provider === undefined || env.proposalStore === undefined || env.ownerId === undefined) {
    return tr(lang, "ph5_mem.unavailable");
  }
  const verified = verifyMemoryPackage(text);
  if (!verified.ok) return renderImportError(lang, verified.error);
  const plan = await planMemoryImport(env.provider, env.ownerId, verified.pkg, { reviewAll });
  const applied = await applyMemoryImport(env.provider, env.ownerId, plan);
  const proposals = importProposalsFromPlan(plan);
  if (proposals.length > 0) {
    env.proposalStore.saveProposals(env.ownerId, proposals);
  }
  const review =
    proposals.length > 0
      ? tr(lang, "ph5_mem.import.review_suffix", { proposals: proposals.length })
      : "";
  return tr(lang, "ph5_mem.import.done", {
    memories: applied.memoriesAdded,
    events: applied.eventsAdded,
    skipped: plan.skipped,
    review,
  });
}

// -------------------------------------------------------------- register ----

/**
 * Register the phase-5 memory commands. The coordinator calls this; nothing
 * here is wired in index.ts/bot.ts by this module.
 */
export function registerPhase5MemoryCommands(
  bot: Bot,
  deps: HermesCommandDeps,
  opts: Phase5MemoryOpts = {},
): void {
  const now = opts.now ?? Date.now;

  const envOf = (): MemoryAutoEnv => ({
    ...(opts.prefs !== undefined ? { prefs: opts.prefs } : {}),
    ...(opts.conversations !== undefined ? { conversations: opts.conversations } : {}),
    ...(opts.proposalStore !== undefined ? { proposalStore: opts.proposalStore } : {}),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(deps.ownerId !== undefined ? { ownerId: String(deps.ownerId) } : {}),
    now,
  });

  const importEnvOf = (): MemoryImportEnv => ({
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.proposalStore !== undefined ? { proposalStore: opts.proposalStore } : {}),
    ...(deps.ownerId !== undefined ? { ownerId: String(deps.ownerId) } : {}),
  });

  /**
   * Download an uploaded document's bytes via the shared Telegram file
   * fetch (timeout + streaming cap at MEMORY_PACKAGE_MAX_BYTES).
   */
  const downloadDocument = async (
    c: Context,
    fileId: string,
  ): Promise<Uint8Array | undefined> => {
    if (opts.downloadDocument !== undefined) return opts.downloadDocument(c, fileId);
    if (opts.botToken === undefined) return undefined;
    return fetchTelegramFileBytes(c.api, opts.botToken, fileId, {
      maxBytes: MEMORY_PACKAGE_MAX_BYTES,
    });
  };

  const importFromDocument = async (
    ctx: Context,
    lang: Ph5MemLang,
    doc: DocumentRef,
    reviewAll: boolean,
  ): Promise<void> => {
    if (doc.fileSize !== undefined && doc.fileSize > MEMORY_PACKAGE_MAX_BYTES) {
      await safeReply(
        ctx,
        tr(lang, "ph5_mem.import.too_large", {
          bytes: formatBytes(doc.fileSize),
          max: formatBytes(MEMORY_PACKAGE_MAX_BYTES),
        }),
      );
      return;
    }
    const bytes = await downloadDocument(ctx, doc.fileId);
    if (bytes === undefined) {
      await safeReply(ctx, tr(lang, "ph5_mem.import.download_failed"));
      return;
    }
    await safeReply(
      ctx,
      await handleMemoryImportText(lang, Buffer.from(bytes).toString("utf8"), importEnvOf(), reviewAll),
    );
  };

  // ------------------------------------------------------------- /memory ----
  bot.command("memory", async (ctx) => {
    const lang = toLang(senderLang(ctx, deps.prefs));
    if (!(await gate(ctx, deps, lang))) return;
    const arg = messageArg(ctx);
    const parts = (arg ?? "").trim().split(/\s+/).filter((p) => p.length > 0);
    const sub = parts[0]?.toLowerCase();

    // Reply-to-document import: "/memory import" as a reply to the file.
    const repliedDoc = documentOf(ctx.message?.reply_to_message);
    if (sub === "import" && repliedDoc !== undefined) {
      await importFromDocument(ctx, lang, repliedDoc, flagSet(arg, "--review"));
      return;
    }
    // Reply-to-text: the package pasted into a message.
    if (sub === "import") {
      const repliedText = ctx.message?.reply_to_message?.text;
      if (typeof repliedText === "string" && repliedText.trim().length > 0) {
        await safeReply(
          ctx,
          await handleMemoryImportText(lang, repliedText, importEnvOf(), flagSet(arg, "--review")),
        );
        return;
      }
      await safeReply(ctx, tr(lang, "ph5_mem.import.no_source"));
      return;
    }

    switch (sub) {
      case "auto": {
        await safeReply(ctx, await handleMemoryAuto(lang, parts[1], envOf()));
        return;
      }
      case "export": {
        const res = await handleMemoryExport(opts.provider, String(deps.ownerId ?? ""), now());
        if (!res.ok) {
          await safeReply(
            ctx,
            res.error === "too_large"
              ? tr(lang, "ph5_mem.export.too_large", { count: res.count ?? 0 })
              : tr(lang, "ph5_mem.export.failed"),
          );
          return;
        }
        try {
          await ctx.replyWithDocument(new InputFile(Buffer.from(res.text, "utf8"), res.fileName), {
            caption: tr(lang, "ph5_mem.export.done", {
              memories: res.memoryCount,
              events: res.eventCount,
            }),
          });
        } catch {
          await safeReply(ctx, tr(lang, "ph5_mem.export.failed"));
        }
        return;
      }
      default:
        await safeReply(ctx, tr(lang, "ph5_mem.usage"));
        return;
    }
  });

  // --------------------------------------- document import (.bobimem upload) ----
  bot.on("message:document", async (ctx) => {
    const lang = toLang(senderLang(ctx, deps.prefs));
    if (!(await gate(ctx, deps, lang))) return;
    const doc = documentOf(ctx.message);
    if (doc === undefined) return;
    if (doc.fileName !== undefined && !doc.fileName.endsWith(MEMORY_PACKAGE_EXT)) {
      // Not ours; other handlers proceed.
      return;
    }
    const caption = ctx.message?.caption;
    if (isMemoryImportCaption(caption)) {
      await importFromDocument(ctx, lang, doc, flagSet(caption ?? undefined, "--review"));
      return;
    }
    // not ours; other handlers proceed
  });
}
