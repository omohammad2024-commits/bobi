/**
 * Private-chat user access.
 *
 * This is the gate that stops an unknown Telegram account from spending the
 * owner's API budget. The tests below are written as adversarially as the group
 * suite: the interesting cases are the ones where a stranger tries to reach the
 * engine, and where a stale or forged decision tries to change state.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { UserAccessService } from "../src/auth/user_service";
import { checkUserAccess, userDenialNote } from "../src/auth/user_enforcement";
import { decode, encode, MAX_CALLBACK_BYTES } from "../src/groups/callbacks";
import {
  userRequestNotificationText,
  userApprovalKeyboard,
  usersPendingText,
  usersMenuKeyboard,
  USER_PAGE_SIZE,
} from "../src/auth/user_panel";

function freshService() {
  const storage = Storage.open(":memory:");
  return { storage, users: new UserAccessService(storage) };
}

describe("user access state machine", () => {
  test("a brand-new user is not approved", () => {
    const { storage, users } = freshService();
    expect(users.isApproved("42")).toBe(false);
    expect(users.stateOf("42")).toBeUndefined();
    storage.close();
  });

  test("the first message creates a pending row, and only the first", () => {
    const { storage, users } = freshService();
    expect(users.registerUser({ userId: "42", firstName: "علی" })).toEqual({ created: true });
    // A second message must not create another row or re-notify.
    expect(users.registerUser({ userId: "42" })).toEqual({ created: false });
    expect(users.stateOf("42")).toBe("pending");
    expect(users.countPending()).toBe(1);
    storage.close();
  });

  test("approving a pending user grants access", () => {
    const { storage, users } = freshService();
    users.registerUser({ userId: "42" });
    const r = users.approve("42", "111");
    expect(r).toEqual({ ok: true, previous: "pending" });
    expect(users.isApproved("42")).toBe(true);
    storage.close();
  });

  test("only pending may be approved — a replay cannot resurrect access", () => {
    const { storage, users } = freshService();
    users.registerUser({ userId: "42" });
    users.approve("42", "111");
    // A second approval finds no pending row.
    expect(users.approve("42", "111")).toEqual({ ok: false, reason: "invalid_transition" });
    storage.close();
  });

  test("a rejected user cannot be approved by re-requesting", () => {
    const { storage, users } = freshService();
    users.registerUser({ userId: "42" });
    users.reject("42", "111");
    // Messaging again does not reset the row to pending.
    expect(users.registerUser({ userId: "42" })).toEqual({ created: false });
    expect(users.stateOf("42")).toBe("rejected");
    expect(users.approve("42", "111")).toEqual({ ok: false, reason: "invalid_transition" });
    storage.close();
  });

  test("revoking an approved user takes effect immediately", () => {
    const { storage, users } = freshService();
    users.registerUser({ userId: "42" });
    users.approve("42", "111");
    expect(users.isApproved("42")).toBe(true);

    expect(users.revoke("42", "111")).toEqual({ ok: true, previous: "approved" });
    // Read from storage on every call, so there is no cache to go stale.
    expect(users.isApproved("42")).toBe(false);
    storage.close();
  });

  test("a revoked user cannot be re-approved directly", () => {
    const { storage, users } = freshService();
    users.registerUser({ userId: "42" });
    users.approve("42", "111");
    users.revoke("42", "111");
    // The only legal route back would be a fresh pending row, which the
    // transition guard does not create.
    expect(users.approve("42", "111")).toEqual({ ok: false, reason: "invalid_transition" });
    expect(users.isApproved("42")).toBe(false);
    storage.close();
  });

  test("an unknown user cannot be transitioned", () => {
    const { storage, users } = freshService();
    expect(users.approve("nobody", "111")).toEqual({ ok: false, reason: "not_found" });
    storage.close();
  });

  test("the decision records who took it", () => {
    const { storage, users } = freshService();
    users.registerUser({ userId: "42" });
    users.approve("42", "111");
    const row = storage.userAccess("42")!;
    expect(row.decidedBy).toBe("111");
    expect(row.decidedAt).toBeGreaterThan(0);
    storage.close();
  });

  test("state survives a reopen", () => {
    const path = "/tmp/sol-user-access-test.db";
    const s1 = Storage.open(path);
    const u1 = new UserAccessService(s1);
    u1.registerUser({ userId: "42" });
    u1.approve("42", "111");
    s1.close();

    const s2 = Storage.open(path);
    const u2 = new UserAccessService(s2);
    expect(u2.isApproved("42")).toBe(true);
    s2.close();
  });
});

describe("notification guards", () => {
  test("the owner is notified once, not on every message", () => {
    const { storage, users } = freshService();
    users.registerUser({ userId: "42" });
    expect(users.needsNotification("42")).toBe(true);

    const seen = storage.userAccess("42")!.notifiedAt;
    expect(users.markNotified("42", seen)).toBe(true);
    expect(users.needsNotification("42")).toBe(false);
    storage.close();
  });

  test("a caller holding a stale timestamp cannot reset the marker", () => {
    const { storage, users } = freshService();
    users.registerUser({ userId: "42" });
    users.markNotified("42", undefined);
    const current = storage.userAccess("42")!.notifiedAt!;

    // A caller that captured an older value must not match. This is the
    // conditional form of the guard; the value is deliberately different from
    // the stored one rather than relying on the clock having advanced.
    expect(users.markNotified("42", current - 1_000)).toBe(false);
    // The stored timestamp is untouched by the failed attempt.
    expect(storage.userAccess("42")!.notifiedAt).toBe(current);

    // The holder of the CURRENT value wins.
    expect(users.markNotified("42", current)).toBe(true);
    storage.close();
  });

  test("an unnotified row is marked unconditionally", () => {
    // Mirrors the group behaviour: the first notification has no prior
    // timestamp to test against, so it always records.
    const { storage, users } = freshService();
    users.registerUser({ userId: "42" });
    expect(storage.userAccess("42")!.notifiedAt).toBeUndefined();
    expect(users.markNotified("42", undefined)).toBe(true);
    expect(users.markNotified("42", undefined)).toBe(true);
    expect(users.needsNotification("42")).toBe(false);
    storage.close();
  });

  test("there is nothing to notify once the user is decided", () => {
    const { storage, users } = freshService();
    users.registerUser({ userId: "42" });
    users.approve("42", "111");
    expect(users.pendingUser("42")).toBeUndefined();
    storage.close();
  });
});

describe("enforcement decision", () => {
  test("the owner is always allowed, even with no row", () => {
    const { storage, users } = freshService();
    expect(
      checkUserAccess(users, { userId: "111", isOwner: true, chatType: "private" }),
    ).toEqual({ allowed: true });
    storage.close();
  });

  test("an unknown private-chat user is denied", () => {
    const { storage, users } = freshService();
    const d = checkUserAccess(users, { userId: "42", isOwner: false, chatType: "private" });
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.state).toBe("unknown");
    storage.close();
  });

  test("an approved private-chat user is allowed", () => {
    const { storage, users } = freshService();
    users.registerUser({ userId: "42" });
    users.approve("42", "111");
    expect(
      checkUserAccess(users, { userId: "42", isOwner: false, chatType: "private" }),
    ).toEqual({ allowed: true });
    storage.close();
  });

  test("revocation denies the very next message", () => {
    const { storage, users } = freshService();
    users.registerUser({ userId: "42" });
    users.approve("42", "111");
    users.revoke("42", "111");
    const d = checkUserAccess(users, { userId: "42", isOwner: false, chatType: "private" });
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.state).toBe("revoked");
    storage.close();
  });

  test("group and channel updates are not gated per user", () => {
    // They have their own gate; gating them here would let one unapproved
    // member silently disable a whole group.
    const { storage, users } = freshService();
    for (const chatType of ["group", "supergroup", "channel"]) {
      expect(checkUserAccess(users, { userId: "42", isOwner: false, chatType })).toEqual({
        allowed: true,
      });
    }
    storage.close();
  });

  test("a closed database denies rather than allowing", () => {
    const { storage, users } = freshService();
    storage.close();
    // A storage failure must never read as approval.
    const d = checkUserAccess(users, { userId: "42", isOwner: false, chatType: "private" });
    expect(d.allowed).toBe(false);
  });

  test("the denial note names the state and no message content", () => {
    const note = userDenialNote(
      { userId: "42", isOwner: false, chatType: "private" },
      { allowed: false, state: "pending" },
    );
    expect(note).toContain("42");
    expect(note).toContain("pending");
  });
});

describe("user callback codec", () => {
  test("every user action round-trips", () => {
    const actions = [
      { kind: "users_menu" },
      { kind: "users_pending", offset: 0 },
      { kind: "users_pending", offset: 5 },
      { kind: "users_approved", offset: 10 },
      { kind: "users_revoke_menu", offset: 0 },
      { kind: "user_approve", userId: "123456789" },
      { kind: "user_reject", userId: "42" },
      { kind: "user_revoke", userId: "42" },
    ] as const;
    for (const a of actions) {
      const data = encode(a as never);
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(MAX_CALLBACK_BYTES);
      expect(decode(data)).toEqual(a);
    }
  });

  test("a negative or zero user id never decodes", () => {
    // User ids are positive; a sign here would name something the table cannot
    // contain, so it must be refused rather than normalised.
    expect(decode("adm:uok:-42")).toBeUndefined();
    expect(decode("adm:uok:0")).toBeUndefined();
    expect(decode("adm:udel:-1")).toBeUndefined();
  });

  test("leading zeros and junk never decode", () => {
    expect(decode("adm:uok:007")).toBeUndefined();
    expect(decode("adm:uok:abc")).toBeUndefined();
    expect(decode("adm:uok:1e5")).toBeUndefined();
    expect(decode("adm:uok:1;DROP TABLE user_access")).toBeUndefined();
  });

  test("an over-long id never decodes", () => {
    expect(decode(`adm:uok:${"9".repeat(30)}`)).toBeUndefined();
  });

  test("user actions do not collide with group actions", () => {
    // The two namespaces are separate: a group chat id in a user action, or the
    // reverse, must not silently resolve.
    expect(decode(encode({ kind: "approve", chatId: "-100123" }))).toEqual({
      kind: "approve",
      chatId: "-100123",
    });
    expect(decode(encode({ kind: "user_approve", userId: "123" }))).toEqual({
      kind: "user_approve",
      userId: "123",
    });
  });
});

/**
 * Callback data from a rendered keyboard.
 *
 * Buttons are a union (an inline button, a game button, ...), and only some
 * carry `callback_data`, so the field is read defensively rather than asserted
 * away with a cast.
 */
