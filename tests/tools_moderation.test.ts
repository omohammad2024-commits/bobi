/**
 * moderate_member tool — owner-driven moderation in the current group.
 *
 * Pins:
 *  - GROUPS ONLY: the chat comes from ctx.conversationId alone (there is
 *    no chatId input); a private (positive) id, or no conversation at
 *    all, is refused before any port call
 *  - every action maps to the right port call, incl. mute duration math
 *    against the injected ctx clock
 *  - warn sends the static platform warning as a reply, with the
 *    owner's note appended — never any message content (there is none
 *    in the input by design)
 *  - port absent → "disabled"; a port throw → one generic "internal"
 *    error leaking none of the underlying text
 *  - the owner gate refuses non-owners in run() (files.ts pattern)
 */
import { describe, expect, test } from "bun:test";
import { ToolError } from "../src/tools/errors";
import {
  MODERATE_MEMBER_PERMISSION,
  WARNING_TEXT,
  createModerationTool,
  moderateMemberManifest,
} from "../src/tools/moderation";
import type { TelegramActionsPort } from "../src/tools/telegram_actions";
import { validateManifest } from "../src/tools/validate_manifest";
import type { Tool, ToolContext } from "../src/tools/types";

const GROUP = "-1001234567890";
const PRIVATE = "424242";
const FIXED_NOW = new Date("2026-10-21T12:00:00Z");

interface RecordedCall {
  method: string;
  args: readonly unknown[];
}

/** Fake port: records every call, returns message id 777, can be made to throw. */
class FakePort implements TelegramActionsPort {
  calls: RecordedCall[] = [];
  failWith: Error | undefined;

  private record(method: string, args: readonly unknown[]): void {
    this.calls.push({ method, args });
    if (this.failWith !== undefined) throw this.failWith;
  }

  async sendMessage(
    chatId: string,
    text: string,
    opts?: { replyToMessageId?: number },
  ): Promise<{ messageId: number }> {
    this.record("sendMessage", [chatId, text, opts]);
    return { messageId: 777 };
  }
  async setReaction(chatId: string, messageId: number, emoji: string): Promise<void> {
    this.record("setReaction", [chatId, messageId, emoji]);
  }
  async forwardMessage(
    chatId: string,
    fromChatId: string,
    messageId: number,
  ): Promise<{ messageId: number }> {
    this.record("forwardMessage", [chatId, fromChatId, messageId]);
    return { messageId: 777 };
  }
  async pinMessage(chatId: string, messageId: number): Promise<void> {
    this.record("pinMessage", [chatId, messageId]);
  }
  async sendPoll(
    chatId: string,
    question: string,
    options: readonly string[],
    opts?: { isAnonymous?: boolean; allowsMultipleAnswers?: boolean },
  ): Promise<{ messageId: number }> {
    this.record("sendPoll", [chatId, question, options, opts]);
    return { messageId: 777 };
  }
  async sendDocument(
    chatId: string,
    filename: string,
    bytes: Uint8Array,
    caption?: string,
  ): Promise<{ messageId: number }> {
    this.record("sendDocument", [chatId, filename, bytes, caption]);
    return { messageId: 777 };
  }
  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    this.record("deleteMessage", [chatId, messageId]);
  }
  async banMember(chatId: string, userId: number): Promise<void> {
    this.record("banMember", [chatId, userId]);
  }
  async unbanMember(chatId: string, userId: number): Promise<void> {
    this.record("unbanMember", [chatId, userId]);
  }
  async restrictMember(
    chatId: string,
    userId: number,
    canSend: boolean,
    untilUnixSeconds?: number,
  ): Promise<void> {
    this.record("restrictMember", [chatId, userId, canSend, untilUnixSeconds]);
  }
}

function ctxWith(conversationId?: string, userId = "owner"): ToolContext {
  return {
    clock: () => FIXED_NOW,
    actor: { userId, permissions: [MODERATE_MEMBER_PERMISSION] },
    signal: new AbortController().signal,
    ...(conversationId !== undefined ? { conversationId } : {}),
  };
}

function toolWith(fake: FakePort): Tool<any, any> {
  return createModerationTool({
    port: () => fake,
    isOwner: (id) => id === "owner",
  }) as Tool<any, any>;
}

function toolWithoutPort(): Tool<any, any> {
  return createModerationTool({
    port: () => undefined,
    isOwner: (id) => id === "owner",
  }) as Tool<any, any>;
}

async function expectToolError(
  p: Promise<unknown>,
  kind: ToolError["kind"],
  message?: string,
): Promise<ToolError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe(kind);
    if (message !== undefined) expect((err as ToolError).message).toBe(message);
    return err as ToolError;
  }
  throw new Error(`expected ToolError(${kind}) but the run succeeded`);
}

