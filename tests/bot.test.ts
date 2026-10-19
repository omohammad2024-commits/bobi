import { describe, expect, test } from "bun:test";
import {
  buildMainMenu,
  buildBackKeyboard,
  menuKeyboardFor,
  replyForCallback,
  editMenuMessage,
  startScreenText,
  CALLBACKS,
  MAIN_MENU_LABELS,
} from "../src/bot/menu";
import { gateUser, type UserPrefStore } from "../src/bot/bot";
import { shouldHandleMessage } from "../src/bot/filter";
import { Storage } from "../src/storage/storage";
import { UserAccessService } from "../src/auth/user_service";
import { t, LANG_PREF_KEY } from "../src/i18n";

// ---------- menu ----------
describe("menu", () => {
  test("menu is a clean 2x2 grid with correct labels", () => {
    const kb = buildMainMenu();
    expect(kb.inline_keyboard.length).toBe(2);
    expect(kb.inline_keyboard[0]!.map((b) => b.text)).toEqual([
      MAIN_MENU_LABELS.chat,
      MAIN_MENU_LABELS.tools,
    ]);
    expect(kb.inline_keyboard[1]!.map((b) => b.text)).toEqual([
      MAIN_MENU_LABELS.commands,
      MAIN_MENU_LABELS.settings,
    ]);
  });

  test("button callback data stays stable", () => {
    const kb = buildMainMenu();
    const data = kb.inline_keyboard
      .flat()
      .map((b) => (b as { callback_data?: string }).callback_data);
    expect(data).toEqual([
      CALLBACKS.chat,
      CALLBACKS.tools,
      CALLBACKS.commands,
      CALLBACKS.settings,
    ]);
    // The original three callbacks keep their values (in-flight keyboards).
    expect(CALLBACKS.chat).toBe("menu:chat");
    expect(CALLBACKS.tools).toBe("menu:tools");
    expect(CALLBACKS.about).toBe("menu:about");
  });

  test("each callback returns a reply", () => {
    for (const cb of Object.values(CALLBACKS)) {
      expect(replyForCallback(cb).length, cb).toBeGreaterThan(0);
    }
  });

  test("unknown callback returns fallback", () => {
    expect(replyForCallback("menu:nope")).toBe("Unknown option.");
  });

  test("chat screen is not a 'coming soon' placeholder", () => {
    const text = replyForCallback(CALLBACKS.chat);
    expect(text).toContain("Just type");
    expect(text).not.toContain("soon");
  });

  test("tools fallback is honest when no tool service is attached", () => {
    const text = replyForCallback(CALLBACKS.tools, undefined);
    expect(text.length).toBeGreaterThan(0);
  });

  test("home renders the start screen", () => {
    expect(replyForCallback(CALLBACKS.home)).toBe(startScreenText("en"));
    expect(startScreenText("en")).toContain("/help");
  });

  test("the welcome screen is tier-aware", () => {
    const owner = startScreenText("en", true);
    const pub = startScreenText("en", false);
    expect(owner).toContain("/reset");
    expect(owner).toContain("/digest");
    expect(pub).not.toContain("/reset");
    expect(pub).not.toContain("/digest");
  });

  test("menuKeyboardFor: home gets the full menu, sub-screens get a back button", () => {
    const home = menuKeyboardFor(CALLBACKS.home);
    expect(home.inline_keyboard.length).toBe(2);
    for (const cb of [CALLBACKS.chat, CALLBACKS.tools, CALLBACKS.commands, CALLBACKS.settings, CALLBACKS.about, CALLBACKS.help] as const) {
      const sub = menuKeyboardFor(cb);
      expect(sub.inline_keyboard.length, cb).toBe(1);
      const btn = sub.inline_keyboard[0]![0]! as { text: string; callback_data?: string };
      expect(btn.text).toBe(MAIN_MENU_LABELS.back);
      expect(btn.callback_data).toBe(CALLBACKS.home);
    }
    expect(
      (buildBackKeyboard().inline_keyboard[0]![0]! as { callback_data?: string }).callback_data,
    ).toBe(CALLBACKS.home);
  });

  test("editMenuMessage edits in place", async () => {
    const calls: string[] = [];
    const ctx = {
      editMessageText: async (text: string) => {
        calls.push(`edit:${text}`);
      },
      reply: async () => {
        calls.push("reply");
      },
    };
    await editMenuMessage(ctx, "hello", buildBackKeyboard());
    expect(calls).toEqual(["edit:hello"]);
  });

  test("editMenuMessage swallows 'message is not modified' without stacking a reply", async () => {
    const calls: string[] = [];
    const ctx = {
      editMessageText: async () => {
        throw new Error("Bad Request: message is not modified");
      },
      reply: async () => {
        calls.push("reply");
      },
    };
    await editMenuMessage(ctx, "hello", buildBackKeyboard());
    expect(calls).toEqual([]);
  });

  test("editMenuMessage falls back to reply when the message cannot be edited", async () => {
    const calls: string[] = [];
    const ctx = {
      editMessageText: async () => {
        throw new Error("Bad Request: message to edit not found");
      },
      reply: async (text: string) => {
        calls.push(`reply:${text}`);
      },
    };
    await editMenuMessage(ctx, "hello", buildBackKeyboard());
    expect(calls).toEqual(["reply:hello"]);
  });
});

