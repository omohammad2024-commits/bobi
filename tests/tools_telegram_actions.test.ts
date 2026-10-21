/**
 * telegram_action tool — owner-driven Telegram actions behind a port.
 *
 * Pins:
 *  - every action routes to the right port call with the right args
 *  - chatId defaults to the server-supplied conversation; an explicit
 *    chatId wins; neither present → invalid_input
 *  - port absent → "disabled"; a port throw → one generic "internal"
 *    error whose message contains NONE of the underlying text
 *  - send_file reads a real sandbox file and passes its bytes; traversal
 *    and absolute paths are refused; >50 MB is refused naming the limit
 *  - poll shape is validated in the body (direct run() callers bypass
 *    the Executor validator, so the body cannot lean on it)
 *  - the owner gate: a supplied isOwner predicate refuses non-owners in
 *    run() before any port call happens (files.ts pattern)
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolError } from "../src/tools/errors";
import {
  TELEGRAM_ACTION_PERMISSION,
  TELEGRAM_MAX_FILE_BYTES,
  createTelegramActionsTool,
  telegramActionManifest,
} from "../src/tools/telegram_actions";
import type { TelegramActionsPort } from "../src/tools/telegram_actions";
import { validateManifest } from "../src/tools/validate_manifest";
import { validateInput } from "../src/tools/validate";
import type { Tool, ToolContext } from "../src/tools/types";

const GROUP = "-1001234567890";
const FIXED_NOW = new Date("2026-10-21T12:00:00Z");

interface RecordedCall {
  method: string;
  args: readonly unknown[];
}

/** Fake port: records every call, returns message id 555, can be made to throw. */
class FakePort implements TelegramActionsPort {
  calls: RecordedCall[] = [];
  failWith: Error | undefined;
  nextMessageId = 555;

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
    return { messageId: this.nextMessageId };
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
    return { messageId: this.nextMessageId };
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
    return { messageId: this.nextMessageId };
  }
  async sendDocument(
    chatId: string,
    filename: string,
    bytes: Uint8Array,
    caption?: string,
  ): Promise<{ messageId: number }> {
    this.record("sendDocument", [chatId, filename, bytes, caption]);
    return { messageId: this.nextMessageId };
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

const roots: string[] = [];

function freshRoot(): string {
  const base = mkdtempSync(join(tmpdir(), "bobi-tg-actions-"));
  roots.push(base);
  return join(base, "files-area");
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp dir must not fail the suite.
    }
  }
});

function ctxWith(conversationId?: string, userId = "owner"): ToolContext {
  return {
    clock: () => FIXED_NOW,
    actor: { userId, permissions: [TELEGRAM_ACTION_PERMISSION] },
    signal: new AbortController().signal,
    ...(conversationId !== undefined ? { conversationId } : {}),
  };
}

function toolWith(fake: FakePort, rootDir: string): Tool<any, any> {
  return createTelegramActionsTool({
    port: () => fake,
    rootDir,
    isOwner: (id) => id === "owner",
  }) as Tool<any, any>;
}

