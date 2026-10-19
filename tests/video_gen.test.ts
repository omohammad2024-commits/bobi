/**
 * generate_video tool.
 *
 * No network is touched: the tool takes an injected transport and a stub DNS
 * resolver, so every HTTP assertion runs against a scripted stub. The tests
 * pin the security-relevant properties:
 *
 *  - the request shape (POST {baseUrl}/videos/jobs, n=1) and the async
 *    submit → poll → download flow
 *  - validation rejects over-long prompts and bad sizes before any request
 *  - the tool does not exist when no endpoint is configured
 *  - video bytes leave via extractMedia only; `data` stays model-safe
 *  - the poll loop is bounded by an attempt cap (timeout path is fast)
 *  - transport failures map to categorized, user-safe ToolErrors
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createVideoGenTool,
  videoGenConfigured,
  videoGenDepsFromEnv,
  GENERATE_VIDEO_PERMISSION,
  VIDEO_JOB_TIMEOUT_MS,
  VIDEO_REQUEST_TIMEOUT_MS,
  MAX_POLL_ATTEMPTS,
  POLL_INTERVAL_MS,
  type VideoGenTransport,
} from "../src/tools/video_gen";
import { ToolService } from "../src/tools/service";
import { AiError } from "../src/ai/provider";

const BASE_URL = "https://videos.example.com/v1";

const FULL_ACTOR = {
  userId: "u1",
  permissions: [GENERATE_VIDEO_PERMISSION],
};

/** Stub DNS: a public IP, so resolveTarget passes without any real lookup. */
const stubResolver = async (_host: string): Promise<readonly string[]> => ["93.184.216.0"];