describe("moderate_member tool shape", () => {
  test("identity, permission, ownerOnly, tiers; no chatId input exists", () => {
    const t = toolWith(new FakePort());
    expect(t.name).toBe("moderate_member");
    expect(MODERATE_MEMBER_PERMISSION).toBe("tools:moderate_member");
    expect(t.permission.requires).toEqual(["tools:moderate_member"]);
    expect(t.ownerOnly).toBe(true);
    expect(t.enabled).toBe(true);
    expect(t.toolset).toBe("system");
    expect(moderateMemberManifest.category).toBe("system");
    expect(moderateMemberManifest.latencyTier).toBe("seconds");
    expect(moderateMemberManifest.costTier).toBe("free");
    expect(t.input.fields["action"]?.choices).toEqual([
      "ban",
      "unban",
      "mute",
      "unmute",
      "delete_message",
      "warn",
    ]);
    // Moderation never leaves the current chat: no chatId field at all.
    expect(Object.keys(t.input.fields)).not.toContain("chatId");
  });

  test("manifest validates and references telegram_action as confusable", () => {
    expect(validateManifest(moderateMemberManifest)).toEqual([]);
    expect(moderateMemberManifest.confusableWith.map((c) => c.tool)).toEqual([
      "telegram_action",
    ]);
  });
});

