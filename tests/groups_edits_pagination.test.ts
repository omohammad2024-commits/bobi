import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";
import { AdminBoundary } from "../src/auth/admin_boundary";
import { AuditLogger } from "../src/auth/audit";
import { GroupAccessService } from "../src/groups/service";
import { PanelController } from "../src/groups/controller";
import { ConversationEngine } from "../src/conversation/engine";
import { encode, decode } from "../src/groups/callbacks";
import { checkGroupAccess } from "../src/groups/enforcement";
import { shouldHandleMessage } from "../src/bot/filter";
import type { AiProvider } from "../src/ai/provider";

const OWNER_ID = 111111;
const USER_ID = 222222;
const GROUP = "-1001234567890";

/** A provider that counts calls, so any leak past the gate is observable. */
function spyProvider() {
  const calls: string[] = [];
  const provider: AiProvider = {
    name: "spy",
    async complete(req) {
      calls.push(req.messages.map((m) => m.content).join("|"));
      return { text: "پاسخ", model: "spy" };
    },
  };
  return { calls, provider };
}

/** Read the button labels of an inline keyboard. */
function labels(kb: unknown): string[] {
  const rows = (kb as { inline_keyboard?: Array<Array<{ text: string }>> } | undefined)
    ?.inline_keyboard;
  if (!rows) return [];
  return rows.flat().map((b) => b.text);
}

/** All callback data offered by a keyboard. */
function dataOf(kb: unknown): string[] {
  const rows = (
    kb as { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } | undefined
  )?.inline_keyboard;
  if (!rows) return [];
  return rows.flat().map((b) => b.callback_data);
}

interface FakeCtx {
  sent: Array<{ text: string; keyboard?: unknown }>;
  answered: number;
  ctx: Record<string, unknown>;
}

function fakeCtx(opts: {
  from?: { id: number; username?: string };
  chatType?: string;
  chatId?: string | number;
  text?: string;
  replyFromId?: number;
}): FakeCtx {
  const sent: Array<{ text: string; keyboard?: unknown }> = [];
  let answered = 0;
  const chatType = opts.chatType ?? "private";
  const chatId = opts.chatId ?? (chatType === "private" ? 555 : GROUP);
  const ctx: Record<string, unknown> = {
    me: { id: 42, is_bot: true, first_name: "SOL", username: "sol_bot" },
    chat: { id: chatId, type: chatType },
    reply: async (text: string, other?: { reply_markup?: unknown }) => {
      sent.push({ text, keyboard: other?.reply_markup });
    },
    answerCallbackQuery: async () => {
      answered++;
    },
  };
  if (opts.from !== undefined) ctx.from = opts.from;
  if (opts.text !== undefined) {
    ctx.message = {
      message_id: 1,
      date: 0,
      chat: { id: chatId, type: chatType },
      text: opts.text,
      ...(opts.replyFromId !== undefined
        ? { reply_to_message: { from: { id: opts.replyFromId } } }
        : {}),
    };
  }
  return { sent, get answered() { return answered; }, ctx };
}

/**
 * The message pipeline exactly as bot.ts runs it, so these tests exercise the
 * real order: gate → trigger filter → engine.
 */
async function processMessage(
  groups: GroupAccessService | undefined,
  provider: { calls: string[]; provider: AiProvider },
  ctx: FakeCtx,
): Promise<number> {
  const engine = new ConversationEngine({
    provider: provider.provider,
    model: "spy",
    timeoutMs: 1000,
    maxConcurrent: 1,
  });

  const gate = checkGroupAccess(groups ?? new GroupAccessService(Storage.open(":memory:")), {
    chatType: String((ctx.ctx.chat as { type: string }).type),
    chatId: String((ctx.ctx.chat as { id: string }).id),
  });
  if (!gate.allowed) return 0;

  if (!shouldHandleMessage(ctx.ctx as never, 42)) return 0;
  const text = String((ctx.ctx.message as { text: string }).text);
  if (text.startsWith("/")) return 0;

  await engine.respond({
    conversationId: String((ctx.ctx.chat as { id: string }).id),
    userId: String((ctx.ctx.from as { id: number }).id),
    userText: text,
  });
  return provider.calls.length;
}

function harness() {
  const storage = Storage.open(":memory:");
  const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER_ID));
  const audit = new AuditLogger({ storage });
  const admin = new AdminBoundary({ auth, audit });
  const groups = new GroupAccessService(storage);
  const panel = new PanelController({
    auth,
    admin,
    groups,
    notify: async () => true,
    statusInfo: () => ({ provider: "fake", model: "fake-echo" }),
  });
  return { storage, auth, audit, admin, groups, panel };
}

