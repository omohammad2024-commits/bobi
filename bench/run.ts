#!/usr/bin/env bun
/**
 * BOBI benchmark runner — headless ConversationEngine over bench/tasks/*.yaml.
 *
 * Modes:
 *  - Offline (default): FakeProvider, :memory: SQLite, mocked web_search /
 *    fetch_url. Proves the plumbing end to end (engine -> tools -> scorer ->
 *    report). Scores are NOT model-quality measurements in this mode.
 *  - Live (--live): the owner's real provider via the normal config path
 *    (AiGateway over the deploy DB, exactly like the bot). Requires a
 *    configured provider; refuses to run otherwise — never silently fakes.
 *
 * CLI:
 *   bun bench/run.ts [--tasks id,...] [--live] [--out dir] [--db path]
 *   bun bench/run.ts --score-only <external-results.json> [--out dir]
 *
 * Writes bench/results/<ts>.json and bench/results/<ts>.md (Persian).
 */
import { mkdirSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ConversationEngine } from "../src/conversation/engine";
import { webhookEventSink } from "../src/webhooks";
import { FakeProvider } from "../src/ai/fake";
import type { AiProvider } from "../src/ai/provider";
import { ToolService, type ToolServiceOptions } from "../src/tools/service";
import type { ExecuteRequest } from "../src/tools/executor";
import type { ToolActor, ToolRunResult } from "../src/tools/types";
import { Storage } from "../src/storage/storage";
import { AiGateway } from "../src/ai/gateway";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { estimateCost } from "../src/ai/usage";
import { createMemoryTools } from "../src/tools/memory";
import { createHistoryTools } from "../src/tools/history";
import { createReminderTools } from "../src/tools/reminders";
import { createScheduledTaskTools } from "../src/tools/scheduled_tasks";
import { resolveMemoryProvider } from "../src/memory/factory";
import {
  getTaskMocks,
  serveMockFetchUrl,
  serveMockWebSearch,
  setTaskMocks,
} from "./mock_tools";
import { loadTasks, taskPrompts, type BenchTask } from "./schema";
import { scoreTask, type CheckResult, type TurnTrace } from "./scorer";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = join(BENCH_DIR, "tasks");
const DEFAULT_OUT = join(BENCH_DIR, "results");

/** ToolService that records every executed call and serves web mocks. */
export class BenchToolService extends ToolService {
  /** {tool, input} in execution order; reset per turn by the runner. */
  readonly calls: Array<{ tool: string; input: unknown }> = [];

  constructor(opts: ToolServiceOptions = {}) {
    super(opts);
  }

  override async execute(req: ExecuteRequest): Promise<ToolRunResult> {
    this.calls.push({ tool: req.tool, input: req.input });
    const t0 = Date.now();
    // Offline web sandbox: serve the task's canned data instead of the
    // network. The model's view (tool specs) is unchanged.
    if (req.tool === "web_search") {
      const query = String((req.input as Record<string, unknown> | null)?.query ?? "");
      return {
        tool: req.tool,
        status: "ok",
        data: serveMockWebSearch(query, getTaskMocks()),
        durationMs: Date.now() - t0,
      };
    }
    if (req.tool === "fetch_url") {
      const url = String((req.input as Record<string, unknown> | null)?.url ?? "");
      return {
        tool: req.tool,
        status: "ok",
        data: serveMockFetchUrl(url, getTaskMocks()),
        durationMs: Date.now() - t0,
      };
    }
    return super.execute(req);
  }
}

export interface BenchStack {
  engine: ConversationEngine;
  tools: BenchToolService;
  actor: ToolActor;
  providerName: string;
  model: string;
}

function registerBenchExtras(tools: BenchToolService, storage: Storage): void {
  const registry = tools.registry;
  for (const t of createMemoryTools({ provider: resolveMemoryProvider(storage) })) {
    registry.register(t);
  }
  for (const t of createHistoryTools({ storage })) registry.register(t);
  for (const t of createReminderTools({ storage })) registry.register(t);
  for (const t of createScheduledTaskTools({
    storage,
    isOwner: () => true, // bench runs as the owner by construction
    defaultTimezone: "Asia/Tehran",
    toolExists: (name) => registry.find(name) !== undefined,
  })) {
    registry.register(t);
  }
}

function benchActor(tools: BenchToolService): ToolActor {
  const perms = new Set<string>();
  for (const t of tools.registry.list()) {
    for (const p of t.permission.requires) perms.add(p);
  }
  return { userId: "bench-owner", permissions: [...perms] };
}

