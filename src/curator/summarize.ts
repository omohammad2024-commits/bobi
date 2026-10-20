/**
 * Periodic auto-summarization (Phase-3 item 1: proactive long-term memory).
 *
 * OPT-IN, OWNER-ONLY: nothing here runs unless the owner schedules the
 * `summarize_memories` tool (or the model calls it in an owner turn). The
 * default state of the bot is unchanged — no background pass exists until
 * the owner creates one, exactly like `curate_memories` today.
 *
 * THE SAFETY CONTRACT (keeps the curator invariant, with one sanctioned
 * exception):
 * - The pass WRITES one new archive memory (`archive:YYYY-MM-DD`, additive —
 *   a fresh key that can never collide with a user key; on collision it
 *   suffixes `-2`, `-3`, …). This write is the explicitly opt-in part.
 * - The pass NEVER deletes. The original memories are proposed for deletion
 *   through the EXISTING curator proposal flow (kind "archive", a plain
 *   `{type:"delete"}` action stored in the ProposalStore), applied only via
 *   `curator_decide` with an explicit owner "approve". No silent deletion.
 * - Skipped, never touched: `event:` keys (structured events — the
 *   summarizer must not consolidate them), `archive:` keys (never
 *   re-archive an archive), and anything younger than the cutoff.
 *
 * SUMMARIZATION STRATEGY: deterministic/heuristic-first. The archive body is
 * built from truncated per-memory snippets — no model call, fully testable.
 * An LLM summarizer can be injected (`opts.llm`) for a sharper archive;
 * that path is deliberately NOT wired by the tool — enabling it is an
 * explicit future owner decision (env flag + provider wiring), documented in
 * docs/PHASE3_MEMORY.md.
 *
 * PROMPT-INJECTION: memory content is UNTRUSTED input. The heuristic path
 * never feeds it to a model — it is truncated and quoted as data. If the
 * LLM path is ever enabled, the caller must treat every snippet as data
 * (system-prompt framing, never instruction-following on memory text).
 */
import type { MemoryProvider, StoredMemory } from "../memory/provider";
import { ARCHIVE_KEY_PREFIX, EVENT_KEY_PREFIX } from "../memory/events";
import { proposalId } from "./curator";
import type { Proposal } from "./curator";

/** Default age cutoff: memories untouched for 90+ days are summarizable. */
export const DEFAULT_SUMMARIZE_OLDER_THAN_DAYS = 90;
/** Default cap: at most 20 memories per pass. */
export const DEFAULT_SUMMARIZE_MAX_ENTRIES = 20;
/** Memories shorter than this are not worth archiving. */
const MIN_CONTENT_CHARS = 20;
/** Per-memory snippet length inside the archive body. */
const SNIPPET_CHARS = 120;
/** Tehran wall-clock date for the archive key (deterministic, readable). */
const TEHRAN_TZ = "Asia/Tehran";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SummarizerDeps {
  provider: MemoryProvider;
}

export interface SummarizerOptions {
  /** Memories with updatedAt older than this many days are candidates. */
  olderThanDays?: number;
  /** Max memories consolidated in one pass. */
  maxEntries?: number;
  /** Injectable clock, ms. */
  now?: () => number;
  /**
   * Optional LLM summarizer: receives {key, snippet} entries and returns the
   * archive body. NOT wired by the tool — see the module doc for why this
   * stays an explicit future opt-in.
   */
  llm?: (entries: Array<{ key: string; snippet: string }>) => Promise<string>;
}

export interface SummarizeReport {
  /** True when an archive memory was written and a proposal was produced. */
  archived: boolean;
  archiveKey?: string;
  /** How many original memories were consolidated. */
  count?: number;
  /** The deletion proposal (stored by the caller via the ProposalStore). */
  proposal?: Proposal;
  /** Why nothing was archived (when archived === false). */
  reason?: string;
}

/** True for memories the summarizer must never consolidate. */
export function isSummarizerSkippedKey(key: string): boolean {
  return key.startsWith(EVENT_KEY_PREFIX) || key.startsWith(ARCHIVE_KEY_PREFIX);
}