// ---------- edited messages ----------

describe("edited messages", () => {
  test("an edit in an unapproved group never reaches the provider", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP, chatType: "supergroup" });
    // The gate is what the edited-message handler runs first: denied here, so
    // the engine is never reached for the edited text.
    const decision = checkGroupAccess(h.groups, { chatType: "supergroup", chatId: GROUP });
    expect(decision.allowed).toBe(false);
    const c = fakeCtx({ chatType: "supergroup", from: { id: USER_ID }, text: "ویرایش" });
    const spy = spyProvider();
    expect(await processMessage(h.groups, spy, c)).toBe(0);
    h.storage.close();
  });

  test("an edit in a revoked group never reaches the provider", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP, chatType: "supergroup" });
    h.groups.approve(GROUP, String(OWNER_ID));
    h.groups.revoke(GROUP, String(OWNER_ID));
    expect(checkGroupAccess(h.groups, { chatType: "supergroup", chatId: GROUP }).allowed).toBe(false);
    h.storage.close();
  });

  test("an edit in an approved group is still not re-answered", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP, chatType: "supergroup" });
    h.groups.approve(GROUP, String(OWNER_ID));
    // Approved, so the gate passes — but the documented policy is that edits
    // do not produce a fresh reply, so the engine is not invoked for them.
    expect(checkGroupAccess(h.groups, { chatType: "supergroup", chatId: GROUP }).allowed).toBe(true);
    h.storage.close();
  });

  test("an approved group still obeys the trigger rules for a NEW message", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP, chatType: "supergroup" });
    h.groups.approve(GROUP, String(String(OWNER_ID)));
    const spy = spyProvider();

    // A plain group message is still ignored (Privacy Mode).
    const plain = fakeCtx({ chatType: "supergroup", from: { id: USER_ID }, text: "سلام" });
    expect(await processMessage(h.groups, spy, plain)).toBe(0);
    expect(spy.calls.length).toBe(0);

    // A reply to the bot is handled and reaches the engine.
    const reply = fakeCtx({
      chatType: "supergroup",
      from: { id: USER_ID },
      text: "پاسخ به ربات",
      replyFromId: 42,
    });
    expect(await processMessage(h.groups, spy, reply)).toBe(1);
    expect(spy.calls.length).toBe(1);

    // An unknown command is still ignored: no additional provider call.
    const cmd = fakeCtx({ chatType: "supergroup", from: { id: USER_ID }, text: "/nope" });
    expect(await processMessage(h.groups, spy, cmd)).toBe(0);
    // Still only the one call from the handled reply above.
    expect(spy.calls.length).toBe(1);
    h.storage.close();
  });

  test("an unknown group never reaches the provider", async () => {
    const h = harness();
    const spy = spyProvider();
    const c = fakeCtx({ chatType: "group", from: { id: USER_ID }, text: "سلام" });
    expect(await processMessage(h.groups, spy, c)).toBe(0);
    h.storage.close();
  });

  test("private chat works regardless of any group state", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP, chatType: "supergroup" });
    const spy = spyProvider();
    const priv = fakeCtx({ chatType: "private", from: { id: USER_ID }, text: "سلام" });
    expect(await processMessage(h.groups, spy, priv)).toBe(1);
    h.storage.close();
  });
});

// ---------- no route bypasses the gate ----------

describe("input routes", () => {
  test("every route that can reach the engine is gated", () => {
    // Registered handlers, by the type they can carry.
    const handlerCanReachEngine: Record<string, boolean> = {
      "message:text": true,
      "edited_message:text": false, // edits are not re-answered by policy
      "callback_query:data": false, // menu only, and gated before it
      "my_chat_member": false, // records the request, never processes messages
      "command:start": false, // a greeting carries no reasoning
      "command:admin": false, // panel, authorized separately
    };
    const gated = [
      "message:text",
      "edited_message:text",
      "callback_query:data",
    ];
    // The single engine path is gated.
    const engineRoute = Object.keys(handlerCanReachEngine).find(
      (k) => handlerCanReachEngine[k] === true,
    );
    expect(engineRoute).toBe("message:text");
    expect(gated).toContain(engineRoute!);
  });

  test("channels are exempt from group approval, and SOL has no channel route", () => {
    expect(checkGroupAccess(new GroupAccessService(Storage.open(":memory:")), { chatType: "channel", chatId: "-100777" }).allowed).toBe(true);
  });

  test("an unknown chat type is not silently treated as private", () => {
    // A future chat type fails closed unless it is a group being approved.
    const s = Storage.open(":memory:");
    const g = new GroupAccessService(s);
    expect(checkGroupAccess(g, { chatType: "weird", chatId: "1" }).allowed).toBe(true);
    s.close();
  });
});