/** Bench stack over any provider (offline plumbing or live). Exported for tests. */
export function buildBenchStack(provider: AiProvider, model: string): BenchStack {
  const storage = Storage.open(":memory:");
  const tools = new BenchToolService();
  registerBenchExtras(tools, storage);
  const engine = new ConversationEngine({
    provider,
    model,
    timeoutMs: 30_000,
    maxConcurrent: 1,
    storage,
    tools,
    timezone: "Asia/Tehran",
    summariseHistory: false,
    // Phase 5: webhook events leave through the sink adapter (no-op
    // unless webhooks are configured in this process's env, as before).
    onEvent: webhookEventSink(),
  });
  return {
    engine,
    tools,
    actor: benchActor(tools),
    providerName: provider.name,
    model,
  };
}

/** Offline stack: FakeProvider, :memory: DB, mocked web. */
export function buildOfflineStack(): BenchStack {
  const stack = buildBenchStack(new FakeProvider(), "fake");
  stack.providerName = "fake (offline plumbing)";
  return stack;
}

export interface LiveStackInfo {
  stack: BenchStack;
  providerLabel: string;
  modelId: string;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(process.env.HOME ?? "~", p.slice(2)) : p;
}

/**
 * Live stack: the owner's real provider through the normal config path
 * (AiGateway over the deploy DB). Bench conversation state stays in a fresh
 * :memory: DB — the owner's data is only read for provider selection.
 *
 * Throws a Persian Error when no provider is configured (the CLI turns this
 * into a clear message and a non-zero exit; results are never faked).
 */
export function buildLiveStack(dbPath?: string): LiveStackInfo {
  const resolved = expandHome(
    dbPath ?? "~/workspace/bobi-deploy/data/bobi.db",
  );
  if (!existsSync(resolved)) {
    throw new Error(
      `فایل دیتابیس بنچ‌مارک زنده پیدا نشد: ${resolved} — مسیر را با --db بدهید.`,
    );
  }
  // Config DB: read for provider selection only.
  const cfgStorage = Storage.open(resolved);
  const secrets = new ProviderSecretStore(
    process.env.AI_KEY_MASTER_KEY?.trim() || undefined,
  );
  const gateway = new AiGateway({
    storage: cfgStorage,
    adapters: new AdapterRegistry(),
    secrets,
  });
  const sel = gateway.currentSelection();
  if (!sel) {
    throw new Error(
      "ارائه‌دهندهٔ هوش مصنوعی پیکربندی نشده است. اول در تلگرام با دستور /ai یک ارائه‌دهنده و مدل انتخاب کنید، بعد بنچ‌مارک زنده را اجرا کنید.",
    );
  }
  const storage = Storage.open(":memory:");
  const tools = new BenchToolService();
  registerBenchExtras(tools, storage);
  const engine = new ConversationEngine({
    provider: gateway as AiProvider,
    model: sel.modelId,
    timeoutMs: 120_000,
    maxConcurrent: 1,
    storage,
    tools,
    timezone: "Asia/Tehran",
    summariseHistory: false,
    // Phase 5: webhook events leave through the sink adapter (no-op
    // unless webhooks are configured in this process's env, as before).
    onEvent: webhookEventSink(),
  });
  const stack: BenchStack = {
    engine,
    tools,
    actor: benchActor(tools),
    providerName: `live: ${sel.providerLabel}`,
    model: sel.modelId,
  };
  return {
    stack,
    providerLabel: sel.providerLabel,
    modelId: sel.modelId,
  };
}

// ---------- per-task execution ----------

export interface TurnResult extends TurnTrace {
  /** Total turn latency, ms. */
  latencyMs: number;
  /**
   * Time to first step callback (model/tool activity), ms after turn start.
   * Approximation: the engine has no token streaming; when no step fires
   * (e.g. plain provider path) this is null and only the total is reported.
   */
  ttfbMs: number | null;
  inputTokens: number;
  outputTokens: number;
}

export interface TaskResult {
  taskId: string;
  title_fa: string;
  category: string;
  passed: boolean;
  score: number;
  maxScore: number;
  checks: CheckResult[];
  turns: TurnResult[];
  totalLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costEstimated: boolean;
  error?: string;
}

