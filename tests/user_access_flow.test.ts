/**
 * The two-tier access flow end to end, through the real controllers.
 *
 * Public chat is OPEN: a stranger is allowed immediately, no pending row, no
 * owner notification. The owner's persisted controls are ban (polite refusal)
 * and mute (silent drop), both effective on the very next message. The unit
 * suite proves the state machine; this proves the integration.
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

describe("public chat is open — no approval queue", () => {
  test("a stranger is allowed on first contact; nothing is recorded, nobody is notified", async () => {
    const h = harness();
    const stranger = { userId: String(STRANGER_ID), isOwner: false, chatType: "private" };

    // Allowed immediately — the gate no longer needs a row.
    expect(checkUserAccess(h.users, stranger)).toEqual({ allowed: true });
    expect(h.users.stateOf(stranger.userId)).toBeUndefined();
    expect(h.notifications).toHaveLength(0);

    h.storage.close();
  });

  test("the owner bans, and the stranger is refused from the next message", async () => {
    const h = harness();
    const userId = String(STRANGER_ID);
    const subject = { userId, isOwner: false, chatType: "private" };
    expect(checkUserAccess(h.users, subject).allowed).toBe(true);

    expect(h.users.ban(userId, String(OWNER_ID)).ok).toBe(true);
    const d = checkUserAccess(h.users, subject);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.state).toBe("rejected");

    h.storage.close();
  });

  test("the owner mutes, and the stranger's messages are silently dropped", async () => {
    const h = harness();
    const userId = String(STRANGER_ID);
    const subject = { userId, isOwner: false, chatType: "private" };

    expect(h.users.mute(userId, String(OWNER_ID)).ok).toBe(true);
    const d = checkUserAccess(h.users, subject);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.state).toBe("revoked");

    // Unmute restores open chat.
    expect(h.users.unmute(userId, String(OWNER_ID)).ok).toBe(true);
    expect(checkUserAccess(h.users, subject)).toEqual({ allowed: true });

    h.storage.close();
  });

  test("unban restores open chat", async () => {
    const h = harness();
    const userId = String(STRANGER_ID);
    const subject = { userId, isOwner: false, chatType: "private" };
    h.users.ban(userId, String(OWNER_ID));
    expect(checkUserAccess(h.users, subject).allowed).toBe(false);

    expect(h.users.unban(userId, String(OWNER_ID)).ok).toBe(true);
    expect(checkUserAccess(h.users, subject)).toEqual({ allowed: true });

    h.storage.close();
  });

  test("ban/mute are idempotent — a double ban is not an error", async () => {
    const h = harness();
    const userId = String(STRANGER_ID);
    expect(h.users.ban(userId, String(OWNER_ID))).toEqual({ ok: true, previous: "pending" });
    expect(h.users.ban(userId, String(OWNER_ID))).toEqual({ ok: true, previous: "rejected" });
    expect(h.users.mute(userId, String(OWNER_ID))).toEqual({ ok: true, previous: "rejected" });
    expect(h.users.mute(userId, String(OWNER_ID))).toEqual({ ok: true, previous: "revoked" });
    h.storage.close();
  });

  test("legacy approve/reject panel actions still work on existing rows", async () => {
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

  test("legacy reject marks the row banned", async () => {
    const h = harness();
    const userId = String(STRANGER_ID);
    h.users.registerUser({ userId });

    await click(h.panel, { id: OWNER_ID }, encode({ kind: "user_reject", userId }));

    expect(h.users.isApproved(userId)).toBe(false);
    const d = checkUserAccess(h.users, { userId, isOwner: false, chatType: "private" });
    expect(d.allowed === false && d.state).toBe("rejected");

    h.storage.close();
  });

  test("revoking an approved user mutes them immediately", async () => {
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
  test("the tools a user is offered follow from their permissions, not their ban state", () => {
    // The registration table is the only thing that grants tool permission.
    // The user gate (ban/mute) decides whether they reach the engine AT ALL;
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
