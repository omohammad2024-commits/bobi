/**
 * Reminder tools.
 *
 * The due time comes from a model, so it is untrusted in a specific way: it can
 * be in the past, absurdly far ahead, or missing a timezone entirely. Each of
 * those is a real failure mode this suite pins, along with the rule that the
 * delivery chat is never something the model names.
 */
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Storage } from "../src/storage/storage";
import { ToolService } from "../src/tools/service";
import {
  CANCEL_REMINDER_PERMISSION,
  createReminderTools,
  LIST_REMINDERS_PERMISSION,
  REMIND_AT_PERMISSION,
} from "../src/tools/reminders";
import type { ToolActor } from "../src/tools/types";

const PERMS = [REMIND_AT_PERMISSION, LIST_REMINDERS_PERMISSION, CANCEL_REMINDER_PERMISSION];

/** A fixed clock, so "in an hour" is a stable instant. */
const NOW = new Date("2026-10-17T12:00:00Z");

function actor(userId = "u1"): ToolActor {
  return { userId, permissions: PERMS };
}

/**
 * A service with a fixed clock.
 *
 * `conversationId` defaults to a real chat; pass the literal "none" to model a
 * caller with no conversation context. `undefined` cannot be the signal, since
 * a default parameter would silently substitute the real value for it.
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
  /** `undefined` means "no conversation context", which is a real case here. */
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

const later = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe("remind_at", () => {
  test("stores a future reminder and reports when it will fire", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", {
      text: "آب بخور",
      dueAt: later(60 * 60_000),
    });

    expect(r.status).toBe("ok");
    const data = r.data as { id: number; inMinutes: number; repeat: string };
    expect(data.inMinutes).toBe(60);
    expect(data.repeat).toBe("none");

    const row = ctx.storage.getReminder("u1", data.id)!;
    expect(row.text).toBe("آب بخور");
    expect(row.chatId).toBe("chat-1");
    expect(row.state).toBe("pending");
    ctx.storage.close();
  });

  test("a repeating reminder records its repeat", async () => {
    const ctx = service();
    for (const repeat of ["daily", "weekly"]) {
      const r = await run(ctx, "remind_at", {
        text: "t",
        dueAt: later(86_400_000),
        repeat,
      });
      expect((r.data as { repeat: string }).repeat).toBe(repeat);
    }
    ctx.storage.close();
  });

  test("a time in the past is refused", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", {
      text: "گذشته",
      dueAt: new Date(NOW.getTime() - 60_000).toISOString(),
    });
    expect(r.status).toBe("invalid_input");
    expect(ctx.storage.countPendingReminders("u1")).toBe(0);
    ctx.storage.close();
  });

  test("a time only a second away is refused", async () => {
    // "In 2 seconds" is not a reminder; it also races the scheduler.
    const ctx = service();
    const r = await run(ctx, "remind_at", {
      text: "الان",
      dueAt: new Date(NOW.getTime() + 1_000).toISOString(),
    });
    expect(r.status).toBe("invalid_input");
    ctx.storage.close();
  });

  test("a time more than a year ahead is refused", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", {
      text: "خیلی دور",
      dueAt: new Date(NOW.getTime() + 400 * 86_400_000).toISOString(),
    });
    expect(r.status).toBe("invalid_input");
    ctx.storage.close();
  });

  test("a time without a timezone offset is refused", async () => {
    // Without an offset the string is not an instant, and would be silently
    // read as UTC — a guess, not a fact.
    const ctx = service();
    for (const dueAt of [
      "2026-10-20",
      "2026-10-20T09:30:00",
      "2026-10-20 09:30",
    ]) {
      const r = await run(ctx, "remind_at", { text: "t", dueAt });
      expect(r.status).toBe("invalid_input");
    }
    ctx.storage.close();
  });

  test("an offset-bearing time is accepted", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", {
      text: "t",
      dueAt: "2026-10-20T09:30:00+03:30",
    });
    expect(r.status).toBe("ok");
    ctx.storage.close();
  });

  test("a Z-suffixed time is accepted", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", {
      text: "t",
      dueAt: "2026-10-20T09:30:00Z",
    });
    expect(r.status).toBe("ok");
    ctx.storage.close();
  });

  test("unparseable text is refused", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", { text: "t", dueAt: "next tuesday+03:30" });
    expect(r.status).toBe("invalid_input");
    ctx.storage.close();
  });

  test("an empty text is refused", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", { text: "   ", dueAt: later(60_000) });
    expect(r.status).toBe("invalid_input");
    ctx.storage.close();
  });

  test("an over-long text is refused", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", {
      text: "x".repeat(600),
      dueAt: later(60_000),
    });
    expect(r.status).toBe("invalid_input");
    ctx.storage.close();
  });

  test("an unknown repeat value is refused", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", {
      text: "t",
      dueAt: later(60_000),
      repeat: "hourly",
    });
    expect(r.status).toBe("invalid_input");
    ctx.storage.close();
  });

  test("with no conversation context the reminder is refused", async () => {
    // The destination comes from server context, never the model, so without
    // one there is nowhere to deliver to.
    const ctx = service("none");
    const r = await run(ctx, "remind_at", { text: "t", dueAt: later(60_000) });
    expect(r.status).toBe("not_allowed");
    expect(ctx.storage.countPendingReminders("u1")).toBe(0);
    ctx.storage.close();
  });

  test("the model cannot name a different delivery chat", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", {
      text: "t",
      dueAt: later(60_000),
      chatId: "@someone_else",
      userId: "victim",
    });
    // Unknown fields are rejected, and the destination would be ignored anyway.
    expect(r.status).toBe("invalid_input");
    ctx.storage.close();
  });

  test("the per-user pending cap is enforced", async () => {
    const ctx = service();
    for (let i = 0; i < 25; i++) {
      await run(ctx, "remind_at", { text: `t${i}`, dueAt: later(60_000 + i * 1_000) });
    }
    const over = await run(ctx, "remind_at", { text: "overflow", dueAt: later(120_000) });
    expect(over.status).toBe("invalid_input");
    expect(ctx.storage.countPendingReminders("u1")).toBe(25);
    ctx.storage.close();
  });
});

