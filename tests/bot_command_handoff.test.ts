import { describe, expect, test } from "bun:test";
import { Bot } from "grammy";

/**
 * Regression test for the Oct 18, 2026 outage where NONE of the 53
 * Hermes-parity commands (/model, /history, ...) responded.
 *
 * Root cause: in production, createBot() registers the `message:text`
 * middleware FIRST and the Hermes commands are registered AFTER it
 * (registerSessionCommands / registerSystemCommands / registerAutoCommands
 * in index.ts). The old message:text handler swallowed every "/" message
 * with `return` and never called next(), so downstream command handlers
 * never ran. The fix hands "/" messages off via next(); unknown commands
 * still match nothing downstream and stay silent.
 */
function testBot() {
  const bot = new Bot("123:fake", {
    botInfo: {
      id: 123,
      is_bot: true,
      first_name: "T",
      username: "t_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
  });
  return bot;
}

function commandUpdate(text: string) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: 1, type: "private" },
      from: { id: 7, is_bot: false, first_name: "U" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }],
    },
  } as any;
}

describe("command handoff past message:text middleware", () => {
  test("a command registered AFTER message:text runs when it hands off via next()", async () => {
    const bot = testBot();
    const calls: string[] = [];
    // Production pattern from src/bot/bot.ts (fixed version).
    bot.on("message:text", async (ctx, next) => {
      const text = ctx.message.text;
      if (text.startsWith("/")) return await next();
      calls.push("message:text");
    });
    // Production pattern from src/index.ts: Hermes commands register later.
    bot.command("model", async () => {
      calls.push("command:model");
    });
    await bot.handleUpdate(commandUpdate("/model"));
    expect(calls).toEqual(["command:model"]);
  });

  test("unknown commands stay silent (no downstream match, no crash)", async () => {
    const bot = testBot();
    const calls: string[] = [];
    bot.on("message:text", async (ctx, next) => {
      const text = ctx.message.text;
      if (text.startsWith("/")) return await next();
      calls.push("message:text");
    });
    bot.command("model", async () => {
      calls.push("command:model");
    });
    await bot.handleUpdate(commandUpdate("/nope"));
    expect(calls).toEqual([]);
  });

  test("plain text still reaches the message handler, not the command chain", async () => {
    const bot = testBot();
    const calls: string[] = [];
    bot.on("message:text", async (ctx, next) => {
      const text = ctx.message.text;
      if (text.startsWith("/")) return await next();
      calls.push("message:text");
    });
    bot.command("model", async () => {
      calls.push("command:model");
    });
    await bot.handleUpdate(commandUpdate("سلام"));
    expect(calls).toEqual(["message:text"]);
  });
});
