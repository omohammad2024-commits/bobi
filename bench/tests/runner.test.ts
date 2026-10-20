/**
 * Runner plumbing tests: scripted fake provider -> engine -> real tools ->
 * scorer -> JSON/MD reports. Fully offline and deterministic.
 */
import { describe, expect, test } from "bun:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
} from "../../../src/ai/provider";
import {
  buildBenchStack,
  buildReport,
  renderMarkdown,
  runTask,
  scoreExternal,
  writeReports,
} from "../../bench/run";
import { loadTasks, taskPrompts } from "../../bench/schema";

const TASKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "tasks");

/** Deterministic provider: per-prompt queues of canned responses. */
class ScriptedProvider implements AiProvider {
  readonly name = "scripted";
  constructor(private readonly script: Record<string, CompletionResponse[]>) {}
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const key = lastUser?.content ?? "";
    // Phase-3 self-review: confirm the draft unchanged (review protocol).
    if (typeof key === "string" && key.startsWith("<self_review>")) {
      const draftMsg = [...req.messages].reverse().find((m) => m.role === "assistant");
      const draft = typeof draftMsg?.content === "string" ? draftMsg.content : "پایان.";
      return { text: draft, model: "m" };
    }
    const q = this.script[key];
    if (!q || q.length === 0) return { text: "پایان.", model: "m" };
    return q.shift()!;
  }
}

const tc = (name: string, args: unknown) => ({
  id: "c1",
  name,
  arguments: args,
});

describe("runner plumbing", () => {
  test("tool_args task passes with correct tool + args", async () => {
    const tasks = await loadTasks(TASKS_DIR);
    const t = tasks.find((x) => x.id === "calc_01")!;
    const prompt = taskPrompts(t)[0]!;
    const stack = buildBenchStack(
      new ScriptedProvider({
        [prompt]: [
          { text: "", model: "m", toolCalls: [tc("calculator", { op: "add", a: 12, b: 30 })] },
          { text: "حاصل ۴۲ است.", model: "m" },
        ],
      }),
      "m",
    );
    const r = await runTask(stack, t, "plumb1");
    expect(r.passed).toBe(true);
    expect(r.score).toBe(r.maxScore);
    expect(r.turns[0]!.toolCalls).toEqual([
      { name: "calculator", args: { op: "add", a: 12, b: 30 } },
    ]);
    expect(r.turns).toHaveLength(1);
  });

  test("tool_args task fails with wrong args", async () => {
    const tasks = await loadTasks(TASKS_DIR);
    const t = tasks.find((x) => x.id === "calc_01")!;
    const prompt = taskPrompts(t)[0]!;
    const stack = buildBenchStack(
      new ScriptedProvider({
        [prompt]: [
          { text: "", model: "m", toolCalls: [tc("calculator", { op: "add", a: 1, b: 2 })] },
          { text: "حاصل ۳ است.", model: "m" },
        ],
      }),
      "m",
    );
    const r = await runTask(stack, t, "plumb2");
    expect(r.passed).toBe(false);
  });

  test("multi_turn memory task passes across turns", async () => {
    const tasks = await loadTasks(TASKS_DIR);
    const t = tasks.find((x) => x.id === "mem_pet")!;
    const [p1, p2] = taskPrompts(t);
    const stack = buildBenchStack(
      new ScriptedProvider({
        [p1!]: [
          { text: "", model: "m", toolCalls: [tc("remember", { key: "dog", content: "فلفل" })] },
          { text: "ذخیره شد.", model: "m" },
        ],
        [p2!]: [{ text: "اسم سگت فلفل است.", model: "m" }],
      }),
      "m",
    );
    const r = await runTask(stack, t, "plumb3");
    expect(r.passed).toBe(true);
    expect(r.turns).toHaveLength(2);
  });

  test("mock web_search serves canned results and is traced", async () => {
    const tasks = await loadTasks(TASKS_DIR);
    const t = tasks.find((x) => x.id === "search_capital")!;
    const prompt = taskPrompts(t)[0]!;
    const stack = buildBenchStack(
      new ScriptedProvider({
        [prompt]: [
          { text: "", model: "m", toolCalls: [tc("web_search", { query: "پایتخت استرالیا" })] },
          { text: "پایتخت استرالیا کانبرا است.", model: "m" },
        ],
      }),
      "m",
    );
    const r = await runTask(stack, t, "plumb4");
    expect(r.passed).toBe(true);
    expect(r.turns[0]!.toolCalls[0]!.name).toBe("web_search");
  });

  test("report JSON + Markdown structure", async () => {
    const tasks = await loadTasks(TASKS_DIR);
    const t = tasks.find((x) => x.id === "calc_01")!;
    const prompt = taskPrompts(t)[0]!;
    const stack = buildBenchStack(
      new ScriptedProvider({
        [prompt]: [{ text: "حاصل ۴۲ است.", model: "m" }],
      }),
      "m",
    );
    const r = await runTask(stack, t, "plumb5");
    expect(r.passed).toBe(false); // no tool called: honest failure
    const report = buildReport([r], {
      mode: "offline",
      provider: "fake (offline plumbing)",
      model: "fake",
    });
    expect(report.totals.passed).toBe(0);
    expect(report.totals.failed).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), "bench-"));
    const { jsonPath, mdPath } = await writeReports(report, dir, "TESTSTAMP");
    expect(jsonPath.endsWith("TESTSTAMP.json")).toBe(true);
    expect(existsSync(mdPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(parsed.results[0].taskId).toBe("calc_01");
    expect(parsed.mode).toBe("offline");
    const md = readFileSync(mdPath, "utf8");
    expect(md).toContain("گزارش بنچ‌مارک بابی");
    expect(md).toContain("calc_01");
    expect(md).toContain("❌");
  });

  test("renderMarkdown passes table for a passing task", () => {
    const report = buildReport(
      [
        {
          taskId: "calc_01",
          title_fa: "جمع ساده",
          category: "tool_calling",
          passed: true,
          score: 3,
          maxScore: 3,
          checks: [],
          turns: [],
          totalLatencyMs: 12,
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0,
          costEstimated: true,
        },
      ],
      { mode: "live", provider: "live: x", model: "m" },
    );
    const md = renderMarkdown(report);
    expect(md).toContain("✅");
    expect(md).toContain("3/3");
  });

  test("scoreExternal scores Hermes-format results with the same scorer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ext-"));
    const extPath = join(dir, "hermes.json");
    await Bun.write(
      extPath,
      JSON.stringify({
        provider: "hermes",
        model: "anthropic/claude-sonnet-4.6",
        results: [
          {
            taskId: "calc_01",
            turns: [
              {
                toolCalls: [{ name: "calculator", args: { op: "add", a: 12, b: 30 } }],
                finalText: "حاصل ۴۲ است.",
              },
            ],
          },
          {
            taskId: "datetime_01",
            turns: [{ toolCalls: [], finalText: "ساعت ده است." }],
          },
        ],
      }),
    );
    const { jsonPath } = await scoreExternal(TASKS_DIR, extPath, dir, {
      provider: "hermes",
      model: "anthropic/claude-sonnet-4.6",
    });
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    const byId = new Map(parsed.results.map((r: { taskId: string; passed: boolean }) => [r.taskId, r.passed]));
    expect(byId.get("calc_01")).toBe(true);
    expect(byId.get("datetime_01")).toBe(false); // no date_time call
  });
});
