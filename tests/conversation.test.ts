import { describe, expect, test } from "bun:test";
import { ConversationEngine, EngineError, splitForTelegram, TELEGRAM_MAX_LENGTH } from "../src/conversation/engine";
import { FakeProvider } from "../src/ai/fake";
import { AiError } from "../src/ai/provider";
import type { AiProvider, CompletionRequest, CompletionResponse } from "../src/ai/provider";

function makeEngine(overrides: Partial<ConstructorParameters<typeof ConversationEngine>[0]> = {}, provider?: AiProvider) {
  return new ConversationEngine({
    provider: provider ?? new FakeProvider(),
    model: "fake-echo",
    timeoutMs: 5_000,
    maxConcurrent: 4,
    ...overrides,
  });
}

const ok = (t: string) => ({ conversationId: "c1", userText: t });

describe("conversation engine", () => {
  test("successful fake provider reply", async () => {
    const eng = makeEngine();
    const out = await eng.respond(ok("سلام"));
    expect(out.isFake).toBe(true);
    expect(out.chunks.length).toBe(1);
    expect(out.chunks[0]).toContain("آزمایشی بابی");
  });

  test("empty / whitespace input rejected", async () => {
    const eng = makeEngine();
    await expect(eng.respond(ok("   "))).rejects.toMatchObject({ kind: "empty_input" });
  });

  test("provider empty text → empty_response", async () => {
    const empty: AiProvider = {
      name: "empty",
      async complete(): Promise<CompletionResponse> {
        return { text: "   ", model: "x" };
      },
    };
    const eng = makeEngine({}, empty);
    await expect(eng.respond(ok("hi"))).rejects.toMatchObject({ kind: "empty_response" });
  });

  test("network error surfaces as 'network'", async () => {
    const netErr: AiProvider = {
      name: "net",
      async complete(): Promise<CompletionResponse> {
        throw new AiError("network", "connection refused");
      },
    };
    const eng = makeEngine({}, netErr);
    await expect(eng.respond(ok("hi"))).rejects.toMatchObject({ kind: "network" });
  });

  test("auth error surfaces as 'auth'", async () => {
    const authErr: AiProvider = {
      name: "auth",
      async complete(): Promise<CompletionResponse> {
        throw new AiError("auth", "bad api key");
      },
    };
    const eng = makeEngine({}, authErr);
    await expect(eng.respond(ok("hi"))).rejects.toMatchObject({ kind: "auth" });
  });

  test("timeout aborts a slow provider", async () => {
    const slow: AiProvider = {
      name: "slow",
      complete(req: CompletionRequest): Promise<CompletionResponse> {
        return new Promise((_, reject) => {
          req.signal.addEventListener("abort", () =>
            reject(new AiError("aborted", "aborted")), { once: true });
        });
      },
    };
    const eng = makeEngine({ timeoutMs: 30 }, slow);
    await expect(eng.respond(ok("hi"))).rejects.toMatchObject({ kind: "aborted" });
  });

  test("long reply is chunked within Telegram limit", async () => {
    const big = "الف ".repeat(6000); // ~12000 chars
    const longProvider: AiProvider = {
      name: "long",
      async complete(): Promise<CompletionResponse> {
        return { text: big, model: "x" };
      },
    };
    const eng = makeEngine({}, longProvider);
    const out = await eng.respond(ok("big"));
    expect(out.chunks.length).toBeGreaterThan(1);
    for (const c of out.chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX_LENGTH);
    // chunker trims whitespace at the break point — verify round-trip modulo that.
    expect(out.chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(
      big.replace(/\s+/g, " ").trim(),
    );
  });

  test("concurrent requests on same conversation are serialized", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const counter: AiProvider = {
      name: "counter",
      async complete(req: CompletionRequest): Promise<CompletionResponse> {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return { text: `ok${req.messages.length}`, model: "x" };
      },
    };
    const eng = makeEngine({}, counter);
    await Promise.all([eng.respond(ok("a")), eng.respond(ok("b")), eng.respond(ok("c"))]);
    // serialized per conversation → provider never saw 2 in-flight for c1
    expect(maxInFlight).toBe(1);
    expect(eng.getHistory("c1").length).toBe(6); // 3 user + 3 assistant
  });

  test("different conversations are isolated", async () => {
    const eng = makeEngine();
    await eng.respond({ conversationId: "c1", userText: "یک" });
    await eng.respond({ conversationId: "c2", userText: "دو" });
    expect(eng.getHistory("c1").length).toBe(2);
    expect(eng.getHistory("c2").length).toBe(2);
    expect(eng.getHistory("c1")[0]?.content).toBe("یک");
    expect(eng.getHistory("c2")[0]?.content).toBe("دو");
  });

  test("engine is independent of grammY (no telegram imports)", async () => {
    // Calling respond() with plain data works without any Context object.
    const eng = makeEngine();
    const out = await eng.respond({ conversationId: "x", userText: "بدون تلگرام" });
    expect(out.chunks[0]).toContain("بدون تلگرام");
  });
});

describe("splitForTelegram", () => {
  test("short text is a single chunk", () => {
    expect(splitForTelegram("hello")).toEqual(["hello"]);
  });
  test("splits on newline when possible", () => {
    const t = `${"a".repeat(4000)}\n${"b".repeat(200)}`;
    const parts = splitForTelegram(t);
    expect(parts.length).toBe(2);
    expect(parts[0]!.length).toBeLessThanOrEqual(TELEGRAM_MAX_LENGTH);
  });
  test("no infinite loop on pathological input", () => {
    const t = "x".repeat(20000); // no spaces/newlines
    const parts = splitForTelegram(t);
    expect(parts.length).toBe(Math.ceil(20000 / TELEGRAM_MAX_LENGTH));
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(TELEGRAM_MAX_LENGTH);
  });
});
