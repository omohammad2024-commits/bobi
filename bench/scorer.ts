/**
 * Deterministic scorer for bench tasks. No LLM-as-judge anywhere: every check
 * is an exact comparison, a regex, or a set-membership test, so the same trace
 * always yields the same score.
 */
import type {
  ArgMatcher,
  BenchTask,
  RubricSpec,
  ScoringSpec,
} from "./schema";

/** One executed tool call, in order. */
export interface ToolCallRecord {
  name: string;
  args: unknown;
}

/** What the agent did on one turn. */
export interface TurnTrace {
  toolCalls: ToolCallRecord[];
  finalText: string;
}

export interface CheckResult {
  /** Persian label for the report. */
  name_fa: string;
  passed: boolean;
  detail: string;
}

export interface TaskScore {
  passed: boolean;
  /** Sum of passed checks. */
  score: number;
  /** Total checks. */
  maxScore: number;
  checks: CheckResult[];
}

function check(name_fa: string, passed: boolean, detail: string): CheckResult {
  return { name_fa, passed, detail };
}

/** Match one argument value against a matcher. */
export function matchArg(matcher: ArgMatcher, value: unknown): boolean {
  if (matcher !== null && typeof matcher === "object") {
    if ("regex" in matcher) {
      // Primitives are stringified so {regex:"^2$"} matches the number 2;
      // objects/arrays never match a regex (use a literal instead).
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        return new RegExp(matcher.regex).test(String(value));
      }
      return false;
    }
    if ("exists" in matcher) {
      const present = value !== undefined && value !== null;
      return matcher.exists ? present : !present;
    }
    if ("type" in matcher) {
      return typeof value === matcher.type;
    }
    return false;
  }
  // Literal: strict deep equality via JSON for objects, === otherwise.
  if (matcher !== null && typeof matcher === "object") return false; // unreachable
  if (typeof matcher === "object") {
    return JSON.stringify(matcher) === JSON.stringify(value);
  }
  return matcher === value;
}

function toolNames(calls: ToolCallRecord[]): string[] {
  return calls.map((c) => c.name);
}

function occurrences(calls: ToolCallRecord[], name: string): ToolCallRecord[] {
  return calls.filter((c) => c.name === name);
}

/**
 * Score one turn's tool sequence + final text against a single (non-multi_turn)
 * scoring spec.
 */
export function scoreTurn(spec: ScoringSpec, trace: TurnTrace): TaskScore {
  const checks: CheckResult[] = [];
  const names = toolNames(trace.toolCalls);

  if (spec.expected_tools !== undefined) {
    const want = spec.expected_tools;
    const same =
      names.length === want.length && names.every((n, i) => n === want[i]);
    checks.push(
      check(
        "ترتیب ابزارها",
        same,
        same
          ? `ابزارها دقیقاً مطابق انتظار: ${want.join(" → ") || "(بدون ابزار)"}`
          : `انتظار: [${want.join(", ")}] — مشاهده: [${names.join(", ")}]`,
      ),
    );
  }

  if (spec.forbidden_tools !== undefined) {
    const bad = names.filter((n) => spec.forbidden_tools!.includes(n));
    checks.push(
      check(
        "عدم فراخوانی ابزار ممنوعه",
        bad.length === 0,
        bad.length === 0
          ? "هیچ ابزار ممنوعه‌ای فراخوانی نشد"
          : `ابزارهای ممنوعهٔ فراخوانی‌شده: ${[...new Set(bad)].join(", ")}`,
      ),
    );
  }

  if (spec.arg_match !== undefined) {
    for (const entry of spec.arg_match) {
      const occ = entry.occurrence ?? 0;
      const found = occurrences(trace.toolCalls, entry.tool);
      if (found.length <= occ) {
        checks.push(
          check(
            `آرگومان ${entry.tool} (#${occ + 1})`,
            false,
            `ابزار ${entry.tool} فقط ${found.length} بار فراخوانی شد (انتظار حداقل ${occ + 1})`,
          ),
        );
        continue;
      }
      const args =
        found[occ]!.args !== null && typeof found[occ]!.args === "object"
          ? (found[occ]!.args as Record<string, unknown>)
          : {};
      const failures: string[] = [];
      for (const [key, matcher] of Object.entries(entry.match)) {
        if (!matchArg(matcher, args[key])) {
          failures.push(
            `${key}: انتظار ${JSON.stringify(matcher)}، مشاهده ${JSON.stringify(args[key])}`,
          );
        }
      }
      checks.push(
        check(
          `آرگومان ${entry.tool} (#${occ + 1})`,
          failures.length === 0,
          failures.length === 0
            ? "همهٔ آرگومان‌ها مطابق انتظار"
            : failures.join("؛ "),
        ),
      );
    }
  }

  if (spec.contains !== undefined) {
    for (const phrase of spec.contains) {
      const ok = trace.finalText.includes(phrase);
      checks.push(
        check(
          `متن نهایی شامل «${phrase}»`,
          ok,
          ok ? "یافت شد" : "در پاسخ نهایی یافت نشد",
        ),
      );
    }
  }

  if (spec.not_contains !== undefined) {
    for (const phrase of spec.not_contains) {
      const ok = !trace.finalText.includes(phrase);
      checks.push(
        check(
          `متن نهایی فاقد «${phrase}»`,
          ok,
          ok ? "یافت نشد (درست)" : "به‌اشتباه در پاسخ نهایی آمد",
        ),
      );
    }
  }

  if (spec.type === "rubric_fa") {
    checks.push(...scoreRubric(spec.rubric, trace.finalText));
  }

  const passedCount = checks.filter((c) => c.passed).length;
  return {
    passed: checks.length > 0 && passedCount === checks.length,
    score: passedCount,
    maxScore: checks.length,
    checks,
  };
}