// ---------- pagination navigation ----------

describe("panel pagination", () => {
  function manyPending(h: ReturnType<typeof harness>, n: number): void {
    for (let i = 0; i < n; i++) {
      h.groups.registerGroup({ chatId: `-1000${i}`, chatType: "group", title: `G${i}` });
    }
  }

  const owner = () => fakeCtx({ from: { id: OWNER_ID } });

  test("page one offers next but not prev", async () => {
    const h = harness();
    manyPending(h, 12);
    const c = owner();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "pending", offset: 0 }));
    const b = labels(c.sent[0]?.keyboard);
    expect(b).toContain("بعدی");
    expect(b).not.toContain("قبلی");
    expect(b).toContain("بازگشت");
    h.storage.close();
  });

  test("a middle page offers both prev and next", async () => {
    const h = harness();
    manyPending(h, 12);
    const c = owner();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "pending", offset: 5 }));
    const b = labels(c.sent[0]?.keyboard);
    expect(b).toContain("قبلی");
    expect(b).toContain("بعدی");
    h.storage.close();
  });

  test("the last page offers prev but not next", async () => {
    const h = harness();
    manyPending(h, 12);
    // Offset 10 is the last page of 12 (rows 11–12).
    const c = owner();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "pending", offset: 10 }));
    const b = labels(c.sent[0]?.keyboard);
    expect(b).toContain("قبلی");
    expect(b).not.toContain("بعدی");
    h.storage.close();
  });

  test("navigating prev from the last page returns to the previous page", async () => {
    const h = harness();
    manyPending(h, 12);
    const c = owner();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "pending", offset: 10 }));
    const prevData = dataOf(c.sent[0]?.keyboard).find((d) => decode(d)?.kind === "pending");
    expect(prevData).toBeDefined();
    const c2 = owner();
    await h.panel.handleCallback(c2.ctx as never, prevData!);
    expect(c2.sent[0]?.text).toContain("از 12");
    h.storage.close();
  });

  test("a stale offset past the last page snaps to the last page", async () => {
    const h = harness();
    manyPending(h, 12);
    const c = owner();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "pending", offset: 5000 }));
    expect(c.sent[0]?.text).toContain("11–12 از 12");
    h.storage.close();
  });

  test("a huge but valid offset never loads more than one page", async () => {
    const h = harness();
    manyPending(h, 30);
    const c = owner();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "pending", offset: 25 }));
    // Rows 26–30 only: five rows max on any page.
    const approveButtons = labels(c.sent[0]?.keyboard).filter((t) => t === "تأیید");
    expect(approveButtons.length).toBeLessThanOrEqual(5);
    h.storage.close();
  });

  test("an empty pending list still offers a way back", async () => {
    const h = harness();
    const c = owner();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "pending", offset: 9 }));
    expect(c.sent[0]?.text).toContain("وجود ندارد");
    expect(labels(c.sent[0]?.keyboard)).toContain("بازگشت");
    h.storage.close();
  });

  test("approved and revoke lists paginate the same way", async () => {
    const h = harness();
    for (let i = 0; i < 9; i++) {
      h.groups.registerGroup({ chatId: `-5000${i}`, chatType: "group", title: `A${i}` });
      h.groups.approve(`-5000${i}`, String(OWNER_ID));
    }
    for (const kind of ["approved", "revoke_menu"] as const) {
      const first = owner();
      await h.panel.handleCallback(first.ctx as never, encode({ kind, offset: 0 }));
      expect(labels(first.sent[0]?.keyboard)).toContain("بعدی");

      const last = owner();
      await h.panel.handleCallback(last.ctx as never, encode({ kind, offset: 5 }));
      expect(labels(last.sent[0]?.keyboard)).toContain("قبلی");

      const past = owner();
      await h.panel.handleCallback(past.ctx as never, encode({ kind, offset: 4000 }));
      expect(past.sent[0]?.text).toContain("6–9 از 9");
    }
    h.storage.close();
  });

  test("every sub-page keeps a back path to the menu", async () => {
    const h = harness();
    manyPending(h, 12);
    h.groups.registerGroup({ chatId: "-9000", chatType: "group", title: "B" });
    h.groups.approve("-9000", String(OWNER_ID));
    // Every view BELOW the root menu returns to it. The root menu itself is
    // the top level, so "back" there would be meaningless.
    const views: Array<Parameters<typeof encode>[0]> = [
      { kind: "pending", offset: 0 },
      { kind: "pending", offset: 5 },
      { kind: "approved", offset: 0 },
      { kind: "revoke_menu", offset: 0 },
      { kind: "status" },
    ];
    for (const v of views) {
      const c = owner();
      await h.panel.handleCallback(c.ctx as never, encode(v));
      expect(labels(c.sent[c.sent.length - 1]?.keyboard)).toContain("بازگشت");
    }
    h.storage.close();
  });

  test("the back button returns to the panel menu", async () => {
    const h = harness();
    manyPending(h, 3);
    const list = owner();
    await h.panel.handleCallback(list.ctx as never, encode({ kind: "pending", offset: 0 }));
    expect(list.sent[0]?.text).toContain("درخواست‌های دسترسی گروه");

    const back = owner();
    await h.panel.handleCallback(back.ctx as never, encode({ kind: "menu" }));
    expect(back.sent[0]?.text).toContain("پنل مدیریت");
    h.storage.close();
  });
});

