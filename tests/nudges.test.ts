/**
 * Follow-up machinery that survived the Phase-8 silo merge.
 *
 * The follow-up STORE and TOOLS are gone from here: nudges merged into
 * the unified reminder store (followup=1 rows) and the remind_at tool
 * family — that coverage lives in tests/phase8_reminder_merge.test.ts,
 * tests/tool_reminders.test.ts and tests/reminders_nl.test.ts.
 *
 * What remains in src/nudges/ — and is pinned here:
 * - time_fa.ts: the deterministic Persian time parser. Safety property:
 *   scheduling never trusts the model's date math.
 * - extract.ts: the auto-capture extractor (bot/bot.ts). It only fires
 *   on explicit Persian follow-up phrasings; memory statements
 *   («یادم هست»), questions about the past («یادته؟») and «فراموش کردم»
 *   never produce a candidate, and proposed text is capped at 500 chars.
 * - sweep.ts: the slimmed sweep — dated-event reminders only; follow-ups
 *   are delivered by the ReminderScheduler now. Each delivery carries
 *   its owner's userId and no one else's.
 */
import { describe, expect, test } from "bun:test";
import { parsePersianWhen, parseDueInstant } from "../src/nudges/time_fa";
import { extractFollowup, MAX_FOLLOWUP_TEXT_LENGTH } from "../src/nudges/extract";
import { sweepEventReminders } from "../src/nudges/sweep";
import { EventStore } from "../src/memory/events";
import type { MemoryProvider, StoredMemory } from "../src/memory/provider";

const TZ = "Asia/Tehran";
// Saturday 2026-10-17 15:30 in Tehran.
const NOW = new Date("2026-10-17T12:00:00Z").getTime();
const DAY = 24 * 60 * 60 * 1000;

/** Epoch for a Tehran wall-clock time: 2026-10-DD HH:MM +03:30. */
function tehran(day: number, hour: number, minute = 0): number {
  return Date.UTC(2026, 9, day, hour - 3, minute - 30);
}

// ---------- Persian time parser ----------

describe("parsePersianWhen", () => {
  test("فردا ساعت ۹ → tomorrow 09:00 Tehran", () => {
    expect(parsePersianWhen("فردا ساعت ۹", NOW, TZ)).toBe(tehran(18, 9));
  });

  test("ASCII digits work too", () => {
    expect(parsePersianWhen("فردا ساعت 9", NOW, TZ)).toBe(tehran(18, 9));
  });

  test("پس‌فردا → two days out, default 09:00", () => {
    expect(parsePersianWhen("پس‌فردا پیگیری کن", NOW, TZ)).toBe(tehran(19, 9));
  });

  test("هفته‌ی بعد → seven days out", () => {
    expect(parsePersianWhen("هفته‌ی بعد یادم بنداز", NOW, TZ)).toBe(tehran(24, 9));
  });

  test("امروز ساعت ۱۸ → later today", () => {
    expect(parsePersianWhen("امروز ساعت ۱۸", NOW, TZ)).toBe(tehran(17, 18));
  });

  test("a bare time already past today rolls to tomorrow", () => {
    // 15:30 now; «ساعت ۹» today is past → tomorrow 09:00.
    expect(parsePersianWhen("ساعت ۹ یادم بنداز", NOW, TZ)).toBe(tehran(18, 9));
  });

  test("a bare time still ahead today stays today", () => {
    expect(parsePersianWhen("ساعت ۱۸ یادم بنداز", NOW, TZ)).toBe(tehran(17, 18));
  });

  test("digit words: ساعت نه", () => {
    expect(parsePersianWhen("فردا ساعت نه", NOW, TZ)).toBe(tehran(18, 9));
  });

  test("عصر shifts to the afternoon", () => {
    expect(parsePersianWhen("فردا ساعت ۹ شب", NOW, TZ)).toBe(tehran(18, 21));
  });

  test("weekday name → next occurrence (Saturday now, جمعه → Oct 23)", () => {
    expect(parsePersianWhen("جمعه یادم بنداز", NOW, TZ)).toBe(tehran(23, 9));
  });

  test("relative N روز دیگه", () => {
    expect(parsePersianWhen("۳ روز دیگه یادم بنداز", NOW, TZ)).toBe(tehran(20, 9));
  });

  test("pure noise returns null", () => {
    expect(parsePersianWhen("سلام چطوری", NOW, TZ)).toBeNull();
    expect(parsePersianWhen("", NOW, TZ)).toBeNull();
    expect(parsePersianWhen("یادم هست", NOW, TZ)).toBeNull();
  });
});

describe("parseDueInstant", () => {
  test("ISO with offset is accepted", () => {
    const iso = "2026-10-20T09:30:00+03:30";
    expect(parseDueInstant(iso, NOW, TZ)).toBe(Date.parse(iso));
  });

  test("past ISO is rejected", () => {
    expect(parseDueInstant("2020-01-01T00:00:00+03:30", NOW, TZ)).toBeNull();
  });

  test("ISO without offset is rejected", () => {
    expect(parseDueInstant("2026-10-20T09:30:00", NOW, TZ)).toBeNull();
  });
});

// ---------- extractor ----------

