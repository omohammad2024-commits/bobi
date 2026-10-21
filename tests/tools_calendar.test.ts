/**
 * read_calendar — the unified day-by-day agenda tool.
 *
 * Pins: items from all three per-actor sources (reminders, scheduled
 * tasks, noted life events) land on the right Tehran calendar days with
 * the right Jalali labels; the range is [from, to) — an item exactly at
 * `to` is excluded; an empty range is an empty agenda, not an error;
 * nonsense ranges are rejected; and another user's rows never leak in.
 *
 * Seeding goes through the real write paths: the scheduling repo for
 * reminders/tasks and EventStore (over the SQLite memory provider) for
 * events — the same paths the write tools use.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { createCalendarTool, READ_CALENDAR_PERMISSION } from "../src/tools/calendar";
import type { ReadCalendarOutput } from "../src/tools/calendar";
import { ToolError } from "../src/tools/errors";
import type { ToolContext } from "../src/tools/types";
import { EventStore } from "../src/memory/events";
import { SqliteMemoryProvider } from "../src/memory/sqlite_provider";

/**
 * Fixed clock: 2026-10-21T08:00:00Z == 11:30 Asia/Tehran, Wednesday
 * 29 Mehr 1405. Default range = Oct 21..27 Tehran days.
 */
const NOW = new Date("2026-10-21T08:00:00Z");

function ctx(userId = "u1"): ToolContext {
  return {
    clock: () => NOW,
    actor: { userId, permissions: [READ_CALENDAR_PERMISSION] },
    signal: new AbortController().signal,
  };
}

/** Tehran instant helper: 2026-10-22 09:00 Tehran == 05:30Z (UTC+3:30). */
const tehran = (isoLocal: string) => Date.parse(`${isoLocal}+03:30`);

async function seedEvent(storage: Storage, userId: string): Promise<void> {
  const store = new EventStore(new SqliteMemoryProvider(storage));
  // Birthday on 30 Mehr — in 1405 that is 2026-10-22 (Tehran).
  await store.add(userId, {
    name: "تولد علی",
    kind: "birthday",
    jMonth: 7,
    jDay: 30,
    labelFa: "۳۰ مهر",
  });
}

async function seeded(): Promise<Storage> {
  const storage = Storage.open(":memory:");
  // Reminder: Oct 22, 09:00 Tehran.
  storage.scheduling.createReminder({
    userId: "u1",
    chatId: "chat-1",
    text: "دندان‌پزشکی",
    dueAt: tehran("2026-10-22T09:00:00"),
    repeat: "none",
  });
  // Reminder outside the default week: Oct 30 — must not appear.
  storage.scheduling.createReminder({
    userId: "u1",
    chatId: "chat-1",
    text: "خیلی دیر",
    dueAt: tehran("2026-10-30T09:00:00"),
    repeat: "none",
  });
  // Another user's reminder inside the range — must never appear.
  storage.scheduling.createReminder({
    userId: "u2",
    chatId: "chat-2",
    text: "مال من نیست",
    dueAt: tehran("2026-10-22T10:00:00"),
    repeat: "none",
  });
  // Scheduled task: next run Oct 21, 15:00 Tehran.
  storage.scheduling.createTask({
    name: "گزارش روزانه",
    cronExpr: "0 15 * * *",
    timezone: "Asia/Tehran",
    actionJson: JSON.stringify({ type: "message", chatId: "chat-1", text: "hi" }),
    createdByUserId: "u1",
    nextRunAtMs: tehran("2026-10-21T15:00:00"),
  });
  // Disabled task with a stored next run — not a real future instant.
  storage.scheduling.createTask({
    name: "تسک خاموش",
    cronExpr: "0 9 * * *",
    timezone: "Asia/Tehran",
    actionJson: JSON.stringify({ type: "message", chatId: "chat-1", text: "hi" }),
    createdByUserId: "u1",
    nextRunAtMs: tehran("2026-10-22T09:00:00"),
    enabled: false,
  });
  await seedEvent(storage, "u1");
  await seedEvent(storage, "u2");
  return storage;
}

