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
import {
  buildDigest,
  buildDigestData,
  DIGEST_CITY_PREF_KEY,
  DIGEST_INTERESTS_PREF_KEY,
  formatDigest,
  MAX_DIGEST_CHARS,
  renderDigestText,
} from "../src/digest/builder";
import type { WeatherFetchFn } from "../src/tools/weather";
import type { DigestDeps, DigestHeadline, SearchHeadlinesFn } from "../src/digest/builder";
import { BUILD_DIGEST_PERMISSION, createDigestTool } from "../src/tools/digest_tool";
import { ToolError } from "../src/tools/errors";
import type { ToolContext } from "../src/tools/types";

const OWNER = "12345";
const STRANGER = "99999";

/** 2026-10-18T04:30:00Z == 08:00 Asia/Tehran (a Sunday). */
const NOW_MS = Date.parse("2026-10-18T04:30:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
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

  test("English date renders with Latin digits", async () => {
    const d = deps();
    const text = formatDigest(await buildDigest(d));
    expect(text).toContain("October");
    expect(text).toContain("2026");
    expect(text).toContain("Good morning");
    // Latin digits in the date line.
    const dateLine = text.split("\n").find((l) => l.includes("Today")) ?? "";
    expect(/[0-9]/.test(dateLine)).toBe(true);
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

// ---------------------------------------------------------------------------
// Weather line through the TOOL path (same gate as /digest: digest.city)
// ---------------------------------------------------------------------------

/** Fake Open-Meteo fetch, in the real response shapes (Tehran fixture). */
function fakeWeatherFetch(counter?: { calls: number }): WeatherFetchFn {
  return async (url: string) => {
    if (counter !== undefined) counter.calls += 1;
    if (url.startsWith("https://geocoding-api.open-meteo.com/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              name: "Tehran",
              latitude: 35.689198,
              longitude: 51.388973,
              country: "Iran",
              admin1: "Tehran",
            },
          ],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        latitude: 35.689205,
        longitude: 51.388977,
        timezone: "Asia/Tehran",
        current: {
          temperature_2m: 18.2,
          relative_humidity_2m: 41,
          apparent_temperature: 17.5,
          weather_code: 0,
          wind_speed_10m: 9.4,
        },
        daily: {
          time: ["2026-10-18"],
          weather_code: [0],
          temperature_2m_max: [21.3],
          temperature_2m_min: [12.1],
          precipitation_probability_max: [0],
        },
      }),
    };
  };
}

