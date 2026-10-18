/**
 * generate_image tool.
 *
 * No network is touched: the tool takes an injected transport and a stub DNS
 * resolver, so every HTTP assertion runs against a scripted stub. The tests
 * pin the security-relevant properties:
 *
 *  - the request shape (POST {baseUrl}/images/generations, n=1, b64_json)
 *  - validation rejects over-long prompts and bad sizes before any request
 *  - the tool does not exist when no endpoint is configured
 *  - image bytes leave via extractMedia only; `data` stays model-safe
 *  - transport failures map to categorized, user-safe ToolErrors
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createImageGenTool,
  imageGenConfigured,
  GENERATE_IMAGE_PERMISSION,
  GENERATIONS_TIMEOUT_MS,
  type ImageGenTransport,
} from "../src/tools/image_gen";
import { ToolService } from "../src/tools/service";
import { AiError } from "../src/ai/provider";

const BASE_URL = "https://images.example.com/v1";

const FULL_ACTOR = {
  userId: "u1",
  permissions: [GENERATE_IMAGE_PERMISSION],
};

/** Stub DNS: a public IP, so resolveTarget passes without any real lookup. */
const stubResolver = async (_host: string): Promise<readonly string[]> => ["93.184.216.0"];

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

function stubTransport(
  respond: (req: Captured) => { status: number; body: string } | never,
  captured: Captured[] = [],
): ImageGenTransport {
  return {
    request: async (opts) => {
      const req = {
        url: opts.url,
        headers: opts.headers,
        body: opts.body,
        timeoutMs: opts.timeoutMs,
      };
      captured.push(req);
      return respond(req);
    },
  };
}

const okBody = (b64 = "aGVsbG8=", revised?: string) =>
  JSON.stringify({
    created: 1,
    data: [
      {
        b64_json: b64,
        ...(revised !== undefined ? { revised_prompt: revised } : {}),
      },
    ],
  });

function serviceWith(
  transport: ImageGenTransport,
  deps: { apiKey?: string; model?: string } = {},
) {
  const tool = createImageGenTool({
    baseUrl: BASE_URL,
    model: deps.model ?? "dall-e-3",
    ...(deps.apiKey !== undefined ? { apiKey: deps.apiKey } : {}),
    transport,
    resolver: stubResolver,
  });
  return new ToolService({ extraTools: [tool as never] });
}

describe("generate_image registration", () => {
  test("declares its name, permission and enabled state", () => {
    const tool = createImageGenTool({ baseUrl: BASE_URL, model: "dall-e-3" });
    expect(tool.name).toBe("generate_image");
    expect(tool.enabled).toBe(true);
    expect(tool.permission.requires).toEqual([GENERATE_IMAGE_PERMISSION]);
  });

  test("imageGenConfigured: empty base URL means the tool must not exist", () => {
    expect(imageGenConfigured("")).toBe(false);
    expect(imageGenConfigured("   ")).toBe(false);
    expect(imageGenConfigured(BASE_URL)).toBe(true);
  });

  test("the factory refuses to build an unconfigured tool", () => {
    expect(() => createImageGenTool({ baseUrl: "", model: "dall-e-3" })).toThrow();
  });

  test("index.ts registers it only when an endpoint is configured", () => {
    const src = readFileSync("src/index.ts", "utf8");
    expect(src).toContain("imageGenConfigured(config.imageBaseUrl)");
    expect(src).toContain("createImageGenTool(");
  });

  test("prompt is length-bounded at the schema level", () => {
    const tool = createImageGenTool({ baseUrl: BASE_URL, model: "dall-e-3" });
    const prompt = tool.input.fields["prompt"]!;
    expect(prompt.required).toBe(true);
    expect(prompt.minLength).toBe(1);
    expect(prompt.maxLength).toBe(1000);
  });

  test("size is an enum with the three supported sizes", () => {
    const tool = createImageGenTool({ baseUrl: BASE_URL, model: "dall-e-3" });
    const size = tool.input.fields["size"]!;
    expect(size.type).toBe("enum");
    expect(size.choices).toEqual(["1024x1024", "1792x1024", "1024x1792"]);
  });
});