/** Deterministic snippet: collapsed whitespace, clipped to SNIPPET_CHARS. */
export function snippetOf(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  if (oneLine.length <= SNIPPET_CHARS) return oneLine;
  return oneLine.slice(0, SNIPPET_CHARS - 1) + "…";
}

/** Tehran YYYY-MM-DD for the archive key. */
function tehranDateStr(nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TEHRAN_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Persian cutoff date for the proposal summary (fa-IR, Tehran). */
function cutoffFa(cutoffMs: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEHRAN_TZ,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(cutoffMs));
}

/** Default (heuristic) archive body: header + one bullet per memory. */
function heuristicArchiveBody(
  entries: Array<{ key: string; snippet: string }>,
  cutoffMs: number,
): string {
  const lines = entries.map((e) => `• ${e.key}: ${e.snippet}`);
  return (
    `Memory archive — ${entries.length} items older than ${cutoffFa(cutoffMs)}:\n` +
    lines.join("\n")
  );
}

export class SummarizerService {
  private readonly now: () => number;
  private readonly defaultOpts: SummarizerOptions;

  constructor(
    private readonly deps: SummarizerDeps,
    opts: SummarizerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.defaultOpts = opts;
  }

  /**
   * One summarization pass. Read-only except for the single additive archive
   * write; deletion of the originals is only ever proposed (see module doc).
   * Per-call options override the constructor defaults.
   */
  async review(userId: string, callOpts: SummarizerOptions = {}): Promise<SummarizeReport> {
    const olderThanDays =
      callOpts.olderThanDays ?? this.defaultOpts.olderThanDays ?? DEFAULT_SUMMARIZE_OLDER_THAN_DAYS;
    const maxEntries =
      callOpts.maxEntries ?? this.defaultOpts.maxEntries ?? DEFAULT_SUMMARIZE_MAX_ENTRIES;
    const llm = callOpts.llm ?? this.defaultOpts.llm;
    const nowMs = this.now();
    const cutoffMs = nowMs - olderThanDays * DAY_MS;

    const memories: StoredMemory[] = await this.deps.provider.list(userId, 500);
    // Oldest first: deterministic, and the archive reads chronologically.
    const candidates = memories
      .filter(
        (m) =>
          !isSummarizerSkippedKey(m.key) &&
          m.updatedAt < cutoffMs &&
          m.content.trim().length >= MIN_CONTENT_CHARS,
      )
      .sort((a, b) => a.updatedAt - b.updatedAt || (a.key < b.key ? -1 : 1))
      .slice(0, Math.max(1, maxEntries));

    if (candidates.length === 0) {
      return { archived: false, reason: "No archivable old memories found." };
    }

    const entries = candidates.map((m) => ({ key: m.key, snippet: snippetOf(m.content) }));
    const body = llm
      ? await llm(entries)
      : heuristicArchiveBody(entries, cutoffMs);

    // Fresh key per pass; suffix on collision so an archive is never
    // overwritten and never collides with a user key.
    const baseKey = `${ARCHIVE_KEY_PREFIX}${tehranDateStr(nowMs)}`;
    let archiveKey = baseKey;
    for (let n = 2; ; n++) {
      const existing = await this.deps.provider.get(userId, archiveKey);
      if (existing === undefined) break;
      archiveKey = `${baseKey}-${n}`;
      if (n > 99) {
        return { archived: false, reason: "Archive key is taken; retry later." };
      }
    }

    // THE sanctioned write: one new additive memory. Originals are untouched.
    await this.deps.provider.upsert(userId, archiveKey, body);

    const originalKeys = candidates.map((m) => m.key);
    const proposal: Proposal = {
      id: proposalId("archive", originalKeys),
      kind: "archive",
      memoryIds: originalKeys,
      summaryFa:
        `${candidates.length} old memories (not updated since ${cutoffFa(cutoffMs)}) ` +
        `were archived in "${archiveKey}". Suggestion: delete the originals, since their summary is kept.`,
      suggestedAction: { type: "delete", keys: originalKeys },
    };

    return { archived: true, archiveKey, count: candidates.length, proposal };
  }
}