describe("extractFollowup", () => {
  test("detects یادم بنداز with a time and cleans the trigger phrase", () => {
    const r = extractFollowup("فردا یادم بنداز قسط رو بدم", NOW, TZ);
    expect(r).not.toBeNull();
    expect(r!.dueAtMs).toBe(tehran(18, 9));
    expect(r!.text).toContain("قسط");
    expect(r!.text).not.toContain("یادم بنداز");
    expect(r!.text).not.toContain("فردا");
  });

  test("detects پیگیری کن with هفته‌ی بعد", () => {
    const r = extractFollowup("پیگیری کن هفته‌ی بعد", NOW, TZ);
    expect(r).not.toBeNull();
    expect(r!.dueAtMs).toBe(tehran(24, 9));
  });

  test("detects یادت نره", () => {
    const r = extractFollowup("یادت نره فردا ساعت ۹ به مامان زنگ بزنم", NOW, TZ);
    expect(r).not.toBeNull();
    expect(r!.dueAtMs).toBe(tehran(18, 9));
    expect(r!.text).toContain("مامان");
  });

  test("detects فراموش نکن (امروز + no hour rolls to tomorrow 09:00)", () => {
    const r = extractFollowup("فراموش نکن امروز مدارک رو ببری", NOW, TZ);
    expect(r).not.toBeNull();
    expect(r!.dueAtMs).toBe(tehran(18, 9));
  });

  test("no time given → defaults to tomorrow 09:00", () => {
    const r = extractFollowup("یادم بنداز قرص‌ها رو بخرم", NOW, TZ);
    expect(r).not.toBeNull();
    expect(r!.dueAtMs).toBe(tehran(18, 9));
  });

  test("empty topic falls back to the original message", () => {
    const r = extractFollowup("فردا یادم بنداز", NOW, TZ);
    expect(r).not.toBeNull();
    expect(r!.text.length).toBeGreaterThan(0);
  });

  test("negative: یادم هست is not a request", () => {
    expect(extractFollowup("یادم هست دیروز چی گفتی", NOW, TZ)).toBeNull();
  });

  test("negative: یادته؟ is a question about the past", () => {
    expect(extractFollowup("یادته دیروز چی گفتیم؟", NOW, TZ)).toBeNull();
  });

  test("negative: فراموش کردم is an admission, not a request", () => {
    expect(extractFollowup("فراموش کردم بهش زنگ بزنم", NOW, TZ)).toBeNull();
  });

  test("negative: plain chat never fires", () => {
    expect(extractFollowup("سلام چطوری؟ امروز هوا خوبه", NOW, TZ)).toBeNull();
    expect(extractFollowup("", NOW, TZ)).toBeNull();
  });

  test("proposed text never exceeds the store cap", () => {
    const long = "یادم بنداز " + "x".repeat(600);
    const r = extractFollowup(long, NOW, TZ);
    expect(r).not.toBeNull();
    expect(r!.text.length).toBeLessThanOrEqual(MAX_FOLLOWUP_TEXT_LENGTH);
  });
});


// ---------- event-reminder sweep (Phase 8: the sweep's only job now) ----------

/** UserId-aware in-memory provider: rows are namespaced per user. */
class FakeProvider implements MemoryProvider {
  readonly name = "fake";
  private readonly rows = new Map<string, StoredMemory>();

  async upsert(userId: string, key: string, content: string): Promise<void> {
    const id = `${userId}\n${key}`;
    const prev = this.rows.get(id);
    const now = Date.now();
    this.rows.set(id, {
      key,
      content,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async get(userId: string, key: string): Promise<StoredMemory | undefined> {
    return this.rows.get(`${userId}\n${key}`);
  }

  async list(userId: string, limit = 50): Promise<StoredMemory[]> {
    const out: StoredMemory[] = [];
    for (const [id, m] of this.rows) {
      if (id.startsWith(`${userId}\n`)) out.push(m);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async delete(userId: string, key: string): Promise<boolean> {
    return this.rows.delete(`${userId}\n${key}`);
  }

  async count(userId: string): Promise<number> {
    let n = 0;
    for (const id of this.rows.keys()) if (id.startsWith(`${userId}\n`)) n++;
    return n;
  }
}

describe("sweepEventReminders", () => {
  // NOW is 2026-10-17 (25 Mehr 1405); a birthday on 29 Mehr is 4 days out.
  test("builds a reminder for an upcoming event, addressed to its owner only", async () => {
    const store = new EventStore(new FakeProvider());
    await store.add("u1", { name: "علی", kind: "birthday", jMonth: 7, jDay: 29, labelFa: "۲۹ مهر" });
    await store.add("u2", { name: "سارا", kind: "birthday", jMonth: 7, jDay: 29, labelFa: "۲۹ مهر" });

    const out = await sweepEventReminders({ store, userId: "u1", nowMs: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.userId).toBe("u1");
    expect(out[0]!.message).toContain("علی");

    // Marked reminded: a second sweep inside the cooldown is silent.
    expect(await sweepEventReminders({ store, userId: "u1", nowMs: NOW + DAY })).toEqual([]);
  });

  test("caps deliveries per sweep", async () => {
    const store = new EventStore(new FakeProvider());
    for (let i = 0; i < 4; i++) {
      await store.add("u1", { name: `نفر${i}`, kind: "birthday", jMonth: 7, jDay: 29, labelFa: "۲۹ مهر" });
    }
    const out = await sweepEventReminders({ store, userId: "u1", nowMs: NOW, max: 2 });
    expect(out).toHaveLength(2);
  });

  test("events outside the horizon stay silent", async () => {
    const store = new EventStore(new FakeProvider());
    await store.add("u1", { name: "دور", kind: "birthday", jMonth: 8, jDay: 15, labelFa: "۱۵ آبان" });
    expect(await sweepEventReminders({ store, userId: "u1", nowMs: NOW })).toEqual([]);
  });
});
