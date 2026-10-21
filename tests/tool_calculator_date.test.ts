import { describe, expect, test } from "bun:test";
import { ToolService } from "../src/tools/service";
import { jalaliPartsOf, jalaliToGregorianMs } from "../src/tools/jalali_calendar";
import type { ToolActor, ToolContext } from "../src/tools/types";
import type { ToolErrorKind } from "../src/tools/errors";

// ---------- shared harness ----------

function makeService(clock?: () => Date): ToolService {
  return new ToolService({ timeoutMs: 2000, ...(clock ? { clock } : {}) });
}

/** Actor granted every active tool. */
function fullActor(userId = "user-1"): ToolActor {
  return {
    userId,
    permissions: [
      "tools:calculator",
      "tools:date_time",
      "tools:text_utilities",
      "tools:unit_converter",
    ],
  };
}

interface RunResult<T> {
  status: string;
  data?: T;
  message?: string;
}

async function run<T>(
  tools: ToolService,
  tool: string,
  input: unknown,
  actor: ToolActor,
): Promise<RunResult<T>> {
  const r = await tools.runTool({ tool, input, actor });
  const out: RunResult<T> = { status: r.status };
  if (r.data !== undefined) out.data = r.data as T;
  if (r.message !== undefined) out.message = r.message;
  return out;
}

/** Extract the tool error kind by running directly against the tool. */
async function toolErrorKind(
  service: ToolService,
  tool: string,
  input: unknown,
): Promise<ToolErrorKind | "none"> {
  const t = service.registry.find(tool);
  if (!t) throw new Error("tool missing");
  const fixed = new Date(0);
  const ctx: ToolContext = {
    clock: () => fixed,
    actor: fullActor(),
    signal: new AbortController().signal,
  };
  try {
    await t.run(input as Record<string, unknown>, ctx);
    return "none";
  } catch (err) {
    return (err as { kind?: ToolErrorKind }).kind ?? "none";
  }
}

// ---------- calculator ----------

describe("calculator", () => {
  test("adds, subtracts, multiplies", async () => {
    const svc = makeService();
    const a = fullActor();
    expect((await run<{ result: number }>(svc, "calculator", { op: "add", a: 2, b: 3 }, a)).data?.result).toBe(5);
    expect((await run<{ result: number }>(svc, "calculator", { op: "subtract", a: 3, b: 10 }, a)).data?.result).toBe(-7);
    expect((await run<{ result: number }>(svc, "calculator", { op: "multiply", a: -4, b: 2.5 }, a)).data?.result).toBe(-10);
  });

  test("divides", async () => {
    const svc = makeService();
    const r = await run<{ result: number }>(
      svc,
      "calculator",
      { op: "divide", a: 22, b: 7 },
      fullActor(),
    );
    expect(r.data?.result).toBeCloseTo(22 / 7, 12);
  });

  test("division by zero is rejected", async () => {
    const svc = makeService();
    const r = await run(svc, "calculator", { op: "divide", a: 1, b: 0 }, fullActor());
    expect(r.status).not.toBe("ok");
    expect(await toolErrorKind(svc, "calculator", { op: "divide", a: 1, b: 0 })).toBe("invalid_input");
  });

  test("non-finite result is rejected", async () => {
    const svc = makeService();
    const r = await run(
      svc,
      "calculator",
      { op: "multiply", a: 1e308, b: 1e10 },
      fullActor(),
    );
    // Result overflows to Infinity — rejected as an invalid computation.
    expect(r.status).toBe("invalid_input");
    expect(await toolErrorKind(svc, "calculator", { op: "multiply", a: 1e308, b: 1e10 })).toBe(
      "invalid_input",
    );
  });

  test("validates its input", async () => {
    const svc = makeService();
    const a = fullActor();
    for (const bad of [
      { op: "power", a: 1, b: 2 },
      { op: "add", a: "1", b: 2 },
      { op: "add", a: 1 },
      { op: "add", a: Number.NaN, b: 1 },
      { op: "add", a: Infinity, b: 1 },
      {},
    ]) {
      const r = await run(svc, "calculator", bad, a);
      expect(r.status).toBe("invalid_input");
    }
  });

  test("calculator does not use eval or dynamic code execution", async () => {
    const svc = makeService();
    // Anything code-shaped must be rejected, never evaluated.
    for (const evil of [
      { op: "add", a: 1, b: "process.exit(1)" },
      { op: "add", a: "1+1", b: 2 },
      { op: "add", a: 1, b: "globalThis" },
    ]) {
      const r = await run(svc, "calculator", evil, fullActor());
      expect(r.status).not.toBe("ok");
    }
  });
});

