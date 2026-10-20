/**
 * Tool desk — Phase-1 contract tests.
 *
 * Pins the desk-card contracts end to end:
 * 1. Catalog completeness: exactly the 44 built-in ids, validateCatalog
 *    clean, every card fully filled in.
 * 2. Desk block: buildSystemPrompt renders one exact card line per tool
 *    under the desk header, with nothing counted away, within budget.
 * 3. Registration contract: a tool whose ATTACHED card is incomplete is
 *    rejected by the registry; a complete card registers; a tool with
 *    no card at all (the external/MCP contract) registers fine.
 * 4. Service seam: ToolService.listActive() descriptors for the
 *    statically-registered tools carry purpose/useWhen from their cards.
 *
 * Import order matters: service is imported before plugins/prompt so
 * the tool-module/service cycle initializes the same way as in the
 * other tool test suites.
 */
import { describe, expect, test } from "bun:test";

import { ToolService } from "../src/tools/service";
import type { ToolDescriptor } from "../src/tools/service";
import { getPluginManifests, pluginTools } from "../src/tools/plugins";
import { validateCatalog } from "../src/tools/validate_manifest";
import { ToolRegistry } from "../src/tools/registry";
import type { ToolManifest } from "../src/tools/manifest";
import type { Tool } from "../src/tools/types";
import { buildSystemPrompt, estimatePromptTokens } from "../src/agent/prompt";

// ---------- catalog completeness ----------

/** The exact built-in catalog, in catalog order — no more, no fewer. */
const EXPECTED_IDS = [
  "ack_nudge",
  "add_goal",
  "build_digest",
  "calculator",
  "cancel_reminder",
  "cancel_task",
  "commands",
  "complete_goal",
  "consult_models",
  "curate_memories",
  "curator_decide",
  "date_time",
  "delegate",
  "download_media",
  "fetch_url",
  "forget",
  "generate_image",
  "generate_video",
  "group_digest",
  "list_events",
  "list_goals",
  "list_nudges",
  "list_reminders",
  "list_tasks",
  "note_event",
  "note_followup",
  "recall",
  "remind_at",
  "remind_nl",
  "remember",
  "run_bench",
  "schedule_task",
  "search_history",
  "shortcut_add",
  "shortcut_delete",
  "shortcut_list",
  "skills",
  "snooze_nudge",
  "summarize_memories",
  "text_utilities",
  "tool_search",
  "unit_converter",
  "usage_report",
  "web_search",
] as const;

const LATENCY_TIERS = new Set(["instant", "seconds", "minutes"]);

describe("desk catalog completeness", () => {
  test("catalog is exactly the 44 expected ids and validates clean", () => {
    const manifests = getPluginManifests();
    expect(manifests.length).toBe(44);
    expect(manifests.map((m) => m.id)).toEqual([...EXPECTED_IDS]);
    expect(new Set(manifests.map((m) => m.id)).size).toBe(44);
    expect(validateCatalog(manifests)).toEqual([]);
  });

  test("every manifest carries a complete desk card", () => {
    for (const manifest of getPluginManifests()) {
      expect(manifest.purpose.length).toBeGreaterThan(0);
      expect(manifest.useWhen.length).toBeGreaterThan(0);
      expect(manifest.doNotUseWhen.length).toBeGreaterThan(0);
      expect(Array.isArray(manifest.confusableWith)).toBe(true);
      expect(LATENCY_TIERS.has(manifest.latencyTier)).toBe(true);
    }
  });
});

// ---------- desk block in the prompt ----------

const DESK_HEADER =
  "Tool desk (44) — every tool you may use; each line: what — when to pick it up:";