export async function runTask(
  stack: BenchStack,
  task: BenchTask,
  runId: string,
): Promise<TaskResult> {
  const conversationId = `bench-${runId}-${task.id}`;
  setTaskMocks(task.mocks);
  const turnResults: TurnResult[] = [];
  let failed: string | undefined;

  for (const promptText of taskPrompts(task)) {
    stack.tools.calls.length = 0;
    const t0 = Date.now();
    let firstStepAt: number | null = null;
    try {
      const out = await stack.engine.respond({
        conversationId,
        userText: promptText,
        actor: stack.actor,
        onProgress: () => {
          if (firstStepAt === null) firstStepAt = Date.now();
        },
      });
      const latencyMs = Date.now() - t0;
      turnResults.push({
        toolCalls: stack.tools.calls.map((c) => ({ name: c.tool, args: c.input })),
        finalText: out.chunks.join("\n"),
        latencyMs,
        ttfbMs: firstStepAt === null ? null : firstStepAt - t0,
        inputTokens: out.usage.inputTokens,
        outputTokens: out.usage.outputTokens,
      });
    } catch (err) {
      failed = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      turnResults.push({
        toolCalls: stack.tools.calls.map((c) => ({ name: c.tool, args: c.input })),
        finalText: "",
        latencyMs: Date.now() - t0,
        ttfbMs: null,
        inputTokens: 0,
        outputTokens: 0,
      });
      break;
    }
  }
  setTaskMocks(undefined);

  const traces: TurnTrace[] = turnResults.map((t) => ({
    toolCalls: t.toolCalls,
    finalText: t.finalText,
  }));
  const s = scoreTask(task, traces);
  const inputTokens = turnResults.reduce((a, t) => a + t.inputTokens, 0);
  const outputTokens = turnResults.reduce((a, t) => a + t.outputTokens, 0);
  const { usd, estimated } = estimateCost(inputTokens, outputTokens, stack.model);

  return {
    taskId: task.id,
    title_fa: task.title_fa,
    category: task.category,
    passed: failed === undefined && s.passed,
    score: s.score,
    maxScore: s.maxScore,
    checks: s.checks,
    turns: turnResults,
    totalLatencyMs: turnResults.reduce((a, t) => a + t.latencyMs, 0),
    inputTokens,
    outputTokens,
    costUsd: usd,
    costEstimated: estimated,
    ...(failed !== undefined ? { error: failed } : {}),
  };
}

// ---------- report ----------