describe("list_reminders", () => {
  test("lists only this user's pending reminders, soonest first", async () => {
    const ctx = service();
    await run(ctx, "remind_at", { text: "دوم", dueAt: later(120_000) });
    await run(ctx, "remind_at", { text: "اول", dueAt: later(60_000) });
    // Another user's reminder must not appear.
    await run(ctx, "remind_at", { text: "مال دیگری", dueAt: later(30_000) }, actor("u2"));

    const r = await run(ctx, "list_reminders", {});
    const data = r.data as { reminders: Array<{ text: string }>; count: number };
    expect(data.count).toBe(2);
    expect(data.reminders.map((x) => x.text)).toEqual(["اول", "دوم"]);
    ctx.storage.close();
  });

  test("an empty list is a normal result", async () => {
    const ctx = service();
    const r = await run(ctx, "list_reminders", {});
    expect(r.status).toBe("ok");
    expect((r.data as { count: number }).count).toBe(0);
    ctx.storage.close();
  });
});

describe("cancel_reminder", () => {
  test("cancels a pending reminder", async () => {
    const ctx = service();
    const created = await run(ctx, "remind_at", { text: "t", dueAt: later(60_000) });
    const id = (created.data as { id: number }).id;

    const r = await run(ctx, "cancel_reminder", { id });
    expect((r.data as { cancelled: boolean }).cancelled).toBe(true);
    expect(ctx.storage.getReminder("u1", id)!.state).toBe("cancelled");
    ctx.storage.close();
  });

  test("one user cannot cancel another's reminder", async () => {
    const ctx = service();
    const created = await run(ctx, "remind_at", { text: "t", dueAt: later(60_000) });
    const id = (created.data as { id: number }).id;

    const r = await run(ctx, "cancel_reminder", { id }, actor("u2"));
    expect((r.data as { cancelled: boolean }).cancelled).toBe(false);
    // Still pending for its owner.
    expect(ctx.storage.getReminder("u1", id)!.state).toBe("pending");
    ctx.storage.close();
  });

  test("cancelling an unknown id reports so without failing", async () => {
    const ctx = service();
    const r = await run(ctx, "cancel_reminder", { id: 9999 });
    expect(r.status).toBe("ok");
    expect((r.data as { cancelled: boolean }).cancelled).toBe(false);
    ctx.storage.close();
  });

  test("an id below one is rejected by validation", async () => {
    const ctx = service();
    expect((await run(ctx, "cancel_reminder", { id: 0 })).status).toBe("invalid_input");
    expect((await run(ctx, "cancel_reminder", { id: -5 })).status).toBe("invalid_input");
    ctx.storage.close();
  });
});

describe("authorization and identity", () => {
  test("an actor without the permission cannot schedule", async () => {
    const ctx = service();
    const r = await run(ctx, "remind_at", { text: "t", dueAt: later(60_000) }, {
      userId: "u1",
      permissions: [],
    });
    expect(r.status).toBe("not_allowed");
    ctx.storage.close();
  });

  test("an unidentified actor gets no reminder access", async () => {
    const ctx = service();
    const anon: ToolActor = { userId: "unknown", permissions: PERMS };
    const r = await run(ctx, "remind_at", { text: "t", dueAt: later(60_000) }, anon);
    expect(r.status).toBe("not_allowed");
    ctx.storage.close();
  });
});

describe("reminder persistence", () => {
  test("reminders survive a reopen", () => {
    // A unique path per run: a leftover file from an earlier run would make
    // this assert against state it did not create.
    const path = `${tmpdir()}/sol-reminder-persist-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.db`;
    const s1 = Storage.open(path);
    s1.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "t",
      dueAt: Date.now() + 60_000,
      repeat: "daily",
    });
    s1.close();

    const s2 = Storage.open(path);
    const rows = s2.listReminders("u1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repeat).toBe("daily");
    s2.close();

    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  });
});
