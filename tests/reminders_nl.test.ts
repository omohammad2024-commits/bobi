/**
 * Persian natural-language reminders.
 *
 * parsePersianDateTime turns expressions like «فردا ساعت ۹ صبح» into
 * instants. Since the Phase-8 merge there is ONE creation tool: remind_at
 * takes the phrase in `when`, an exact instant in `dueAt`, and follow-ups
 * via `followUp` — the old remind_nl tool is gone. A fixed clock keeps
 * every assertion deterministic.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { ToolService } from "../src/tools/service";
import { parsePersianDateTime } from "../src/tools/persian_datetime";
import {
  createReminderTools,
  REMIND_AT_PERMISSION,
} from "../src/tools/reminders";
import type { ToolActor } from "../src/tools/types";

/**
 * Monday 2026-10-19, 11:30 UTC — 15:00 in Tehran.
 *
 * The afternoon hour is deliberate: «ساعت ۹ صبح» must roll to tomorrow,
 * while «ساعت ۴ بعدازظهر» still lands today.
 */
const NOW = new Date("2026-10-19T11:30:00Z");

function parse(when: string): string | null {
  const d = parsePersianDateTime(when, NOW);
  return d === null ? null : d.toISOString();
}

describe("parsePersianDateTime", () => {
  test("day words with a time", () => {
    expect(parse("فردا ساعت ۹ صبح")).toBe("2026-10-20T05:30:00.000Z");
    expect(parse("پس‌فردا ساعت ۱۲ ظهر")).toBe("2026-10-21T08:30:00.000Z");
    expect(parse("امروز ساعت ۸ شب")).toBe("2026-10-19T16:30:00.000Z");
  });

  test("امشب implies evening when no meridiem is named", () => {
    expect(parse("امشب ساعت ۹")).toBe("2026-10-19T17:30:00.000Z");
    expect(parse("امشب ساعت ۹ شب")).toBe("2026-10-19T17:30:00.000Z");
  });

  test("a time that already passed today rolls to tomorrow", () => {
    expect(parse("ساعت ۹ صبح")).toBe("2026-10-20T05:30:00.000Z");
    expect(parse("۹:۳۰")).toBe("2026-10-20T06:00:00.000Z");
  });

  test("a later time today stays today", () => {
    expect(parse("ساعت ۴ بعدازظهر")).toBe("2026-10-19T12:30:00.000Z");
    expect(parse("ساعت ۸ شب")).toBe("2026-10-19T16:30:00.000Z");
  });

  test("relative durations in Persian digits", () => {
    expect(parse("۱۰ دقیقه دیگه")).toBe("2026-10-19T11:40:00.000Z");
    expect(parse("۲ ساعت دیگه")).toBe("2026-10-19T13:30:00.000Z");
    expect(parse("۳ روز دیگه")).toBe("2026-10-22T11:30:00.000Z");
  });

  test("نیم ساعت دیگه is thirty minutes", () => {
    expect(parse("نیم ساعت دیگه")).toBe("2026-10-19T12:00:00.000Z");
  });

  test("Persian number words", () => {
    expect(parse("دو ساعت دیگه")).toBe("2026-10-19T13:30:00.000Z");
    expect(parse("یه ربع دیگه")).toBeNull(); // «ربع» is not a supported unit
  });

  test("bare هفته/ماه دیگه mean one of each", () => {
    expect(parse("هفته‌ی دیگه")).toBe("2026-10-26T11:30:00.000Z");
    expect(parse("ماه دیگه")).toBe("2026-11-18T11:30:00.000Z");
  });

  test("weekdays resolve to the next such weekday", () => {
    // Today is Monday; 10:00 already passed, so next Monday.
    expect(parse("دوشنبه ساعت ۱۰")).toBe("2026-10-26T06:30:00.000Z");
    expect(parse("جمعه ساعت ۹ صبح")).toBe("2026-10-23T05:30:00.000Z");
  });

  test("absolute Jalali dates convert to Gregorian", () => {
    // 15 Aban 1405 = 2026-11-06; no time defaults to 09:00 Tehran.
    expect(parse("۱۵ آبان")).toBe("2026-11-06T05:30:00.000Z");
    expect(parse("۱۵ آبان ساعت ۱۴")).toBe("2026-11-06T10:30:00.000Z");
  });

  test("a named Jalali year in the past has no future occurrence", () => {
    expect(parse("۱۵ آبان ۱۴۰۳")).toBeNull();
  });

  test("unparseable input returns null", () => {
    expect(parse("")).toBeNull();
    expect(parse("سلام چطوری")).toBeNull();
    expect(parse("فردا")).toBeNull(); // a day word with no time
    expect(parse("شاید بعدا")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// remind_at with a Persian `when` (the merged remind_nl surface)
// ---------------------------------------------------------------------------

const PERMS = [REMIND_AT_PERMISSION];

function actor(userId = "u1"): ToolActor {
  return { userId, permissions: PERMS };
}

/**
 * A service with a fixed clock.
 *
 * `conversationId` defaults to a real chat; pass the literal "none" to model
 * a caller with no conversation context.
 */
function service(conversationId: string | "none" = "chat-1") {
  const storage = Storage.open(":memory:");
  const svc = new ToolService({
    extraTools: createReminderTools({ storage }),
    clock: () => NOW,
  });
  return {
    storage,
    svc,
    conversationId: conversationId === "none" ? undefined : conversationId,
  };
}

interface Ctx {
  storage: Storage;
  svc: ToolService;
  conversationId: string | undefined;
}

/** Run through the Executor, with the conversation the bot would supply. */
function run(ctx: Ctx, tool: string, input: unknown, who = actor()) {
  return ctx.svc.execute({
    tool,
    input,
    actor: who,
    ...(ctx.conversationId !== undefined ? { conversationId: ctx.conversationId } : {}),
  });
}

describe("remind_at (when form)", () => {
  test("stores a reminder parsed from a Persian expression", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", {
      text: "به مامان زنگ بزن",
      when: "فردا ساعت ۹ صبح",
    });

    expect(r.status).toBe("ok");
    const data = r.data as { id: number; dueAt: string; repeat: string; followUp: boolean; inMinutes: number };
    expect(data.dueAt).toBe("2026-10-20T05:30:00.000Z");
    expect(data.repeat).toBe("none");
    expect(data.followUp).toBe(false);
    expect(data.inMinutes).toBe(18 * 60);

    const row = ctx.storage.getReminder("u1", data.id)!;
    expect(row.text).toBe("به مامان زنگ بزن");
    expect(row.chatId).toBe("chat-1");
    expect(row.state).toBe("pending");
    expect(row.followup).toBe(false);
    ctx.storage.close();
  });

  test("an exact ISO dueAt works through the same tool", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", {
      text: "t",
      dueAt: "2026-10-20T05:30:00.000Z",
    });
    expect(r.status).toBe("ok");
    const data = r.data as { dueAt: string };
    expect(data.dueAt).toBe("2026-10-20T05:30:00.000Z");
    ctx.storage.close();
  });

  test("dueAt and when together are refused (exactly one form)", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", {
      text: "t",
      dueAt: "2026-10-20T05:30:00.000Z",
      when: "فردا ساعت ۹",
    });
    expect(r.status).toBe("invalid_input");
    expect(ctx.storage.countPendingReminders("u1")).toBe(0);
    ctx.storage.close();
  });

  test("an unparseable expression is refused and stores nothing", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", { text: "t", when: "شاید یه وقتی" });
    expect(r.status).toBe("invalid_input");
    expect(ctx.storage.countPendingReminders("u1")).toBe(0);
    ctx.storage.close();
  });

  test("an empty text is refused", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", { text: "   ", when: "۱۰ دقیقه دیگه" });
    expect(r.status).toBe("invalid_input");
    ctx.storage.close();
  });

  test("the pending-count ceiling applies", async () => {
    const ctx = service();
    for (let i = 0; i < 25; i++) {
      const r = await run(ctx, "remind_at", { text: `t${i}`, when: "۱۰ دقیقه دیگه" });
      expect(r.status).toBe("ok");
    }
    const r = await run(ctx, "remind_at", { text: "one too many", when: "۱۰ دقیقه دیگه" });
    expect(r.status).toBe("invalid_input");
    ctx.storage.close();
  });

  test("with no conversation context a plain reminder is refused", async () => {
    const ctx = service("none");
    const r = await run(ctx, "remind_at", { text: "t", when: "۱۰ دقیقه دیگه" });
    expect(r.status).toBe("not_allowed");
    expect(ctx.storage.countPendingReminders("u1")).toBe(0);
    ctx.storage.close();
  });

  test("an unknown field is rejected", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", {
      text: "t",
      when: "۱۰ دقیقه دیگه",
      chatId: "@someone_else",
    });
    expect(r.status).toBe("invalid_input");
    ctx.storage.close();
  });

  test("a follow-up is stored as a follow-up row addressed to the owner's DM", async () => {
    const ctx = service("-100123"); // created from inside a group chat
    const r = await run(ctx, "remind_at", {
      text: "پیگیری کن",
      when: "فردا ساعت ۹",
      followUp: true,
    });
    expect(r.status).toBe("ok");
    const data = r.data as { id: number; followUp: boolean };
    expect(data.followUp).toBe(true);
    const row = ctx.storage.getReminder("u1", data.id)!;
    expect(row.followup).toBe(true);
    expect(row.chatId).toBe("u1"); // DM convention: never the group
    ctx.storage.close();
  });

  test("a follow-up cannot also repeat", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", {
      text: "t",
      when: "فردا ساعت ۹",
      followUp: true,
      repeat: "daily",
    });
    expect(r.status).toBe("invalid_input");
    ctx.storage.close();
  });
});