interface Captured {
  url: string;
  method: "GET" | "POST" | undefined;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

type StubReply = { status: number; body: string; rawBody?: Buffer };

function stubTransport(
  respond: (req: Captured) => StubReply | never,
  captured: Captured[] = [],
): VideoGenTransport {
  return {
    request: async (opts) => {
      const req: Captured = {
        url: opts.url,
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        timeoutMs: opts.timeoutMs,
      };
      captured.push(req);
      return respond(req);
    },
  };
}

/** A stub that walks the full job lifecycle: submit → polling → video URL → download. */
function lifecycleTransport(
  captured: Captured[] = [],
  opts: { statusBody?: (attempt: number) => StubReply } = {},
): VideoGenTransport {
  let polls = 0;
  return stubTransport((req) => {
    if (req.url === `${BASE_URL}/videos/jobs` && req.method !== "GET") {
      return { status: 200, body: JSON.stringify({ id: "job-1" }) };
    }
    if (req.url === `${BASE_URL}/videos/jobs/job-1`) {
      polls += 1;
      if (opts.statusBody !== undefined) return opts.statusBody(polls);
      // First poll: still working. Second poll: done with a download URL.
      return polls < 2
        ? { status: 200, body: JSON.stringify({ status: "processing" }) }
        : {
            status: 200,
            body: JSON.stringify({
              status: "succeeded",
              video: { url: "https://cdn.example.com/v/clip.mp4" },
            }),
          };
    }
    if (req.url === "https://cdn.example.com/v/clip.mp4") {
      return { status: 200, body: "", rawBody: Buffer.from("fake-mp4-bytes") };
    }
    throw new Error(`unexpected request: ${req.url}`);
  }, captured);
}

function serviceWith(
  transport: VideoGenTransport,
  deps: {
    apiKey?: string;
    model?: string;
    pollIntervalMs?: number;
    maxPollAttempts?: number;
  } = {},
) {
  const tool = createVideoGenTool({
    baseUrl: BASE_URL,
    model: deps.model ?? "vid-model",
    ...(deps.apiKey !== undefined ? { apiKey: deps.apiKey } : {}),
    transport,
    resolver: stubResolver,
    ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
    ...(deps.maxPollAttempts !== undefined ? { maxPollAttempts: deps.maxPollAttempts } : {}),
  });
  return new ToolService({ extraTools: [tool as never] });
}

describe("generate_video registration", () => {
  test("declares its name, permission and enabled state", () => {
    const tool = createVideoGenTool({ baseUrl: BASE_URL, model: "vid-model" });
    expect(tool.name).toBe("generate_video");
    expect(tool.enabled).toBe(true);
    expect(tool.permission.requires).toEqual([GENERATE_VIDEO_PERMISSION]);
  });

  test("the permission constant has the tools: prefix", () => {
    expect(GENERATE_VIDEO_PERMISSION).toBe("tools:generate_video");
  });

  test("videoGenConfigured: empty base URL means the tool must not exist", () => {
    expect(videoGenConfigured("")).toBe(false);
    expect(videoGenConfigured("   ")).toBe(false);
    expect(videoGenConfigured(BASE_URL)).toBe(true);
  });

  test("the factory refuses to build an unconfigured tool", () => {
    expect(() => createVideoGenTool({ baseUrl: "", model: "vid-model" })).toThrow();
  });

  test("index.ts registers it only when an endpoint is configured", () => {
    const src = readFileSync("src/index.ts", "utf8");
    expect(src).toContain("videoGenConfigured(videoDeps.baseUrl)");
    expect(src).toContain("createVideoGenTool(");
  });

  test("prompt is length-bounded at the schema level", () => {
    const tool = createVideoGenTool({ baseUrl: BASE_URL, model: "vid-model" });
    const prompt = tool.input.fields["prompt"]!;
    expect(prompt.required).toBe(true);
    expect(prompt.minLength).toBe(1);
    expect(prompt.maxLength).toBe(1000);
  });

  test("size is an enum with the two supported sizes", () => {
    const tool = createVideoGenTool({ baseUrl: BASE_URL, model: "vid-model" });
    const size = tool.input.fields["size"]!;
    expect(size.type).toBe("enum");
    expect(size.choices).toEqual(["1280x720", "720x1280"]);
  });

  test("duration_seconds is bounded to 1..30", () => {
    const tool = createVideoGenTool({ baseUrl: BASE_URL, model: "vid-model" });
    const d = tool.input.fields["duration_seconds"]!;
    expect(d.type).toBe("integer");
    expect(d.minimum).toBe(1);
    expect(d.maximum).toBe(30);
  });
});

describe("generate_video env config", () => {
  test("reads BOBI_VIDEO_BASE_URL / BOBI_VIDEO_API_KEY / BOBI_VIDEO_MODEL", () => {
    const deps = videoGenDepsFromEnv({
      BOBI_VIDEO_BASE_URL: "https://v.example/v1",
      BOBI_VIDEO_API_KEY: "secret",
      BOBI_VIDEO_MODEL: "m1",
    } as NodeJS.ProcessEnv);
    expect(deps.baseUrl).toBe("https://v.example/v1");
    expect(deps.apiKey).toBe("secret");
    expect(deps.model).toBe("m1");
  });

  test("honours the SOL_ fallback prefix like the shared config loader", () => {
    const deps = videoGenDepsFromEnv({
      SOL_VIDEO_BASE_URL: "https://v2.example/v1",
    } as NodeJS.ProcessEnv);
    expect(deps.baseUrl).toBe("https://v2.example/v1");
    expect(deps.apiKey).toBeUndefined();
  });

  test("empty env means the tool must not be registered", () => {
    const deps = videoGenDepsFromEnv({} as NodeJS.ProcessEnv);
    expect(videoGenConfigured(deps.baseUrl)).toBe(false);
  });
});

describe("generate_video request shape", () => {
  test("submits POST {baseUrl}/videos/jobs with n=1", async () => {
    const captured: Captured[] = [];
    const svc = serviceWith(lifecycleTransport(captured), { apiKey: "k", pollIntervalMs: 1 });
    const r = await svc.runTool({
      tool: "generate_video",
      input: { prompt: "a cat dancing" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("ok");
    const submit = captured[0]!;
    expect(submit.url).toBe(`${BASE_URL}/videos/jobs`);
    const body = JSON.parse(submit.body) as Record<string, unknown>;
    expect(body).toEqual({
      model: "vid-model",
      prompt: "a cat dancing",
      n: 1,
      size: "1280x720",
      duration_seconds: 5,
    });
    expect(submit.headers["authorization"]).toBe("Bearer k");
    expect(submit.headers["content-type"]).toBe("application/json");
    expect(submit.timeoutMs).toBe(VIDEO_REQUEST_TIMEOUT_MS);
  });

  test("the requested size and duration are forwarded", async () => {
    const captured: Captured[] = [];
    const svc = serviceWith(lifecycleTransport(captured), { pollIntervalMs: 1 });
    await svc.runTool({
      tool: "generate_video",
      input: { prompt: "x", size: "720x1280", duration_seconds: 10 },
      actor: FULL_ACTOR,
    });
    const body = JSON.parse(captured[0]!.body) as Record<string, unknown>;
    expect(body["size"]).toBe("720x1280");
    expect(body["duration_seconds"]).toBe(10);
  });

  test("no Authorization header is sent without a key", async () => {
    const captured: Captured[] = [];
    const svc = serviceWith(lifecycleTransport(captured), { pollIntervalMs: 1 });
    await svc.runTool({ tool: "generate_video", input: { prompt: "x" }, actor: FULL_ACTOR });
    expect(captured[0]!.headers["authorization"]).toBeUndefined();
  });

  test("the poll loop hits the status endpoint, then downloads the video URL", async () => {
    const captured: Captured[] = [];
    const svc = serviceWith(lifecycleTransport(captured), { pollIntervalMs: 1 });
    const r = await svc.runTool({
      tool: "generate_video",
      input: { prompt: "x" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("ok");
    const urls = captured.map((c) => c.url);
    expect(urls).toContain(`${BASE_URL}/videos/jobs/job-1`);
    expect(urls).toContain("https://cdn.example.com/v/clip.mp4");
    const download = captured.find((c) => c.url === "https://cdn.example.com/v/clip.mp4")!;
    expect(download.method).toBe("GET");
  });

  test("an inline base64 video needs no download leg", async () => {
    const captured: Captured[] = [];
    const transport = lifecycleTransport(captured, {
      statusBody: () => ({
        status: 200,
        body: JSON.stringify({ status: "succeeded", video: { b64: "QUJD" } }),
      }),
    });
    const svc = serviceWith(transport, { pollIntervalMs: 1 });
    const r = await svc.runTool({
      tool: "generate_video",
      input: { prompt: "x" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("ok");
    expect(r.media).toEqual([
      { type: "document", mediaType: "video/mp4", base64: "QUJD", name: "bobi.mp4" },
    ]);
    expect(captured.some((c) => c.method === "GET" && !c.url.includes("jobs"))).toBe(false);
  });

  test("the tool declares a long executor timeout for the poll loop", () => {
    const tool = createVideoGenTool({ baseUrl: BASE_URL, model: "vid-model" });
    expect(tool.timeoutMs).toBeGreaterThan(VIDEO_JOB_TIMEOUT_MS);
  });
});

describe("generate_video validation", () => {
  test("a 1001-char prompt is rejected before any request", async () => {
    const captured: Captured[] = [];
    const svc = serviceWith(lifecycleTransport(captured));
    const r = await svc.runTool({
      tool: "generate_video",
      input: { prompt: "a".repeat(1001) },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("invalid_input");
    expect(captured).toHaveLength(0);
  });

  test("a 1000-char prompt is accepted", async () => {
    const r = await serviceWith(lifecycleTransport(), { pollIntervalMs: 1 }).runTool({
      tool: "generate_video",
      input: { prompt: "a".repeat(1000) },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("ok");
  });

  test("an unknown size is rejected", async () => {
    const r = await serviceWith(lifecycleTransport()).runTool({
      tool: "generate_video",
      input: { prompt: "x", size: "512x512" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("invalid_input");
  });

  test("a blank prompt is rejected", async () => {
    const r = await serviceWith(lifecycleTransport()).runTool({
      tool: "generate_video",
      input: { prompt: "   " },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("invalid_input");
  });
});

describe("generate_video media seam", () => {
  test("extractMedia returns the downloaded bytes as a video document part", async () => {
    const svc = serviceWith(lifecycleTransport(), { pollIntervalMs: 1 });
    const r = await svc.runTool({
      tool: "generate_video",
      input: { prompt: "a cat" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("ok");
    expect(r.media).toEqual([
      {
        type: "document",
        mediaType: "video/mp4",
        base64: Buffer.from("fake-mp4-bytes").toString("base64"),
        name: "bobi.mp4",
      },
    ]);
  });

  test("data is model-safe: no base64, only metadata", async () => {
    const svc = serviceWith(lifecycleTransport(), { pollIntervalMs: 1 });
    const r = await svc.runTool({
      tool: "generate_video",
      input: { prompt: "a cat" },
      actor: FULL_ACTOR,
    });
    expect(r.data).toEqual({
      ok: true,
      prompt: "a cat",
      size: "1280x720",
      durationSeconds: 5,
    });
    expect(JSON.stringify(r.data)).not.toContain("ZmFrZS");
  });
});

describe("generate_video poll bounds", () => {
  test("a job that never finishes ends as a timeout after the attempt cap", async () => {
    const captured: Captured[] = [];
    const transport = stubTransport((req) => {
      if (req.url === `${BASE_URL}/videos/jobs` && req.method !== "GET") {
        return { status: 200, body: JSON.stringify({ id: "job-9" }) };
      }
      return { status: 200, body: JSON.stringify({ status: "processing" }) };
    }, captured);
    const svc = serviceWith(transport, { pollIntervalMs: 1, maxPollAttempts: 3 });
    const r = await svc.runTool({
      tool: "generate_video",
      input: { prompt: "x" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("error");
    // The executor maps timeouts to the generic English message by design.
    expect(r.message).toBe("The tool run timed out.");
    // 1 submit + 3 status polls, then the loop gives up.
    expect(captured.filter((c) => c.url.includes("jobs/job-9"))).toHaveLength(3);
  });

  test("a failed job is an invalid result, not a hang", async () => {
    const transport = lifecycleTransport([], {
      statusBody: () => ({ status: 200, body: JSON.stringify({ status: "failed" }) }),
    });
    const svc = serviceWith(transport, { pollIntervalMs: 1 });
    const r = await svc.runTool({
      tool: "generate_video",
      input: { prompt: "x" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("error");
    // The executor sanitises invalid_result messages by design (executor.ts),
    // so the tool's own detail never reaches the user.
    expect(r.message).toBe("The tool returned an invalid result.");
  });

  test("production defaults bound the loop by time AND attempts", () => {
    expect(VIDEO_JOB_TIMEOUT_MS).toBe(10 * 60 * 1000);
    expect(MAX_POLL_ATTEMPTS).toBe(120);
    expect(POLL_INTERVAL_MS).toBe(5_000);
  });
});

describe("generate_video failure mapping", () => {
  function svcWithStatus(status: number, body: string) {
    return serviceWith(stubTransport(() => ({ status, body })));
  }

  test("rate limiting becomes overloaded, not a retry-now error", async () => {
    const svc = serviceWith(
      stubTransport(() => {
        throw new AiError("quota", "limited");
      }),
    );
    const r = await svc.runTool({
      tool: "generate_video",
      input: { prompt: "x" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("error");
    expect(r.message).toContain("busy");
  });

  test("HTTP 429 on submit maps to overloaded", async () => {
    const r = await svcWithStatus(429, "{}").runTool({
      tool: "generate_video",
      input: { prompt: "x" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("error");
    expect(r.message).toContain("busy");
  });

  test("HTTP 401 maps to not_allowed without echoing the body", async () => {
    const r = await svcWithStatus(401, '{"error":"bad key hunter2"}').runTool({
      tool: "generate_video",
      input: { prompt: "x" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("not_allowed");
    expect(r.message).not.toContain("hunter2");
  });

  test("a submit response without a job id is an invalid result", async () => {
    const r = await svcWithStatus(200, "{}").runTool({
      tool: "generate_video",
      input: { prompt: "x" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("error");
  });

  test("a terminal payload without video is an invalid result", async () => {
    const transport = lifecycleTransport([], {
      statusBody: () => ({ status: 200, body: JSON.stringify({ status: "succeeded" }) }),
    });
    const r = await serviceWith(transport, { pollIntervalMs: 1 }).runTool({
      tool: "generate_video",
      input: { prompt: "x" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("error");
  });

  test("a malformed JSON body is an invalid result", async () => {
    const r = await svcWithStatus(200, "not json").runTool({
      tool: "generate_video",
      input: { prompt: "x" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("error");
  });

  test("a transport timeout becomes the timeout category", async () => {
    const svc = serviceWith(
      stubTransport(() => {
        throw new AiError("timeout", "slow");
      }),
    );
    const r = await svc.runTool({
      tool: "generate_video",
      input: { prompt: "x" },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("error");
  });
});