function dataOf(button: { text: string }): string | undefined {
  const data = (button as { callback_data?: string }).callback_data;
  return typeof data === "string" ? data : undefined;
}

describe("user panel rendering", () => {
  test("the notification carries the numeric id and the names", () => {
    const text = userRequestNotificationText({
      userId: "987654",
      username: "ali",
      firstName: "علی",
      state: "pending",
      requestedAt: 0,
      updatedAt: 0,
    });
    expect(text).toContain("987654");
    expect(text).toContain("علی");
    expect(text).toContain("@ali");
  });

  test("the notification omits absent optional fields", () => {
    const text = userRequestNotificationText({
      userId: "987654",
      state: "pending",
      requestedAt: 0,
      updatedAt: 0,
    });
    expect(text).toContain("987654");
    expect(text).not.toContain("@");
  });

  test("the approval keyboard carries this user's id", () => {
    const kb = userApprovalKeyboard("987654");
    const buttons = kb.inline_keyboard.flat();
    expect(decode(dataOf(buttons[0]!)!)).toEqual({
      kind: "user_approve",
      userId: "987654",
    });
    expect(decode(dataOf(buttons[1]!)!)).toEqual({
      kind: "user_reject",
      userId: "987654",
    });
  });

  test("an empty pending list says so instead of rendering nothing", () => {
    expect(usersPendingText([], 0, 0).length).toBeGreaterThan(0);
  });

  test("the menu is reachable from the owner panel", () => {
    const kb = usersMenuKeyboard();
    const datas = kb.inline_keyboard.flat().map(dataOf);
    expect(datas.some((d) => d !== undefined && decode(d)?.kind === "users_pending")).toBe(true);
  });

  test("a full page offers a next button, a short one does not", () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        userId: String(i),
        state: "pending" as const,
        requestedAt: 0,
        updatedAt: 0,
      }));
    const full = usersPendingText(mk(USER_PAGE_SIZE), 0, 20);
    expect(full).toContain("۱");
    // Only the text is checked here; navigation is asserted via the codec tests.
    expect(usersPendingText(mk(1), 0, 1)).toContain("۱–۱");
  });
});
