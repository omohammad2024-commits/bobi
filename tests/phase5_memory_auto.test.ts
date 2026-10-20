/**
 * Phase-5 item 6 tests: opt-in automatic event extraction + memory
 * export/import.
 *
 * Safety properties pinned here:
 * - Auto-extraction is OFF by default: with no pref, the sweep returns
 *   immediately, reads nothing else, and files no proposals.
 * - Extraction NEVER stores: candidates become curator proposals (kind
 *   "event"); the event lands in memory only via `curator_decide` approve.
 * - A rejected proposal is never resurrected by a later sweep.
 * - Extraction runs only in the sweep: the module has no import of the
 *   conversation engine (static guard against a future per-turn wiring).
 * - Import: malformed packages are rejected whole; re-importing the same
 *   package is a no-op (dedup); conflicts become proposals, never silent
 *   overwrites; reviewAll routes even new items through proposals.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { ToolService } from "../src/tools/service";
import type { MemoryProvider, StoredMemory } from "../src/memory/provider";
import type { ToolActor } from "../src/tools/types";
import { ProposalStore } from "../src/curator/proposals";
import { kindLabelFa } from "../src/curator/curator";
import {
  CURATE_MEMORIES_PERMISSION,
  CURATOR_DECIDE_PERMISSION,
  createCuratorTools,
} from "../src/curator/tools";
import { EventStore, eventKeyFor, extractEvents } from "../src/memory/events";
import {
  AUTO_EXTRACT_PREF_KEY,
  candidatesToEventProposals,
  EVENT_EXTRACTION_PROMPT,
  extractCandidatesFromMessages,
  extractEventsWithLLM,
  isAutoExtractEnabled,
  scanForEventCandidates,
  setAutoExtractEnabled,
  type ConversationReader,
  type PrefStore,
} from "../src/memory/auto_extract";
import {
  FACT_EXTRACT_PREF_KEY,
  candidatesToFactProposals,
  extractFactCandidates,
  factKeyFor,
  findCorrectionTarget,
  isFactExtractEnabled,
  scanForFactCandidates,
  scoreFactImportance,
  setFactExtractEnabled,
  type FactCandidate,
} from "../src/memory/auto_extract";
import {
  applyMemoryImport,
  buildMemoryPackage,
  importProposalsFromPlan,
  MEMORY_PACKAGE_FORMAT,
  planMemoryImport,
  verifyMemoryPackage,
} from "../src/memory/mem_share";
import {
  handleMemoryAuto,
  handleMemoryExport,
  handleMemoryImportText,
  isMemoryImportCaption,
} from "../src/bot/cmd_phase5_memory";
import type { StoredMessage, UserConversationSummary } from "../src/storage/storage";

// ---------------------------------------------------------------- fakes ----

class FakeMemoryProvider implements MemoryProvider {
  readonly name = "fake";
  private readonly rows = new Map<string, StoredMemory>();

  seed(key: string, content: string, ts = 1000): void {
    this.rows.set(key, { key, content, createdAt: ts, updatedAt: ts });
  }

  upsert(_userId: string, key: string, content: string): void {
    const prev = this.rows.get(key);
    const now = Date.now();
    this.rows.set(key, {
      key,
      content,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    });
  }

  get(_userId: string, key: string): StoredMemory | undefined {
    return this.rows.get(key);
  }

  list(_userId: string, limit = 50): StoredMemory[] {
    return [...this.rows.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  delete(_userId: string, key: string): boolean {
    return this.rows.delete(key);
  }

  count(_userId: string): number {
    return this.rows.size;
  }
}

class FakePrefs implements PrefStore {
  private readonly map = new Map<string, string>();
  getUserPref(userId: string, key: string): string | undefined {
    return this.map.get(`${userId}:${key}`);
  }
  setUserPref(userId: string, key: string, value: string): void {
    this.map.set(`${userId}:${key}`, value);
  }
}

interface FakeMessage {
  role: StoredMessage["role"];
  content: string;
  createdAt: number;
}

class FakeConversations implements ConversationReader {
  private readonly convs = new Map<string, FakeMessage[]>();

  add(chatId: string, messages: FakeMessage[]): void {
    this.convs.set(chatId, messages);
  }

  listUserConversations(_userId: string): UserConversationSummary[] {
    return [...this.convs.keys()].map((chatId, i) => ({
      conversationId: chatId,
      createdAt: 1000 + i,
      messageCount: this.convs.get(chatId)!.length,
      lastActivity: 2000 + i,
    }));
  }

  history(_userId: string, chatId: string, limit = 50): StoredMessage[] {
    const msgs = this.convs.get(chatId) ?? [];
    return msgs.slice(-limit).map((m, i) => ({
      id: i + 1,
      conversationId: 1,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    }));
  }
}

const OWNER = "u1";
const PERMS = [CURATE_MEMORIES_PERMISSION, CURATOR_DECIDE_PERMISSION];
const ownerActor = (): ToolActor => ({ userId: OWNER, permissions: PERMS });

function setupSweep() {
  const provider = new FakeMemoryProvider();
  const prefs = new FakePrefs();
  const convs = new FakeConversations();
  const store = new ProposalStore(new Database(":memory:"));
  const svc = new ToolService({
    extraTools: createCuratorTools({ provider, store, isOwner: () => true }),
  });
  return { provider, prefs, convs, store, svc };
}

async function decide(
  svc: ToolService,
  proposalId: string,
  decision: "approve" | "reject",
) {
  return svc.runTool({ tool: "curator_decide", input: { proposalId, decision }, actor: ownerActor() });
}

function scanDeps(s: ReturnType<typeof setupSweep>, extra: Record<string, unknown> = {}) {
  return {
    prefs: s.prefs,
    conversations: s.convs,
    provider: s.provider,
    proposalStore: s.store,
    ownerId: OWNER,
    nowMs: 10_000,
    ...extra,
  };
}

// ------------------------------------------------- off by default ----------

describe("auto event extraction: off by default", () => {
  test("no pref → sweep returns disabled and touches nothing", async () => {
    const s = setupSweep();
    s.convs.add("c1", [
      { role: "user", content: "تولد علی ۱۵ مرداده", createdAt: 9000 },
    ]);
    const report = await scanForEventCandidates(scanDeps(s));
    expect(report.enabled).toBe(false);
    expect(report.messagesScanned).toBe(0);
    expect(report.newProposals).toBe(0);
    expect(s.store.listPending(OWNER)).toHaveLength(0);
    expect(await s.provider.count(OWNER)).toBe(0);
    // The pref itself was never even set — the feature is inert.
    expect(s.prefs.getUserPref(OWNER, AUTO_EXTRACT_PREF_KEY)).toBeUndefined();
  });

  test("isAutoExtractEnabled is false unless the pref is exactly \"1\"", () => {
    const prefs = new FakePrefs();
    expect(isAutoExtractEnabled(prefs, OWNER)).toBe(false);
    prefs.setUserPref(OWNER, AUTO_EXTRACT_PREF_KEY, "0");
    expect(isAutoExtractEnabled(prefs, OWNER)).toBe(false);
    prefs.setUserPref(OWNER, AUTO_EXTRACT_PREF_KEY, "yes");
    expect(isAutoExtractEnabled(prefs, OWNER)).toBe(false);
    setAutoExtractEnabled(prefs, OWNER, true);
    expect(isAutoExtractEnabled(prefs, OWNER)).toBe(true);
  });
});

// ------------------------------------------- candidates → proposals ---------

describe("auto event extraction: sweep scan", () => {
  test("enabled sweep files event proposals but stores nothing", async () => {
    const s = setupSweep();
    setAutoExtractEnabled(s.prefs, OWNER, true);
    s.convs.add("c1", [
      { role: "user", content: "سلام", createdAt: 8000 },
      { role: "user", content: "تولد علی ۱۵ مرداده", createdAt: 9000 },
      { role: "assistant", content: "باشه", createdAt: 9100 },
      { role: "user", content: "هر ماه ۵ام قسط وام", createdAt: 9200 },
    ]);
    const report = await scanForEventCandidates(scanDeps(s));
    expect(report.enabled).toBe(true);
    expect(report.conversationsScanned).toBe(1);
    expect(report.messagesScanned).toBe(3); // assistant message not scanned
    expect(report.candidatesFound).toBe(2);
    expect(report.newProposals).toBe(2);

    const pending = s.store.listPending(OWNER);
    expect(pending).toHaveLength(2);
    expect(pending.every((p) => p.kind === "event")).toBe(true);
    expect(kindLabelFa("event")).toBe("Event");
    expect(kindLabelFa("import")).toBe("Import");

    // Nothing was stored: the events land only via curator_decide.
    const events = await new EventStore(s.provider).list(OWNER);
    expect(events).toHaveLength(0);
  });

  test("approve via curator_decide stores the event; re-scan proposes nothing new", async () => {
    const s = setupSweep();
    setAutoExtractEnabled(s.prefs, OWNER, true);
    s.convs.add("c1", [{ role: "user", content: "تولد علی ۱۵ مرداده", createdAt: 9000 }]);
    const first = await scanForEventCandidates(scanDeps(s));
    expect(first.newProposals).toBe(1);

    const [proposal] = s.store.listPending(OWNER);
    expect(proposal!.suggestedAction.type).toBe("add_event");
    const res = await decide(s.svc, proposal!.id, "approve");
    expect(res.status).toBe("ok");

    const events = await new EventStore(s.provider).list(OWNER);
    expect(events).toHaveLength(1);
    expect(events[0]!.event.name).toBe("علی");

    // Re-scan: the stored event matches, and the proposal row still exists —
    // no new proposal.
    const second = await scanForEventCandidates(scanDeps(s, { nowMs: 20_000 }));
    expect(second.newProposals).toBe(0);
  });

  test("a rejected candidate is never resurrected by a later sweep", async () => {
    const s = setupSweep();
    setAutoExtractEnabled(s.prefs, OWNER, true);
    s.convs.add("c1", [{ role: "user", content: "تولد علی ۱۵ مرداده", createdAt: 9000 }]);
    await scanForEventCandidates(scanDeps(s));
    const [proposal] = s.store.listPending(OWNER);
    await decide(s.svc, proposal!.id, "reject");
    expect(s.store.listPending(OWNER)).toHaveLength(0);

    // New message arrives → watermark advanced; old message not re-scanned.
    s.convs.add("c1", [
      { role: "user", content: "تولد علی ۱۵ مرداده", createdAt: 9000 },
      { role: "user", content: "هوا خوبه", createdAt: 30_000 },
    ]);
    const report = await scanForEventCandidates(scanDeps(s, { nowMs: 40_000 }));
    expect(report.newProposals).toBe(0);
    expect(s.store.listPending(OWNER)).toHaveLength(0);
  });

  test("watermark: a sweep with no new messages scans nothing", async () => {
    const s = setupSweep();
    setAutoExtractEnabled(s.prefs, OWNER, true);
    s.convs.add("c1", [{ role: "user", content: "سلام", createdAt: 9000 }]);
    const first = await scanForEventCandidates(scanDeps(s));
    expect(first.messagesScanned).toBe(1);
    const second = await scanForEventCandidates(scanDeps(s, { nowMs: 20_000 }));
    expect(second.messagesScanned).toBe(0);
    expect(second.newProposals).toBe(0);
  });

  test("a date correction for the same name gets its own proposal", async () => {
    const s = setupSweep();
    setAutoExtractEnabled(s.prefs, OWNER, true);
    s.convs.add("c1", [{ role: "user", content: "تولد علی ۱۵ مرداده", createdAt: 9000 }]);
    await scanForEventCandidates(scanDeps(s));
    const [p1] = s.store.listPending(OWNER);
    await decide(s.svc, p1!.id, "approve");

    s.convs.add("c1", [
      { role: "user", content: "تولد علی ۱۵ مرداده", createdAt: 9000 },
      { role: "user", content: "اشتباه شد، تولد علی ۲۰ مرداده", createdAt: 30_000 },
    ]);
    const report = await scanForEventCandidates(scanDeps(s, { nowMs: 40_000 }));
    expect(report.newProposals).toBe(1);
    const pending = s.store.listPending(OWNER);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).not.toBe(p1!.id);
  });

  test("only the owner's own user messages are scanned", async () => {
    const s = setupSweep();
    setAutoExtractEnabled(s.prefs, OWNER, true);
    // Assistant/system messages mentioning dates must not become proposals.
    s.convs.add("c1", [
      { role: "assistant", content: "تولد علی ۱۵ مرداده، یادم هست", createdAt: 9000 },
      { role: "system", content: "تولد علی ۱۵ مرداده", createdAt: 9100 },
    ]);
    const report = await scanForEventCandidates(scanDeps(s));
    expect(report.messagesScanned).toBe(0);
    expect(report.newProposals).toBe(0);
  });
});

// ------------------------------------------------- extraction units --------

describe("extraction units", () => {
  test("extractCandidatesFromMessages dedupes by event key, last wins", () => {
    const out = extractCandidatesFromMessages([
      "تولد علی ۱۵ مرداده",
      "چیز دیگری",
      "تولد علی ۲۰ مرداده",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.jDay).toBe(20);
  });

  test("candidatesToEventProposals builds kind=event proposals with add_event", () => {
    const cands = extractEvents("تولد علی ۱۵ مرداده");
    expect(cands).toHaveLength(1);
    const [p] = candidatesToEventProposals(cands);
    expect(p!.kind).toBe("event");
    expect(p!.suggestedAction.type).toBe("add_event");
    expect(p!.summaryFa).toContain("علی");
    expect(p!.summaryFa).toContain("۱۵ مرداد");
  });

  test("EVENT_EXTRACTION_PROMPT is short and small-model-friendly", () => {
    expect(EVENT_EXTRACTION_PROMPT.length).toBeLessThan(1500);
    expect(EVENT_EXTRACTION_PROMPT).toContain("JSON");
    expect(EVENT_EXTRACTION_PROMPT).toContain("jMonth");
  });

  test("extractEventsWithLLM validates model output field-by-field", async () => {
    const callModel = async () =>
      JSON.stringify([
        { kind: "birthday", name: "علی", jMonth: 5, jDay: 15, jYear: null, labelFa: "۱۵ مرداد" },
        { kind: "party", name: "x", jMonth: 1, jDay: 1, labelFa: "۱ فروردین" },
        { kind: "birthday", name: "", jMonth: 5, jDay: 99, labelFa: "x" },
        "garbage",
      ]);
    const out = await extractEventsWithLLM(["تولد علی ۱۵ مرداده"], callModel);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "birthday", name: "علی", jMonth: 5, jDay: 15 });
  });

  test("extractEventsWithLLM returns [] on model failure or bad JSON", async () => {
    const fail = async () => {
      throw new Error("down");
    };
    expect(await extractEventsWithLLM(["hi"], fail)).toEqual([]);
    const bad = async () => "not json at all";
    expect(await extractEventsWithLLM(["hi"], bad)).toEqual([]);
  });

  test("auto_extract.ts never imports the conversation engine (no per-turn path)", () => {
    const src = readFileSync("src/memory/auto_extract.ts", "utf8");
    expect(src).not.toMatch(/conversation\/engine/);
    expect(src).not.toMatch(/from "\.\.\/conversation/);
  });
});

// ------------------------------------------------- export / import ---------

function seedSource(): FakeMemoryProvider {
  const p = new FakeMemoryProvider();
  p.seed("project", "پروژهٔ بابی", 1000);
  p.seed("taste", "قهوه دوست دارم", 2000);
  p.seed("event:birthday:abc123", JSON.stringify({
    name: "علی",
    kind: "birthday",
    jMonth: 5,
    jDay: 15,
    labelFa: "۱۵ مرداد",
  }), 3000);
  return p;
}

describe("memory export/import", () => {
  test("export → verify → import round-trips memories and events", async () => {
    const src = seedSource();
    const built = await buildMemoryPackage(src, OWNER);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.pkg.memoryCount).toBe(2);
    expect(built.pkg.eventCount).toBe(1);
    expect(built.pkg.fileName).toMatch(/\.bobimem$/);

    const verified = verifyMemoryPackage(built.pkg.text);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.pkg.metadata.sourceInstance.length).toBeGreaterThan(0);

    const dst = new FakeMemoryProvider();
    const plan = await planMemoryImport(dst, OWNER, verified.pkg);
    expect(plan.memoriesToAdd).toHaveLength(2);
    expect(plan.eventsToAdd).toHaveLength(1);
    expect(plan.toReview).toHaveLength(0);
    expect(plan.skipped).toBe(0);
    const applied = await applyMemoryImport(dst, OWNER, plan);
    expect(applied.memoriesAdded).toBe(2);
    expect(applied.eventsAdded).toBe(1);
    expect(dst.get(OWNER, "project")?.content).toBe("پروژهٔ بابی");
    const events = await new EventStore(dst).list(OWNER);
    expect(events).toHaveLength(1);
    expect(events[0]!.event.name).toBe("علی");
  });

  test("re-importing the same package is a no-op (dedup)", async () => {
    const src = seedSource();
    const built = await buildMemoryPackage(src, OWNER);
    if (!built.ok) throw new Error("export failed");
    const verified = verifyMemoryPackage(built.pkg.text);
    if (!verified.ok) throw new Error("verify failed");

    const dst = new FakeMemoryProvider();
    const first = await planMemoryImport(dst, OWNER, verified.pkg);
    await applyMemoryImport(dst, OWNER, first);
    const second = await planMemoryImport(dst, OWNER, verified.pkg);
    expect(second.memoriesToAdd).toHaveLength(0);
    expect(second.eventsToAdd).toHaveLength(0);
    expect(second.toReview).toHaveLength(0);
    expect(second.skipped).toBe(3);
    const proposals = importProposalsFromPlan(second);
    expect(proposals).toHaveLength(0);
  });

  test("conflicting keys become proposals — never silent overwrites", async () => {
    const src = seedSource();
    const built = await buildMemoryPackage(src, OWNER);
    if (!built.ok) throw new Error("export failed");
    const verified = verifyMemoryPackage(built.pkg.text);
    if (!verified.ok) throw new Error("verify failed");

    const dst = new FakeMemoryProvider();
    dst.seed("project", "پروژهٔ قدیمی", 500); // same key, different content
    const plan = await planMemoryImport(dst, OWNER, verified.pkg);
    expect(plan.memoriesToAdd).toHaveLength(1); // "taste"
    expect(plan.toReview).toHaveLength(1);
    const [spec] = plan.toReview;
    expect(spec!.key).toBe("project");
    expect(spec!.action.type).toBe("update");
    expect(dst.get(OWNER, "project")?.content).toBe("پروژهٔ قدیمی"); // untouched

    const proposals = importProposalsFromPlan(plan);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.kind).toBe("import");
    expect(proposals[0]!.summaryFa).toContain("project");
  });

  test("reviewAll routes even new items through curator proposals", async () => {
    const src = seedSource();
    const built = await buildMemoryPackage(src, OWNER);
    if (!built.ok) throw new Error("export failed");
    const verified = verifyMemoryPackage(built.pkg.text);
    if (!verified.ok) throw new Error("verify failed");

    const dst = new FakeMemoryProvider();
    const plan = await planMemoryImport(dst, OWNER, verified.pkg, { reviewAll: true });
    expect(plan.memoriesToAdd).toHaveLength(0);
    expect(plan.eventsToAdd).toHaveLength(0);
    expect(plan.toReview).toHaveLength(3);
    const applied = await applyMemoryImport(dst, OWNER, plan);
    expect(applied.memoriesAdded).toBe(0);
    expect(await dst.count(OWNER)).toBe(0); // nothing written directly
    const proposals = importProposalsFromPlan(plan);
    expect(proposals.every((p) => p.kind === "import")).toBe(true);
  });

  test("conflicting events become add_event proposals", async () => {
    const src = seedSource();
    const built = await buildMemoryPackage(src, OWNER);
    if (!built.ok) throw new Error("export failed");
    const verified = verifyMemoryPackage(built.pkg.text);
    if (!verified.ok) throw new Error("verify failed");

    const dst = new FakeMemoryProvider();
    // Same event (canonical key), different date.
    dst.seed(eventKeyFor("علی", "birthday"), JSON.stringify({
      name: "علی",
      kind: "birthday",
      jMonth: 5,
      jDay: 20,
      labelFa: "۲۰ مرداد",
    }));
    const plan = await planMemoryImport(dst, OWNER, verified.pkg);
    const eventReviews = plan.toReview.filter((s) => s.isEvent);
    expect(eventReviews).toHaveLength(1);
    expect(eventReviews[0]!.action.type).toBe("add_event");
  });

  test("malformed packages are rejected whole", () => {
    expect(verifyMemoryPackage("not json").ok).toBe(false);
    expect(verifyMemoryPackage("not json")).toMatchObject({
      ok: false,
      error: { kind: "not_json" },
    });
    expect(verifyMemoryPackage(JSON.stringify({ format: "nope", formatVersion: 1 })).ok).toBe(false);

    // Tampered checksum.
    const tampered = JSON.stringify({
      format: MEMORY_PACKAGE_FORMAT,
      formatVersion: 1,
      memories: [],
      events: [],
      metadata: { exportedAt: "x", sourceInstance: "y", memoryCount: 0, eventCount: 0 },
      checksum: "0".repeat(64),
    });
    expect(verifyMemoryPackage(tampered)).toMatchObject({
      ok: false,
      error: { kind: "checksum_mismatch" },
    });

    // Bad entry: key too long.
    const bad = (async () => {
      const src = new FakeMemoryProvider();
      src.seed("k", "v");
      const built = await buildMemoryPackage(src, OWNER);
      if (!built.ok) throw new Error("export failed");
      const parsed = JSON.parse(built.pkg.text) as Record<string, unknown>;
      (parsed.memories as Array<Record<string, unknown>>)[0]!.key = "k".repeat(61);
      return verifyMemoryPackage(JSON.stringify(parsed));
    })();
    return expect(bad).resolves.toMatchObject({ ok: false, error: { kind: "bad_entry" } });
  });

  test("a package reformatted (not tampered) still verifies", async () => {
    const src = seedSource();
    const built = await buildMemoryPackage(src, OWNER);
    if (!built.ok) throw new Error("export failed");
    // Re-serialize with different whitespace: checksum must still hold.
    const reformatted = JSON.stringify(JSON.parse(built.pkg.text), null, 4);
    expect(verifyMemoryPackage(reformatted).ok).toBe(true);
  });
});

// ------------------------------------------------- command handlers --------

describe("/memory command handlers", () => {
  function autoEnv(s: ReturnType<typeof setupSweep>) {
    return {
      prefs: s.prefs,
      conversations: s.convs,
      proposalStore: s.store,
      provider: s.provider,
      ownerId: OWNER,
      now: () => 10_000,
    };
  }

  test("auto on/off/status round-trip", async () => {
    const s = setupSweep();
    const env = autoEnv(s);
    expect(await handleMemoryAuto("en", "status", env)).toContain("disabled");
    expect(await handleMemoryAuto("en", "on", env)).toContain("enabled");
    expect(isAutoExtractEnabled(s.prefs, OWNER)).toBe(true);
    expect(await handleMemoryAuto("en", "status", env)).toContain("enabled");
    expect(await handleMemoryAuto("en", "off", env)).toContain("disabled");
    expect(await handleMemoryAuto("en", "bogus", env)).toContain("/memory auto");
  });

  test("auto scan reports counts and needs the feature enabled", async () => {
    const s = setupSweep();
    const env = autoEnv(s);
    expect(await handleMemoryAuto("en", "scan", env)).toContain("disabled");
    setAutoExtractEnabled(s.prefs, OWNER, true);
    s.convs.add("c1", [{ role: "user", content: "تولد علی ۱۵ مرداده", createdAt: 9000 }]);
    const text = await handleMemoryAuto("en", "scan", env);
    expect(text).toContain("new proposals");
    expect(text).toContain("/curator");
    expect(s.store.listPending(OWNER)).toHaveLength(1);
  });

  test("export handler builds a package; import handler round-trips it", async () => {
    const src = seedSource();
    const exp = await handleMemoryExport(src, OWNER, 10_000);
    expect(exp.ok).toBe(true);
    if (!exp.ok) return;
    expect(exp.fileName).toMatch(/\.bobimem$/);

    const dst = new FakeMemoryProvider();
    const store = new ProposalStore(new Database(":memory:"));
    const done = await handleMemoryImportText("en", exp.text, {
      provider: dst,
      proposalStore: store,
      ownerId: OWNER,
    }, false);
    expect(done).toContain("2 memories");
    expect(dst.get(OWNER, "project")?.content).toBe("پروژهٔ بابی");

    // Re-import → all skipped.
    const again = await handleMemoryImportText("en", exp.text, {
      provider: dst,
      proposalStore: store,
      ownerId: OWNER,
    }, false);
    expect(again).toContain("duplicates");
  });

  test("import handler rejects garbage and reports conflicts as proposals", async () => {
    const store = new ProposalStore(new Database(":memory:"));
    const env = { provider: new FakeMemoryProvider(), proposalStore: store, ownerId: OWNER };
    expect(await handleMemoryImportText("en", "junk", env, false)).toContain("JSON");
    expect(await handleMemoryImportText("en", "junk", env, false)).toContain("not JSON");

    const src = seedSource();
    const exp = await handleMemoryExport(src, OWNER, 10_000);
    if (!exp.ok) throw new Error("export failed");
    const dst = new FakeMemoryProvider();
    dst.seed("project", "قدیمی", 1);
    const text = await handleMemoryImportText("en", exp.text, {
      provider: dst,
      proposalStore: store,
      ownerId: OWNER,
    }, false);
    expect(text).toContain("/curator");
    expect(store.listPending(OWNER).filter((p) => p.kind === "import")).toHaveLength(1);
    expect(dst.get(OWNER, "project")?.content).toBe("قدیمی"); // not overwritten
  });

  test("isMemoryImportCaption matches /memory import captions", () => {
    expect(isMemoryImportCaption("/memory import")).toBe(true);
    expect(isMemoryImportCaption("/memory import --review")).toBe(true);
    expect(isMemoryImportCaption("/memory export")).toBe(false);
    expect(isMemoryImportCaption("/skill import")).toBe(false);
    expect(isMemoryImportCaption(undefined)).toBe(false);
  });
});


describe("fact extraction: extractFactCandidates", () => {
  test("extracts the user's name (Persian and English)", () => {
    const [fa] = extractFactCandidates(["اسمم محمد است"]);
    expect(fa?.kind).toBe("name");
    expect(fa?.key).toBe("fact:name");
    expect(fa?.importance).toBe(5);
    expect(fa?.content).toContain("محمد");

    const [en] = extractFactCandidates(["my name is Mohammad"]);
    expect(en?.kind).toBe("name");
    expect(en?.key).toBe("fact:name");
  });

  test("extracts preferences in several phrasings", () => {
    const kinds = extractFactCandidates([
      "دوست دارم قهوه بخورم",
      "از چایی خوشم میاد",
      "از قهوه خوشم می‌آید",
      "ترجیح میدم شب کار کنم",
      "متنفرم از شلوغی",
    ]).map((c) => c.kind);
    expect(kinds).toEqual([
      "preference",
      "preference",
      "preference",
      "preference",
      "preference",
    ]);
    for (const c of extractFactCandidates(["دوست دارم قهوه"])) {
      expect(c.importance).toBe(3);
      expect(c.isCorrection).toBe(false);
    }
  });

  test("extracts «یادم بنداز» commitments with importance 4", () => {
    const [c] = extractFactCandidates(["یادم بنداز فردا به علی زنگ بزنم"]);
    expect(c?.kind).toBe("commitment");
    expect(c?.importance).toBe(4);
    expect(c?.content).toContain("علی");

    const [c2] = extractFactCandidates(["remind me to call Ali tomorrow"]);
    expect(c2?.kind).toBe("commitment");
  });

  test("extracts decisions with importance 4", () => {
    const [c] = extractFactCandidates(["تصمیم گرفتم هر روز ورزش کنم"]);
    expect(c?.kind).toBe("decision");
    expect(c?.importance).toBe(4);
  });

  test("a correction beats a preference in the same message", () => {
    const [c] = extractFactCandidates([
      "نه، اشتباه گفتی، من چایی دوست دارم نه قهوه",
    ]);
    expect(c?.kind).toBe("correction");
    expect(c?.isCorrection).toBe(true);
    expect(c?.importance).toBe(5);
    expect(c?.content).not.toContain("اشتباه گفتی");
  });

  test("plain chatter yields no candidates", () => {
    expect(extractFactCandidates(["سلام چطوری", "امروز هوا خوبه"])).toEqual([]);
  });

  test("duplicate topics collapse by key, last wins", () => {
    const cs = extractFactCandidates(["اسمم محمد است", "اسمم علی است"]);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.content).toContain("علی");
  });
});

describe("fact extraction: scoring and keys", () => {
  test("scoreFactImportance ranks name/correction highest", () => {
    expect(scoreFactImportance("name")).toBe(5);
    expect(scoreFactImportance("correction")).toBe(5);
    expect(scoreFactImportance("commitment")).toBe(4);
    expect(scoreFactImportance("decision")).toBe(4);
    expect(scoreFactImportance("preference")).toBe(3);
  });

  test("factKeyFor is deterministic and stable per topic", () => {
    expect(factKeyFor("name", "anything")).toBe("fact:name");
    const a = factKeyFor("preference", "قهوه");
    const b = factKeyFor("preference", "قهوه");
    const c = factKeyFor("preference", "چایی");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // Normalization-insensitive: Arabic ي hashes like Persian ی.
    expect(factKeyFor("preference", "علي")).toBe(factKeyFor("preference", "علی"));
  });
});

describe("fact extraction: correction targeting", () => {
  const corr = (content: string): FactCandidate => ({
    kind: "correction",
    key: factKeyFor("correction", content),
    content,
    importance: 5,
    isCorrection: true,
    source: content,
  });

  test("finds the target by deterministic key", () => {
    const c = corr("من چایی دوست دارم");
    const target = findCorrectionTarget(c, [
      { key: c.key, content: "دوست دارم قهوه" },
      { key: "other", content: "unrelated" },
    ]);
    expect(target?.key).toBe(c.key);
  });

  test("falls back to token overlap when the key is unknown", () => {
    const c = corr("من چایی دوست دارم نه قهوه");
    const target = findCorrectionTarget(c, [
      { key: "fact:preference:xyz", content: "دوست دارم قهوه بخورم" },
      { key: "other", content: "امروز هوا آفتابی است" },
    ]);
    expect(target?.key).toBe("fact:preference:xyz");
  });

  test("returns undefined when nothing looks related", () => {
    const c = corr("تولدم پانزده مرداده");
    expect(
      findCorrectionTarget(c, [{ key: "x", content: "امروز هوا آفتابی است" }]),
    ).toBeUndefined();
  });

  test("a correction proposal UPDATES the target instead of appending", () => {
    const existing = [{ key: "fact:preference:xyz", content: "دوست دارم قهوه" }];
    const [p] = candidatesToFactProposals(
      [corr("دوست دارم چایی")].map((c) => ({ ...c, key: "fact:preference:xyz" })),
      existing,
    );
    expect(p!.kind).toBe("fact");
    expect(p!.suggestedAction).toMatchObject({
      type: "update",
      key: "fact:preference:xyz",
      importance: 5,
    });
    expect(p!.summaryFa).toContain("به‌روزرسانی");
  });

  test("a new fact proposal ADDS with its importance attached", () => {
    const [c] = extractFactCandidates(["اسمم محمد است"]);
    const [p] = candidatesToFactProposals([c!], []);
    expect(p!.kind).toBe("fact");
    expect(p!.suggestedAction).toMatchObject({
      type: "add",
      key: "fact:name",
      importance: 5,
    });
  });

  test("proposal ids are deterministic", () => {
    const [c] = extractFactCandidates(["اسمم محمد است"]);
    const [p1] = candidatesToFactProposals([c!], []);
    const [p2] = candidatesToFactProposals([c!], []);
    expect(p1!.id).toBe(p2!.id);
  });
});

describe("fact extraction: sweep scan", () => {
  test("disabled by default", () => {
    const s = setupSweep();
    expect(isFactExtractEnabled(s.prefs, OWNER)).toBe(false);
    expect(s.prefs.getUserPref(OWNER, FACT_EXTRACT_PREF_KEY)).toBeUndefined();
  });

  test("setFactExtractEnabled round-trips the pref", () => {
    const s = setupSweep();
    setFactExtractEnabled(s.prefs, OWNER, true);
    expect(isFactExtractEnabled(s.prefs, OWNER)).toBe(true);
    setFactExtractEnabled(s.prefs, OWNER, false);
    expect(isFactExtractEnabled(s.prefs, OWNER)).toBe(false);
  });

  test("a disabled sweep touches nothing", async () => {
    const s = setupSweep();
    s.convs.add("c1", [{ role: "user", content: "اسمم محمد است", createdAt: 5000 }]);
    const r = await scanForFactCandidates(scanDeps(s));
    expect(r.enabled).toBe(false);
    expect(r.messagesScanned).toBe(0);
    expect(s.store.listPending(OWNER)).toHaveLength(0);
  });

  test("an enabled sweep files fact proposals but stores nothing", async () => {
    const s = setupSweep();
    setFactExtractEnabled(s.prefs, OWNER, true);
    s.convs.add("c1", [
      { role: "user", content: "اسمم محمد است", createdAt: 5000 },
      { role: "user", content: "یادم بنداز فردا به علی زنگ بزنم", createdAt: 6000 },
      { role: "assistant", content: "باشه", createdAt: 7000 },
    ]);
    const r = await scanForFactCandidates(scanDeps(s));
    expect(r.enabled).toBe(true);
    expect(r.messagesScanned).toBe(2); // assistant messages are not scanned
    expect(r.candidatesFound).toBe(2);
    expect(r.newProposals).toBe(2);
    const pending = s.store.listPending(OWNER);
    expect(pending).toHaveLength(2);
    expect(pending.every((p) => p.kind === "fact")).toBe(true);
    // Nothing written to memory — proposals need owner approval.
    expect(s.provider.count(OWNER)).toBe(0);
  });

  test("a verbatim-stored fact is not proposed again", async () => {
    const s = setupSweep();
    setFactExtractEnabled(s.prefs, OWNER, true);
    s.provider.seed("fact:name", "نام کاربر: محمد", 1000);
    s.convs.add("c1", [{ role: "user", content: "اسمم محمد است", createdAt: 5000 }]);
    const r = await scanForFactCandidates(scanDeps(s));
    expect(r.candidatesFound).toBe(1);
    expect(r.newProposals).toBe(0);
  });

  test("approving a fact proposal stores it with its importance", async () => {
    const s = setupSweep();
    setFactExtractEnabled(s.prefs, OWNER, true);
    s.convs.add("c1", [{ role: "user", content: "اسمم محمد است", createdAt: 5000 }]);
    await scanForFactCandidates(scanDeps(s));
    const [p] = s.store.listPending(OWNER);
    // The apply path threads importance through provider.upsert — the fake
    // provider ignores opts, so assert the action carries it.
    expect(p!.suggestedAction).toMatchObject({ type: "add", importance: 5 });
    const res = await decide(s.svc, p!.id, "approve");
    expect(res.status).toBe("ok");
    expect(s.provider.get(OWNER, "fact:name")?.content).toContain("محمد");
    expect(s.store.listPending(OWNER)).toHaveLength(0);
  });
});
