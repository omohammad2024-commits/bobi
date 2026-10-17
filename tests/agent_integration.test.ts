/**
 * End-to-end agent wiring.
 *
 * The unit tests prove the loop and the tools separately. This suite proves the
 * composition that actually ships: a Telegram-derived actor becomes tool
 * permissions, the engine runs a real registered tool, the reply is chunked for
 * Telegram, and the turn is persisted — with the tool's permission decision made
 * from server-side identity rather than anything the model sent.
 */
import { describe, expect, test } from "bun:test";
import { ConversationEngine } from "../src/conversation/engine";
import { ToolService } from "../src/tools/service";
import { Storage } from "../src/storage/storage";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";
import { authorizeToolUse, toToolActor } from "../src/auth/tool_bridge";
import { AiError } from "../src/ai/provider";
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
} from "../src/ai/provider";
import type { ToolActor } from "../src/tools/types";

const OWNER_ID = 111;

/** Plays back a script, recording each request. */
class ScriptedProvider implements AiProvider {
  readonly name = "scripted";
  readonly requests: CompletionRequest[] = [];
  private index = 0;
  constructor(private readonly script: readonly CompletionResponse[]) {}
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(req);
    const next = this.script[this.index++];
    if (!next) throw new AiError("invalid_response", "exhausted");
    return next;
  }
}

/**
 * Resolve the tool actor exactly as the bot does: from the Authorization Core
 * and the registry, never from message content.
 */
function actorFor(auth: AuthorizationService, tools: ToolService, id: number): ToolActor {
  const actor = auth.actorFrom({ id });
  return toToolActor(authorizeToolUse(auth, actor, tools.registry.list()));
}

function makeStack(provider: AiProvider) {
  const storage = Storage.open(":memory:");
  const tools = new ToolService();
  const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER_ID));
  const engine = new ConversationEngine({
    provider,
    model: "m",
    timeoutMs: 5_000,
    maxConcurrent: 4,
    storage,
    tools,
    timezone: "UTC",
  });
  return { storage, tools, auth, engine };
}

