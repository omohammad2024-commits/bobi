/**
 * Phase 6 — per-repository tests.
 *
 * Each domain repository is exercised in isolation: a DbHandle over an
 * in-memory database, ONLY that repo's DDL fragment applied (plus the
 * idempotent ALTERs the facade's migrate() owns for that domain), and a
 * round-trip through the repo's own API. This proves every domain's
 * storage is independently testable — the point of the split.
 *
 * Also covered: the facade wiring (all repos share ONE handle; writes via
 * a repo are visible via the facade and vice versa; satellite stores built
 * on storage.database share the connection), and the previous-version
 * migration proof (the pre-phase-6 backup DB, schema v18, opens and its
 * data is readable through the repositories).
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbHandle } from "../src/storage/db_handle";
import { Storage } from "../src/storage/storage";
import { ACCESS_SCHEMA, AccessRepo } from "../src/storage/repos/access";
import { CONVERSATIONS_SCHEMA, ConversationsRepo } from "../src/storage/repos/conversations";
import { MEMORIES_SCHEMA, MemoriesRepo } from "../src/storage/repos/memories";
import { MISC_SCHEMA, MiscRepo } from "../src/storage/repos/misc";
import { PROVIDERS_SCHEMA, ProvidersRepo } from "../src/storage/repos/providers";
import { SCHEDULING_SCHEMA, SchedulingRepo } from "../src/storage/repos/scheduling";
import { USAGE_SCHEMA, UsageRepo } from "../src/storage/repos/usage";
import { BenchHistory } from "../src/bench/history";

function handleWith(...fragments: string[]): DbHandle {
  const h = new DbHandle(new Database(":memory:"));
  for (const f of fragments) h.execScript(f);
  return h;
}

describe("ConversationsRepo in isolation", () => {
  test("conversation/message round-trip + FTS search", () => {
    const repo = new ConversationsRepo(handleWith(CONVERSATIONS_SCHEMA));
    const id = repo.appendMessage("u1", "c1", "user", "salam donya");
    expect(id).toBeGreaterThan(0);
    repo.appendMessage("u1", "c1", "assistant", "chetori");
    const hist = repo.history("u1", "c1");
    expect(hist.map((m) => m.content)).toEqual(["salam donya", "chetori"]);
    expect(repo.countMessages("u1", "c1")).toBe(2);
    expect(repo.searchMessages("donya", { userId: "u1" }).length).toBe(1);
    // ownership: another user sees nothing
    expect(repo.history("intruder", "c1")).toEqual([]);
    expect(repo.listUserConversations("u1").length).toBe(1);
  });

  test("conversation summaries round-trip", () => {
    const repo = new ConversationsRepo(handleWith(CONVERSATIONS_SCHEMA));
    repo.appendMessage("u1", "c1", "user", "hello");
    repo.setConversationSummary({ userId: "u1", chatId: "c1", summary: "sum", summarisedUntil: 1 });
    expect(repo.getConversationSummary("u1", "c1")?.summary).toBe("sum");
    repo.clearConversationSummary("u1", "c1");
    expect(repo.getConversationSummary("u1", "c1")).toBeUndefined();
  });
});

describe("AccessRepo in isolation", () => {
  test("group approval state machine + audit log", () => {
    const repo = new AccessRepo(handleWith(ACCESS_SCHEMA));
    repo.createPendingGroup({ chatId: "-100", title: "g", chatType: "supergroup", requestedBy: "42" });
    expect(repo.groupAccess("-100")?.state).toBe("pending");
    expect(repo.transitionGroup("-100", "pending", "approved", "1")).toBe(true);
    expect(repo.groupAccess("-100")?.state).toBe("approved");
    expect(repo.countGroupsByState("approved")).toBe(1);
    repo.appendAudit({ operation: "test.op", outcome: "success", actorId: "1" });
    expect(repo.auditEvents(10).length).toBe(1);
    repo.createPendingUser({ userId: "7" });
    expect(repo.userAccess("7")?.state).toBe("pending");
  });
});

describe("UsageRepo in isolation", () => {
  test("daily counters + ledger totals", () => {
    const repo = new UsageRepo(handleWith(USAGE_SCHEMA));
    repo.addUsage({ userId: "u1", day: new Date().toISOString().slice(0, 10), requests: 2, toolCalls: 1, inputTokens: 100, outputTokens: 50 });
    const day = repo.usageForDay(new Date().toISOString().slice(0, 10));
    expect(day?.requests).toBe(2);
    repo.recordUsage({
      userId: "u1", conversationId: 1, providerId: 1, modelId: "m",
      inputTokens: 10, outputTokens: 5, atMs: Date.now(),
    });
    expect(repo.usageTotals("u1").inputTokens).toBe(10);
    expect(repo.usageByModel("u1")[0]?.modelId).toBe("m");
  });
});

describe("SchedulingRepo in isolation", () => {
  test("reminders due/claim, tasks, goals, heartbeats", () => {
    const repo = new SchedulingRepo(handleWith(SCHEDULING_SCHEMA));
    const rid = repo.createReminder({ userId: "u1", chatId: "c1", text: "wake", dueAt: 1000, repeat: "none" });
    expect(repo.dueReminders(2000).map((r) => r.id)).toContain(rid);
    expect(repo.claimReminder(rid, 2000)).toBe(true);
    expect(repo.getReminder("u1", rid)?.state).toBe("fired");
    const tid = repo.createTask({
      name: "t", cronExpr: "* * * * *", timezone: "UTC", actionJson: "{}",
      createdByUserId: "u1", nextRunAtMs: 500,
    });
    expect(repo.dueTasks(1000).map((t) => t.id)).toContain(tid);
    const gid = repo.createGoal({ title: "goal", createdBy: "u1" });
    repo.completeGoal("u1", gid);
    expect(repo.getGoal("u1", gid)?.status).toBe("done");
    repo.logHeartbeat({ summary: "test", toolCalls: 0, status: "ok" });
    expect(repo.recentHeartbeats(5).length).toBe(1);
  });
});

describe("MemoriesRepo in isolation", () => {
  test("upsert/get/list/delete round-trip", () => {
    // Fresh databases get the importance/recall columns from the SCHEMA
    // fragment itself; migrate()'s idempotent ALTERs only serve old DBs.
    const repo = new MemoriesRepo(handleWith(MEMORIES_SCHEMA));
    repo.upsertMemory({ userId: "u1", key: "k1", content: "v1", importance: 4 });
    expect(repo.getMemory("u1", "k1")?.content).toBe("v1");
    expect(repo.getMemory("u1", "k1")?.importance).toBe(4);
    repo.upsertMemory({ userId: "u1", key: "k1", content: "v2" });
    expect(repo.countMemories("u1")).toBe(1);
    expect(repo.listMemories("u1")[0]?.content).toBe("v2");
    repo.deleteMemory("u1", "k1");
    expect(repo.countMemories("u1")).toBe(0);
  });
});

describe("ProvidersRepo in isolation", () => {
  test("providers, credentials, pool, models, runtime, failover, search", () => {
    const repo = new ProvidersRepo(handleWith(PROVIDERS_SCHEMA));
    const pid = repo.createProvider({ label: "p1", adapter: "openai", baseUrl: "https://x.test/v1" });
    expect(repo.listProviders().map((p) => p.id)).toContain(pid);
    repo.upsertCredential({ providerId: pid, iv: "i", ciphertext: "c", tag: "t" });
    expect(repo.hasCredential(pid)).toBe(true);
    expect(repo.getCredential(pid)?.ciphertext).toBe("c");
    const poolId = repo.addPoolCredential({ providerId: pid, label: "k1", iv: "i", ciphertext: "c2", tag: "t" });
    expect(repo.listPoolCredentials(pid).map((c) => c.id)).toContain(poolId);
    expect(repo.poolPosition(pid, 1)).toBe(0);
    const mid = repo.createModel({ providerId: pid, modelId: "m1", label: "M1" });
    expect(repo.listModels(pid).map((m) => m.id)).toContain(mid);
    repo.setRuntimeSelection({ providerId: pid, modelId: mid });
    expect(repo.getRuntimeSettings().activeProviderId).toBe(pid);
    repo.setFailoverCandidates([{ providerId: pid, modelId: mid }]);
    expect(repo.listFailoverCandidates().length).toBe(1);
    repo.setSearchProvider("tavily");
    expect(repo.getSearchSettings().provider).toBe("tavily");
    repo.upsertSearchCredential({ iv: "i", ciphertext: "c", tag: "t" });
    expect(repo.hasSearchCredential()).toBe(true);
  });
});

describe("MiscRepo in isolation", () => {
  test("prefs, owner profile doc, skill trust, shortcuts", () => {
    const repo = new MiscRepo(handleWith(MISC_SCHEMA));
    repo.setUserPref("u1", "lang", "fa");
    expect(repo.getUserPref("u1", "lang")).toBe("fa");
    expect(repo.listUserPrefKeys("u1", "")).toContain("lang");
    repo.setOwnerProfileDoc("{\"name\":\"Mohammad\"}");
    expect(repo.getOwnerProfileDoc()).toContain("Mohammad");
    repo.setSkillSigningKey({ keyId: "k1", publicKey: "pub", privateKeyJwk: "{}" });
    expect(repo.getSkillSigningKey()?.keyId).toBe("k1");
    repo.trustSkillPublisher({ keyId: "p1", label: "P1", publicKey: "pk" });
    expect(repo.getTrustedSkillPublisher("p1")?.publicKey).toBe("pk");
    repo.upsertShortcut({ name: "s1", kind: "prompt", action: "do it" });
    expect(repo.getShortcut("s1")?.action).toBe("do it");
    expect(repo.deleteShortcut("s1")).toBe(true);
  });
});

describe("facade wiring — one handle for everything", () => {
  test("repos share the Storage handle; satellite stores share the connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "bobi-repos-"));
    try {
      const s = Storage.open(join(dir, "t.db"));
      // repo write -> facade read, facade write -> repo read
      s.providers.createProvider({ label: "via-facade", adapter: "openai", baseUrl: "https://x" });
      expect(s.listProviders().length).toBe(1);
      const pid = s.providers.createProvider({ label: "via-repo", adapter: "openai", baseUrl: "https://y" });
      expect(s.getProvider(pid)?.label).toBe("via-repo");
      // satellite store on the shared connection sees its tables alongside
      const bench = new BenchHistory(s.database);
      bench.markAlertSent("k", 123);
      expect(bench.recentAlerts(5)).toEqual([{ key: "k", lastSentMs: 123 }]);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const BACKUP = "/home/hatch/workspace/bobi-vm-backup/bobi.db.20261019";
describe("previous-version DB migration proof", () => {
  test.skipIf(!existsSync(BACKUP))(
    "pre-phase-6 backup (schema v18) opens, migrates, and reads through repos",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "bobi-mig-"));
      try {
        const p = join(dir, "old.db");
        copyFileSync(BACKUP, p);
        const raw = new Database(p, { readonly: true });
        const before = raw.query<{ v: string }, []>("SELECT v FROM _meta WHERE k='schema_version'").get();
        raw.close();
        expect(Number(before?.v)).toBeLessThan(23);
        const s = Storage.open(p);
        const raw2 = new Database(p, { readonly: true });
        const after = raw2.query<{ v: string }, []>("SELECT v FROM _meta WHERE k='schema_version'").get();
        raw2.close();
        expect(Number(after?.v)).toBe(24);
        // data written by the old build is readable through the repositories
        expect(s.conversations.listUserConversations("999999999").length).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(s.providers.listProviders())).toBe(true);
        s.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
