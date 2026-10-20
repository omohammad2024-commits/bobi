/**
 * Custom shortcut tools (shortcut_add / shortcut_list / shortcut_delete)
 * and the custom_shortcuts storage table.
 *
 * Pins: CRUD round-trip, name validation, tool-existence validation for
 * kind="tool", and the owner-only gate.
 */
import { describe, expect, test } from "bun:test";
import { Storage, StorageError } from "../src/storage/storage";
import { ToolService } from "../src/tools/service";
import {
  SHORTCUT_ADD_PERMISSION,
  SHORTCUT_DELETE_PERMISSION,
  SHORTCUT_LIST_PERMISSION,
  createShortcutTools,
  normalizeShortcutName,
  validateShortcutName,
} from "../src/tools/shortcuts";
import { ToolError } from "../src/tools/errors";
import type { ToolActor, ToolContext } from "../src/tools/types";

const PERMS = [SHORTCUT_ADD_PERMISSION, SHORTCUT_LIST_PERMISSION, SHORTCUT_DELETE_PERMISSION];
const OWNER = "owner-1";

function ownerActor(): ToolActor {
  return { userId: OWNER, permissions: PERMS };
}

function nonOwnerActor(): ToolActor {
  return { userId: "stranger", permissions: [] };
}

function ctxFor(actor: ToolActor): ToolContext {
  return { clock: () => new Date(), actor, signal: new AbortController().signal };
}

interface Ctx {
  storage: Storage;
  svc: ToolService;
}

/** Service whose shortcut tools validate against the service's own registry. */
function service(isOwner: (userId: string) => boolean = (id) => id === OWNER): Ctx {
  const storage = Storage.open(":memory:");
  const svc = new ToolService({});
  for (const tool of createShortcutTools({ storage, registry: svc.registry, isOwner })) {
    svc.registry.register(tool);
  }
  return { storage, svc };
}

function run(ctx: Ctx, tool: string, input: unknown, who: ToolActor = ownerActor()) {
  return ctx.svc.runTool({ tool, input, actor: who });
}

describe("custom_shortcuts storage", () => {
  test("CRUD round-trip on a prompt shortcut", () => {
    const db = Storage.open(":memory:");
    expect(db.getShortcut("صبح")).toBeUndefined();
    expect(db.listShortcuts()).toEqual([]);

    db.upsertShortcut({ name: "صبح", kind: "prompt", action: "خلاصه صبحگاهی بده" });
    const got = db.getShortcut("صبح");
    expect(got).toBeDefined();
    expect(got?.name).toBe("صبح");
    expect(got?.kind).toBe("prompt");
    expect(got?.action).toBe("خلاصه صبحگاهی بده");
    expect(got?.toolArgs).toBeUndefined();
    expect(typeof got?.createdAt).toBe("number");
    expect(typeof got?.updatedAt).toBe("number");

    // Upsert replaces the row.
    db.upsertShortcut({ name: "صبح", kind: "prompt", action: "نسخه جدید" });
    expect(db.getShortcut("صبح")?.action).toBe("نسخه جدید");
    expect(db.listShortcuts().length).toBe(1);

    expect(db.deleteShortcut("صبح")).toBe(true);
    expect(db.deleteShortcut("صبح")).toBe(false);
    expect(db.getShortcut("صبح")).toBeUndefined();
    db.close();
  });

  test("toolArgs survive a JSON round-trip", () => {
    const db = Storage.open(":memory:");
    db.upsertShortcut({
      name: "calc",
      kind: "tool",
      action: "calculator",
      toolArgs: { expression: "1+2", note: "فارسی" },
    });
    const got = db.getShortcut("calc");
    expect(got?.toolArgs).toEqual({ expression: "1+2", note: "فارسی" });
    db.close();
  });

  test("listShortcuts returns names alphabetically", () => {
    const db = Storage.open(":memory:");
    db.upsertShortcut({ name: "zulu", kind: "prompt", action: "a" });
    db.upsertShortcut({ name: "alpha", kind: "prompt", action: "a" });
    db.upsertShortcut({ name: "mike", kind: "tool", action: "calculator" });
    expect(db.listShortcuts().map((s) => s.name)).toEqual(["alpha", "mike", "zulu"]);
    db.close();
  });

  test("invalid kind is refused with a clear storage error", () => {
    const db = Storage.open(":memory:");
    expect(() => db.upsertShortcut({ name: "x", kind: "bogus", action: "a" })).toThrow(StorageError);
    expect(db.getShortcut("x")).toBeUndefined();
    db.close();
  });
});

describe("normalizeShortcutName", () => {
  test("strips leading slashes and lowercases", () => {
    expect(normalizeShortcutName("/صبح")).toBe("صبح");
    expect(normalizeShortcutName("//Morning")).toBe("morning");
    expect(normalizeShortcutName("  وضعیت  ")).toBe("وضعیت");
  });
});

describe("validateShortcutName", () => {
  test("accepts Persian and Latin names", () => {
    expect(() => validateShortcutName("صبح")).not.toThrow();
    expect(() => validateShortcutName("وضعیت_من۱")).not.toThrow();
    expect(() => validateShortcutName("morning_2")).not.toThrow();
    expect(() => validateShortcutName("ab")).not.toThrow();
  });

  test("rejects bad lengths", () => {
    expect(() => validateShortcutName("a")).toThrow(ToolError);
    expect(() => validateShortcutName("x".repeat(33))).toThrow(ToolError);
  });

  test("rejects forbidden characters", () => {
    for (const bad of ["hello world", "a-b", "a/b", "😂خنده", "name!"]) {
      expect(() => validateShortcutName(bad), bad).toThrow(ToolError);
    }
  });

  test("rejects names colliding with built-in commands", () => {
    for (const reserved of ["start", "help", "ai", "admin", "model", "digest", "reset"]) {
      expect(() => validateShortcutName(reserved), reserved).toThrow(ToolError);
    }
  });
});

