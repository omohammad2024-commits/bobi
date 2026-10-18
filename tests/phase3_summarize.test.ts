/**
 * Phase-3 item 1: periodic auto-summarization.
 *
 * Covers: candidate selection (age cutoff, event:/archive: skipping, short
 * memories), deterministic archive keys (+ collision suffix), the heuristic
 * archive body, the LLM-injection opt-in, the "archive" proposal shape
 * (deletion proposed, never performed), and the owner-only tool surfaces
 * (summarize_memories, note_event, list_events).
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { MemoryProvider, StoredMemory } from "../src/memory/provider";
import {
  SummarizerService,
  isSummarizerSkippedKey,
  snippetOf,
} from "../src/curator/summarize";
import { kindLabelFa } from "../src/curator/curator";
import {
  LIST_EVENTS_PERMISSION,
  NOTE_EVENT_PERMISSION,
  SUMMARIZE_MEMORIES_PERMISSION,
  createCuratorTools,
} from "../src/curator/tools";
import { ProposalStore } from "../src/curator/proposals";
import { ToolService } from "../src/tools/service";
import type { ToolActor } from "../src/tools/types";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 2026-10-18T04:30:00Z — the archive key becomes archive:2026-10-18. */
const NOW_MS = Date.parse("2026-10-18T04:30:00Z");

class FakeProvider implements MemoryProvider {
  readonly name = "fake";
  private readonly rows = new Map<string, StoredMemory>();
  nowMs = NOW_MS;

  seed(key: string, content: string, updatedAt: number): void {
    this.rows.set(key, { key, content, createdAt: updatedAt, updatedAt });
  }

  async upsert(_userId: string, key: string, content: string): Promise<void> {
    const prev = this.rows.get(key);
    this.rows.set(key, {
      key,
      content,
      createdAt: prev?.createdAt ?? this.nowMs,
      updatedAt: this.nowMs,
    });
  }

  async get(_userId: string, key: string): Promise<StoredMemory | undefined> {
    return this.rows.get(key);
  }

