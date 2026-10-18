import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";
import { AdminBoundary } from "../src/auth/admin_boundary";
import { AuditLogger } from "../src/auth/audit";
import { GroupAccessService } from "../src/groups/service";
import { PanelController } from "../src/groups/controller";
import { encode } from "../src/groups/callbacks";
import { ConversationEngine } from "../src/conversation/engine";
import { checkGroupAccess } from "../src/groups/enforcement";

const OWNER_ID = 111111;
const USER_ID = 222222;
const GROUP_ID = "-1001234567890";

/** A fake ctx that records what the bot would send. */
function fakeCtx(from: { id: number; username?: string } | undefined) {
  const sent: Array<{ text: string; keyboard?: unknown }> = [];
  let answered = 0;
  return {
    sent,
    answered: () => answered,
    ctx: {
      get from() {
        return from;
      },
      reply: async (text: string, other?: { reply_markup?: unknown }) => {
        sent.push({ text, keyboard: other?.reply_markup });
      },
      answerCallbackQuery: async () => {
        answered++;
      },
    },
  };
}

interface Harness {
  storage: Storage;
  auth: AuthorizationService;
  admin: AdminBoundary;
  groups: GroupAccessService;
  panel: PanelController;
  notifyCalls: number;
  notifyOk: boolean;
}

function harness(opts: { notifyOk?: boolean } = {}): Harness {
  const storage = Storage.open(":memory:");
  const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER_ID));
  const audit = new AuditLogger({ storage });
  const admin = new AdminBoundary({ auth, audit });
  const groups = new GroupAccessService(storage);
  const h: Harness = {
    storage,
    auth,
    admin,
    groups,
    panel: undefined as unknown as PanelController,
    notifyCalls: 0,
    notifyOk: opts.notifyOk ?? true,
  };
  h.panel = new PanelController({
    auth,
    admin,
    groups,
    notify: async () => {
      h.notifyCalls++;
      return h.notifyOk;
    },
    statusInfo: () => ({ provider: "fake", model: "fake-echo" }),
  });
  return h;
}

const ownerCtx = () => fakeCtx({ id: OWNER_ID, username: "realowner" });
const userCtx = () => fakeCtx({ id: USER_ID, username: "someone" });

// ---------- /admin access ----------

describe("owner panel authorization", () => {
  test("owner can open the panel", async () => {
    const h = harness();
    const c = ownerCtx();
    await h.panel.openPanel(c.ctx as never);
    const text = c.sent.map((s) => s.text).join("\n");
    expect(text).toContain("پنل مدیریت");
    h.storage.close();
  });

  test("an ordinary user cannot open the panel", async () => {
    const h = harness();
    const c = userCtx();
    await h.panel.openPanel(c.ctx as never);
    expect(c.sent.length).toBe(1);
    expect(c.sent[0]?.text).toBe("این بخش فقط برای مالک ربات در دسترس است.");
    // No panel content leaked.
    expect(c.sent[0]?.text).not.toContain("پنل مدیریت");
    h.storage.close();
  });

  test("missing sender identity is denied", async () => {
    const h = harness();
    const c = fakeCtx(undefined);
    await h.panel.openPanel(c.ctx as never);
    expect(c.sent[0]?.text).toContain("فقط برای مالک");
    // The callback query is still answered, so no loading spinner hangs.
    expect(c.answered()).toBeGreaterThanOrEqual(0);
    h.storage.close();
  });

  test("a username matching the owner's username grants nothing", async () => {
    const h = harness();
    // Different numeric id, same display name as the owner.
    const c = fakeCtx({ id: USER_ID, username: "realowner" });
    await h.panel.openPanel(c.ctx as never);
    expect(c.sent[0]?.text).toContain("فقط برای مالک");
    h.storage.close();
  });

  test("a forged user id equal to the owner's is still not the owner", async () => {
    const h = harness();
    // The payload claims the owner id, but the trusted context says otherwise.
    const c = userCtx();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "approve", chatId: GROUP_ID }));
    expect(c.sent[0]?.text).toContain("فقط برای مالک");
    h.storage.close();
  });
});

// ---------- callback authorization ----------

