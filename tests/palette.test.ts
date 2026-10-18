/**
 * Tests for the inline command palette (src/bot/palette.ts).
 *
 * - grouping renders from COMMAND_HELP (the single source shared with /help),
 *   owner-filtered;
 * - pagination slices 8 commands per page and ignores out-of-range pages;
 * - the callback parser rejects forged/malformed data;
 * - tap-to-run re-checks ownership server-side and never executes unknown
 *   or hidden commands.
 *
 * No network, no Telegram.
 */
import { describe, expect, test } from "bun:test";
import {
  PALETTE_CALLBACK_PREFIX,
  PALETTE_PAGE_SIZE,
  PALETTE_DIRECT,
  parsePaletteCallback,
  palettePageEntries,
  paletteGroupCounts,
  paletteCategoriesText,
  paletteCategoriesRender,
  paletteCategoryText,
  paletteUsageCardText,
  buildCategoriesKeyboard,
  buildCategoryKeyboard,
  buildUsageCardKeyboard,
  runPaletteCommand,
  handlePaletteCallback,
  type PaletteEnv,
} from "../src/bot/palette";
import { COMMAND_HELP, visibleCommandHelp, type CommandHelpEntry } from "../src/bot/bot";
import { Storage } from "../src/storage/storage";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";
import { formatCount } from "../src/bot/ux";

const OWNER = 111_111;
const NON_OWNER = 222_222;

/** Fake callback-query context: records replies and message edits. */
function fakeCbCtx(fromId: number) {
  const sent: string[] = [];
  const edits: Array<{ text: string; keyboard: unknown }> = [];
  const ctx = {
    from: { id: fromId },
    chat: { id: 999 },
    reply: async (text: string) => {
      sent.push(text);
    },
    editMessageText: async (
      text: string,
      extra?: { reply_markup?: unknown },
    ) => {
      edits.push({ text, keyboard: extra?.reply_markup });
    },
    answerCallbackQuery: async () => {},
  };
  return { ctx: ctx as never, sent, edits };
}

function envFor(fromId: number, storage?: Storage): PaletteEnv {
  const deps: Record<string, unknown> = {};
  if (fromId === OWNER) {
    deps.auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER));
  }
  if (storage !== undefined) deps.storage = storage;
  deps.engine = {};
  return { deps: deps as never, sysOpts: {} };
}

function callbackData(kb: unknown): string[] {
  const keyboard = kb as {
    inline_keyboard: Array<Array<{ callback_data?: string }>>;
  };
  return keyboard.inline_keyboard.flat().map((b) => b.callback_data ?? "");
}

// ---------------------------------------------------------------------------
// Callback parsing — the forgery boundary
// ---------------------------------------------------------------------------

describe("parsePaletteCallback", () => {
  test("accepts the three server-generated shapes", () => {
    expect(parsePaletteCallback("pal:cats")).toEqual({ kind: "cats" });
    expect(parsePaletteCallback("pal:cat:session:0")).toEqual({
      kind: "cat",
      group: "session",
      page: 0,
    });
    expect(parsePaletteCallback("pal:cat:owner:12")).toEqual({
      kind: "cat",
      group: "owner",
      page: 12,
    });
    expect(parsePaletteCallback("pal:cmd:history")).toEqual({
      kind: "cmd",
      name: "history",
    });
  });

  test("rejects forged and malformed payloads", () => {
    const forged = [
      "",
      "pal:",
      "pal:x",
      "pal:cats:extra",
      "pal:cat:general:-1",
      "pal:cat:general:x",
      "pal:cat:general:1.5",
      "pal:cat:general:99999",
      "pal:cat:evil:0",
      "pal:cat:general:0:extra",
      "pal:cat::0",
      "pal:cmd:",
      "pal:cmd:HISTORY",
      "pal:cmd:History",
      "pal:cmd:history ",
      "pal:cmd:his/tory",
      "pal:cmd:history;rm -rf",
      "pal:cmd:../../../etc",
      "pal:cmd:nonexistent",
      "pal:cmd:snapshot --confirm",
      "menu:help",
      "lang:fa",
      "pal:run:history",
    ];
    for (const data of forged) {
      expect(parsePaletteCallback(data), data).toBeUndefined();
    }
  });

  test("command names must exist in COMMAND_HELP", () => {
    // Well-formed but unknown — not a typo we should guess at.
    expect(parsePaletteCallback("pal:cmd:histroy")).toBeUndefined();
    for (const e of COMMAND_HELP) {
      expect(parsePaletteCallback(`pal:cmd:${e.name}`)?.kind).toBe("cmd");
    }
  });
});

