/**
 * Phase 5, item 6 — opt-in automatic event extraction from conversations.
 *
 * When the owner enables it (`/memory auto on`), the BACKGROUND sweep (the
 * same in-process timer as the nudge/event-reminder sweep in src/index.ts)
 * scans the owner's own recent conversation messages for event-like
 * statements (birthdays, anniversaries, recurring commitments) and files
 * each candidate as a curator proposal (kind "event"). The owner approves
 * in `curator_decide` before anything is stored — extraction NEVER writes
 * to memory by itself.
 *
 * LATENCY CONTRACT: this module is only ever called from the sweep. It has
 * no import of the conversation engine and no per-turn hook — replies never
 * wait on extraction. (Pinned by tests/phase5_memory_auto.test.ts.)
 *
 * COST CONTRACT: the default extractor is the deterministic, rule-based
 * `extractEvents` (zero model calls, zero latency). The short,
 * small-model-friendly `EVENT_EXTRACTION_PROMPT` plus `extractEventsWithLLM`
 * is the documented upgrade path for better paraphrase recall; nothing in
 * the sweep wires it today.
 *
 * PRIVACY:
 * - Only the owner's own messages (role "user") are scanned, only from
 *   conversations owned by the owner's user id. No other user's text is
 *   ever read.
 * - Nothing leaves the instance: the deterministic path makes no network
 *   call at all. If a future wiring injects `llmExtract`, message text
 *   would go to the owner's configured provider — that wiring does not
 *   exist today and must be an explicit, documented owner choice.
 * - Candidates are inert proposal rows (7-day TTL, owner-scoped) — the same
 *   review flow as every other curator proposal.
 */
import type { MemoryProvider } from "./provider";
import {
  EventStore,
  eventKeyFor,
  eventKindLabel,
  extractEvents,
  parseEventPayload,
  type EventCandidate,
  type MemoryEvent,
  type NewEvent,
} from "./events";
import { proposalId, type Proposal, type ProposalAction } from "../curator/curator";
import type { ProposalStore } from "../curator/proposals";
import type { StoredMessage, UserConversationSummary } from "../storage/storage";

/** user_prefs key: "1" = enabled. Absent or any other value = disabled. */
export const AUTO_EXTRACT_PREF_KEY = "memory:auto_extract";
/** user_prefs key: watermark (unix ms) of the last sweep scan. */
export const AUTO_EXTRACT_WM_PREF_KEY = "memory:auto_extract:wm";

/**
 * Minimal pref surface this module needs. `Storage` satisfies it
 * structurally, as does the bot's `UserPrefStore` — the module never
 * imports bot.ts (grammy) so it stays usable from the sweep and tests.
 */
export interface PrefStore {
  getUserPref(userId: string, key: string): string | undefined;
  setUserPref(userId: string, key: string, value: string): void;
}

/** Minimal conversation-history surface this module needs. */
export interface ConversationReader {
  listUserConversations(userId: string): UserConversationSummary[];
  history(userId: string, chatId: string, limit?: number): StoredMessage[];
}

/**
 * Short, small-model-friendly extraction prompt (the upgrade path).
 *
 * Kept deliberately tiny: a few dozen messages in, a JSON array out, no
 * chain-of-thought, no explanations. A small/cheap model can run it; the
 * output is validated field-by-field by `extractEventsWithLLM`, so a
 * sloppy model cannot smuggle in malformed events.
 */
export const EVENT_EXTRACTION_PROMPT = `Extract dated events from the chat messages below.
Output ONLY a JSON array, no other text. Each item:
{"kind":"birthday|anniversary|monthly|once","name":"<short label>","jMonth":1-12,"jDay":1-31,"jYear":<Jalali year or null>,"labelFa":"<Persian date label>"}
Rules:
- Include an item ONLY when the message names an explicit date (e.g. «۱۵ مرداد», «هر ماه ۵ام»). No date → skip the message.
- kind: "birthday" for تولد, "anniversary" for سالگرد, "monthly" for هر ماه/ماهانه commitments, "once" for a one-time appointment that names a Jalali year.
- name: at most 3-4 words — the person or thing. Never invent details not in the message.
- jYear is the Jalali year (e.g. 1404) or null. labelFa is the Persian date as written.
- Nothing qualifies → output [].`;

