import { describe, expect, test } from "bun:test";
import { Bot } from "grammy";

/**
 * Regression test for the callback-chain outage class fixed during the UI
 * upgrade (same root cause as the /model command outage of Oct 18, 2026):
 * a `callback_query:data` middleware registered FIRST that never calls
 * next() silently kills every callback handler registered AFTER it
 * (sess:, mdl:, pers: namespaces).
 *
 * Production bot.ts now ends its callback router with `await next()` so
 * downstream namespace handlers run; the loading spinner is still stopped
 * when nothing downstream matches.
 */
function testBot() {
  return new Bot("123:fake", {
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
}

function callbackUpdate(data: string) {
  return {
    update_id: 1,
    callback_query: {
      id: "q1",
      from: { id: 7, is_bot: false, first_name: "U" },
      chat_instance: "x",
      data,
    },
  } as any;
}

describe("callback handoff past the main callback router", () => {
  test("a namespaced handler registered AFTER the router runs via next()", async () => {
    const bot = testBot();
    const calls: string[] = [];
    // Production pattern from src/bot/bot.ts (fixed version).
    bot.on("callback_query:data", async (ctx, next) => {
      const data = ctx.callbackQuery.data;
      if (data === "menu:chat") {
        calls.push("router:menu");
        await ctx.answerCallbackQuery().catch(() => undefined);
        return;
      }
      await next();
      await ctx.answerCallbackQuery().catch(() => undefined);
    });
    // Production pattern from the cmd modules: namespace handlers register later.
    bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (!data.startsWith("sess:")) return;
      calls.push("ns:sess");
      await ctx.answerCallbackQuery().catch(() => undefined);
    });
    await bot.handleUpdate(callbackUpdate("sess:resume:abc"));
    expect(calls).toEqual(["ns:sess"]);
  });

  test("router-owned callbacks still short-circuit before next()", async () => {
    const bot = testBot();
    const calls: string[] = [];
    bot.on("callback_query:data", async (ctx, next) => {
      const data = ctx.callbackQuery.data;
      if (data === "menu:chat") {
        calls.push("router:menu");
        await ctx.answerCallbackQuery().catch(() => undefined);
        return;
      }
      await next();
      await ctx.answerCallbackQuery().catch(() => undefined);
    });
    bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (!data.startsWith("sess:")) return;
      calls.push("ns:sess");
      await ctx.answerCallbackQuery().catch(() => undefined);
    });
    await bot.handleUpdate(callbackUpdate("menu:chat"));
    expect(calls).toEqual(["router:menu"]);
  });

  test("unknown callback data is answered and stays silent", async () => {
    const bot = testBot();
    const calls: string[] = [];
    let answered = 0;
    bot.on("callback_query:data", async (ctx, next) => {
      await next();
      answered++;
      await ctx.answerCallbackQuery().catch(() => undefined);
    });
    await bot.handleUpdate(callbackUpdate("junk:xyz"));
    expect(calls).toEqual([]);
    expect(answered).toBe(1);
  });
});
