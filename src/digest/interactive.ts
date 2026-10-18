/**
 * Interactive digest — the on-demand, tap-to-act product layer over the
 * digest builder (Phase-2 item 3).
 *
 * This module is PURE (no Telegram I/O, no storage writes): it defines the
 * `dgst:` callback protocol, strictly parses callback data, and renders the
 * digest text + inline keyboard in the owner's language. All mutations live
 * in src/bot/digest_cmd.ts, which calls back into these renderers after
 * every action so the message refreshes in place.
 *
 * Callback protocol (namespace "dgst:"):
 *   dgst:refresh            — rebuild the digest and refresh the message
 *   dgst:back               — back to the digest from the proposals view
 *   dgst:props              — open the curator-proposal review view
 *   dgst:task:run:<id>      — run a scheduled task's action once, now
 *   dgst:task:del:<id>      — arm the two-step delete confirm for a task row
 *   dgst:task:delc:<id>     — confirm the task deletion
 *   dgst:task:delx:<id>     — cancel the delete confirm
 *   dgst:rem:done:<id>      — mark a reminder done (cancel it)
 *   dgst:mem:show:<index>   — show the full memory entry (index into the
 *                             digest's memory list, resolved at tap time)
 *   dgst:prop:ok:<pid>      — approve a curator proposal (cur- + 16 hex)
 *   dgst:prop:no:<pid>      — reject a curator proposal
 *
 * SECURITY notes (callback forgery — mirrors the palette's strictness):
 * - parseDigestCallback is strict: ids are 1–10 plain digits, the memory
 *   index is a single digit, and proposal ids must match the store's
 *   `cur-<16 hex>` shape exactly. Anything else is rejected and safely
 *   ignored (the query is still answered so Telegram stops the spinner).
 * - No user-controlled text is ever interpolated into callback data; every
 *   payload is server-generated from storage ids. Ownership is re-checked
 *   server-side on every tap (see digest_cmd.ts) — hiding buttons is not
 *   the boundary.
 * - The digest message is sent as PLAIN TEXT (no parse_mode): a memory or
 *   task name containing markdown/control characters cannot break the
 *   message or inject fake buttons.
 */
import { InlineKeyboard } from "grammy";
import { t, type Lang } from "../i18n";
import {
  fitDigestSections,
  renderDigestText,
  type DigestSectionData,
} from "./builder";

/** Callback-data namespace for the interactive digest. Stable, machine-readable. */
export const DIGEST_CALLBACK_PREFIX = "dgst:";

/**
 * Text budget for the interactive digest message. Telegram caps messages at
 * 4096 chars; 3500 leaves headroom for the closer and avoids a hard cut in
 * normal use. Sections that do not fit are dropped (header always survives).
 */
export const INTERACTIVE_DIGEST_MAX_CHARS = 3500;

export type DigestAction =
  | { kind: "refresh" }
  | { kind: "back" }
  | { kind: "props" }
  | { kind: "task:run"; id: number }
  | { kind: "task:del"; id: number }
  | { kind: "task:delc"; id: number }
  | { kind: "task:delx"; id: number }
  | { kind: "rem:done"; id: number }
  | { kind: "mem:show"; index: number }
  | { kind: "prop:ok"; proposalId: string }
  | { kind: "prop:no"; proposalId: string };

const ID_RE = /^\d{1,10}$/;
const INDEX_RE = /^\d$/;
/** Proposal ids are store-generated: "cur-" + 16 lowercase hex (see curator). */
const PROPOSAL_ID_RE = /^cur-[0-9a-f]{16}$/;

/**
 * Strictly parse digest callback data. Returns undefined for anything that
 * is not exactly one of the server-generated shapes — forged, truncated, or
 * mistyped payloads are rejected, never executed. Pure, for tests.
 */