// ---------- calculator expressions ----------

describe("calculator expressions", () => {
  /** Direct-run error message (bypasses the Executor, like toolErrorKind). */
  async function exprErrorMessage(
    service: ToolService,
    input: unknown,
  ): Promise<string> {
    const t = service.registry.find("calculator");
    if (!t) throw new Error("tool missing");
    const ctx: ToolContext = {
      clock: () => new Date(0),
      actor: fullActor(),
      signal: new AbortController().signal,
    };
    try {
      await t.run(input as Record<string, unknown>, ctx);
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  }

  async function exprResult(
    svc: ToolService,
    expression: string,
  ): Promise<number | undefined> {
    const r = await run<{ result: number }>(
      svc,
      "calculator",
      { expression },
      fullActor(),
    );
    expect(r.status).toBe("ok");
    return r.data?.result;
  }

  test("expression form returns { expression, result }", async () => {
    const svc = makeService();
    const r = await run<{ expression: string; result: number }>(
      svc,
      "calculator",
      { expression: "2+3*4" },
      fullActor(),
    );
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ expression: "2+3*4", result: 14 });
  });

  test("precedence: multiplication and division bind tighter than + and -", async () => {
    const svc = makeService();
    expect(await exprResult(svc, "2+3*4")).toBe(14);
    expect(await exprResult(svc, "2*3+4")).toBe(10);
    expect(await exprResult(svc, "10-2*3")).toBe(4);
    expect(await exprResult(svc, "2+10/4")).toBe(4.5);
    expect(await exprResult(svc, "10/2/5")).toBe(1);
    expect(await exprResult(svc, "1.5*2+0.5")).toBe(3.5);
    expect(await exprResult(svc, ".5+.5")).toBe(1);
  });

  test("parentheses override precedence", async () => {
    const svc = makeService();
    expect(await exprResult(svc, "(2+3)*4")).toBe(20);
    expect(await exprResult(svc, "2*(3+4)")).toBe(14);
    expect(await exprResult(svc, "((2+3))*((4))")).toBe(20);
    expect(await exprResult(svc, "10-(2+3)")).toBe(5);
  });

  test("multiplication and division glyphs × and ÷ work", async () => {
    const svc = makeService();
    expect(await exprResult(svc, "3×4")).toBe(12);
    expect(await exprResult(svc, "12÷4")).toBe(3);
    expect(await exprResult(svc, "2×3+8÷2")).toBe(10);
  });

  test("power: ^ is right-associative and binds tighter than * and unary minus", async () => {
    const svc = makeService();
    expect(await exprResult(svc, "2^10")).toBe(1024);
    expect(await exprResult(svc, "2^3^2")).toBe(512); // 2^(3^2), not (2^3)^2
    expect(await exprResult(svc, "2*3^2")).toBe(18);
    // Standard convention pinned: -2^2 = -(2^2) = -4, (-2)^2 = 4.
    expect(await exprResult(svc, "-2^2")).toBe(-4);
    expect(await exprResult(svc, "(-2)^2")).toBe(4);
    expect(await exprResult(svc, "2^-2")).toBe(0.25);
    expect(await exprResult(svc, "9^0.5")).toBe(3);
  });

  test("unary minus and plus", async () => {
    const svc = makeService();
    expect(await exprResult(svc, "-3+5")).toBe(2);
    expect(await exprResult(svc, "+5")).toBe(5);
    expect(await exprResult(svc, "-(2+3)")).toBe(-5);
    expect(await exprResult(svc, "3*-2")).toBe(-6);
    expect(await exprResult(svc, "--5")).toBe(5);
    expect(await exprResult(svc, "5--3")).toBe(8);
  });

  test("postfix percent divides the preceding factor by 100", async () => {
    const svc = makeService();
    expect(await exprResult(svc, "50%")).toBe(0.5);
    expect(await exprResult(svc, "100%")).toBe(1);
    expect(await exprResult(svc, "200*10%")).toBe(20);
    expect(await exprResult(svc, "50%+1")).toBe(1.5);
    expect(await exprResult(svc, "(50+50)%")).toBe(1);
    expect(await exprResult(svc, "200-10%")).toBeCloseTo(199.9, 12);
  });

  test("sqrt, √ and abs functions", async () => {
    const svc = makeService();
    expect(await exprResult(svc, "sqrt(16)")).toBe(4);
    expect(await exprResult(svc, "sqrt(9+16)")).toBe(5);
    expect(await exprResult(svc, "sqrt(2)")).toBeCloseTo(Math.SQRT2, 12);
    expect(await exprResult(svc, "√(25)")).toBe(5);
    expect(await exprResult(svc, "√9")).toBe(3);
    expect(await exprResult(svc, "sqrt(16)+√(9)")).toBe(7);
    expect(await exprResult(svc, "abs(-7)")).toBe(7);
    expect(await exprResult(svc, "abs(3-10)")).toBe(7);
    expect(await exprResult(svc, "abs(-2^2)")).toBe(4); // abs(-(2^2))
  });

  test("constants pi and e", async () => {
    const svc = makeService();
    expect(await exprResult(svc, "pi")).toBeCloseTo(Math.PI, 12);
    expect(await exprResult(svc, "e")).toBeCloseTo(Math.E, 12);
    expect(await exprResult(svc, "2*pi")).toBeCloseTo(2 * Math.PI, 12);
    expect(await exprResult(svc, "π")).toBeCloseTo(Math.PI, 12);
  });

  test("Persian and Arabic digits are normalized", async () => {
    const svc = makeService();
    expect(await exprResult(svc, "۲+۳")).toBe(5);
    expect(await exprResult(svc, "۲×(۳+۴)")).toBe(14);
    expect(await exprResult(svc, "١٢÷٣")).toBe(4);
    expect(await exprResult(svc, "۲^۳")).toBe(8);
    expect(await exprResult(svc, "۵۰%")).toBe(0.5);
    expect(await exprResult(svc, "۵۰٪")).toBe(0.5);
    expect(await exprResult(svc, "√(۱۶)")).toBe(4);
  });

  test("malformed expressions are rejected with invalid_input", async () => {
    const svc = makeService();
    const a = fullActor();
    for (const bad of [
      "(1+2", // unbalanced parens
      "1+2)", // extra closing paren
      "1+", // trailing operator
      "2**3", // doubled operator
      "()", // empty parens
      "foo(1)", // unknown function
      "bar+1", // unknown identifier
      "sqrt(1", // unbalanced function call
      "sqrt 16", // function without parens
      "1 2", // two numbers, no operator
      ".", // lone decimal point
      "1/ ", // trailing operator after spaces
      "process.exit(1)", // code-shaped input is never evaluated
      "globalThis", // unknown identifier, not a global lookup
    ]) {
      const r = await run(svc, "calculator", { expression: bad }, a);
      expect(r.status).toBe("invalid_input");
      expect(await toolErrorKind(svc, "calculator", { expression: bad })).toBe(
        "invalid_input",
      );
    }
  });

  test("parse errors name the problem", async () => {
    const svc = makeService();
    expect(await exprErrorMessage(svc, { expression: "(1+2" })).toContain(")");
    expect(await exprErrorMessage(svc, { expression: "bar+1" })).toContain("bar");
    expect(await exprErrorMessage(svc, { expression: "1+" })).toContain(
      "end of expression",
    );
  });

  test("empty expression is rejected", async () => {
    const svc = makeService();
    const a = fullActor();
    for (const bad of [{ expression: "" }, { expression: "   " }]) {
      const r = await run(svc, "calculator", bad, a);
      expect(r.status).toBe("invalid_input");
      expect(await toolErrorKind(svc, "calculator", bad)).toBe("invalid_input");
    }
  });

  test("divide by zero via expression is rejected", async () => {
    const svc = makeService();
    const a = fullActor();
    for (const bad of ["1/0", "1/(2-2)", "0/0"]) {
      const r = await run(svc, "calculator", { expression: bad }, a);
      expect(r.status).toBe("invalid_input");
      expect(await toolErrorKind(svc, "calculator", { expression: bad })).toBe(
        "invalid_input",
      );
    }
    expect(await exprErrorMessage(svc, { expression: "1/0" })).toBe(
      "Division by zero is not allowed.",
    );
  });

  test("non-finite expression results are rejected", async () => {
    const svc = makeService();
    const a = fullActor();
    for (const bad of ["10^1000", "sqrt(-1)", "(-2)^0.5", "10^308*10"]) {
      const r = await run(svc, "calculator", { expression: bad }, a);
      expect(r.status).toBe("invalid_input");
    }
  });

  test("length cap: expressions over 200 characters are rejected", async () => {
    const svc = makeService();
    const tooLong = "1" + "+1".repeat(100); // 201 characters
    expect(tooLong.length).toBe(201);
    const r = await run(svc, "calculator", { expression: tooLong }, fullActor());
    expect(r.status).toBe("invalid_input");
    // The tool body itself enforces the cap for direct callers too.
    expect(await toolErrorKind(svc, "calculator", { expression: tooLong })).toBe(
      "invalid_input",
    );
    expect(await exprErrorMessage(svc, { expression: tooLong })).toContain("too long");
    // Exactly at the cap is still accepted when it parses.
    const atCap = "11" + "+1".repeat(99); // 200 characters, = 110
    expect(atCap.length).toBe(200);
    expect(await exprResult(svc, atCap)).toBe(110);
  });

  test("depth cap: pathologically nested expressions are rejected", async () => {
    const svc = makeService();
    const deep = "(".repeat(40) + "1" + ")".repeat(40);
    const r = await run(svc, "calculator", { expression: deep }, fullActor());
    expect(r.status).toBe("invalid_input");
    expect(await toolErrorKind(svc, "calculator", { expression: deep })).toBe(
      "invalid_input",
    );
    expect(await exprErrorMessage(svc, { expression: deep })).toContain("too deeply");
    // Reasonable nesting still works.
    expect(await exprResult(svc, "((((1+2))))*3")).toBe(9);
  });

  test("legacy { op, a, b } form still works and keeps its output shape", async () => {
    const svc = makeService();
    const r = await run<{ op: string; a: number; b: number; result: number }>(
      svc,
      "calculator",
      { op: "multiply", a: 6, b: 7 },
      fullActor(),
    );
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ op: "multiply", a: 6, b: 7, result: 42 });
  });

  test("supplying both forms is an invalid_input error explaining the two forms", async () => {
    const svc = makeService();
    const both = { expression: "1+1", op: "add", a: 1, b: 2 };
    const r = await run(svc, "calculator", both, fullActor());
    expect(r.status).toBe("invalid_input");
    expect(await toolErrorKind(svc, "calculator", both)).toBe("invalid_input");
    const message = await exprErrorMessage(svc, both);
    expect(message).toContain("expression");
    expect(message).toContain("not both");
  });

  test("supplying neither form (or a partial legacy form) is invalid_input", async () => {
    const svc = makeService();
    const a = fullActor();
    for (const bad of [{}, { op: "add", a: 1 }, { a: 1, b: 2 }, { op: "add" }]) {
      const r = await run(svc, "calculator", bad, a);
      expect(r.status).toBe("invalid_input");
      expect(await toolErrorKind(svc, "calculator", bad)).toBe("invalid_input");
    }
    const message = await exprErrorMessage(svc, {});
    expect(message).toContain("expression");
    expect(message).toContain("'op'");
  });
});

