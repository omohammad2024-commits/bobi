/**
 * Personalized morning digest (Worker D: smarter morning digest).
 *
 * Pins the contract: the "what matters to you" focus section ranks overdue
 * items, today's events, soon-starting tasks/reminders, and interest
 * matches above everything else; owner interest topics (read-only from
 * user_prefs) steer headline search queries and surface matching items;
 * the global item budget trims the lowest-priority sections first; a calm
 * day keeps its friendly empty state; and focus rows get tap-to-act
 * buttons in the interactive digest.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Storage } from "../src/storage/storage";
import { ProposalStore } from "../src/curator/proposals";
import {
  applyItemBudget,
  buildDigestData,
  DIGEST_INTERESTS_PREF_KEY,
  MAX_DIGEST_ITEMS,
  renderDigestText,
  type DigestDeps,
  type DigestFocusItem,
  type DigestHeadline,
  type DigestSectionData,
} from "../src/digest/builder";
import { renderInteractiveDigest } from "../src/digest/interactive";
import { InlineKeyboard } from "grammy";

const OWNER = "12345";

/** 2026-10-18T04:30:00Z == 08:00 Asia/Tehran (a Sunday; Mehr 26, 1405). */
const NOW_MS = Date.parse("2026-10-18T04:30:00Z");
const TWO_HOURS_LATER = NOW_MS + 2 * 3_600_000; // 10:00 Tehran — within "soon"
const TEN_HOURS_LATER = NOW_MS + 10 * 3_600_000; // 18:00 Tehran — later today
const ONE_HOUR_AGO = NOW_MS - 3_600_000;

function deps(over: Partial<DigestDeps> = {}): DigestDeps {
  return {
    storage: Storage.open(":memory:"),
    proposalStore: new ProposalStore(new Database(":memory:")),
    userId: OWNER,
    now: () => NOW_MS,
    ...over,
  };
}

function seedTask(d: DigestDeps, name: string, nextRunAtMs: number): number {
  return d.storage.createTask({
    name,
    cronExpr: "0 * * * *",
    timezone: "Asia/Tehran",
    actionJson: JSON.stringify({ type: "message", chatId: "1", text: "x" }),
    createdByUserId: OWNER,
    nextRunAtMs,
  });
}

function seedReminder(d: DigestDeps, text: string, dueAt: number): number {
  return d.storage.createReminder({
    userId: OWNER,
    chatId: "1",
    text,
    dueAt,
    repeat: "none",
  });
}

function seedEventToday(d: DigestDeps, name: string): void {
  d.storage.upsertMemory({
    userId: OWNER,
    key: "event:birthday:today",
    content: JSON.stringify({
      v: 1,
      name,
      kind: "birthday",
      jMonth: 7,
      jDay: 26,
      labelFa: "۲۶ مهر",
    }),
  });
}

/** Fake search that records the queries it was asked. */
function recordingSearch(
  seen: string[],
): (q: string, limit: number, signal: AbortSignal) => Promise<readonly DigestHeadline[]> {
  return async (q, limit) => {
    seen.push(q);
    return [{ title: `hit for ${q}`, url: "https://example.com/x", snippet: "" }].slice(0, limit);
  };
}

function focusOf(sections: DigestSectionData[]): Extract<DigestSectionData, { kind: "focus" }> {
  const s = sections.find((x) => x.kind === "focus");
  if (s?.kind !== "focus") throw new Error("expected a focus section");
  return s;
}

function itemCount(sections: readonly DigestSectionData[]): number {
  return sections.reduce((n, s) => n + ("items" in s ? s.items.length : 0), 0);
}

function mkFocus(text: string): DigestFocusItem {
  return { itemKind: "memory", text, reason: { type: "today" } };
}