describe("agent end to end", () => {
  test("owner asks a question, the real calculator tool runs, the answer persists", async () => {
    const provider = new ScriptedProvider([
      {
        text: "",
        model: "m",
        toolCalls: [{ id: "c1", name: "calculator", arguments: { op: "add", a: 20, b: 22 } }],
      },
      { text: "حاصل ۴۲ است.", model: "m" },
    ]);
    const stack = makeStack(provider);
    const actor = actorFor(stack.auth, stack.tools, OWNER_ID);

    const out = await stack.engine.respond({
      conversationId: "chat-1",
      userId: String(OWNER_ID),
      userText: "۲۰ + ۲۲ چند می‌شود؟",
      actor,
    });

    // The tool really executed: the model received its output.
    const toolMsg = provider.requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg!.content).toContain("42");

    expect(out.chunks.join("")).toContain("۴۲");
    expect(out.steps.some((s) => s.kind === "tool" && s.status === "ok")).toBe(true);
    expect(out.truncated).toBe(false);

    // Both turns were persisted, so a follow-up sees the exchange.
    const history = stack.storage.history(String(OWNER_ID), "chat-1", 10);
    expect(history.map((h) => h.role)).toEqual(["user", "assistant"]);
    expect(history[1]!.content).toContain("۴۲");

    stack.storage.close();
  });

  test("an update with no identity gets no tools, even when the model asks for one", async () => {
    const provider = new ScriptedProvider([
      {
        text: "",
        model: "m",
        toolCalls: [{ id: "c1", name: "calculator", arguments: { op: "add", a: 1, b: 1 } }],
      },
      { text: "نتوانستم محاسبه کنم.", model: "m" },
    ]);
    const stack = makeStack(provider);
    // No identity at all (a channel post, say): the actor the bot derives is
    // empty, so no tool permission is held.
    const anonymous = toToolActor(
      authorizeToolUse(stack.auth, undefined, stack.tools.registry.list()),
    );

    const out = await stack.engine.respond({
      conversationId: "chat-2",
      userId: "anon",
      userText: "۱+۱؟",
      actor: anonymous,
    });

    // Refused, and reported back to the model as a fact rather than executed.
    const toolMsg = provider.requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg!.content).toContain("not_allowed");
    expect(out.steps.some((s) => s.kind === "tool" && s.status === "not_allowed")).toBe(true);
    expect(out.chunks.join("")).toContain("نتوانستم");

    stack.storage.close();
  });

  test("a permission the actor lacks is refused for that tool only", async () => {
    // Narrower than the identity check: an actor holding `tools.use` but only
    // one tool's key may run that tool and nothing else.
    const provider = new ScriptedProvider([
      {
        text: "",
        model: "m",
        toolCalls: [{ id: "c1", name: "date_time", arguments: {} }],
      },
      { text: "نشد.", model: "m" },
    ]);
    const stack = makeStack(provider);
    const onlyCalc: ToolActor = { userId: "u", permissions: ["tools:calculator"] };

    await stack.engine.respond({
      conversationId: "chat-3",
      userId: "u",
      userText: "ساعت چند است؟",
      actor: onlyCalc,
    });

    const toolMsg = provider.requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg!.content).toContain("not_allowed");
    // ...and the model was only ever offered the tool that is actually allowed.
    expect((provider.requests[0]!.tools ?? []).map((t) => t.name)).toEqual(["calculator"]);

    stack.storage.close();
  });

  test("the tool list sent to the model matches the actor's permissions", async () => {
    const provider = new ScriptedProvider([{ text: "ok", model: "m" }]);
    const stack = makeStack(provider);

    await stack.engine.respond({
      conversationId: "c",
      userId: String(OWNER_ID),
      userText: "سلام",
      actor: actorFor(stack.auth, stack.tools, OWNER_ID),
    });

    const offered = provider.requests[0]!.tools ?? [];
    expect(offered.map((t) => t.name)).toEqual([
      "calculator",
      "date_time",
      "text_utilities",
      "unit_converter",
      "fetch_url",
    ]);
    // Every offered tool declares a real argument schema.
    for (const spec of offered) {
      expect(spec.parameters["type"]).toBe("object");
    }

    stack.storage.close();
  });

  test("the system prompt reaches the provider as the first message", async () => {
    const provider = new ScriptedProvider([{ text: "ok", model: "m" }]);
    const stack = makeStack(provider);
    await stack.engine.respond({
      conversationId: "c",
      userId: String(OWNER_ID),
      userText: "سلام",
      actor: actorFor(stack.auth, stack.tools, OWNER_ID),
    });

    const first = provider.requests[0]!.messages[0]!;
    expect(first.role).toBe("system");
    expect(first.content).toContain("calculator");

    stack.storage.close();
  });

  test("a long answer is chunked to Telegram's limit", async () => {
    const provider = new ScriptedProvider([{ text: "ب".repeat(10_000), model: "m" }]);
    const stack = makeStack(provider);
    const out = await stack.engine.respond({
      conversationId: "c",
      userId: String(OWNER_ID),
      userText: "بلند بنویس",
      actor: actorFor(stack.auth, stack.tools, OWNER_ID),
    });
    expect(out.chunks.length).toBeGreaterThan(1);
    for (const chunk of out.chunks) expect(chunk.length).toBeLessThanOrEqual(4096);

    stack.storage.close();
  });

  test("a budget-limited run is flagged as truncated", async () => {
    // A model that only ever asks for tools.
    const provider = new ScriptedProvider([
      { text: "", model: "m", toolCalls: [{ id: "a", name: "date_time", arguments: {} }] },
      { text: "", model: "m", toolCalls: [{ id: "b", name: "date_time", arguments: {} }] },
      { text: "بهترین پاسخ ممکن با اطلاعات موجود.", model: "m" },
    ]);
    const stack = makeStack(provider);
    const engine = new ConversationEngine({
      provider,
      model: "m",
      timeoutMs: 5_000,
      maxConcurrent: 4,
      storage: stack.storage,
      tools: stack.tools,
      budgets: { maxIterations: 2 },
    });

    const out = await engine.respond({
      conversationId: "c",
      userId: String(OWNER_ID),
      userText: "چند بار؟",
      actor: actorFor(stack.auth, stack.tools, OWNER_ID),
    });

    expect(out.truncated).toBe(true);
    expect(out.chunks.join("")).toContain("بهترین پاسخ");

    stack.storage.close();
  });

  test("conversations stay isolated per user", async () => {
    const provider = new ScriptedProvider([
      { text: "پاسخ اول", model: "m" },
      { text: "پاسخ دوم", model: "m" },
    ]);
    const stack = makeStack(provider);

    await stack.engine.respond({
      conversationId: "chat-a",
      userId: "a",
      userText: "یک",
      actor: actorFor(stack.auth, stack.tools, OWNER_ID),
    });
    await stack.engine.respond({
      conversationId: "chat-b",
      userId: "b",
      userText: "دو",
      actor: actorFor(stack.auth, stack.tools, 999),
    });

    expect(stack.storage.history("a", "chat-a", 10)).toHaveLength(2);
    expect(stack.storage.history("b", "chat-b", 10)).toHaveLength(2);
    // Cross-reads return nothing.
    expect(stack.storage.history("a", "chat-b", 10)).toHaveLength(0);

    stack.storage.close();
  });

  test("with no tool service the engine still answers", async () => {
    // The plain chat path must keep working, since tools are optional.
    const provider = new ScriptedProvider([{ text: "سلام!", model: "m" }]);
    const storage = Storage.open(":memory:");
    const engine = new ConversationEngine({
      provider,
      model: "m",
      timeoutMs: 5_000,
      maxConcurrent: 4,
      storage,
    });
    const out = await engine.respond({ conversationId: "c", userId: "u", userText: "سلام" });
    expect(out.chunks[0]).toBe("سلام!");
    expect(out.steps).toHaveLength(0);
    storage.close();
  });
});
