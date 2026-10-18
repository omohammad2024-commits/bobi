/**
 * Tests for the COMMAND-UX chunk:
 * - `src/bot/ux.ts`: withTyping, progressMessage, TOOL_PROGRESS_LABELS,
 *   the sess:/mdl:/pers: callback namespaces + keyboard builders,
 * - the destructive two-step confirmations (/new, /queue clear,
 *   /goal clear, /subgoal clear),
 * - the sess: tap-to-resume callback (forgery rejection + happy path),
 * - the mdl: quick-switch callback (validation + enablement checks),
 * - /whoami's generated command list.
 *
 * All through exported functions with stub contexts — no Telegram, no network.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  withTyping,
  progressMessage,
  TOOL_PROGRESS_LABELS,
  toolProgressLabel,
  parseSessionResumeCallback,
  parseModelSwitchCallback,
  parsePersonalityCallback,
  buildSessionsKeyboard,
  buildModelKeyboard,
  buildPersonalityKeyboard,
  truncateLabel,
  type ProgressCtx,
  type TypingCtx,
} from "../src/bot/ux";
import {
  hasConfirmFlag,
  handleSessionResumeCallback,
  handleWhoamiCommand,
  type SessionCallbackCtx,
} from "../src/bot/cmd_session";
import { handleQueue, clearQueuesForTests } from "../src/bot/cmd_auto";
import {
  handleModelSwitchCallback,
  type ModelCallbackCtx,
  type ModelSwitchStorage,
} from "../src/bot/cmd_system";
import type { Storage } from "../src/storage/storage";
import type { UserPrefStore } from "../src/bot/bot";

// ---------------------------------------------------------------------------
// withTyping
// ---------------------------------------------------------------------------

function typingCtx(): { ctx: TypingCtx; actions: string[] } {
  const actions: string[] = [];
  const ctx: TypingCtx = {
    chat: { id: 123 },
    api: {
      sendChatAction: async (chatId, action) => {
        actions.push(`${String(chatId)}:${action}`);
        return undefined;
      },
    },
  };
  return { ctx, actions };
}

describe("withTyping", () => {
  test("sends typing and returns the fn value", async () => {
    const { ctx, actions } = typingCtx();
    const out = await withTyping(ctx, async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 42;
    });
    expect(out).toBe(42);
    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions[0]).toBe("123:typing");
  });

  test("without a chat id the fn just runs", async () => {
    const { ctx } = typingCtx();
    const actions: string[] = [];
    const noChat: TypingCtx = {
      api: {
        sendChatAction: async () => {
          actions.push("x");
          return undefined;
        },
      },
    };
    void ctx;
    const out = await withTyping(noChat, async () => "ok");
    expect(out).toBe("ok");
    expect(actions).toHaveLength(0);
  });

  test("a refusing chat action stops the heartbeat but not the fn", async () => {
    let calls = 0;
    const ctx: TypingCtx = {
      chat: { id: 1 },
      api: {
        sendChatAction: async () => {
          calls++;
          throw new Error("blocked");
        },
      },
    };
    const out = await withTyping(ctx, async () => "done");
    expect(out).toBe("done");
    expect(calls).toBe(1);
  });

  test("fn errors propagate", async () => {
    const { ctx } = typingCtx();
    await expect(
      withTyping(ctx, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

// ---------------------------------------------------------------------------
// progressMessage
// ---------------------------------------------------------------------------

interface ProgressProbe {
  ctx: ProgressCtx;
  replies: string[];
  edits: Array<{ chatId: number | string; messageId: number; text: string }>;
  deleted: number[];
}

function progressProbe(): ProgressProbe {
  const replies: string[] = [];
  const edits: ProgressProbe["edits"] = [];
  const deleted: number[] = [];
  let nextId = 1;
  const ctx: ProgressCtx = {
    chat: { id: 7 },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: nextId++ };
    },
    api: {
      editMessageText: async (chatId, messageId, text) => {
        edits.push({ chatId, messageId, text });
        return undefined;
      },
      deleteMessage: async (_chatId, messageId) => {
        deleted.push(messageId);
        return undefined;
      },
    },
  };
  return { ctx, replies, edits, deleted };
}

describe("progressMessage", () => {
  test("posts once and edits in place", async () => {
    const { ctx, replies, edits } = progressProbe();
    const p = await progressMessage(ctx, "در حال کار…");
    expect(p.posted).toBe(true);
    expect(replies).toEqual(["در حال کار…"]);
    await p.update("مرحلهٔ ۲…");
    expect(edits).toEqual([{ chatId: 7, messageId: 1, text: "مرحلهٔ ۲…" }]);
  });

  test("deliver edits the first chunk and sends the overflow", async () => {
    const { ctx, edits } = progressProbe();
    const p = await progressMessage(ctx, "working");
    const sent: string[] = [];
    const long = "x".repeat(5000);
    await p.deliver(long, async (c) => {
      sent.push(c);
    });
    expect(edits).toHaveLength(1);
    expect(edits[0]!.messageId).toBe(1);
    expect(edits[0]!.text.length).toBeLessThanOrEqual(4096);
    expect(sent).toHaveLength(1);
    expect(edits[0]!.text.length + sent[0]!.length).toBe(5000);
  });

  test("deliver on a short text edits in place, nothing extra sent", async () => {
    const { ctx, edits } = progressProbe();
    const p = await progressMessage(ctx, "working");
    const sent: string[] = [];
    await p.deliver("تمام شد ✅", async (c) => {
      sent.push(c);
    });
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toBe("تمام شد ✅");
    expect(sent).toHaveLength(0);
  });

  test("when the post failed, everything goes through send", async () => {
    const sent: string[] = [];
    const ctx: ProgressCtx = {
      chat: { id: 7 },
      reply: async () => {
        throw new Error("blocked");
      },
      api: {
        editMessageText: async () => undefined,
        deleteMessage: async () => undefined,
      },
    };
    const p = await progressMessage(ctx, "working");
    expect(p.posted).toBe(false);
    await p.deliver("نتیجه", async (c) => {
      sent.push(c);
    });
    expect(sent).toEqual(["نتیجه"]);
  });

  test("a refused edit falls back to plain sends, nothing is lost", async () => {
    const { ctx } = progressProbe();
    const p = await progressMessage(ctx, "working");
    const failing: ProgressCtx = {
      ...ctx,
      api: {
        editMessageText: async () => {
          throw new Error("rate limited");
        },
        deleteMessage: async () => undefined,
      },
    };
    // Rebuild on the failing api to simulate a mid-run refusal.
    const p2 = await progressMessage(failing, "working");
    const sent: string[] = [];
    await p2.deliver("نتیجه", async (c) => {
      sent.push(c);
    });
    expect(sent).toEqual(["نتیجه"]);
    void p;
  });

  test("finish deletes the status message", async () => {
    const { ctx, deleted } = progressProbe();
    const p = await progressMessage(ctx, "working");
    await p.finish();
    expect(deleted).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// TOOL_PROGRESS_LABELS
// ---------------------------------------------------------------------------

const ALL_KNOWN_TOOLS = [
  "calculator",
  "date_time",
  "text_utilities",
  "unit_converter",
  "fetch_url",
  "web_search",
  "remember",
  "recall",
  "forget",
  "remind_at",
  "list_reminders",
  "cancel_reminder",
  "search_history",
  "note_followup",
  "list_nudges",
  "ack_nudge",
  "snooze_nudge",
  "add_goal",
  "list_goals",
  "complete_goal",
  "schedule_task",
  "list_tasks",
  "cancel_task",
  "usage_report",
  "build_digest",
  "curate_memories",
  "curator_decide",
  "skills",
  "tool_search",
  "delegate",
  "consult_models",
  "generate_image",
  "generate_video",
];

describe("TOOL_PROGRESS_LABELS", () => {
  test("covers every known tool in fa and en", () => {
    for (const name of ALL_KNOWN_TOOLS) {
      expect(TOOL_PROGRESS_LABELS.fa[name], `fa:${name}`).toBeTruthy();
      expect(TOOL_PROGRESS_LABELS.en[name], `en:${name}`).toBeTruthy();
    }
  });

  test("toolProgressLabel falls back to the raw name for dynamic tools", () => {
    expect(toolProgressLabel("fa", "mcp_server__some_tool")).toBe(
      "mcp_server__some_tool",
    );
    expect(toolProgressLabel("en", "calculator")).toBe("calculating");
    expect(toolProgressLabel("fa", "delegate")).toBe("سپردن به ایجنت");
  });
});

// ---------------------------------------------------------------------------
// hasConfirmFlag
// ---------------------------------------------------------------------------

describe("hasConfirmFlag", () => {
  test("needs the exact --confirm token", () => {
    expect(hasConfirmFlag(undefined)).toBe(false);
    expect(hasConfirmFlag("")).toBe(false);
    expect(hasConfirmFlag("--confirm")).toBe(true);
    expect(hasConfirmFlag("clear --confirm")).toBe(true);
    expect(hasConfirmFlag("--CONFIRM")).toBe(true);
    // Near-misses must NOT count: no smuggled consent.
    expect(hasConfirmFlag("--confirmx")).toBe(false);
    expect(hasConfirmFlag("--confirmation")).toBe(false);
    expect(hasConfirmFlag("--confirm!")).toBe(false);
    expect(hasConfirmFlag("x--confirm")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// callback namespaces: parsers
// ---------------------------------------------------------------------------

describe("callback parsers", () => {
  test("parseSessionResumeCallback", () => {
    expect(parseSessionResumeCallback("sess:resume:12345")).toBe("12345");
    expect(parseSessionResumeCallback("sess:resume:-123:branch_1")).toBe(
      "-123:branch_1",
    );
    expect(parseSessionResumeCallback("sess:resume:")).toBeUndefined();
    expect(parseSessionResumeCallback("sess:delete:123")).toBeUndefined();
    expect(parseSessionResumeCallback("sess:resume:../evil")).toBeUndefined();
    expect(parseSessionResumeCallback("sess:resume:a b")).toBeUndefined();
    // Other namespaces never parse as sess:.
    expect(parseSessionResumeCallback("mdl:switch:3")).toBeUndefined();
    expect(parseSessionResumeCallback("pers:playful")).toBeUndefined();
    expect(parseSessionResumeCallback("lang:fa")).toBeUndefined();
    expect(parseSessionResumeCallback("menu:chat")).toBeUndefined();
  });

  test("parseModelSwitchCallback", () => {
    expect(parseModelSwitchCallback("mdl:switch:7")).toBe(7);
    expect(parseModelSwitchCallback("mdl:switch:abc")).toBeUndefined();
    expect(parseModelSwitchCallback("mdl:switch:")).toBeUndefined();
    expect(parseModelSwitchCallback("mdl:switch:7x")).toBeUndefined();
    expect(parseModelSwitchCallback("mdl:delete:7")).toBeUndefined();
    expect(parseModelSwitchCallback("sess:resume:7")).toBeUndefined();
    expect(parseModelSwitchCallback("pers:playful")).toBeUndefined();
  });

  test("parsePersonalityCallback validates against built-in skins", () => {
    expect(parsePersonalityCallback("pers:playful")).toBe("playful");
    expect(parsePersonalityCallback("pers:concise")).toBe("concise");
    expect(parsePersonalityCallback("pers:default")).toBe("default");
    // Case-insensitive, like the typed /personality arg.
    expect(parsePersonalityCallback("pers:PLAYFUL")).toBe("playful");
    // Anything else is rejected — raw callback text never reaches a prompt.
    expect(parsePersonalityCallback("pers:evil")).toBeUndefined();
    expect(parsePersonalityCallback("pers:")).toBeUndefined();
    expect(parsePersonalityCallback("pers:default; rm -rf")).toBeUndefined();
    expect(parsePersonalityCallback("mdl:switch:1")).toBeUndefined();
    expect(parsePersonalityCallback("sess:resume:1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// keyboard builders
// ---------------------------------------------------------------------------

function callbackDataOf(kb: {
  inline_keyboard: Array<Array<{ callback_data?: string; text: string }>>;
}): Array<{ text: string; data: string | undefined }> {
  return kb.inline_keyboard.flat().map((b) => ({ text: b.text, data: b.callback_data }));
}

describe("keyboard builders", () => {
  test("sessions keyboard: sess: namespace, ▶ buttons", () => {
    const kb = buildSessionsKeyboard(
      [{ id: "123", title: "گفتگوی اول دربارهٔ همه‌چیز" }],
      "fa",
    );
    const btns = callbackDataOf(kb);
    expect(btns).toHaveLength(1);
    expect(btns[0]!.data).toBe("sess:resume:123");
    expect(btns[0]!.text.startsWith("▶")).toBe(true);
  });

  test("model keyboard: mdl: namespace, active mark", () => {
    const kb = buildModelKeyboard(
      [
        { id: 7, label: "GPT", isActive: true },
        { id: 8, label: "Claude", isActive: false },
      ],
      "fa",
    );
    const btns = callbackDataOf(kb);
    expect(btns.map((b) => b.data)).toEqual(["mdl:switch:7", "mdl:switch:8"]);
    expect(btns[0]!.text).toContain("✅");
    expect(btns[1]!.text).not.toContain("✅");
  });

  test("personality keyboard: pers: namespace", () => {
    const kb = buildPersonalityKeyboard(
      [
        { name: "default", label: "معمولی" },
        { name: "playful", label: "شوخ‌طبع" },
      ],
      "playful",
      "fa",
    );
    const btns = callbackDataOf(kb);
    expect(btns.map((b) => b.data)).toEqual(["pers:default", "pers:playful"]);
    expect(btns[1]!.text).toContain("✅");
  });

  test("truncateLabel keeps surrogate pairs intact", () => {
    expect(truncateLabel("abc", 5)).toBe("abc");
    expect(truncateLabel("abcdef", 3)).toBe("abc…");
    expect(truncateLabel("😀😀😀😀", 2)).toBe("😀😀…");
  });
});

// ---------------------------------------------------------------------------
// sess: tap-to-resume callback
// ---------------------------------------------------------------------------

function sessionStorage(convs: string[]): Storage {
  return {
    listUserConversations: (_userId: string) =>
      convs.map((c) => ({
        conversationId: c,
        createdAt: 0,
        messageCount: 0,
        lastActivity: 0,
      })),
    history: () => [],
    countMessages: () => 0,
    getConversationSummary: () => undefined,
  } as unknown as Storage;
}

function sessionCallbackCtx(): {
  ctx: SessionCallbackCtx;
  answered: number[];
  replies: string[];
} {
  const answered: number[] = [];
  const replies: string[] = [];
  const ctx: SessionCallbackCtx = {
    chat: { id: 10 },
    from: { id: 999 },
    answerCallbackQuery: async () => {
      answered.push(1);
      return undefined;
    },
    reply: async (text: string) => {
      replies.push(text);
      return undefined;
    },
  };
  return { ctx, answered, replies };
}

describe("handleSessionResumeCallback", () => {
  test("a forged id (not the caller's) is rejected", async () => {
    const { ctx, answered, replies } = sessionCallbackCtx();
    await handleSessionResumeCallback(
      ctx,
      { storage: sessionStorage(["111"]) },
      "sess:resume:222",
      "fa",
    );
    expect(answered).toHaveLength(1);
    expect(replies.join("\n")).toContain("پیدا نشد");
  });

  test("junk callback data is rejected", async () => {
    const { ctx, replies } = sessionCallbackCtx();
    await handleSessionResumeCallback(
      ctx,
      { storage: sessionStorage(["111"]) },
      "sess:resume:../../etc",
      "fa",
    );
    expect(replies.join("\n")).toContain("پیدا نشد");
  });

  test("an owned id resumes: pref stored + honest note", async () => {
    const { ctx, replies } = sessionCallbackCtx();
    const stored: Array<[string, string, string]> = [];
    const prefs = {
      getUserPref: () => undefined,
      setUserPref: (u: string, k: string, v: string) => {
        stored.push([u, k, v]);
      },
    } as unknown as UserPrefStore;
    await handleSessionResumeCallback(
      ctx,
      { storage: sessionStorage(["111"]), prefs },
      "sess:resume:111",
      "fa",
    );
    expect(
      stored.some(
        ([u, k, v]) =>
          u === "999" && k === "active_conversation:10" && v === "111",
      ),
    ).toBe(true);
    expect(replies.join("\n")).toContain("نشست فعال");
  });
});

// ---------------------------------------------------------------------------
// mdl: quick-switch callback
// ---------------------------------------------------------------------------

function modelStorage(): { storage: ModelSwitchStorage; switched: Array<{ providerId: number; modelId: number }> } {
  const switched: Array<{ providerId: number; modelId: number }> = [];
  const storage = {
    listProviders: () => [
      { id: 1, label: "P1", enabled: true },
      { id: 2, label: "P2", enabled: false },
    ],
    listModels: (providerId: number) =>
      providerId === 1
        ? [
            { id: 7, providerId: 1, modelId: "m1", label: "Model One", enabled: true },
            { id: 8, providerId: 1, modelId: "m2", label: "Model Two", enabled: false },
          ]
        : [{ id: 9, providerId: 2, modelId: "m3", label: "Model Three", enabled: true }],
    getProvider: () => undefined,
    setRuntimeSelection: (sel: { providerId: number; modelId: number }) => {
      switched.push(sel);
    },
  } as unknown as ModelSwitchStorage;
  return { storage, switched };
}

function modelCallbackCtx(): { ctx: ModelCallbackCtx; replies: string[] } {
  const replies: string[] = [];
  const ctx: ModelCallbackCtx = {
    from: { id: 999 },
    answerCallbackQuery: async () => undefined,
    reply: async (text: string) => {
      replies.push(text);
      return undefined;
    },
  };
  return { ctx, replies };
}

describe("handleModelSwitchCallback", () => {
  test("an enabled model switches", async () => {
    const { storage, switched } = modelStorage();
    const { ctx, replies } = modelCallbackCtx();
    await handleModelSwitchCallback(ctx, storage, "mdl:switch:7", "fa");
    expect(switched).toEqual([{ providerId: 1, modelId: 7 }]);
    expect(replies.join("\n")).toContain("Model One");
  });

  test("a disabled model is rejected", async () => {
    const { storage, switched } = modelStorage();
    const { ctx, replies } = modelCallbackCtx();
    await handleModelSwitchCallback(ctx, storage, "mdl:switch:8", "fa");
    expect(switched).toHaveLength(0);
    expect(replies.join("\n")).toContain("غیرفعال");
  });

  test("a model on a disabled provider is rejected", async () => {
    const { storage, switched } = modelStorage();
    const { ctx, replies } = modelCallbackCtx();
    await handleModelSwitchCallback(ctx, storage, "mdl:switch:9", "fa");
    expect(switched).toHaveLength(0);
    expect(replies.join("\n")).toContain("غیرفعال");
  });

  test("an unknown id is rejected", async () => {
    const { storage, switched } = modelStorage();
    const { ctx, replies } = modelCallbackCtx();
    await handleModelSwitchCallback(ctx, storage, "mdl:switch:4242", "fa");
    expect(switched).toHaveLength(0);
    expect(replies.join("\n")).toContain("پیدا نشد");
  });

  test("junk callback data is rejected", async () => {
    const { storage, switched } = modelStorage();
    const { ctx, replies } = modelCallbackCtx();
    await handleModelSwitchCallback(ctx, storage, "mdl:switch:abc", "fa");
    expect(switched).toHaveLength(0);
    expect(replies.join("\n")).toContain("پیدا نشد");
  });
});

// ---------------------------------------------------------------------------
// /queue clear two-step (via cmd_auto)
// ---------------------------------------------------------------------------

describe("/queue clear confirmation", () => {
  beforeEach(() => {
    clearQueuesForTests();
  });

  test("bare clear shows the confirm; --confirm wipes", () => {
    const sender = { userId: "u1", telegramId: 1, chatId: "c1" };
    const deps = {} as never;
    expect(handleQueue(deps, sender, "کار اول", "fa")).toContain("مورد 1");
    const confirm = handleQueue(deps, sender, "clear", "fa");
    expect(confirm).toContain("/queue clear --confirm");
    expect(confirm).toContain("کار اول");
    // Not cleared yet.
    expect(handleQueue(deps, sender, "list", "fa")).toContain("کار اول");
    const done = handleQueue(deps, sender, "clear --confirm", "fa");
    expect(done).toContain("1 مورد حذف شد");
    expect(handleQueue(deps, sender, "list", "fa")).toContain("خالی");
  });

  test("clear on an empty queue reports empty, not a wipe", () => {
    const sender = { userId: "u2", telegramId: 2, chatId: "c1" };
    expect(handleQueue({} as never, sender, "clear", "fa")).toContain("خالی");
  });
});

// ---------------------------------------------------------------------------
// /whoami generated list
// ---------------------------------------------------------------------------

describe("/whoami", () => {
  test("lists real commands from COMMAND_HELP; hides owner ones from users", async () => {
    const replies: string[] = [];
    await handleWhoamiCommand(
      {
        from: { id: 1 },
        reply: async (t: string) => {
          replies.push(t);
          return undefined;
        },
      },
      false,
      "fa",
    );
    const text = replies.join("\n");
    // Two-tier: a non-owner sees exactly the public surface (voice is public:
    // it is conversation, not administration).
    for (const cmd of ["/start", "/help", "/commands", "/lang", "/voice"]) {
      expect(text, cmd).toContain(cmd);
    }
    for (const cmd of ["/history", "/new", "/bg", "/review", "/bundles", "/snapshot", "/goal"]) {
      expect(text, cmd).not.toContain(cmd);
    }

    const ownerReplies: string[] = [];
    await handleWhoamiCommand(
      {
        from: { id: 1 },
        reply: async (t: string) => {
          ownerReplies.push(t);
          return undefined;
        },
      },
      true,
      "en",
    );
    const ownerText = ownerReplies.join("\n");
    expect(ownerText).toContain("/snapshot");
    expect(ownerText).toContain("/goal");
  });
});