export function parseDigestCallback(data: string): DigestAction | undefined {
  if (!data.startsWith(DIGEST_CALLBACK_PREFIX)) return undefined;
  const rest = data.slice(DIGEST_CALLBACK_PREFIX.length);
  if (rest === "refresh") return { kind: "refresh" };
  if (rest === "back") return { kind: "back" };
  if (rest === "props") return { kind: "props" };
  const parts = rest.split(":");
  if (parts.length !== 3) return undefined;
  const [ns, op, arg] = parts as [string, string, string];
  if (ns === "task") {
    if (!ID_RE.test(arg)) return undefined;
    const id = Number(arg);
    if (op === "run") return { kind: "task:run", id };
    if (op === "del") return { kind: "task:del", id };
    if (op === "delc") return { kind: "task:delc", id };
    if (op === "delx") return { kind: "task:delx", id };
    return undefined;
  }
  if (ns === "rem" && op === "done") {
    if (!ID_RE.test(arg)) return undefined;
    return { kind: "rem:done", id: Number(arg) };
  }
  if (ns === "mem" && op === "show") {
    if (!INDEX_RE.test(arg)) return undefined;
    return { kind: "mem:show", index: Number(arg) };
  }
  if (ns === "prop") {
    if (!PROPOSAL_ID_RE.test(arg)) return undefined;
    if (op === "ok") return { kind: "prop:ok", proposalId: arg };
    if (op === "no") return { kind: "prop:no", proposalId: arg };
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Two-step delete confirm state: which task row is asking "are you sure?". */
export interface DigestDeleteConfirm {
  kind: "task";
  id: number;
}

export interface DigestRenderOpts {
  lang?: Lang;
  /** When set, that task row renders the confirm/cancel pair instead. */
  confirm?: DigestDeleteConfirm;
  /** When false, the per-task run button is omitted (no runner wired). */
  canRunTask?: boolean;
  maxChars?: number;
}

export interface DigestRender {
  text: string;
  keyboard: InlineKeyboard;
}

function taskSection(data: readonly DigestSectionData[]): Extract<DigestSectionData, { kind: "tasks" }> | undefined {
  return data.find((s) => s.kind === "tasks") as
    | Extract<DigestSectionData, { kind: "tasks" }>
    | undefined;
}

function remindersSection(
  data: readonly DigestSectionData[],
): Extract<DigestSectionData, { kind: "reminders" }> | undefined {
  return data.find((s) => s.kind === "reminders") as
    | Extract<DigestSectionData, { kind: "reminders" }>
    | undefined;
}

function proposalsSection(
  data: readonly DigestSectionData[],
): Extract<DigestSectionData, { kind: "proposals" }> | undefined {
  return data.find((s) => s.kind === "proposals") as
    | Extract<DigestSectionData, { kind: "proposals" }>
    | undefined;
}

function memoriesSection(
  data: readonly DigestSectionData[],
): Extract<DigestSectionData, { kind: "memories" }> | undefined {
  return data.find((s) => s.kind === "memories") as
    | Extract<DigestSectionData, { kind: "memories" }>
    | undefined;
}

/**
 * Render the interactive digest: text (fitted to the budget, header always
 * survives) + the tap-to-act keyboard built from the SAME surviving
 * sections, so buttons never point at dropped content. Pure, for tests.
 */
export function renderInteractiveDigest(
  data: readonly DigestSectionData[],
  opts: DigestRenderOpts = {},
): DigestRender {
  const lang: Lang = opts.lang ?? "fa";
  const maxChars = opts.maxChars ?? INTERACTIVE_DIGEST_MAX_CHARS;
  const kept = fitDigestSections(data, lang, maxChars);
  const text = renderDigestText(kept, lang, maxChars);
  const keyboard = buildDigestKeyboard(kept, {
    lang,
    ...(opts.confirm !== undefined ? { confirm: opts.confirm } : {}),
    canRunTask: opts.canRunTask ?? true,
  });
  return { text, keyboard };
}

/** The tap-to-act keyboard for the surviving digest sections. Pure, for tests. */
export function buildDigestKeyboard(
  data: readonly DigestSectionData[],
  opts: { lang?: Lang; confirm?: DigestDeleteConfirm; canRunTask?: boolean } = {},
): InlineKeyboard {
  const lang: Lang = opts.lang ?? "fa";
  const canRunTask = opts.canRunTask ?? true;
  const kb = new InlineKeyboard();

  const tasks = taskSection(data);
  if (tasks !== undefined) {
    for (const item of tasks.items) {
      if (opts.confirm?.kind === "task" && opts.confirm.id === item.id) {
        kb.text(
          t("digest.btn.task_confirm_yes", lang),
          `${DIGEST_CALLBACK_PREFIX}task:delc:${item.id}`,
        ).text(
          t("digest.btn.task_confirm_no", lang),
          `${DIGEST_CALLBACK_PREFIX}task:delx:${item.id}`,
        );
      } else {
        if (canRunTask) {
          kb.text(
            t("digest.btn.task_run", lang),
            `${DIGEST_CALLBACK_PREFIX}task:run:${item.id}`,
          );
        }
        kb.text(
          t("digest.btn.task_delete", lang),
          `${DIGEST_CALLBACK_PREFIX}task:del:${item.id}`,
        );
      }
      kb.row();
    }
  }

  const reminders = remindersSection(data);
  if (reminders !== undefined) {
    for (const item of reminders.items) {
      kb.text(
        t("digest.btn.reminder_done", lang),
        `${DIGEST_CALLBACK_PREFIX}rem:done:${item.id}`,
      ).row();
    }
  }

  if (proposalsSection(data) !== undefined) {
    kb.text(
      t("digest.btn.proposals_review", lang),
      `${DIGEST_CALLBACK_PREFIX}props`,
    ).row();
  }

  const memories = memoriesSection(data);
  if (memories !== undefined) {
    for (let index = 0; index < memories.items.length; index++) {
      kb.text(
        t("digest.btn.memory_details", lang),
        `${DIGEST_CALLBACK_PREFIX}mem:show:${index}`,
      ).row();
    }
  }

  kb.text(t("digest.btn.refresh", lang), `${DIGEST_CALLBACK_PREFIX}refresh`);
  return kb;
}

// ---------------------------------------------------------------------------
// Curator proposal review view
// ---------------------------------------------------------------------------

/** One pending proposal for the review view (summary shown as stored). */
export interface DigestProposalRow {
  id: string;
  /** The stored summary (Persian in the current store); shown as-is. */
  summary: string;
}

/**
 * The proposal review view: each pending proposal with approve/reject
 * buttons, plus a back button to the digest. Pure, for tests.
 */
export function renderProposalsView(
  proposals: readonly DigestProposalRow[],
  lang: Lang = "fa",
): { text: string; keyboard: InlineKeyboard } {
  const kb = new InlineKeyboard();
  if (proposals.length === 0) {
    kb.text(t("digest.btn.back", lang), `${DIGEST_CALLBACK_PREFIX}back`);
    return {
      text: [t("digest.proposals_view.title", lang), "", t("digest.proposals_view.empty", lang)].join("\n"),
      keyboard: kb,
    };
  }
  const lines = proposals.map((p) =>
    t("digest.proposals_view.item", lang, { summary: clipSummary(p.summary) }),
  );
  const text = [
    t("digest.proposals_view.title", lang),
    "",
    t("digest.proposals_view.hint", lang),
    ...lines,
  ].join("\n");
  for (const p of proposals) {
    kb.text(
      t("digest.btn.proposal_approve", lang),
      `${DIGEST_CALLBACK_PREFIX}prop:ok:${p.id}`,
    ).text(
      t("digest.btn.proposal_reject", lang),
      `${DIGEST_CALLBACK_PREFIX}prop:no:${p.id}`,
    ).row();
  }
  kb.text(t("digest.btn.back", lang), `${DIGEST_CALLBACK_PREFIX}back`);
  return { text, keyboard: kb };
}

function clipSummary(summary: string): string {
  const v = summary.replace(/\s+/g, " ").trim();
  return v.length <= 120 ? v : `${v.slice(0, 119)}…`;
}

// ---------------------------------------------------------------------------
// Memory detail card
// ---------------------------------------------------------------------------

/** One memory entry for the detail card. */
export interface DigestMemoryCard {
  key: string;
  content: string;
  /** unix ms */
  createdAt: number;
}

/**
 * The full memory entry as a follow-up message (plain text, capped so a
 * pathological entry cannot blow past the Telegram limit). Pure, for tests.
 */
export function renderMemoryCard(
  memory: DigestMemoryCard,
  lang: Lang = "fa",
): string {
  const date = new Intl.DateTimeFormat(lang === "fa" ? "fa-IR" : "en-US", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(memory.createdAt));
  const content =
    memory.content.length <= 3500 ? memory.content : `${memory.content.slice(0, 3499)}…`;
  return [
    t("digest.memory_card.title", lang),
    "",
    content,
    "",
    t("digest.memory_card.key", lang, { key: memory.key }),
    t("digest.memory_card.saved", lang, { date }),
  ].join("\n");
}
