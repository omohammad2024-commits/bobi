import { describe, expect, test } from "bun:test";
import { ToolService } from "../src/tools/service";
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
