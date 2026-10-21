/**
 * Outbound webhooks: signing, config fail-closed behaviour, the bounded
 * delivery queue, the metadata-only privacy rule, and engine emission.
 *
 * HMAC vectors below are fixed test vectors (RFC 4231 case 1 and a second
 * well-known vector), computed independently with node:crypto — they pin the
 * signer to the standard, not to its own implementation.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { signBody, verifySignature, SIGNATURE_HEADER } from "../src/webhooks/signer";
import { loadWebhookConfig } from "../src/webhooks/config";
import {
  agentStartEvent,
  agentEndEvent,
  toolEndEvent,
  serialiseEvent,
} from "../src/webhooks/events";
import {
  WebhookQueue,
  postWebhook,
  MAX_QUEUE_SIZE,
  MAX_ATTEMPTS,
  type DeliverFn,
} from "../src/webhooks/queue";
import {
  initWebhooks,
  webhooksEnabled,
  emitWebhookEvent,
  webhookEventSink,
  setWebhookDeliverForTests,
} from "../src/webhooks";
import { ConversationEngine } from "../src/conversation/engine";
import { FakeProvider } from "../src/ai/fake";
import { ToolService } from "../src/tools/service";
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

const noSleep = async (_ms: number): Promise<void> => {};
const immediateDeliver: DeliverFn = async () => {};

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("webhook signer", () => {
  test("RFC 4231 test case 1 (HMAC-SHA256)", () => {
    const key = Buffer.alloc(20, 0x0b).toString("binary");
    expect(signBody(key, "Hi There")).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  test("known vector: key='key' over the fox sentence", () => {
    expect(signBody("key", "The quick brown fox jumps over the lazy dog")).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });

  test("output is 64 lowercase hex chars", () => {
    expect(signBody("secret", "hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("header name", () => {
    expect(SIGNATURE_HEADER).toBe("X-Bobi-Signature-256");
  });

  test("verifySignature accepts a valid signature (constant-time)", () => {
    const secret = "s3cr3t";
    const body = '{"event":"agent:end"}';
    expect(verifySignature(secret, body, signBody(secret, body))).toBe(true);
  });

  test("verifySignature rejects tampered body and wrong secret", () => {
    const secret = "s3cr3t";
    const body = '{"event":"agent:end"}';
    const sig = signBody(secret, body);
    expect(verifySignature(secret, body + "x", sig)).toBe(false);
    expect(verifySignature("other", body, sig)).toBe(false);
    expect(verifySignature(secret, body, "0".repeat(64))).toBe(false);
    expect(verifySignature(secret, body, "short")).toBe(false);
  });
});

describe("webhook config", () => {
  test("URL without secret disables webhooks (fail closed)", () => {
    const cfg = loadWebhookConfig({ BOBI_WEBHOOK_URL: "https://hooks.example.com/e" });
    expect(cfg.enabled).toBe(false);
    expect(cfg.urls).toEqual([]);
    expect(cfg.disabledReason).toContain("BOBI_WEBHOOK_SECRET");
  });

  test("whitespace-only secret also disables", () => {
    const cfg = loadWebhookConfig({
      BOBI_WEBHOOK_URL: "https://hooks.example.com/e",
      BOBI_WEBHOOK_SECRET: "   ",
    });
    expect(cfg.enabled).toBe(false);
  });

  test("URL + secret enables, comma-separated URLs are all kept", () => {
    const cfg = loadWebhookConfig({
      BOBI_WEBHOOK_URL: "https://a.example.com/e, https://b.example.com/e ",
      BOBI_WEBHOOK_SECRET: "s3cr3t",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.urls).toHaveLength(2);
    expect(cfg.secret).toBe("s3cr3t");
  });

  test("URL with embedded credentials is refused", () => {
    const cfg = loadWebhookConfig({
      BOBI_WEBHOOK_URL: "https://user:pass@hooks.example.com/e",
      BOBI_WEBHOOK_SECRET: "s3cr3t",
    });
    // The only URL was invalid, so nothing is enabled.
    expect(cfg.enabled).toBe(false);
    expect(cfg.urls).toEqual([]);
  });

  test("non-http(s) scheme is refused", () => {
    const cfg = loadWebhookConfig({
      BOBI_WEBHOOK_URL: "ftp://hooks.example.com/e",
      BOBI_WEBHOOK_SECRET: "s3cr3t",
    });
    expect(cfg.enabled).toBe(false);
  });

  test("one bad URL does not poison the good ones", () => {
    const cfg = loadWebhookConfig({
      BOBI_WEBHOOK_URL: "gopher://x, https://good.example.com/e",
      BOBI_WEBHOOK_SECRET: "s3cr3t",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.urls).toHaveLength(1);
    expect(cfg.urls[0]).toContain("good.example.com");
  });

  test("no URL at all disables quietly", () => {
    const cfg = loadWebhookConfig({});
    expect(cfg.enabled).toBe(false);
  });

  test("queue default cap is 100", () => {
    expect(MAX_QUEUE_SIZE).toBe(100);
  });
});

describe("webhook queue", () => {
  test("full queue drops the oldest WAITING events first and counts them", async () => {
    const seen: string[] = [];
    // Hold the first delivery in flight so the burst queues behind it.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const q = new WebhookQueue({
      urls: ["https://hooks.example.com/e"],
      secret: "s",
      capacity: 3,
      deliver: async (_url, body) => {
        await gate;
        seen.push(JSON.parse(body).conversationId);
      },
      sleep: noSleep,
    });
    for (let i = 1; i <= 5; i++) {
      q.enqueue(
        agentStartEvent({ conversationId: `c${i}`, userId: "u", model: "m", hasAttachments: false, userTextLength: i }),
      );
    }
    // c1 is in flight (never a drop victim); c2 was the oldest waiter when
    // c5 arrived, so exactly one event was dropped.
    expect(q.droppedCount).toBe(1);
    expect(q.size).toBe(3);
    release();
    await q.drain();
    expect(seen).toEqual(["c1", "c3", "c4", "c5"]);
  });

  test("a failing endpoint is retried with backoff, then the event is dropped", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const q = new WebhookQueue({
      urls: ["https://hooks.example.com/e"],
      secret: "s",
      deliver: async () => {
        calls++;
        throw new Error("down");
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    q.enqueue(agentEndEvent({ conversationId: "c", userId: "u", durationMs: 1, toolCalls: 0, ok: true }));
    await q.drain();
    expect(calls).toBe(MAX_ATTEMPTS);
    // Exponential backoff between attempts: 1s, 2s (none after the last).
    expect(sleeps).toEqual([1000, 2000]);
    expect(q.size).toBe(0);
  });

  test("a flaky endpoint recovers on retry", async () => {
    let calls = 0;
    const delivered: string[] = [];
    const q = new WebhookQueue({
      urls: ["https://hooks.example.com/e"],
      secret: "s",
      deliver: async (_url, body) => {
        calls++;
        if (calls < 3) throw new Error("flaky");
        delivered.push(body);
      },
      sleep: noSleep,
    });
    q.enqueue(toolEndEvent({ conversationId: "c", userId: "u", tool: "t", status: "ok", durationMs: 5 }));
    await q.drain();
    expect(calls).toBe(3);
    expect(delivered).toHaveLength(1);
  });

  test("delivery failure never throws out of enqueue", async () => {
    const q = new WebhookQueue({
      urls: ["https://hooks.example.com/e"],
      secret: "s",
      deliver: async () => {
        throw new Error("always down");
      },
      sleep: noSleep,
    });
    expect(() => q.enqueue(agentStartEvent({ conversationId: "c", userId: "u", model: "m", hasAttachments: false, userTextLength: 1 }))).not.toThrow();
    await q.drain();
    expect(q.size).toBe(0);
  });

  test("each URL gets a signed POST", async () => {
    const calls: Array<{ url: string; body: string; signature: string }> = [];
    const q = new WebhookQueue({
      urls: ["https://a.example.com/e", "https://b.example.com/e"],
      secret: "s3cr3t",
      deliver: async (url, body, signature) => {
        calls.push({ url, body, signature });
      },
      sleep: noSleep,
    });
    q.enqueue(agentStartEvent({ conversationId: "c", userId: "u", model: "m", hasAttachments: false, userTextLength: 1 }));
    await q.drain();
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://a.example.com/e",
      "https://b.example.com/e",
    ]);
    for (const c of calls) {
      expect(c.signature).toBe(signBody("s3cr3t", c.body));
    }
  });
});

describe("postWebhook transport hardening (P0-NET-2)", () => {
  test("(a) a loopback target is refused before any connection is made", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits++;
        return new Response("ok");
      },
    });
    try {
      await expect(
        postWebhook(`http://127.0.0.1:${server.port}/hook`, "{}", "sig"),
      ).rejects.toThrow();
      expect(hits).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("(b) a 307 redirect never re-sends the body and signature off-host", async () => {
    let bHits = 0;
    let bSignature: string | null = null;
    let bBody = "";
    const b = Bun.serve({
      port: 0,
      fetch: async (req) => {
        bHits++;
        bSignature = req.headers.get(SIGNATURE_HEADER);
        bBody = await req.text();
        return new Response("ok");
      },
    });
    const a = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 307,
          headers: { location: `http://127.0.0.1:${b.port}/hook` },
        }),
    });
    try {
      // Delivery to A must fail (redirects are not followed), and B — a
      // host the owner never configured — must see nothing at all.
      await expect(
        postWebhook(`http://127.0.0.1:${a.port}/hook`, '{"event":"agent:end"}', "deadbeefsig"),
      ).rejects.toThrow();
      expect(bHits).toBe(0);
      expect(bSignature).toBeNull();
      expect(bBody).toBe("");
    } finally {
      a.stop();
      b.stop();
    }
  });

  test("(b, transport) a 307 is a failure and is never followed to its Location", async () => {
    // Seam-level pin, independent of target validation: exactly one fetch,
    // to the configured URL only — the Location is never requested.
    const fetched: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(null, {
        status: 307,
        headers: { location: "https://elsewhere.example/hook" },
      });
    }) as typeof fetch;
    await expect(
      postWebhook("https://hooks.example.com/e", "{}", "sig", {
        validate: async () => {},
        fetchFn,
      }),
    ).rejects.toThrow("HTTP 307");
    expect(fetched).toEqual(["https://hooks.example.com/e"]);
  });

  test("(c) the response drain is capped, not read to the end", async () => {
    // Pull-counting stream: 200 chunks × 16KB = 3.2MB. An uncapped
    // arrayBuffer() drain pulls every chunk; a capped drain stops early.
    // (Pre-fix this ran against a real local server and pulled all 200;
    // the target validator now refuses loopback before fetch, so the cap
    // is pinned here through the transport seam instead.)
    let pulls = 0;
    const chunk = new Uint8Array(16 * 1024).fill(1);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 200) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const fetchFn = (async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      })) as unknown as typeof fetch;
    await postWebhook("https://hooks.example.com/e", "{}", "sig", {
      validate: async () => {},
      fetchFn,
    });
    expect(pulls).toBeLessThan(50);
  });
});

describe("webhook event privacy", () => {
  const canary = "CANARY-متن-محرمانه-کاربر-۹۸۷۶۵";

  test("agent:start carries length, never the text", () => {
    const body = serialiseEvent(
      agentStartEvent({ conversationId: "c", userId: "u", model: "m", hasAttachments: false, userTextLength: canary.length }),
    );
    expect(body).not.toContain(canary);
    expect(body).not.toContain("CANARY");
    expect(JSON.parse(body).data.userTextLength).toBe(canary.length);
  });

  test("agent:end carries counts, never the reply", () => {
    const body = serialiseEvent(
      agentEndEvent({ conversationId: "c", userId: "u", durationMs: 10, toolCalls: 1, ok: true, inputTokens: 5, outputTokens: 7 }),
    );
    expect(body).not.toContain(canary);
    const parsed = JSON.parse(body);
    expect(parsed.data.inputTokens).toBe(5);
    expect(parsed.data.outputTokens).toBe(7);
  });

  test("tool:end carries name/status/duration, never args or results", () => {
    const body = serialiseEvent(
      toolEndEvent({ conversationId: "c", userId: "u", tool: "calculator", status: "ok", durationMs: 3 }),
    );
    expect(body).not.toContain(canary);
    const parsed = JSON.parse(body);
    expect(Object.keys(parsed.data).sort()).toEqual(["durationMs", "status", "tool"]);
  });

  test("envelope shape is exactly event/at/conversationId/userId/data", () => {
    const parsed = JSON.parse(serialiseEvent(agentStartEvent({ conversationId: "c", userId: "u", model: "m", hasAttachments: false, userTextLength: 0 })));
    expect(Object.keys(parsed).sort()).toEqual(["at", "conversationId", "data", "event", "userId"]);
    expect(parsed.event).toBe("agent:start");
  });
});

describe("engine webhook emission", () => {
  const delivered: Array<{ url: string; body: string; signature: string }> = [];

  beforeEach(() => {
    delivered.length = 0;
    process.env.BOBI_WEBHOOK_URL = "https://hooks.example.test/e";
    process.env.BOBI_WEBHOOK_SECRET = "test-secret";
    initWebhooks();
    setWebhookDeliverForTests(async (url, body, signature) => {
      delivered.push({ url, body, signature });
    });
    expect(webhooksEnabled()).toBe(true);
  });

  afterEach(() => {
    delete process.env.BOBI_WEBHOOK_URL;
    delete process.env.BOBI_WEBHOOK_SECRET;
    initWebhooks();
    setWebhookDeliverForTests(undefined);
  });

  test("plain turn emits agent:start and agent:end, with no message text", async () => {
    const engine = new ConversationEngine({
      provider: new FakeProvider(),
      model: "fake-echo",
      timeoutMs: 5_000,
      maxConcurrent: 4,
      // Phase 5: engine events leave through the injected sink (production
      // wiring); delivery still flows via initWebhooks + the test transport.
      onEvent: webhookEventSink(),
    });
    const secretText = "متن محرمانه کاربر ۱۲۳۴۵";
    await engine.respond({ conversationId: "c1", userText: secretText });

    await waitFor(() => delivered.length >= 2);
    const events = delivered.map((d) => JSON.parse(d.body));
    expect(events.map((e) => e.event)).toEqual(["agent:start", "agent:end"]);

    const bodies = delivered.map((d) => d.body).join("\n");
    expect(bodies).not.toContain(secretText);
    expect(bodies).not.toContain("محرمانه");

    const start = events[0];
    expect(start.conversationId).toBe("c1");
    expect(start.data.userTextLength).toBe(secretText.length);
    expect(start.data.model).toBe("fake-echo");

    const end = events[1];
    expect(end.conversationId).toBe("c1");
    expect(end.data.ok).toBe(true);
    expect(end.data.toolCalls).toBe(0);
    expect(typeof end.data.durationMs).toBe("number");

    // Every delivery is signed with the configured secret.
    for (const d of delivered) {
      expect(d.signature).toBe(signBody("test-secret", d.body));
      expect(d.url).toBe("https://hooks.example.test/e");
    }
  });

  test("a tool execution emits tool:end with metadata only", async () => {
    // Scripted provider: first asks the model to run the calculator, then answers.
    class ScriptedProvider implements AiProvider {
      readonly name = "scripted";
      private i = 0;
      constructor(private readonly script: readonly CompletionResponse[]) {}
      async complete(_req: CompletionRequest): Promise<CompletionResponse> {
        const next = this.script[this.i++];
        if (!next) throw new AiError("invalid_response", "exhausted");
        return next;
      }
    }
    const provider = new ScriptedProvider([
      {
        text: "",
        model: "m",
        toolCalls: [{ id: "c1", name: "calculator", arguments: { op: "add", a: 2, b: 3 } }],
      },
      { text: "حاصل ۵ است.", model: "m" },
    ]);
    const tools = new ToolService();
    const auth = new AuthorizationService(OwnerIdentity.fromNumber(111));
    const base = auth.actorFrom({ id: 111 });
    const actor: ToolActor = toToolActor(authorizeToolUse(auth, base, tools.registry.list()));

    const engine = new ConversationEngine({
      provider,
      model: "m",
      timeoutMs: 5_000,
      maxConcurrent: 4,
      tools,
      onEvent: webhookEventSink(),
    });
    await engine.respond({ conversationId: "chat-1", userText: "دو به علاوه سه؟", actor });

    await waitFor(() => delivered.length >= 3);
    const events = delivered.map((d) => JSON.parse(d.body));
    expect(events.map((e) => e.event)).toEqual(["agent:start", "tool:end", "agent:end"]);

    const tool = events[1];
    expect(tool.data.tool).toBe("calculator");
    expect(tool.data.status).toBe("ok");
    expect(typeof tool.data.durationMs).toBe("number");

    const body = delivered.map((d) => d.body).join("\n");
    expect(body).not.toContain("دو به علاوه سه");
    expect(body).not.toContain("حاصل ۵ است");
  });

  test("disabled webhooks emit nothing", async () => {
    delete process.env.BOBI_WEBHOOK_URL;
    delete process.env.BOBI_WEBHOOK_SECRET;
    initWebhooks();
    expect(webhooksEnabled()).toBe(false);

    const engine = new ConversationEngine({
      provider: new FakeProvider(),
      model: "fake-echo",
      timeoutMs: 5_000,
      maxConcurrent: 4,
      onEvent: webhookEventSink(),
    });
    await engine.respond({ conversationId: "c1", userText: "سلام" });
    // Give the (non-existent) worker a chance to misbehave.
    await new Promise((r) => setTimeout(r, 100));
    expect(delivered).toHaveLength(0);
  });

  test("emitWebhookEvent never throws when disabled", () => {
    delete process.env.BOBI_WEBHOOK_URL;
    initWebhooks();
    expect(() =>
      emitWebhookEvent(agentStartEvent({ conversationId: "c", userId: "u", model: "m", hasAttachments: false, userTextLength: 1 })),
    ).not.toThrow();
  });
});
