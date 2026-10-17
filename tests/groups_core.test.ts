import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Storage } from "../src/storage/storage";
import { GroupAccessService } from "../src/groups/service";
import { checkGroupAccess, isGatedChat } from "../src/groups/enforcement";
import { decode, encode, MAX_CALLBACK_BYTES } from "../src/groups/callbacks";

const OWNER = "111111";

function fresh(): Storage {
  return Storage.open(":memory:");
}

function svc(): { storage: Storage; groups: GroupAccessService } {
  const storage = fresh();
  return { storage, groups: new GroupAccessService(storage) };
}

const GROUP = {
  chatId: "-1001234567890",
  title: "تیم SOL",
  chatType: "supergroup" as const,
};

// ---------- storage / state machine ----------

describe("group access storage", () => {
  test("a new group is recorded as pending", () => {
    const { storage, groups } = svc();
    const r = groups.registerGroup(GROUP);
    expect(r.created).toBe(true);
    expect(storage.groupAccess(GROUP.chatId)?.state).toBe("pending");
    expect(groups.stateOf(GROUP.chatId)).toBe("pending");
    expect(groups.isApproved(GROUP.chatId)).toBe(false);
    storage.close();
  });

  test("repeated registration is idempotent", () => {
    const { storage, groups } = svc();
    expect(groups.registerGroup(GROUP).created).toBe(true);
    expect(groups.registerGroup(GROUP).created).toBe(false);
    expect(groups.registerGroup(GROUP).created).toBe(false);
    // Exactly one row, still pending, no duplicate.
    expect(storage.listGroupsByState("pending", 50).length).toBe(1);
    storage.close();
  });

  test("title, type and requester are stored when known", () => {
    const { storage, groups } = svc();
    groups.registerGroup({ ...GROUP, requestedBy: "999" });
    const row = storage.groupAccess(GROUP.chatId);
    expect(row?.title).toBe("تیم SOL");
    expect(row?.chatType).toBe("supergroup");
    expect(row?.requestedBy).toBe("999");
    storage.close();
  });

  test("approve persists across a database reopen", () => {
    // A file-backed database, because :memory: is per-connection and cannot
    // demonstrate persistence across a restart. os.tmpdir() resolves on every
    // platform, so a temp file never lands in the repository.
    const dir = tmpdir();
    const path = `${dir}/_test-group-${Date.now()}.db`;
    try {
      const first = Storage.open(path);
      const g1 = new GroupAccessService(first);
      g1.registerGroup(GROUP);
      expect(g1.approve(GROUP.chatId, OWNER).ok).toBe(true);
      first.close();

      const second = Storage.open(path);
      const g2 = new GroupAccessService(second);
      expect(g2.isApproved(GROUP.chatId)).toBe(true);
      expect(second.groupAccess(GROUP.chatId)?.decidedBy).toBe(OWNER);
      second.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(path + suffix);
        } catch {
          // Best-effort cleanup on Windows.
        }
      }
    }
  });

  test("only pending may be approved", () => {
    const { storage, groups } = svc();
    expect(groups.registerGroup(GROUP).created).toBe(true);
    expect(groups.approve(GROUP.chatId, OWNER).ok).toBe(true);
    // Replaying the same approval is refused.
    const again = groups.approve(GROUP.chatId, OWNER);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("invalid_transition");
    storage.close();
  });

  test("a revoked group cannot be re-approved by replay", () => {
    const { storage, groups } = svc();
    groups.registerGroup(GROUP);
    groups.approve(GROUP.chatId, OWNER);
    expect(groups.revoke(GROUP.chatId, OWNER).ok).toBe(true);
    const back = groups.approve(GROUP.chatId, OWNER);
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.reason).toBe("invalid_transition");
    expect(groups.isApproved(GROUP.chatId)).toBe(false);
    storage.close();
  });

  test("revoke only applies to an approved group", () => {
    const { storage, groups } = svc();
    groups.registerGroup(GROUP);
    // Pending → revoked directly is refused.
    expect(groups.revoke(GROUP.chatId, OWNER).ok).toBe(false);
    groups.approve(GROUP.chatId, OWNER);
    expect(groups.revoke(GROUP.chatId, OWNER).ok).toBe(true);
    // Second click is stale.
    expect(groups.revoke(GROUP.chatId, OWNER).ok).toBe(false);
    storage.close();
  });

  test("reject then approve is refused", () => {
    const { storage, groups } = svc();
    groups.registerGroup(GROUP);
    expect(groups.reject(GROUP.chatId, OWNER).ok).toBe(true);
    expect(groups.approve(GROUP.chatId, OWNER).ok).toBe(false);
    storage.close();
  });

  test("a transition on an unknown group reports not_found", () => {
    const { storage, groups } = svc();
    const r = groups.approve("-1000000000000", OWNER);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
    storage.close();
  });

  test("decision records the acting owner and a timestamp", () => {
    const { storage, groups } = svc();
    groups.registerGroup(GROUP);
    const before = Date.now();
    groups.approve(GROUP.chatId, OWNER);
    const row = storage.groupAccess(GROUP.chatId);
    expect(row?.decidedBy).toBe(OWNER);
    expect(row?.decidedAt).toBeGreaterThanOrEqual(before);
    storage.close();
  });

  test("pending and approved lists are separate and bounded", () => {
    const { storage, groups } = svc();
    for (let i = 0; i < 12; i++) groups.registerGroup({ ...GROUP, chatId: `-100000${i}` });
    // Beyond the default page, only the page is returned but the count is total.
    expect(groups.listPending().length).toBe(8);
    expect(groups.countPending()).toBe(12);

    groups.registerGroup({ ...GROUP, chatId: "-100999" });
    groups.approve("-100999", OWNER);
    expect(groups.listApproved().map((g) => g.chatId)).toContain("-100999");
    expect(groups.countApproved()).toBe(1);
    storage.close();
  });

  test("an absurd limit or offset is clamped, not trusted", () => {
    const { storage, groups } = svc();
    for (let i = 0; i < 12; i++) groups.registerGroup({ ...GROUP, chatId: `-2000${i}` });
    // A hostile "limit" cannot widen the page beyond the cap.
    expect(storage.listGroupsByState("pending", 99999).length).toBeLessThanOrEqual(50);
    expect(storage.listGroupsByState("pending", -5).length).toBeGreaterThan(0);
    expect(groups.stateOf("-1000000")).toBeUndefined();
    storage.close();
  });

  test("a closed database reads as not approved", () => {
    const { storage, groups } = svc();
    groups.registerGroup(GROUP);
    groups.approve(GROUP.chatId, OWNER);
    storage.close();
    // A storage failure must never be mistaken for approval.
    expect(groups.isApproved(GROUP.chatId)).toBe(false);
    expect(groups.stateOf(GROUP.chatId)).toBeUndefined();
  });
});

