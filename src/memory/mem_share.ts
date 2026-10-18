/**
 * Phase 5, item 6 — memory export/import between BOBI instances.
 *
 * A memory package (`.bobimem`) is a single, inspectable JSON file: the
 * owner's memories plus their structured events, with metadata and a
 * SHA-256 checksum over the canonical payload. The envelope mirrors the
 * phase-4 skill package (`.bobiskill`) so the trust story is familiar:
 *
 * - The checksum only detects tampering of the envelope in transit. It is
 *   NOT a signature: anyone can mint a valid package.
 * - Import is owner-only and validates everything before touching storage:
 *   size cap, envelope shape, checksum, then every entry (key/content
 *   limits mirror the `remember` tool; event payloads are re-validated).
 * - Dedup/merge: an entry whose key exists with IDENTICAL content is
 *   skipped (re-importing the same file is a no-op). A key that exists
 *   with DIFFERENT content is never silently overwritten — it becomes a
 *   curator proposal (kind "import") for the owner to approve in
 *   `curator_decide`. With `reviewAll`, even brand-new entries go through
 *   proposals instead of being written directly.
 *
 * SECURITY:
 * - A package is the owner's own long-term memory: treat the file as
 *   sensitive, same as the database. Export hands it to the owner over
 *   their own DM; import only accepts it from the owner.
 * - Entry contents are data, never instructions — they are stored verbatim
 *   and rendered quoted downstream, same as any remembered text.
 */
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type { MemoryProvider, StoredMemory } from "./provider";
import { EVENT_KEY_PREFIX, EventStore, eventKeyFor, parseEventPayload, type MemoryEvent, type NewEvent } from "./events";
import { proposalId, type Proposal, type ProposalAction } from "../curator/curator";

/** Magic marker every memory-package envelope carries. */
export const MEMORY_PACKAGE_FORMAT = "bobi-memory-package";
/** Envelope schema version this code writes and reads. */
export const MEMORY_PACKAGE_FORMAT_VERSION = 1;
/** File extension for exported packages. */
export const MEMORY_PACKAGE_EXT = ".bobimem";
/** Raw-bytes cap for an imported package. */
export const MEMORY_PACKAGE_MAX_BYTES = 1_000_000;
/** Max entries (memories + events) a package may carry. */
export const MEMORY_PACKAGE_MAX_ENTRIES = 2000;
/** Key/content limits mirror the `remember` tool. */
export const MEMORY_KEY_MAX_LENGTH = 60;
export const MEMORY_CONTENT_MAX_LENGTH = 2000;