export interface BenchReport {
  generatedAt: string;
  mode: "offline" | "live";
  provider: string;
  model: string;
  taskCount: number;
  totals: {
    passed: number;
    failed: number;
    avgScorePct: number;
    totalLatencyMs: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  results: TaskResult[];
}

export function buildReport(
  results: TaskResult[],
  opts: { mode: "offline" | "live"; provider: string; model: string },
): BenchReport {
  const passed = results.filter((r) => r.passed).length;
  const maxTotal = results.reduce((a, r) => a + r.maxScore, 0);
  const scoreTotal = results.reduce((a, r) => a + r.score, 0);
  return {
    generatedAt: new Date().toISOString(),
    mode: opts.mode,
    provider: opts.provider,
    model: opts.model,
    taskCount: results.length,
    totals: {
      passed,
      failed: results.length - passed,
      avgScorePct: maxTotal === 0 ? 0 : Math.round((scoreTotal / maxTotal) * 1000) / 10,
      totalLatencyMs: results.reduce((a, r) => a + r.totalLatencyMs, 0),
      inputTokens: results.reduce((a, r) => a + r.inputTokens, 0),
      outputTokens: results.reduce((a, r) => a + r.outputTokens, 0),
      costUsd: results.reduce((a, r) => a + r.costUsd, 0),
    },
    results,
  };
}

function tehranDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("fa-IR", {
      timeZone: "Asia/Tehran",
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function esc(s: string): string {
  return s.replace(/\|/g, "¦").replace(/\n/g, " ");
}

/** Persian markdown report: per-task table + totals + failed-check details. */
export function renderMarkdown(report: BenchReport): string {
  const L: string[] = [];
  L.push("# گزارش بنچ‌مارک بابی");
  L.push("");
  L.push(`- تاریخ اجرا: ${tehranDate(report.generatedAt)}`);
  L.push(
    `- حالت: ${report.mode === "live" ? "زنده (مدل واقعی)" : "آفلاین (plumbing — امتیازها معیار کیفیت مدل نیست)"}`,
  );
  L.push(`- ارائه‌دهنده: ${report.provider}`);
  L.push(`- مدل: ${report.model}`);
  L.push("");
  L.push("## خلاصه");
  L.push("");
  L.push(`- تعداد تسک‌ها: ${report.taskCount}`);
  L.push(`- موفق: ${report.totals.passed} — ناموفق: ${report.totals.failed}`);
  L.push(`- میانگین امتیاز: ${report.totals.avgScorePct}٪`);
  L.push(
    `- مجموع تأخیر: ${(report.totals.totalLatencyMs / 1000).toFixed(1)} ثانیه`,
  );
  L.push(
    `- توکن‌ها: ورودی ${report.totals.inputTokens} / خروجی ${report.totals.outputTokens}`,
  );
  L.push(`- هزینهٔ تخمینی: ${report.totals.costUsd.toFixed(6)} دلار`);
  L.push("");
  L.push("## نتایج تک‌تک تسک‌ها");
  L.push("");
  L.push("| شناسه | عنوان | دسته | نتیجه | امتیاز | ابزارها | تأخیر (ms) |");
  L.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of report.results) {
    const tools = r.turns
      .flatMap((t) => t.toolCalls.map((c) => c.name))
      .join("، ");
    L.push(
      `| ${r.taskId} | ${esc(r.title_fa)} | ${r.category} | ${r.passed ? "✅" : "❌"} | ${r.score}/${r.maxScore} | ${esc(tools) || "—"} | ${r.totalLatencyMs} |`,
    );
  }
  const failed = report.results.filter((r) => !r.passed);
  if (failed.length > 0) {
    L.push("");
    L.push("## جزئیات تسک‌های ناموفق");
    for (const r of failed) {
      L.push("");
      L.push(`### ${r.taskId} — ${esc(r.title_fa)}`);
      if (r.error) L.push(`- خطا: ${esc(r.error)}`);
      for (const c of r.checks.filter((c) => !c.passed)) {
        L.push(`- ❌ ${esc(c.name_fa)}: ${esc(c.detail)}`);
      }
    }
  }
  L.push("");
  L.push(
    "_یادداشت: امتیازها قطعی و بدون داوری مدل زبانی محاسبه شده‌اند (تطبیق دقیق ابزار/آرگومان، عبارات متنی، روبریک فارسی)._",
  );
  L.push("");
  return L.join("\n");
}

export function stampName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export async function writeReports(
  report: BenchReport,
  outDir: string,
  stamp = stampName(),
): Promise<{ jsonPath: string; mdPath: string }> {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `${stamp}.json`);
  const mdPath = join(outDir, `${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(mdPath, renderMarkdown(report), "utf8");
  return { jsonPath, mdPath };
}

// ---------- external (Hermes) results scoring ----------

interface ExternalTurn {
  toolCalls?: Array<{ name: string; args?: unknown }>;
  finalText?: string;
}
interface ExternalResult {
  taskId: string;
  turns?: ExternalTurn[];
  toolCalls?: Array<{ name: string; args?: unknown }>;
  finalText?: string;
  /** Set by the Hermes adapter when no trajectory exists — never scores a pass. */
  error?: string;
}

/**
 * Score results produced outside this runner (e.g. the Hermes adapter):
 * same tasks, same deterministic scorer, zero model-quality judgement.
 *
 * `toolMap` renames external tool calls before scoring (Hermes tool names
 * differ from BOBI's). The map is an explicit, owner-filled JSON file —
 * never guessed.
 */
export async function scoreExternal(
  tasksDir: string,
  externalPath: string,
  outDir: string,
  meta: { provider: string; model: string },
  toolMap: Record<string, string> = {},
): Promise<{ jsonPath: string; mdPath: string }> {
  const tasks = await loadTasks(tasksDir);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const raw = JSON.parse(await Bun.file(externalPath).text()) as {
    results?: ExternalResult[];
    provider?: string;
    model?: string;
  };
  const results: TaskResult[] = [];
  for (const er of raw.results ?? []) {
    const task = byId.get(er.taskId);
    if (!task) continue;
    const turns: TurnTrace[] = (er.turns ?? []).map((t) => ({
      toolCalls: (t.toolCalls ?? []).map((c) => ({
        name: toolMap[c.name] ?? c.name,
        args: c.args ?? {},
      })),
      finalText: t.finalText ?? "",
    }));
    if (turns.length === 0) {
      turns.push({
        toolCalls: (er.toolCalls ?? []).map((c) => ({
          name: toolMap[c.name] ?? c.name,
          args: c.args ?? {},
        })),
        finalText: er.finalText ?? "",
      });
    }
    const s = scoreTask(task, turns);
    const checks =
      er.error !== undefined
        ? [
            {
              name_fa: "اجرای خارجی",
              passed: false,
              detail: `بدون trajectory: ${er.error}`,
            } satisfies CheckResult,
            ...s.checks,
          ]
        : s.checks;
    const passedCount = checks.filter((c) => c.passed).length;
    results.push({
      taskId: task.id,
      title_fa: task.title_fa,
      category: task.category,
      passed: er.error === undefined && s.passed,
      score: passedCount,
      maxScore: checks.length,
      checks,
      turns: turns.map((t) => ({
        ...t,
        latencyMs: 0,
        ttfbMs: null,
        inputTokens: 0,
        outputTokens: 0,
      })),
      totalLatencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costEstimated: true,
    });
  }
  const report = buildReport(results, {
    mode: "live",
    provider: meta.provider !== "external" ? meta.provider : (raw.provider ?? "external"),
    model: meta.model !== "external" ? meta.model : (raw.model ?? "external"),
  });
  return writeReports(report, outDir, `${stampName()}-external`);
}

// ---------- CLI ----------

function parseArgs(argv: string[]): {
  tasks?: string[];
  live: boolean;
  out: string;
  db?: string;
  scoreOnly?: string;
  toolMap?: string;
} {
  const opts: {
    tasks?: string[];
    live: boolean;
    out: string;
    db?: string;
    scoreOnly?: string;
    toolMap?: string;
  } = {
    live: false,
    out: DEFAULT_OUT,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--live") opts.live = true;
    else if (a === "--tasks") opts.tasks = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--out") opts.out = argv[++i] ?? DEFAULT_OUT;
    else if (a === "--db") {
      const v = argv[++i];
      if (v !== undefined) opts.db = v;
    } else if (a === "--score-only") {
      const v = argv[++i];
      if (v !== undefined) opts.scoreOnly = v;
    } else if (a === "--tool-map") {
      const v = argv[++i];
      if (v !== undefined) opts.toolMap = v;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "bun bench/run.ts [--tasks id,...] [--live] [--out dir] [--db path]\n" +
          "bun bench/run.ts --score-only <external-results.json> [--out dir] [--tool-map <map.json>]",
      );
      process.exit(0);
    } else {
      console.error(`ناشناخته: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.scoreOnly) {
    const meta = { provider: "external", model: "external" };
    let toolMap: Record<string, string> = {};
    if (opts.toolMap) {
      toolMap = JSON.parse(await Bun.file(resolve(opts.toolMap)).text()) as Record<
        string,
        string
      >;
    }
    const { jsonPath, mdPath } = await scoreExternal(
      TASKS_DIR,
      resolve(opts.scoreOnly),
      resolve(opts.out),
      meta,
      toolMap,
    );
    console.log(`گزارش JSON: ${jsonPath}`);
    console.log(`گزارش Markdown: ${mdPath}`);
    return;
  }

  let tasks = await loadTasks(TASKS_DIR);
  if (opts.tasks) {
    const want = new Set(opts.tasks);
    tasks = tasks.filter((t) => want.has(t.id));
    const missing = [...want].filter((id) => !tasks.some((t) => t.id === id));
    if (missing.length > 0) {
      console.error(`تسک‌های ناشناخته: ${missing.join(", ")}`);
      process.exit(2);
    }
  }

  let stack: BenchStack;
  let mode: "offline" | "live";
  if (opts.live) {
    try {
      const live = buildLiveStack(opts.db);
      stack = live.stack;
      mode = "live";
      console.log(`حالت زنده — ارائه‌دهنده: ${live.providerLabel}، مدل: ${live.modelId}`);
    } catch (err) {
      console.error(`خطا: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else {
    stack = buildOfflineStack();
    mode = "offline";
    console.log(
      "حالت آفلاین (FakeProvider + ابزارهای شبیه‌سازی‌شده): فقط برای تست plumbing — امتیازها معیار کیفیت مدل نیست.",
    );
  }

  const runId = stampName();
  const results: TaskResult[] = [];
  for (const task of tasks) {
    process.stdout.write(`… ${task.id} ${task.title_fa}`);
    const r = await runTask(stack, task, runId);
    results.push(r);
    console.log(` — ${r.passed ? "✅" : "❌"} (${r.score}/${r.maxScore})`);
  }

  const report = buildReport(results, {
    mode,
    provider: stack.providerName,
    model: stack.model,
  });
  const { jsonPath, mdPath } = await writeReports(report, resolve(opts.out), runId);
  console.log(`\nموفق: ${report.totals.passed} از ${report.taskCount} — میانگین امتیاز: ${report.totals.avgScorePct}٪`);
  console.log(`گزارش JSON: ${jsonPath}`);
  console.log(`گزارش Markdown: ${mdPath}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`خطای غیرمنتظره: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
