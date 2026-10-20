/**
 * Phase-4 item 4 — scheduled group digests (owner's DM, zero LLM).
 *
 * What this is: for groups where the assistant mode is enabled, the owner may
 * additionally enable a DAILY digest delivered to the OWNER's private chat at
 * a configured time (Asia/Tehran). The group itself stays silent — nothing is
 * posted into the group by this feature.
 *
 * The digest content is the same deterministic statistical summary /gsummary
 * uses (see buildSummaryText): counts, top speakers, top words. NO LLM is
 * involved, so embedded instructions inside group messages have nothing to
 * steer — this keeps the Phase-3 injection-surface decision intact.
 *
 * PHASE-5 ADDENDUM (opt-in LLM layer): when the owner enables
 * `/gassistant smart` for the group, the digest additionally requests an
 * LLM smart summary (see smart_summary.ts — structural isolation, not
 * pattern-stripping). The smart section is appended AFTER the deterministic
 * one and is delivered ONLY to the owner's DM (never the group). Any smart
 * failure degrades to the deterministic digest — the scheduled digest keeps
 * working even if the smart layer fails. No provider wired → deterministic
 * only, exactly like before.
 *
 * Mechanics: the digest is a regular scheduled task (see src/tools/
 * scheduled_tasks.ts) whose action is {type:"tool", tool:"group_digest"}.
 * The tool is owner-only, runs with the task creator's live actor, reads the
 * config from the OWNER's own prefs (owner-scoped, like the assistant config),
 * builds the summary from the in-memory history buffer, and notifies the
 * owner through an injected notifyOwner channel wired to the owner's DM.
 *
 * ATTACK-SURFACE REVIEW (part of the module contract):
 *
 * 1. Delivery target is FIXED server-side: the injected ownerId / notifyOwner
 *    channel (the owner's DM). The task row's chatId is only the GROUP whose
 *    history is read — it never becomes a send destination.
 * 2. The tool's chatId input is validated (bounded numeric id) and is only
 *    ever used to READ the owner's own config blob and the in-memory buffer;
 *    a foreign chatId yields the disabled default (fail-closed).
 * 3. Group message content flows through the same sanitization as /gsummary:
 *    display names are one-lined/truncated, raw message text is never quoted
 *    verbatim (only single extracted topic words), inputs are capped
 *    (MAX_MESSAGE_CHARS, SUMMARY_INPUT_MAX_MESSAGES). The digest text is
 *    sent as a plain Telegram message — quoted/escaped, never executed, and
 *    no prompt content built from group text reaches an LLM in this item.
 * 4. Task rows are owner-created and owner-executed: group members cannot
 *    create, read, or alter a digest schedule; /gassistant digest is owner-
 *    gated at the command layer and re-checked in the handlers.
 * 5. The history buffer is in-memory only (see createGroupHistory): after a
 *    restart the digest may report "not enough messages" until chatter
 *    refills it. That is the safe failure direction (no stale cross-restart
 *    retention).
 */
import { ToolError } from "../tools/errors";
import { defineManifest } from "../tools/manifest";
import type { ToolManifest } from "../tools/manifest";
import type { Tool, ToolContext } from "../tools/types";
import {
  buildSummaryText,
  getAssistantConfig,
  type AssistantPrefStore,
  type DigestSchedulePort,
  type GroupHistory,
} from "./assistant";
import { tr, type AssistantLang } from "./assistant_strings";
import { summarizeSmart, type SmartSummaryPort } from "./smart_summary";

export const GROUP_DIGEST_TOOL_NAME = "group_digest";
export const GROUP_DIGEST_PERMISSION = "tools:group_digest";

/** Default digest time (Asia/Tehran), used when the owner never set one. */
export const DEFAULT_DIGEST_TIME = "08:00";

/** A digest task's fixed name, one per group chat. */
export function digestTaskName(chatId: string): string {
  return `group_digest:${chatId}`;
}

/** Telegram group chat ids are numeric (optionally negative). */
const CHAT_ID_RE = /^-?\d{1,20}$/;

/** "HH:MM" 24-hour clock. */
const DIGEST_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type DigestTimeValidation =
  | { ok: true; time: string }
  | { ok: false };

/**
 * Validate an owner-supplied digest time ("HH:MM", 24-hour).
 * Pure — the handler maps a failure to the bad_time string.
 */