/** Off by default: the pref must be exactly "1". */
export function isAutoExtractEnabled(prefs: PrefStore, userId: string): boolean {
  return prefs.getUserPref(userId, AUTO_EXTRACT_PREF_KEY) === "1";
}

export function setAutoExtractEnabled(
  prefs: PrefStore,
  userId: string,
  enabled: boolean,
): void {
  prefs.setUserPref(userId, AUTO_EXTRACT_PREF_KEY, enabled ? "1" : "0");
}

/**
 * Extract event candidates from plain message texts.
 *
 * Deterministic and rule-based (via `extractEvents`): no model call, no
 * latency, no text leaving the instance. Duplicates within the batch are
 * collapsed by deterministic event key; when the same name+kind appears
 * twice with different dates (a correction), the LAST one wins.
 */
export function extractCandidatesFromMessages(
  messages: readonly string[],
): EventCandidate[] {
  const byKey = new Map<string, EventCandidate>();
  for (const m of messages) {
    for (const c of extractEvents(m)) {
      byKey.set(eventKeyFor(c.name, c.kind), c);
    }
  }
  return [...byKey.values()];
}

/**
 * Turn candidates into curator proposals (kind "event").
 *
 * The proposal id is deterministic over (event key + date parts), so a
 * repeated scan of unchanged text yields the same ids and the proposal
 * store's INSERT OR IGNORE dedupes instead of piling up rows — and a date
 * correction for the same name gets a NEW proposal id, so it is not
 * swallowed by the old (already decided) row. Nothing is stored here;
 * applying happens only via `curator_decide` + owner approval, through the
 * new `add_event` proposal action.
 */
export function candidatesToEventProposals(
  candidates: readonly EventCandidate[],
): Proposal[] {
  return candidates.map((c) => {
    const key = eventKeyFor(c.name, c.kind);
    const idInput = [key, `${c.jYear ?? ""}-${c.jMonth}-${c.jDay}`];
    const event: NewEvent = {
      name: c.name,
      kind: c.kind,
      jMonth: c.jMonth,
      jDay: c.jDay,
      labelFa: c.labelFa,
    };
    if (c.jYear !== undefined) event.jYear = c.jYear;
    return {
      id: proposalId("event", idInput),
      kind: "event",
      memoryIds: [key],
      summaryFa:
        `رویداد پیشنهادی از گفتگو: «${c.name}» — ${eventKindLabel(c.kind)} در ${c.labelFa}. ` +
        `تأیید یعنی ثبت در حافظهٔ رویدادها؛ رد یعنی نادیده گرفتن.`,
      suggestedAction: { type: "add_event", event },
    };
  });
}

export interface AutoExtractScanDeps {
  prefs: PrefStore;
  conversations: ConversationReader;
  provider: MemoryProvider;
  proposalStore: ProposalStore;
  /** The owner's user id — the ONLY user whose conversations are scanned. */
  ownerId: string;
  nowMs?: number;
  maxConversations?: number;
  maxMessagesPerConversation?: number;
  /**
   * Explicit lower bound for message timestamps (an on-demand deep scan).
   * Default: the stored watermark, or (first run) now − 30 days.
   */
  sinceMs?: number;
  /**
   * Optional LLM extractor (upgrade path). When absent, the deterministic
   * rule extractor is used — no model call at all.
   */
  llmExtract?: (messages: string[]) => Promise<EventCandidate[]>;
  /** Persist the watermark. Default true; tests may disable. */
  updateWatermark?: boolean;
}

