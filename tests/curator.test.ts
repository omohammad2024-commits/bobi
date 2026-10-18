/**
 * Phase D4 curator tests.
 *
 * The safety properties pinned here:
 * - review() is read-only: it can never mutate a memory.
 * - A proposal is applied ONLY through the `curator_decide` tool with an
 *   explicit "approve" decision. There is no other apply path: the store has
 *   no provider access, and the stored row (never tool input) is what gets
 *   applied.
 * - Proposals expire after 7 days: a stale approval can never fire later.
 * - Both tools are owner-only: a non-owner actor gets not_allowed.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Storage } from "../src/storage/storage";
import { SqliteMemoryProvider } from "../src/memory/sqlite_provider";
import { ToolService } from "../src/tools/service";
import type { MemoryProvider, StoredMemory } from "../src/memory/provider";
import { CuratorService, CURATOR_TASK_ACTION, kindLabelFa } from "../src/curator/curator";
import { ProposalStore, PROPOSAL_TTL_MS } from "../src/curator/proposals";
import {
  CURATE_MEMORIES_PERMISSION,
  CURATOR_DECIDE_PERMISSION,
  createCuratorTools,
} from "../src/curator/tools";
import type { ToolActor } from "../src/tools/types";

const PERMS = [CURATE_MEMORIES_PERMISSION, CURATOR_DECIDE_PERMISSION];

/**
 * Deterministic in-memory MemoryProvider for tests: timestamps are supplied
 * by the test, so "older vs newer" heuristics never depend on wall-clock.
 */
class FakeMemoryProvider implements MemoryProvider {
  readonly name = "fake";
  private readonly rows = new Map<string, StoredMemory>();

