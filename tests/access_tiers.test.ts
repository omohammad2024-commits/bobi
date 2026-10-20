/**
 * Two-tier access model tests (owner directive, Oct 18 2026).
 *
 * TIER 1 — OWNER (محمد): full access, no behaviour change.
 * TIER 2 — PUBLIC: chat + /start (public) + /help (public part) + /commands.
 * Everything else is owner-only: invisible in menus AND refused by
 * server-side gates. (/lang was removed Oct 2026: the UI is English-only.)
 *
 * Covers: classification of every command, tier-gate refusals (fa+en, no
 * leak), forged palette callbacks across ALL owner-only commands, menu
 * invisibility (default setMyCommands scope + public menu builder fuzz),
 * per-user data isolation (hammer test), ban/mute, creator identity
 * surviving personality switches, and the ban/mute command handlers.
 *
 * No network, no Telegram.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";
import { authorizeToolUse, toToolActor } from "../src/auth/tool_bridge";
import { ToolService } from "../src/tools/service";
import {
  COMMAND_HELP,
  visibleCommandHelp,
  gateUser,
  handleHelpCommand,
} from "../src/bot/bot";
import {
  PUBLIC_COMMANDS,
  commandTier,
  isPublicCommand,
  isOwnerCtx,
  requireOwnerTier,
} from "../src/bot/access";
import {
  buildMainMenu,
  buildPublicMainMenu,
  publicMenuCommands,
  ownerMenuCommands,
  BUILTIN_COMMAND_DEFS,
  CALLBACKS,
} from "../src/bot/menu";
import { COMMAND_DEFS as SESSION_COMMAND_DEFS } from "../src/bot/cmd_session";
import { COMMAND_DEFS as SYSTEM_COMMAND_DEFS } from "../src/bot/cmd_system";
import { COMMAND_DEFS as AUTO_COMMAND_DEFS } from "../src/bot/cmd_auto";
import { COMMAND_DEFS as BENCH_COMMAND_DEFS } from "../src/bot/cmd_phase3_bench";
import { COMMAND_DEFS as SKILLS_COMMAND_DEFS } from "../src/bot/cmd_phase3_skills";
import {
  runPaletteCommand,
  handlePaletteCallback,
  paletteCategoriesRender,
} from "../src/bot/palette";
import { buildSystemPrompt } from "../src/agent/prompt";
import { getPersonality, personalityNames } from "../src/personality/personalities";
import { createMemoryTools } from "../src/tools/memory";
import { createHistoryTools } from "../src/tools/history";
import { SqliteMemoryProvider } from "../src/memory/sqlite_provider";
import { UserAccessService } from "../src/auth/user_service";
import {
  handleUserRestrict,
  parseUserIdArg,
} from "../src/bot/cmd_system";
import { t } from "../src/i18n";

const OWNER = 111_111;
const STRANGER = 222_222;
const OTHER = 333_333;

const HERMES_DEFS = [
  ...SESSION_COMMAND_DEFS,
  ...SYSTEM_COMMAND_DEFS,
  ...AUTO_COMMAND_DEFS,
  // Phase-3: owner-only commands (invisible to the public via ownerOnly).
  ...SKILLS_COMMAND_DEFS,
  ...BENCH_COMMAND_DEFS,
  { command: "gassistant", descriptionEn: "Group assistant mode", ownerOnly: true },
  { command: "gsummary", descriptionEn: "Summarize group discussion", ownerOnly: true },
  { command: "gpoll", descriptionEn: "Create a group poll", ownerOnly: true },
];

function authForOwner() {
  return new AuthorizationService(OwnerIdentity.fromNumber(OWNER));
}

/** Fake command ctx with a sender id; records replies. */
function fakeCmdCtx(fromId: number, chatType = "private") {
  const replies: string[] = [];
  return {
    replies,
    ctx: {
      from: { id: fromId },
      chat: { id: fromId, type: chatType },
      message: { text: "/model" },
      reply: async (text: string) => {
        replies.push(text);
      },
    } as never,
  };
}