describe("desk block", () => {
  const manifests = getPluginManifests();
  const descriptors: ToolDescriptor[] = manifests.map((m) => ({
    name: m.id,
    description: m.description,
    purpose: m.purpose,
    useWhen: m.useWhen,
    enabled: true,
    requires: [],
  }));
  const prompt = buildSystemPrompt({
    tools: descriptors,
    now: new Date("2026-10-18T12:00:00Z"),
    timezone: "Asia/Tehran",
  });
  const promptLines = prompt.split("\n");
  const headerIndex = promptLines.indexOf(DESK_HEADER);
  const deskBlock = promptLines
    .slice(headerIndex, headerIndex + 1 + manifests.length)
    .join("\n");

  test("prompt carries the desk header", () => {
    expect(headerIndex).toBeGreaterThanOrEqual(0);
    expect(prompt).toContain(DESK_HEADER);
  });

  test("every id appears exactly once as its exact card line", () => {
    for (const manifest of manifests) {
      const line = `- ${manifest.id}: ${manifest.purpose} — ${manifest.useWhen}`;
      expect(promptLines.filter((l) => l === line)).toHaveLength(1);
    }
  });

  test("no tool is counted away", () => {
    expect(prompt).not.toContain("Plus ");
  });

  test("desk block stays within the token budget (measured: 570)", () => {
    const tokens = estimatePromptTokens(deskBlock);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThanOrEqual(600);
  });
});

// ---------- registration contract ----------

function completeCard(id: string): ToolManifest {
  return {
    id,
    version: "1.0.0",
    title: "Desk Probe",
    purpose: "desk contract probe",
    useWhen: "a desk test runs",
    doNotUseWhen: "when the test is not about the desk contract",
    confusableWith: [],
    latencyTier: "instant",
    description: "A fake tool used only to pin the desk registration contract.",
    outputSummary: "A probe result.",
    category: "utils",
  };
}

function fakeTool(
  name: string,
  manifest?: ToolManifest,
): Tool<Record<string, unknown>, { ok: boolean }> {
  return {
    name,
    description: `${name} fake tool for desk tests.`,
    enabled: true,
    permission: { requires: [] },
    input: { fields: {} },
    ...(manifest !== undefined ? { manifest } : {}),
    async run() {
      return { ok: true };
    },
  };
}

describe("registry desk-card contract", () => {
  test("a tool whose attached card is missing a field is rejected, naming the tool", () => {
    const broken: Record<string, unknown> = { ...completeCard("broken_card_tool") };
    delete broken["purpose"];
    const registry = new ToolRegistry();
    expect(() =>
      registry.register(
        fakeTool("broken_card_tool", broken as unknown as ToolManifest) as Tool<unknown, unknown>,
      ),
    ).toThrow(/broken_card_tool/);
    expect(registry.has("broken_card_tool")).toBe(false);
  });

  test("a tool with a complete card registers", () => {
    const registry = new ToolRegistry();
    registry.register(
      fakeTool("complete_card_tool", completeCard("complete_card_tool")) as Tool<unknown, unknown>,
    );
    expect(registry.has("complete_card_tool")).toBe(true);
    expect(registry.find("complete_card_tool")?.manifest?.id).toBe("complete_card_tool");
  });

  test("a tool with no manifest registers fine (external/MCP contract)", () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool("bare_external_tool") as Tool<unknown, unknown>);
    expect(registry.has("bare_external_tool")).toBe(true);
    expect(registry.find("bare_external_tool")?.manifest).toBeUndefined();
  });
});

// ---------- service seam ----------

describe("ToolService desk seam", () => {
  test("listActive descriptors carry purpose/useWhen from the catalog cards", () => {
    const service = new ToolService();
    const byId = new Map(getPluginManifests().map((m) => [m.id, m]));
    const descriptors = service.listActive();
    // Exactly the statically-registered tools, in registration order.
    expect(descriptors.map((d) => d.name)).toEqual(pluginTools.map((t) => t.name));
    for (const descriptor of descriptors) {
      const card = byId.get(descriptor.name);
      expect(card).toBeDefined();
      expect(descriptor.purpose).toBe(card?.purpose);
      expect(descriptor.useWhen).toBe(card?.useWhen);
    }
  });
});
