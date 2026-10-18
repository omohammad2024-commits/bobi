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
    expect(kindLabelFa("event")).toBe("رویداد");
    expect(kindLabelFa("import")).toBe("ورودی");

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
    expect(await handleMemoryAuto("fa", "status", env)).toContain("غیرفعال");
    expect(await handleMemoryAuto("fa", "on", env)).toContain("فعال شد");
    expect(isAutoExtractEnabled(s.prefs, OWNER)).toBe(true);
    expect(await handleMemoryAuto("en", "status", env)).toContain("enabled");
    expect(await handleMemoryAuto("fa", "off", env)).toContain("غیرفعال شد");
    expect(await handleMemoryAuto("fa", "bogus", env)).toContain("/memory auto");
  });

  test("auto scan reports counts and needs the feature enabled", async () => {
    const s = setupSweep();
    const env = autoEnv(s);
    expect(await handleMemoryAuto("fa", "scan", env)).toContain("غیرفعال");
    setAutoExtractEnabled(s.prefs, OWNER, true);
    s.convs.add("c1", [{ role: "user", content: "تولد علی ۱۵ مرداده", createdAt: 9000 }]);
    const text = await handleMemoryAuto("fa", "scan", env);
    expect(text).toContain("1 پیشنهاد جدید");
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
    const done = await handleMemoryImportText("fa", exp.text, {
      provider: dst,
      proposalStore: store,
      ownerId: OWNER,
    }, false);
    expect(done).toContain("2 حافظه");
    expect(dst.get(OWNER, "project")?.content).toBe("پروژهٔ بابی");

    // Re-import → all skipped.
    const again = await handleMemoryImportText("fa", exp.text, {
      provider: dst,
      proposalStore: store,
      ownerId: OWNER,
    }, false);
    expect(again).toContain("3 مورد تکراری");
  });

  test("import handler rejects garbage and reports conflicts as proposals", async () => {
    const store = new ProposalStore(new Database(":memory:"));
    const env = { provider: new FakeMemoryProvider(), proposalStore: store, ownerId: OWNER };
    expect(await handleMemoryImportText("fa", "junk", env, false)).toContain("JSON");
    expect(await handleMemoryImportText("en", "junk", env, false)).toContain("not JSON");

    const src = seedSource();
    const exp = await handleMemoryExport(src, OWNER, 10_000);
    if (!exp.ok) throw new Error("export failed");
    const dst = new FakeMemoryProvider();
    dst.seed("project", "قدیمی", 1);
    const text = await handleMemoryImportText("fa", exp.text, {
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