// ---------- date_time ----------

describe("date_time", () => {
  test("formats a FIXED instant with an injected clock", async () => {
    const svc = makeService(() => new Date(Date.UTC(2026, 0, 15, 10, 30, 0)));
    const r = await run<{ date: string; time: string; weekday: string }>(
      svc,
      "date_time",
      { timezone: "UTC", locale: "en-US" },
      fullActor(),
    );
    expect(r.status).toBe("ok");
    expect(r.data?.date).toBe("2026-01-15");
    expect(r.data?.time).toBe("10:30:00");
    expect(r.data?.weekday).toBe("Thursday");
  });

  test("applies a timezone offset to the same instant", async () => {
    const svc = makeService(() => new Date(Date.UTC(2026, 0, 15, 10, 30, 0)));
    const r = await run<{ date: string; time: string }>(
      svc,
      "date_time",
      { timezone: "Asia/Tehran" },
      fullActor(),
    );
    // UTC 10:30 → Tehran is UTC+3:30 → 14:00
    expect(r.data?.time).toBe("۱۴:۰۰:۰۰");
  });

  test("accepts several valid timezones", async () => {
    const svc = makeService(() => new Date(Date.UTC(2026, 6, 1, 12, 0, 0)));
    for (const tz of ["UTC", "Asia/Tehran", "Europe/London", "America/New_York"]) {
      const r = await run(svc, "date_time", { timezone: tz }, fullActor());
      expect(r.status).toBe("ok");
    }
  });

  test("rejects an invalid timezone", async () => {
    const svc = makeService(() => new Date());
    for (const bad of ["Not/AZone", "sol/planet", "", "  "]) {
      const r = await run(svc, "date_time", { timezone: bad }, fullActor());
      expect(r.status).not.toBe("ok");
      expect(await toolErrorKind(svc, "date_time", { timezone: bad })).toBe("invalid_input");
    }
  });

  test("handles DST correctly for both hemispheres", async () => {
    // The same wall-clock instant is rendered per-zone; DST shifts the hour.
    const summer = makeService(() => new Date(Date.UTC(2026, 0, 15, 12, 0, 0)));
    const r1 = await run<{ time: string }>(
      summer,
      "date_time",
      { timezone: "America/New_York", locale: "en-US" },
      fullActor(),
    );
    expect(r1.data?.time).toBe("07:00:00"); // EST = UTC-5

    const winter = makeService(() => new Date(Date.UTC(2026, 6, 15, 12, 0, 0)));
    const r2 = await run<{ time: string }>(
      winter,
      "date_time",
      { timezone: "America/New_York", locale: "en-US" },
      fullActor(),
    );
    expect(r2.data?.time).toBe("08:00:00"); // EDT = UTC-4
  });

  test("rejects an invalid locale", async () => {
    const svc = makeService(() => new Date());
    const r = await run(
      svc,
      "date_time",
      { timezone: "UTC", locale: "!!!invalid!!!" },
      fullActor(),
    );
    expect(r.status).not.toBe("ok");
  });

  test("rejects an over-long timezone string", async () => {
    const svc = makeService(() => new Date());
    const r = await run(
      svc,
      "date_time",
      { timezone: "x".repeat(200) },
      fullActor(),
    );
    expect(r.status).toBe("invalid_input");
  });

  // ---------- date_time: Jalali + arbitrary dates + differences ----------
  // Hard-coded Gregorian↔Jalali pairs below were verified against Intl
  // (en-u-ca-persian, Asia/Tehran) in a scratch `bun` run before being
  // written here:
  //   2026-10-20T12:00+03:30 → ۲۸ مهر ۱۴۰۵ (سه‌شنبه)
  //   2026-03-21T12:00+03:30 → ۱ فروردین ۱۴۰۵ (شنبه) — Nowruz
  //   2025-03-20T12:00+03:30 → ۳۰ اسفند ۱۴۰۳ (پنجشنبه) — leap-year Esfand 30

  type JalaliBlock = {
    year: number; month: number; day: number;
    monthName: string; weekday: string; formatted: string;
  };
  type DiffBlock = {
    milliseconds: number; days: number; hours: number;
    minutes: number; seconds: number; direction: string; human: string;
  };

  test("always includes Jalali parts for the reported instant", async () => {
    const svc = makeService(() => new Date(Date.UTC(2026, 9, 20, 8, 30, 0)));
    const r = await run<{ jalali: JalaliBlock }>(
      svc,
      "date_time",
      { timezone: "Asia/Tehran", locale: "en-US" },
      fullActor(),
    );
    expect(r.status).toBe("ok");
    expect(r.data?.jalali).toEqual({
      year: 1405,
      month: 7,
      day: 28,
      monthName: "مهر",
      weekday: "سه‌شنبه",
      formatted: "۲۸ مهر ۱۴۰۵",
    });
  });

  test("Jalali conversion matches hard-coded known pairs", async () => {
    const svc = makeService(() => new Date(0));
    const cases: Array<{ date: string; jalali: JalaliBlock }> = [
      {
        date: "2026-10-20T12:00:00+03:30",
        jalali: { year: 1405, month: 7, day: 28, monthName: "مهر", weekday: "سه‌شنبه", formatted: "۲۸ مهر ۱۴۰۵" },
      },
      {
        // Nowruz 1405
        date: "2026-03-21T12:00:00+03:30",
        jalali: { year: 1405, month: 1, day: 1, monthName: "فروردین", weekday: "شنبه", formatted: "۱ فروردین ۱۴۰۵" },
      },
      {
        // 1403 is a leap year: Esfand has 30 days.
        date: "2025-03-20T12:00:00+03:30",
        jalali: { year: 1403, month: 12, day: 30, monthName: "اسفند", weekday: "پنجشنبه", formatted: "۳۰ اسفند ۱۴۰۳" },
      },
    ];
    for (const c of cases) {
      const r = await run<{ jalali: JalaliBlock }>(
        svc,
        "date_time",
        { timezone: "Asia/Tehran", locale: "en-US", date: c.date },
        fullActor(),
      );
      expect(r.status).toBe("ok");
      expect(r.data?.jalali).toEqual(c.jalali);
    }
  });

  test("jalaliPartsOf / jalaliToGregorianMs round-trip on the same Jalali day", () => {
    for (const iso of [
      "2026-10-20T12:00:00+03:30",
      "2026-03-21T00:30:00+03:30",
      "2025-03-20T23:59:00+03:30",
      "2026-01-15T10:30:00+03:30",
    ]) {
      const ms = Date.parse(iso);
      const p = jalaliPartsOf(ms, "Asia/Tehran");
      const back = jalaliToGregorianMs(p.jy, p.jm, p.jd, "Asia/Tehran");
      expect(back).not.toBeNull();
      // The inverse lands on zone midnight of the same Jalali day.
      const p2 = jalaliPartsOf(back!, "Asia/Tehran");
      expect([p2.jy, p2.jm, p2.jd]).toEqual([p.jy, p.jm, p.jd]);
      expect(back!).toBeLessThanOrEqual(ms);
      expect(ms - back!).toBeLessThan(24 * 60 * 60 * 1000);
    }
  });

  test("impossible Jalali dates are rejected by the helper", () => {
    // مهر has 30 days — day 31 never exists.
    expect(jalaliToGregorianMs(1405, 7, 31, "Asia/Tehran")).toBeNull();
    // 1404 is not a leap year — no 30 اسفند.
    expect(jalaliToGregorianMs(1404, 12, 30, "Asia/Tehran")).toBeNull();
    // …but 1403 IS a leap year, so 30 اسفند ۱۴۰۳ resolves.
    expect(jalaliToGregorianMs(1403, 12, 30, "Asia/Tehran")).not.toBeNull();
    // Out-of-range fields.
    expect(jalaliToGregorianMs(1405, 13, 1, "Asia/Tehran")).toBeNull();
    expect(jalaliToGregorianMs(1405, 1, 32, "Asia/Tehran")).toBeNull();
  });

  test("reports an arbitrary `date` instant instead of the clock", async () => {
    const svc = makeService(() => new Date(Date.UTC(2026, 0, 15, 10, 30, 0)));
    const r = await run<{ iso: string; date: string; time: string }>(
      svc,
      "date_time",
      { timezone: "Asia/Tehran", locale: "en-US", date: "2026-10-20T12:00:00+03:30" },
      fullActor(),
    );
    expect(r.status).toBe("ok");
    expect(r.data?.iso).toBe("2026-10-20T08:30:00.000Z");
    expect(r.data?.date).toBe("2026-10-20");
    expect(r.data?.time).toBe("12:00:00");
  });

  test('date: "now" falls back to the injected clock', async () => {
    const svc = makeService(() => new Date(Date.UTC(2026, 0, 15, 10, 30, 0)));
    const r = await run<{ iso: string }>(
      svc,
      "date_time",
      { timezone: "UTC", locale: "en-US", date: "now" },
      fullActor(),
    );
    expect(r.status).toBe("ok");
    expect(r.data?.iso).toBe("2026-01-15T10:30:00.000Z");
  });

  test("difference: exact breakdown and 'later' direction", async () => {
    const svc = makeService(() => new Date(0));
    const r = await run<{ difference: DiffBlock }>(
      svc,
      "date_time",
      {
        timezone: "UTC",
        locale: "en-US",
        date: "2026-01-18T14:05:06Z",
        compareTo: "2026-01-15T10:00:00Z",
      },
      fullActor(),
    );
    expect(r.status).toBe("ok");
    const expectedMs = (3 * 86_400 + 4 * 3_600 + 5 * 60 + 6) * 1000;
    expect(r.data?.difference).toEqual({
      milliseconds: expectedMs,
      days: 3,
      hours: 4,
      minutes: 5,
      seconds: 6,
      direction: "later",
      human: "3 days, 4 hours later",
    });
  });

  test("difference: 'earlier' direction keeps an absolute breakdown", async () => {
    const svc = makeService(() => new Date(0));
    const r = await run<{ difference: DiffBlock }>(
      svc,
      "date_time",
      {
        timezone: "UTC",
        locale: "en-US",
        date: "2026-01-15T10:00:00Z",
        compareTo: "2026-01-18T14:05:06Z",
      },
      fullActor(),
    );
    expect(r.status).toBe("ok");
    expect(r.data?.difference.milliseconds).toBe((3 * 86_400 + 4 * 3_600 + 5 * 60 + 6) * 1000);
    expect(r.data?.difference.direction).toBe("earlier");
    expect(r.data?.difference.human).toBe("3 days, 4 hours earlier");
  });

  test("difference: same instant, and difference against the clock when date is omitted", async () => {
    const svc = makeService(() => new Date(Date.UTC(2026, 0, 15, 10, 30, 0)));
    const same = await run<{ difference: DiffBlock }>(
      svc,
      "date_time",
      {
        timezone: "UTC",
        locale: "en-US",
        date: "2026-01-15T10:30:00Z",
        compareTo: "2026-01-15T10:30:00Z",
      },
      fullActor(),
    );
    expect(same.data?.difference).toEqual({
      milliseconds: 0,
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      direction: "same",
      human: "same instant",
    });

    const vsClock = await run<{ difference: DiffBlock }>(
      svc,
      "date_time",
      { timezone: "UTC", locale: "en-US", compareTo: "2026-01-14T10:30:00Z" },
      fullActor(),
    );
    expect(vsClock.data?.difference.days).toBe(1);
    expect(vsClock.data?.difference.direction).toBe("later");
    expect(vsClock.data?.difference.human).toBe("1 day later");
  });

  test("no difference block when compareTo is omitted", async () => {
    const svc = makeService(() => new Date(Date.UTC(2026, 0, 15, 10, 30, 0)));
    const r = await run<Record<string, unknown>>(
      svc,
      "date_time",
      { timezone: "UTC", locale: "en-US" },
      fullActor(),
    );
    expect(r.status).toBe("ok");
    expect(r.data && "difference" in r.data).toBe(false);
  });

  test("rejects invalid date and compareTo inputs", async () => {
    const svc = makeService(() => new Date(Date.UTC(2026, 0, 15, 10, 30, 0)));
    for (const bad of [
      { date: "not-a-date" },
      { date: "" },
      { date: "2026-13-01T00:00:00Z" },
      { compareTo: "tomorrow-ish" },
      { date: "2026-01-15T10:30:00Z", compareTo: "2026-02-30T99:99:99Z" },
    ]) {
      const r = await run(svc, "date_time", { timezone: "UTC", ...bad }, fullActor());
      expect(r.status).toBe("invalid_input");
      expect(await toolErrorKind(svc, "date_time", { timezone: "UTC", ...bad })).toBe("invalid_input");
    }
  });
});

