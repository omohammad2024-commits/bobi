/**
 * The user-approval workflow end to end, through the real controllers.
 *
 * The unit suite proves the state machine. This proves the integration the bot
 * actually performs: an unknown account's first message creates a pending row
 * and notifies the owner, the owner's decision is authorized and audited, and
 * the account's access changes accordingly — with no path that lets a stranger
 * reach the engine or run a tool.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";
import { AdminBoundary } from "../src/auth/admin_boundary";
import { AuditLogger } from "../src/auth/audit";
import { UserAccessService } from "../src/auth/user_service";
import { UserPanelController } from "../src/auth/user_controller";
import { checkUserAccess } from "../src/auth/user_enforcement";
import { decode, encode } from "../src/groups/callbacks";
import { ToolService } from "../src/tools/service";
import { authorizeToolUse, toToolActor } from "../src/auth/tool_bridge";

const OWNER_ID = 111111;
const STRANGER_ID = 222222;

/** A fake ctx that records what the bot would send. */
function fakeCtx(from: { id: number; username?: string; first_name?: string } | undefined) {
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

/** Drive a callback through the controller as if a button was pressed. */
async function click(
  panel: UserPanelController,
  from: { id: number },
  data: string,
) {
  const f = fakeCtx(from);
  const handled = await panel.handleCallback(f.ctx as never, data);
  return { handled, sent: f.sent };
}

function harness() {
  const storage = Storage.open(":memory:");
  const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER_ID));
  const audit = new AuditLogger({ storage });
  const admin = new AdminBoundary({ auth, audit });
  const users = new UserAccessService(storage);
  const notifications: Array<{ chatId: string; text: string }> = [];
  const panel = new UserPanelController({
    auth,
    admin,
    users,
    notify: async (chatId, text) => {
      notifications.push({ chatId, text });
      return true;
    },
  });
  return { storage, auth, admin, users, panel, notifications, audit };
}

describe("unknown account → owner approval", () => {
  test("first contact creates a pending row and notifies the owner once", async () => {
    const h = harness();
    const stranger = { userId: String(STRANGER_ID), isOwner: false, chatType: "private" };

    // Before anything, the stranger is denied.
    expect(checkUserAccess(h.users, stranger).allowed).toBe(false);

    // The bot records the request (this is what gateUser does on first contact).
    expect(h.users.registerUser({ userId: stranger.userId, firstName: "مهمان" }).created).toBe(true);
    expect(await h.panel.notifyOwnerRequest({ userId: stranger.userId })).toBe(true);

    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]!.chatId).toBe(String(OWNER_ID));
    expect(h.notifications[0]!.text).toContain(stranger.userId);

    // Still denied until the owner actually decides.
    expect(checkUserAccess(h.users, stranger).allowed).toBe(false);

    h.storage.close();
  });

  test("a second message does not notify the owner again", async () => {
    const h = harness();
    const userId = String(STRANGER_ID);
    h.users.registerUser({ userId });
    await h.panel.notifyOwnerRequest({ userId });

    // The same account messages again: no new row, no second notification.
    expect(h.users.registerUser({ userId }).created).toBe(false);
    expect(await h.panel.notifyOwnerRequest({ userId })).toBe(false);
    expect(h.notifications).toHaveLength(1);

    h.storage.close();
  });

  test("a failed notification leaves the user pending and retries later", async () => {
    const storage = Storage.open(":memory:");
    const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER_ID));
    const admin = new AdminBoundary({ auth, audit: new AuditLogger({ storage }) });
    const users = new UserAccessService(storage);
    let sendOk = false;
    let attempts = 0;
    const panel = new UserPanelController({
      auth,
      admin,
      users,
      notify: async () => {
        attempts++;
        return sendOk;
      },
    });

    const userId = String(STRANGER_ID);
    users.registerUser({ userId });

    // A delivery failure must never be read as an approval.
    expect(await panel.notifyOwnerRequest({ userId })).toBe(false);
    expect(users.isApproved(userId)).toBe(false);
    expect(users.stateOf(userId)).toBe("pending");
    // ...and the row stays unnotified, so a later attempt retries.
    expect(users.needsNotification(userId)).toBe(true);

    sendOk = true;
    expect(await panel.notifyOwnerRequest({ userId })).toBe(true);
    expect(attempts).toBe(2);
    // Once delivered, it is not sent again.
    expect(await panel.notifyOwnerRequest({ userId })).toBe(false);

    storage.close();
  });

  test("the owner approves, and access is granted", async () => {
    const h = harness();
    const userId = String(STRANGER_ID);
    h.users.registerUser({ userId });

    const { handled, sent } = await click(
      h.panel,
      { id: OWNER_ID },
      encode({ kind: "user_approve", userId }),
    );
    expect(handled).toBe(true);
    expect(sent[0]!.text).toContain("تأیید");

    expect(h.users.isApproved(userId)).toBe(true);
    expect(checkUserAccess(h.users, { userId, isOwner: false, chatType: "private" })).toEqual({
      allowed: true,
    });

    h.storage.close();
  });

  test("the owner rejects, and access stays closed", async () => {
    const h = harness();
    const userId = String(STRANGER_ID);
    h.users.registerUser({ userId });

    await click(h.panel, { id: OWNER_ID }, encode({ kind: "user_reject", userId }));

    expect(h.users.isApproved(userId)).toBe(false);
    const d = checkUserAccess(h.users, { userId, isOwner: false, chatType: "private" });
    expect(d.allowed === false && d.state).toBe("rejected");

    h.storage.close();
  });

  test("revoking an approved user closes access immediately", async () => {
    const h = harness();
    const userId = String(STRANGER_ID);
    h.users.registerUser({ userId });
    await click(h.panel, { id: OWNER_ID }, encode({ kind: "user_approve", userId }));
    expect(h.users.isApproved(userId)).toBe(true);

    await click(h.panel, { id: OWNER_ID }, encode({ kind: "user_revoke", userId }));
    expect(h.users.isApproved(userId)).toBe(false);
    const d = checkUserAccess(h.users, { userId, isOwner: false, chatType: "private" });
    expect(d.allowed === false && d.state).toBe("revoked");

    h.storage.close();
  });
});

