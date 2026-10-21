/**
 * Per-turn context budgeting: tool-result compaction + budget enforcement.
 *
 * The engine assembles system prompt + history + memories + the live turn
 * for every provider call, but a model's window is finite and a long chat
 * silently overflows it. This module keeps ONE measured budget:
 *
 *   target = min(model window if known, 32k default; BOBI_CONTEXT_TOKEN_BUDGET)
 *
 * Two mechanisms live here:
 *
 * 1. Tool-result compaction (head+tail, or structural for JSON). A single
 *    tool result over TOOL_RESULT_TOKEN_LIMIT tokens keeps its first 40 and
 *    last 20 lines with an elision marker in between — UNLESS it is a
 *    wrapped tool_result whose body parses as JSON, in which case the JSON
 *    is truncated structurally (§4.7: truncateJsonForModel) and re-wrapped,
 *    so the replayed body still parses. The FULL result is available for its
 *    own turn (the agent loop's live context); compaction only applies when
 *    the result is replayed from history — so history carries the shape of
 *    the result, not its full bulk.
 *
 * 2. Budget enforcement. If the assembled context still exceeds the budget,
 *    it is cut in this order:
 *      a. old tool results (already-compacted history) → one-line summaries
 *      b. old history dropped by priority (prioritize.ts): filler and stale
 *         middle turns first, pinned/fact/correction turns last. The rolling
 *         summary fold itself happens between turns at the 60% trigger in
 *         the engine's compactedHistory, never as a blocking extra call
 *         mid-assembly.
 *      c. memories/history → top-K only: everything except the pinned set
 *         (system summaries), the recent window, and the last user message.
 *    Never dropped, at any step: system-role messages (the identity
 *    sections and rolling summary) and the last user message in history.
 *    The live turn is never part of the array handed to this module.
 */
import type { ChatMessage } from "../ai/provider";
import { truncateJsonForModel, wrapToolResult } from "../agent/transcript";
import { prioritizeHistory, PINNED_SCORE, defaultImportance } from "./prioritize";
import {
  estimateMessagesTokens,
  estimateTokens,
} from "./tokens";

/** Default per-turn context target when nothing else is configured. */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 32_000;

/** A single tool result above this size is head+tail compacted in history. */
export const TOOL_RESULT_TOKEN_LIMIT = 2_000;

/** History at this fraction of budget triggers a between-turn summary fold. */
export const SUMMARY_TRIGGER_RATIO = 0.6;

/** Lines kept from the start of an oversized tool result. */
export const TOOL_COMPACT_HEAD_LINES = 40;
/** Lines kept from the end of an oversized tool result. */
export const TOOL_COMPACT_TAIL_LINES = 20;

/** The elision marker, so a reader (and the model) knows lines were cut. */
export function elisionMarker(elidedLines: number): string {
  return `[… ${elidedLines} lines elided …]`;
}

export interface ToolCompaction {
  content: string;
  compacted: boolean;
  elidedLines: number;
  beforeTokens: number;
  afterTokens: number;
}

/**
 * Head+tail compaction of one tool result.
 *
 * Only applies when the result is over the token limit AND long enough to
 * actually gain from cutting (head+tail must leave something elided).
 * Unchanged results are returned by reference value with `compacted: false`.
 */
