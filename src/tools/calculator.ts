/**
 * calculator — arithmetic: a full expression evaluator plus the legacy
 * two-operand form.
 *
 * No eval, no Function constructor, no dynamic code: expressions are tokenized
 * by a hand-written tokenizer and evaluated by a recursive-descent parser
 * over a fixed grammar (see below). Division by zero and any non-finite or
 * out-of-range result are rejected as invalid input so a caller always
 * receives a real number.
 *
 * Input contract — exactly ONE of two forms:
 * - { expression: string } — e.g. "200 * 10%", "sqrt(9) + 2^3", "√(۱۶)".
 * - { op, a, b } — the legacy form ("add" | "subtract" | "multiply" |
 *   "divide" on two operands), kept for existing callers.
 * Supplying both forms, a partial legacy form, or neither is invalid_input.
 *
 * Expression grammar (loosest to tightest binding):
 *   additive       := multiplicative (("+" | "-") multiplicative)*
 *   multiplicative := unary (("*" | "/" | "×" | "÷") unary)*
 *   unary          := ("-" | "+") unary | power
 *   power          := postfix ("^" unary)?      // right-associative
 *   postfix        := primary ("%")*            // 50% = 0.5
 *   primary        := number | "pi" | "e" | "π"
 *                   | ("sqrt" | "abs") "(" additive ")"
 *                   | "√" primary
 *                   | "(" additive ")"
 *
 * Conventions (pinned by tests):
 * - Power binds tighter than a unary minus on its LEFT, as in standard
 *   math: -2^2 = -(2^2) = -4, while (-2)^2 = 4. The exponent may itself be
 *   unary (2^-2 = 0.25) and power is right-associative (2^3^2 = 512).
 * - "%" is a POSTFIX operator on the immediately preceding factor:
 *   50% = 0.5, 200 * 10% = 200 * 0.1 = 20, 50% + 1 = 1.5.
 * - Persian/Arabic digits (۰-۹, ٠-٩) are normalized to ASCII before
 *   tokenizing, as are ٫ (decimal point) and ٪ (percent sign).
 */
import { ToolError } from "./errors";
import type { Tool, ToolContext } from "./types";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";

export const CALCULATOR_PERMISSION = "tools:calculator";

export type CalcOp = "add" | "subtract" | "multiply" | "divide";

/**
 * Tool input: exactly one form (enforced in `run`, since the declarative
 * validator can only say "each field is optional"). All fields optional
 * here on purpose — see the XOR rule in `run`.
 */
export interface CalcInput {
  expression?: string;
  op?: CalcOp;
  a?: number;
  b?: number;
}

export type CalcOutput =
  | { op: CalcOp; a: number; b: number; result: number }
  | { expression: string; result: number };

const OPS: Readonly<Record<CalcOp, (a: number, b: number) => number>> = {
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
  divide: (a, b) => a / b,
};

/** Guards against overflow to Infinity, which is not a usable number. */
const MAGNITUDE_LIMIT = 1e308;

/** Hard cap on expression length (characters), checked before tokenizing. */
export const MAX_EXPRESSION_LENGTH = 200;

/** Hard cap on nesting/recursion depth (parens, functions, unary, power). */
export const MAX_EXPRESSION_DEPTH = 32;

export const calculatorManifest: ToolManifest = defineManifest({
  id: "calculator",
  version: "1.0.0",
  title: "Calculator",
  description:
    "Evaluate a math expression ( + - * / ^ % sqrt abs pi e, parentheses ) or add, subtract, multiply or divide two numbers.",
  purpose: "math expressions",
  useWhen: "expression given",
  doNotUseWhen:
    "Unit conversion — unit_converter converts units; this evaluates arithmetic with no units.",
  confusableWith: [
    { tool: "unit_converter", difference: "unit_converter changes units (km to miles); calculator does arithmetic with no units." },
  ],
  latencyTier: "instant",
  outputSummary: "The computed result as a number.",
  category: "utils",
  triggers: {
    keywordPatterns: [
      "حساب کن",
      "محاسبه کن",
      "calculate",
      "what is \\d+\\s*[+\\-*/x×]\\s*\\d+",
      "sqrt\\s*\\(",
      "\\d+\\s*\\^",
      "\\d+\\s*%",
    ],
  },
  costTier: "free",
});