export function validateDigestTime(raw: unknown): DigestTimeValidation {
  if (typeof raw !== "string") return { ok: false };
  const t = raw.trim();
  return DIGEST_TIME_RE.test(t) ? { ok: true, time: t } : { ok: false };
}

/**
 * Convert a validated "HH:MM" time into a daily cron expression.
 *
 * Throws on invalid input: callers must validate first (validateDigestTime).
 */
export function digestTimeToCron(time: string): string {
  const v = validateDigestTime(time);
  if (!v.ok) throw new Error(`invalid digest time: ${time}`);
  const [hh, mm] = v.time.split(":");
  return `${Number(mm)} ${Number(hh)} * * *`;
}

// ------------------------------------------------------------------ tool ----

export interface GroupDigestInput {
  chatId: string;
}

export interface GroupDigestOutput {
  delivered: boolean;
  /** Messages the summary window spanned (0 when not delivered). */
  messages: number;
}

export interface GroupDigestToolDeps {
  /** Pref store (Storage satisfies this). Absent → config reads fail closed. */
  storage?: AssistantPrefStore;
  /** Bot owner's numeric Telegram id, as a string. */
  ownerId: string;
  /** Server-supplied owner check. */
  isOwner: (userId: string) => boolean;
  /** The message buffer the digests read from. */
  history: GroupHistory;
  /**
   * Proactive channel to the owner (the coordinator wires this to the
   * owner's DM) — never a group, never another user.
   */
  notifyOwner: (text: string) => Promise<void>;
  /** Owner's /lang; the digest is bilingual like everything else. */
  ownerLang: () => AssistantLang;
  /**
   * Phase-5: LLM smart-summary port, wired by the coordinator to the AI
   * gateway (only when a real provider is configured). Absent → the digest
   * stays deterministic. Failures degrade to deterministic — the digest
   * keeps working even if the smart layer fails.
   */
  smart?: SmartSummaryPort | undefined;
  /** Diagnostic log for notify failures etc. */
  log?: (message: string) => void;
}

/** The owner id for this call, from the server-supplied actor, double-checked. */
function ownerOf(ctx: ToolContext, deps: GroupDigestToolDeps): string {
  const id = ctx.actor.userId;
  if (typeof id !== "string" || id.length === 0 || id === "unknown") {
    throw new ToolError("not_allowed", "هویت مشخص نیست.");
  }
  if (!deps.isOwner(id)) {
    throw new ToolError("not_allowed", "خلاصهٔ زمان‌بندی‌شدهٔ گروه فقط برای مالک است.");
  }
  return id;
}

/** Notify failures must never fail the digest run: the scheduler marks the
 *  task from the tool's own return, not from the side channel. */