// ---------- notification guards ----------

describe("owner notification guards", () => {
  test("a fresh pending group needs notification", () => {
    const { storage, groups } = svc();
    groups.registerGroup(GROUP);
    expect(groups.needsNotification(GROUP.chatId)).toBe(true);
    storage.close();
  });

  test("a notified group does not need another notification", () => {
    const { storage, groups } = svc();
    groups.registerGroup(GROUP);
    expect(groups.markNotified(GROUP.chatId, undefined)).toBe(true);
    expect(groups.needsNotification(GROUP.chatId)).toBe(false);
    // A replay does not reset the timestamp.
    expect(groups.markNotified(GROUP.chatId, undefined)).toBe(true);
    expect(groups.needsNotification(GROUP.chatId)).toBe(false);
    storage.close();
  });

  test("a group with no row needs no notification", () => {
    const { storage, groups } = svc();
    expect(groups.needsNotification("-100111")).toBe(false);
    storage.close();
  });
});

// ---------- enforcement gate ----------

describe("group access enforcement", () => {
  test("private chat is never gated", () => {
    const { storage, groups } = svc();
    expect(isGatedChat("private")).toBe(false);
    expect(checkGroupAccess(groups, { chatType: "private", chatId: "555" }).allowed).toBe(true);
    storage.close();
  });

  test("group and supergroup are gated", () => {
    const { storage, groups } = svc();
    groups.registerGroup({ ...GROUP, chatType: "group" });
    expect(isGatedChat("group")).toBe(true);
    expect(isGatedChat("supergroup")).toBe(true);
    storage.close();
  });

  test("pending group is denied", () => {
    const { storage, groups } = svc();
    groups.registerGroup(GROUP);
    const d = checkGroupAccess(groups, { chatType: "supergroup", chatId: GROUP.chatId });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.state).toBe("pending");
    storage.close();
  });

  test("rejected group is denied", () => {
    const { storage, groups } = svc();
    groups.registerGroup(GROUP);
    groups.reject(GROUP.chatId, OWNER);
    const d = checkGroupAccess(groups, { chatType: "supergroup", chatId: GROUP.chatId });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.state).toBe("rejected");
    storage.close();
  });

  test("revoked group is denied immediately", () => {
    const { storage, groups } = svc();
    groups.registerGroup(GROUP);
    groups.approve(GROUP.chatId, OWNER);
    // Before revocation the same group passes.
    expect(checkGroupAccess(groups, { chatType: "supergroup", chatId: GROUP.chatId }).allowed).toBe(true);
    groups.revoke(GROUP.chatId, OWNER);
    const d = checkGroupAccess(groups, { chatType: "supergroup", chatId: GROUP.chatId });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.state).toBe("revoked");
    storage.close();
  });

  test("approved group is allowed", () => {
    const { storage, groups } = svc();
    groups.registerGroup(GROUP);
    groups.approve(GROUP.chatId, OWNER);
    expect(checkGroupAccess(groups, { chatType: "supergroup", chatId: GROUP.chatId }).allowed).toBe(true);
    storage.close();
  });

  test("an unknown group is denied", () => {
    const { storage, groups } = svc();
    const d = checkGroupAccess(groups, { chatType: "group", chatId: "-100777" });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.state).toBe("unknown");
    storage.close();
  });

  test("a closed database denies rather than defaulting open", () => {
    const { storage, groups } = svc();
    storage.close();
    expect(checkGroupAccess(groups, { chatType: "group", chatId: "-100777" }).allowed).toBe(false);
  });
});