export interface MemoryPackageEntry {
  key: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryPackageEvent {
  key: string;
  event: MemoryEvent;
}

export interface MemoryPackageMetadata {
  /** ISO-8601 timestamp of the export. */
  exportedAt: string;
  /** Hostname of the exporting instance ("unknown" when unreadable). */
  sourceInstance: string;
  memoryCount: number;
  eventCount: number;
}

export interface VerifiedMemoryPackage {
  memories: MemoryPackageEntry[];
  events: MemoryPackageEvent[];
  metadata: MemoryPackageMetadata;
}

export type MemoryPackageError =
  | { kind: "too_large"; bytes: number; maxBytes: number }
  | { kind: "not_json" }
  | { kind: "bad_envelope"; reason: string }
  | { kind: "checksum_mismatch" }
  | { kind: "bad_entry"; index: number; reason: string };

export interface BuiltMemoryPackage {
  /** Suggested filename, e.g. "bobi-memory-2026-10-19.bobimem". */
  fileName: string;
  /** The full package text (UTF-8 JSON). */
  text: string;
  checksum: string;
  memoryCount: number;
  eventCount: number;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function instanceLabel(): string {
  try {
    const h = hostname();
    return h.length > 0 ? h : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Build the canonical payload string the checksum covers.
 *
 * Keys are constructed in a fixed order (not taken from the parsed object)
 * so the checksum is stable regardless of how the JSON was formatted or
 * re-serialized. The `checksum` field itself is never part of the payload.
 */
function canonicalPayload(input: {
  memories: MemoryPackageEntry[];
  events: MemoryPackageEvent[];
  metadata: MemoryPackageMetadata;
}): string {
  return JSON.stringify({
    format: MEMORY_PACKAGE_FORMAT,
    formatVersion: MEMORY_PACKAGE_FORMAT_VERSION,
    memories: input.memories.map((m) => ({
      key: m.key,
      content: m.content,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    })),
    events: input.events.map((e) => ({
      key: e.key,
      event: {
        name: e.event.name,
        kind: e.event.kind,
        jMonth: e.event.jMonth,
        jDay: e.event.jDay,
        ...(e.event.jYear !== undefined ? { jYear: e.event.jYear } : {}),
        labelFa: e.event.labelFa,
        ...(e.event.note !== undefined ? { note: e.event.note } : {}),
        ...(e.event.lastRemindedMs !== undefined
          ? { lastRemindedMs: e.event.lastRemindedMs }
          : {}),
      },
    })),
    metadata: {
      exportedAt: input.metadata.exportedAt,
      sourceInstance: input.metadata.sourceInstance,
      memoryCount: input.metadata.memoryCount,
      eventCount: input.metadata.eventCount,
    },
  });
}

export type MemoryExportError = { kind: "too_large"; count: number };

/**
 * Export the owner's memories and structured events as a portable package.
 *
 * Pure over the provider: reads everything, writes nothing. `event:` rows
 * with a valid payload go into the `events` array (re-validated on import);
 * malformed `event:` rows are exported verbatim inside `memories` so no
 * byte is silently dropped.
 */
export async function buildMemoryPackage(
  provider: MemoryProvider,
  userId: string,
  opts: { now?: () => number } = {},
): Promise<
  | { ok: true; pkg: BuiltMemoryPackage }
  | { ok: false; error: MemoryExportError }
> {
  const rows: StoredMemory[] = await provider.list(userId, MEMORY_PACKAGE_MAX_ENTRIES + 1);
  if (rows.length > MEMORY_PACKAGE_MAX_ENTRIES) {
    return { ok: false, error: { kind: "too_large", count: rows.length } };
  }
  const memories: MemoryPackageEntry[] = [];
  const events: MemoryPackageEvent[] = [];
  for (const row of rows) {
    if (row.key.startsWith(EVENT_KEY_PREFIX)) {
      const parsed = parseEventPayload(row.content);
      if (parsed !== undefined) {
        events.push({ key: row.key, event: parsed });
        continue;
      }
    }
    memories.push({
      key: row.key,
      content: row.content,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
  const nowMs = opts.now?.() ?? Date.now();
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const metadata: MemoryPackageMetadata = {
    exportedAt: new Date(nowMs).toISOString(),
    sourceInstance: instanceLabel(),
    memoryCount: memories.length,
    eventCount: events.length,
  };
  const payload = canonicalPayload({ memories, events, metadata });
  const checksum = sha256Hex(payload);
  const text = JSON.stringify({ ...JSON.parse(payload), checksum });
  return {
    ok: true,
    pkg: {
      fileName: `bobi-memory-${day}${MEMORY_PACKAGE_EXT}`,
      text,
      checksum,
      memoryCount: memories.length,
      eventCount: events.length,
    },
  };
}

// --------------------------------------------------------------- verify ----

function badEntry(index: number, reason: string): MemoryPackageError {
  return { kind: "bad_entry", index, reason };
}

function validEntry(m: unknown, index: number): MemoryPackageError | MemoryPackageEntry {
  if (typeof m !== "object" || m === null) return badEntry(index, "entry is not an object");
  const o = m as Record<string, unknown>;
  if (typeof o.key !== "string" || o.key.length === 0 || o.key.length > MEMORY_KEY_MAX_LENGTH) {
    return badEntry(index, "bad key");
  }
  if (
    typeof o.content !== "string" ||
    o.content.length === 0 ||
    o.content.length > MEMORY_CONTENT_MAX_LENGTH
  ) {
    return badEntry(index, "bad content");
  }
  if (!Number.isFinite(o.createdAt) || !Number.isFinite(o.updatedAt)) {
    return badEntry(index, "bad timestamps");
  }
  return {
    key: o.key,
    content: o.content,
    createdAt: o.createdAt as number,
    updatedAt: o.updatedAt as number,
  };
}

function validPackageEvent(e: unknown, index: number): MemoryPackageError | MemoryPackageEvent {
  if (typeof e !== "object" || e === null) return badEntry(index, "event entry is not an object");
  const o = e as Record<string, unknown>;
  if (typeof o.key !== "string" || !o.key.startsWith(EVENT_KEY_PREFIX)) {
    return badEntry(index, "event key must use the event: prefix");
  }
  if (typeof o.event !== "object" || o.event === null) {
    return badEntry(index, "event payload is not an object");
  }
  const parsed = parseEventPayload(JSON.stringify(o.event));
  if (parsed === undefined) return badEntry(index, "invalid event payload");
  return { key: o.key, event: parsed };
}

/**
 * Verify a package's bytes: size cap, JSON, envelope, checksum, then every
 * entry. Returns the verified package or the first error found. Rejects —
 * never partially accepts — malformed input.
 */
export function verifyMemoryPackage(
  input: string | Uint8Array,
): { ok: true; pkg: VerifiedMemoryPackage } | { ok: false; error: MemoryPackageError } {
  const bytes = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (bytes > MEMORY_PACKAGE_MAX_BYTES) {
    return { ok: false, error: { kind: "too_large", bytes, maxBytes: MEMORY_PACKAGE_MAX_BYTES } };
  }
  const text = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: { kind: "not_json" } };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: { kind: "bad_envelope", reason: "top-level JSON is not an object" } };
  }
  const o = parsed as Record<string, unknown>;
  if (o.format !== MEMORY_PACKAGE_FORMAT) {
    return { ok: false, error: { kind: "bad_envelope", reason: "not a bobi memory package" } };
  }
  if (o.formatVersion !== MEMORY_PACKAGE_FORMAT_VERSION) {
    return {
      ok: false,
      error: { kind: "bad_envelope", reason: `unsupported version ${String(o.formatVersion)}` },
    };
  }
  if (!Array.isArray(o.memories) || !Array.isArray(o.events)) {
    return { ok: false, error: { kind: "bad_envelope", reason: "memories/events must be arrays" } };
  }
  if (o.memories.length + o.events.length > MEMORY_PACKAGE_MAX_ENTRIES) {
    return {
      ok: false,
      error: { kind: "bad_envelope", reason: "too many entries" },
    };
  }
  const meta = o.metadata as Record<string, unknown> | undefined;
  if (typeof meta !== "object" || meta === null || typeof meta.exportedAt !== "string") {
    return { ok: false, error: { kind: "bad_envelope", reason: "bad metadata" } };
  }
  const memories: MemoryPackageEntry[] = [];
  for (let i = 0; i < o.memories.length; i++) {
    const v = validEntry(o.memories[i], i);
    if ("kind" in v) return { ok: false, error: v };
    memories.push(v);
  }
  const events: MemoryPackageEvent[] = [];
  for (let i = 0; i < o.events.length; i++) {
    const v = validPackageEvent(o.events[i], i);
    if ("kind" in v) return { ok: false, error: v };
    events.push(v);
  }
  // The checksum covers the canonical payload built from the VERIFIED
  // values — so a package that reordered keys or reformatted whitespace
  // still verifies, while any byte-level tampering of content fails.
  const recomputed = sha256Hex(
    canonicalPayload({
      memories,
      events,
      metadata: {
        exportedAt: meta.exportedAt as string,
        sourceInstance: typeof meta.sourceInstance === "string" ? meta.sourceInstance : "unknown",
        memoryCount: memories.length,
        eventCount: events.length,
      },
    }),
  );
  if (o.checksum !== recomputed) {
    return { ok: false, error: { kind: "checksum_mismatch" } };
  }
  return {
    ok: true,
    pkg: {
      memories,
      events,
      metadata: {
        exportedAt: meta.exportedAt as string,
        sourceInstance: typeof meta.sourceInstance === "string" ? meta.sourceInstance : "unknown",
        memoryCount: memories.length,
        eventCount: events.length,
      },
    },
  };
}

// ----------------------------------------------------------------- plan ----

/** One item that needs the owner's review instead of a direct write. */
export interface ImportProposalSpec {
  key: string;
  isEvent: boolean;
  summaryFa: string;
  action: ProposalAction;
}

export interface MemoryImportPlan {
  /** New memory keys: safe to upsert directly (or proposals when reviewAll). */
  memoriesToAdd: MemoryPackageEntry[];
  /** New events: safe to add directly (or proposals when reviewAll). */
  eventsToAdd: MemoryPackageEvent[];
  /** Conflicts and reviewAll items: curator proposals, never direct writes. */
  toReview: ImportProposalSpec[];
  /** Keys skipped because the stored content is already identical. */
  skipped: number;
  /** Duplicate keys inside the file itself (last wins). */
  deduped: number;
}

function shortPreview(s: string, max = 60): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * Plan an import: dedupe within the file, then classify each entry as
 * direct-add, skip (identical), or curator-review (conflict).
 *
 * `reviewAll` turns even brand-new entries into proposals — the "same
 * curator-review option" for owners who want to eyeball everything.
 */
export async function planMemoryImport(
  provider: MemoryProvider,
  userId: string,
  pkg: VerifiedMemoryPackage,
  opts: { reviewAll?: boolean } = {},
): Promise<MemoryImportPlan> {
  const reviewAll = opts.reviewAll ?? false;
  const plan: MemoryImportPlan = {
    memoriesToAdd: [],
    eventsToAdd: [],
    toReview: [],
    skipped: 0,
    deduped: 0,
  };

  // Within-file dedup: last entry wins for a repeated key.
  const memByKey = new Map<string, MemoryPackageEntry>();
  for (const m of pkg.memories) {
    if (memByKey.has(m.key)) plan.deduped += 1;
    memByKey.set(m.key, m);
  }
  const evByKey = new Map<string, MemoryPackageEvent>();
  for (const e of pkg.events) {
    // Canonical key: a well-formed package always carries it, but a
    // hand-built one might not — resolve it so lookup/apply/dedupe agree.
    const canonicalKey = eventKeyFor(e.event.name, e.event.kind);
    if (evByKey.has(canonicalKey)) plan.deduped += 1;
    evByKey.set(canonicalKey, { key: canonicalKey, event: e.event });
  }

  for (const m of memByKey.values()) {
    const existing = await provider.get(userId, m.key);
    if (existing === undefined) {
      if (reviewAll) {
        plan.toReview.push({
          key: m.key,
          isEvent: false,
          summaryFa: `ورودی از بستهٔ حافظه: حافظهٔ جدید «${m.key}» — «${shortPreview(m.content)}».`,
          action: { type: "add", key: m.key, content: m.content },
        });
      } else {
        plan.memoriesToAdd.push(m);
      }
      continue;
    }
    if (existing.content === m.content) {
      plan.skipped += 1;
      continue;
    }
    plan.toReview.push({
      key: m.key,
      isEvent: false,
      summaryFa:
        `ورودی از بستهٔ حافظه: «${m.key}» قبلاً با متن دیگری ثبت شده — ` +
        `«${shortPreview(existing.content)}» ← «${shortPreview(m.content)}». تأیید یعنی جایگزینی.`,
      action: { type: "update", key: m.key, newContent: m.content },
    });
  }

  for (const e of evByKey.values()) {
    const existing = await provider.get(userId, e.key);
    const stored = existing !== undefined ? parseEventPayload(existing.content) : undefined;
    if (existing === undefined) {
      if (reviewAll) {
        plan.toReview.push({
          key: e.key,
          isEvent: true,
          summaryFa: `ورودی از بستهٔ حافظه: رویداد جدید «${e.event.name}» در ${e.event.labelFa}.`,
          action: { type: "add_event", event: toNewEvent(e.event) },
        });
      } else {
        plan.eventsToAdd.push(e);
      }
      continue;
    }
    if (stored !== undefined && eventsEqual(stored, e.event)) {
      plan.skipped += 1;
      continue;
    }
    // A conflicting event is never silently overwritten — owner review.
    const oldLabel = stored !== undefined ? `${stored.name} در ${stored.labelFa}` : "نامعتبر";
    plan.toReview.push({
      key: e.key,
      isEvent: true,
      summaryFa:
        `ورودی از بستهٔ حافظه: رویداد «${e.event.name}» قبلاً ثبت شده (${oldLabel}) — ` +
        `نسخهٔ بسته: ${e.event.labelFa}. تأیید یعنی جایگزینی.`,
      action: { type: "add_event", event: toNewEvent(e.event) },
    });
  }
  return plan;
}

function toNewEvent(e: MemoryEvent): NewEvent {
  const out: NewEvent = {
    name: e.name,
    kind: e.kind,
    jMonth: e.jMonth,
    jDay: e.jDay,
    labelFa: e.labelFa,
  };
  if (e.jYear !== undefined) out.jYear = e.jYear;
  if (e.note !== undefined) out.note = e.note;
  return out;
}

function eventsEqual(a: MemoryEvent, b: MemoryEvent): boolean {
  return (
    a.name === b.name &&
    a.kind === b.kind &&
    a.jMonth === b.jMonth &&
    a.jDay === b.jDay &&
    (a.jYear ?? undefined) === (b.jYear ?? undefined) &&
    a.labelFa === b.labelFa &&
    (a.note ?? "") === (b.note ?? "")
  );
}

export interface AppliedMemoryImport {
  memoriesAdded: number;
  eventsAdded: number;
}

/**
 * Apply the direct-write half of an import plan. Conflicts and reviewAll
 * items are NOT written here — the caller files them as proposals.
 */
export async function applyMemoryImport(
  provider: MemoryProvider,
  userId: string,
  plan: MemoryImportPlan,
): Promise<AppliedMemoryImport> {
  for (const m of plan.memoriesToAdd) {
    await provider.upsert(userId, m.key, m.content);
  }
  const store = new EventStore(provider);
  for (const e of plan.eventsToAdd) {
    await store.add(userId, toNewEvent(e.event));
  }
  return { memoriesAdded: plan.memoriesToAdd.length, eventsAdded: plan.eventsToAdd.length };
}

/**
 * Turn the review half of an import plan into curator proposals
 * (kind "import"). The proposal id is deterministic over ("import", key),
 * so re-importing the same conflicting file does not pile up duplicate
 * proposals — the store's INSERT OR IGNORE dedupes.
 */
export function importProposalsFromPlan(plan: MemoryImportPlan): Proposal[] {
  return plan.toReview.map((spec) => ({
    id: proposalId("import", [spec.key]),
    kind: "import",
    memoryIds: [spec.key],
    summaryFa: spec.summaryFa,
    suggestedAction: spec.action,
  }));
}
