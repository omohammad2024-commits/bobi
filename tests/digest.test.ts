/**
 * Morning digest (Stage-3 differentiator).
 *
 * Pins the contract: the builder composes all sections from real sources,
 * one failing source is skipped (never fails the digest), the formatted
 * text respects the char cap, the tool is owner-only, the Persian date
 * renders with fa-IR digits, and an empty day still yields a valid digest.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Storage } from "../src/storage/storage";
import { ProposalStore } from "../src/curator/proposals";
import { UsageTracker } from "../src/ai/usage";
import { buildDigest, formatDigest, MAX_DIGEST_CHARS } from "../src/digest/builder";
import type { DigestDeps, DigestHeadline } from "../src/digest/builder";
import { BUILD_DIGEST_PERMISSION, createDigestTool } from "../src/tools/digest_tool";
import { ToolError } from "../src/tools/errors";
import type { ToolContext } from "../src/tools/types";

const OWNER = "12345";
const STRANGER = "99999";

/** 2026-10-18T04:30:00Z == 08:00 Asia/Tehran (a Sunday). */
const NOW_MS = Date.parse("2026-10-18T04:30:00Z");
const TEN_AM_TEHRAN = Date.parse("2026-10-18T06:30:00Z");
const NINE_AM_TEHRAN = Date.parse("2026-10-18T05:30:00Z");

function ctx(userId: string): ToolContext {
  return {
    clock: () => new Date(NOW_MS),
    actor: { userId, permissions: [BUILD_DIGEST_PERMISSION] },
    signal: new AbortController().signal,
  };
}

function deps(over: Partial<DigestDeps> = {}): DigestDeps & { proposalStore: ProposalStore } {
  const storage = Storage.open(":memory:");
  const proposalStore = new ProposalStore(new Database(":memory:"));
  const base: DigestDeps = {
    storage,
    proposalStore,
    userId: OWNER,
    now: () => NOW_MS,
    ...over,
  };
  return { ...base, proposalStore };
}

/** Seed one task, one reminder, two proposals, three memories, one usage run. */
function seedFull(d: DigestDeps & { proposalStore: ProposalStore }): void {
  d.storage.createTask({
    name: "جلسهٔ تیم",
    cronExpr: "0 10 * * *",
    timezone: "Asia/Tehran",
    actionJson: JSON.stringify({ type: "message", chatId: "1", text: "x" }),
    createdByUserId: OWNER,
    nextRunAtMs: TEN_AM_TEHRAN,
  });
  d.storage.createReminder({
    userId: OWNER,
    chatId: "1",
    text: "دارو بخور",
    dueAt: NINE_AM_TEHRAN,
    repeat: "none",
  });
  d.proposalStore.saveProposals(OWNER, [
    {
      id: "p1",
      kind: "duplicate",
      memoryIds: ["a"],
      summaryFa: "دو خاطره تکراری",
      suggestedAction: { type: "delete", keys: ["a"] },
    },
    {
      id: "p2",
      kind: "stale",
      memoryIds: ["b"],
      summaryFa: "خاطره قدیمی",
      suggestedAction: { type: "delete", keys: ["b"] },
    },
  ]);
  d.storage.upsertMemory({ userId: OWNER, key: "k1", content: "محمد عاشق قهوه است" });
  d.storage.upsertMemory({ userId: OWNER, key: "k2", content: "قرار جمعه با ژئو" });
  d.storage.upsertMemory({ userId: OWNER, key: "k3", content: "ایدهٔ میم جدید برای لش‌میم" });
  new UsageTracker(d.storage).record({
    userId: OWNER,
    conversationId: 1,
    providerId: 1,
    modelId: "claude-sonnet",
    usage: { inputTokens: 1000, outputTokens: 500 },
    at: NOW_MS - 3_600_000,
  });
}

function fakeSearch(): (q: string, limit: number, signal: AbortSignal) => Promise<readonly DigestHeadline[]> {
  return async () => [
    { title: "خبر اول امروز", url: "https://example.com/a?token=secret", snippet: "s1" },
    { title: "خبر دوم امروز", url: "https://news.example.ir/b", snippet: "s2" },
    { title: "خبر سوم امروز", url: "not-a-url", snippet: "s3" },
  ];
}

