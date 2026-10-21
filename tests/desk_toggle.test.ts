/**
 * Platform Phase 10 — the owner's tool-desk override.
 *
 * The registry carries an owner-disabled set on top of each tool's own
 * `enabled` flag. These tests pin the enforcement contract: a desk-disabled
 * tool disappears from the model's specs (toolSpecsFor), from tool_search
 * (searchableTools), from active listings (listActive/listActiveNames) —
 * and the Executor refuses it with status "disabled" even when called
 * directly. Re-enabling restores everything; unknown names change nothing.
 */
import { describe, expect, test } from "bun:test";
import { ToolService } from "../src/tools/service";
import type { ToolActor } from "../src/tools/types";

const ACTOR: ToolActor = {
  userId: "owner-1",
  permissions: ["tools:calculator", "tools:date_time"],
};

function names(specs: readonly { name: string }[]): string[] {
  return specs.map((s) => s.name);
}

describe("registry owner-disabled set", () => {
  test("setDisabled on an unknown name changes nothing", () => {
    const svc = new ToolService();
    expect(svc.registry.setDisabled("no_such_tool", true)).toBe(false);
    expect(svc.registry.disabledNames()).toEqual([]);
    expect(svc.registry.isDisabled("no_such_tool")).toBe(false);
  });

  test("disabled tool leaves every active surface and dispatch refuses it", async () => {
    const svc = new ToolService();
    // Baseline: calculator is offered, listed, and runs.
    expect(names(svc.toolSpecsFor(ACTOR))).toContain("calculator");
    expect(svc.listActiveNames()).toContain("calculator");
    expect(names(svc.searchableTools(ACTOR))).toContain("calculator");
    expect(svc.listActive().map((d) => d.name)).toContain("calculator");
    const before = await svc.runTool({
      tool: "calculator",
      input: { expression: "1+1" },
      actor: ACTOR,
    });
    expect(before.status).toBe("ok");

    expect(svc.registry.setDisabled("calculator", true)).toBe(true);
    expect(svc.registry.isDisabled("calculator")).toBe(true);
    expect(svc.registry.disabledNames()).toEqual(["calculator"]);

    expect(names(svc.toolSpecsFor(ACTOR))).not.toContain("calculator");
    expect(svc.listActiveNames()).not.toContain("calculator");
    expect(names(svc.searchableTools(ACTOR))).not.toContain("calculator");
    expect(svc.listActive().map((d) => d.name)).not.toContain("calculator");
    // …but it stays REGISTERED (the desk view lists it so it can be re-enabled).
    expect(svc.registry.has("calculator")).toBe(true);
    expect(svc.registry.list().map((t) => t.name)).toContain("calculator");

    const refused = await svc.runTool({
      tool: "calculator",
      input: { expression: "1+1" },
      actor: ACTOR,
    });
    expect(refused.status).toBe("disabled");
  });

  test("re-enabling restores the tool everywhere", async () => {
    const svc = new ToolService();
    svc.registry.setDisabled("calculator", true);
    expect(svc.registry.setDisabled("calculator", false)).toBe(true);
    expect(svc.registry.disabledNames()).toEqual([]);
    expect(names(svc.toolSpecsFor(ACTOR))).toContain("calculator");
    const after = await svc.runTool({
      tool: "calculator",
      input: { expression: "2+2" },
      actor: ACTOR,
    });
    expect(after.status).toBe("ok");
  });

  test("disabling one tool leaves the others untouched", () => {
    const svc = new ToolService();
    svc.registry.setDisabled("calculator", true);
    expect(names(svc.toolSpecsFor(ACTOR))).toContain("date_time");
    expect(svc.listActiveNames()).toContain("date_time");
  });
});
