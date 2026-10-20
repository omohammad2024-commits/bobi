/**
 * calculator — arithmetic on two operands.
 *
 * No eval, no dynamic code execution: an operator is matched against a fixed
 * table of pure functions. Division by zero and any non-finite result are
 * rejected as invalid input so a caller always receives a real number.
 */
import { ToolError } from "./errors";
import type { Tool, ToolContext } from "./types";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";

export const CALCULATOR_PERMISSION = "tools:calculator";

export type CalcOp = "add" | "subtract" | "multiply" | "divide";

export interface CalcInput {
  op: CalcOp;
  a: number;
  b: number;
}

export interface CalcOutput {
  op: CalcOp;
  a: number;
  b: number;
  result: number;
}

const OPS: Readonly<Record<CalcOp, (a: number, b: number) => number>> = {
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
  divide: (a, b) => a / b,
};

/** Guards against overflow to Infinity, which is not a usable number. */
const MAGNITUDE_LIMIT = 1e308;

export const calculatorManifest: ToolManifest = defineManifest({
  id: "calculator",
  version: "1.0.0",
  title: "Calculator",
  description: "Add, subtract, multiply or divide two numbers.",
  outputSummary: "The computed result as a number.",
  category: "utils",
  triggers: {
    keywordPatterns: [
      "حساب کن",
      "محاسبه کن",
      "calculate",
      "what is \\d+\\s*[+\\-*/x×]\\s*\\d+",
    ],
  },
  costTier: "free",
});

export const calculatorTool: Tool<CalcInput, CalcOutput> = {
  name: "calculator",
  manifest: calculatorManifest,
  description: "Add, subtract, multiply or divide two numbers.",
  enabled: true,
  permission: { requires: [CALCULATOR_PERMISSION] },
  toolset: "utils",
  input: {
    fields: {
      op: {
        type: "enum",
        required: true,
        description: "The arithmetic operation.",
        choices: ["add", "subtract", "multiply", "divide"],
      },
      a: { type: "number", required: true, description: "First operand." },
      b: { type: "number", required: true, description: "Second operand." },
    },
  },

  async run(input: CalcInput, _ctx: ToolContext): Promise<CalcOutput> {
    const fn = OPS[input.op];
    if (fn === undefined) {
      // Defence in depth: the validator rejects unknown ops first, but a
      // direct caller bypassing validation gets a clean error, not a crash.
      throw new ToolError("invalid_input", "Invalid operation.", { op: input.op });
    }
    const result = fn(input.a, input.b);

    if (!Number.isFinite(result)) {
      // Distinguishes the actionable case (divide by zero) from overflow.
      const kind =
        input.op === "divide" && input.b === 0 ? "divide_by_zero" : "non_finite";
      throw new ToolError("invalid_input", describe(kind), { kind });
    }

    if (Math.abs(result) > MAGNITUDE_LIMIT) {
      throw new ToolError("invalid_input", describe("overflow"), { kind: "overflow" });
    }

    return { op: input.op, a: input.a, b: input.b, result };
  },
};

function describe(kind: "divide_by_zero" | "non_finite" | "overflow"): string {
  switch (kind) {
    case "divide_by_zero":
      return "Division by zero is not allowed.";
    case "non_finite":
      return "The result is not a valid number.";
    case "overflow":
      return "The result is out of numeric range.";
  }
}