describe("shortcut_add", () => {
  test("stores a prompt shortcut and reports created (not updated)", async () => {
    const ctx = service();
    const r = await run(ctx, "shortcut_add", {
      name: "/صبح",
      kind: "prompt",
      action: "خلاصه صبحگاهی بده",
    });
    expect(r.status).toBe("ok");
    expect(r.data).toMatchObject({ name: "صبح", kind: "prompt", updated: false });
    expect(ctx.storage.getShortcut("صبح")?.action).toBe("خلاصه صبحگاهی بده");
  });

  test("re-adding the same name reports updated", async () => {
    const ctx = service();
    await run(ctx, "shortcut_add", { name: "صبح", kind: "prompt", action: "one" });
    const r = await run(ctx, "shortcut_add", { name: "صبح", kind: "prompt", action: "two" });
    expect(r.status).toBe("ok");
    expect((r.data as { updated: boolean }).updated).toBe(true);
    expect(ctx.storage.getShortcut("صبح")?.action).toBe("two");
  });

  test("kind=tool requires a registered tool", async () => {
    const ctx = service();
    const bad = await run(ctx, "shortcut_add", {
      name: "ghost",
      kind: "tool",
      action: "no_such_tool",
    });
    expect(bad.status).toBe("invalid_input");
    expect(ctx.storage.getShortcut("ghost")).toBeUndefined();

    const good = await run(ctx, "shortcut_add", {
      name: "calc",
      kind: "tool",
      action: "calculator",
      toolArgs: { expression: "2*3" },
    });
    expect(good.status).toBe("ok");
    expect(ctx.storage.getShortcut("calc")?.toolArgs).toEqual({ expression: "2*3" });
  });

  test("rejects reserved names and garbage input", async () => {
    const ctx = service();
    const reserved = await run(ctx, "shortcut_add", {
      name: "start",
      kind: "prompt",
      action: "x",
    });
    expect(reserved.status).toBe("invalid_input");

    const badKind = await run(ctx, "shortcut_add", {
      name: "fine_name",
      kind: "script",
      action: "x",
    });
    expect(badKind.status).toBe("invalid_input");

    const empty = await run(ctx, "shortcut_add", {
      name: "fine_name",
      kind: "prompt",
      action: "   ",
    });
    expect(empty.status).toBe("invalid_input");
  });

  test("non-owner is refused", async () => {
    const ctx = service();
    const r = await run(
      ctx,
      "shortcut_add",
      { name: "صبح", kind: "prompt", action: "x" },
      nonOwnerActor(),
    );
    expect(r.status).toBe("not_allowed");
    expect(ctx.storage.getShortcut("صبح")).toBeUndefined();
  });

  test("unknown identity is refused", async () => {
    const ctx = service();
    const tools = createShortcutTools({
      storage: ctx.storage,
      registry: ctx.svc.registry,
      isOwner: (id) => id === OWNER,
    });
    const add = tools.find((t) => t.name === "shortcut_add");
    expect(add).toBeDefined();
    await expect(
      add!.run(
        { name: "صبح", kind: "prompt", action: "x" } as never,
        ctxFor({ userId: "unknown", permissions: PERMS }),
      ),
    ).rejects.toThrow(ToolError);
  });
});

describe("shortcut_list", () => {
  test("lists shortcuts with truncated action previews", async () => {
    const ctx = service();
    await run(ctx, "shortcut_add", { name: "صبح", kind: "prompt", action: "خلاصه بده" });
    await run(ctx, "shortcut_add", { name: "calc", kind: "tool", action: "calculator" });
    const r = await run(ctx, "shortcut_list", {});
    expect(r.status).toBe("ok");
    const data = r.data as {
      shortcuts: Array<{ name: string; kind: string; action: string; updatedAt: number }>;
    };
    expect(data.shortcuts.map((s) => s.name)).toEqual(["calc", "صبح"]);
    expect(data.shortcuts[0]?.kind).toBe("tool");
  });

  test("non-owner is refused", async () => {
    const ctx = service();
    const r = await run(ctx, "shortcut_list", {}, nonOwnerActor());
    expect(r.status).toBe("not_allowed");
  });
});

describe("shortcut_delete", () => {
  test("deletes and reports deleted=false for unknown names", async () => {
    const ctx = service();
    await run(ctx, "shortcut_add", { name: "صبح", kind: "prompt", action: "x" });
    const r1 = await run(ctx, "shortcut_delete", { name: "/صبح" });
    expect(r1.status).toBe("ok");
    expect((r1.data as { deleted: boolean }).deleted).toBe(true);
    const r2 = await run(ctx, "shortcut_delete", { name: "صبح" });
    expect((r2.data as { deleted: boolean }).deleted).toBe(false);
  });

  test("non-owner is refused", async () => {
    const ctx = service();
    const r = await run(ctx, "shortcut_delete", { name: "صبح" }, nonOwnerActor());
    expect(r.status).toBe("not_allowed");
  });
});