describe("personalized focus section", () => {
  test("ranks overdue, today, and soon items right after the date header", async () => {
    const d = deps();
    const overdueId = seedReminder(d, "pay the bill", ONE_HOUR_AGO);
    const soonTaskId = seedTask(d, "team standup", TWO_HOURS_LATER);
    seedTask(d, "evening review", TEN_HOURS_LATER);
    seedEventToday(d, "Geo's birthday");

    const sections = await buildDigestData(d);
    expect(sections[0]?.kind).toBe("date");
    expect(sections[1]?.kind).toBe("focus");
    const focus = focusOf(sections);

    // Overdue first, then today's event, then the soon task.
    expect(focus.items[0]?.reason).toEqual({ type: "overdue" });
    expect(focus.items[0]?.refId).toBe(overdueId);
    expect(focus.items[1]?.reason).toEqual({ type: "today" });
    const soonItem = focus.items.find((i) => i.itemKind === "task" && i.refId === soonTaskId);
    expect(soonItem?.reason.type).toBe("soon");

    const text = renderDigestText(sections, "en");
    expect(text).toContain("🎯 What matters to you");
    expect(text).toContain("overdue");
    expect(text).toContain("pay the bill");
  });

  test("a calm day keeps its friendly empty state — no focus section", async () => {
    const sections = await buildDigestData(deps());
    expect(sections.some((s) => s.kind === "focus")).toBe(false);
    const text = renderDigestText(sections, "en");
    expect(text).toContain("enjoy the calm");
  });

  test("focus never exceeds its cap", async () => {
    const d = deps();
    for (let i = 0; i < 6; i++) seedReminder(d, `overdue ${i}`, ONE_HOUR_AGO - i * 1000);
    const focus = focusOf(await buildDigestData(d));
    expect(focus.items.length).toBeLessThanOrEqual(5);
  });
});

describe("interest topics (read-only user_prefs)", () => {
  test("topics steer headline search and surface matching items in focus", async () => {
    const seen: string[] = [];
    const d = deps({ searchHeadlines: recordingSearch(seen) });
    d.storage.setUserPref(OWNER, DIGEST_INTERESTS_PREF_KEY, JSON.stringify(["meme page"]));
    d.storage.upsertMemory({ userId: OWNER, key: "k1", content: "new idea for the meme page" });
    seedTask(d, "water the plants", TEN_HOURS_LATER);

    const sections = await buildDigestData(d);
    // Headlines were searched with the interest topic, not the generic query.
    expect(seen).toEqual(["meme page news"]);
    const headlines = sections.find((s) => s.kind === "headlines");
    expect(headlines?.kind).toBe("headlines");

    // The matching memory surfaced in focus with the interest reason.
    const focus = focusOf(sections);
    const match = focus.items.find((i) => i.reason.type === "interest");
    expect(match?.reason).toEqual({ type: "interest", topic: "meme page" });
    const text = renderDigestText(sections, "en");
    expect(text).toContain('📌 about "meme page"');
  });

  test("malformed interests pref degrades to generic behavior", async () => {
    const seen: string[] = [];
    const d = deps({ searchHeadlines: recordingSearch(seen) });
    d.storage.setUserPref(OWNER, DIGEST_INTERESTS_PREF_KEY, "not-json{{{");
    seedTask(d, "team standup", TWO_HOURS_LATER);

    const sections = await buildDigestData(d);
    expect(seen).toEqual(["today's top headlines"]);
    const focus = focusOf(sections);
    expect(focus.items.every((i) => i.reason.type !== "interest")).toBe(true);
  });

  test("without topics, headlines stay generic", async () => {
    const seen: string[] = [];
    const d = deps({ searchHeadlines: recordingSearch(seen) });
    await buildDigestData(d);
    expect(seen).toEqual(["today's top headlines"]);
  });
});