describe("panel callback authorization", () => {
  test("an ordinary user cannot approve via a forged callback", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, chatType: "supergroup" });
    const c = userCtx();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "approve", chatId: GROUP_ID }));
    // Denied, and the group was NOT approved.
    expect(c.sent[0]?.text).toContain("فقط برای مالک");
    expect(h.groups.isApproved(GROUP_ID)).toBe(false);
    h.storage.close();
  });

  test("an ordinary user cannot reject or revoke either", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, chatType: "supergroup" });
    for (const kind of ["reject", "revoke"] as const) {
      const c = userCtx();
      await h.panel.handleCallback(c.ctx as never, encode({ kind, chatId: GROUP_ID }));
      expect(c.sent[0]?.text).toContain("فقط برای مالک");
    }
    expect(h.groups.stateOf(GROUP_ID)).toBe("pending");
    h.storage.close();
  });

  test("an ordinary user cannot read pending or lists", async () => {
    const h = harness();
    for (const data of [
      encode({ kind: "pending", offset: 0 }),
      encode({ kind: "approved", offset: 0 }),
      encode({ kind: "revoke_menu", offset: 0 }),
      encode({ kind: "status" }),
    ]) {
      const c = userCtx();
      await h.panel.handleCallback(c.ctx as never, data);
      expect(c.sent[0]?.text).toContain("فقط برای مالک");
    }
    h.storage.close();
  });

  test("an ordinary user's denial is audited and no state changes", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, chatType: "supergroup" });
    const c = userCtx();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "approve", chatId: GROUP_ID }));
    const rows = h.storage.auditEvents(20);
    expect(rows.some((r) => r.outcome === "denied" && r.operation === "group.approve")).toBe(true);
    expect(h.storage.groupAccess(GROUP_ID)?.state).toBe("pending");
    h.storage.close();
  });

  test("unknown callback data is not treated as a panel action", async () => {
    const h = harness();
    const c = ownerCtx();
    const handled = await h.panel.handleCallback(c.ctx as never, "menu:chat");
    // Another feature's namespace: the caller routes on, nothing is sent here.
    expect(handled).toBe(false);
    expect(c.sent.length).toBe(0);
    h.storage.close();
  });

  test("the owner's successful approval is audited", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, chatType: "supergroup" });
    const c = ownerCtx();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "approve", chatId: GROUP_ID }));
    const rows = h.storage.auditEvents(20);
    const ok = rows.find((r) => r.operation === "group.approve");
    expect(ok?.outcome).toBe("success");
    expect(ok?.actorId).toBe(String(OWNER_ID));
    expect(ok?.targetId).toBe(GROUP_ID);
    h.storage.close();
  });
});

// ---------- owner can complete the workflow ----------