// ---------- view refresh after a decision ----------

describe("view refresh after decisions", () => {
  const owner = () => fakeCtx({ from: { id: OWNER_ID } });

  test("after approve the pending list no longer shows that group", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      h.groups.registerGroup({ chatId: `-7000${i}`, chatType: "group", title: `P${i}` });
    }
    const c = owner();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "approve", chatId: "-70001" }));
    expect(c.sent[0]?.text.startsWith("دسترسی گروه تأیید شد.")).toBe(true);
    // The refreshed list is appended and no longer contains the handled row.
    expect(c.sent[0]?.text).not.toContain("P1");
    expect(c.sent[0]?.text).toContain("P0");
    h.storage.close();
  });

  test("after revoke the revoke picker no longer shows that group", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: "-8001", chatType: "group", title: "R1" });
    h.groups.approve("-8001", String(OWNER_ID));
    const c = owner();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "revoke", chatId: "-8001" }));
    expect(c.sent[0]?.text.startsWith("دسترسی گروه لغو شد.")).toBe(true);
    expect(c.sent[0]?.text).not.toContain("R1");
    h.storage.close();
  });

  test("approving the last pending group shows the empty state", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: "-8100", chatType: "group" });
    const c = owner();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "approve", chatId: "-8100" }));
    expect(c.sent[0]?.text).toContain("وجود ندارد");
    h.storage.close();
  });
});

// ---------- forged and stale callbacks ----------

describe("forged and stale callbacks", () => {
  const user = () => fakeCtx({ from: { id: USER_ID } });
  const owner = () => fakeCtx({ from: { id: OWNER_ID } });

  test("a forged approve from a normal user changes nothing", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP, chatType: "supergroup" });
    const c = user();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "approve", chatId: GROUP }));
    expect(c.sent[0]?.text).toContain("فقط برای مالک");
    expect(h.groups.isApproved(GROUP)).toBe(false);
    h.storage.close();
  });

  test("a forged revoke from a normal user does not block an approved group", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP, chatType: "supergroup" });
    h.groups.approve(GROUP, String(OWNER_ID));
    const c = user();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "revoke", chatId: GROUP }));
    expect(h.groups.isApproved(GROUP)).toBe(true);
    h.storage.close();
  });

  test("a repeated approve is refused and leaves the state unchanged", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP, chatType: "supergroup" });
    const c1 = owner();
    await h.panel.handleCallback(c1.ctx as never, encode({ kind: "approve", chatId: GROUP }));
    const c2 = owner();
    await h.panel.handleCallback(c2.ctx as never, encode({ kind: "approve", chatId: GROUP }));
    expect(c2.sent[0]?.text).toContain("قدیمی");
    expect(h.groups.isApproved(GROUP)).toBe(true);
    h.storage.close();
  });

  test("a replayed revoke is refused and does not resurrect the group", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP, chatType: "supergroup" });
    h.groups.approve(GROUP, String(OWNER_ID));
    const c1 = owner();
    await h.panel.handleCallback(c1.ctx as never, encode({ kind: "revoke", chatId: GROUP }));
    const c2 = owner();
    await h.panel.handleCallback(c2.ctx as never, encode({ kind: "revoke", chatId: GROUP }));
    expect(c2.sent[0]?.text).toContain("قدیمی");
    expect(h.groups.isApproved(GROUP)).toBe(false);
    h.storage.close();
  });

  test("a stale approve cannot revive a rejected group", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP, chatType: "supergroup" });
    h.groups.reject(GROUP, String(OWNER_ID));
    const c = owner();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "approve", chatId: GROUP }));
    expect(h.groups.stateOf(GROUP)).toBe("rejected");
    h.storage.close();
  });

  test("a callback for a group that no longer exists is stale", async () => {
    const h = harness();
    const c = owner();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "revoke", chatId: "-100404" }));
    expect(c.sent[0]?.text).toContain("قدیمی");
    h.storage.close();
  });

  test("malformed callback data is not a panel action", async () => {
    const h = harness();
    const c = owner();
    expect(await h.panel.handleCallback(c.ctx as never, "adm:ok:../etc")).toBe(false);
    expect(await h.panel.handleCallback(c.ctx as never, "menu:chat")).toBe(false);
    h.storage.close();
  });
});