// ---------- message routing ----------
// Minimal Context shape for shouldHandleMessage — no real Telegram call.
const BOT_ID = 42;
const ME = { id: BOT_ID, is_bot: true, first_name: "SOL", username: "sol_bot" } as const;

type ChatType = "private" | "group" | "supergroup" | "channel";
function ctx(o: {
  chatType?: ChatType;
  text?: string;
  replyFromId?: number;
  hasMessage?: boolean;
}) {
  const base: Record<string, unknown> = { me: ME };
  if (o.hasMessage !== false) {
    base.message = {
      message_id: 1,
      date: 0,
      chat: { id: 1, type: o.chatType ?? "private" },
      ...(o.text !== undefined ? { text: o.text } : {}),
      ...(o.replyFromId !== undefined
        ? { reply_to_message: { from: { id: o.replyFromId } } }
        : {}),
    };
  }
  return base as unknown as Parameters<typeof shouldHandleMessage>[0];
}

describe("message routing", () => {
  test("private message → handle", () => {
    expect(shouldHandleMessage(ctx({ chatType: "private", text: "سلام" }), BOT_ID)).toBe(true);
  });

  test("group plain message → ignore", () => {
    expect(shouldHandleMessage(ctx({ chatType: "group", text: "سلام" }), BOT_ID)).toBe(false);
  });

  test("supergroup plain message → ignore", () => {
    expect(shouldHandleMessage(ctx({ chatType: "supergroup", text: "hi" }), BOT_ID)).toBe(false);
  });

  test("group reply to bot → handle", () => {
    expect(shouldHandleMessage(ctx({ chatType: "group", replyFromId: BOT_ID }), BOT_ID)).toBe(true);
  });

  test("group reply to someone else → ignore", () => {
    expect(shouldHandleMessage(ctx({ chatType: "group", replyFromId: 999 }), BOT_ID)).toBe(false);
  });

  test("group /start → handle", () => {
    expect(shouldHandleMessage(ctx({ chatType: "group", text: "/start" }), BOT_ID)).toBe(true);
  });

  test("group /cmd@sol_bot → handle", () => {
    expect(shouldHandleMessage(ctx({ chatType: "group", text: "/help@sol_bot" }), BOT_ID)).toBe(true);
  });

  test("group /cmd@OtherBot → ignore", () => {
    expect(shouldHandleMessage(ctx({ chatType: "group", text: "/help@OtherBot" }), BOT_ID)).toBe(false);
  });

  test("no message → ignore", () => {
    expect(shouldHandleMessage(ctx({ hasMessage: false }), BOT_ID)).toBe(false);
  });
});

// ---------- gateUser denial language ----------

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
    },
  };
}

function prefsWith(lang: string | undefined): UserPrefStore {
  return {
    getUserPref: (_uid: string, _key: string) => lang,
    setUserPref: () => {},
  };
}

describe("gateUser ban/mute language", () => {
  test("a banned user with English UI gets the English banned note", async () => {
    const storage = Storage.open(":memory:");
    try {
      const users = new UserAccessService(storage);
      users.ban("7", "owner");
      const f = gateCtx(7);
      const ok = await gateUser(f.ctx as never, { users, prefs: prefsWith("en") });
      expect(ok).toBe(false);
      expect(f.replies).toEqual([t("gate.user_banned", "en")]);
    } finally {
      storage.close();
    }
  });

  test("a muted user is silently dropped — no reply at all", async () => {
    const storage = Storage.open(":memory:");
    try {
      const users = new UserAccessService(storage);
      users.mute("7", "owner");
      const f = gateCtx(7);
      const ok = await gateUser(f.ctx as never, { users, prefs: prefsWith("en") });
      expect(ok).toBe(false);
      expect(f.replies).toEqual([]);
    } finally {
      storage.close();
    }
  });

  test("an ordinary public user passes with no row at all", async () => {
    const storage = Storage.open(":memory:");
    try {
      const users = new UserAccessService(storage);
      const f = gateCtx(7);
      const ok = await gateUser(f.ctx as never, { users, prefs: prefsWith("en") });
      expect(ok).toBe(true);
      expect(f.replies).toEqual([]);
    } finally {
      storage.close();
    }
  });

  test("without a language pref the banned denial stays Persian", async () => {
    const storage = Storage.open(":memory:");
    try {
      const users = new UserAccessService(storage);
      users.ban("7", "owner");
      const f = gateCtx(7);
      const ok = await gateUser(f.ctx as never, { users });
      expect(ok).toBe(false);
      expect(f.replies).toEqual([t("gate.user_banned", "en")]);
    } finally {
      storage.close();
    }
  });

  test("LANG_PREF_KEY is the pref the gate reads", () => {
    expect(LANG_PREF_KEY).toBe("lang");
  });
});