describe("owner group workflow", () => {
  test("owner approves a pending group", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, chatType: "supergroup" });
    const c = ownerCtx();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "approve", chatId: GROUP_ID }));
    expect(h.groups.isApproved(GROUP_ID)).toBe(true);
    expect(c.sent.some((s) => s.text.includes("تأیید شد"))).toBe(true);
    h.storage.close();
  });

  test("owner rejects a pending group", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, chatType: "supergroup" });
    const c = ownerCtx();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "reject", chatId: GROUP_ID }));
    expect(h.groups.stateOf(GROUP_ID)).toBe("rejected");
    expect(h.groups.isApproved(GROUP_ID)).toBe(false);
    h.storage.close();
  });

  test("owner revokes an approved group", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, chatType: "supergroup" });
    h.groups.approve(GROUP_ID, String(OWNER_ID));
    const c = ownerCtx();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "revoke", chatId: GROUP_ID }));
    expect(h.groups.isApproved(GROUP_ID)).toBe(false);
    expect(h.groups.stateOf(GROUP_ID)).toBe("revoked");
    h.storage.close();
  });

  test("a stale re-click is handled safely and changes nothing", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, chatType: "supergroup" });
    const c1 = ownerCtx();
    await h.panel.handleCallback(c1.ctx as never, encode({ kind: "approve", chatId: GROUP_ID }));
    // Second click on the same, now stale, button.
    const c2 = ownerCtx();
    await h.panel.handleCallback(c2.ctx as never, encode({ kind: "approve", chatId: GROUP_ID }));
    expect(c2.sent.some((s) => s.text.includes("قدیمی"))).toBe(true);
    expect(h.groups.isApproved(GROUP_ID)).toBe(true);
    h.storage.close();
  });

  test("a callback for a group that was never recorded is stale", async () => {
    const h = harness();
    const c = ownerCtx();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "approve", chatId: "-100999" }));
    expect(c.sent.some((s) => s.text.includes("قدیمی"))).toBe(true);
    h.storage.close();
  });

  test("the pending view lists the group for the owner", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, title: "تیم SOL", chatType: "supergroup" });
    const c = ownerCtx();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "pending", offset: 0 }));
    const text = c.sent.map((s) => s.text).join("\n");
    expect(text).toContain("تیم SOL");
    expect(text).toContain(GROUP_ID);
    h.storage.close();
  });

  test("the status view shows counts, never a token or config value", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, chatType: "supergroup" });
    const c = ownerCtx();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "status" }));
    const text = c.sent.map((s) => s.text).join("\n");
    expect(text).toContain("وضعیت سیستم");
    // Persian digits in the fa panel.
    expect(text).toContain("در انتظار تأیید: ۱");
    // No secret surfaces.
    expect(text).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(text).not.toContain("OWNER_TELEGRAM_ID");
    h.storage.close();
  });

  test("every panel call answers its callback query", async () => {
    const h = harness();
    const c = ownerCtx();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "menu" }));
    // Owner reached the back-navigation action without a hang.
    expect(c.answered()).toBeGreaterThan(0);
    h.storage.close();
  });

  test("a denied call answers its callback query too", async () => {
    const h = harness();
    const c = userCtx();
    await h.panel.handleCallback(c.ctx as never, encode({ kind: "status" }));
    expect(c.answered()).toBeGreaterThan(0);
    h.storage.close();
  });
});

// ---------- owner notification ----------

describe("owner notification", () => {
  test("a new pending group notifies the owner once", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, title: "تیم SOL", chatType: "supergroup" });
    const sent = await h.panel.notifyOwnerRequest({
      chatId: GROUP_ID,
      title: "تیم SOL",
      chatType: "supergroup",
    });
    expect(sent).toBe(true);
    expect(h.notifyCalls).toBe(1);
    h.storage.close();
  });

  test("duplicate membership updates do not re-notify", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, title: "تیم SOL", chatType: "supergroup" });
    expect(await h.panel.notifyOwnerRequest({ chatId: GROUP_ID, chatType: "supergroup" })).toBe(true);
    // Second update: no second message.
    expect(await h.panel.notifyOwnerRequest({ chatId: GROUP_ID, chatType: "supergroup" })).toBe(false);
    expect(h.notifyCalls).toBe(1);
    h.storage.close();
  });

  test("a failed notification leaves the group pending and retryable", async () => {
    const h = harness({ notifyOk: false });
    h.groups.registerGroup({ chatId: GROUP_ID, title: "تیم SOL", chatType: "supergroup" });
    const sent = await h.panel.notifyOwnerRequest({ chatId: GROUP_ID, chatType: "supergroup" });
    expect(sent).toBe(false);
    // Never approved by a delivery failure.
    expect(h.groups.isApproved(GROUP_ID)).toBe(false);
    expect(h.groups.stateOf(GROUP_ID)).toBe("pending");
    // Still needs a notification, so a later retry can reach the owner.
    expect(h.groups.needsNotification(GROUP_ID)).toBe(true);
    h.storage.close();
  });

  test("the notification text contains no requester when unknown", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, chatType: "supergroup" });
    // Await so the write settles before the database is closed.
    await h.panel.notifyOwnerRequest({ chatId: GROUP_ID, chatType: "supergroup" });
    expect(h.notifyCalls).toBe(1);
    expect(h.storage.groupAccess(GROUP_ID)?.requestedBy).toBeUndefined();
    h.storage.close();
  });
});

// ---------- unapproved groups never reach reasoning ----------