  async list(_userId: string, limit = 50): Promise<StoredMemory[]> {
    return [...this.rows.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async delete(_userId: string, key: string): Promise<boolean> {
    return this.rows.delete(key);
  }

  async count(): Promise<number> {
    return this.rows.size;
  }

  keys(): string[] {
    return [...this.rows.keys()].sort();
  }
}

function service(provider: FakeProvider, opts: Record<string, unknown> = {}) {
  return new SummarizerService({ provider }, { now: () => NOW_MS, ...opts });
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

describe("SummarizerService selection", () => {
  test("archives only memories older than the cutoff", async () => {
    const p = new FakeProvider();
    p.seed("old", "این یک خاطرهٔ قدیمی و طولانی است که باید بایگانی شود", NOW_MS - 100 * DAY_MS);
    p.seed("young", "این یک خاطرهٔ تازه و طولانی است که نباید دست بخورد", NOW_MS - 10 * DAY_MS);
    const report = await service(p).review("u1");
    expect(report.archived).toBe(true);
    expect(report.count).toBe(1);
    expect(report.proposal?.memoryIds).toEqual(["old"]);
    // The original is still there — the pass never deletes.
    expect(await p.get("u1", "old")).toBeDefined();
    expect(await p.get("u1", "young")).toBeDefined();
  });

  test("skips event: and archive: keys", async () => {
    const p = new FakeProvider();
    p.seed("event:birthday:abc", JSON.stringify({ v: 1 }), NOW_MS - 200 * DAY_MS);
    p.seed("archive:2026-01-01", "بایگانی قبلی", NOW_MS - 200 * DAY_MS);
    expect(isSummarizerSkippedKey("event:birthday:abc")).toBe(true);
    expect(isSummarizerSkippedKey("archive:2026-01-01")).toBe(true);
    expect(isSummarizerSkippedKey("k1")).toBe(false);
    const report = await service(p).review("u1");
    expect(report.archived).toBe(false);
  });

  test("skips short memories and reports the reason", async () => {
    const p = new FakeProvider();
    p.seed("tiny", "کم", NOW_MS - 200 * DAY_MS);
    const report = await service(p).review("u1");
    expect(report.archived).toBe(false);
    expect(report.reason).toBeDefined();
  });

  test("respects olderThanDays and maxEntries overrides", async () => {
    const p = new FakeProvider();
    for (let i = 0; i < 5; i++) {
      p.seed(`k${i}`, `خاطرهٔ شمارهٔ ${i} با متن کافی برای بایگانی شدن`, NOW_MS - 40 * DAY_MS);
    }
    const capped = await service(p).review("u1", { olderThanDays: 30, maxEntries: 2 });
    expect(capped.count).toBe(2);
    const none = await service(p).review("u1", { olderThanDays: 365 });
    expect(none.archived).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// archive writing
// ---------------------------------------------------------------------------

describe("archive writing", () => {
  test("writes one deterministic archive key with a heuristic body", async () => {
    const p = new FakeProvider();
    p.seed("k1", "قهوهٔ ترک دوست دارم و هر صبح می‌خورم", NOW_MS - 100 * DAY_MS);
    p.seed("k2", "پروژهٔ سول را شروع کردم", NOW_MS - 120 * DAY_MS);
    const report = await service(p).review("u1");
    expect(report.archiveKey).toBe("archive:2026-10-18");
    const archive = await p.get("u1", "archive:2026-10-18");
    expect(archive).toBeDefined();
    expect(archive!.content).toContain("بایگانی حافظه");
    expect(archive!.content).toContain("k1");
    expect(archive!.content).toContain("k2");
    // Oldest first in the body.
    expect(archive!.content.indexOf("k2")).toBeLessThan(archive!.content.indexOf("k1"));
  });

  test("suffixes the archive key on collision instead of overwriting", async () => {
    const p = new FakeProvider();
    p.seed("archive:2026-10-18", "بایگانی دستی مالک", NOW_MS - 5 * DAY_MS);
    p.seed("k1", "خاطرهٔ قدیمی طولانی برای بایگانی", NOW_MS - 100 * DAY_MS);
    const report = await service(p).review("u1");
    expect(report.archiveKey).toBe("archive:2026-10-18-2");
    expect((await p.get("u1", "archive:2026-10-18"))!.content).toBe("بایگانی دستی مالک");
  });

  test("uses the injected LLM summarizer when provided", async () => {
    const p = new FakeProvider();
    p.seed("k1", "خاطرهٔ قدیمی طولانی برای بایگانی", NOW_MS - 100 * DAY_MS);
    const report = await service(p, {
      llm: async (entries: Array<{ key: string }>) =>
        `خلاصهٔ هوشمند ${entries.length} مورد`,
    }).review("u1");
    const archive = await p.get("u1", report.archiveKey!);
    expect(archive!.content).toBe("خلاصهٔ هوشمند 1 مورد");
  });

  test("snippetOf is deterministic and clipped", () => {
    expect(snippetOf("  سلام   دنیا  ")).toBe("سلام دنیا");
    const long = "x".repeat(200);
    expect(snippetOf(long)).toBe("x".repeat(119) + "…");
  });
});

// ---------------------------------------------------------------------------
// proposal shape: deletion is proposed, never performed
// ---------------------------------------------------------------------------

describe("archive proposal", () => {
  test("proposal kind is archive with a delete action over the originals", async () => {
    const p = new FakeProvider();
    p.seed("k1", "خاطرهٔ قدیمی طولانی شماره یک", NOW_MS - 100 * DAY_MS);
    p.seed("k2", "خاطرهٔ قدیمی طولانی شماره دو", NOW_MS - 110 * DAY_MS);
    const report = await service(p).review("u1");
    const proposal = report.proposal!;
    expect(proposal.kind).toBe("archive");
    expect(kindLabelFa("archive")).toBe("بایگانی");
    expect(proposal.memoryIds.sort()).toEqual(["k1", "k2"]);
    expect(proposal.suggestedAction).toEqual({ type: "delete", keys: ["k1", "k2"] });
    expect(proposal.summaryFa).toContain("archive:2026-10-18");
    // Deterministic id: a repeated review of unchanged data yields the same id.
    const again = await service(p, {}).review("u1");
    // (the second run archives nothing new — k1/k2 still present but the
    // archive key now collides and suffixes; the proposal id over the same
    // original keys is stable)
    expect(again.proposal!.id).toBe(proposal.id);
  });
});

// ---------------------------------------------------------------------------
// tools: owner-only surfaces
// ---------------------------------------------------------------------------

const OWNER = "u1";
const STRANGER = "u9";

function ownerActor(): ToolActor {
  return {
    userId: OWNER,
    permissions: [SUMMARIZE_MEMORIES_PERMISSION, NOTE_EVENT_PERMISSION, LIST_EVENTS_PERMISSION],
  };
}

function setup() {
  const provider = new FakeProvider();
  const store = new ProposalStore(new Database(":memory:"));
  const svc = new ToolService({
    extraTools: createCuratorTools({
      provider,
      store,
      isOwner: (id) => id === OWNER,
      now: () => NOW_MS,
    }),
  });
  return { provider, store, svc };
}

function ctx(userId: string) {
  return {
    clock: () => new Date(NOW_MS),
    actor: { userId, permissions: [] as string[] },
    signal: new AbortController().signal,
  };
}

describe("summarize_memories tool", () => {
  test("archives and stores the deletion proposal for the owner", async () => {
    const { provider, store, svc } = setup();
    provider.seed("k1", "خاطرهٔ قدیمی طولانی برای بایگانی شدن", NOW_MS - 100 * DAY_MS);
    const r = await svc.runTool({
      tool: "summarize_memories",
      input: { olderThanDays: 90 },
      actor: ownerActor(),
    });
    expect(r.status).toBe("ok");
    const out = r.data as { archived: boolean; proposalId: string; summaryFa: string };
    expect(out.archived).toBe(true);
    expect(out.proposalId).toBeDefined();
    const pending = store.getPending(OWNER, out.proposalId);
    expect(pending?.kind).toBe("archive");
    // The archive exists; the original still exists (no silent deletion).
    expect(provider.keys()).toContain("archive:2026-10-18");
    expect(provider.keys()).toContain("k1");
  });

  test("rejects non-owners", async () => {
    const { svc } = setup();
    const r = await svc.runTool({
      tool: "summarize_memories",
      input: {},
      actor: { userId: STRANGER, permissions: [] },
    });
    expect(r.status).toBe("not_allowed");
  });

  test("reports cleanly when nothing is archivable", async () => {
    const { svc } = setup();
    const r = await svc.runTool({
      tool: "summarize_memories",
      input: {},
      actor: ownerActor(),
    });
    expect(r.status).toBe("ok");
    expect((r.data as { archived: boolean }).archived).toBe(false);
  });
});

describe("note_event / list_events tools", () => {
  test("note_event stores a Persian-dated event", async () => {
    const { provider, svc } = setup();
    const r = await svc.runTool({
      tool: "note_event",
      input: { name: "علی", kind: "birthday", date: "۱۵ مرداد" },
      actor: ownerActor(),
    });
    expect(r.status).toBe("ok");
    const out = r.data as { key: string; labelFa: string; summaryFa: string };
    expect(out.key.startsWith("event:birthday:")).toBe(true);
    expect(out.labelFa).toBe("۱۵ مرداد");
    expect(out.summaryFa).toContain("علی");
    expect(provider.keys()).toContain(out.key);
  });

  test("note_event forces kind=once when a Jalali year is given", async () => {
    const { svc } = setup();
    const r = await svc.runTool({
      tool: "note_event",
      input: { name: "کنفرانس", kind: "anniversary", date: "۲۰ شهریور ۱۴۰۳" },
      actor: ownerActor(),
    });
    expect(r.status).toBe("ok");
    expect((r.data as { kind: string }).kind).toBe("once");
  });

  test("note_event rejects an unparsable date", async () => {
    const { svc } = setup();
    const r = await svc.runTool({
      tool: "note_event",
      input: { name: "علی", kind: "birthday", date: "فردا" },
      actor: ownerActor(),
    });
    expect(r.status).toBe("invalid_input");
    // The executor sanitizes tool-error text; the Persian detail is logged,
    // not echoed — assert only the status here.
    expect(r.message).toBeDefined();
  });

  test("note_event and list_events are owner-only", async () => {
    const { svc } = setup();
    const stranger = { userId: STRANGER, permissions: [] as string[] };
    const r1 = await svc.runTool({
      tool: "note_event",
      input: { name: "x", kind: "birthday", date: "۱۵ مرداد" },
      actor: stranger,
    });
    expect(r1.status).toBe("not_allowed");
    const r2 = await svc.runTool({ tool: "list_events", input: {}, actor: stranger });
    expect(r2.status).toBe("not_allowed");
  });

  test("list_events shows days-until for each event", async () => {
    const { svc } = setup();
    await svc.runTool({
      tool: "note_event",
      input: { name: "علی", kind: "birthday", date: "۲۹ مهر" },
      actor: ownerActor(),
    });
    const r = await svc.runTool({ tool: "list_events", input: {}, actor: ownerActor() });
    expect(r.status).toBe("ok");
    const out = r.data as {
      events: Array<{ name: string; daysUntil: number; whenFa: string }>;
      count: number;
    };
    expect(out.count).toBe(1);
    expect(out.events[0]!.name).toBe("علی");
    expect(out.events[0]!.daysUntil).toBe(3);
    expect(out.events[0]!.whenFa).toBe("۳ روز دیگه");
  });
});
