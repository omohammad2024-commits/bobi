/**
 * Unified platform proof (platform Phase 5, step H) — the roadmap's
 * «یه بابی واحد» ("one single BOBI") demo, as a hermetic test.
 *
 * buildPlatform(config, { surface: "mcp" }) builds the SAME platform the
 * Telegram starter runs — same full tool wiring, same memory stack, same
 * provider gateway — with no Telegram machinery: no bot is created, the
 * Telegram surface is never started, no token is required, no network is
 * touched. Everything runs on a temp-file SQLite DB.
 *
 * What is pinned here:
 *   1. The platform's tool registry is the FULL desk, not the bare
 *      ToolService defaults — the MCP-unification property: an MCP
 *      surface mounted on this platform exposes every composed tool.
 *   2. Surfaces share state: a long-term memory written through the
 *      platform's memory facade is readable from the storage an MCP
 *      server built the way src/mcp/serve.ts builds it holds, and
 *      conversations created through one surface (the platform engine /
 *      an MCP bobi_send_message call) are listed by the other.
 *   3. Single selection: the providers facade's currentSelection()
 *      agrees with the gateway's — there is one selection computation
 *      (AiGateway.currentSelection), the facade only delegates to it.
 *
 * Hermetic pattern (following tests/integration_core_upgrade.test.ts):
 * config is built by passing an explicit env object to loadConfig()
 * (temp DB path, owner id, dummy master key), and the few values
 * buildPlatform reads straight from process.env (plugins/hooks dirs,
 * video-gen base URL, context files, memory provider) are pointed at
 * the temp dir / neutral values for the duration of the file and
 * restored afterwards. No providers are configured on the fresh DB, so
 * engine turns take the composed provider's no-selection fallback
 * (model "fake", a diagnostic reply) — no real provider is ever called.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPlatform } from "../src/bootstrap";
import { loadConfig } from "../src/config/config";
import { createMcpServer } from "../src/mcp/server";
import type { McpServer } from "../src/mcp/server";
import { authorizeToolUse, toToolActor } from "../src/auth/tool_bridge";
import { ToolService } from "../src/tools/service";
import type { ToolActor } from "../src/tools/types";
import type { Platform } from "../src/platform/index";

/** Owner id used throughout: a valid numeric Telegram-shaped id. */
const OWNER_ID = "424242001";
const MEMORY_KEY = "phase5:unified-probe";
const MEMORY_CONTENT = "unified platform probe memory — قهوه تلخ";

/** process.env keys buildPlatform reads directly (not via SolConfig). */
const PROCESS_ENV_KEYS = [
  "BOBI_PLUGINS_DIR",
  "BOBI_HOOKS_DIR",
  "BOBI_VIDEO_BASE_URL",
  "SOL_VIDEO_BASE_URL",
  "BOBI_CONTEXT_FILES",
  "BOBI_MEMORY_PROVIDER",
] as const;

let dir = "";
let dbPath = "";
let platform: Platform | undefined;
let ownerActor: ToolActor;
let mcp: McpServer;
const savedEnv = new Map<string, string | undefined>();

/** Call one MCP tool over the in-process server; return its parsed payload. */
async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const res = await mcp.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = (
    res as {
      result: { content: { text: string }[]; isError?: boolean };
    }
  ).result;
  const first = result.content[0];
  if (first === undefined) throw new Error("MCP tool returned no content");
  return {
    isError: result.isError === true,
    payload: JSON.parse(first.text) as Record<string, unknown>,
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "bobi-platform-unified-"));
  dbPath = join(dir, "bobi.db");

  for (const key of PROCESS_ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.BOBI_PLUGINS_DIR = join(dir, "plugins"); // absent → no plugins
  process.env.BOBI_HOOKS_DIR = join(dir, "hooks"); // absent → no hook files
  process.env.BOBI_VIDEO_BASE_URL = ""; // video_gen tool stays unregistered
  delete process.env.SOL_VIDEO_BASE_URL;
  const contextFile = join(dir, "context.md"); // empty project-context file
  writeFileSync(contextFile, "");
  process.env.BOBI_CONTEXT_FILES = contextFile;
  delete process.env.BOBI_MEMORY_PROVIDER; // default "sqlite" provider

  const config = loadConfig({
    BOBI_ENV: "test",
    BOBI_LOG_LEVEL: "error",
    BOBI_DB_PATH: dbPath,
    OWNER_TELEGRAM_ID: OWNER_ID,
    BOBI_AI_KEY_MASTER_KEY: "platform-unified-test-master-key",
    BOBI_SKILLS_DIR: join(dir, "skills"), // absent → no skills
    BOBI_MCP_CONFIG: join(dir, "mcp.json"), // absent → no external MCP servers
    // No TELEGRAM_BOT_TOKEN on purpose: the mcp surface must not need one.
  });
  const built = await buildPlatform(config, { surface: "mcp" });
  if (built === undefined) throw new Error("buildPlatform failed closed unexpectedly");
  platform = built;

  // The MCP surface, built exactly the way src/mcp/serve.ts builds it:
  // same storage, the platform's own engine, and an owner actor resolved
  // server-side from the validated owner identity.
  ownerActor = toToolActor(
    authorizeToolUse(platform.auth, { id: Number(OWNER_ID) }, platform.tools.registry.list()),
  );
  mcp = createMcpServer({
    storage: platform.storage,
    engineFactory: () => platform!.turn.engine,
    ownerActor,
  });
});