export function compactToolResult(
  content: string,
  limit = TOOL_RESULT_TOKEN_LIMIT,
): ToolCompaction {
  const beforeTokens = estimateTokens(content);
  if (beforeTokens <= limit) {
    return {
      content,
      compacted: false,
      elidedLines: 0,
      beforeTokens,
      afterTokens: beforeTokens,
    };
  }
  // §4.7 structural rule: a wrapped tool_result whose inner body parses as
  // JSON is compacted by truncating that JSON structurally (valid JSON in,
  // valid JSON out, `truncated` marker inside) instead of line cutting —
  // head+tail on a one-line JSON blob would either do nothing or slice it
  // mid-token. `elidedLines` is 0 here: nothing line-shaped was elided.
  const structural = compactWrappedJson(content, limit, beforeTokens);
  if (structural !== undefined) return structural;
  const lines = content.split("\n");
  const kept = TOOL_COMPACT_HEAD_LINES + TOOL_COMPACT_TAIL_LINES;
  if (lines.length <= kept + 1) {
    return {
      content,
      compacted: false,
      elidedLines: 0,
      beforeTokens,
      afterTokens: beforeTokens,
    };
  }
  const elided = lines.length - kept;
  const compacted = [
    ...lines.slice(0, TOOL_COMPACT_HEAD_LINES),
    elisionMarker(elided),
    ...lines.slice(lines.length - TOOL_COMPACT_TAIL_LINES),
  ].join("\n");
  return {
    content: compacted,
    compacted: true,
    elidedLines: elided,
    beforeTokens,
    afterTokens: estimateTokens(compacted),
  };
}

/** A parsed `<tool_result>` wrapper: the tool name (unescaped) and its body. */
function unwrapToolResult(content: string): { tool: string; body: string } | undefined {
  const open = /^<tool_result tool="([^"]*)">\n/.exec(content);
  if (open === null) return undefined;
  const close = "\n</tool_result>";
  if (!content.endsWith(close)) return undefined;
  const body = content.slice(open[0].length, content.length - close.length);
  // Undo wrapToolResult's attribute escaping (reverse order: &amp; last).
  const tool = open[1]!
    .replaceAll("&lt;", "<")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
  return { tool, body };
}

/**
 * Structural compaction of one wrapped JSON tool result.
 *
 * The char budget handed to truncateJsonForModel is derived from the token
 * limit via this module's own estimator: the body's measured
 * chars-per-token rate converts `limit` tokens back into characters, and
 * the result is verified against the estimator, halving the budget until
 * the re-wrapped message actually fits. Returns undefined when the content
 * is not a wrapped JSON result, or when no structural form beats the
 * original — the caller then falls back to head+tail.
 */
function compactWrappedJson(
  content: string,
  limit: number,
  beforeTokens: number,
): ToolCompaction | undefined {
  const wrapped = unwrapToolResult(content);
  if (wrapped === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(wrapped.body);
  } catch {
    return undefined;
  }
  const bodyTokens = estimateTokens(wrapped.body);
  if (bodyTokens <= 0) return undefined;
  const charsPerToken = wrapped.body.length / bodyTokens;
  let charBudget = Math.max(128, Math.floor(limit * charsPerToken));
  for (let attempt = 0; attempt < 8; attempt++) {
    const clipped = truncateJsonForModel(parsed, charBudget);
    const rewrapped = wrapToolResult(wrapped.tool, clipped);
    const afterTokens = estimateTokens(rewrapped);
    if (afterTokens <= limit && rewrapped.length < content.length) {
      return {
        content: rewrapped,
        compacted: true,
        elidedLines: 0,
        beforeTokens,
        afterTokens,
      };
    }
    if (charBudget <= 128) break;
    charBudget = Math.max(128, Math.floor(charBudget / 2));
  }
  return undefined;
}

export interface HistoryCompaction {
  messages: ChatMessage[];
  compactedCount: number;
  beforeTokens: number;
  afterTokens: number;
}

/**
 * Apply tool-result compaction to every tool message in a history list
 * (item 2). Non-tool messages pass through untouched; the input is never
 * mutated.
 */
export function compactHistoryToolResults(
  messages: readonly ChatMessage[],
  limit = TOOL_RESULT_TOKEN_LIMIT,
): HistoryCompaction {
  let compactedCount = 0;
  const out = messages.map((m) => {
    if (m.role !== "tool") return m;
    const r = compactToolResult(m.content, limit);
    if (!r.compacted) return m;
    compactedCount++;
    return { ...m, content: r.content };
  });
  return {
    messages: out,
    compactedCount,
    beforeTokens: estimateMessagesTokens(messages),
    afterTokens: estimateMessagesTokens(out),
  };
}