describe("only the owner may decide", () => {
  test("a stranger cannot approve themselves", async () => {
    const h = harness();
    const userId = String(STRANGER_ID);
    h.users.registerUser({ userId });

    const { sent } = await click(
      h.panel,
      { id: STRANGER_ID },
      encode({ kind: "user_approve", userId }),
    );

    // The handler never ran; the stranger was told nothing useful.
    expect(h.users.isApproved(userId)).toBe(false);
    expect(sent[0]!.text).toContain("فقط برای مالک");

    h.storage.close();
  });

  test("a stranger cannot read the user list", async () => {
    const h = harness();
    h.users.registerUser({ userId: String(STRANGER_ID) });

    const { sent } = await click(h.panel, { id: STRANGER_ID }, encode({ kind: "users_pending", offset: 0 }));
    expect(sent[0]!.text).toContain("فقط برای مالک");

    h.storage.close();
  });

  test("an update with no identity cannot act", async () => {
    const h = harness();
    const userId = String(STRANGER_ID);
    h.users.registerUser({ userId });

    const { sent } = await click(h.panel, undefined as never, encode({ kind: "user_approve", userId }));
    expect(h.users.isApproved(userId)).toBe(false);
    expect(sent[0]!.text).toContain("فقط برای مالک");

    h.storage.close();
  });

  test("denied decisions are audited", async () => {
    const h = harness();
    const userId = String(STRANGER_ID);
    h.users.registerUser({ userId });

    await click(h.panel, { id: STRANGER_ID }, encode({ kind: "user_approve", userId }));

    const events = h.storage.auditEvents(20);
    const denied = events.find((e) => e.operation === "user.approve");
    expect(denied?.outcome).toBe("denied");
    expect(denied?.actorId).toBe(String(STRANGER_ID));

    h.storage.close();
  });

  test("a successful decision is audited with the target", async () => {
    const h = harness();
    const userId = String(STRANGER_ID);
    h.users.registerUser({ userId });

    await click(h.panel, { id: OWNER_ID }, encode({ kind: "user_approve", userId }));

    const events = h.storage.auditEvents(20);
    const done = events.find((e) => e.operation === "user.approve");
    expect(done?.outcome).toBe("success");
    expect(done?.targetId).toBe(userId);

    h.storage.close();
  });

  test("user callbacks are claimed, group callbacks are not", async () => {
    const h = harness();
    // A group action must fall through to the group panel.
    const group = await click(h.panel, { id: OWNER_ID }, encode({ kind: "pending", offset: 0 }));
    expect(group.handled).toBe(false);

    const users = await click(h.panel, { id: OWNER_ID }, encode({ kind: "users_menu" }));
    expect(users.handled).toBe(true);

    h.storage.close();
  });

  test("foreign callback data is ignored", async () => {
    const h = harness();
    for (const junk of ["", "nope", "adm:zzz", "menu:chat"]) {
      const r = await click(h.panel, { id: OWNER_ID }, junk);
      expect(r.handled).toBe(false);
    }
    h.storage.close();
  });
});

describe("access gates tool use", () => {
  test("the tools a user is offered follow from their permissions, not their approval", () => {
    // The registration table is the only thing that grants tool permission.
    // The user-approval gate decides whether they reach the engine AT ALL;
    // this checks the second, narrower layer still behaves.
    const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER_ID));
    const tools = new ToolService();

    const ownerActor = toToolActor(
      authorizeToolUse(auth, auth.actorFrom({ id: OWNER_ID }), tools.registry.list()),
    );
    expect(tools.toolSpecsFor(ownerActor).length).toBeGreaterThan(0);

    // No identity: nothing offered, nothing runnable.
    const anon = toToolActor(authorizeToolUse(auth, undefined, tools.registry.list()));
    expect(tools.toolSpecsFor(anon)).toEqual([]);
  });
});

describe("callback codec round trip through the controller", () => {
  test("every user list page survives encode → decode", async () => {
    const h = harness();
    for (const action of [
      { kind: "users_menu" },
      { kind: "users_pending", offset: 0 },
      { kind: "users_approved", offset: 5 },
      { kind: "users_revoke_menu", offset: 15 },
    ] as const) {
      const data = encode(action as never);
      expect(decode(data)).toEqual(action);
      const r = await click(h.panel, { id: OWNER_ID }, data);
      expect(r.handled).toBe(true);
    }
    h.storage.close();
  });
});