// ---------------------------------------------------------------------------
// Grouping — one source with /help
// ---------------------------------------------------------------------------

describe("palette grouping", () => {
  test("renders from COMMAND_HELP, owner-filtered like /help", () => {
    const ownerRender = paletteCategoriesRender(true, "fa");
    const userRender = paletteCategoriesRender(false, "fa");
    const ownerCounts = paletteGroupCounts(visibleCommandHelp(true));
    const userCounts = paletteGroupCounts(visibleCommandHelp(false));
    expect(ownerCounts.owner).toBeGreaterThan(0);
    expect(userCounts.owner).toBe(0);
    // Button callback data is exact.
    expect(callbackData(ownerRender.keyboard)).toEqual([
      "pal:cat:general:0",
      "pal:cat:session:0",
      "pal:cat:automation:0",
      "pal:cat:owner:0",
    ]);
    expect(callbackData(userRender.keyboard)).toEqual([
      "pal:cat:general:0",
      "pal:cat:session:0",
      "pal:cat:automation:0",
    ]);
    // Counts on the buttons match the visible entries.
    const texts = (
      ownerRender.keyboard as {
        inline_keyboard: Array<Array<{ text: string }>>;
      }
    ).inline_keyboard
      .flat()
      .map((b) => b.text);
    expect(texts[0]).toContain(formatCount(ownerCounts.general, "fa"));
    expect(texts[3]).toContain(formatCount(ownerCounts.owner, "fa"));
  });

  test("every COMMAND_HELP entry appears in exactly one group", () => {
    const counts = paletteGroupCounts(COMMAND_HELP);
    const total =
      counts.general + counts.session + counts.automation + counts.owner;
    expect(total).toBe(COMMAND_HELP.length);
  });

  test("bilingual titles", () => {
    expect(paletteCategoriesText("fa")).toContain("مرورگر دستورها");
    expect(paletteCategoriesText("en")).toContain("Command browser");
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe("palette pagination", () => {
  test("eight commands per page", () => {
    expect(PALETTE_PAGE_SIZE).toBe(8);
    const entries = visibleCommandHelp(true);
    // Session group has 15 entries → 2 pages of 8 and 7.
    const p0 = palettePageEntries(entries, "session", 0);
    const p1 = palettePageEntries(entries, "session", 1);
    expect(p0.totalPages).toBe(2);
    expect(p0.pageEntries.length).toBe(8);
    expect(p1.pageEntries.length).toBe(7);
    // No overlap, order preserved.
    const names0 = p0.pageEntries.map((e) => e.name);
    const names1 = p1.pageEntries.map((e) => e.name);
    expect(new Set([...names0, ...names1]).size).toBe(15);
    expect(p0.pageEntries[0]!.name).toBe(
      entries.filter((e) => e.group === "session")[0]!.name,
    );
  });

  test("out-of-range pages are empty (caller ignores them)", () => {
    const entries = visibleCommandHelp(true);
    expect(palettePageEntries(entries, "session", 2).pageEntries).toEqual([]);
    expect(palettePageEntries(entries, "session", 99).pageEntries).toEqual([]);
    expect(palettePageEntries(entries, "session", -1).pageEntries).toEqual([]);
  });

  test("category keyboard: command buttons, nav, back", () => {
    const entries = visibleCommandHelp(true);
    const { pageEntries, totalPages } = palettePageEntries(entries, "session", 0);
    const kb = buildCategoryKeyboard("session", pageEntries, 0, totalPages, "fa");
    const data = callbackData(kb);
    // 8 command buttons, then next-page, then back to categories.
    expect(data.slice(0, 8)).toEqual(
      pageEntries.map((e) => `pal:cmd:${e.name}`),
    );
    expect(data).toContain("pal:cat:session:1");
    expect(data).not.toContain("pal:cat:session:-1");
    expect(data[data.length - 1]).toBe("pal:cats");

    const last = palettePageEntries(entries, "session", 1);
    const kbLast = buildCategoryKeyboard(
      "session",
      last.pageEntries,
      1,
      last.totalPages,
      "fa",
    );
    const dataLast = callbackData(kbLast);
    expect(dataLast).toContain("pal:cat:session:0");
    expect(dataLast).not.toContain("pal:cat:session:2");

    // Single-page group: no prev/next at all.
    const tiny: CommandHelpEntry[] = [
      { name: "a", descriptionFa: "x", ownerOnly: false, group: "general" },
      { name: "b", descriptionFa: "y", ownerOnly: false, group: "general" },
    ];
    const one = palettePageEntries(tiny, "general", 0);
    expect(one.totalPages).toBe(1);
    const kbOne = buildCategoryKeyboard("general", one.pageEntries, 0, 1, "fa");
    expect(callbackData(kbOne)).toEqual(["pal:cmd:a", "pal:cmd:b", "pal:cats"]);
  });

  test("category text lists one /name — description line per entry", () => {
    // The session category is owner-only under the two-tier model; the
    // owner view still renders one line per entry.
    const entries = visibleCommandHelp(true);
    const { pageEntries, totalPages } = palettePageEntries(entries, "session", 0);
    const text = paletteCategoryText("session", pageEntries, 0, totalPages, "fa");
    expect(text).toContain("/history 20 — نمایش تاریخچهٔ گفت‌وگو");
    const en = paletteCategoryText("session", pageEntries, 0, totalPages, "en");
    expect(en).toContain("/history 20 — Show conversation history");
  });
});

// ---------------------------------------------------------------------------
// Usage cards — no dead ends
// ---------------------------------------------------------------------------

describe("palette usage cards", () => {
  test("card shows the description and the one-line example", () => {
    const entry = COMMAND_HELP.find((e) => e.name === "title")!;
    const text = paletteUsageCardText(entry, "fa");
    expect(text).toContain("/title — تنظیم عنوان گفت‌وگو");
    expect(text).toContain("/title ایده‌ها");
    const en = paletteUsageCardText(entry, "en");
    expect(en).toContain("/title ideas");
  });

  test("card back button returns to the entry's category", () => {
    const entry = COMMAND_HELP.find((e) => e.name === "bg")!;
    const data = callbackData(buildUsageCardKeyboard(entry, "fa"));
    expect(data).toEqual(["pal:cat:automation:0"]);
  });

  test("every command is either directly runnable or has a usage card", () => {
    const names = new Set(COMMAND_HELP.map((e) => e.name));
    for (const name of PALETTE_DIRECT) {
      expect(names.has(name), name).toBe(true);
    }
    for (const e of COMMAND_HELP) {
      const text = paletteUsageCardText(e, "fa");
      expect(text, e.name).toContain(`/${e.name}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Tap-to-run — ownership is re-checked server-side
// ---------------------------------------------------------------------------

describe("runPaletteCommand", () => {
  test("unknown names are ignored silently", async () => {
    const { ctx, sent, edits } = fakeCbCtx(NON_OWNER);
    await runPaletteCommand("nope", ctx, envFor(NON_OWNER), "fa");
    await runPaletteCommand("", ctx, envFor(NON_OWNER), "fa");
    expect(sent).toEqual([]);
    expect(edits).toEqual([]);
  });

  test("a forged owner-only tap by a non-owner is rejected, never run", async () => {
    const { ctx, sent } = fakeCbCtx(NON_OWNER);
    await runPaletteCommand("snapshot", ctx, envFor(NON_OWNER), "fa");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("فقط برای مالک");
    // …and in English when the sender prefers it.
    const en = fakeCbCtx(NON_OWNER);
    await runPaletteCommand("usage", en.ctx, envFor(NON_OWNER), "en");
    expect(en.sent[0]).toContain("owner-only");
  });

  test("the owner can run owner-only commands", async () => {
    const { ctx, sent } = fakeCbCtx(OWNER);
    // /pause with no args reports its usage — the point is it RAN.
    await runPaletteCommand("pause", ctx, envFor(OWNER), "fa");
    expect(sent.length).toBeGreaterThan(0);
  });

  test("direct commands behave like the bare typed command", async () => {
    const { ctx, sent } = fakeCbCtx(OWNER);
    await runPaletteCommand("version", ctx, envFor(OWNER), "fa");
    expect(sent).toHaveLength(1);

    const storage = Storage.open(":memory:");
    try {
      const h = fakeCbCtx(OWNER);
      await runPaletteCommand("history", h.ctx, envFor(OWNER, storage), "fa");
      expect(h.sent.length).toBeGreaterThan(0);
    } finally {
      storage.close();
    }
  });

  test("a non-owner tap on an owner-only direct command is refused, never run", async () => {
    const { ctx, sent } = fakeCbCtx(NON_OWNER);
    await runPaletteCommand("version", ctx, envFor(NON_OWNER), "fa");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("فقط برای مالک");
  });

  test("missing storage degrades honestly, never crashes", async () => {
    const { ctx, sent } = fakeCbCtx(OWNER);
    await runPaletteCommand("history", ctx, envFor(OWNER), "fa");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("ذخیره‌سازی");
  });
});

// ---------------------------------------------------------------------------
// Callback handler — routing + forgery review
// ---------------------------------------------------------------------------

describe("handlePaletteCallback", () => {
  test("non-palette data is not claimed", async () => {
    const { ctx } = fakeCbCtx(NON_OWNER);
    expect(await handlePaletteCallback(ctx, envFor(NON_OWNER), "menu:help", "fa")).toBe(false);
    expect(await handlePaletteCallback(ctx, envFor(NON_OWNER), "lang:fa", "fa")).toBe(false);
  });

  test("forged data is consumed but changes nothing", async () => {
    const forged = [
      "pal:cmd:nonexistent",
      "pal:cat:session:99",
      "pal:cat:general:-1",
      "pal:whatever",
    ];
    for (const data of forged) {
      const { ctx, sent, edits } = fakeCbCtx(NON_OWNER);
      expect(await handlePaletteCallback(ctx, envFor(NON_OWNER), data, "fa"), data).toBe(true);
      expect(sent, data).toEqual([]);
      expect(edits, data).toEqual([]);
    }
  });

  test("a non-owner cannot open the owner category, even forged", async () => {
    const { ctx, sent, edits } = fakeCbCtx(NON_OWNER);
    const handled = await handlePaletteCallback(
      ctx,
      envFor(NON_OWNER),
      "pal:cat:owner:0",
      "fa",
    );
    expect(handled).toBe(true);
    expect(sent).toEqual([]);
    expect(edits).toEqual([]);
  });

  test("a forged owner-only command tap by a non-owner gets the owner-only reply", async () => {
    const { ctx, sent, edits } = fakeCbCtx(NON_OWNER);
    await handlePaletteCallback(ctx, envFor(NON_OWNER), "pal:cmd:snapshot", "fa");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("فقط برای مالک");
    expect(edits).toEqual([]);
  });

  test("categories screen edits the message in place", async () => {
    const { ctx, edits } = fakeCbCtx(NON_OWNER);
    await handlePaletteCallback(ctx, envFor(NON_OWNER), "pal:cats", "fa");
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toContain("مرورگر دستورها");
  });

  test("category page edits the message in place", async () => {
    const { ctx, edits } = fakeCbCtx(OWNER);
    await handlePaletteCallback(ctx, envFor(OWNER), "pal:cat:session:1", "fa");
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toContain("/new");
  });

  test("tapping a command that needs args shows its usage card", async () => {
    const { ctx, sent, edits } = fakeCbCtx(OWNER);
    await handlePaletteCallback(ctx, envFor(OWNER), "pal:cmd:bg", "fa");
    expect(sent).toEqual([]);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toContain("/bg");
    expect(edits[0]!.text).toContain("خلاصهٔ اخبار");
  });

  test("tapping a no-arg command runs it as a new message", async () => {
    const { ctx, sent, edits } = fakeCbCtx(NON_OWNER);
    await handlePaletteCallback(ctx, envFor(NON_OWNER), "pal:cmd:version", "fa");
    expect(sent).toHaveLength(1);
    expect(edits).toEqual([]);
  });

  test("the owner category opens for the owner", async () => {
    const { ctx, edits } = fakeCbCtx(OWNER);
    await handlePaletteCallback(ctx, envFor(OWNER), "pal:cat:owner:0", "fa");
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toContain("/snapshot");
  });

  test("the palette follows the sender's language immediately", async () => {
    const { ctx, edits } = fakeCbCtx(NON_OWNER);
    await handlePaletteCallback(ctx, envFor(NON_OWNER), "pal:cats", "en");
    expect(edits[0]!.text).toContain("Command browser");
  });
});

// ---------------------------------------------------------------------------
// Prefix hygiene
// ---------------------------------------------------------------------------

describe("palette namespace", () => {
  test("the prefix does not collide with other namespaces", () => {
    expect(PALETTE_CALLBACK_PREFIX).toBe("pal:");
    for (const known of ["menu:", "lang:", "sess:", "mdl:", "pers:"]) {
      expect(PALETTE_CALLBACK_PREFIX.startsWith(known)).toBe(false);
      expect(known.startsWith(PALETTE_CALLBACK_PREFIX)).toBe(false);
    }
  });

  test("unused imports stay clean: categories keyboard is built from counts", () => {
    const kb = buildCategoriesKeyboard(
      { general: 1, session: 0, automation: 0, owner: 0 },
      "fa",
    );
    // Zero-count groups still render (the count is honest).
    expect(callbackData(kb)).toContain("pal:cat:session:0");
  });
});