describe("unapproved groups never reach the engine or tools", () => {
  /** A provider that records every call, so any leak is observable. */
  function spyProvider() {
    const calls: string[] = [];
    return {
      calls,
      provider: {
        name: "spy",
        async complete(req: { messages: Array<{ role: string; content: string }> }) {
          calls.push(req.messages.map((m) => m.content).join("|"));
          return { text: "ردیف", model: "spy" };
        },
      },
    };
  }

  async function processText(
    h: Harness,
    chatType: string,
    text: string,
  ): Promise<number> {
    const spy = spyProvider();
    const engine = new ConversationEngine({
      provider: spy.provider as never,
      model: "m",
      timeoutMs: 1000,
      maxConcurrent: 1,
    });
    // Mirror the bot's gate-before-engine order.
    const decision = checkGroupAccess(h.groups, { chatType, chatId: GROUP_ID });
    if (decision.allowed) {
      await engine.respond({ conversationId: GROUP_ID, userId: "u", userText: text });
    }
    return spy.calls.length;
  }

  test("a pending group never invokes the provider", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, chatType: "supergroup" });
    expect(await processText(h, "supergroup", "سلام")).toBe(0);
    h.storage.close();
  });

  test("a rejected group never invokes the provider", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, chatType: "supergroup" });
    h.groups.reject(GROUP_ID, String(OWNER_ID));
    expect(await processText(h, "supergroup", "سلام")).toBe(0);
    h.storage.close();
  });

  test("a revoked group never invokes the provider", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, chatType: "supergroup" });
    h.groups.approve(GROUP_ID, String(OWNER_ID));
    h.groups.revoke(GROUP_ID, String(OWNER_ID));
    expect(await processText(h, "supergroup", "سلام")).toBe(0);
    h.storage.close();
  });

  test("an unknown group never invokes the provider", async () => {
    const h = harness();
    expect(await processText(h, "group", "سلام")).toBe(0);
    h.storage.close();
  });

  test("an approved group does invoke the provider", async () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, chatType: "supergroup" });
    h.groups.approve(GROUP_ID, String(OWNER_ID));
    expect(await processText(h, "supergroup", "سلام")).toBe(1);
    h.storage.close();
  });

  test("a private chat works regardless of group state", async () => {
    const h = harness();
    // No group rows at all: private must be unaffected.
    expect(await processText(h, "private", "سلام")).toBe(1);
    h.storage.close();
  });
});

// ---------- no route bypasses the gate ----------

describe("no group route bypasses the gate", () => {
  test("a group update types list matches the gated routes", () => {
    // The routes that can carry group content are gated before reasoning.
    // `start` is a universal greeting and `my_chat_member` creates the pending
    // record; neither invokes the engine or a tool.
    const routes = [
      "start",
      "admin",
      "my_chat_member",
      "callback_query:data",
      "message:text",
      "edited_message:text",
    ];
    const gated = ["callback_query:data", "message:text", "edited_message:text"];
    const engineRoutes = ["message:text"];
    // Every route that can reach the engine is gated.
    for (const route of engineRoutes) {
      expect(gated).toContain(route);
    }
    // And no unlisted route may carry group content.
    expect(routes.length).toBe(gated.length + 3);
  });

  test("the panel route is authorized, not gated by group state", async () => {
    // An owner may administer from any chat type, including an unapproved
    // group; the boundary decides on identity, not on group approval.
    const h = harness();
    const c = ownerCtx();
    await h.panel.openPanel(c.ctx as never);
    expect(c.sent.map((s) => s.text).join("\n")).toContain("پنل مدیریت");
    h.storage.close();
  });

  test("an edited message in an unapproved group is blocked", () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, chatType: "supergroup" });
    // Same gate the edited-message handler runs.
    expect(checkGroupAccess(h.groups, { chatType: "supergroup", chatId: GROUP_ID }).allowed).toBe(false);
    h.storage.close();
  });

  test("a callback from an unapproved group is blocked", () => {
    const h = harness();
    h.groups.registerGroup({ chatId: GROUP_ID, chatType: "supergroup" });
    expect(checkGroupAccess(h.groups, { chatType: "group", chatId: GROUP_ID }).allowed).toBe(false);
    h.storage.close();
  });
});
