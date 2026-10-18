#!/usr/bin/env bun
/**
 * Hermes side of the head-to-head: convert BOBI bench tasks to a Hermes
 * batch_runner.py JSONL dataset.
 *
 * Usage:
 *   bun bench/hermes_adapter.ts to-jsonl [--out bench/hermes_dataset.jsonl]
 *
 * Writes two files:
 *   <out>             JSONL, one {"prompt": ...} per task (batch_runner input)
 *   <out>.index.json  prompt_index -> task id (+ multi_turn_joined flags),
 *                     consumed by bench/hermes_adapter.py parse.
 *
 * Multi-turn tasks are joined into a single prompt (Hermes batch mode runs
 * one prompt per sample with no conversation carry-over); they are flagged
 * in the index and the limitation is documented in hermes_adapter.md.
 */
import { writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTasks, taskPrompts } from "./schema";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = join(BENCH_DIR, "tasks");

const TURN_SEPARATOR = "\n\n[نوبت بعد]\n\n";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] !== "to-jsonl") {
    console.error("usage: bun bench/hermes_adapter.ts to-jsonl [--out <file>]");
    process.exit(2);
  }
  let out = join(BENCH_DIR, "hermes_dataset.jsonl");
  const outIdx = argv.indexOf("--out");
  if (outIdx !== -1 && argv[outIdx + 1]) out = resolve(argv[outIdx + 1]);

  const tasks = await loadTasks(TASKS_DIR);
  const lines: string[] = [];
  const index: Record<string, { taskId: string; multi_turn_joined: boolean }> = {};
  tasks.forEach((t, i) => {
    const prompts = taskPrompts(t);
    const joined = prompts.length > 1;
    lines.push(
      JSON.stringify({
        prompt:
          `شناسهٔ تسک: ${t.id}\n` +
          (joined ? prompts.join(TURN_SEPARATOR) : prompts[0]),
      }),
    );
    index[String(i)] = { taskId: t.id, multi_turn_joined: joined };
  });
  await writeFile(out, lines.join("\n") + "\n", "utf8");
  await writeFile(out + ".index.json", JSON.stringify(index, null, 2) + "\n", "utf8");
  console.log(`wrote ${lines.length} prompts -> ${out}`);
  console.log(`wrote index -> ${out}.index.json`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