describe("generate_image request shape", () => {
  test("POSTs the OpenAI images shape with n=1 and b64_json", async () => {
    const captured: Captured[] = [];
    const svc = serviceWith(stubTransport(() => ({ status: 200, body: okBody() }), captured), {
      apiKey: "k",
    });
    const r = await svc.runTool({
      tool: "generate_image",
      input: { prompt: "a cat in space" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("ok");
    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.url).toBe(`${BASE_URL}/images/generations`);
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body).toEqual({
      model: "dall-e-3",
      prompt: "a cat in space",
      n: 1,
      size: "1024x1024",
      response_format: "b64_json",
    });
    expect(req.headers["authorization"]).toBe("Bearer k");
    expect(req.headers["content-type"]).toBe("application/json");
  });

  test("the per-call deadline is 90 seconds", async () => {
    const captured: Captured[] = [];
    const svc = serviceWith(stubTransport(() => ({ status: 200, body: okBody() }), captured));
    await svc.runTool({ tool: "generate_image", input: { prompt: "x" }, actor: FULL_ACTOR });
    expect(GENERATIONS_TIMEOUT_MS).toBe(90_000);
    expect(captured[0]!.timeoutMs).toBe(90_000);
  });

  test("the requested size is forwarded", async () => {
    const captured: Captured[] = [];
    const svc = serviceWith(stubTransport(() => ({ status: 200, body: okBody() }), captured));
    await svc.runTool({
      tool: "generate_image",
      input: { prompt: "x", size: "1792x1024" },
      actor: FULL_ACTOR,
    });
    expect((JSON.parse(captured[0]!.body) as Record<string, unknown>)["size"]).toBe("1792x1024");
  });

  test("no Authorization header is sent without a key", async () => {
    const captured: Captured[] = [];
    const svc = serviceWith(stubTransport(() => ({ status: 200, body: okBody() }), captured));
    await svc.runTool({ tool: "generate_image", input: { prompt: "x" }, actor: FULL_ACTOR });
    expect(captured[0]!.headers["authorization"]).toBeUndefined();
  });
});

describe("generate_image validation", () => {
  function svc() {
    return serviceWith(stubTransport(() => ({ status: 200, body: okBody() })));
  }

  test("a 1001-char prompt is rejected before any request", async () => {
    const captured: Captured[] = [];
    const s = serviceWith(stubTransport(() => ({ status: 200, body: okBody() }), captured));
    const r = await s.runTool({
      tool: "generate_image",
      input: { prompt: "a".repeat(1001) },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("invalid_input");
    expect(captured).toHaveLength(0);
  });

  test("a 1000-char prompt is accepted", async () => {
    const r = await svc().runTool({
      tool: "generate_image",
      input: { prompt: "a".repeat(1000) },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("ok");
  });

  test("an unknown size is rejected", async () => {
    const r = await svc().runTool({
      tool: "generate_image",
      input: { prompt: "x", size: "512x512" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("invalid_input");
  });

  test("a blank prompt is rejected", async () => {
    const r = await svc().runTool({
      tool: "generate_image",
      input: { prompt: "   " },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("invalid_input");
  });
});

describe("generate_image media seam", () => {
  test("extractMedia returns the exact response bytes as a png image part", async () => {
    const svc = serviceWith(stubTransport(() => ({ status: 200, body: okBody("QUJD", "rev") })));
    const r = await svc.runTool({
      tool: "generate_image",
      input: { prompt: "a cat" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("ok");
    expect(r.media).toEqual([{ type: "image", mediaType: "image/png", base64: "QUJD" }]);
  });

  test("data is model-safe: no base64, only metadata", async () => {
    const svc = serviceWith(stubTransport(() => ({ status: 200, body: okBody("QUJD", "rev") })));
    const r = await svc.runTool({
      tool: "generate_image",
      input: { prompt: "a cat" },
      actor: FULL_ACTOR,
    });
    expect(r.data).toEqual({
      ok: true,
      prompt: "a cat",
      size: "1024x1024",
      revisedPrompt: "rev",
    });
    expect(JSON.stringify(r.data)).not.toContain("QUJD");
  });

  test("revisedPrompt is absent when the provider omits it", async () => {
    const svc = serviceWith(stubTransport(() => ({ status: 200, body: okBody("QUJD") })));
    const r = await svc.runTool({
      tool: "generate_image",
      input: { prompt: "a cat" },
      actor: FULL_ACTOR,
    });
    expect(r.data).toEqual({ ok: true, prompt: "a cat", size: "1024x1024" });
  });
});

describe("generate_image failure mapping", () => {
  test("rate limiting becomes overloaded, not a retry-now error", async () => {
    const svc = serviceWith(
      stubTransport(() => {
        throw new AiError("quota", "limited");
      }),
    );
    const r = await svc.runTool({
      tool: "generate_image",
      input: { prompt: "x" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("error");
    expect(r.message).toContain("شلوغ");
  });

  test("a transport timeout becomes the timeout category", async () => {
    const svc = serviceWith(
      stubTransport(() => {
        throw new AiError("timeout", "slow");
      }),
    );
    const r = await svc.runTool({
      tool: "generate_image",
      input: { prompt: "x" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("error");
  });

  test("HTTP 429 maps to overloaded", async () => {
    const svc = serviceWith(stubTransport(() => ({ status: 429, body: "{}" })));
    const r = await svc.runTool({
      tool: "generate_image",
      input: { prompt: "x" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("error");
    expect(r.message).toContain("شلوغ");
  });

  test("HTTP 401 maps to not_allowed without echoing the body", async () => {
    const svc = serviceWith(
      stubTransport(() => ({ status: 401, body: '{"error":"bad key hunter2"}' })),
    );
    const r = await svc.runTool({
      tool: "generate_image",
      input: { prompt: "x" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("not_allowed");
    expect(r.message).not.toContain("hunter2");
  });

  test("a response without b64_json is an invalid result", async () => {
    const svc = serviceWith(
      stubTransport(() => ({ status: 200, body: JSON.stringify({ data: [{ url: "https://x/y.png" }] }) })),
    );
    const r = await svc.runTool({
      tool: "generate_image",
      input: { prompt: "x" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("error");
  });

  test("a malformed JSON body is an invalid result", async () => {
    const svc = serviceWith(stubTransport(() => ({ status: 200, body: "not json" })));
    const r = await svc.runTool({
      tool: "generate_image",
      input: { prompt: "x" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("error");
  });
});
