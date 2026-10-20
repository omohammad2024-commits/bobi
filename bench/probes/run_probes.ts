#!/usr/bin/env bun
/**
 * Probe runner — Phase-3 before/after measurement harness.
 *
 *   bun bench/probes/run_probes.ts --mode tasks24 [--out file.json]
 *   bun bench/probes/run_probes.ts --mode probes  [--out file.json]
 *
 * tasks24: all 24 bench tasks through buildBenchStack(new SimProvider())
 *          + runTask (bench/run.ts), scored by the bench scorer.
 * probes:  ambiguous (a1–a6) + situational (s1–s6) scenarios through a
 *          ConversationEngine built exactly like the bench stack, scored
 *          by the deterministic scorer in scenarios.ts.
 *
 * Deterministic: fixed run id, :memory: storage, bench web mocks, no
 * randomness, no network. The SimProvider's behaviour depends only on the
 * system prompt it receives, so pre-Phase-3 runs record the BEFORE numbers
 * and post-Phase-3 runs (same files, same sim) record the AFTER numbers.
 */
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBenchStack, buildReport, runTask, type BenchStack } from "../run";
import { loadTasks } from "../schema";
import { SimProvider } from "./sim_provider";
import {
  AMBIGUOUS_PROBES,
  SITUATIONAL_SCENARIOS,
  scoreAmbiguous,
  scoreSituational,
  type ProbeResult,
  type ProbeTrace,
} from "./scenarios";

const PROBES_DIR = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = join(PROBES_DIR, "..");
const TASKS_DIR = join(BENCH_DIR, "tasks");
const RUN_ID = "probes-fixed"; // fixed: conversation ids stay deterministic

function parseArgs(argv: string[]): { mode: string; out?: string } {
  let mode = "";
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--mode") mode = argv[++i] ?? "";
    else if (a === "--out") out = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("bun bench/probes/run_probes.ts --mode tasks24|probes [--out file.json]");
      process.exit(0);
    } else {
      console.error(`ناشناخته: ${a}`);
      process.exit(2);
    }
  }
  if (mode !== "tasks24" && mode !== "probes") {
    console.error("--mode باید یکی از tasks24 یا probes باشد");
    process.exit(2);
  }
  return { mode, ...(out !== undefined ? { out } : {}) };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** One engine turn with a clean tool-call slate (same pattern as runTask). */
async function probeTurn(
  stack: BenchStack,
  conversationId: string,
  userText: string,
): Promise<ProbeTrace> {
  stack.tools.calls.length = 0;
  const out = await stack.engine.respond({
    conversationId,
    userText,
    actor: stack.actor,
  });
  return {
    toolCalls: stack.tools.calls.map((c) => ({ name: c.tool, args: c.input })),
    finalText: out.chunks.join("\n"),
  };
}

async function runTasks24(outPath: string): Promise<void> {
  const t0 = Date.now();
  const tasks = await loadTasks(TASKS_DIR);
  const stack = buildBenchStack(new SimProvider(), "sim");
  const results = [];
  for (const task of tasks) {
    const r = await runTask(stack, task, RUN_ID);
    results.push(r);
    console.log(`${r.passed ? "✅" : "❌"} ${r.taskId} (${r.score}/${r.maxScore})`);
    for (const c of r.checks.filter((x) => !x.passed)) {
      console.log(`   ❌ ${c.name_fa}: ${c.detail}`);
    }
  }
  const report = buildReport(results, { mode: "offline", provider: "sim", model: "sim" });
  const wallMs = Date.now() - t0;
  console.log(
    `\ntasks24: passed ${report.totals.passed}/${report.taskCount} — avgScorePct ${report.totals.avgScorePct}% — wall ${wallMs}ms`,
  );
  await writeJson(outPath, {
    mode: "tasks24",
    provider: "sim",
    model: "sim",
    generatedAt: new Date().toISOString(),
    wallMs,
    totals: report.totals,
    taskCount: report.taskCount,
    results: results.map((r) => ({
      taskId: r.taskId,
      passed: r.passed,
      score: r.score,
      maxScore: r.maxScore,
      checks: r.checks,
      turns: r.turns.map((t) => ({ toolCalls: t.toolCalls, finalText: t.finalText })),
      ...(r.error !== undefined ? { error: r.error } : {}),
    })),
  });
  console.log(`JSON: ${outPath}`);
}

async function runProbes(outPath: string): Promise<void> {
  const t0 = Date.now();
  const stack = buildBenchStack(new SimProvider(), "sim");

  const ambiguous: ProbeResult[] = [];
  for (const probe of AMBIGUOUS_PROBES) {
    const trace = await probeTurn(stack, `probe-${probe.id}`, probe.prompt);
    const r = scoreAmbiguous(probe, trace);
    ambiguous.push(r);
    console.log(
      `${r.passed ? "✅" : "❌"} ${probe.id} (${probe.kind}) tools=[${trace.toolCalls.map((c) => c.name).join(", ")}] reply=${trace.finalText.slice(0, 70)}`,
    );
    for (const c of r.checks.filter((x) => !x.passed)) {
      console.log(`   ❌ ${c.name}: ${c.detail}`);
    }
  }

  const situational: ProbeResult[] = [];
  for (const scenario of SITUATIONAL_SCENARIOS) {
    const traces: ProbeTrace[] = [];
    for (const turnText of scenario.turns) {
      traces.push(await probeTurn(stack, `probe-${scenario.id}`, turnText));
    }
    const r = scoreSituational(scenario, traces);
    situational.push(r);
    console.log(`${r.passed ? "✅" : "❌"} ${scenario.id}`);
    for (const c of r.checks) {
      console.log(`   ${c.passed ? "✅" : "❌"} ${c.name}: ${c.detail}`);
    }
  }

  const ambPassed = ambiguous.filter((r) => r.passed).length;
  const sitPassed = situational.filter((r) => r.passed).length;
  const wallMs = Date.now() - t0;
  console.log(
    `\nprobes: ambiguous ${ambPassed}/${ambiguous.length} — situational ${sitPassed}/${situational.length} — wall ${wallMs}ms`,
  );
  await writeJson(outPath, {
    mode: "probes",
    provider: "sim",
    model: "sim",
    generatedAt: new Date().toISOString(),
    wallMs,
    totals: {
      ambiguousPassed: ambPassed,
      ambiguousTotal: ambiguous.length,
      situationalPassed: sitPassed,
      situationalTotal: situational.length,
    },
    ambiguous,
    situational,
  });
  console.log(`JSON: ${outPath}`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const outPath = resolve(opts.out ?? join(PROBES_DIR, `results-${opts.mode}.json`));
  if (opts.mode === "tasks24") await runTasks24(outPath);
  else await runProbes(outPath);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`خطا: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
