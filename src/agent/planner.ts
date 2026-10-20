/**
 * Planning mode — one cheap provider call before the first iteration, only for
 * requests that actually need a plan.
 *
 * Planning is opt-in per task: it fires when the request has multi-task
 * structure (explicit numbered steps, or several distinct imperatives) AND the
 * conversation already has some history. Trivial single-turn chats skip it:
 * a plan for "hi" would cost a provider call and read as a broken bot.
 *
 * The plan itself is advisory — the loop carries it as a system note and the
 * model works through it. If parsing or the provider call fails, the run
 * proceeds exactly as it would have without planning.
 */

import type { ChatMessage } from "../ai/provider";

export const PLAN_MAX_STEPS = 5;
export const PLAN_MAX_WORDS = 12;
/** Tokens budgeted for the plan call — plans are lists, not essays. */
export const PLAN_MAX_TOKENS = 128;

export const PLAN_SYSTEM_PROMPT =
  "You are a planner for a Telegram assistant. Read the user's request and " +
  "output ONLY a JSON array of at most 5 short steps, each at most 12 words, " +
  "in the order they should be done. No commentary, no code fences. " +
  'Example: ["Search flights to Tehran", "Compare the three cheapest"]';

/** Numbered/enumerated step markers: "1. …", "2) …", "- …", "• …". */
const STEP_MARKER_RE = /(?:^|\n)\s*(?:\d{1,2}[.)]|[-*•])\s+\S/g;

/** Imperative clause starts, English and Persian. Leading discourse markers ("Then…", "بعد…") are allowed before the verb. */
const IMPERATIVE_RE =
  /^(?:(?:please|then|next|and then|afterwards|after that|بعد|بعدش|سپس)\s+)?(?:add|create|make|set|send|fetch|find|search|check|get|calculate|compute|schedule|remind|delete|remove|update|list|show|tell|summarise|summarize|translate|download|book|open|close|start|run|بفرست|بزن|بگیر|بده|بگو|حساب|محاسبه|پیدا|جستجو|اضافه|حذف|تنظیم|لیست|نمایش|دانلود|ترجمه|خلاصه|بساز)\b/i;

/** Persian imperative verbs anywhere in a clause (SOV word order). */
const FA_IMPERATIVE_ANYWHERE_RE =
  /(?:^|\s)(بفرست|بزن|بگیر|بده|بگو|حساب|محاسبه|پیدا|جستجو|اضافه|حذف|تنظیم|لیست|نمایش|دانلود|ترجمه|خلاصه|بساز)(?:\s|$)/;

/** True when the text has multi-task structure. */
export function looksMultiTask(text: string): boolean {
  const markers = text.match(STEP_MARKER_RE);
  if (markers !== null && markers.length >= 2) return true;

  let imperatives = 0;
  for (const clause of text.split(/[.!?;\n،؛]+/)) {
    const trimmed = clause.trim();
    // English imperatives start the clause; Persian is SOV, so an imperative
    // verb anywhere in the clause counts ("یه یادآوری بزن").
    if (IMPERATIVE_RE.test(trimmed) || FA_IMPERATIVE_ANYWHERE_RE.test(trimmed)) imperatives++;
  }
  return imperatives >= 2;
}

/**
 * Whether the loop should ask for a plan before the first iteration.
 *
 * `lastUserText` is the newest user turn; `historyLen` counts the messages
 * before it. Trivial chats (no structure AND short history) skip planning.
 */
export function shouldPlan(lastUserText: string, historyLen: number): boolean {
  return looksMultiTask(lastUserText) && historyLen >= 3;
}

/**
 * Parse a plan from the model's reply. Accepts a bare JSON array or one
 * wrapped in code fences. Returns null for anything that is not a usable
 * list — planning is advisory, never blocking.
 */
export function parsePlan(text: string): string[] | null {
  let clean = text.trim();
  const fence = clean.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence !== null) clean = fence[1]!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const steps: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") return null;
    const words = entry.trim().split(/\s+/);
    if (words.length === 0 || words[0] === "") return null;
    steps.push(words.slice(0, PLAN_MAX_WORDS).join(" "));
    if (steps.length >= PLAN_MAX_STEPS) break;
  }
  return steps.length > 0 ? steps : null;
}

/** The system note the loop carries once a plan is accepted. */
export function planNote(steps: readonly string[]): string {
  const lines = steps.map((s, i) => `${i + 1}. ${s}`);
  return `<plan>\nWork through these steps in order:\n${lines.join("\n")}\n</plan>`;
}

/** Messages for the plan call: a standalone planner turn. */
export function planMessages(userText: string): ChatMessage[] {
  return [
    { role: "system", content: PLAN_SYSTEM_PROMPT },
    { role: "user", content: userText },
  ];
}