describe("groups-only guard", () => {
  test("a private conversation id is refused with the fixed message", async () => {
    const fake = new FakePort();
    const t = toolWith(fake);
    await expectToolError(
      t.run({ action: "ban", userId: 111 }, ctxWith(PRIVATE)),
      "invalid_input",
      "Moderation actions only work in group chats.",
    );
    expect(fake.calls).toHaveLength(0);
  });

  test("no conversation at all is refused the same way", async () => {
    const fake = new FakePort();
    const t = toolWith(fake);
    await expectToolError(
      t.run({ action: "ban", userId: 111 }, ctxWith()),
      "invalid_input",
      "Moderation actions only work in group chats.",
    );
    expect(fake.calls).toHaveLength(0);
  });

  test("a group (negative) conversation id is accepted", async () => {
    const fake = new FakePort();
    const t = toolWith(fake);
    const out = await t.run({ action: "ban", userId: 111 }, ctxWith(GROUP));
    expect(out.chatId).toBe(GROUP);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("action mapping", () => {
  test("ban → banMember, unban → unbanMember, with userId in the output", async () => {
    const fake = new FakePort();
    const t = toolWith(fake);
    const banned = await t.run({ action: "ban", userId: 111 }, ctxWith(GROUP));
    expect(banned).toEqual({ action: "ban", chatId: GROUP, userId: 111 });
    expect(fake.calls[0]?.method).toBe("banMember");
    expect(fake.calls[0]?.args).toEqual([GROUP, 111]);

    const unbanned = await t.run({ action: "unban", userId: 111 }, ctxWith(GROUP));
    expect(unbanned).toEqual({ action: "unban", chatId: GROUP, userId: 111 });
    expect(fake.calls[1]?.method).toBe("unbanMember");
    expect(fake.calls[1]?.args).toEqual([GROUP, 111]);
  });

  test("mute without a duration restricts with no until", async () => {
    const fake = new FakePort();
    const t = toolWith(fake);
    const out = await t.run({ action: "mute", userId: 222 }, ctxWith(GROUP));
    expect(out).toEqual({ action: "mute", chatId: GROUP, userId: 222 });
    expect(fake.calls[0]?.method).toBe("restrictMember");
    expect(fake.calls[0]?.args[0]).toBe(GROUP);
    expect(fake.calls[0]?.args[1]).toBe(222);
    expect(fake.calls[0]?.args[2]).toBe(false);
    expect(fake.calls[0]?.args[3]).toBeUndefined();
  });

  test("mute duration math uses the injected clock", async () => {
    const fake = new FakePort();
    const t = toolWith(fake);
    await t.run(
      { action: "mute", userId: 222, durationMinutes: 30 },
      ctxWith(GROUP),
    );
    const expectedUntil = Math.floor(FIXED_NOW.getTime() / 1000) + 30 * 60;
    expect(fake.calls[0]?.args).toEqual([GROUP, 222, false, expectedUntil]);
  });

  test("mute duration bounds: 1 and 43200 pass, 0 and 43201 are refused", async () => {
    const fake = new FakePort();
    const t = toolWith(fake);
    await t.run({ action: "mute", userId: 1, durationMinutes: 1 }, ctxWith(GROUP));
    await t.run({ action: "mute", userId: 1, durationMinutes: 43200 }, ctxWith(GROUP));
    expect(fake.calls).toHaveLength(2);
    await expectToolError(
      t.run({ action: "mute", userId: 1, durationMinutes: 0 }, ctxWith(GROUP)),
      "invalid_input",
    );
    await expectToolError(
      t.run({ action: "mute", userId: 1, durationMinutes: 43201 }, ctxWith(GROUP)),
      "invalid_input",
    );
    expect(fake.calls).toHaveLength(2);
  });

  test("unmute → restrictMember with canSend true", async () => {
    const fake = new FakePort();
    const t = toolWith(fake);
    const out = await t.run({ action: "unmute", userId: 222 }, ctxWith(GROUP));
    expect(out).toEqual({ action: "unmute", chatId: GROUP, userId: 222 });
    expect(fake.calls[0]?.method).toBe("restrictMember");
    expect(fake.calls[0]?.args[0]).toBe(GROUP);
    expect(fake.calls[0]?.args[1]).toBe(222);
    expect(fake.calls[0]?.args[2]).toBe(true);
  });

  test("delete_message → deleteMessage with the message id in the output", async () => {
    const fake = new FakePort();
    const t = toolWith(fake);
    const out = await t.run({ action: "delete_message", messageId: 88 }, ctxWith(GROUP));
    expect(out).toEqual({ action: "delete_message", chatId: GROUP, messageId: 88 });
    expect(fake.calls[0]?.method).toBe("deleteMessage");
    expect(fake.calls[0]?.args).toEqual([GROUP, 88]);
  });

  test("member actions without a userId, message actions without a messageId → invalid_input", async () => {
    const fake = new FakePort();
    const t = toolWith(fake);
    await expectToolError(t.run({ action: "ban" }, ctxWith(GROUP)), "invalid_input");
    await expectToolError(t.run({ action: "mute" }, ctxWith(GROUP)), "invalid_input");
    await expectToolError(
      t.run({ action: "delete_message" }, ctxWith(GROUP)),
      "invalid_input",
    );
    await expectToolError(t.run({ action: "warn" }, ctxWith(GROUP)), "invalid_input");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("warn", () => {
  test("warn replies to the message with exactly the static platform text", async () => {
    const fake = new FakePort();
    const t = toolWith(fake);
    const out = await t.run({ action: "warn", messageId: 66 }, ctxWith(GROUP));
    expect(out).toEqual({ action: "warn", chatId: GROUP, messageId: 777 });
    expect(fake.calls[0]?.method).toBe("sendMessage");
    expect(fake.calls[0]?.args[0]).toBe(GROUP);
    expect(fake.calls[0]?.args[1]).toBe("⚠️ Warning from the group admin.");
    expect(fake.calls[0]?.args[1]).toBe(WARNING_TEXT);
    expect(fake.calls[0]?.args[2]).toEqual({ replyToMessageId: 66 });
  });

  test("warn appends the owner's note after the static text", async () => {
    const fake = new FakePort();
    const t = toolWith(fake);
    await t.run(
      { action: "warn", messageId: 66, note: "Second time this week." },
      ctxWith(GROUP),
    );
    expect(fake.calls[0]?.args[1]).toBe(
      "⚠️ Warning from the group admin. Second time this week.",
    );
    expect(fake.calls[0]?.args[2]).toEqual({ replyToMessageId: 66 });
  });

  test("a note over 200 characters is refused", async () => {
    const fake = new FakePort();
    const t = toolWith(fake);
    await expectToolError(
      t.run({ action: "warn", messageId: 66, note: "n".repeat(201) }, ctxWith(GROUP)),
      "invalid_input",
    );
    expect(fake.calls).toHaveLength(0);
  });
});

describe("port honesty", () => {
  test("port absent → disabled with the fixed message", async () => {
    const t = toolWithoutPort();
    await expectToolError(
      t.run({ action: "ban", userId: 111 }, ctxWith(GROUP)),
      "disabled",
      "Telegram actions are not available on this surface.",
    );
  });

  test("a port throw → internal, and NONE of the underlying text leaks", async () => {
    const fake = new FakePort();
    fake.failWith = new Error("SECRET_MARKER_67890 not enough rights");
    const t = toolWith(fake);
    const err = await expectToolError(
      t.run({ action: "ban", userId: 111 }, ctxWith(GROUP)),
      "internal",
      "Telegram could not complete that action.",
    );
    expect(err.message).not.toContain("SECRET_MARKER_67890");
  });
});

describe("owner defence in depth (isOwner dep)", () => {
  test("non-owner and unknown actors are refused before any port call", async () => {
    const fake = new FakePort();
    const t = toolWith(fake);
    await expectToolError(
      t.run({ action: "ban", userId: 111 }, ctxWith(GROUP, "intruder")),
      "not_allowed",
    );
    await expectToolError(
      t.run({ action: "ban", userId: 111 }, ctxWith(GROUP, "unknown")),
      "not_allowed",
    );
    expect(fake.calls).toHaveLength(0);
  });
});
