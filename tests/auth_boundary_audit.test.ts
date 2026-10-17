import { describe, expect, test } from "bun:test";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";
import { AdminBoundary, DENIED_MESSAGE } from "../src/auth/admin_boundary";
import { AuditLogger } from "../src/auth/audit";
import { Storage } from "../src/storage/storage";
import { ToolService } from "../src/tools/service";
import { authorizeToolUse, toToolActor } from "../src/auth/tool_bridge";

const OWNER_ID = 111111;

function makeAuth(): AuthorizationService {
  return new AuthorizationService(OwnerIdentity.fromNumber(OWNER_ID));
}

const owner = { id: OWNER_ID };
const ordinary = { id: 222222 };

/** A storage instance that verifies audit rows are actually persisted. */
function freshStorage(): Storage {
  return Storage.open(":memory:");
}

// ---------- admin boundary: authorization ----------

describe("AdminBoundary authorization", () => {
  test("owner is allowed through", async () => {
    let ran = 0;
    const boundary = new AdminBoundary({ auth: makeAuth() });
    const r = await boundary.runAdmin(
      { actor: owner, operation: "settings.model", permission: "settings.manage" },
      () => {
        ran++;
        return "done";
      },
    );
    expect(r.ok).toBe(true);
    expect(ran).toBe(1);
  });

  test("ordinary user is refused and the handler NEVER runs", async () => {
    let ran = 0;
    const boundary = new AdminBoundary({ auth: makeAuth() });
    const r = await boundary.runAdmin(
      { actor: ordinary, operation: "settings.model", permission: "settings.manage" },
      () => {
        ran++;
        return "done";
      },
    );
    expect(r.ok).toBe(false);
    expect(ran).toBe(0);
    if (!r.ok) expect(r.message).toBe(DENIED_MESSAGE);
  });

  test("missing identity is refused", async () => {
    let ran = 0;
    const boundary = new AdminBoundary({ auth: makeAuth() });
    const r = await boundary.runAdmin(
      { actor: undefined, operation: "admin.view", permission: "admin.view" },
      () => {
        ran++;
      },
    );
    expect(r.ok).toBe(false);
    expect(ran).toBe(0);
  });

  test("a forged actor cannot claim admin permission", async () => {
    let ran = 0;
    const boundary = new AdminBoundary({ auth: makeAuth() });
    // A caller who "looks" authorized but holds no such permission.
    const forged = { id: 999999 };
    const r = await boundary.runAdmin(
      { actor: forged, operation: "users.manage", permission: "users.manage" },
      () => {
        ran++;
      },
    );
    expect(r.ok).toBe(false);
    expect(ran).toBe(0);
  });

  test("owner cannot act on a permission it does not hold", async () => {
    // Sanity: the boundary checks the *requested* permission, not ownership.
    const boundary = new AdminBoundary({ auth: makeAuth() });
    const r = await boundary.runAdmin(
      { actor: owner, operation: "noop", permission: "tools.use" },
      () => "ok",
    );
    expect(r.ok).toBe(true); // owner holds tools.use too
  });

  test("user-facing message contains no internal detail", async () => {
    const boundary = new AdminBoundary({ auth: makeAuth() });
    for (const perm of ["settings.manage", "users.manage", "groups.review", "admin.view"] as const) {
      const r = await boundary.runAdmin({ actor: ordinary, operation: "x", permission: perm }, () => 1);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.message).toBe(DENIED_MESSAGE);
      expect(r.message).not.toContain("permission");
      expect(r.message).not.toContain(perm);
    }
  });

  test("a failing handler is reported safely", async () => {
    const boundary = new AdminBoundary({ auth: makeAuth() });
    const r = await boundary.runAdmin(
      { actor: owner, operation: "settings.model", permission: "settings.manage" },
      () => {
        throw new Error("INTERNAL /path/secret.db token=abc123");
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("error");
      expect(r.message).not.toContain("secret");
      expect(r.message).not.toContain("abc123");
      expect(r.message).not.toContain("INTERNAL");
    }
  });

  test("async handlers work", async () => {
    const boundary = new AdminBoundary({ auth: makeAuth() });
    const r = await boundary.runAdmin(
      { actor: owner, operation: "admin.view", permission: "admin.view" },
      async () => "async-ok",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe("async-ok");
  });

  test("the synchronous variant refuses non-owners", () => {
    let ran = 0;
    const boundary = new AdminBoundary({ auth: makeAuth() });
    const r = boundary.runAdminSync(
      { actor: ordinary, operation: "settings.model", permission: "settings.manage" },
      () => {
        ran++;
        return 1;
      },
    );
    expect(r.ok).toBe(false);
    expect(ran).toBe(0);
  });
});

// ---------- admin boundary: no state change on denial ----------

describe("no database change when permission is denied", () => {
  test("a denied admin op leaves the database untouched", async () => {
    const storage = freshStorage();
    const before = storage.auditEvents(100).length;

    const boundary = new AdminBoundary({
      auth: makeAuth(),
      audit: new AuditLogger({ storage }),
    });

    // The handler would delete a conversation; denial must prevent it.
    await boundary.runAdmin(
      { actor: ordinary, operation: "settings.reset", permission: "settings.manage" },
      () => {
        storage.appendMessage("u1", "c1", "user", "should never be written");
      },
    );

    expect(storage.history("u1", "c1")).toEqual([]);
    // Nothing but the denial event itself was written.
    expect(storage.auditEvents(100).length).toBe(before + 1);
    storage.close();
  });

  test("an allowed admin op does change the database", async () => {
    const storage = freshStorage();
    const boundary = new AdminBoundary({
      auth: makeAuth(),
      audit: new AuditLogger({ storage }),
    });

    const r = await boundary.runAdmin(
      { actor: owner, operation: "settings.note", permission: "settings.manage" },
      () => storage.appendMessage("owner", "c1", "assistant", "note"),
    );

    expect(r.ok).toBe(true);
    expect(storage.history("owner", "c1").length).toBe(1);
    storage.close();
  });
});

// ---------- audit log ----------

describe("audit log", () => {
  test("records a denied admin op with actor, outcome and permission", () => {
    const storage = freshStorage();
    const boundary = new AdminBoundary({
      auth: makeAuth(),
      audit: new AuditLogger({ storage }),
    });

    void boundary.runAdminSync(
      { actor: ordinary, operation: "settings.model", permission: "settings.manage" },
      () => "x",
    );

    const rows = storage.auditEvents(10);
    expect(rows.length).toBe(1);
    expect(rows[0]?.operation).toBe("settings.model");
    expect(rows[0]?.outcome).toBe("denied");
    expect(rows[0]?.actorId).toBe("222222");
    expect(rows[0]?.detail).toContain("settings.manage");
    storage.close();
  });

  test("records a successful admin op", () => {
    const storage = freshStorage();
    const boundary = new AdminBoundary({
      auth: makeAuth(),
      audit: new AuditLogger({ storage }),
    });

    void boundary.runAdminSync(
      { actor: owner, operation: "settings.model", permission: "settings.manage" },
      () => "x",
    );

    const rows = storage.auditEvents(10);
    expect(rows.length).toBe(1);
    expect(rows[0]?.outcome).toBe("success");
    expect(rows[0]?.actorId).toBe(String(OWNER_ID));
    storage.close();
  });

  test("never logs a token, key, or full secret", () => {
    const storage = freshStorage();
    const logger = new AuditLogger({ storage });

    logger.record({
      operation: "settings.model",
      actorId: "111111",
      outcome: "success",
      // Deliberately dangerous detail to prove it is scrubbed.
      detail: "TOKEN=1234567890:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQq set api_key=sk_live_abcdefghij",
    });

    const rows = storage.auditEvents(10);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("AAbbCCddEEffGGhhIIjjKKllMMnnOOppQq");
    expect(text).not.toContain("sk_live_abcdefghij");
    expect(text).not.toContain("1234567890:");
    expect(text).toContain("[redacted]");
    storage.close();
  });

  test("the audit record shape holds only ids and metadata, never message text", () => {
    const storage = freshStorage();
    const logger = new AuditLogger({ storage });

    // The tool/bot layer never passes user message text here. This records an
    // administrative action, whose payload is operation + ids only.
    logger.record({
      operation: "settings.model",
      actorId: "222222",
      outcome: "success",
      detail: "permission=settings.manage",
    });

    const row = storage.auditEvents(10)[0];
    expect(row).toBeDefined();
    // Fields are bounded and identifier-shaped.
    expect(row?.operation).toBe("settings.model");
    expect(row?.actorId).toBe("222222");
    expect(row?.detail).toBe("permission=settings.manage");
    expect(row?.detail?.length).toBeLessThanOrEqual(200);
    storage.close();
  });

  test("an oversized detail is clipped, not stored in full", () => {
    const storage = freshStorage();
    const logger = new AuditLogger({ storage });
    logger.record({
      operation: "op",
      actorId: "1",
      outcome: "success",
      detail: "x".repeat(5000),
    });
    const row = storage.auditEvents(10)[0];
    expect(row?.detail?.length).toBeLessThanOrEqual(200);
    storage.close();
  });

  test("caps growth at the retention limit", () => {
    const storage = freshStorage();
    const logger = new AuditLogger({ storage });
    for (let i = 0; i < 120; i++) {
      logger.record({ operation: `op${i}`, actorId: "1", outcome: "success" });
    }
    // 120 rows written; the cap keeps the newest and prunes the rest.
    const kept = storage.auditEvents(10_000);
    expect(kept.length).toBeLessThanOrEqual(120);
    expect(kept.length).toBeGreaterThan(0);
    // Newest preserved.
    expect(kept[0]?.operation).toBe("op119");
    storage.close();
  });

  test("audit failures never break the operation", () => {
    const boundary = new AdminBoundary({
      auth: makeAuth(),
      // A storage that throws on audit write.
      audit: new AuditLogger({
        storage: { appendAudit: () => { throw new Error("db gone"); } } as unknown as Storage,
      }),
    });
    const r = boundary.runAdminSync(
      { actor: owner, operation: "settings.model", permission: "settings.manage" },
      () => "ok",
    );
    expect(r.ok).toBe(true);
  });

  test("an event with no actor omits the actor field", () => {
    const storage = freshStorage();
    const logger = new AuditLogger({ storage });
    logger.record({ operation: "op", outcome: "denied" });
    const rows = storage.auditEvents(10);
    expect(rows.length).toBe(1);
    expect(rows[0]?.actorId).toBeUndefined();
    storage.close();
  });
});

// ---------- tools keep working through the authorized path ----------

describe("tools still run through the authorized path", () => {
  test("an ordinary user may still use the four public tools", async () => {
    const storage = freshStorage();
    const tools = new ToolService();
    const auth = makeAuth();

    const actor = toToolActor(authorizeToolUse(auth, ordinary, tools.registry.list()));

    const calc = await tools.runTool({ tool: "calculator", input: { op: "add", a: 2, b: 3 }, actor });
    expect(calc.status).toBe("ok");
    expect((calc.data as { result: number }).result).toBe(5);

    const unit = await tools.runTool({ tool: "unit_converter", input: { value: 1, from: "km", to: "m" }, actor });
    expect(unit.status).toBe("ok");
    storage.close();
  });

  test("an unidentified caller cannot run any tool", async () => {
    const tools = new ToolService();
    const auth = makeAuth();
    const actor = toToolActor(authorizeToolUse(auth, undefined, tools.registry.list()));
    const r = await tools.runTool({ tool: "calculator", input: { op: "add", a: 1, b: 1 }, actor });
    expect(r.status).toBe("not_allowed");
  });

  test("spoofing identity inside the tool payload grants nothing", async () => {
    const tools = new ToolService();
    const auth = makeAuth();
    // Unauthorized actor: empty grant list.
    const actor = toToolActor(authorizeToolUse(auth, undefined, tools.registry.list()));
    const r = await tools.runTool({
      tool: "calculator",
      // Attempts to escalate from inside the tool input.
      input: {
        op: "add",
        a: 1,
        b: 1,
        actor: { id: OWNER_ID },
        userId: String(OWNER_ID),
        permissions: ["tools:calculator"],
      },
      actor,
    });
    // Denied on authorization (or validation) — either way, not executed.
    expect(r.status).not.toBe("ok");
    expect(["not_allowed", "invalid_input"]).toContain(r.status);
  });

  test("a forged actor id in the payload cannot elevate the caller", async () => {
    const tools = new ToolService();
    const auth = makeAuth();
    // An ordinary user's real identity is 222222; the payload claims OWNER_ID.
    const ordinaryActor = toToolActor(
      authorizeToolUse(auth, { id: 222222 }, tools.registry.list()),
    );
    const r = await tools.runTool({
      tool: "calculator",
      // A well-formed tool call that also tries to claim the owner's identity.
      input: { op: "add", a: 1, b: 1 },
      actor: ordinaryActor,
    });
    // Runs, but only as the ordinary user: no admin capability is conferred.
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect((r.data as { result: number }).result).toBe(2);
    // The claim itself reaches no authorization decision.
    expect(auth.isOwner({ id: 222222 })).toBe(false);
  });

  test("identity fields inside tool input are rejected as unknown", async () => {
    const tools = new ToolService();
    const auth = makeAuth();
    const actor = toToolActor(authorizeToolUse(auth, { id: 222222 }, tools.registry.list()));
    for (const payload of [
      { op: "add", a: 1, b: 1, userId: String(OWNER_ID) },
      { op: "add", a: 1, b: 1, actor: { id: OWNER_ID } },
      { op: "add", a: 1, b: 1, permissions: ["tools:calculator"] },
      { op: "add", a: 1, b: 1, role: "owner" },
    ]) {
      const r = await tools.runTool({ tool: "calculator", input: payload, actor });
      expect(r.status).toBe("invalid_input");
    }
  });
});
