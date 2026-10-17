import { describe, expect, test } from "bun:test";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";
import {
  can,
  permissionsForRole,
  roleOf,
  requirePermission,
  AuthorizationDenied,
  ALL_PERMISSIONS,
} from "../src/auth/roles";
import { authorizeToolUse, toToolActor } from "../src/auth/tool_bridge";

const OWNER_ID = 111111;

/**
 * Build a service, with no owner configured unless one is given explicitly.
 *
 * Note: a default parameter cannot be used here — JS substitutes the default
 * for `undefined`, which would silently turn "no owner" into a real owner.
 */
function makeAuth(ownerId?: number): AuthorizationService {
  const identity =
    ownerId === undefined ? OwnerIdentity.none() : OwnerIdentity.fromNumber(ownerId);
  return new AuthorizationService(identity);
}

const owner = { id: OWNER_ID, label: "owner" };
const ordinary = { id: 222222, label: "user" };
const other = { id: 333333, label: "other" };

// ---------- roles & permissions ----------

describe("roles and permissions", () => {
  test("owner holds every permission", () => {
    expect([...permissionsForRole("owner")].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  test("ordinary user holds only tools.use", () => {
    expect(permissionsForRole("user")).toEqual(["tools.use"]);
  });

  test("unknown role holds nothing", () => {
    expect(permissionsForRole("unknown")).toEqual([]);
  });
});

// ---------- central checks ----------

describe("AuthorizationService", () => {
  test("recognizes the owner by numeric id", () => {
    const auth = makeAuth(OWNER_ID);
    expect(auth.isOwner(owner)).toBe(true);
    expect(auth.isOwner(ordinary)).toBe(false);
  });

  test("owner cannot be spoofed by a different id", () => {
    const auth = makeAuth(OWNER_ID);
    expect(auth.isOwner(other)).toBe(false);
    expect(auth.roleFor(other)).toBe("user");
  });

  test("with no configured owner, nobody gains owner privileges", () => {
    const auth = makeAuth(undefined);
    expect(auth.isOwner(owner)).toBe(false);
    // Falls back to the ordinary role, never to owner.
    expect(auth.roleFor(owner)).toBe("user");
    expect(auth.can(owner, "settings.manage")).toBe(false);
    expect(auth.can(owner, "admin.view")).toBe(false);
    expect(auth.can(owner, "tools.use")).toBe(true);
  });

  test("permissions resolve by role", () => {
    const auth = makeAuth(OWNER_ID);
    expect(auth.can(owner, "settings.manage")).toBe(true);
    expect(auth.can(owner, "users.manage")).toBe(true);
    expect(auth.can(owner, "groups.review")).toBe(true);
    expect(auth.can(owner, "admin.view")).toBe(true);
    expect(auth.can(owner, "tools.use")).toBe(true);
  });

  test("an ordinary user cannot reach admin permissions", () => {
    const auth = makeAuth(OWNER_ID);
    for (const perm of ["settings.manage", "users.manage", "groups.review", "admin.view"] as const) {
      expect(auth.can(ordinary, perm)).toBe(false);
    }
  });

  test("an ordinary user keeps tools.use", () => {
    const auth = makeAuth(OWNER_ID);
    expect(auth.can(ordinary, "tools.use")).toBe(true);
  });

  test("no identity means no access", () => {
    const auth = makeAuth(OWNER_ID);
    expect(auth.can(undefined, "tools.use")).toBe(false);
    expect(auth.can(undefined, "settings.manage")).toBe(false);
    expect(auth.roleFor(undefined)).toBe("unknown");
  });

  test("an invalid numeric id yields no actor", () => {
    const auth = makeAuth(OWNER_ID);
    expect(auth.actorFrom({ id: undefined })).toBeUndefined();
    expect(auth.actorFrom({ id: 0 })).toBeUndefined();
    expect(auth.actorFrom({ id: -5 })).toBeUndefined();
    expect(auth.actorFrom({ id: 1.5 })).toBeUndefined();
    expect(auth.actorFrom({ id: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(auth.actorFrom({ id: 42 })?.id).toBe(42);
  });

  test("actorFromTelegramUser reads only the trusted id field", () => {
    const auth = makeAuth(OWNER_ID);
    expect(auth.actorFromTelegramUser({ id: OWNER_ID })?.id).toBe(OWNER_ID);
    expect(auth.actorFromTelegramUser({ id: 222222 })?.id).toBe(222222);
    // A username alone yields no identity at all.
    expect(auth.actorFromTelegramUser({ username: "realowner" })).toBeUndefined();
    expect(auth.actorFromTelegramUser(undefined)).toBeUndefined();
    // Username present alongside a real id is a label, not the identity.
    expect(auth.actorFromTelegramUser({ id: 222222, username: "realowner" })?.id).toBe(222222);
  });

  test("the label never affects authorization", () => {
    const auth = makeAuth(OWNER_ID);
    const spoof = auth.actorFrom({ id: 222222, label: "owner" });
    expect(auth.isOwner(spoof)).toBe(false);
    expect(auth.can(spoof, "settings.manage")).toBe(false);
  });

  test("recognizes known permission strings only", () => {
    const auth = makeAuth(OWNER_ID);
    expect(auth.isKnownPermission("tools.use")).toBe(true);
    expect(auth.isKnownPermission("admin.view")).toBe(true);
    expect(auth.isKnownPermission("everything")).toBe(false);
    expect(auth.isKnownPermission("")).toBe(false);
  });
});

// ---------- deny-by-default at execution time ----------

describe("permission is checked at execution time", () => {
  test("can() reflects the current policy on every call", () => {
    const auth = makeAuth(OWNER_ID);
    expect(can(auth, ordinary, "settings.manage")).toBe(false);
    // Even repeated checks never become true on their own.
    expect(can(auth, ordinary, "settings.manage")).toBe(false);
  });

  test("requirePermission throws for a denied actor", () => {
    const auth = makeAuth(OWNER_ID);
    expect(() => requirePermission(auth, ordinary, "settings.manage")).toThrow(
      AuthorizationDenied,
    );
  });

  test("requirePermission succeeds for the owner", () => {
    const auth = makeAuth(OWNER_ID);
    expect(() => requirePermission(auth, owner, "settings.manage")).not.toThrow();
  });
});

// ---------- integration with the tool system ----------

describe("authorizeToolUse", () => {
  const fakeTools = [
    {
      name: "t1",
      description: "d",
      enabled: true,
      permission: { requires: ["tools:t1"] },
      input: { fields: {} },
      async run() { return "x"; },
    },
    {
      name: "t2",
      description: "d",
      enabled: true,
      permission: { requires: ["tools:t2"] },
      input: { fields: {} },
      async run() { return "y"; },
    },
    {
      name: "off",
      description: "d",
      enabled: false,
      permission: { requires: ["tools:off"] },
      input: { fields: {} },
      async run() { return "z"; },
    },
  ] as unknown as ReadonlyArray<import("../src/tools/types").Tool<unknown, unknown>>;

  test("an authorized user gets the enabled tools' permission keys", () => {
    const auth = makeAuth(OWNER_ID);
    const result = authorizeToolUse(auth, ordinary, fakeTools);
    expect(result.allowed).toBe(true);
    expect(result.permissions).toEqual(["tools:t1", "tools:t2"]);
  });

  test("no identity yields no permissions", () => {
    const auth = makeAuth(OWNER_ID);
    const result = authorizeToolUse(auth, undefined, fakeTools);
    expect(result.allowed).toBe(false);
    expect(result.permissions).toEqual([]);
  });

  test("the owner also gets tools", () => {
    const auth = makeAuth(OWNER_ID);
    expect(authorizeToolUse(auth, owner, fakeTools).allowed).toBe(true);
  });

  test("toToolActor carries the derived grants and the numeric id", () => {
    const auth = makeAuth(OWNER_ID);
    const actor = toToolActor(authorizeToolUse(auth, ordinary, fakeTools));
    expect(actor.userId).toBe("222222");
    expect(actor.permissions).toEqual(["tools:t1", "tools:t2"]);
  });

  test("an unauthorized actor gets an empty permission list", () => {
    const auth = makeAuth(OWNER_ID);
    const actor = toToolActor(authorizeToolUse(auth, undefined, fakeTools));
    expect(actor.permissions).toEqual([]);
    expect(actor.userId).toBe("unknown");
  });
});
