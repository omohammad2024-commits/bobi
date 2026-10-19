/**
 * Reminder scheduling.
 *
 * The behaviours that matter are the ones a naive timer gets wrong:
 *  - a reminder whose time passed while the process was down still fires
 *  - a reminder that is far overdue is retired rather than flooding the user
 *  - two passes never both send the same reminder
 *  - a repeating reminder re-arms from its scheduled time, not from "now"
 *
 * The clock is injected everywhere, so none of these depend on wall time.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { ReminderScheduler, stepFor } from "../src/scheduler/scheduler";

const DAY = 24 * 60 * 60 * 1_000;
const WEEK = 7 * DAY;

function harness(startAt = 1_000_000_000_000) {
  const storage = Storage.open(":memory:");
  let clock = startAt;
  const sent: Array<{ chatId: string; text: string }> = [];
  let deliverOk = true;

  const scheduler = new ReminderScheduler({
    storage,
    intervalMs: 1_000,
    now: () => clock,
    deliver: async (d) => {
      if (!deliverOk) return false;
      sent.push(d);
      return true;
    },
  });

  return {
    storage,
    scheduler,
    sent,
    setDeliverOk: (ok: boolean) => {
      deliverOk = ok;
    },
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    set: (ms: number) => {
      clock = ms;
    },
  };
}

describe("firing a due reminder", () => {
  test("a reminder due now is delivered", async () => {
    const h = harness();
    h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "آب بخور",
      dueAt: h.now(),
      repeat: "none",
    });

    const r = await h.scheduler.tick();
    expect(r.delivered).toBe(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.chatId).toBe("c1");
    expect(h.sent[0]!.text).toContain("آب بخور");

    h.storage.close();
  });

  test("a reminder in the future is not delivered yet", async () => {
    const h = harness();
    h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "بعداً",
      dueAt: h.now() + 60_000,
      repeat: "none",
    });

    expect((await h.scheduler.tick()).delivered).toBe(0);
    expect(h.sent).toHaveLength(0);

    // ...and it fires once the clock reaches it.
    h.advance(60_000);
    expect((await h.scheduler.tick()).delivered).toBe(1);

    h.storage.close();
  });

  test("a fired reminder is never delivered twice", async () => {
    const h = harness();
    h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "یک‌بار",
      dueAt: h.now(),
      repeat: "none",
    });

    expect((await h.scheduler.tick()).delivered).toBe(1);
    // A second pass finds nothing pending.
    expect((await h.scheduler.tick()).delivered).toBe(0);
    expect(h.sent).toHaveLength(1);

    h.storage.close();
  });

  test("the reminder is marked fired with its timestamp", async () => {
    const h = harness();
    const id = h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "t",
      dueAt: h.now(),
      repeat: "none",
    });
    await h.scheduler.tick();

    const row = h.storage.getReminder("u1", id)!;
    expect(row.state).toBe("fired");
    expect(row.firedAt).toBe(h.now());

    h.storage.close();
  });
});

describe("catch-up after downtime", () => {
  test("a reminder due while the process was down still fires", async () => {
    const h = harness();
    // Scheduled for a time that passed ten minutes ago.
    h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "مهم",
      dueAt: h.now() - 10 * 60_000,
      repeat: "none",
    });

    // On the next pass it fires: a sleeping laptop must not lose the reminder.
    expect((await h.scheduler.tick()).delivered).toBe(1);

    h.storage.close();
  });

  test("a reminder far overdue is retired, not delivered", async () => {
    const h = harness();
    const id = h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "خیلی قدیمی",
      dueAt: h.now() - 5 * DAY,
      repeat: "none",
    });

    const r = await h.scheduler.tick();
    expect(r.delivered).toBe(0);
    expect(r.missed).toBe(1);
    // It is not sent: a reminder from five days ago is noise.
    expect(h.sent).toHaveLength(0);
    expect(h.storage.getReminder("u1", id)!.state).toBe("fired");

    h.storage.close();
  });

  test("lateness is bounded by the configured window", async () => {
    const storage = Storage.open(":memory:");
    let clock = 1_000_000_000_000;
    const sent: string[] = [];
    const scheduler = new ReminderScheduler({
      storage,
      intervalMs: 1_000,
      now: () => clock,
      maxLatenessMs: 60_000,
      deliver: async () => {
        sent.push("x");
        return true;
      },
    });

    // Two minutes late, with a one-minute tolerance.
    storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "t",
      dueAt: clock - 120_000,
      repeat: "none",
    });

    await scheduler.tick();
    expect(sent).toHaveLength(0);
    storage.close();
  });

  test("a backlog of due reminders is delivered in time order", async () => {
    const h = harness();
    for (const [i, text] of ["اول", "دوم", "سوم"].entries()) {
      h.storage.createReminder({
        userId: "u1",
        chatId: "c1",
        text,
        dueAt: h.now() - (3 - i) * 1_000,
        repeat: "none",
      });
    }

    await h.scheduler.tick();
    expect(h.sent.map((s) => s.text.replace("⏰ Reminder: ", ""))).toEqual([
      "اول",
      "دوم",
      "سوم",
    ]);
    h.storage.close();
  });
});

describe("repeating reminders", () => {
  test("a daily reminder re-arms for the next day", async () => {
    const h = harness();
    const id = h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "روزانه",
      dueAt: h.now(),
      repeat: "daily",
    });

    await h.scheduler.tick();
    expect(h.sent).toHaveLength(1);

    // It is pending again, one day later, not fired.
    const row = h.storage.getReminder("u1", id)!;
    expect(row.state).toBe("pending");
    expect(row.dueAt).toBe(h.now() + DAY);

    h.storage.close();
  });

  test("a weekly reminder re-arms for the next week", async () => {
    const h = harness();
    const id = h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "هفتگی",
      dueAt: h.now(),
      repeat: "weekly",
    });
    await h.scheduler.tick();
    expect(h.storage.getReminder("u1", id)!.dueAt).toBe(h.now() + WEEK);
    h.storage.close();
  });

  test("the next occurrence is computed from the SCHEDULED time, not from now", async () => {
    // The pass runs two minutes late. If re-arming used `now`, a daily
    // reminder would drift later by two minutes every day.
    const h = harness();
    const id = h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "t",
      dueAt: h.now(),
      repeat: "daily",
    });

    h.advance(120_000);
    await h.scheduler.tick();

    const row = h.storage.getReminder("u1", id)!;
    // Scheduled time + one day, not "now" + one day.
    expect(row.dueAt).toBe(1_000_000_000_000 + DAY);
    h.storage.close();
  });

  test("a long outage re-arms the series without replaying every missed day", async () => {
    const h = harness();
    const id = h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "t",
      dueAt: h.now(),
      repeat: "daily",
    });

    // Five days pass with the process down.
    h.advance(5 * DAY);
    const r = await h.scheduler.tick();

    // The stale occurrence is not replayed: five days of reminders arriving at
    // once is noise, not a reminder.
    expect(h.sent).toHaveLength(0);
    expect(r.missed).toBe(1);

    // But the SERIES continues, with the next occurrence in the future.
    const row = h.storage.getReminder("u1", id)!;
    expect(row.state).toBe("pending");
    expect(row.dueAt).toBeGreaterThan(h.now());

    // ...and it fires normally when that time arrives.
    h.set(row.dueAt);
    expect((await h.scheduler.tick()).delivered).toBe(1);

    h.storage.close();
  });

  test("a far-overdue repeating reminder is re-armed rather than dropped", async () => {
    const h = harness();
    const id = h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "t",
      dueAt: h.now() - 3 * DAY,
      repeat: "daily",
    });

    const r = await h.scheduler.tick();
    // Too late to deliver, so it counts as missed...
    expect(r.missed).toBe(1);
    // ...but the series continues.
    const row = h.storage.getReminder("u1", id)!;
    expect(row.state).toBe("pending");
    expect(row.dueAt).toBeGreaterThan(h.now());
    h.storage.close();
  });
});

describe("cancellation", () => {
  test("a cancelled reminder never fires", async () => {
    const h = harness();
    const id = h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "لغو شد",
      dueAt: h.now() + 1_000,
      repeat: "none",
    });
    expect(h.storage.cancelReminder("u1", id)).toBe(true);

    h.advance(2_000);
    await h.scheduler.tick();
    expect(h.sent).toHaveLength(0);
    h.storage.close();
  });

  test("one user cannot cancel another's reminder", async () => {
    const h = harness();
    const id = h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "t",
      dueAt: h.now(),
      repeat: "none",
    });

    expect(h.storage.cancelReminder("u2", id)).toBe(false);
    // Still pending, and still fires for its owner.
    await h.scheduler.tick();
    expect(h.sent).toHaveLength(1);
    h.storage.close();
  });

  test("cancelling twice reports the second as a no-op", async () => {
    const h = harness();
    const id = h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "t",
      dueAt: h.now(),
      repeat: "none",
    });
    expect(h.storage.cancelReminder("u1", id)).toBe(true);
    expect(h.storage.cancelReminder("u1", id)).toBe(false);
    h.storage.close();
  });
});

describe("delivery failure", () => {
  test("a failed one-off delivery is claimed so it cannot loop forever", async () => {
    const h = harness();
    h.setDeliverOk(false);
    h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "t",
      dueAt: h.now(),
      repeat: "none",
    });

    await h.scheduler.tick();
    expect(h.sent).toHaveLength(0);

    // The row was claimed before the send, so a later pass does not retry a
    // chat that rejected the message.
    expect((await h.scheduler.tick()).delivered).toBe(0);
    h.storage.close();
  });

  test("a failed delivery does NOT kill a repeating series", async () => {
    // One transient Telegram error must not silently end a daily reminder the
    // user asked for. The occurrence is lost; the series is not.
    const h = harness();
    const id = h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "روزانه",
      dueAt: h.now(),
      repeat: "daily",
    });

    h.setDeliverOk(false);
    await h.scheduler.tick();

    // The failed occurrence was not delivered...
    expect(h.sent).toHaveLength(0);
    // ...but the reminder is pending again, at its next occurrence.
    const row = h.storage.getReminder("u1", id)!;
    expect(row.state).toBe("pending");
    expect(row.dueAt).toBeGreaterThan(h.now());

    // And it delivers normally next time.
    h.setDeliverOk(true);
    h.set(row.dueAt);
    expect((await h.scheduler.tick()).delivered).toBe(1);

    h.storage.close();
  });

  test("the delivery callback receives the owning user", async () => {
    // The delivery path needs the user id to re-check access at send time.
    const storage = Storage.open(":memory:");
    const clock = 1_000_000_000_000;
    const seen: Array<{ chatId: string; userId: string }> = [];
    const scheduler = new ReminderScheduler({
      storage,
      intervalMs: 1_000,
      now: () => clock,
      deliver: async (d) => {
        seen.push({ chatId: d.chatId, userId: d.userId });
        return true;
      },
    });

    storage.createReminder({
      userId: "u42",
      chatId: "c9",
      text: "t",
      dueAt: clock,
      repeat: "none",
    });
    await scheduler.tick();

    expect(seen).toEqual([{ chatId: "c9", userId: "u42" }]);
    storage.close();
  });

  test("a throwing delivery does not abort the whole pass", async () => {
    const storage = Storage.open(":memory:");
    const clock = 1_000_000_000_000;
    const sent: string[] = [];
    let calls = 0;
    const scheduler = new ReminderScheduler({
      storage,
      intervalMs: 1_000,
      now: () => clock,
      deliver: async (d) => {
        calls++;
        if (calls === 1) throw new Error("boom");
        sent.push(d.chatId);
        return true;
      },
    });

    storage.createReminder({ userId: "u1", chatId: "c1", text: "a", dueAt: clock, repeat: "none" });
    storage.createReminder({ userId: "u2", chatId: "c2", text: "b", dueAt: clock, repeat: "none" });

    const r = await scheduler.tick();
    // The first threw; the second still went out.
    expect(r.delivered).toBe(1);
    expect(sent).toEqual(["c2"]);
    storage.close();
  });
});

describe("concurrency", () => {
  test("a reminder claimed by one pass is skipped by another", async () => {
    const h = harness();
    const id = h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "t",
      dueAt: h.now(),
      repeat: "none",
    });

    // Simulate the race directly: whoever claims first wins.
    const first = h.storage.claimReminder(id, h.now());
    const second = h.storage.claimReminder(id, h.now());
    expect(first).toBe(true);
    expect(second).toBe(false);
    h.storage.close();
  });

  test("overlapping ticks do not double-send", async () => {
    const h = harness();
    h.storage.createReminder({
      userId: "u1",
      chatId: "c1",
      text: "t",
      dueAt: h.now(),
      repeat: "none",
    });

    // Two passes at once: the internal guard serialises them.
    const [a, b] = await Promise.all([h.scheduler.tick(), h.scheduler.tick()]);
    expect(a.delivered + b.delivered).toBe(1);
    expect(h.sent).toHaveLength(1);
    h.storage.close();
  });
});

describe("loop lifecycle", () => {
  test("start is idempotent and stop is safe when not started", () => {
    const h = harness();
    expect(h.scheduler.isRunning).toBe(false);
    h.scheduler.stop(); // no-op
    h.scheduler.start();
    expect(h.scheduler.isRunning).toBe(true);
    h.scheduler.start(); // idempotent
    expect(h.scheduler.isRunning).toBe(true);
    h.scheduler.stop();
    expect(h.scheduler.isRunning).toBe(false);
    h.storage.close();
  });

  test("the step for each repeat kind", () => {
    expect(stepFor("none")).toBe(0);
    expect(stepFor("daily")).toBe(DAY);
    expect(stepFor("weekly")).toBe(WEEK);
  });
});