/** Deterministic Persian-quality rubric: lengths, Latin leakage, phrases. */
export function scoreRubric(rubric: RubricSpec | undefined, text: string): CheckResult[] {
  const checks: CheckResult[] = [];
  if (!rubric) return checks;
  const len = [...text].length; // code points, not UTF-16 units

  if (rubric.min_length !== undefined) {
    const ok = len >= rubric.min_length;
    checks.push(
      check(
        `حداقل طول (${rubric.min_length} نویسه)`,
        ok,
        `طول پاسخ: ${len} نویسه`,
      ),
    );
  }
  if (rubric.max_length !== undefined) {
    const ok = len <= rubric.max_length;
    checks.push(
      check(
        `حداکثر طول (${rubric.max_length} نویسه)`,
        ok,
        `طول پاسخ: ${len} نویسه`,
      ),
    );
  }
  if (rubric.forbid_latin === true) {
    const m = text.match(/[A-Za-z]/);
    checks.push(
      check(
        "عدم نشت انگلیسی",
        m === null,
        m === null ? "حرف لاتینی یافت نشد" : `حرف لاتین «${m[0]}» در پاسخ دیده شد`,
      ),
    );
  }
  for (const phrase of rubric.contains ?? []) {
    const ok = text.includes(phrase);
    checks.push(check(`شامل «${phrase}»`, ok, ok ? "یافت شد" : "یافت نشد"));
  }
  if (rubric.contains_any !== undefined && rubric.contains_any.length > 0) {
    const hit = rubric.contains_any.find((p) => text.includes(p));
    checks.push(
      check(
        `شامل یکی از (${rubric.contains_any.join(" / ")})`,
        hit !== undefined,
        hit !== undefined ? `«${hit}» یافت شد` : "هیچ‌کدام یافت نشد",
      ),
    );
  }
  for (const phrase of rubric.not_contains ?? []) {
    const ok = !text.includes(phrase);
    checks.push(
      check(`فاقد «${phrase}»`, ok, ok ? "یافت نشد (درست)" : "به‌اشتباه آمد"),
    );
  }
  return checks;
}

/**
 * Score a whole task. `turns` holds one TurnTrace per prompt turn; multi_turn
 * tasks score each turn against its own sub-spec, everything else scores the
 * single turn (or the concatenation of tool calls for robustness).
 */
export function scoreTask(task: BenchTask, turns: TurnTrace[]): TaskScore {
  if (task.scoring.type === "multi_turn") {
    const per = task.scoring.per_turn ?? [];
    const checks: CheckResult[] = [];
    for (let i = 0; i < per.length; i++) {
      const sub = per[i]!;
      const trace = turns[i] ?? { toolCalls: [], finalText: "" };
      const subScore = scoreTurn(sub, trace);
      for (const c of subScore.checks) {
        checks.push({
          name_fa: `نوبت ${i + 1} — ${c.name_fa}`,
          passed: c.passed,
          detail: c.detail,
        });
      }
    }
    const passedCount = checks.filter((c) => c.passed).length;
    return {
      passed: checks.length > 0 && passedCount === checks.length,
      score: passedCount,
      maxScore: checks.length,
      checks,
    };
  }

  // Single-turn scoring. If a single-turn task somehow ran multiple turns
  // (should not happen), score the last turn's text with all tool calls.
  const merged: TurnTrace =
    turns.length <= 1
      ? (turns[0] ?? { toolCalls: [], finalText: "" })
      : {
          toolCalls: turns.flatMap((t) => t.toolCalls),
          finalText: turns[turns.length - 1]!.finalText,
        };
  return scoreTurn(task.scoring, merged);
}