describe("read_calendar", () => {
  test("unifies reminders, tasks and events by day with Jalali labels", async () => {
    const storage = await seeded();
    const tool = createCalendarTool({ storage });
    const out: ReadCalendarOutput = await tool.run({}, ctx());

    expect(out.totalItems).toBe(3);
    expect(out.days.map((d) => d.date)).toEqual(["2026-10-21", "2026-10-22"]);

    const d21 = out.days[0]!;
    const d22 = out.days[1]!;
    expect(d21.jalali).toBe("۲۹ مهر ۱۴۰۵");
    expect(d21.items).toHaveLength(1);
    expect(d21.items[0]).toMatchObject({ kind: "task", title: "گزارش روزانه" });
    expect(d21.items[0]!.at).toBe(new Date(tehran("2026-10-21T15:00:00")).toISOString());
    expect(d21.items[0]!.jalali).toBe("۲۹ مهر ۱۴۰۵");

    expect(d22.jalali).toBe("۳۰ مهر ۱۴۰۵");
    const kinds = d22.items.map((i) => i.kind).sort();
    expect(kinds).toEqual(["event", "reminder"]);
    const reminder = d22.items.find((i) => i.kind === "reminder")!;
    expect(reminder.title).toBe("دندان‌پزشکی");
    expect(reminder.at).toBe(new Date(tehran("2026-10-22T09:00:00")).toISOString());
    const event = d22.items.find((i) => i.kind === "event")!;
    expect(event.title).toBe("تولد علی");
    expect(event.jalali).toBe("۳۰ مهر ۱۴۰۵");
    storage.close();
  });

  test("an item exactly at `to` is excluded; one just before is included", async () => {
    const storage = Storage.open(":memory:");
    const toMs = tehran("2026-10-23T00:00:00");
    storage.scheduling.createReminder({
      userId: "u1",
      chatId: "chat-1",
      text: "دقیقاً سر مرز",
      dueAt: toMs,
      repeat: "none",
    });
    storage.scheduling.createReminder({
      userId: "u1",
      chatId: "chat-1",
      text: "یه کم قبل مرز",
      dueAt: toMs - 60_000,
      repeat: "none",
    });
    const tool = createCalendarTool({ storage });
    const out = await tool.run(
      { from: "2026-10-21", to: new Date(toMs).toISOString() },
      ctx(),
    );
    expect(out.totalItems).toBe(1);
    expect(out.days[0]!.items[0]!.title).toBe("یه کم قبل مرز");
    storage.close();
  });

  test("explicit `to` (date) overrides days", async () => {
    const storage = await seeded();
    const tool = createCalendarTool({ storage });
    // days says 31, but `to` cuts the range at Oct 22's start: only the
    // Oct 21 task remains.
    const out = await tool.run({ days: 31, to: "2026-10-22" }, ctx());
    expect(out.totalItems).toBe(1);
    expect(out.days.map((d) => d.date)).toEqual(["2026-10-21"]);
    storage.close();
  });

  test("empty range → empty days and totalItems 0", async () => {
    const storage = Storage.open(":memory:");
    const tool = createCalendarTool({ storage });
    const out = await tool.run({ days: 7 }, ctx());
    expect(out.days).toEqual([]);
    expect(out.totalItems).toBe(0);
    storage.close();
  });

  test("per-actor isolation: another user's items never appear", async () => {
    const storage = await seeded();
    const tool = createCalendarTool({ storage });
    const mine = await tool.run({}, ctx("u1"));
    const titles = mine.days.flatMap((d) => d.items.map((i) => i.title));
    expect(titles).not.toContain("مال من نیست");
    // u2's own agenda has their reminder and their copy of the event.
    const theirs = await tool.run({}, ctx("u2"));
    expect(theirs.totalItems).toBe(2);
    storage.close();
  });

  test("invalid ranges are rejected with invalid_input", async () => {
    const storage = Storage.open(":memory:");
    const tool = createCalendarTool({ storage });
    const bad: Array<Parameters<typeof tool.run>[0]> = [
      { days: 0 },
      { days: 32 },
      { days: 2.5 },
      { from: "not-a-date" },
      { from: "2026-10-25", to: "2026-10-21" }, // reversed
      { from: "2026-10-21", to: "2026-10-21" }, // empty
      { from: "2026-01-01", to: "2026-06-01" }, // > 62 days
    ];
    for (const input of bad) {
      let caught: unknown;
      try {
        await tool.run(input, ctx());
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ToolError);
      expect((caught as ToolError).kind).toBe("invalid_input");
    }
    storage.close();
  });

  test("an unidentified actor is refused", async () => {
    const storage = Storage.open(":memory:");
    const tool = createCalendarTool({ storage });
    let caught: unknown;
    try {
      await tool.run({}, ctx("unknown"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect((caught as ToolError).kind).toBe("not_allowed");
    storage.close();
  });
});
