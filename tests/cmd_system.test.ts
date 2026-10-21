/**
 * Tests for the Hermes-parity system/owner commands (`src/bot/cmd_system.ts`).
 *
 * Owner enforcement is tested through `checkOwner` (the same preamble every
 * grammy wrapper runs): a non-owner gets the Persian owner-only reply.
 * All logic functions are tested with plain values — no grammy bot needed.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMAND_DEFS,
  checkOwner,
  handleAccessDecision,
  handleAccessList,
  handleAutopruneSet,
  handleCuratorRun,
  handleCuratorStatus,
  handleInsights,
  handleModelShow,
  handleModelSwitch,
  handlePause,
  handlePlugins,
  handleReasoningSet,
  handleReasoningShow,
  handleReloadMcp,
  handleReloadSkills,
  handleRestart,
  handleSetHome,
  handleSkills,
  handleSnapshot,
  handleSnapshotCreate,
  handleSnapshotList,
  handleSnapshotRestore,
  handleTools,
  handleUpdate,
  handleUsage,
  isPaused,
  listSnapshots,
  parseAccessTarget,
  parseAutoprune,
  sanitizeSnapshotName,
  scrubSecrets,
  setPaused,
  buildDebugMarkdown,
  tailLines,
} from "../src/bot/cmd_system";
import { tr } from "../src/i18n/strings/cmd_system_strings";

const EN = "en" as const; // English-only UI

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cmd-system-"));
}

// ---------------------------------------------------------------- defs ----

describe("COMMAND_DEFS", () => {
  test("declares all 23 system commands, owner-only", () => {
    const names = COMMAND_DEFS.map((d) => d.command).sort();
    expect(names).toEqual(
      [
        "approve", "autoprune", "ban", "curator", "debug", "deny", "insights",
        "model", "mute", "pause", "plugins", "reasoning", "reload_mcp",
        "reload_skills", "restart", "sethome", "skills", "snapshot",
        "tools", "unban", "unmute", "update", "usage",
      ].sort(),
    );
    expect(COMMAND_DEFS.every((d) => d.ownerOnly)).toBe(true);
    expect(COMMAND_DEFS.every((d) => d.descriptionEn.length > 0)).toBe(true);
    expect(COMMAND_DEFS.every((d) => d.descriptionEn.length > 0)).toBe(true);
  });
});

// ------------------------------------------------------ owner preamble ----

describe("checkOwner", () => {
  function fakeCtx() {
    const replies: string[] = [];
    return {
      ctx: {
        from: { id: 999 },
        reply: async (text: string) => {
          replies.push(text);
        },
      },
      replies,
    };
  }

  test("non-owner gets the Persian owner-only reply and false", async () => {
    const { ctx, replies } = fakeCtx();
    const deps = {
      auth: {
        actorFromTelegramUser: () => ({ id: "u999" }),
        isOwner: () => false,
      },
    };
    const ok = await checkOwner(ctx as never, deps as never, EN);
    expect(ok).toBe(false);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("for the bot owner only");
  });

  test("owner passes with no reply", async () => {
    const { ctx, replies } = fakeCtx();
    const deps = {
      auth: {
        actorFromTelegramUser: () => ({ id: "u1" }),
        isOwner: () => true,
      },
    };
    const ok = await checkOwner(ctx as never, deps as never, EN);
    expect(ok).toBe(true);
    expect(replies).toHaveLength(0);
  });

  test("no auth configured = fail closed", async () => {
    const { ctx, replies } = fakeCtx();
    const ok = await checkOwner(ctx as never, {} as never, EN);
    expect(ok).toBe(false);
    expect(replies[0]).toContain("for the bot owner only");
  });
});

// ------------------------------------------------------------- snapshot ----

describe("sanitizeSnapshotName", () => {
  test("rejects traversal and hostile names", () => {
    for (const bad of [
      "../evil", "a/b", "a\\b", "..", "a..", ".hidden", "-dash", "", "   ",
      "x".repeat(65), "نام فارسی", "a;b", "a b",
    ]) {
      expect(sanitizeSnapshotName(bad), bad).toBeUndefined();
    }
  });

  test("accepts sane names", () => {
    expect(sanitizeSnapshotName("pre-update")).toBe("pre-update");
    expect(sanitizeSnapshotName("bobi_20261018")).toBe("bobi_20261018");
    expect(sanitizeSnapshotName("a.b-c_d")).toBe("a.b-c_d");
  });
});

describe("snapshot round-trip", () => {
  function env() {
    const dir = tempDir();
    const db = join(dir, "bobi.db");
    writeFileSync(db, "fake-sqlite-bytes");
    return { dbPath: db, snapshotDir: join(dir, "snaps") };
  }

  test("create with default name + list + restore", () => {
    const e = env();
    const created = handleSnapshotCreate(EN, e, undefined, 1729252800000);
    expect(created.text).toContain("✅");
    const entries = listSnapshots(e.snapshotDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toMatch(/^bobi-\d{8}-\d{6}$/);

    // Restore without --confirm only explains.
    const ask = handleSnapshotRestore(EN, e, entries[0]!.name, false, false);
    expect(ask.text).toContain("--confirm");
    expect(ask.restart).toBeUndefined();

    // Confirmed restore replaces the db file.
    writeFileSync(e.dbPath, "changed-bytes");
    const done = handleSnapshotRestore(EN, e, entries[0]!.name, false, true);
    expect(done.text).toContain("✅");
    expect(
      handleSnapshotList(EN, e.snapshotDir).text,
    ).toContain(entries[0]!.name);
  });

  test("restore refuses while a turn is running", () => {
    const e = env();
    handleSnapshotCreate(EN, e, "one", 1);
    const r = handleSnapshotRestore(EN, e, "one", true, true);
    expect(r.text).toContain("turn is running");
  });

  test("restore of a missing snapshot is an error, not a throw", () => {
    const e = env();
    const r = handleSnapshotRestore(EN, e, "nope", false, true);
    expect(r.text).toContain("not found");
  });

  test("traversal name is rejected before any fs access", () => {
    const e = env();
    const r = handleSnapshotCreate(EN, e, "../escape", 1);
    expect(r.text).toContain("Invalid");
    expect(listSnapshots(e.snapshotDir)).toHaveLength(0);
  });

  test("dispatch: bare /snapshot lists, unknown sub shows usage", () => {
    const e = env();
    expect(handleSnapshot(EN, e, undefined, false, 1).text).toContain(
      "No snapshots",
    );
    expect(handleSnapshot(EN, e, "frobnicate", false, 1).text).toContain(
      "/snapshot create",
    );
    expect(
      handleSnapshot(EN, e, "create named-one", false, 1).text,
    ).toContain("named-one");
  });
});

// -------------------------------------------------------------- restart ----

describe("handleRestart", () => {
  test("refuses while a turn runs unless --force", () => {
    expect(
      handleRestart(EN, { turnRunning: true, force: false, confirmed: true })
        .text,
    ).toContain("turn is running");
    const forced = handleRestart(EN, {
      turnRunning: true,
      force: true,
      confirmed: true,
    });
    expect(forced.restart).toBe(true);
  });

  test("needs explicit --confirm", () => {
    const r = handleRestart(EN, {
      turnRunning: false,
      force: false,
      confirmed: false,
    });
    expect(r.restart).toBeUndefined();
    expect(r.text).toContain("--confirm");
    expect(
      handleRestart(EN, { turnRunning: false, force: false, confirmed: true })
        .restart,
    ).toBe(true);
  });
});

// --------------------------------------------------------------- update ----

describe("handleUpdate", () => {
  test("asks for confirmation first", async () => {
    const r = await handleUpdate(
      EN,
      {
        execGit: async () => ({ code: 0, out: "", err: "" }),
        repoDir: "/tmp",
      },
      false,
    );
    expect(r.text).toContain("--confirm");
    expect(r.restart).toBeUndefined();
  });

  test("refuses when cwd is not a git repo", async () => {
    const r = await handleUpdate(
      EN,
      {
        execGit: async () => ({ code: 128, out: "", err: "not a git repo" }),
        repoDir: "/tmp",
      },
      true,
    );
    expect(r.text).toContain("not a git repository");
    expect(r.restart).toBeUndefined();
  });

  test("successful pull restarts; failed pull does not", async () => {
    const ok = await handleUpdate(
      EN,
      {
        execGit: async () => ({ code: 0, out: "Already up to date.", err: "" }),
        repoDir: "/tmp",
      },
      true,
    );
    expect(ok.restart).toBe(true);
    expect(ok.text).toContain("Already up to date");

    const fail = await handleUpdate(
      EN,
      {
        execGit: async (args) =>
          args[0] === "rev-parse"
            ? { code: 0, out: "true", err: "" }
            : { code: 1, out: "", err: "diverged" },
        repoDir: "/tmp",
      },
      true,
    );
    expect(fail.restart).toBeUndefined();
    expect(fail.text).toContain("diverged");
  });
});

describe("tailLines", () => {
  test("returns the last N lines", () => {
    expect(tailLines("a\nb\nc\nd", 2)).toBe("c\nd");
    expect(tailLines("a\nb", 10)).toBe("a\nb");
  });
});

// ---------------------------------------------------------------- debug ----

describe("scrubSecrets", () => {
  test("redacts key-like spans (canary)", () => {
    const canary = `apiKey=sk-test-secret123 and token 123456:${"A".repeat(35)} and Bearer ${"z".repeat(20)} and ghp_${"b".repeat(24)} and xoxb-123-abc and AKIA${"C".repeat(16)} and password="hunter2"`;
    const out = scrubSecrets(canary);
    expect(out).not.toContain("sk-test-secret123");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain(`ghp_${"b".repeat(24)}`);
    expect(out).toContain("[redacted]");
  });

  test("leaves ordinary text alone", () => {
    const text = "provider: anthropic, model: claude-sonnet, uptime: 12m";
    expect(scrubSecrets(text)).toBe(text);
  });
});

describe("buildDebugMarkdown", () => {
  test("includes diagnostics, never secrets", () => {
    const md = buildDebugMarkdown(EN, {
      version: "1.2.3",
      uptimeSec: 754,
      providerLabel: "Anthropic",
      modelLabel: "claude",
      pendingUsers: 2,
      approvedUsers: 5,
      pendingGroups: 0,
      approvedGroups: 1,
      logTail: "starting up\napiKey=sk-test-secret123\nok",
    });
    expect(md).toContain("1.2.3");
    expect(md).toContain("12m");
    expect(md).not.toContain("sk-test-secret123");
    expect(md).toContain("[redacted]");
  });
});

// ------------------------------------------------- usage and insights ----

describe("handleUsage", () => {
  test("summarises today + week with the approximate-cost disclaimer", () => {
    const text = handleUsage(
      EN,
      { inputTokens: 1000, outputTokens: 500, runs: 3, costUsd: 0.0123 },
      { inputTokens: 7000, outputTokens: 3500, runs: 21, costUsd: 0.0861 },
      [{ modelId: "m1", inputTokens: 7000, outputTokens: 3500, runs: 21 }],
    );
    expect(text).toContain("today");
    expect(text).toContain("last 7 days");
    expect(text).toContain("Approximate");
    expect(text).toContain("m1");
  });
});

describe("handleInsights", () => {
  const days = [
    { day: "2026-10-16", inputTokens: 100, outputTokens: 50, runs: 1 },
    { day: "2026-10-17", inputTokens: 200, outputTokens: 100, runs: 2 },
  ];
  test("reports an upward trend vs the previous period", () => {
    const text = handleInsights(
      EN,
      2,
      days,
      { inputTokens: 50, outputTokens: 25, runs: 1 },
      [],
    );
    expect(text).toContain("up (");
    expect(text).toContain("2026-10-17");
  });

  test("flat trend when periods are similar", () => {
    const text = handleInsights(
      EN,
      2,
      days,
      { inputTokens: 440, outputTokens: 0, runs: 3 },
      [],
    );
    expect(text).toContain("unchanged");
  });
});

// ---------------------------------------------------------------- model ----

describe("handleModelSwitch", () => {
  function fakeStorage() {
    const selections: Array<{ providerId: number; modelId: number }> = [];
    return {
      selections,
      listProviders: () => [
        { id: 1, label: "P1", enabled: true },
        { id: 2, label: "P2", enabled: false },
      ],
      listModels: (providerId: number) =>
        providerId === 1
          ? [
              { id: 10, label: "Alpha", modelId: "alpha-1", enabled: true },
              { id: 11, label: "Beta", modelId: "beta-1", enabled: false },
            ]
          : [{ id: 20, label: "Gamma", modelId: "gamma-1", enabled: true }],
      getProvider: (id: number) => ({ id, label: `P${id}`, enabled: id !== 2 }),
      setRuntimeSelection: (sel: { providerId: number; modelId: number }) => {
        selections.push(sel);
      },
    };
  }

  test("switches by label and by model id", () => {
    const s = fakeStorage();
    const r = handleModelSwitch(EN, s as never, "Alpha");
    expect(r.text).toContain("Alpha");
    expect(s.selections).toEqual([{ providerId: 1, modelId: 10 }]);
    const r2 = handleModelSwitch(EN, s as never, "beta-1");
    expect(r2.text).toContain("disabled");
  });

  test("unknown name is an error, not a throw", () => {
    const r = handleModelSwitch(EN, fakeStorage() as never, "nope");
    expect(r.text).toContain("No model named");
  });
});

describe("handleModelShow", () => {
  test("marks the active model", () => {
    const text = handleModelShow(
      EN,
      { providerLabel: "P1", modelLabel: "Alpha" },
      [
        {
          providerLabel: "P1",
          label: "Alpha",
          modelId: "alpha-1",
          enabled: true,
          isActive: true,
          id: 1,
        },
      ],
    );
    expect(text).toContain("active ✅");
    expect(text).toContain("/model");
  });
});

// ------------------------------------------------------------ reasoning ----

describe("reasoning", () => {
  test("show reports the effective env-resolved level", () => {
    const text = handleReasoningShow(EN, "low");
    expect(text).toContain("BOBI_REASONING_EFFORT");
    expect(text).toContain("low");
  });

  test("set stores a valid level, rejects junk", () => {
    const saved: Record<string, string> = {};
    const prefs = {
      getUserPref: () => undefined,
      setUserPref: (u: string, k: string, v: string) => {
        saved[`${u}:${k}`] = v;
      },
    };
    expect(handleReasoningSet(EN, prefs, "1", "high")).toContain("high");
    expect(saved["1:reasoning_effort"]).toBe("high");
    expect(handleReasoningSet(EN, prefs, "1", "ultra")).toContain("off, low");
  });
});

// ------------------------------------------------------------ autoprune ----

describe("autoprune", () => {
  test("parses stored state", () => {
    expect(parseAutoprune(undefined)).toEqual({ on: false, days: 30 });
    expect(parseAutoprune("on:14")).toEqual({ on: true, days: 14 });
    expect(parseAutoprune("off")).toEqual({ on: false, days: 30 });
  });

  test("set on/off with validation", () => {
    const saved: Record<string, string> = {};
    const prefs = {
      getUserPref: () => undefined,
      setUserPref: (u: string, k: string, v: string) => {
        saved[`${u}:${k}`] = v;
      },
    };
    expect(handleAutopruneSet(EN, prefs, "1", "on 30")).toContain("on (30d)");
    expect(saved["1:autoprune"]).toBe("on:30");
    expect(handleAutopruneSet(EN, prefs, "1", "off")).toContain("off");
    expect(handleAutopruneSet(EN, prefs, "1", "maybe")).toContain("/autoprune on");
  });
});

// ----------------------------------------------------------------- tools ----

describe("handleTools", () => {
  test("lists tools with toolset and disabled state", () => {
    const text = handleTools(EN, {
      registry: {
        list: () => [
          { name: "a", description: "A", enabled: true, toolset: "core" },
          { name: "b", description: "B", enabled: false },
        ],
      },
      listActive: () => [],
    } as never);
    expect(text).toContain("a");
    expect(text).toContain("[core]");
    expect(text).toContain("disabled");
  });

  test("unavailable without the service", () => {
    expect(handleTools(EN, undefined)).toContain("unavailable");
  });
});

// ---------------------------------------------------------------- skills ----

describe("handleSkills", () => {
  test("prefers the skills tool path", async () => {
    const text = await handleSkills(EN, {
      ownerId: "1",
      tools: {
        execute: async () => ({
          tool: "skills",
          status: "ok",
          data: { skills: [{ name: "seo", description: "SEO helper" }] },
          durationMs: 1,
        }),
      } as never,
    });
    expect(text).toContain("seo");
    expect(text).toContain("SEO helper");
  });

  test("falls back to the skill cache", async () => {
    const text = await handleSkills(EN, {
      ownerId: "1",
      skills: { skills: () => [{ name: "k", description: "d" }] } as never,
    });
    expect(text).toContain("k");
  });

  test("honest when nothing is wired", async () => {
    expect(await handleSkills(EN, { ownerId: "1" })).toContain("is available");
  });
});

// --------------------------------------------------------------- curator ----

describe("curator", () => {
  test("status shows the pending count", () => {
    expect(handleCuratorStatus(EN, {} as never, 3)).toContain("3");
    expect(handleCuratorStatus(EN, undefined, 0)).toContain("unavailable");
  });

  test("run executes curate_memories with an owner actor", async () => {
    let seenActor: unknown;
    const text = await handleCuratorRun(
      EN,
      {
        execute: async (req: { actor: unknown }) => {
          seenActor = req.actor;
          return {
            tool: "curate_memories",
            status: "ok",
            data: { count: 2, proposals: [] },
            durationMs: 1,
          };
        },
      } as never,
      "1",
    );
    expect(text).toContain("2");
    expect((seenActor as { userId: string }).userId).toBe("1");
  });
});

// --------------------------------------------------------------- plugins ----

describe("handlePlugins", () => {
  test("lists plugins from the dir", () => {
    const dir = tempDir();
    const pdir = join(dir, "demo");
    mkdirSync(pdir, { recursive: true });
    writeFileSync(
      join(pdir, "plugin.md"),
      `---\nname: demo\nversion: 0.1.0\ndescription: Demo plugin\nenabled: true\n---\n`,
    );
    const text = handlePlugins(EN, dir);
    expect(text).toContain("demo");
    expect(text).toContain("0.1.0");
  });

  test("empty dir is an honest empty message", () => {
    expect(handlePlugins(EN, tempDir())).toContain("No plugins");
  });
});

// ----------------------------------------------------- reload commands ----

describe("reload", () => {
  test("reload_mcp reconnects through closeAll+connectAll", async () => {
    const calls: string[] = [];
    const text = await handleReloadMcp(EN, {
      closeAll: async () => {
        calls.push("close");
      },
      connectAll: async () => {
        calls.push("connect");
      },
      status: () => [{ name: "s", connected: true }],
    } as never);
    expect(calls).toEqual(["close", "connect"]);
    expect(text).toContain("✅");
  });

  test("reload_mcp is honest without the manager", async () => {
    expect(await handleReloadMcp(EN, undefined)).toContain("not wired");
  });

  test("reload_skills rescans the cache", () => {
    expect(
      handleReloadSkills(EN, {
        skills: () => [{ name: "a", description: "b" }],
      } as never),
    ).toContain("1");
    expect(handleReloadSkills(EN, undefined)).toContain("not wired");
  });
});

// -------------------------------------------------------- approve / deny ----

describe("parseAccessTarget", () => {
  test("parses kind, id and --confirm", () => {
    expect(parseAccessTarget("user 123 --confirm")).toEqual({
      kind: "user",
      id: "123",
      confirmed: true,
    });
    expect(parseAccessTarget("group -456")).toEqual({
      kind: "group",
      id: "-456",
      confirmed: false,
    });
    expect(parseAccessTarget(undefined)).toBeUndefined();
    expect(parseAccessTarget("bogus 1")).toBeUndefined();
    expect(parseAccessTarget("user")).toBeUndefined();
  });
});

describe("access list and decisions", () => {
  function fakeServices() {
    const calls: Array<{ op: string; id: string }> = [];
    const users = {
      listPending: () => [
        { userId: "42", username: "ali", firstName: "Ali", state: "pending" },
      ],
      approve: (id: string) => {
        calls.push({ op: "approve", id });
        return { ok: true, previous: "pending" };
      },
      reject: (id: string) => {
        calls.push({ op: "reject", id });
        return { ok: true, previous: "pending" };
      },
    };
    const storage = { appendAudit: () => 1 };
    return { users, calls, storage };
  }

  test("list shows pending users with confirm commands", () => {
    const text = handleAccessList(EN, [
      { kind: "user", id: "42", label: "Ali" },
    ]);
    expect(text).toContain("42");
    expect(text).toContain("/approve user 42 --confirm");
  });

  test("empty list is an honest message", () => {
    expect(handleAccessList(EN, [])).toContain("pending");
  });

  test("decision without --confirm only explains", () => {
    const { users, calls, storage } = fakeServices();
    const r = handleAccessDecision(
      EN,
      { users: users as never },
      storage as never,
      { kind: "user", id: "42", approve: true, confirmed: false, ownerId: "1" },
    );
    expect(r.text).toContain("--confirm");
    expect(calls).toHaveLength(0);
  });

  test("approve and deny with --confirm execute", () => {
    const { users, calls, storage } = fakeServices();
    const a = handleAccessDecision(
      EN,
      { users: users as never },
      storage as never,
      { kind: "user", id: "42", approve: true, confirmed: true, ownerId: "1" },
    );
    expect(a.text).toContain("approved");
    const d = handleAccessDecision(
      EN,
      { users: users as never },
      storage as never,
      { kind: "user", id: "42", approve: false, confirmed: true, ownerId: "1" },
    );
    expect(d.text).toContain("denied");
    expect(calls.map((c) => c.op)).toEqual(["approve", "reject"]);
  });
});

// -------------------------------------------------------- sethome & pause ----

describe("sethome and pause", () => {
  test("sethome stores the chat id in the owner prefs", () => {
    const saved: Record<string, string> = {};
    const prefs = {
      getUserPref: () => undefined,
      setUserPref: (u: string, k: string, v: string) => {
        saved[`${u}:${k}`] = v;
      },
    };
    expect(handleSetHome(EN, prefs, "1", "-100")).toContain("home chat");
    expect(saved["1:home_chat_id"]).toBe("-100");
    expect(handleSetHome(EN, undefined, "1", "-100")).toContain(
      "unavailable",
    );
  });

  test("pause flag round-trips", () => {
    setPaused(false);
    expect(isPaused()).toBe(false);
    const prefs = {
      getUserPref: () => undefined,
      setUserPref: () => {},
    };
    expect(handlePause(EN, prefs, "1", "on")).toContain("paused");
    expect(isPaused()).toBe(true);
    expect(handlePause(EN, prefs, "1", "off")).toContain("resumed");
    expect(isPaused()).toBe(false);
    expect(handlePause(EN, prefs, "1", "maybe")).toContain("/pause on");
  });
});

// ---------------------------------------------------------------- strings ----

describe("tr", () => {
  test("translates, falls back to the key, substitutes vars", () => {
    expect(tr("fa", "cmd_system.owner_only")).toContain("owner");
    expect(tr("en", "cmd_system.owner_only")).toContain("owner");
    expect(tr("fa", "cmd_system.nope")).toBe("cmd_system.nope");
    expect(tr("fa", "cmd_system.snapshot.created", { name: "n", size: "1 KB" }))
      .toContain("n");
  });
});