// ---------- text_utilities ----------

describe("text_utilities", () => {
  test("counts characters and words", async () => {
    const svc = makeService();
    const r = await run<{ characters: number; words: number }>(
      svc,
      "text_utilities",
      { text: "سلام دنیا" },
      fullActor(),
    );
    expect(r.status).toBe("ok");
    expect(r.data?.characters).toBe("سلام دنیا".length);
    expect(r.data?.words).toBe(2);
  });

  test("empty text is rejected", async () => {
    const svc = makeService();
    const r = await run(svc, "text_utilities", { text: "" }, fullActor());
    expect(r.status).toBe("invalid_input");
  });

  test("whitespace-only text is rejected", async () => {
    const svc = makeService();
    const r = await run(svc, "text_utilities", { text: "   \n\t  " }, fullActor());
    expect(r.status).toBe("invalid_input");
    // The tool body itself rejects it, not just the length validator.
    expect(await toolErrorKind(svc, "text_utilities", { text: "   \n\t  " })).toBe("invalid_input");
  });

  test("over-long input is rejected, not truncated", async () => {
    const svc = makeService();
    const r = await run(
      svc,
      "text_utilities",
      { text: "a".repeat(65_536 + 1) },
      fullActor(),
    );
    expect(r.status).toBe("invalid_input");
  });

  test("text at exactly the cap is accepted", async () => {
    const svc = makeService();
    const atCap = "a".repeat(65_536);
    const r = await run<{ characters: number }>(
      svc,
      "text_utilities",
      { text: atCap },
      fullActor(),
    );
    expect(r.status).toBe("ok");
    expect(r.data?.characters).toBe(65_536);
  });

  test("output never echoes the input text", async () => {
    const svc = makeService();
    const secretText = "پسورد من: hunter2 در فایل سی‌د.bla";
    const r = await run<Record<string, unknown>>(
      svc,
      "text_utilities",
      { text: secretText },
      fullActor(),
    );
    // counts only, no text content
    expect(JSON.stringify(r.data)).not.toContain("hunter2");
    expect(JSON.stringify(r)).not.toContain(secretText);
  });

  test("rejects a non-string", async () => {
    const svc = makeService();
    const r = await run(svc, "text_utilities", { text: 12345 }, fullActor());
    expect(r.status).toBe("invalid_input");
  });
});

