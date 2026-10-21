/**
 * Tool plugin architecture — contract tests (Coordinator E).
 *
 * Three suites:
 * 1. Dependency audit: no RUNTIME import from src/tools/* into the AI,
 *    agent, or bot layers beyond an explicit justified allowlist. This
 *    is the executable form of "tools are independent plugins": a new
 *    cross-layer import fails CI instead of quietly coupling the core
 *    to a tool again.
 * 2. Manifest contract: every built-in plugin manifest validates, ids
 *    are unique, and statically-registered tools carry their manifest.
 * 3. Intent router: deterministic hints for the reference flows.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ToolService } from "../src/tools/service";
import {
  assertPluginCatalog,
  getPluginManifests,
  pluginTools,
} from "../src/tools/plugins";
import {
  validateCatalog,
  validateManifest,
} from "../src/tools/validate_manifest";
import type { ToolManifest } from "../src/tools/manifest";
import { createCommandsTool } from "../src/tools/commands";
import {
  detectIntents,
  extractUrls,
  hasStrongIntent,
  intentRouterEnabled,
} from "../src/routing/intent";

const TOOLS_DIR = join(import.meta.dir, "..", "src", "tools");

/** Runtime (non-type-only) import specifiers of one source file. */
function runtimeImports(source: string): string[] {
  const specifiers: string[] = [];
  const re = /^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gms;
  for (const match of source.matchAll(re)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * Justified cross-layer allowances (see the audit in the final report):
 * - ../ai/provider is the shared error vocabulary (AiError) + types.
 * - ../ai/dns_guard + ../ai/pinned_transport are the SSRF-safe HTTP
 *   primitives — infrastructure, the same class as node:* imports.
 * Everything else is a named, single-file exception.
 */
const SHARED_INFRA = new Set(["../ai/provider", "../ai/dns_guard", "../ai/pinned_transport"]);
const FILE_EXCEPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  // Mixture fan-out is a provider-agnostic algorithm; the provider
  // itself is injected via the tool's deps.
  "consult_models.ts": new Set(["../ai/mixture"]),
  // Delegation primitive: spawns the child loop with an injected
  // provider; full decoupling needs composition-root wiring.
  "delegate.ts": new Set(["../agent/loop"]),
  // Usage ledger reader (observability infra, not a model call).
  "usage_report.ts": new Set(["../ai/usage"]),
  // Optional listCommands dep exists; the bot catalog import is the
  // backward-compatible fallback until the root passes it explicitly.
  "commands.ts": new Set(["../bot/command_help"]),
};

describe("dependency audit: tools do not reach into ai/agent/bot at runtime", () => {
  test("every cross-layer runtime import is allowlisted", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(TOOLS_DIR)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(TOOLS_DIR, file), "utf8");
      for (const spec of runtimeImports(source)) {
        if (!/^\.\.\/(ai|agent|bot)\//.test(spec)) continue;
        if (SHARED_INFRA.has(spec)) continue;
        if (FILE_EXCEPTIONS[file]?.has(spec) === true) continue;
        offenders.push(`${file} imports ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no tool imports a gateway, adapter, prompt, or bot module directly", () => {
    const forbidden = /\.\.\/(ai\/(gateway|adapter|anthropic|gemini|openai|smart_router)|agent\/(prompt|stream)|bot\/)/;
    const offenders: string[] = [];
    for (const file of readdirSync(TOOLS_DIR)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(TOOLS_DIR, file), "utf8");
      for (const spec of runtimeImports(source)) {
        if (forbidden.test(spec) && FILE_EXCEPTIONS[file]?.has(spec) !== true) {
          offenders.push(`${file} imports ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("service.ts registers via the plugin barrel only", () => {
    const source = readFileSync(join(TOOLS_DIR, "service.ts"), "utf8");
    expect(source).toContain('from "./plugins"');
    const directToolImports = runtimeImports(source).filter((spec) =>
      /^\.\/(calculator|date_time|fetch_url|unit_converter|text_utilities|downloader|memory|reminders)$/.test(spec),
    );
    expect(directToolImports).toEqual([]);
  });
});

describe("plugin manifest contract", () => {
  test("the real catalog validates clean", () => {
    expect(validateCatalog(getPluginManifests())).toEqual([]);
    expect(() => assertPluginCatalog()).not.toThrow();
  });

  test("catalog covers every built-in tool exactly once", () => {
    const ids = getPluginManifests().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("download_media");
    expect(ids).toContain("remind_at");
    expect(ids.length).toBe(49);
  });

  test("static plugin tools carry manifests matching their names", () => {
    const service = new ToolService();
    for (const tool of pluginTools) {
      expect(tool.manifest).toBeDefined();
      expect(tool.manifest?.id).toBe(tool.name);
      expect(service.registry.find(tool.name)?.manifest?.id).toBe(tool.name);
    }
  });

  test("factory tools carry their manifests too", () => {
    const commands = createCommandsTool({ isOwner: () => false });
    expect(commands.manifest?.id).toBe("commands");
  });

  test("validateManifest rejects the classic mistakes", () => {
    const base: ToolManifest = {
      id: "ok_tool",
      version: "1.0.0",
      title: "OK",
      purpose: "perfectly fine tool",
      useWhen: "a fine case arises",
      doNotUseWhen: "when something else fits the request better",
      confusableWith: [],
      latencyTier: "instant",
      description: "A perfectly fine description.",
      outputSummary: "Something useful.",
      category: "utils",
    };
    expect(validateManifest(base)).toEqual([]);
    expect(validateManifest({ ...base, id: "Bad ID" }).length).toBeGreaterThan(0);
    expect(validateManifest({ ...base, description: "short" }).length).toBeGreaterThan(0);
    expect(validateManifest({ ...base, timeoutMs: 5 }).length).toBeGreaterThan(0);
    expect(
      validateManifest({ ...base, triggers: { keywordPatterns: ["(["] } }).length,
    ).toBeGreaterThan(0);
    expect(
      validateCatalog([base, { ...base }]).some((p) => p.includes("duplicate")),
    ).toBe(true);
    // Desk-card fields are all required: removing any one is a problem.
    const without = (field: string): string[] => {
      const copy: Record<string, unknown> = { ...base };
      delete copy[field];
      return validateManifest(copy as unknown as ToolManifest);
    };
    for (const field of ["purpose", "useWhen", "doNotUseWhen", "confusableWith", "latencyTier"]) {
      expect(without(field).length).toBeGreaterThan(0);
    }
    expect(
      validateManifest({
        ...base,
        latencyTier: "eventually" as ToolManifest["latencyTier"],
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateManifest({
        ...base,
        confusableWith: [{ tool: "ok_tool", difference: "the same tool, not a peer" }],
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateCatalog([
        {
          ...base,
          confusableWith: [{ tool: "ghost_tool", difference: "a different tool entirely" }],
        },
      ]).some((p) => p.includes("unknown") && p.includes("ghost_tool")),
    ).toBe(true);
  });
});

describe("intent router", () => {
  const catalog = getPluginManifests();
  const now = new Date("2026-10-20T05:00:00Z"); // Tue 08:30 Tehran

  test("bare YouTube URL routes to the downloader at 0.95", () => {
    const hints = detectIntents("https://www.youtube.com/watch?v=dQw4w9WgXcQ", catalog);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]?.toolId).toBe("download_media");
    expect(hints[0]?.confidence).toBe(0.95);
    expect(hints[0]?.extractedArgs["url"]).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(hasStrongIntent(hints)).toBe(true);
  });

  test("Instagram reel URL inside Persian text routes to the downloader", () => {
    const hints = detectIntents("اینو ببین https://www.instagram.com/reel/C8xyzAb/ قشنگه", catalog);
    expect(hints[0]?.toolId).toBe("download_media");
    expect(hints[0]?.confidence).toBe(0.95);
  });

  test("Persian reminder with a parseable date routes to remind_at with args", () => {
    const hints = detectIntents("یادم بنداز فردا ساعت ۹ به مامانم زنگ بزنم", catalog, { now });
    const hint = hints.find((h) => h.toolId === "remind_at");
    expect(hint).toBeDefined();
    expect(hint?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(typeof hint?.extractedArgs["dueAt"]).toBe("string");
    expect(String(hint?.extractedArgs["text"])).not.toContain("یادم بنداز");
    expect(hasStrongIntent(hints)).toBe(true);
  });

  test("Persian math phrase routes to the calculator with extracted operands", () => {
    const hints = detectIntents("حساب کن ۱۲*۸", catalog);
    const hint = hints.find((h) => h.toolId === "calculator");
    expect(hint).toBeDefined();
    expect(hint?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(hint?.extractedArgs).toMatchObject({ op: "multiply", a: 12, b: 8 });
  });

  test("mixed message yields multiple hints, sorted, capped at 3", () => {
    const hints = detectIntents(
      "یادم بنداز فردا ساعت ۹ نون بخرم و اینو دانلود کن https://youtu.be/abc123 و حساب کن ۳+۴",
      catalog,
      { now },
    );
    const ids = hints.map((h) => h.toolId);
    expect(ids).toContain("remind_at");
    expect(ids).toContain("download_media");
    expect(hints.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < hints.length; i++) {
      expect(hints[i - 1]!.confidence).toBeGreaterThanOrEqual(hints[i]!.confidence);
    }
  });

  test("small talk yields no hints", () => {
    expect(detectIntents("سلام، خوبی؟ چه خبر؟", catalog, { now })).toEqual([]);
    expect(detectIntents("", catalog)).toEqual([]);
  });

  test("audio request on a media URL pre-extracts audio_only", () => {
    const hints = detectIntents("فقط صداشو میخوام https://www.youtube.com/watch?v=abc123", catalog);
    const hint = hints.find((h) => h.toolId === "download_media");
    expect(hint?.extractedArgs["audio_only"]).toBe(true);
  });

  test("kill switch BOBI_INTENT_ROUTER=0 disables detection", () => {
    const prev = process.env["BOBI_INTENT_ROUTER"];
    process.env["BOBI_INTENT_ROUTER"] = "0";
    try {
      expect(intentRouterEnabled()).toBe(false);
      expect(detectIntents("https://www.youtube.com/watch?v=abc123", catalog)).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env["BOBI_INTENT_ROUTER"];
      else process.env["BOBI_INTENT_ROUTER"] = prev;
    }
  });

  test("extractUrls trims sentence punctuation", () => {
    expect(extractUrls("ببین (https://x.com/a/status/1).")).toEqual(["https://x.com/a/status/1"]);
  });
});