function toolWithoutPort(rootDir: string): Tool<any, any> {
  return createTelegramActionsTool({
    port: () => undefined,
    rootDir,
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

describe("telegram_action tool shape", () => {
  test("identity, permission, ownerOnly, tiers", () => {
    const t = toolWith(new FakePort(), freshRoot());
    expect(t.name).toBe("telegram_action");
    expect(TELEGRAM_ACTION_PERMISSION).toBe("tools:telegram_action");
    expect(t.permission.requires).toEqual(["tools:telegram_action"]);
    expect(t.ownerOnly).toBe(true);
    expect(t.enabled).toBe(true);
    expect(t.toolset).toBe("system");
    expect(telegramActionManifest.category).toBe("system");
    expect(telegramActionManifest.latencyTier).toBe("seconds");
    expect(telegramActionManifest.costTier).toBe("free");
    expect(t.input.fields["action"]?.choices).toEqual([
      "send_message",
      "react",
      "forward",
      "pin",
      "send_poll",
      "send_file",
    ]);
  });

  test("manifest validates and references the fixed confusables", () => {
    expect(validateManifest(telegramActionManifest)).toEqual([]);
    expect(telegramActionManifest.confusableWith.map((c) => c.tool)).toEqual([
      "download_media",
      "files",
    ]);
  });
});

describe("action routing", () => {
  test("send_message routes to sendMessage and returns the new message id", async () => {
    const fake = new FakePort();
    const t = toolWith(fake, freshRoot());
    const out = await t.run({ action: "send_message", text: "hello group" }, ctxWith(GROUP));
    expect(out).toEqual({ action: "send_message", chatId: GROUP, messageId: 555 });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe("sendMessage");
    expect(fake.calls[0]?.args[0]).toBe(GROUP);
    expect(fake.calls[0]?.args[1]).toBe("hello group");
  });

  test("chatId defaults to the conversation; an explicit chatId wins", async () => {
    const fake = new FakePort();
    const t = toolWith(fake, freshRoot());
    await t.run({ action: "send_message", text: "a" }, ctxWith("-111"));
    expect(fake.calls[0]?.args[0]).toBe("-111");
    const out = await t.run(
      { action: "send_message", chatId: "-222", text: "b" },
      ctxWith("-111"),
    );
    expect(out.chatId).toBe("-222");
    expect(fake.calls[1]?.args[0]).toBe("-222");
  });

  test("no conversation and no chatId → invalid_input, no port call", async () => {
    const fake = new FakePort();
    const t = toolWith(fake, freshRoot());
    await expectToolError(t.run({ action: "send_message", text: "x" }, ctxWith()), "invalid_input");
    expect(fake.calls).toHaveLength(0);
  });

  test("react routes to setReaction with chat, message and emoji", async () => {
    const fake = new FakePort();
    const t = toolWith(fake, freshRoot());
    const out = await t.run(
      { action: "react", messageId: 42, emoji: "🔥" },
      ctxWith(GROUP),
    );
    expect(out).toEqual({ action: "react", chatId: GROUP });
    expect(fake.calls[0]?.method).toBe("setReaction");
    expect(fake.calls[0]?.args).toEqual([GROUP, 42, "🔥"]);
  });

  test("forward defaults fromChatId to the target chat; explicit source wins", async () => {
    const fake = new FakePort();
    const t = toolWith(fake, freshRoot());
    const out = await t.run({ action: "forward", messageId: 7 }, ctxWith(GROUP));
    expect(out).toEqual({ action: "forward", chatId: GROUP, messageId: 555 });
    expect(fake.calls[0]?.args).toEqual([GROUP, GROUP, 7]);

    await t.run({ action: "forward", messageId: 8, fromChatId: "-999" }, ctxWith(GROUP));
    expect(fake.calls[1]?.args).toEqual([GROUP, "-999", 8]);
  });

  test("pin routes to pinMessage", async () => {
    const fake = new FakePort();
    const t = toolWith(fake, freshRoot());
    const out = await t.run({ action: "pin", messageId: 9 }, ctxWith(GROUP));
    expect(out).toEqual({ action: "pin", chatId: GROUP });
    expect(fake.calls[0]?.method).toBe("pinMessage");
    expect(fake.calls[0]?.args).toEqual([GROUP, 9]);
  });

  test("send_poll routes question, options and both flags", async () => {
    const fake = new FakePort();
    const t = toolWith(fake, freshRoot());
    const out = await t.run(
      {
        action: "send_poll",
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
        anonymous: true,
        multiple: true,
      },
      ctxWith(GROUP),
    );
    expect(out).toEqual({ action: "send_poll", chatId: GROUP, messageId: 555 });
    expect(fake.calls[0]?.method).toBe("sendPoll");
    expect(fake.calls[0]?.args[0]).toBe(GROUP);
    expect(fake.calls[0]?.args[1]).toBe("Lunch?");
    expect(fake.calls[0]?.args[2]).toEqual(["Pizza", "Sushi"]);
    expect(fake.calls[0]?.args[3]).toEqual({
      isAnonymous: true,
      allowsMultipleAnswers: true,
    });
  });

  test("send_poll defaults both flags to false", async () => {
    const fake = new FakePort();
    const t = toolWith(fake, freshRoot());
    await t.run(
      { action: "send_poll", question: "Ok?", options: ["Yes", "No"] },
      ctxWith(GROUP),
    );
    expect(fake.calls[0]?.args[3]).toEqual({
      isAnonymous: false,
      allowsMultipleAnswers: false,
    });
  });
});

describe("input validation in the body", () => {
  test("send_message without text, and text over 4096 chars → invalid_input", async () => {
    const fake = new FakePort();
    const t = toolWith(fake, freshRoot());
    await expectToolError(t.run({ action: "send_message" }, ctxWith(GROUP)), "invalid_input");
    await expectToolError(
      t.run({ action: "send_message", text: "x".repeat(4097) }, ctxWith(GROUP)),
      "invalid_input",
    );
    expect(fake.calls).toHaveLength(0);
  });

  test("react / forward / pin without a messageId → invalid_input", async () => {
    const fake = new FakePort();
    const t = toolWith(fake, freshRoot());
    await expectToolError(
      t.run({ action: "react", emoji: "👍" }, ctxWith(GROUP)),
      "invalid_input",
    );
    await expectToolError(t.run({ action: "forward" }, ctxWith(GROUP)), "invalid_input");
    await expectToolError(t.run({ action: "pin" }, ctxWith(GROUP)), "invalid_input");
    expect(fake.calls).toHaveLength(0);
  });

  test("react without an emoji → invalid_input", async () => {
    const fake = new FakePort();
    const t = toolWith(fake, freshRoot());
    await expectToolError(
      t.run({ action: "react", messageId: 1 }, ctxWith(GROUP)),
      "invalid_input",
    );
  });

  test("poll with 1 option → invalid_input (body), 11 options → invalid_input", async () => {
    const fake = new FakePort();
    const t = toolWith(fake, freshRoot());
    await expectToolError(
      t.run({ action: "send_poll", question: "Q?", options: ["only"] }, ctxWith(GROUP)),
      "invalid_input",
    );
    await expectToolError(
      t.run(
        {
          action: "send_poll",
          question: "Q?",
          options: Array.from({ length: 11 }, (_, i) => `opt ${i}`),
        },
        ctxWith(GROUP),
      ),
      "invalid_input",
    );
    expect(fake.calls).toHaveLength(0);
  });

  test("poll validation also fires through the Executor validator for 11 options", () => {
    const t = toolWith(new FakePort(), freshRoot());
    expect(() =>
      validateInput(t.input, {
        action: "send_poll",
        question: "Q?",
        options: Array.from({ length: 11 }, (_, i) => `opt ${i}`),
      }),
    ).toThrow(ToolError);
  });

  test("poll with an over-long question or option → invalid_input", async () => {
    const fake = new FakePort();
    const t = toolWith(fake, freshRoot());
    await expectToolError(
      t.run(
        { action: "send_poll", question: "q".repeat(301), options: ["a", "b"] },
        ctxWith(GROUP),
      ),
      "invalid_input",
    );
    await expectToolError(
      t.run(
        { action: "send_poll", question: "Q?", options: ["a", "b".repeat(101)] },
        ctxWith(GROUP),
      ),
      "invalid_input",
    );
  });
});

describe("send_file", () => {
  test("reads a real sandbox file and passes filename, bytes and caption", async () => {
    const root = freshRoot();
    mkdirSync(join(root, "docs"), { recursive: true });
    const payload = Buffer.from("file body bytes", "utf8");
    writeFileSync(join(root, "docs", "report.txt"), payload);

    const fake = new FakePort();
    const t = toolWith(fake, root);
    const out = await t.run(
      { action: "send_file", path: "docs/report.txt", caption: "here you go" },
      ctxWith(GROUP),
    );
    expect(out).toEqual({ action: "send_file", chatId: GROUP, messageId: 555 });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe("sendDocument");
    expect(fake.calls[0]?.args[0]).toBe(GROUP);
    expect(fake.calls[0]?.args[1]).toBe("report.txt");
    expect(Buffer.from(fake.calls[0]?.args[2] as Uint8Array)).toEqual(payload);
    expect(fake.calls[0]?.args[3]).toBe("here you go");
  });

  test("traversal and absolute paths are refused before any port call", async () => {
    const base = mkdtempSync(join(tmpdir(), "bobi-tg-actions-esc-"));
    roots.push(base);
    const root = join(base, "files-area");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(base, "outside.txt"), "not yours");

    const fake = new FakePort();
    const t = toolWith(fake, root);
    await expectToolError(
      t.run({ action: "send_file", path: "../outside.txt" }, ctxWith(GROUP)),
      "not_allowed",
      "That path is outside the files area.",
    );
    await expectToolError(
      t.run({ action: "send_file", path: join(base, "outside.txt") }, ctxWith(GROUP)),
      "not_allowed",
      "That path is outside the files area.",
    );
    await expectToolError(
      t.run({ action: "send_file", path: "a/../../outside.txt" }, ctxWith(GROUP)),
      "not_allowed",
    );
    expect(fake.calls).toHaveLength(0);
  });

  test("a missing file → not_found; a folder → invalid_input", async () => {
    const root = freshRoot();
    mkdirSync(join(root, "sub"), { recursive: true });
    const fake = new FakePort();
    const t = toolWith(fake, root);
    await expectToolError(
      t.run({ action: "send_file", path: "nope.txt" }, ctxWith(GROUP)),
      "not_found",
    );
    await expectToolError(
      t.run({ action: "send_file", path: "sub" }, ctxWith(GROUP)),
      "invalid_input",
    );
    expect(fake.calls).toHaveLength(0);
  });

  test("a file over 50 MB is refused with the limit named in the error", async () => {
    const root = freshRoot();
    mkdirSync(root, { recursive: true });
    const big = join(root, "big.bin");
    writeFileSync(big, "x");
    // Sparse-grow: stat reports the size, and the tool refuses before reading.
    truncateSync(big, TELEGRAM_MAX_FILE_BYTES + 1);

    const fake = new FakePort();
    const t = toolWith(fake, root);
    const err = await expectToolError(
      t.run({ action: "send_file", path: "big.bin" }, ctxWith(GROUP)),
      "invalid_input",
    );
    expect(err.message).toContain("50 MB");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("port honesty", () => {
  test("port absent → disabled with the fixed message", async () => {
    const t = toolWithoutPort(freshRoot());
    await expectToolError(
      t.run({ action: "send_message", text: "hi" }, ctxWith(GROUP)),
      "disabled",
      "Telegram actions are not available on this surface.",
    );
  });

  test("a port throw → internal, and NONE of the underlying text leaks", async () => {
    const fake = new FakePort();
    fake.failWith = new Error("SECRET_MARKER_12345 bot token exploded");
    const t = toolWith(fake, freshRoot());
    const err = await expectToolError(
      t.run({ action: "send_message", text: "hi" }, ctxWith(GROUP)),
      "internal",
      "Telegram could not complete that action.",
    );
    expect(err.message).not.toContain("SECRET_MARKER_12345");
    expect(String(err.detail ?? "")).not.toContain("SECRET_MARKER_12345");
  });
});

describe("owner defence in depth (isOwner dep)", () => {
  test("non-owner and unknown actors are refused before any port call", async () => {
    const fake = new FakePort();
    const t = toolWith(fake, freshRoot());
    await expectToolError(
      t.run({ action: "send_message", text: "hi" }, ctxWith(GROUP, "intruder")),
      "not_allowed",
    );
    await expectToolError(
      t.run({ action: "send_message", text: "hi" }, ctxWith(GROUP, "unknown")),
      "not_allowed",
    );
    expect(fake.calls).toHaveLength(0);
    const ok = await t.run({ action: "send_message", text: "hi" }, ctxWith(GROUP, "owner"));
    expect(ok.action).toBe("send_message");
  });
});