/**
 * Replace one tool result with a single line naming its size and opening
 * text — the step-(a) form used under budget pressure, where even the
 * head+tail form is too expensive.
 */
export function oneLineToolSummary(content: string): string {
  const tokens = estimateTokens(content);
  const firstLine =
    content
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const head = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
  return `[tool result compacted to save context (~${tokens} tokens)]: ${head}`;
}

export interface BudgetEnforcement {
  messages: ChatMessage[];
  /** Tool results replaced by one-liners at step (a). */
  toolResultsOneLined: number;
  /** History messages dropped at steps (b)/(c). */
  droppedMessages: number;
  /** Did the final context fit the budget? */
  fits: boolean;
}

/** Messages that enforcement may never drop: system (identity/summary). */
function isProtected(message: ChatMessage): boolean {
  return message.role === "system";
}

/**
 * Enforce the context budget on a HISTORY list (the live turn is never
 * included — the caller appends it after enforcement, and the last user
 * message inside the history is protected here as well).
 *
 * `systemTokens` is the measured system-prompt cost and `turnTokens` the
 * live turn's; enforcement targets system + history + turn ≤ budget.
 */
export function enforceContextBudget(
  history: readonly ChatMessage[],
  opts: { systemTokens: number; turnTokens: number; budget: number },
): BudgetEnforcement {
  const total = (h: readonly ChatMessage[]): number =>
    opts.systemTokens + estimateMessagesTokens(h) + opts.turnTokens;

  if (total(history) <= opts.budget) {
    return { messages: [...history], toolResultsOneLined: 0, droppedMessages: 0, fits: true };
  }

  // The last user message in history is never dropped: it is the most
  // recent intent before the live turn. It is tracked by reference and
  // re-inserted (in original order) if a priority cut removed it.
  let lastUserIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  // (a) old tool results → one-line summaries. Index-preserving map, so
  // every later step still lines up with the original positions.
  let toolResultsOneLined = 0;
  const working = history.map((m) => {
    if (m.role !== "tool") return m;
    toolResultsOneLined++;
    return { ...m, content: oneLineToolSummary(m.content) };
  });
  const lastUser = lastUserIndex >= 0 ? working[lastUserIndex] : undefined;
  const protectedCount = working.filter(isProtected).length;

  const finish = (kept: ChatMessage[]): BudgetEnforcement => {
    let merged = kept;
    if (lastUser !== undefined && !merged.includes(lastUser)) {
      merged = [...merged, lastUser].sort(
        (a, b) => working.indexOf(a) - working.indexOf(b),
      );
    }
    return {
      messages: merged,
      toolResultsOneLined,
      droppedMessages: history.length - merged.length,
      fits: total(merged) <= opts.budget,
    };
  };

  if (total(working) <= opts.budget) return finish(working);

  // (b) drop by priority, halving the window until it fits or only the
  // protected/pinned set remains. prioritizeHistory pins system messages
  // and corrections on top of scores, so identity and corrections survive.
  let msgBudget = Math.max(protectedCount, Math.floor(working.length / 2));
  let shrunk = prioritizeHistory(working, { budget: msgBudget });
  while (total(shrunk) > opts.budget && msgBudget > protectedCount) {
    const next = Math.max(protectedCount, Math.floor(msgBudget / 2));
    if (next === msgBudget) break;
    msgBudget = next;
    shrunk = prioritizeHistory(working, { budget: msgBudget });
  }
  if (total(shrunk) <= opts.budget) return finish(shrunk);

  // (c) top-K only: the pinned set plus the most recent window, chosen by
  // the same priority order — everything else goes.
  const pinnedCount = working.filter(
    (m, i) => defaultImportance(m, i, working) >= PINNED_SCORE,
  ).length;
  const topK = Math.max(protectedCount, pinnedCount, 8);
  shrunk = prioritizeHistory(working, { budget: topK, recentMessages: 8 });
  return finish(shrunk);
}