export interface AutoExtractScanReport {
  enabled: boolean;
  conversationsScanned: number;
  messagesScanned: number;
  candidatesFound: number;
  /** Proposals that were newly pending after this scan (not deduped). */
  newProposals: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HISTORY_WINDOW_MS = 30 * DAY_MS;
const MAX_MESSAGE_CHARS = 2000;

/** True when the stored event already matches the candidate exactly. */
function eventMatches(stored: MemoryEvent, c: EventCandidate): boolean {
  return (
    stored.name === c.name &&
    stored.kind === c.kind &&
    stored.jMonth === c.jMonth &&
    stored.jDay === c.jDay &&
    (stored.jYear ?? undefined) === (c.jYear ?? undefined)
  );
}

/**
 * One background sweep pass: scan the owner's recent messages and file new
 * event candidates as curator proposals.
 *
 * - Returns immediately (after a single pref read) when the feature is
 *   disabled — which is the default, so a stock instance pays ~nothing.
 * - Only messages newer than the watermark are scanned; the watermark
 *   advances to the newest message seen, so each message is scanned at most
 *   once and a rejected proposal is never resurrected (its row still exists
 *   in the store, so INSERT OR IGNORE skips it).
 * - Candidates identical to an already-stored event are skipped silently.
 */
export async function scanForEventCandidates(
  deps: AutoExtractScanDeps,
): Promise<AutoExtractScanReport> {
  const idle: AutoExtractScanReport = {
    enabled: false,
    conversationsScanned: 0,
    messagesScanned: 0,
    candidatesFound: 0,
    newProposals: 0,
  };
  if (!isAutoExtractEnabled(deps.prefs, deps.ownerId)) return idle;
  const nowMs = deps.nowMs ?? Date.now();
  const maxConvs = deps.maxConversations ?? 20;
  const maxMsgs = deps.maxMessagesPerConversation ?? 60;
  const updateWm = deps.updateWatermark ?? true;

  const storedWm = Number(
    deps.prefs.getUserPref(deps.ownerId, AUTO_EXTRACT_WM_PREF_KEY) ?? NaN,
  );
  const sinceMs =
    deps.sinceMs ?? (Number.isFinite(storedWm) ? storedWm : nowMs - DEFAULT_HISTORY_WINDOW_MS);

  const report: AutoExtractScanReport = { ...idle, enabled: true };
  const texts: string[] = [];
  let maxSeen = sinceMs;
  try {
    const convs = deps.conversations
      .listUserConversations(deps.ownerId)
      .slice(0, maxConvs);
    for (const conv of convs) {
      let rows: StoredMessage[];
      try {
        rows = deps.conversations.history(deps.ownerId, conv.conversationId, maxMsgs);
      } catch {
        continue; // One unreadable conversation never breaks the sweep.
      }
      report.conversationsScanned += 1;
      for (const row of rows) {
        if (typeof row.createdAt === "number" && row.createdAt > maxSeen) {
          maxSeen = row.createdAt;
        }
        if (row.role !== "user") continue;
        if (typeof row.createdAt !== "number" || row.createdAt <= sinceMs) continue;
        if (typeof row.content !== "string") continue;
        if (row.content.length === 0 || row.content.length > MAX_MESSAGE_CHARS) continue;
        texts.push(row.content);
        report.messagesScanned += 1;
      }
    }
  } catch {
    // listUserConversations itself failed: report what we know, honestly.
    return report;
  }

  const candidates =
    deps.llmExtract !== undefined
      ? await deps.llmExtract(texts)
      : extractCandidatesFromMessages(texts);
  report.candidatesFound = candidates.length;

  // Drop candidates that are already stored verbatim — approving them again
  // would be a no-op upsert, so proposing them is pure noise.
  const fresh: EventCandidate[] = [];
  for (const c of candidates) {
    const key = eventKeyFor(c.name, c.kind);
    let skip = false;
    try {
      const row = await deps.provider.get(deps.ownerId, key);
      if (row !== undefined) {
        const stored = parseEventPayload(row.content);
        if (stored !== undefined && eventMatches(stored, c)) skip = true;
      }
    } catch {
      // A read failure must not silently store or silently drop: keep the
      // candidate so the owner sees it and decides.
    }
    if (!skip) fresh.push(c);
  }

  const proposals = candidatesToEventProposals(fresh);
  if (proposals.length > 0) {
    const before = new Set(
      deps.proposalStore.listPending(deps.ownerId).map((p) => p.id),
    );
    const after = deps.proposalStore.saveProposals(deps.ownerId, proposals);
    const afterIds = new Set(after.map((p) => p.id));
    report.newProposals = proposals.filter(
      (p) => afterIds.has(p.id) && !before.has(p.id),
    ).length;
  }

  if (updateWm) {
    try {
      deps.prefs.setUserPref(deps.ownerId, AUTO_EXTRACT_WM_PREF_KEY, String(maxSeen));
    } catch {
      // A watermark write failure just means the next sweep re-scans;
      // proposal dedup keeps that harmless.
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Fact extraction (worker-2): user-stated facts, not just dated events
// ---------------------------------------------------------------------------

import { normalizeMemoryText, tokenJaccard } from "./hybrid";

/** user_prefs key: "1" = fact extraction enabled. Default off, like events. */
export const FACT_EXTRACT_PREF_KEY = "memory:fact_extract";
/** user_prefs key: watermark (unix ms) of the last fact sweep scan. */
export const FACT_EXTRACT_WM_PREF_KEY = "memory:fact_extract:wm";

export type FactKind = "name" | "preference" | "commitment" | "decision" | "correction";

export interface FactCandidate {
  kind: FactKind;
  /**
   * Deterministic storage key: the same topic always yields the same key,
   * so a repeated statement collapses (last wins) and a correction can
   * target the memory it corrects instead of appending a contradiction.
   */
  key: string;
  /** The statement to remember, as written (trimmed). */
  content: string;
  /** Importance 1-5 scored at extraction time. */
  importance: number;
  /** True for «نه، اشتباه گفتی»-style corrections: apply as an update. */
  isCorrection: boolean;
  /** The raw message this was extracted from. */
  source: string;
}

/** Importance at write time, by fact kind. */
export function scoreFactImportance(kind: FactKind): number {
  switch (kind) {
    case "name":
      return 5; // identity is the most-recalled fact there is
    case "correction":
      return 5; // a correction supersedes whatever it corrects
    case "commitment":
      return 4; // «یادم بنداز» is an explicit remember-me
    case "decision":
      return 4;
    case "preference":
      return 3;
  }
}

/** Persian label for a fact kind, for owner-facing proposal text. */
export function factKindLabelFa(kind: FactKind): string {
  switch (kind) {
    case "name":
      return "نام";
    case "preference":
      return "سلیقه";
    case "commitment":
      return "تعهد";
    case "decision":
      return "تصمیم";
    case "correction":
      return "اصلاحیه";
  }
}

/** djb2 → base36, for deterministic short topic hashes in fact keys. */
function topicHash(topic: string): string {
  let h = 5381;
  const s = normalizeMemoryText(topic);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(7, "0");
}

/** Deterministic fact key: «fact:name» for the user's name, topic-hashed otherwise. */
export function factKeyFor(kind: FactKind, topic: string): string {
  if (kind === "name") return "fact:name";
  return `fact:${kind}:${topicHash(topic)}`;
}

/**
 * Light message normalization for pattern matching: unify ی/ک, turn the
 * half-space into a real space, collapse whitespace. (Full
 * normalizeMemoryText also lowercases and strips diacritics — too
 * aggressive for capture groups we show back to the owner.)
 */
function normMsg(m: string): string {
  return m
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/‌/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SENTENCE_END = /[.!؟?؛\n]/;

function captureTopic(m: string): string {
  const cut = m.split(SENTENCE_END)[0] ?? m;
  return cut.trim().slice(0, 120);
}

/** After removing a correction marker, drop leftover leading punctuation. */
function stripMarker(m: string): string {
  return captureTopic(m.replace(/^[,،:؛\s]+/, ""));
}

interface FactPattern {
  kind: FactKind;
  re: RegExp;
  /** Build the stored content from the match. */
  content: (m: RegExpMatchArray, raw: string) => string;
  /** Topic used for the deterministic key (defaults to the content). */
  topic?: (m: RegExpMatchArray, raw: string) => string;
}

const COPULA_TAIL = /\s+(است|هست|هستم|می‌باشد|میباشد)$/;

const FACT_PATTERNS: readonly FactPattern[] = [
  // -- correction («نه، اشتباه گفتی») — FIRST: a message that corrects must
  // never be misfiled as a plain preference/decision it happens to mention.
  {
    kind: "correction",
    re: /(?:نه\s*[,،]?\s*)?اشتباه\s+(گفتی|کردی|میگی|می‌گی)/,
    content: (m, raw) => stripMarker(raw.replace(m[0]!, "")),
    topic: (m, raw) => stripMarker(raw.replace(m[0]!, "")),
  },
  {
    kind: "correction",
    re: /نه\s+این\s*طور\s+نیست/,
    content: (m, raw) => stripMarker(raw.replace(m[0]!, "")),
    topic: (m, raw) => stripMarker(raw.replace(m[0]!, "")),
  },
  // -- name --
  {
    kind: "name",
    re: /(?:اسم|نام)(?:م| من)?\s+(.+)/,
    content: (m) =>
      `نام کاربر: ${captureTopic(m[1]!).replace(COPULA_TAIL, "").trim()}`,
    topic: () => "name",
  },
  {
    kind: "name",
    re: /من\s+(.+?)\s+هستم/,
    content: (m) => `نام کاربر: ${captureTopic(m[1]!).trim()}`,
    topic: () => "name",
  },
  {
    kind: "name",
    re: /my name is\s+([a-zA-Z][\w ]{0,40})/i,
    content: (m) => `نام کاربر: ${captureTopic(m[1]!).trim()}`,
    topic: () => "name",
  },
  // -- preference --
  {
    kind: "preference",
    re: /دوست\s+دارم\s+(.+)/,
    content: (m, raw) => captureTopic(raw),
  },
  {
    kind: "preference",
    // «خوشم میاد» (plain alef) and «خوشم می‌آید» (madda) are both common.
    re: /از\s+(.+?)\s+خوشم\s+می\s*[اآ](ی)?د/,
    content: (m, raw) => captureTopic(raw),
  },
  {
    kind: "preference",
    re: /ترجیح\s+می\s*دم\s+(.+)/,
    content: (m, raw) => captureTopic(raw),
  },
  {
    kind: "preference",
    re: /علاقه\s+دارم\s+به\s+(.+)/,
    content: (m, raw) => captureTopic(raw),
  },
  {
    kind: "preference",
    re: /متنفرم\s+از\s+(.+)/,
    content: (m, raw) => captureTopic(raw),
  },
  {
    kind: "preference",
    re: /i\s+(?:really\s+)?(?:like|love)\s+(.+)/i,
    content: (m, raw) => captureTopic(raw),
  },
  // -- commitment («یادم بنداز») --
  {
    kind: "commitment",
    re: /یادم\s+بنداز\s+(?:که\s+)?(.+)/,
    content: (m, raw) => captureTopic(raw),
  },
  {
    kind: "commitment",
    re: /یادآوری\s+کن\s+(?:که\s+)?(.+)/,
    content: (m, raw) => captureTopic(raw),
  },
  {
    kind: "commitment",
    re: /فراموش\s+نکن\s+(?:که\s+)?(.+)/,
    content: (m, raw) => captureTopic(raw),
  },
  {
    kind: "commitment",
    re: /remind me to\s+(.+)/i,
    content: (m, raw) => captureTopic(raw),
  },
  // -- decision --
  {
    kind: "decision",
    re: /تصمیم\s+گرفتم\s+(?:که\s+)?(.+)/,
    content: (m, raw) => captureTopic(raw),
  },
  {
    kind: "decision",
    re: /قرار\s+شد\s+(?:که\s+)?(.+)/,
    content: (m, raw) => captureTopic(raw),
  },
];

/**
 * Extract fact candidates from plain message texts.
 *
 * Deterministic and rule-based: no model call, no latency, no text leaving
 * the instance. Each message yields at most one candidate per pattern; the
 * first matching pattern wins per message, and duplicates within the batch
 * collapse by deterministic fact key with the LAST one winning — so a
 * restated fact (or a corrected one) never piles up.
 */
export function extractFactCandidates(
  messages: readonly string[],
): FactCandidate[] {
  const byKey = new Map<string, FactCandidate>();
  for (const raw of messages) {
    const msg = normMsg(raw);
    if (msg.length === 0 || msg.length > MAX_MESSAGE_CHARS) continue;
    for (const p of FACT_PATTERNS) {
      const m = p.re.exec(msg);
      if (!m) continue;
      const content = p.content(m, msg).trim();
      if (content.length === 0) continue;
      const topic = p.topic ? p.topic(m, msg) : content;
      const kind = p.kind;
      const candidate: FactCandidate = {
        kind,
        key: factKeyFor(kind, topic),
        content,
        importance: scoreFactImportance(kind),
        isCorrection: kind === "correction",
        source: raw.slice(0, 500),
      };
      byKey.set(candidate.key, candidate);
      break; // one candidate per message: the first (most specific) pattern wins
    }
  }
  return [...byKey.values()];
}

/**
 * Find the existing memory a correction probably targets.
 *
 * First the deterministic key (a correction of a fact extracted by the same
 * rules lands on the same key); then, as a fallback, the memory with the
 * highest token-set Jaccard to the corrected claim (≥ 0.4). Returns
 * undefined when nothing looks related — then the correction is proposed as
 * a new fact rather than a blind overwrite.
 */
export function findCorrectionTarget(
  candidate: FactCandidate,
  existing: ReadonlyArray<{ key: string; content: string }>,
): { key: string; content: string } | undefined {
  const direct = existing.find((m) => m.key === candidate.key);
  if (direct !== undefined) return direct;
  let best: { key: string; content: string } | undefined;
  let bestScore = 0.4;
  for (const m of existing) {
    const score = tokenJaccard(candidate.content, m.content);
    if (score > bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Turn fact candidates into curator proposals (kind "fact").
 *
 * Corrections that find their target become `{type:"update"}` proposals —
 * the corrected memory is REPLACED, never contradicted by an appended
 * twin. Everything else becomes `{type:"add"}` with the extraction-time
 * importance attached, so retrieval can prefer it. Nothing is stored here;
 * applying happens only via `curator_decide` + owner approval.
 */
export function candidatesToFactProposals(
  candidates: readonly FactCandidate[],
  existing: ReadonlyArray<{ key: string; content: string }>,
): Proposal[] {
  return candidates.map((c) => {
    const target = c.isCorrection ? findCorrectionTarget(c, existing) : undefined;
    const action: ProposalAction =
      target !== undefined
        ? {
            type: "update",
            key: target.key,
            newContent: c.content,
            importance: c.importance,
          }
        : { type: "add", key: c.key, content: c.content, importance: c.importance };
    const idInput =
      target !== undefined
        ? ["fact-update", target.key, c.content]
        : ["fact-add", c.key, c.content];
    return {
      id: proposalId("fact", idInput),
      kind: "fact",
      memoryIds: target !== undefined ? [target.key] : [c.key],
      summaryFa:
        target !== undefined
          ? `اصلاحیه از گفتگو: حافظهٔ «${target.key}» به‌روزرسانی می‌شود (جایگزینی، نه تناقض): «${c.content}».`
          : `فکت پیشنهادی از گفتگو (${factKindLabelFa(c.kind)}، اهمیت ${c.importance}/۵): «${c.content}». ` +
            `تأیید یعنی ثبت در حافظه؛ رد یعنی نادیده گرفتن.`,
      suggestedAction: action,
    };
  });
}

/** Off by default: the pref must be exactly "1". */
export function isFactExtractEnabled(prefs: PrefStore, userId: string): boolean {
  return prefs.getUserPref(userId, FACT_EXTRACT_PREF_KEY) === "1";
}

export function setFactExtractEnabled(
  prefs: PrefStore,
  userId: string,
  enabled: boolean,
): void {
  prefs.setUserPref(userId, FACT_EXTRACT_PREF_KEY, enabled ? "1" : "0");
}

export interface FactExtractScanReport {
  enabled: boolean;
  conversationsScanned: number;
  messagesScanned: number;
  candidatesFound: number;
  /** Proposals that were newly pending after this scan (not deduped). */
  newProposals: number;
}

export interface FactExtractScanDeps {
  prefs: PrefStore;
  conversations: ConversationReader;
  provider: MemoryProvider;
  proposalStore: ProposalStore;
  /** The owner's user id — the ONLY user whose conversations are scanned. */
  ownerId: string;
  nowMs?: number;
  maxConversations?: number;
  maxMessagesPerConversation?: number;
  sinceMs?: number;
  updateWatermark?: boolean;
}

/**
 * One background sweep pass: scan the owner's recent messages for
 * user-stated facts and file them as curator proposals (kind "fact").
 *
 * Same contract as the event sweep: disabled by default (one pref read and
 * out), owner-only messages, watermarked so each message is scanned at most
 * once, candidates identical to an already-stored fact skipped silently,
 * and extraction NEVER writes to memory by itself.
 */
export async function scanForFactCandidates(
  deps: FactExtractScanDeps,
): Promise<FactExtractScanReport> {
  const idle: FactExtractScanReport = {
    enabled: false,
    conversationsScanned: 0,
    messagesScanned: 0,
    candidatesFound: 0,
    newProposals: 0,
  };
  if (!isFactExtractEnabled(deps.prefs, deps.ownerId)) return idle;
  const nowMs = deps.nowMs ?? Date.now();
  const maxConvs = deps.maxConversations ?? 20;
  const maxMsgs = deps.maxMessagesPerConversation ?? 60;
  const updateWm = deps.updateWatermark ?? true;

  const storedWm = Number(
    deps.prefs.getUserPref(deps.ownerId, FACT_EXTRACT_WM_PREF_KEY) ?? NaN,
  );
  const sinceMs =
    deps.sinceMs ?? (Number.isFinite(storedWm) ? storedWm : nowMs - DEFAULT_HISTORY_WINDOW_MS);

  const report: FactExtractScanReport = { ...idle, enabled: true };
  const texts: string[] = [];
  let maxSeen = sinceMs;
  try {
    const convs = deps.conversations
      .listUserConversations(deps.ownerId)
      .slice(0, maxConvs);
    for (const conv of convs) {
      let rows: StoredMessage[];
      try {
        rows = deps.conversations.history(deps.ownerId, conv.conversationId, maxMsgs);
      } catch {
        continue;
      }
      report.conversationsScanned += 1;
      for (const row of rows) {
        if (typeof row.createdAt === "number" && row.createdAt > maxSeen) {
          maxSeen = row.createdAt;
        }
        if (row.role !== "user") continue;
        if (typeof row.createdAt !== "number" || row.createdAt <= sinceMs) continue;
        if (typeof row.content !== "string") continue;
        if (row.content.length === 0 || row.content.length > MAX_MESSAGE_CHARS) continue;
        texts.push(row.content);
        report.messagesScanned += 1;
      }
    }
  } catch {
    return report;
  }

  const candidates = extractFactCandidates(texts);
  report.candidatesFound = candidates.length;

  // The proposal builder needs existing memories for correction targeting;
  // one bounded list call, owner-scoped like everything else.
  let existing: Array<{ key: string; content: string }> = [];
  try {
    existing = await deps.provider.list(deps.ownerId, 200);
  } catch {
    existing = [];
  }

  // Drop candidates already stored verbatim under the same key — approving
  // them again would be a no-op upsert. Corrections keep their proposal:
  // their whole point is replacing something.
  const fresh: FactCandidate[] = [];
  for (const c of candidates) {
    if (!c.isCorrection) {
      let skip = false;
      try {
        const row = await deps.provider.get(deps.ownerId, c.key);
        if (
          row !== undefined &&
          normalizeMemoryText(row.content) === normalizeMemoryText(c.content)
        ) {
          skip = true;
        }
      } catch {
        // A read failure must not silently drop: keep the candidate.
      }
      if (skip) continue;
    }
    fresh.push(c);
  }

  const proposals = candidatesToFactProposals(fresh, existing);
  if (proposals.length > 0) {
    const before = new Set(
      deps.proposalStore.listPending(deps.ownerId).map((p) => p.id),
    );
    const after = deps.proposalStore.saveProposals(deps.ownerId, proposals);
    const afterIds = new Set(after.map((p) => p.id));
    report.newProposals = proposals.filter(
      (p) => afterIds.has(p.id) && !before.has(p.id),
    ).length;
  }

  if (updateWm) {
    try {
      deps.prefs.setUserPref(deps.ownerId, FACT_EXTRACT_WM_PREF_KEY, String(maxSeen));
    } catch {
      // Harmless: the next sweep re-scans, proposal dedup absorbs it.
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Optional LLM extractor (upgrade path, not wired in the sweep today)
// ---------------------------------------------------------------------------

const VALID_KINDS = new Set(["birthday", "anniversary", "monthly", "once"]);

function validLlmCandidate(v: unknown): EventCandidate | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (!VALID_KINDS.has(o.kind as string)) return undefined;
  if (typeof o.name !== "string" || o.name.trim().length === 0 || o.name.length > 60) {
    return undefined;
  }
  if (!Number.isInteger(o.jMonth) || (o.jMonth as number) < 1 || (o.jMonth as number) > 12) {
    return undefined;
  }
  if (!Number.isInteger(o.jDay) || (o.jDay as number) < 1 || (o.jDay as number) > 31) {
    return undefined;
  }
  if (typeof o.labelFa !== "string" || o.labelFa.length === 0 || o.labelFa.length > 40) {
    return undefined;
  }
  const c: EventCandidate = {
    kind: o.kind as EventCandidate["kind"],
    name: o.name.trim(),
    jMonth: o.jMonth as number,
    jDay: o.jDay as number,
    labelFa: o.labelFa,
  };
  if (o.jYear !== null && o.jYear !== undefined) {
    if (!Number.isInteger(o.jYear) || (o.jYear as number) < 1300 || (o.jYear as number) > 1500) {
      return undefined;
    }
    c.jYear = o.jYear as number;
  }
  return c;
}

/**
 * Model-backed extraction using the short `EVENT_EXTRACTION_PROMPT`.
 *
 * `callModel(prompt, input)` is injected so the sweep never depends on a
 * concrete provider here. Every returned item is validated field-by-field;
 * malformed model output yields [] (or the valid subset), never an
 * exception — a sloppy small model degrades to fewer candidates, not to
 * bad data.
 */
export async function extractEventsWithLLM(
  messages: readonly string[],
  callModel: (prompt: string, input: string) => Promise<string>,
): Promise<EventCandidate[]> {
  const input = messages
    .slice(0, 40)
    .map((m) => m.slice(0, 500))
    .join("\n---\n");
  if (input.trim().length === 0) return [];
  let raw: string;
  try {
    raw = await callModel(EVENT_EXTRACTION_PROMPT, input);
  } catch {
    return [];
  }
  const json = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: EventCandidate[] = [];
  const seen = new Set<string>();
  for (const item of parsed.slice(0, 50)) {
    const c = validLlmCandidate(item);
    if (c === undefined) continue;
    const key = eventKeyFor(c.name, c.kind);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