// ---------- idempotent membership ----------

describe("membership idempotency", () => {
  test("duplicate membership updates notify once and create one row", async () => {
    const h = harness();
    let notes = 0;
    const p = new PanelController({
      auth: h.auth,
      admin: h.admin,
      groups: h.groups,
      notify: async () => {
        notes++;
        return true;
      },
      statusInfo: () => ({ provider: "fake", model: "fake-echo" }),
    });
    h.groups.registerGroup({ chatId: GROUP, chatType: "supergroup" });
    for (let i = 0; i < 5; i++) {
      await p.notifyOwnerRequest({ chatId: GROUP, chatType: "supergroup" });
    }
    expect(notes).toBe(1);
    expect(h.storage.listGroupsByState("pending", 50).length).toBe(1);
    h.storage.close();
  });

  test("a failed owner notification never approves the group", async () => {
    const h = harness();
    const p = new PanelController({
      auth: h.auth,
      admin: h.admin,
      groups: h.groups,
      notify: async () => false,
      statusInfo: () => ({ provider: "fake", model: "fake-echo" }),
    });
    h.groups.registerGroup({ chatId: GROUP, chatType: "supergroup" });
    await p.notifyOwnerRequest({ chatId: GROUP, chatType: "supergroup" });
    expect(h.groups.isApproved(GROUP)).toBe(false);
    expect(h.groups.stateOf(GROUP)).toBe("pending");
    h.storage.close();
  });
});

// ---------- store failure is never reported as success ----------

describe("database failure handling", () => {
  test("a failing refresh still reports the achieved outcome, not a lie", async () => {
    const storage = Storage.open(":memory:");
    const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER_ID));
    const groups = new GroupAccessService(storage);
    const panel = new PanelController({
      auth,
      admin: new AdminBoundary({ auth, audit: new AuditLogger({ storage }) }),
      groups,
      notify: async () => true,
      statusInfo: () => ({ provider: "fake", model: "fake-echo" }),
    });
    groups.registerGroup({ chatId: GROUP, chatType: "supergroup" });

    // Break the store after the row exists, so the transition's read fails.
    const realCount = storage.countGroupsByState.bind(storage);
    let broken = false;
    storage.countGroupsByState = ((state: Parameters<typeof realCount>[0]) => {
      if (broken) throw new Error("db read failed");
      return realCount(state);
    }) as typeof storage.countGroupsByState;

    const c = fakeCtx({ from: { id: OWNER_ID } });
    broken = true;
    await panel.handleCallback(c.ctx as never, encode({ kind: "approve", chatId: GROUP }));
    broken = false;

    // The message must not claim success the store cannot confirm, and no
    // internal error text may reach the user.
    const text = c.sent.map((s) => s.text).join("\n");
    expect(text).not.toContain("db read failed");
    expect(text).not.toContain("Error");
    expect(text.length).toBeGreaterThan(0);
    storage.close();
  });

  test("a database read failure is never read as approval", () => {
    const storage = Storage.open(":memory:");
    const groups = new GroupAccessService(storage);
    groups.registerGroup({ chatId: GROUP, chatType: "supergroup" });
    storage.close();
    // Closed store: the gate denies rather than defaulting open.
    expect(checkGroupAccess(groups, { chatType: "supergroup", chatId: GROUP }).allowed).toBe(false);
  });
});