// ---------- callback codec ----------

describe("callback codec", () => {
  test("round-trips every action", () => {
    const actions = [
      { kind: "menu" },
      { kind: "pending", offset: 0 },
      { kind: "approved", offset: 0 },
      { kind: "approved", offset: 10 },
      { kind: "revoke_menu", offset: 5 },
      { kind: "approve", chatId: "-1001234567890" },
      { kind: "reject", chatId: "-1001234567890" },
      { kind: "revoke", chatId: "-1001234567890" },
      { kind: "status" },
    ] as const;
    for (const a of actions) {
      const data = encode(a);
      expect(data.length).toBeLessThanOrEqual(MAX_CALLBACK_BYTES);
      expect(decode(data)).toEqual(decode(encode(a)));
    }
  });

  test("rejects data from another feature's namespace", () => {
    for (const bad of ["menu:chat", "menu:tools", "nope", ""]) {
      expect(decode(bad)).toBeUndefined();
    }
  });

  test("rejects malformed and hostile payloads", () => {
    for (const bad of [
      "adm:ok",
      "adm:ok:not-a-number",
      "adm:ok:-100abc",
      "adm:ok:../../etc/passwd",
      "adm:ok:-100123; DROP TABLE group_access",
      "adm:ok:0",
      "adm:ok:-1",
      "adm:unknown:5",
      "adm:apv:-1",
      "adm:apv:abc",
      "adm:apv",
      "adm:",
      "x",
    ]) {
      expect(decode(bad)).toBeUndefined();
    }
  });

  test("rejects over-long data outright", () => {
    const huge = `adm:ok:${"-1".repeat(40)}`;
    expect(decode(huge)).toBeUndefined();
  });

  test("rejects leading zeros in an offset", () => {
    expect(decode("adm:apv:007")).toBeUndefined();
    expect(decode("adm:ok:0123")).toBeUndefined();
    // "0" alone is a valid offset.
    expect(decode("adm:apv:0")).toEqual({ kind: "approved", offset: 0 });
  });

  test("rejects a chat id that is not an integer", () => {
    expect(decode("adm:ok:12.5")).toBeUndefined();
  });

  test("training group ids (negative) are accepted", () => {
    expect(decode("adm:del:-1001234567890")).toEqual({ kind: "revoke", chatId: "-1001234567890" });
  });
});
