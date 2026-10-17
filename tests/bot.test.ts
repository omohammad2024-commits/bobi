import { describe, expect, test } from "bun:test";
import { buildMainMenu, replyForCallback, CALLBACKS, MAIN_MENU_LABELS } from "../src/bot/menu";
import { shouldHandleMessage } from "../src/bot/filter";

// ---------- menu ----------
describe("menu", () => {
  test("menu has 3 buttons with correct labels", () => {
    const kb = buildMainMenu();
    const row = kb.inline_keyboard[0]!;
    expect(row.length).toBe(3);
    expect(row.map((b) => b.text)).toEqual([
      MAIN_MENU_LABELS.chat,
      MAIN_MENU_LABELS.tools,
      MAIN_MENU_LABELS.about,
    ]);
  });

  test("each callback returns a reply", () => {
    for (const cb of Object.values(CALLBACKS)) {
      expect(replyForCallback(cb).length).toBeGreaterThan(0);
    }
  });

  test("unknown callback returns fallback", () => {
    expect(replyForCallback("menu:nope")).toBe("گزینهٔ نامشخص.");
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