describe("createDigestTool weather line", () => {
  function weatherTool(weatherFetchFn: WeatherFetchFn) {
    const d = deps({ searchHeadlines: fakeSearch() });
    seedFull(d);
    return {
      d,
      tool: createDigestTool({
        storage: d.storage,
        proposalStore: d.proposalStore,
        isOwner: (id) => id === OWNER,
        now: () => NOW_MS,
        searchHeadlines: fakeSearch(),
        weatherFetchFn,
      }),
    };
  }

  test("digest.city set → the tool's digest carries the weather line", async () => {
    const { d, tool } = weatherTool(fakeWeatherFetch());
    d.storage.setUserPref(OWNER, DIGEST_CITY_PREF_KEY, "Tehran");
    const out = await tool.run({}, ctx(OWNER));
    expect(out.text).toContain("Tehran: 18°C, clear — today 12–21°C");
  });

  test("digest.city unset → no weather line and no weather fetch at all", async () => {
    const counter = { calls: 0 };
    const { tool } = weatherTool(fakeWeatherFetch(counter));
    const out = await tool.run({}, ctx(OWNER));
    expect(out.text).not.toContain("18°C");
    expect(counter.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase-8: topic / date-range parameters
// ---------------------------------------------------------------------------

/** Fake search that records every (query, limit) it was asked for. */
function recordingSearch(seen: Array<{ q: string; limit: number }>): SearchHeadlinesFn {
  return async (q, limit) => {
    seen.push({ q, limit });
    return [{ title: `hit for ${q}`, url: "https://example.com/x", snippet: "" }];
  };
}

describe("buildDigestData Phase-8 window (builder)", () => {
  test("default call keeps the exact legacy date section shape", async () => {
    const sections = await buildDigestData(deps());
    expect(sections[0]).toEqual({ kind: "date", nowMs: NOW_MS });
  });

  test("topic override reaches searchHeadlines as one topic query, beating saved interests", async () => {
    const seen: Array<{ q: string; limit: number }> = [];
    const d = deps({ searchHeadlines: recordingSearch(seen), topic: "AI chips" });
    d.storage.setUserPref(OWNER, DIGEST_INTERESTS_PREF_KEY, JSON.stringify(["meme page"]));
    await buildDigestData(d);
    expect(seen).toEqual([{ q: "AI chips news", limit: 3 }]);
  });

  test("anchored 2 days ahead includes that day's task and excludes today's", async () => {
    const d = deps({ anchorMs: NOW_MS + 2 * DAY_MS, rangeDays: 1 });
    d.storage.createTask({
      name: "today task",
      cronExpr: "0 10 * * *",
      timezone: "Asia/Tehran",
      actionJson: "{}",
      createdByUserId: OWNER,
      nextRunAtMs: TEN_AM_TEHRAN,
    });
    d.storage.createTask({
      name: "future task",
      cronExpr: "0 10 * * *",
      timezone: "Asia/Tehran",
      actionJson: "{}",
      createdByUserId: OWNER,
      nextRunAtMs: NOW_MS + 2 * DAY_MS + 2 * 3_600_000,
    });
    const sections = await buildDigestData(d);
    const tasks = sections.find((s) => s.kind === "tasks");
    if (tasks?.kind !== "tasks") throw new Error("expected a tasks section");
    expect(tasks.items.map((i) => i.name)).toEqual(["future task"]);
    const text = renderDigestText(sections, "en");
    expect(text).toContain("October 20");
    expect(text).toContain("future task");
    expect(text).not.toContain("today task");
  });

  test("days=3 range includes a reminder due on day 3; the default digest excludes it", async () => {
    const d = deps();
    d.storage.createReminder({
      userId: OWNER,
      chatId: "1",
      text: "day three reminder",
      dueAt: NOW_MS + 2 * DAY_MS + 3_600_000,
      repeat: "none",
    });
    const plain = await buildDigestData(d);
    expect(plain.some((s) => s.kind === "reminders")).toBe(false);

    const ranged = await buildDigestData({ ...d, rangeDays: 3 });
    const reminders = ranged.find((s) => s.kind === "reminders");
    if (reminders?.kind !== "reminders") throw new Error("expected a reminders section");
    expect(reminders.items.map((i) => i.text)).toEqual(["day three reminder"]);
    // The header must not claim a 3-day digest is one day.
    expect(renderDigestText(ranged, "en")).toContain("Covering 3 days");
  });

  test("explicit range bounds events to the window; default keeps the 7-day horizon", async () => {
    const d = deps();
    d.storage.upsertMemory({
      userId: OWNER,
      key: "event:birthday:plus3",
      content: JSON.stringify({
        v: 1,
        name: "Plus Three",
        kind: "birthday",
        jMonth: 7,
        jDay: 29, // Mehr 29 == 3 days after Mehr 26 (NOW)
        labelFa: "۲۹ مهر",
      }),
    });
    const plain = await buildDigestData(d);
    expect(plain.some((s) => s.kind === "events")).toBe(true);
    const ranged = await buildDigestData({ ...d, rangeDays: 1 });
    expect(ranged.some((s) => s.kind === "events")).toBe(false);
  });

  test("ranged usage counts from the range start, not the rolling 24h", async () => {
    const d = deps();
    new UsageTracker(d.storage).record({
      userId: OWNER,
      conversationId: 1,
      providerId: 1,
      modelId: "claude-sonnet",
      usage: { inputTokens: 100, outputTokens: 50 },
      at: NOW_MS - 36 * 3_600_000, // 36h ago: outside last-24h, inside a 3-day range anchored 2 days back
    });
    const plain = await buildDigestData(d);
    expect(plain.some((s) => s.kind === "usage")).toBe(false);

    const ranged = await buildDigestData({ ...d, anchorMs: NOW_MS - 2 * DAY_MS, rangeDays: 3 });
    const usage = ranged.find((s) => s.kind === "usage");
    if (usage?.kind !== "usage") throw new Error("expected a usage section");
    expect(usage.runs).toBe(1);
  });
});

describe("createDigestTool Phase-8 params", () => {
  function makeTool(seen?: Array<{ q: string; limit: number }>) {
    const d = deps(seen !== undefined ? { searchHeadlines: recordingSearch(seen) } : {});
    const tool = createDigestTool({
      storage: d.storage,
      proposalStore: d.proposalStore,
      isOwner: (id) => id === OWNER,
      now: () => NOW_MS,
      ...(d.searchHeadlines !== undefined ? { searchHeadlines: d.searchHeadlines } : {}),
    });
    return { tool, d };
  }

  test("no params: output is exactly { text }, as before", async () => {
    const { tool } = makeTool();
    const out = await tool.run({}, ctx(OWNER));
    expect(Object.keys(out)).toEqual(["text"]);
  });

  test("topic is echoed trimmed and drives the headline query", async () => {
    const seen: Array<{ q: string; limit: number }> = [];
    const { tool } = makeTool(seen);
    const out = await tool.run({ topic: "  space exploration " }, ctx(OWNER));
    expect(out.topic).toBe("space exploration");
    expect(out.date).toBeUndefined();
    expect(out.days).toBeUndefined();
    expect(seen).toEqual([{ q: "space exploration news", limit: 3 }]);
  });

  test("empty topic counts as absent: no echo, generic headlines", async () => {
    const seen: Array<{ q: string; limit: number }> = [];
    const { tool } = makeTool(seen);
    const out = await tool.run({ topic: "   " }, ctx(OWNER));
    expect(out.topic).toBeUndefined();
    expect(seen).toEqual([{ q: "today's top headlines", limit: 3 }]);
  });

  test("date + days are echoed; the header reflects the anchor and the range", async () => {
    const { tool } = makeTool();
    const out = await tool.run({ date: "2026-10-20", days: 3 }, ctx(OWNER));
    expect(out.date).toBe("2026-10-20");
    expect(out.days).toBe(3);
    expect(out.text).toContain("October 20");
    expect(out.text).toContain("Covering 3 days");
  });

  test("date alone echoes days=1, the effective range", async () => {
    const { tool } = makeTool();
    const out = await tool.run({ date: "2026-10-20" }, ctx(OWNER));
    expect(out.date).toBe("2026-10-20");
    expect(out.days).toBe(1);
    expect(out.text).toContain("October 20");
  });

  test("a full ISO instant is accepted as the anchor", async () => {
    const { tool } = makeTool();
    const out = await tool.run({ date: "2026-10-20T06:30:00Z" }, ctx(OWNER));
    expect(out.date).toBe("2026-10-20T06:30:00Z");
    expect(out.days).toBe(1);
    expect(out.text).toContain("October 20");
  });

  test("days alone echoes days and starts the range today", async () => {
    const { tool, d } = makeTool();
    d.storage.createReminder({
      userId: OWNER,
      chatId: "1",
      text: "day three reminder",
      dueAt: NOW_MS + 2 * DAY_MS + 3_600_000,
      repeat: "none",
    });
    const ranged = await tool.run({ days: 3 }, ctx(OWNER));
    expect(ranged.days).toBe(3);
    expect(ranged.date).toBeUndefined();
    expect(ranged.text).toContain("day three reminder");
    const plain = await tool.run({}, ctx(OWNER));
    expect(plain.text).not.toContain("day three reminder");
  });

  test("invalid dates are rejected as invalid_input naming the expected format", async () => {
    const { tool } = makeTool();
    for (const bad of [
      "not-a-date",
      "2026-02-30", // Date.parse would silently roll this to March 2
      "2026-13-01",
      "20/10/2026",
      "2026-10-20T25:00:00Z",
      "",
    ]) {
      const err = await tool.run({ date: bad }, ctx(OWNER)).catch((e) => e);
      expect(err, bad).toBeInstanceOf(ToolError);
      expect((err as ToolError).kind, bad).toBe("invalid_input");
      expect((err as ToolError).message, bad).toContain("YYYY-MM-DD");
    }
  });

  test("out-of-range days are rejected as invalid_input", async () => {
    const { tool } = makeTool();
    for (const bad of [0, 8, 1.5, -1]) {
      const err = await tool.run({ days: bad }, ctx(OWNER)).catch((e) => e);
      expect(err, String(bad)).toBeInstanceOf(ToolError);
      expect((err as ToolError).kind, String(bad)).toBe("invalid_input");
    }
  });

  test("an over-long topic is rejected as invalid_input", async () => {
    const { tool } = makeTool();
    const err = await tool.run({ topic: "x".repeat(81) }, ctx(OWNER)).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe("invalid_input");
  });

  test("non-owner with params is still refused as not_allowed", async () => {
    const { tool } = makeTool();
    const err = await tool.run({ topic: "space", days: 3 }, ctx(STRANGER)).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe("not_allowed");
  });
});