// ---------- unit_converter ----------

describe("unit_converter", () => {
  const svc = makeService();
  const a = fullActor();

  test("length", async () => {
    const r = await run<{ result: number }>(svc, "unit_converter", { value: 1, from: "km", to: "mi" }, a);
    expect(r.data?.result).toBeCloseTo(0.6213711922, 9);
  });

  test("mass", async () => {
    const r = await run<{ result: number }>(svc, "unit_converter", { value: 1000, from: "g", to: "kg" }, a);
    expect(r.data?.result).toBe(1);
  });

  test("volume: 1 US gallon is 3.785411784 litres", async () => {
    const r = await run<{ result: number }>(svc, "unit_converter", { value: 1, from: "gal", to: "l" }, a);
    expect(r.data?.result).toBeCloseTo(3.785411784, 9);
  });

  test("volume: litres to millilitres", async () => {
    const r = await run<{ result: number }>(svc, "unit_converter", { value: 2.5, from: "l", to: "ml" }, a);
    expect(r.data?.result).toBeCloseTo(2500, 6);
  });

  test("same unit is identity", async () => {
    const r = await run<{ result: number }>(svc, "unit_converter", { value: 42, from: "cm", to: "cm" }, a);
    expect(r.data?.result).toBe(42);
  });

  test("centimetres to metres and back", async () => {
    const r = await run<{ result: number }>(svc, "unit_converter", { value: 2500, from: "cm", to: "m" }, a);
    expect(r.data?.result).toBe(25);
  });

  test("temperature: °C → °F", async () => {
    const r = await run<{ result: number }>(svc, "unit_converter", { value: 100, from: "c", to: "f" }, a);
    expect(r.data?.result).toBe(212);
  });

  test("temperature: °F → °C", async () => {
    const r = await run<{ result: number }>(svc, "unit_converter", { value: 32, from: "f", to: "c" }, a);
    expect(r.data?.result).toBe(0);
  });

  test("temperature: °C → K and back", async () => {
    const toK = await run<{ result: number }>(svc, "unit_converter", { value: 0, from: "c", to: "k" }, a);
    expect(toK.data?.result).toBeCloseTo(273.15, 9);
    const back = await run<{ result: number }>(svc, "unit_converter", { value: 273.15, from: "k", to: "c" }, a);
    expect(back.data?.result).toBeCloseTo(0, 9);
  });

  test("temperature below absolute zero is rejected", async () => {
    const r = await run(svc, "unit_converter", { value: -300, from: "c", to: "k" }, a);
    expect(r.status).not.toBe("ok");
    expect(await toolErrorKind(svc, "unit_converter", { value: -300, from: "c", to: "k" })).toBe("invalid_input");
  });

  test("unknown unit is rejected", async () => {
    for (const bad of [
      { value: 1, from: "xyz", to: "m" },
      { value: 1, from: "m", to: "xyz" },
      { value: 1, from: "km", to: "zzz" },
    ]) {
      const r = await run(svc, "unit_converter", bad, a);
      expect(r.status).not.toBe("ok");
      expect(await toolErrorKind(svc, "unit_converter", bad)).toBe("invalid_input");
    }
  });

  test("a category mismatch is rejected (length vs mass)", async () => {
    const r = await run(svc, "unit_converter", { value: 1, from: "km", to: "kg" }, a);
    expect(r.status).not.toBe("ok");
  });

  test("temperature vs non-temperature is rejected", async () => {
    const r = await run(svc, "unit_converter", { value: 1, from: "c", to: "kg" }, a);
    expect(r.status).not.toBe("ok");
  });

  test("malformed unit ids are rejected", async () => {
    for (const bad of [
      { value: 1, from: "", to: "m" },
      { value: 1, from: "K M", to: "m" },
      { value: 1, from: "m!", to: "m" },
      { value: 1, from: "../../etc/passwd", to: "m" },
    ]) {
      const r = await run(svc, "unit_converter", bad, a);
      expect(r.status).not.toBe("ok");
    }
  });

  test("non-numeric value is rejected", async () => {
    const r = await run(svc, "unit_converter", { value: "one", from: "m", to: "km" }, a);
    expect(r.status).toBe("invalid_input");
  });

  test("unit ids are case-insensitive", async () => {
    const r = await run<{ result: number }>(svc, "unit_converter", { value: 1, from: "KM", to: "m" }, a);
    expect(r.status).toBe("ok");
    expect(r.data?.result).toBe(1000);
  });
});