describe("priority item budget", () => {
  test("trims the lowest-priority item lists first, never the focus", () => {
    const sections: DigestSectionData[] = [
      { kind: "date", nowMs: NOW_MS },
      { kind: "focus", items: [mkFocus("a"), mkFocus("b"), mkFocus("c")] },
      {
        kind: "tasks",
        items: [1, 2, 3, 4, 5].map((id) => ({ id, name: `t${id}`, runAtMs: NOW_MS })),
      },
      {
        kind: "headlines",
        items: [1, 2, 3].map((n) => ({ title: `h${n}` })),
      },
      {
        kind: "memories",
        items: [1, 2].map((n) => ({ key: `k${n}`, content: `m${n}` })),
      },
    ];
    // 3 + 5 + 3 + 2 = 13 items; budget 12 trims exactly one headline.
    const trimmed = applyItemBudget(sections, 12);
    expect(itemCount(trimmed)).toBe(12);
    expect(focusOf(trimmed).items).toHaveLength(3);
    const headlines = trimmed.find((s) => s.kind === "headlines");
    expect(headlines?.kind).toBe("headlines");
    if (headlines?.kind === "headlines") expect(headlines.items).toHaveLength(2);
  });

  test("emptied low-priority sections are dropped; tasks keeps its floor", () => {
    const sections: DigestSectionData[] = [
      { kind: "date", nowMs: NOW_MS },
      {
        kind: "tasks",
        items: [1, 2, 3].map((id) => ({ id, name: `t${id}`, runAtMs: NOW_MS })),
      },
      { kind: "headlines", items: [{ title: "h1" }] },
    ];
    const trimmed = applyItemBudget(sections, 1);
    expect(trimmed.some((s) => s.kind === "headlines")).toBe(false);
    const tasks = trimmed.find((s) => s.kind === "tasks");
    expect(tasks?.kind).toBe("tasks");
    if (tasks?.kind === "tasks") expect(tasks.items).toHaveLength(1);
  });

  test("a packed day stays within the global item budget end to end", async () => {
    const seen: string[] = [];
    const d = deps({ searchHeadlines: recordingSearch(seen) });
    for (let i = 0; i < 5; i++) seedTask(d, `task ${i}`, TWO_HOURS_LATER + i * 1000);
    for (let i = 0; i < 4; i++) seedReminder(d, `reminder ${i}`, TWO_HOURS_LATER + i * 1000);
    for (let i = 0; i < 3; i++) {
      d.storage.upsertMemory({ userId: OWNER, key: `k${i}`, content: `memory ${i}` });
    }
    const sections = await buildDigestData(d);
    expect(itemCount(sections)).toBeLessThanOrEqual(MAX_DIGEST_ITEMS);
    // The personalized top survives the trim.
    expect(sections.some((s) => s.kind === "focus")).toBe(true);
  });
});

describe("interactive digest focus buttons", () => {
  function callbackDatas(kb: InlineKeyboard): string[] {
    return kb.inline_keyboard.flatMap((row) =>
      row.map((b) => (b as { callback_data?: string }).callback_data ?? ""),
    );
  }

  test("focus rows get the same tap-to-act buttons as the detail sections", async () => {
    const d = deps();
    const taskId = seedTask(d, "team standup", TWO_HOURS_LATER);
    const remId = seedReminder(d, "pay the bill", ONE_HOUR_AGO);
    const sections = await buildDigestData(d);
    expect(focusOf(sections).items.length).toBeGreaterThan(0);

    const datas = callbackDatas(renderInteractiveDigest(sections, { locale: "en" }).keyboard);
    expect(datas).toContain(`dgst:task:run:${taskId}`);
    expect(datas).toContain(`dgst:task:del:${taskId}`);
    expect(datas).toContain(`dgst:rem:done:${remId}`);
    expect(datas).toContain("dgst:refresh");
  });

  test("delete confirm swaps a focus task row's buttons too", async () => {
    const d = deps();
    const taskId = seedTask(d, "team standup", TWO_HOURS_LATER);
    const sections = await buildDigestData(d);
    const datas = callbackDatas(
      renderInteractiveDigest(sections, { locale: "en", confirm: { kind: "task", id: taskId } })
        .keyboard,
    );
    expect(datas).toContain(`dgst:task:delc:${taskId}`);
    expect(datas).toContain(`dgst:task:delx:${taskId}`);
  });
});
