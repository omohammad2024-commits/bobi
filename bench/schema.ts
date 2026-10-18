/**
 * Bench task schema: YAML definitions under bench/tasks/, loaded and
 * validated before any run. All user-facing strings (titles, prompts) are
 * Persian; code and comments are English.
 */

export type TaskCategory =
  | "tool_calling"
  | "multi_step"
  | "memory"
  | "scheduling"
  | "web_search"
  | "injection"
  | "persian";

export type ScoringType =
  | "exact_tools"
  | "tool_args"
  | "contains"
  | "not_contains"
  | "multi_turn"
  | "rubric_fa"
  | "injection";

/** Deterministic argument matcher for one tool call's arguments. */
export type ArgMatcher =
  | { regex: string }
  | { exists: boolean }
  | { type: "string" | "number" | "boolean" }
  | string
  | number
  | boolean
  | null;

export interface ArgMatchEntry {
  tool: string;
  /** Which occurrence of this tool's calls to match (0-based). Default 0. */
  occurrence?: number;
  match: Record<string, ArgMatcher>;
}

export interface RubricSpec {
  min_length?: number;
  max_length?: number;
  /** Fail when any ASCII Latin letter appears in the final text. */
  forbid_latin?: boolean;
  /** All of these phrases must appear. */
  contains?: string[];
  /** At least one of these phrases must appear. */
  contains_any?: string[];
  /** None of these phrases may appear. */
  not_contains?: string[];
}

export interface ScoringSpec {
  type: ScoringType;
  /** Ordered tool names expected for the whole run (single-turn tasks). */
  expected_tools?: string[];
  /** Per-occurrence argument assertions (tool_args). */
  arg_match?: ArgMatchEntry[];
  /** Tool names that must NOT be called (injection). */
  forbidden_tools?: string[];
  /** Final-text assertions, usable with any scoring type. */
  contains?: string[];
  not_contains?: string[];
  /** Per-turn sub-specs (multi_turn). */
  per_turn?: ScoringSpec[];
  /** Persian quality rubric (rubric_fa). */
  rubric?: RubricSpec;
}

export interface MockWebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface TaskMocks {
  web_search?: { results: MockWebSearchResult[] };
  /** URL -> page text. */
  fetch_url?: Record<string, string>;
}

export interface BenchTask {
  id: string;
  title_fa: string;
  category: TaskCategory;
  /** Single-turn prompt. Mutually exclusive with `turns`. */
  prompt?: string;
  /** Multi-turn prompts; overrides `prompt`. */
  turns?: string[];
  scoring: ScoringSpec;
  mocks?: TaskMocks;
}

const CATEGORIES: TaskCategory[] = [
  "tool_calling",
  "multi_step",
  "memory",
  "scheduling",
  "web_search",
  "injection",
  "persian",
];

const SCORING_TYPES: ScoringType[] = [
  "exact_tools",
  "tool_args",
  "contains",
  "not_contains",
  "multi_turn",
  "rubric_fa",
  "injection",
];

/** Validate one parsed YAML document; throws a descriptive Error on failure. */
export function validateTask(raw: unknown, source: string): BenchTask {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${source}: task must be a YAML mapping`);
  }
  const t = raw as Record<string, unknown>;
  const need = (key: string, what: string): unknown => {
    const v = t[key];
    if (v === undefined || v === null || v === "") {
      throw new Error(`${source}: missing required field "${key}" (${what})`);
    }
    return v;
  };

  const id = need("id", "task id") as string;
  if (!/^[a-z0-9_]+$/.test(id)) {
    throw new Error(`${source}: id "${id}" must be lowercase snake_case`);
  }
  const title_fa = need("title_fa", "Persian title") as string;
  const category = need("category", "category") as string;
  if (!CATEGORIES.includes(category as TaskCategory)) {
    throw new Error(`${source}: unknown category "${category}"`);
  }

  const prompt = t["prompt"];
  const turns = t["turns"];
  if (prompt !== undefined && turns !== undefined) {
    throw new Error(`${source}: "prompt" and "turns" are mutually exclusive`);
  }
  if (prompt === undefined && turns === undefined) {
    throw new Error(`${source}: one of "prompt" or "turns" is required`);
  }
  if (turns !== undefined) {
    if (!Array.isArray(turns) || turns.length < 2 || !turns.every((x) => typeof x === "string")) {
      throw new Error(`${source}: "turns" must be a list of >= 2 strings`);
    }
  }

  const scoring = need("scoring", "scoring spec") as Record<string, unknown>;
  validateScoring(scoring, source, "scoring");

  const mocks = t["mocks"] as TaskMocks | undefined;

  const task: BenchTask = {
    id,
    title_fa,
    category: category as TaskCategory,
    scoring: scoring as unknown as ScoringSpec,
  };
  if (typeof prompt === "string") task.prompt = prompt;
  if (Array.isArray(turns)) task.turns = turns as string[];
  if (mocks !== undefined) task.mocks = mocks;
  return task;
}

function validateScoring(s: Record<string, unknown>, source: string, where: string): void {
  const type = s["type"];
  if (typeof type !== "string" || !SCORING_TYPES.includes(type as ScoringType)) {
    throw new Error(`${source}: ${where}.type must be one of ${SCORING_TYPES.join(", ")}`);
  }
  if (type === "multi_turn") {
    const per = s["per_turn"];
    if (!Array.isArray(per) || per.length < 2) {
      throw new Error(`${source}: ${where}.per_turn must be a list of >= 2 sub-specs`);
    }
    per.forEach((sub, i) => {
      if (typeof sub !== "object" || sub === null) {
        throw new Error(`${source}: ${where}.per_turn[${i}] must be a mapping`);
      }
      validateScoring(sub as Record<string, unknown>, source, `${where}.per_turn[${i}]`);
    });
  }
  if (type === "rubric_fa" && (typeof s["rubric"] !== "object" || s["rubric"] === null)) {
    throw new Error(`${source}: ${where}.rubric is required for rubric_fa`);
  }
}

/** Load and validate every *.yaml in a directory. Ids must be unique. */
export async function loadTasks(dir: string): Promise<BenchTask[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();
  if (files.length === 0) throw new Error(`no task YAML files in ${dir}`);
  const tasks: BenchTask[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const path = join(dir, f);
    const text = await readFile(path, "utf8");
    let raw: unknown;
    try {
      raw = Bun.YAML.parse(text);
    } catch (err) {
      throw new Error(`${path}: YAML parse error: ${(err as Error).message}`);
    }
    const task = validateTask(raw, path);
    if (seen.has(task.id)) throw new Error(`${path}: duplicate task id "${task.id}"`);
    seen.add(task.id);
    tasks.push(task);
  }
  return tasks;
}

/** Prompts for a task: `turns` when present, otherwise the single prompt. */
export function taskPrompts(task: BenchTask): string[] {
  if (task.turns !== undefined) return task.turns;
  return [task.prompt!];
}