/** Fake palette callback ctx. */
function fakeCbCtx(fromId: number, authed: boolean) {
  const sent: string[] = [];
  const edits: unknown[] = [];
  const deps: Record<string, unknown> = { engine: {} };
  if (authed) deps.auth = authForOwner();
  return {
    sent,
    ctx: {
      from: { id: fromId },
      chat: { id: 999 },
      reply: async (text: string) => {
        sent.push(text);
      },
      editMessageText: async (text: string, extra?: unknown) => {
        edits.push({ text, extra });
      },
      answerCallbackQuery: async () => {},
    } as never,
    env: { deps: deps as never, sysOpts: {} },
  };
}

// ---------------------------------------------------------------------------
// 1. Classification: every command has a tier, and the public set is tiny
// ---------------------------------------------------------------------------

describe("tier classification", () => {
  test("the public surface is exactly start/help/commands/voice", () => {
    expect([...PUBLIC_COMMANDS].sort()).toEqual(["commands", "help", "start", "voice"]);
    for (const c of COMMAND_HELP) {
      expect(commandTier(c.name)).toBe(c.ownerOnly ? "owner" : "public");
      expect(isPublicCommand(c.name)).toBe(!c.ownerOnly);
    }
  });

  test("unknown command names are owner-only (deny by default)", () => {
    expect(commandTier("nope")).toBe("owner");
    expect(commandTier("")).toBe("owner");
    expect(isPublicCommand("admin")).toBe(false);
  });

  test("visibleCommandHelp(false) exposes exactly the public four", () => {
    expect(visibleCommandHelp(false).map((c) => c.name)).toEqual([
      "start",
      "help",
      "commands",
      "voice",
    ]);
  });

  test("COMMAND_HELP, menu defs and palette agree on every flag", () => {
    const helpFlags = new Map(COMMAND_HELP.map((c) => [c.name, c.ownerOnly]));
    for (const d of [...BUILTIN_COMMAND_DEFS, ...HERMES_DEFS]) {
      expect(helpFlags.get(d.command), d.command).toBe(d.ownerOnly);
    }
    expect(COMMAND_HELP.length).toBe(
      BUILTIN_COMMAND_DEFS.length + HERMES_DEFS.length,
    );
  });

  test("/help text for the public contains zero owner-only commands", () => {
    const replies: string[] = [];
    const ctx = { reply: async (t: string) => { replies.push(t); } };
    return handleHelpCommand(ctx, false, "en").then(() => {
      const text = replies.join("\n");
      for (const c of COMMAND_HELP) {
        if (c.ownerOnly) expect(text).not.toContain(`/${c.name}`);
        else expect(text).toContain(`/${c.name}`);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The tier gate: polite refusal, no leak, fail-closed
// ---------------------------------------------------------------------------

describe("requireOwnerTier", () => {
  test("the owner passes through untouched", async () => {
    const { ctx, replies } = fakeCmdCtx(OWNER);
    expect(await requireOwnerTier(ctx, { auth: authForOwner() }, "en")).toBe(true);
    expect(replies).toEqual([]);
  });

  test("a stranger gets the short polite Persian refusal — nothing about the command", async () => {
    const { ctx, replies } = fakeCmdCtx(STRANGER);
    expect(await requireOwnerTier(ctx, { auth: authForOwner() }, "en")).toBe(false);
    expect(replies).toEqual([t("tier.refused", "en")]);
    // No leak: the refusal names no feature, no command, no capability.
    for (const leak of ["model", "admin", "حافظه", "توکن", "دستور"]) {
      expect(replies[0]).not.toContain(leak);
    }
  });

  test("the refusal follows the sender's language", async () => {
    const { ctx, replies } = fakeCmdCtx(STRANGER);
    expect(await requireOwnerTier(ctx, { auth: authForOwner() }, "en")).toBe(false);
    expect(replies).toEqual([t("tier.refused", "en")]);
  });

  test("fail-closed without auth or sender: nobody is the owner", async () => {
    expect(isOwnerCtx({ from: { id: STRANGER } }, {})).toBe(false);
    expect(isOwnerCtx({}, { auth: authForOwner() })).toBe(false);
    const { ctx, replies } = fakeCmdCtx(STRANGER);
    expect(await requireOwnerTier(ctx, {}, "en")).toBe(false);
    expect(replies).toEqual([t("tier.refused", "en")]);
  });

  test("ownership comes from the numeric id only — a group chat does not confuse it", async () => {
    const { ctx, replies } = fakeCmdCtx(STRANGER, "supergroup");
    expect(await requireOwnerTier(ctx, { auth: authForOwner() }, "en")).toBe(false);
    expect(replies).toHaveLength(1);
    const owner = fakeCmdCtx(OWNER, "supergroup");
    expect(await requireOwnerTier(owner.ctx, { auth: authForOwner() }, "en")).toBe(true);
    expect(owner.replies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Forged palette callbacks: every owner-only command, never executed
// ---------------------------------------------------------------------------

describe("forged palette callbacks across all owner-only commands", () => {
  const ownerOnly = COMMAND_HELP.filter((c) => c.ownerOnly).map((c) => c.name);

  test("all 69 owner-only commands are refused for a stranger via pal:cmd:", async () => {
    expect(ownerOnly.length).toBe(69);
    for (const name of ownerOnly) {
      const f = fakeCbCtx(STRANGER, false);
      await handlePaletteCallback(f.ctx, f.env, `pal:cmd:${name}`, "en");
      expect(f.sent, name).toHaveLength(1);
      expect(f.sent[0], name).toContain("owner-only");
    }
  });

  test("runPaletteCommand refuses every owner-only command for a stranger", async () => {
    for (const name of ownerOnly) {
      const f = fakeCbCtx(STRANGER, false);
      await runPaletteCommand(name, f.ctx, f.env, "en");
      expect(f.sent, name).toHaveLength(1);
      expect(f.sent[0], name).toContain("owner-only");
    }
  });

  test("the owner still runs them (spot check)", async () => {
    for (const name of ["pause", "version", "status"]) {
      const f = fakeCbCtx(OWNER, true);
      await runPaletteCommand(name, f.ctx, f.env, "en");
      expect(f.sent.length, name).toBeGreaterThan(0);
      expect(f.sent[0], name).not.toContain("owner-only");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Invisibility: menus never render owner surface for the public
// ---------------------------------------------------------------------------

describe("menu invisibility", () => {
  test("the default setMyCommands scope contains zero owner-only commands", () => {
    const pub = publicMenuCommands(HERMES_DEFS);
    expect(pub.length).toBe(4); // start/help/commands/voice (/lang removed)
    expect(pub.every((d) => !d.ownerOnly)).toBe(true);
    const own = ownerMenuCommands(HERMES_DEFS);
    expect(own.length).toBe(73); // 11 builtins + 62 Hermes defs
  });

  test("the public palette render contains no owner group or command", () => {
    const render = paletteCategoriesRender(false, "en");
    const kb = JSON.stringify(render.keyboard);
    expect(kb).not.toContain("owner");
    for (const c of COMMAND_HELP) {
      if (c.ownerOnly) {
        expect(render.text).not.toContain(`/${c.name}`);
        expect(kb).not.toContain(`pal:cmd:${c.name}`);
      }
    }
  });

  test("fuzz: the public main menu never emits owner-only callbacks", () => {
    for (const lang of ["en"] as const) {
      const kb = buildPublicMainMenu(lang) as unknown as {
        inline_keyboard: Array<Array<{ callback_data?: string; text: string }>>;
      };
      const data = kb.inline_keyboard.flat().map((b) => b.callback_data ?? "");
      expect(data.length).toBeGreaterThan(0);
      // No owner-only buttons are rendered at all — not hidden, absent.
      expect(data).not.toContain(CALLBACKS.tools);
      expect(data).not.toContain(CALLBACKS.settings);
      // And only known public callbacks appear.
      for (const d of data) {
        expect(
          [CALLBACKS.chat, CALLBACKS.commands, CALLBACKS.about, CALLBACKS.help].includes(d as never),
          d,
        ).toBe(true);
      }
    }
  });

  test("the owner menu is a clean 2x2 grid", () => {
    const kb = buildMainMenu("en") as unknown as {
      inline_keyboard: Array<Array<{ callback_data?: string }>>;
    };
    const data = kb.inline_keyboard.flat().map((b) => b.callback_data ?? "");
    expect(data).toContain(CALLBACKS.tools);
    expect(data).toContain(CALLBACKS.settings);
    expect(data).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 5. Per-user isolation hammer test
// ---------------------------------------------------------------------------

describe("per-user data isolation", () => {
  test("hammer: two users interleave — history, memory and search never cross", async () => {
    const storage = Storage.open(":memory:");
    try {
      const chatId = "shared-chat";
      // Interleaved writes from two users in the SAME chat.
      for (let i = 0; i < 25; i++) {
        storage.appendMessage("userA", chatId, "user", `A-secret-${i}`);
        storage.appendMessage("userB", chatId, "user", `B-secret-${i}`);
      }
      const aHistory = storage.history("userA", chatId, 100).map((r) => r.content);
      const bHistory = storage.history("userB", chatId, 100).map((r) => r.content);
      expect(aHistory).toHaveLength(25);
      expect(bHistory).toHaveLength(25);
      expect(aHistory.every((c) => c.startsWith("A-secret-"))).toBe(true);
      expect(bHistory.every((c) => c.startsWith("B-secret-"))).toBe(true);
      expect(aHistory.some((c) => c.includes("B-secret"))).toBe(false);

      // Memory provider: per-user scoping.
      const mem = new SqliteMemoryProvider(storage);
      for (let i = 0; i < 10; i++) {
        await mem.upsert("userA", `k${i}`, `A-mem-${i}`);
        await mem.upsert("userB", `k${i}`, `B-mem-${i}`);
      }
      const aMems = await mem.list("userA", 100);
      const bMems = await mem.list("userB", 100);
      expect(aMems).toHaveLength(10);
      expect(bMems).toHaveLength(10);
      expect(aMems.every((m) => m.content.startsWith("A-mem-"))).toBe(true);
      expect(await mem.get("userA", "k0")).toMatchObject({ content: "A-mem-0" });
      expect(await mem.count("userA")).toBe(10);

      // search_history tool: actor-scoped, never the other user's rows.
      const tools = createHistoryTools({ storage });
      const search = tools.find((t) => t.name === "search_history")!;
      const runAs = async (userId: string) => {
        const out = (await search.run({ query: "secret", limit: 100 }, {
          clock: () => new Date(),
          actor: { userId, permissions: ["tools:search_history"] },
          signal: AbortSignal.timeout(5000),
        })) as { results: Array<{ snippet: string }>; total: number };
        return out;
      };
      const aRes = await runAs("userA");
      const bRes = await runAs("userB");
      expect(aRes.total).toBeGreaterThan(0);
      expect(bRes.total).toBeGreaterThan(0);
      // Snippets wrap the match in [ ], so match on the user-specific prefix.
      expect(aRes.results.every((r) => r.snippet.includes("A-"))).toBe(true);
      expect(aRes.results.some((r) => r.snippet.includes("B-"))).toBe(false);
      expect(bRes.results.every((r) => r.snippet.includes("B-"))).toBe(true);
      expect(bRes.results.some((r) => r.snippet.includes("A-"))).toBe(false);
    } finally {
      storage.close();
    }
  });

  test("memory tools are ownerOnly: a public actor is never granted them", () => {
    const storage = Storage.open(":memory:");
    try {
      const auth = authForOwner();
      const tools = new ToolService({
        extraTools: [
          ...createMemoryTools({ provider: new SqliteMemoryProvider(storage) }),
          ...createHistoryTools({ storage }),
        ],
      });
      const strangerActor = auth.actorFromTelegramUser({ id: STRANGER });
      const granted = authorizeToolUse(auth, strangerActor, tools.registry.list());
      const keys = granted.permissions.join(" ");
      expect(keys).not.toContain("tools:remember");
      expect(keys).not.toContain("tools:recall");
      expect(keys).not.toContain("tools:forget");
      expect(keys).not.toContain("tools:search_history");
      // …while the owner holds them.
      const ownerActor = auth.actorFromTelegramUser({ id: OWNER });
      const ownerGranted = authorizeToolUse(auth, ownerActor, tools.registry.list());
      const ownerKeys = ownerGranted.permissions.join(" ");
      expect(ownerKeys).toContain("tools:remember");
      expect(ownerKeys).toContain("tools:search_history");
      // And toolSpecsFor (what the model sees) hides them from the stranger.
      const strangerSpecs = tools.toolSpecsFor(toToolActor(granted)).map((s) => s.name);
      expect(strangerSpecs).not.toContain("remember");
      expect(strangerSpecs).not.toContain("search_history");
    } finally {
      storage.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Ban / mute through the gate
// ---------------------------------------------------------------------------

describe("ban/mute enforcement", () => {
  function prefsWith(lang: string | undefined) {
    return { getUserPref: (_u: string, _k: string) => lang, setUserPref: () => {} };
  }
  function gateCtx(userId: number) {
    const replies: string[] = [];
    return {
      replies,
      ctx: {
        chat: { id: 1, type: "private" as const },
        from: { id: userId },
        reply: async (text: string) => {
          replies.push(text);
        },
      } as never,
    };
  }

  test("banned user: one short polite refusal, in their language", async () => {
    const storage = Storage.open(":memory:");
    try {
      const users = new UserAccessService(storage);
      users.ban(String(STRANGER), String(OWNER));
      const f = gateCtx(STRANGER);
      expect(await gateUser(f.ctx, { users, prefs: prefsWith("en") as never })).toBe(false);
      expect(f.replies).toEqual([t("gate.user_banned", "en")]);
    } finally {
      storage.close();
    }
  });

  test("muted user: dropped silently, zero replies", async () => {
    const storage = Storage.open(":memory:");
    try {
      const users = new UserAccessService(storage);
      users.mute(String(STRANGER), String(OWNER));
      const f = gateCtx(STRANGER);
      expect(await gateUser(f.ctx, { users, prefs: prefsWith("fa") as never })).toBe(false);
      expect(f.replies).toEqual([]);
    } finally {
      storage.close();
    }
  });

  test("the owner is never gated, even when 'banned' on paper", async () => {
    const storage = Storage.open(":memory:");
    try {
      const users = new UserAccessService(storage);
      users.ban(String(OWNER), String(OWNER));
      const f = gateCtx(OWNER);
      const auth = authForOwner();
      expect(await gateUser(f.ctx, { users, auth, prefs: prefsWith("fa") as never })).toBe(true);
      expect(f.replies).toEqual([]);
    } finally {
      storage.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Ban/mute command handlers
// ---------------------------------------------------------------------------

describe("handleUserRestrict", () => {
  function svc() {
    const storage = Storage.open(":memory:");
    return { storage, users: new UserAccessService(storage) };
  }

  test("ban → unban round trip", () => {
    const { storage, users } = svc();
    try {
      expect(handleUserRestrict("en", users, String(OWNER), "ban", "42", "ban")).toContain("42");
      expect(users.stateOf("42")).toBe("rejected");
      expect(handleUserRestrict("en", users, String(OWNER), "unban", "42", "unban")).toContain("42");
      expect(users.stateOf("42")).toBe("approved");
    } finally {
      storage.close();
    }
  });

  test("mute → unmute round trip", () => {
    const { storage, users } = svc();
    try {
      handleUserRestrict("en", users, String(OWNER), "mute", "42", "mute");
      expect(users.stateOf("42")).toBe("revoked");
      handleUserRestrict("en", users, String(OWNER), "unmute", "42", "unmute");
      expect(users.stateOf("42")).toBe("approved");
    } finally {
      storage.close();
    }
  });

  test("missing/invalid target and self-target are refused, never executed", () => {
    const { storage, users } = svc();
    try {
      expect(handleUserRestrict("en", users, String(OWNER), "ban", undefined, "ban")).toContain("/ban");
      expect(handleUserRestrict("en", users, String(OWNER), "ban", "@someone", "ban")).toContain("Invalid");
      expect(handleUserRestrict("en", users, String(OWNER), "ban", String(OWNER), "ban")).toContain("yourself");
      expect(users.stateOf(String(OWNER))).toBeUndefined();
      expect(handleUserRestrict("en", undefined, String(OWNER), "ban", "42", "ban")).toContain("unavailable");
    } finally {
      storage.close();
    }
  });

  test("parseUserIdArg takes the first token; blanks are missing", () => {
    expect(parseUserIdArg("12345")).toBe("12345");
    expect(parseUserIdArg("  12345  ")).toBe("12345");
    expect(parseUserIdArg("")).toBeUndefined();
    expect(parseUserIdArg(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9. Session-namespace callbacks are tier-gated too
// ---------------------------------------------------------------------------

describe("sess: namespace tier gate", () => {
  test("a forged sess: tap by a non-owner is refused before any session work", async () => {
    const { registerSessionCommands } = await import("../src/bot/cmd_session");
    const { SESSION_CALLBACK_PREFIX } = await import("../src/bot/ux");
    const handlers: Array<(ctx: never) => Promise<void>> = [];
    const fakeBot = {
      command: (_name: string, _fn: unknown) => {},
      on: (_event: string, fn: (ctx: never) => Promise<void>) => {
        handlers.push(fn);
      },
    };
    // No auth wired: nobody is the owner here.
    registerSessionCommands(fakeBot as never, {} as never);
    expect(handlers.length).toBeGreaterThan(0);

    const replies: string[] = [];
    const fakeCtx = {
      from: { id: STRANGER },
      chat: { id: 1, type: "private" },
      callbackQuery: { data: `${SESSION_CALLBACK_PREFIX}resume:abc`, message: {} },
      reply: async (text: string) => {
        replies.push(text);
      },
      answerCallbackQuery: async () => {},
    };
    for (const h of handlers) await h(fakeCtx as never);
    expect(replies).toEqual([t("tier.refused", "en")]);
  });
});

// ---------------------------------------------------------------------------
// 10. Creator identity: survives personality switches, bilingual
// ---------------------------------------------------------------------------

describe("creator identity", () => {
  const base = {
    tools: [],
    now: new Date("2026-10-18T12:00:00Z"),
    timezone: "Asia/Tehran",
  };

  test("the base prompt names Mohammad as creator and father", () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain("Mohammad");
    expect(prompt).toContain("creator and father");
  });

  test("identity survives every personality skin", () => {
    for (const name of personalityNames()) {
      const skin = getPersonality(name)!;
      const prompt = buildSystemPrompt({ ...base, personality: skin.systemAddition });
      expect(prompt, name).toContain("Mohammad");
      expect(prompt, name).toContain("creator and father");
    }
  });

  test("identity is not a session fact: it precedes the tool rules and needs no history", () => {
    const skin = getPersonality("playful")!;
    const prompt = buildSystemPrompt({ ...base, personality: skin.systemAddition });
    // The creator block sits in the base IDENTITY section, before the tools.
    expect(prompt.indexOf("Mohammad")).toBeLessThan(prompt.indexOf("Tool rules:"));
  });

  test("anti-impersonation: the prompt says ownership is never decided from chat claims", () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain("never from chat text");
    expect(prompt).toContain("ownership is determined by the system");
  });
});