afterAll(() => {
  platform?.turn.engine.cancelAll();
  platform?.storage.close();
  for (const key of PROCESS_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

function requirePlatform(): Platform {
  if (platform === undefined) throw new Error("platform was not built");
  return platform;
}

describe("unified platform (surface: mcp)", () => {
  test("builds without a bot token and starts no Telegram surface", () => {
    const p = requirePlatform();
    expect(p.bot).toBeUndefined();
    expect(p.token).toBe("");
    expect(p.ownerIdStr).toBe(OWNER_ID);
    expect(p.config.dbPath).toBe(dbPath);
    // The turn facade and the platform handle are the same engine object.
    expect(p.turn.engine).toBe(p.engine);
  });

  test("tool registry is the FULL desk, not a bare ToolService registry", () => {
    const p = requirePlatform();
    // Observed counts at pinning time (Phase 5 step H), under the
    // hermetic env above (no image/video endpoints, no external MCP
    // servers, no provider selection):
    //   bare new ToolService()  →  6 tools (the static plugin defaults:
    //     calculator, date_time, text_utilities, unit_converter, fetch_url,
    //     weather — Phase 9)
    //   platform tools facade   → 42 tools (defaults + every factory tool
    //     the composition root wires: memory, history, reminders,
    //     downloader, nudges, goals, scheduled tasks, usage report,
    //     commands, bench, digest, curator, group_digest, web_search,
    //     skills, tool_search, delegate, shortcuts, consult_models, ...)
    // Phase 8: consult_models is registered UNCONDITIONALLY — it is
    // present even with no provider configured (it resolves its
    // provider live per run and reports not-configured honestly).
    // Phase 8 also merged the silos: the five nudge tools and
    // remind_nl folded into the reminder family, summarize_memories
    // folded into the curator, and snooze_reminder was added — a net
    // −5 against the earlier 42, so the count is 37.
    // Phase 9 (action layer): weather joined the static defaults
    // (bare 5 → 6, platform 37 → 38) and nine factory tools landed —
    // currency_rates, todo_list, read_calendar, files, telegram_action,
    // moderate_member, extract_document, transcribe_audio,
    // text_to_speech — bringing the platform desk to 47.
    // The pinned property is the relationship — the platform desk is a
    // strict superset many times the bare defaults — with the observed
    // counts asserted exactly so a lost wiring step fails loudly.
    const bareCount = new ToolService().registry.list().length;
    const platformTools = p.tools.list();
    expect(bareCount).toBe(6);
    expect(platformTools.length).toBe(47);
    expect(platformTools.length).toBeGreaterThan(bareCount);

    const names = platformTools.map((t) => t.name);
    // Factory/composed tools a bare ToolService never has — the tools an
    // MCP client of the old hand-wired serve.ts would have missed.
    for (const composed of [
      "remember",
      "recall",
      "schedule_task",
      "download_media",
      "run_bench",
      "build_digest",
      "web_search",
      "delegate",
      "tool_search",
      // Phase 8: present even though this platform has NO provider
      // configured — registration no longer depends on a boot selection.
      "consult_models",
    ]) {
      expect(names).toContain(composed);
    }
    // The facade's registry IS the service's registry (one desk, shared).
    expect(p.tools.registry).toBe(p.tools.service.registry);
  });

  test("memory written via the facade is visible through the MCP surface's storage", async () => {
    const p = requirePlatform();
    // Write through the platform's memory facade (its provider handle).
    await p.memory.provider.upsert(OWNER_ID, MEMORY_KEY, MEMORY_CONTENT);
    expect(p.memory.handle).toBe(p.memory.provider);

    // Read back through the storage object the MCP server was built with
    // (createMcpServer holds this exact instance — see beforeAll): the
    // facade and the MCP surface operate on ONE memory stack.
    const viaMcpStorage = p.storage.getMemory(OWNER_ID, MEMORY_KEY);
    expect(viaMcpStorage?.content).toBe(MEMORY_CONTENT);

    // And back through the facade itself, keyed exactly as written.
    const viaFacade = await p.memory.provider.get(OWNER_ID, MEMORY_KEY);
    expect(viaFacade?.content).toBe(MEMORY_CONTENT);
  });

  test("conversations cross surfaces: engine turns are listed by MCP and vice versa", async () => {
    const p = requirePlatform();

    // A turn through the PLATFORM engine (the Telegram surface's engine
    // object — the same instance the MCP engineFactory returns).
    const out = await p.turn.respond({
      conversationId: "unified-engine-chat",
      userId: OWNER_ID,
      userText: "سلام از موتور پلتفرم",
      actor: ownerActor,
    });
    // No providers on a fresh DB: the composed provider's fallback answers
    // with the no-selection diagnostic instead of calling the network.
    expect(out.model).toBe("fake");
    expect(out.chunks.join("\n")).toContain("No provider and model selected yet");

    // ... is listed by the MCP server (same storage, same engine).
    const listedAfterEngine = await callMcpTool("bobi_list_conversations", {
      userId: OWNER_ID,
    });
    expect(listedAfterEngine.isError).toBe(false);
    const engineConvs = listedAfterEngine.payload["conversations"] as {
      conversationId: string;
      messageCount: number;
    }[];
    const engineConv = engineConvs.find((c) => c.conversationId === "unified-engine-chat");
    expect(engineConv?.messageCount).toBe(2);

    // A turn through the MCP surface (bobi_send_message) ...
    const sent = await callMcpTool("bobi_send_message", {
      userId: OWNER_ID,
      conversationId: "unified-mcp-chat",
      text: "سلام از ام‌سی‌پی",
    });
    expect(sent.isError).toBe(false);
    expect(sent.payload["model"]).toBe("fake");

    // ... is persisted in the platform's storage, readable directly ...
    const history = p.storage.history(OWNER_ID, "unified-mcp-chat");
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(history[0]?.content).toBe("سلام از ام‌سی‌پی");

    // ... and listed alongside the engine's conversation by MCP itself:
    // one conversation space, two surfaces.
    const listedBoth = await callMcpTool("bobi_list_conversations", {
      userId: OWNER_ID,
    });
    const allIds = (
      listedBoth.payload["conversations"] as { conversationId: string }[]
    ).map((c) => c.conversationId);
    expect(allIds).toContain("unified-engine-chat");
    expect(allIds).toContain("unified-mcp-chat");
  });

  // Declared last on purpose: it configures a provider selection, which
  // changes what later engine turns would do — nothing after it needs one.
  test("single selection: the facade's currentSelection() agrees with the gateway's", () => {
    const p = requirePlatform();

    // Fresh DB: no selection anywhere — facade and gateway agree (both
    // undefined, because the facade delegates to the one computation).
    expect(p.providers.currentSelection()).toBeUndefined();
    expect(p.providers.gateway.currentSelection()).toBeUndefined();
    expect(p.providers.handle).toBe(p.providers.gateway);

    // Configure a selection through the facade's own service handles
    // (no network: create/add only write rows; nothing probes).
    const created = p.providers.providers.create({
      label: "unified-probe",
      adapter: "openai_compatible",
      baseUrl: "https://unified.invalid/v1",
      apiKey: "<redacted>",
    });
    if (!created.ok) throw new Error("provider create failed");
    const providerId = created.data;
    const added = p.providers.models.add({
      providerId,
      modelId: "model-unified-1",
      label: "unified-1",
    });
    if (!added.ok) throw new Error("model add failed");
    p.storage.setRuntimeSelection({ providerId, modelId: added.data });

    // Now both surfaces of the selection return the same value: the
    // facade's answer and the gateway's answer are one computation, so
    // they cannot drift. (Each call builds a fresh object — equality is
    // by value, and the identifying fields are pinned explicitly.)
    const viaFacade = p.providers.currentSelection();
    const viaGateway = p.providers.gateway.currentSelection();
    expect(viaFacade).toEqual(viaGateway);
    expect(viaFacade?.providerId).toBe(providerId);
    expect(viaFacade?.modelId).toBe("model-unified-1");
    expect(viaFacade?.adapterType).toBe("openai_compatible");
  });
});