export const calculatorTool: Tool<CalcInput, CalcOutput> = {
  name: "calculator",
  manifest: calculatorManifest,
  description:
    "Evaluate a math expression ( + - * / ^ % sqrt abs pi e, parentheses ) or add, subtract, multiply or divide two numbers.",
  enabled: true,
  permission: { requires: [CALCULATOR_PERMISSION] },
  toolset: "utils",
  input: {
    fields: {
      expression: {
        type: "string",
        required: false,
        description:
          "A math expression to evaluate, e.g. \"200 * 10%\" or \"sqrt(9) + 2^3\". Provide this OR op/a/b, not both.",
        maxLength: MAX_EXPRESSION_LENGTH,
      },
      op: {
        type: "enum",
        required: false,
        description: "The arithmetic operation (legacy two-operand form; requires a and b).",
        choices: ["add", "subtract", "multiply", "divide"],
      },
      a: { type: "number", required: false, description: "First operand (legacy form)." },
      b: { type: "number", required: false, description: "Second operand (legacy form)." },
    },
  },

  async run(input: CalcInput, _ctx: ToolContext): Promise<CalcOutput> {
    // `input` is validated when it arrives through the Executor, but a direct
    // caller can bypass that — so the XOR contract and every type check are
    // re-done here from the raw bag, never assumed.
    const raw = (input ?? {}) as unknown as Record<string, unknown>;

    const expressionValue = raw["expression"];
    if (expressionValue !== undefined && typeof expressionValue !== "string") {
      throw new ToolError("invalid_input", "Field must be a string: expression.", {
        field: "expression",
      });
    }
    const expression =
      typeof expressionValue === "string" ? expressionValue : undefined;
    const hasExpression = expression !== undefined && expression.trim().length > 0;

    const legacyFieldCount = ["op", "a", "b"].filter(
      (k) => raw[k] !== undefined,
    ).length;
    const hasLegacy = legacyFieldCount === 3;

    if (hasExpression && legacyFieldCount > 0) {
      throw new ToolError(
        "invalid_input",
        "Provide either 'expression' or 'op' with 'a' and 'b', not both.",
        { kind: "ambiguous_form" },
      );
    }
    if (!hasExpression && !hasLegacy) {
      throw new ToolError(
        "invalid_input",
        "Provide either 'expression' or 'op' with 'a' and 'b'.",
        { kind: "missing_form" },
      );
    }

    if (hasExpression) {
      const expr = expression as string;
      if (expr.length > MAX_EXPRESSION_LENGTH) {
        throw new ToolError(
          "invalid_input",
          `Expression is too long: ${expr.length} characters (max ${MAX_EXPRESSION_LENGTH}).`,
          { kind: "expression_too_long", length: expr.length },
        );
      }
      const result = evaluateExpression(expr);
      return { expression: expr, result };
    }

    // Legacy form: { op, a, b } — behaviour identical to the original tool.
    const op = raw["op"] as CalcOp;
    const fn = OPS[op];
    if (fn === undefined) {
      // Defence in depth: the validator rejects unknown ops first, but a
      // direct caller bypassing validation gets a clean error, not a crash.
      throw new ToolError("invalid_input", "Invalid operation.", { op: raw["op"] });
    }
    const a = raw["a"];
    const b = raw["b"];
    if (
      typeof a !== "number" ||
      !Number.isFinite(a) ||
      typeof b !== "number" ||
      !Number.isFinite(b)
    ) {
      throw new ToolError("invalid_input", describe("non_finite"), { kind: "non_finite" });
    }
    const result = fn(a, b);

    if (!Number.isFinite(result)) {
      // Distinguishes the actionable case (divide by zero) from overflow.
      const kind = op === "divide" && b === 0 ? "divide_by_zero" : "non_finite";
      throw new ToolError("invalid_input", describe(kind), { kind });
    }

    if (Math.abs(result) > MAGNITUDE_LIMIT) {
      throw new ToolError("invalid_input", describe("overflow"), { kind: "overflow" });
    }

    return { op, a, b, result };
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

/**
 * Reject NaN / Infinity / beyond-range intermediate and final results with
 * the same honest errors as the legacy path, and return the usable value.
 */
function assertUsableResult(value: number): number {
  if (Number.isNaN(value)) {
    throw new ToolError("invalid_input", describe("non_finite"), { kind: "non_finite" });
  }
  if (!Number.isFinite(value)) {
    throw new ToolError("invalid_input", describe("non_finite"), { kind: "non_finite" });
  }
  if (Math.abs(value) > MAGNITUDE_LIMIT) {
    throw new ToolError("invalid_input", describe("overflow"), { kind: "overflow" });
  }
  return value;
}

// ---------- expression tokenizer ----------

type TokenType =
  | "number"
  | "ident"
  | "plus"
  | "minus"
  | "star"
  | "slash"
  | "caret"
  | "percent"
  | "lparen"
  | "rparen"
  | "sqrt"
  | "eof";

interface Token {
  readonly type: TokenType;
  /** Canonical ASCII lexeme for error messages ("*" for ×, "/" for ÷, ...). */
  readonly text: string;
  /** Parsed value for number tokens. */
  readonly value?: number;
  /** 0-based character position in the original expression. */
  readonly pos: number;
}

/**
 * Normalize one character before tokenizing. Every mapping is one code unit
 * to one code unit, so character positions are preserved for error messages.
 * Persian digits ۰-۹ (U+06F0–U+06F9) and Arabic digits ٠-٩ (U+0660–U+0669)
 * become ASCII digits; ٫ becomes "."; ٪ becomes "%"; the Unicode minus
 * sign − becomes "-". All other characters pass through unchanged (the
 * tokenizer itself handles ×, ÷, √ and π).
 */
function normalizeChar(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code === 0x066b) return ".";
  if (code === 0x066a) return "%";
  if (code === 0x2212) return "-";
  return ch;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isSpace(ch: string): boolean {
  return (
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r" ||
    ch === " " ||
    ch === "‌"
  );
}

/** ASCII-safe rendering of an unexpected character for error messages. */
function describeChar(ch: string, normalized: string): string {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x21 && code <= 0x7e) return `'${normalized}'`;
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

function tokenize(source: string): Token[] {
  const normalized = [...source].map(normalizeChar).join("");
  const tokens: Token[] = [];
  let i = 0;

  while (i < normalized.length) {
    const ch = normalized[i] as string;
    const pos = i;

    if (isSpace(ch)) {
      i++;
      continue;
    }

    if (isDigit(ch) || ch === ".") {
      let j = i;
      let sawDigit = false;
      let sawDot = false;
      while (j < normalized.length) {
        const c = normalized[j] as string;
        if (isDigit(c)) {
          sawDigit = true;
          j++;
        } else if (c === "." && !sawDot) {
          sawDot = true;
          j++;
        } else {
          break;
        }
      }
      const text = normalized.slice(i, j);
      if (!sawDigit) {
        throw new ToolError(
          "invalid_input",
          `Invalid number at position ${pos}: '.' needs a digit.`,
          { kind: "parse_error", position: pos },
        );
      }
      tokens.push({ type: "number", text, value: Number(text), pos });
      i = j;
      continue;
    }

    if (isIdentChar(ch)) {
      let j = i;
      while (j < normalized.length && isIdentChar(normalized[j] as string)) j++;
      const text = normalized.slice(i, j).toLowerCase();
      tokens.push({ type: "ident", text, pos });
      i = j;
      continue;
    }

    switch (ch) {
      case "+":
        tokens.push({ type: "plus", text: "+", pos });
        break;
      case "-":
        tokens.push({ type: "minus", text: "-", pos });
        break;
      case "*":
      case "×":
        tokens.push({ type: "star", text: "*", pos });
        break;
      case "/":
      case "÷":
        tokens.push({ type: "slash", text: "/", pos });
        break;
      case "^":
        tokens.push({ type: "caret", text: "^", pos });
        break;
      case "%":
        tokens.push({ type: "percent", text: "%", pos });
        break;
      case "(":
        tokens.push({ type: "lparen", text: "(", pos });
        break;
      case ")":
        tokens.push({ type: "rparen", text: ")", pos });
        break;
      case "√":
        tokens.push({ type: "sqrt", text: "sqrt symbol", pos });
        break;
      case "π":
        tokens.push({ type: "ident", text: "pi", pos });
        break;
      default:
        throw new ToolError(
          "invalid_input",
          `Unexpected character ${describeChar(source[pos] as string, ch)} at position ${pos}.`,
          { kind: "parse_error", position: pos },
        );
    }
    i++;
  }

  tokens.push({ type: "eof", text: "end of expression", pos: normalized.length });
  return tokens;
}

// ---------- expression parser (recursive descent, evaluates as it parses) ----------

function evaluateExpression(source: string): number {
  const parser = new ExpressionParser(tokenize(source));
  return assertUsableResult(parser.parse());
}

class ExpressionParser {
  private readonly tokens: readonly Token[];
  private index = 0;
  private depth = 0;

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  parse(): number {
    const value = this.parseAdditive();
    const rest = this.peek();
    if (rest.type !== "eof") {
      throw new ToolError(
        "invalid_input",
        rest.type === "rparen"
          ? `Unbalanced parentheses: unexpected ')' at position ${rest.pos}.`
          : `Unexpected token '${rest.text}' at position ${rest.pos}.`,
        { kind: "parse_error", position: rest.pos },
      );
    }
    return value;
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private advance(): Token {
    const token = this.tokens[this.index] as Token;
    if (this.index < this.tokens.length - 1) this.index++;
    return token;
  }

  private enterDepth(pos: number): void {
    this.depth++;
    if (this.depth > MAX_EXPRESSION_DEPTH) {
      throw new ToolError(
        "invalid_input",
        `Expression is nested too deeply (max depth ${MAX_EXPRESSION_DEPTH}) at position ${pos}.`,
        { kind: "too_deep", position: pos },
      );
    }
  }

  private exitDepth(): void {
    this.depth--;
  }

  private parseAdditive(): number {
    let left = this.parseMultiplicative();
    for (;;) {
      const op = this.peek();
      if (op.type !== "plus" && op.type !== "minus") return left;
      this.advance();
      const right = this.parseMultiplicative();
      left = assertUsableResult(op.type === "plus" ? left + right : left - right);
    }
  }

  private parseMultiplicative(): number {
    let left = this.parseUnary();
    for (;;) {
      const op = this.peek();
      if (op.type !== "star" && op.type !== "slash") return left;
      this.advance();
      const right = this.parseUnary();
      if (op.type === "slash") {
        if (right === 0) {
          throw new ToolError("invalid_input", describe("divide_by_zero"), {
            kind: "divide_by_zero",
            position: op.pos,
          });
        }
        left = assertUsableResult(left / right);
      } else {
        left = assertUsableResult(left * right);
      }
    }
  }

  private parseUnary(): number {
    const token = this.peek();
    if (token.type === "minus" || token.type === "plus") {
      this.advance();
      this.enterDepth(token.pos);
      try {
        const value = this.parseUnary();
        return assertUsableResult(token.type === "minus" ? -value : value);
      } finally {
        this.exitDepth();
      }
    }
    return this.parsePower();
  }

  private parsePower(): number {
    const base = this.parsePostfix();
    const op = this.peek();
    if (op.type !== "caret") return base;
    this.advance();
    this.enterDepth(op.pos);
    try {
      // The exponent is a unary: this makes power right-associative
      // (2^3^2 = 2^(3^2)) and admits negative exponents (2^-2). Because a
      // leading unary minus wraps the whole power instead (-2^2 = -4),
      // power binds tighter than unary minus on the left.
      const exponent = this.parseUnary();
      return assertUsableResult(Math.pow(base, exponent));
    } finally {
      this.exitDepth();
    }
  }

  private parsePostfix(): number {
    let value = this.parsePrimary();
    while (this.peek().type === "percent") {
      this.advance();
      value = assertUsableResult(value / 100);
    }
    return value;
  }

  private parsePrimary(): number {
    const token = this.peek();

    if (token.type === "number") {
      this.advance();
      return assertUsableResult(token.value as number);
    }

    if (token.type === "sqrt") {
      this.advance();
      this.enterDepth(token.pos);
      try {
        const arg = this.parsePrimary();
        return assertUsableResult(Math.sqrt(arg));
      } finally {
        this.exitDepth();
      }
    }

    if (token.type === "lparen") {
      this.advance();
      this.enterDepth(token.pos);
      try {
        const value = this.parseAdditive();
        this.expectRparen(token.pos);
        return value;
      } finally {
        this.exitDepth();
      }
    }

    if (token.type === "ident") {
      const name = token.text;
      if (name === "pi") {
        this.advance();
        return Math.PI;
      }
      if (name === "e") {
        this.advance();
        return Math.E;
      }
      if (name === "sqrt" || name === "abs") {
        this.advance();
        const open = this.peek();
        if (open.type !== "lparen") {
          throw new ToolError(
            "invalid_input",
            `Expected '(' after '${name}' at position ${open.pos}.`,
            { kind: "parse_error", position: open.pos },
          );
        }
        this.advance();
        this.enterDepth(token.pos);
        try {
          const arg = this.parseAdditive();
          this.expectRparen(token.pos);
          return assertUsableResult(name === "sqrt" ? Math.sqrt(arg) : Math.abs(arg));
        } finally {
          this.exitDepth();
        }
      }
      throw new ToolError(
        "invalid_input",
        `Unknown identifier '${name}' at position ${token.pos}.`,
        { kind: "parse_error", position: token.pos },
      );
    }

    if (token.type === "eof") {
      throw new ToolError(
        "invalid_input",
        `Unexpected end of expression at position ${token.pos}: expected a number, '(' or a function.`,
        { kind: "parse_error", position: token.pos },
      );
    }

    throw new ToolError(
      "invalid_input",
      `Unexpected token '${token.text}' at position ${token.pos}: expected a number, '(' or a function.`,
      { kind: "parse_error", position: token.pos },
    );
  }

  private expectRparen(openPos: number): void {
    const token = this.peek();
    if (token.type !== "rparen") {
      throw new ToolError(
        "invalid_input",
        `Unbalanced parentheses: missing ')' for '(' at position ${openPos}.`,
        { kind: "parse_error", position: openPos },
      );
    }
    this.advance();
  }
}