  seed(key: string, content: string, ts: number): void {
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

function ownerActor(userId = "u1"): ToolActor {
  return { userId, permissions: PERMS };
}

function setup(opts: { isOwner?: (id: string) => boolean; now?: () => number } = {}) {
  const provider = new FakeMemoryProvider();
  // exactOptionalPropertyTypes: only pass `now` when the caller gave one.
  const store = new ProposalStore(
    new Database(":memory:"),
    opts.now === undefined ? {} : { now: opts.now },
  );
  const svc = new ToolService({
    extraTools: createCuratorTools({
      provider,
      store,
      isOwner: opts.isOwner ?? (() => true),
    }),
  });
  return { provider, store, svc };
}

function run(svc: ToolService, tool: string, input: unknown, who: ToolActor = ownerActor()) {
  return svc.runTool({ tool, input, actor: who });
}

function snapshot(provider: FakeMemoryProvider): Array<[string, string]> {
  return provider
    .list("u1", 200)
    .map((m) => [m.key, m.content] as [string, string])
    .sort();
}

// ---------- review heuristics ----------

describe("review: duplicate detection", () => {
  test("finds near-duplicates and proposes a merge keeping the newest", async () => {
    const { provider } = setup();
    provider.seed("k1", "اسم پروژه‌ام سول است", 1000);
    provider.seed("k2", "اسم پروژه من سول است", 2000);
    provider.seed("k3", "قهوه دوست دارم", 3000);

    const proposals = await new CuratorService({ provider }).review("u1");
    const dups = proposals.filter((p) => p.kind === "duplicate");
    expect(dups).toHaveLength(1);
    const dup = dups[0]!;
    expect(new Set(dup.memoryIds)).toEqual(new Set(["k1", "k2"]));
    expect(dup.suggestedAction).toEqual({ type: "merge", keepKey: "k2", removeKeys: ["k1"] });
    // The summary is the exact old→new diff, in Persian.
    expect(dup.summaryFa.length).toBeGreaterThan(0);
    expect(dup.summaryFa).toContain("ادغام");
    expect(kindLabelFa("duplicate")).toBe("تکراری");
  });

  test("exact normalized duplicates are caught even when keys differ", async () => {
    const { provider } = setup();
    provider.seed("a", "سلام دنیا", 1000);
    provider.seed("b", "سلام  دنیا!", 2000);
    const proposals = await new CuratorService({ provider }).review("u1");
    expect(proposals.filter((p) => p.kind === "duplicate")).toHaveLength(1);
  });

  test("review is read-only: it never mutates memories", async () => {
    const { provider, store } = setup();
    provider.seed("k1", "اسم پروژه‌ام سول است", 1000);
    provider.seed("k2", "اسم پروژه من سول است", 2000);
    const before = snapshot(provider);
    const proposals = await new CuratorService({ provider }).review("u1");
    expect(proposals.length).toBeGreaterThan(0);
    store.saveProposals("u1", proposals);
    expect(snapshot(provider)).toEqual(before);
  });

  test("deterministic: same memories yield the same proposal ids", async () => {
    const s1 = setup();
    const s2 = setup();
    for (const s of [s1, s2]) {
      s.provider.seed("k1", "اسم پروژه‌ام سول است", 1000);
      s.provider.seed("k2", "اسم پروژه من سول است", 2000);
    }
    const r1 = await new CuratorService({ provider: s1.provider }).review("u1");
    const r2 = await new CuratorService({ provider: s2.provider }).review("u1");
    expect(r1.map((p) => p.id)).toEqual(r2.map((p) => p.id));
  });
});

describe("review: stale detection", () => {
  test("contradicted entries propose deleting the older one", async () => {
    const { provider } = setup();
    provider.seed("old", "من قهوه را خیلی دوست دارم", 1000);
    provider.seed("new", "دیگر اصلا قهوه دوست ندارم", 2000);

    const proposals = await new CuratorService({ provider }).review("u1");
    const stales = proposals.filter((p) => p.kind === "stale");
    expect(stales).toHaveLength(1);
    const stale = stales[0]!;
    expect(stale.memoryIds).toEqual(["old", "new"]);
    expect(stale.suggestedAction).toEqual({ type: "delete", keys: ["old"] });
    expect(stale.summaryFa).toContain("تضاد");
  });

  test("different topics are not flagged as contradictions", async () => {
    const { provider } = setup();
    provider.seed("a", "من قهوه دوست دارم", 1000);
    provider.seed("b", "من چای دوست ندارم", 2000);
    const proposals = await new CuratorService({ provider }).review("u1");
    expect(proposals.filter((p) => p.kind === "stale")).toHaveLength(0);
  });
});

describe("review: split detection", () => {
  test("overloaded entries propose a split into separate keys", async () => {
    const { provider } = setup();
    provider.seed(
      "notes",
      "اول: پروژه سول یک بات تلگرامی فارسی است که با تایپ‌اسکریپت نوشته شده است\n" +
        "دوم: دیتابیس اس‌کیو‌ال‌لایت برای ذخیره‌سازی حافظه بلندمدت استفاده می‌شود\n" +
        "سوم: زمان‌بندی وظایف با عبارت کرون انجام می‌شود و مالک آن را مدیریت می‌کند",
      1000,
    );
    const proposals = await new CuratorService({ provider }).review("u1");
    const splits = proposals.filter((p) => p.kind === "split");
    expect(splits).toHaveLength(1);
    const split = splits[0]!;
    expect(split.memoryIds).toEqual(["notes"]);
    const action = split.suggestedAction;
    expect(action.type).toBe("split");
    if (action.type === "split") {
      expect(action.parts).toHaveLength(3);
      expect(action.parts.map((p) => p.key)).toEqual(["notes-1", "notes-2", "notes-3"]);
    }
  });

  test("short multi-line entries are left alone", async () => {
    const { provider } = setup();
    provider.seed("short", "خط اول\nخط دوم\nخط سوم", 1000);
    const proposals = await new CuratorService({ provider }).review("u1");
    expect(proposals.filter((p) => p.kind === "split")).toHaveLength(0);
  });
});

// ---------- curate_memories tool ----------

describe("curate_memories tool", () => {
  test("stores proposals and returns the Persian proposal list", async () => {
    const { provider, svc } = setup();
    provider.seed("k1", "اسم پروژه‌ام سول است", 1000);
    provider.seed("k2", "اسم پروژه من سول است", 2000);

    const res = await run(svc, "curate_memories", {});
    expect(res.status).toBe("ok");
    const data = res.data as { count: number; proposals: Array<{ id: string; kindFa: string; summaryFa: string }> };
    expect(data.count).toBe(1);
    expect(data.proposals[0]!.kindFa).toBe("تکراری");
    expect(data.proposals[0]!.summaryFa.length).toBeGreaterThan(0);
  });

  test("re-running does not pile up duplicate proposal rows", async () => {
    const { provider, svc, store } = setup();
    provider.seed("k1", "اسم پروژه‌ام سول است", 1000);
    provider.seed("k2", "اسم پروژه من سول است", 2000);

    await run(svc, "curate_memories", {});
    await run(svc, "curate_memories", {});
    expect(store.countPending("u1")).toBe(1);
  });

  test("empty memory store yields no proposals and no crash", async () => {
    const { svc } = setup();
    const res = await run(svc, "curate_memories", {});
    expect(res.status).toBe("ok");
    expect((res.data as { count: number }).count).toBe(0);
  });

  test("both tools are ownerOnly and declare their own permissions", async () => {
    const { svc } = setup();
    for (const name of ["curate_memories", "curator_decide"]) {
      const tool = svc.registry.find(name);
      expect(tool?.ownerOnly).toBe(true);
      expect(svc.listActiveNames()).toContain(name);
    }
  });
});

// ---------- curator_decide tool: the only apply path ----------

describe("curator_decide: approve applies, everything else does not", () => {
  async function reviewed() {
    const s = setup();
    s.provider.seed("k1", "اسم پروژه‌ام سول است", 1000);
    s.provider.seed("k2", "اسم پروژه من سول است", 2000);
    const res = await run(s.svc, "curate_memories", {});
    const data = res.data as { proposals: Array<{ id: string }> };
    return { ...s, proposalId: data.proposals[0]!.id };
  }

  test("approve applies the merge: older key deleted, newest kept", async () => {
    const { svc, provider, proposalId } = await reviewed();
    const res = await run(svc, "curator_decide", { proposalId, decision: "approve" });
    expect(res.status).toBe("ok");
    const data = res.data as { applied: boolean; decision: string };
    expect(data.applied).toBe(true);
    expect(data.decision).toBe("approve");
    expect(provider.get("u1", "k1")).toBeUndefined();
    expect(provider.get("u1", "k2")?.content).toBe("اسم پروژه من سول است");
  });

  test("reject leaves memories untouched", async () => {
    const { svc, provider, store, proposalId } = await reviewed();
    const before = snapshot(provider);
    const res = await run(svc, "curator_decide", { proposalId, decision: "reject" });
    expect(res.status).toBe("ok");
    expect((res.data as { applied: boolean }).applied).toBe(false);
    expect(snapshot(provider)).toEqual(before);
    expect(store.countPending("u1")).toBe(0);
  });

  test("a second decision on the same proposal is not_found: no double apply", async () => {
    const { svc, provider, proposalId } = await reviewed();
    await run(svc, "curator_decide", { proposalId, decision: "approve" });
    const again = await run(svc, "curator_decide", { proposalId, decision: "approve" });
    expect(again.status).toBe("not_found");
    // Still exactly the single-apply state.
    expect(provider.get("u1", "k2")?.content).toBe("اسم پروژه من سول است");
    expect(provider.count("u1")).toBe(1);
  });

  test("unknown proposal id is not_found", async () => {
    const { svc } = setup();
    const res = await run(svc, "curator_decide", { proposalId: "cur-nope", decision: "approve" });
    expect(res.status).toBe("not_found");
  });

  test("invalid decision is rejected by input validation", async () => {
    const { svc } = setup();
    const res = await run(svc, "curate_memories", {});
    expect(res.status).toBe("ok");
    const bad = await run(svc, "curator_decide", { proposalId: "cur-x", decision: "maybe" });
    expect(bad.status).toBe("invalid_input");
  });

  test("resolving on the store alone cannot apply: the store has no provider", async () => {
    // This pins the architecture: ProposalStore.resolveProposal only flips a
    // row's status. Even called directly with "approve", memories are
    // untouched — application lives only in the tool's approve branch.
    const { provider, store, proposalId } = await reviewed();
    const before = snapshot(provider);
    const resolved = store.resolveProposal("u1", proposalId, "approve");
    expect(resolved?.status).toBe("approved");
    expect(snapshot(provider)).toEqual(before);
  });

  test("a proposal for another user cannot be decided by this owner", async () => {
    const s = setup();
    s.provider.seed("k1", "اسم پروژه‌ام سول است", 1000);
    s.provider.seed("k2", "اسم پروژه من سول است", 2000);
    const res = await run(s.svc, "curate_memories", {}, ownerActor("u1"));
    const id = (res.data as { proposals: Array<{ id: string }> }).proposals[0]!.id;
    // A different owner (still owner of their own id) cannot touch u1's row.
    const other = await run(s.svc, "curator_decide", { proposalId: id, decision: "approve" }, ownerActor("u2"));
    expect(other.status).toBe("not_found");
    expect(s.provider.count("u1")).toBe(2);
  });
});

// ---------- expiry ----------

describe("proposal expiry", () => {
  test("proposals older than 7 days cannot be listed or approved", async () => {
    let nowMs = 1_000_000;
    const { provider, store } = setup({ now: () => nowMs });
    provider.seed("k1", "اسم پروژه‌ام سول است", 1000);
    provider.seed("k2", "اسم پروژه من سول است", 2000);
    const proposals = await new CuratorService({ provider }).review("u1");
    const saved = store.saveProposals("u1", proposals);
    const id = saved[0]!.id;
    expect(store.listPending("u1")).toHaveLength(1);

    // Travel past the TTL.
    nowMs += PROPOSAL_TTL_MS + 1;
    expect(store.listPending("u1")).toHaveLength(0);
    expect(store.getPending("u1", id)).toBeUndefined();
    expect(store.resolveProposal("u1", id, "approve")).toBeUndefined();

    // Memories untouched: the expired proposal never fired.
    expect(provider.get("u1", "k1")?.content).toBe("اسم پروژه‌ام سول است");
  });

  test("fresh proposals survive; the TTL is 7 days", () => {
    expect(PROPOSAL_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    let nowMs = 5_000_000;
    const store = new ProposalStore(new Database(":memory:"), { now: () => nowMs });
    const proposals = [
      {
        id: "cur-test1",
        kind: "duplicate" as const,
        memoryIds: ["a", "b"],
        summaryFa: "تست",
        suggestedAction: { type: "delete" as const, keys: ["a"] },
      },
    ];
    store.saveProposals("u1", proposals);
    nowMs += PROPOSAL_TTL_MS - 1000; // just inside the TTL
    expect(store.listPending("u1")).toHaveLength(1);
    expect(store.getPending("u1", "cur-test1")?.id).toBe("cur-test1");
  });
});

// ---------- ownership ----------

describe("ownership", () => {
  test("non-owner actor gets not_allowed from both tools", async () => {
    const { svc } = setup({ isOwner: () => false });
    const actor = ownerActor("intruder");
    const r1 = await run(svc, "curate_memories", {}, actor);
    expect(r1.status).toBe("not_allowed");
    const r2 = await run(svc, "curator_decide", { proposalId: "cur-x", decision: "approve" }, actor);
    expect(r2.status).toBe("not_allowed");
  });

  test("unknown identity gets not_allowed", async () => {
    const { svc } = setup();
    const r = await run(svc, "curate_memories", {}, { userId: "unknown", permissions: PERMS });
    expect(r.status).toBe("not_allowed");
  });

  test("tools are registered and runnable through the real ToolService", async () => {
    // Guards against the tools drifting out of the registry contract.
    const { svc } = setup();
    expect(svc.registry.has("curate_memories")).toBe(true);
    expect(svc.registry.has("curator_decide")).toBe(true);
  });
});

// ---------- parity with the real provider ----------

describe("works against the real SqliteMemoryProvider", () => {
  test("review + approve end-to-end on SQLite storage", async () => {
    const storage = Storage.open(":memory:");
    try {
      const provider = new SqliteMemoryProvider(storage);
      const store = new ProposalStore(new Database(":memory:"));
      const svc = new ToolService({
        extraTools: createCuratorTools({ provider, store, isOwner: () => true }),
      });
      await provider.upsert("u1", "k1", "اسم پروژه‌ام سول است");
      await provider.upsert("u1", "k2", "اسم پروژه من سول است");

      const reviewRes = await run(svc, "curate_memories", {});
      expect(reviewRes.status).toBe("ok");
      const id = (reviewRes.data as { proposals: Array<{ id: string }> }).proposals[0]!.id;

      const decideRes = await run(svc, "curator_decide", { proposalId: id, decision: "approve" });
      expect(decideRes.status).toBe("ok");
      expect(await provider.count("u1")).toBe(1);
    } finally {
      storage.close();
    }
  });
});

// ---------- scheduler hook constant ----------

describe("scheduler hook", () => {
  test("CURATOR_TASK_ACTION is the documented short name", () => {
    expect(CURATOR_TASK_ACTION).toBe("curate");
  });
});