describe("buildDigest", () => {
  test("composes all sections from real sources", async () => {
    const d = deps({ searchHeadlines: fakeSearch() });
    seedFull(d);
    const text = formatDigest(await buildDigest(d));

    expect(text).toContain("Good morning!");
    expect(text).toContain("Today's tasks");
    expect(text).toContain("جلسهٔ تیم");
    expect(text).toContain("Reminders");
    expect(text).toContain("دارو بخور");
    expect(text).toContain("Memory proposals");
    expect(text).toContain("proposals");
    expect(text).toContain("Last 24h usage");
    expect(text).toContain("Headlines");
    expect(text).toContain("خبر اول امروز");
    // Headline URLs are reduced to hostnames: query-string secrets never leak.
    expect(text).toContain("example.com");
    expect(text).not.toContain("token=secret");
    expect(text).toContain("From your memory");
    expect(text).toContain("عاشق قهوه");
    expect(text).toContain("Have a great day");
  });

  test("one failing source is skipped, never kills the digest", async () => {
    const logs: string[] = [];
    const d = deps({
      log: (m) => logs.push(m),
      searchHeadlines: async () => {
        throw new Error("provider down");
      },
    });
    seedFull(d);
    const sections = await buildDigest(d);
    const text = formatDigest(sections);

    expect(text).not.toContain("Headlines");
    expect(text).toContain("Today's tasks");
    expect(text).toContain("Reminders");
    expect(text).toContain("From your memory");
    expect(logs.some((m) => m.includes("headlines"))).toBe(true);
  });

  test("missing search resolver skips headlines silently", async () => {
    const d = deps();
    seedFull(d);
    const text = formatDigest(await buildDigest(d));
    expect(text).not.toContain("Headlines");
    expect(text).toContain("Today's tasks");
  });

  test("enforces the char cap on a pathological digest", async () => {
    const d = deps();
    d.storage.upsertMemory({ userId: OWNER, key: "long", content: "x".repeat(20_000) });
    for (let i = 0; i < 30; i++) {
      d.storage.createTask({
        name: "کار " + "بسیار طولانی ".repeat(40),
        cronExpr: "0 10 * * *",
        timezone: "Asia/Tehran",
        actionJson: "{}",
        createdByUserId: OWNER,
        nextRunAtMs: TEN_AM_TEHRAN + i * 1000,
      });
    }
    const text = formatDigest(await buildDigest(d));
    expect(text.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);
    // The date header always survives the cap.
    expect(text).toContain("☀️");
  });

  test("Persian date renders with fa-IR digits", async () => {
    const d = deps();
    const text = formatDigest(await buildDigest(d));
    expect(text).toContain("مهر");
    expect(text).toContain("۱۴۰۵");
    expect(text).toContain("Good morning");
    // No Latin digits in the date line.
    const dateLine = text.split("\n").find((l) => l.includes("امروز")) ?? "";
    expect(/[0-9]/.test(dateLine)).toBe(false);
  });

  test("an empty day still produces a valid digest", async () => {
    const d = deps();
    const text = formatDigest(await buildDigest(d));
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("Good morning");
    expect(text).toContain("Today's tasks");
    expect(text).toContain("enjoy the calm");
    expect(text.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);
  });

  test("a failing proposal store is skipped", async () => {
    const logs: string[] = [];
    const d = deps({ log: (m) => logs.push(m) });
    const broken = new ProposalStore(new Database(":memory:"));
    (broken as unknown as { countPending: () => number }).countPending = () => {
      throw new Error("db locked");
    };
    const sections = await buildDigest({ ...d, proposalStore: broken });
    const text = formatDigest(sections);
    expect(text).not.toContain("Memory proposals");
    expect(text).toContain("Today's tasks");
    expect(logs.some((m) => m.includes("proposals"))).toBe(true);
  });
});

describe("createDigestTool", () => {
  function toolDeps(userId = OWNER) {
    const d = deps({ searchHeadlines: fakeSearch() });
    seedFull(d);
    const { searchHeadlines } = d;
    return createDigestTool({
      storage: d.storage,
      proposalStore: d.proposalStore,
      isOwner: (id) => id === userId,
      now: () => NOW_MS,
      ...(searchHeadlines !== undefined ? { searchHeadlines } : {}),
    });
  }

  test("is owner-only and declares its permission", () => {
    const tool = toolDeps();
    expect(tool.ownerOnly).toBe(true);
    expect(tool.name).toBe("build_digest");
    expect(tool.permission.requires).toEqual([BUILD_DIGEST_PERMISSION]);
    expect(tool.enabled).toBe(true);
  });

  test("owner gets the formatted digest", async () => {
    const tool = toolDeps();
    const out = await tool.run({}, ctx(OWNER));
    expect(out.text).toContain("Good morning");
    expect(out.text).toContain("جلسهٔ تیم");
    expect(out.text.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);
  });

  test("non-owner is refused", async () => {
    const tool = toolDeps();
    const err = await tool.run({}, ctx(STRANGER)).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe("not_allowed");
  });

  test("unknown identity is refused", async () => {
    const tool = toolDeps();
    const err = await tool
      .run({}, { ...ctx(""), actor: { userId: "", permissions: [] } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe("not_allowed");
  });
});