async function safeNotify(
  deps: GroupDigestToolDeps,
  text: string,
): Promise<void> {
  try {
    await deps.notifyOwner(text);
  } catch (err) {
    deps.log?.(`group_digest notify failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Build the DM text for one group's digest: a header line identifying the
 * group (chat id stays Latin so it can be copied verbatim) + the
 * deterministic statistical summary. Pure — unit-testable.
 */
export function buildGroupDigestText(
  chatId: string,
  messages: Parameters<typeof buildSummaryText>[0],
  lang: AssistantLang = "fa",
): string {
  const header = tr(lang, "gassistant.digest.header", { chat: chatId });
  return `${header}\n${buildSummaryText(messages, lang)}`;
}

export const groupDigestManifest: ToolManifest = defineManifest({
  id: "group_digest",
  version: "1.0.0",
  title: "Group Digest",
  purpose: "daily group recap",
  useWhen: "group digest due",
  doNotUseWhen:
    "Never posts into the group; for the owner's own daily digest use build_digest instead.",
  confusableWith: [
    {
      tool: "build_digest",
      difference: "build_digest is the owner's personal digest; group_digest summarizes one group.",
    },
    {
      tool: "schedule_task",
      difference: "schedule_task creates the schedule; group_digest is the action it runs.",
    },
  ],
  latencyTier: "seconds",
  description:
    "Build one group's statistical digest (counts, top speakers, top words) and deliver it to the owner's DM only. Optional smart layer adds an LLM summary; owner-only.",
  outputSummary: "Whether the digest was delivered and how many messages it spanned.",
  category: "groups",
  costTier: "cheap",
});

export function createGroupDigestTool(deps: GroupDigestToolDeps): Tool<GroupDigestInput, GroupDigestOutput> {
  return {
    name: GROUP_DIGEST_TOOL_NAME,
    manifest: groupDigestManifest,
    description:
      "خلاصهٔ روزانهٔ آماری گروه را به مالک ارسال می‌کند (فقط مالک؛ بدون مدل زبانی، مگر خلاصهٔ هوشمند فعال باشد).",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [GROUP_DIGEST_PERMISSION] },
    toolset: "schedule",
    input: {
      fields: {
        chatId: {
          type: "string",
          required: true,
          description: "شناسهٔ عددی گروهی که خلاصه‌اش ساخته می‌شود.",
          minLength: 1,
          maxLength: 24,
        },
      },
    },

    async run(input: GroupDigestInput, ctx: ToolContext): Promise<GroupDigestOutput> {
      const ownerId = ownerOf(ctx, deps);

      const chatId = typeof input.chatId === "string" ? input.chatId.trim() : "";
      if (!CHAT_ID_RE.test(chatId)) {
        throw new ToolError("invalid_input", "شناسهٔ گروه نامعتبر است.");
      }

      // The config lives under the OWNER's id (never the caller's text): a
      // group whose mode or digest was turned off after scheduling silently
      // no-ops instead of sending a stale digest.
      const cfg = getAssistantConfig(deps.storage, ownerId, chatId);
      if (!cfg.enabled || !cfg.digestEnabled) {
        return { delivered: false, messages: 0 };
      }

      const lang = deps.ownerLang();
      const messages = deps.history.recent(chatId, cfg.summaryMaxMessages);
      const baseText = buildGroupDigestText(chatId, messages, lang);
      // Phase-5 smart layer: attempted only when the owner opted in; any
      // failure (no port, provider error, empty reply) degrades to the
      // deterministic digest — the schedule keeps working either way.
      const result = await summarizeSmart({
        messages,
        lang,
        cfg,
        port: deps.smart,
        fallbackText: baseText,
      });
      await safeNotify(deps, result.text);
      return { delivered: true, messages: messages.length };
    },
  };
}

// -------------------------------------------- digest task row management ----

/** One row of what the port needs from list_tasks. */
export interface DigestTaskRow {
  id: number;
  name: string;
}

/**
 * The task-row calls the port performs, expressed as injectable functions so
 * the replace-don't-duplicate logic is unit-testable without a ToolService.
 */
export interface DigestTaskCalls {
  list(): Promise<DigestTaskRow[]>;
  create(args: { name: string; cron: string; timezone: string; chatId: string }): Promise<number>;
  cancel(id: number): Promise<void>;
}

/**
 * Ensure exactly one digest task exists for a group: cancel any previous
 * task with the fixed name, then create the new one at the given time.
 *
 * Pure row logic over injected calls; the coordinator supplies the real
 * schedule_task/list_tasks/cancel_task wiring. Throws only when creation
 * itself fails (callers translate that into a generic user message).
 */
export async function ensureGroupDigestTask(
  calls: DigestTaskCalls,
  chatId: string,
  timeHHMM: string,
): Promise<number> {
  const name = digestTaskName(chatId);
  const rows = await calls.list();
  for (const row of rows) {
    if (row.name === name) {
      try {
        await calls.cancel(row.id);
      } catch {
        // Best effort: a stale row that refuses to cancel must not block
        // the new schedule; the old row keeps its old time until it runs
        // out or the owner cancels it manually via list_tasks/cancel_task.
      }
    }
  }
  return calls.create({
    name,
    cron: digestTimeToCron(timeHHMM),
    timezone: "Asia/Tehran",
    chatId,
  });
}

/**
 * Cancel the digest task for a group, if one exists. Never throws: a
 * missing task is the normal "already off" case.
 */
export async function cancelGroupDigestTask(
  calls: DigestTaskCalls,
  chatId: string,
): Promise<void> {
  const name = digestTaskName(chatId);
  let rows: DigestTaskRow[];
  try {
    rows = await calls.list();
  } catch {
    return;
  }
  for (const row of rows) {
    if (row.name === name) {
      try {
        await calls.cancel(row.id);
      } catch {
        // Best effort — see ensureGroupDigestTask.
      }
    }
  }
}
