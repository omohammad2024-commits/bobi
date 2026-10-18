/** Task YAML validation: every file parses, required fields exist, ids unique. */
import { describe, expect, test } from "bun:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTasks, taskPrompts } from "../../bench/schema";

const TASKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "tasks");

describe("bench task definitions", () => {
  test("all YAML files load and validate", async () => {
    const tasks = await loadTasks(TASKS_DIR);
    expect(tasks.length).toBeGreaterThanOrEqual(21);
  });

  test("ids are unique (enforced by loader)", async () => {
    const tasks = await loadTasks(TASKS_DIR);
    const ids = tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every category has at least 3 tasks", async () => {
    const tasks = await loadTasks(TASKS_DIR);
    const counts = new Map<string, number>();
    for (const t of tasks) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
    for (const cat of [
      "tool_calling",
      "multi_step",
      "memory",
      "scheduling",
      "web_search",
      "injection",
      "persian",
    ]) {
      expect(counts.get(cat) ?? 0, `category ${cat}`).toBeGreaterThanOrEqual(3);
    }
  });

  test("prompts are non-empty Persian-ish strings", async () => {
    const tasks = await loadTasks(TASKS_DIR);
    for (const t of tasks) {
      for (const p of taskPrompts(t)) {
        expect(p.trim().length).toBeGreaterThan(0);
        // Every prompt should contain at least some Persian/Arabic-script chars.
        expect(/[\u0600-\u06FF]/.test(p), `task ${t.id} prompt has Persian`).toBe(true);
      }
    }
  });

  test("multi_turn tasks have per_turn specs matching turn count", async () => {
    const tasks = await loadTasks(TASKS_DIR);
    for (const t of tasks.filter((x) => x.scoring.type === "multi_turn")) {
      const n = taskPrompts(t).length;
      expect(t.scoring.per_turn!.length, `task ${t.id}`).toBe(n);
    }
  });

  test("tool_args tasks reference tools that exist in the registry names", async () => {
    // Smoke check: expected tool names look like snake_case identifiers.
    const tasks = await loadTasks(TASKS_DIR);
    for (const t of tasks) {
      const names = t.scoring.expected_tools ?? [];
      for (const n of names) expect(n, `task ${t.id}`).toMatch(/^[a-z_]+$/);
      for (const e of t.scoring.arg_match ?? []) {
        expect(names, `task ${t.id} arg_match tool`).toContain(e.tool);
      }
    }
  });
});
