/**
 * weather tool (Phase-9 Action Layer) + the morning-digest weather seam.
 *
 * The tool talks to Open-Meteo, which is KEYLESS — these tests pin that
 * the tool is live by default (enabled, not owner-only, no config gate)
 * and that every HTTP path runs against a FAKE fetch returning fixtures
 * in the real Open-Meteo shapes. No real network anywhere in this file.
 *
 * Digest seam: DigestDeps.weatherLine is optional and additive — absent
 * (or undefined/empty/throwing) leaves the digest byte-identical, a
 * resolved line appears as its own short section.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Storage } from "../src/storage/storage";
import { ProposalStore } from "../src/curator/proposals";
import {
  createWeatherTool,
  fetchWeatherLine,
  weatherCondition,
  weatherManifest,
  weatherTool,
  WEATHER_PERMISSION,
  type WeatherFetchFn,
} from "../src/tools/weather";
import { ToolError } from "../src/tools/errors";
import { validateManifest } from "../src/tools/validate_manifest";
import type { Tool, ToolContext } from "../src/tools/types";
import type { WeatherInput, WeatherOutput } from "../src/tools/weather";
import {
  buildDigest,
  buildDigestData,
  formatDigest,
  renderDigestText,
} from "../src/digest/builder";
import type { DigestDeps } from "../src/digest/builder";

const OWNER = "12345";
/** 2026-10-18T04:30:00Z == 08:00 Asia/Tehran (a Sunday). */
const NOW_MS = Date.parse("2026-10-18T04:30:00Z");

function ctx(): ToolContext {
  return {
    clock: () => new Date(NOW_MS),
    actor: { userId: OWNER, permissions: [WEATHER_PERMISSION] },
    signal: new AbortController().signal,
  };
}

// ---------------------------------------------------------------------------
// Fake Open-Meteo fixtures (real response shapes)
// ---------------------------------------------------------------------------

const GEO_BODY = {
  results: [
    {
      id: 112931,
      name: "Tehran",
      latitude: 35.689198,
      longitude: 51.388973,
      country: "Iran",
      admin1: "Tehran",
      timezone: "Asia/Tehran",
    },
  ],
  generationtime_ms: 0.12,
};

const FORECAST_BODY = {
  latitude: 35.689205,
  longitude: 51.388977,
  timezone: "Asia/Tehran",
  utc_offset_seconds: 12600,
  current: {
    time: "2026-10-21T07:00",
    interval: 900,
    temperature_2m: 18.2,
    relative_humidity_2m: 41,
    apparent_temperature: 17.5,
    weather_code: 0,
    wind_speed_10m: 9.4,
  },
  daily: {
    time: ["2026-10-21", "2026-10-22", "2026-10-23"],
    weather_code: [0, 2, 61],
    temperature_2m_max: [21.3, 19.0, 16.5],
    temperature_2m_min: [12.1, 11.0, 9.8],
    precipitation_probability_max: [0, 10, 80],
  },
};

interface FakeOpts {
  geoBody?: unknown;
  forecastBody?: unknown;
  geoStatus?: number;
  forecastStatus?: number;
  /** json() throws for this leg (a parse failure). */
  jsonThrows?: "geo" | "forecast";
  /** The fetch itself rejects (a network failure). */
  throwError?: boolean;
}

function makeFakeFetch(opts: FakeOpts = {}): {
  fetchFn: WeatherFetchFn;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchFn: WeatherFetchFn = async (url: string) => {
    calls.push(url);
    if (opts.throwError === true) {
      throw new Error("network down — raw detail that must never leak");
    }
    if (url.startsWith("https://geocoding-api.open-meteo.com/")) {
      const status = opts.geoStatus ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
          if (opts.jsonThrows === "geo") throw new Error("not json");
          return opts.geoBody ?? GEO_BODY;
        },
      };
    }
    if (url.startsWith("https://api.open-meteo.com/")) {
      const status = opts.forecastStatus ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
          if (opts.jsonThrows === "forecast") throw new Error("not json");
          return opts.forecastBody ?? FORECAST_BODY;
        },
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchFn, calls };
}

async function runErr(
  tool: Tool<WeatherInput, WeatherOutput>,
  input: WeatherInput,
): Promise<ToolError> {
  try {
    await tool.run(input, ctx());
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error("expected the tool to throw");
}

// ---------------------------------------------------------------------------
// Registration / desk card
// ---------------------------------------------------------------------------

describe("weather registration", () => {
  test("is live by default: enabled, public, keyed to its permission", () => {
    expect(weatherTool.name).toBe("weather");
    expect(weatherTool.enabled).toBe(true);
    expect(weatherTool.ownerOnly).toBeFalsy();
    expect(weatherTool.permission.requires).toEqual([WEATHER_PERMISSION]);
    expect(WEATHER_PERMISSION).toBe("tools:weather");
    expect(weatherTool.manifest).toBe(weatherManifest);
  });

  test("the desk card is valid and carries the Phase-9 classes", () => {
    expect(validateManifest(weatherManifest)).toEqual([]);
    expect(weatherManifest.id).toBe("weather");
    expect(weatherManifest.category).toBe("utils");
    expect(weatherManifest.latencyTier).toBe("seconds");
    expect(weatherManifest.costTier).toBe("free");
    expect(weatherManifest.confusableWith.map((c) => c.tool)).toEqual([
      "web_search",
      "date_time",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The tool flow
// ---------------------------------------------------------------------------

describe("weather tool", () => {
  test("happy path: geocodes, forecasts, and shapes the output", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    const tool = createWeatherTool({ fetchFn });
    const out = await tool.run({ location: "Tehran" }, ctx());

    expect(out.source).toBe("Open-Meteo");
    expect(out.location).toEqual({ name: "Tehran", country: "Iran", admin1: "Tehran" });
    expect(out.timezone).toBe("Asia/Tehran");
    expect(out.current).toEqual({
      temperatureC: 18.2,
      feelsLikeC: 17.5,
      humidityPct: 41,
      windKph: 9.4,
      condition: "clear",
    });
    expect(out.daily).toEqual([
      {
        date: "2026-10-21",
        condition: "clear",
        minC: 12.1,
        maxC: 21.3,
        precipitationProbabilityPct: 0,
      },
      {
        date: "2026-10-22",
        condition: "partly cloudy",
        minC: 11.0,
        maxC: 19.0,
        precipitationProbabilityPct: 10,
      },
      {
        date: "2026-10-23",
        condition: "rain",
        minC: 9.8,
        maxC: 16.5,
        precipitationProbabilityPct: 80,
      },
    ]);

    expect(calls.length).toBe(2);
    expect(calls[0]).toContain("geocoding-api.open-meteo.com/v1/search");
    expect(calls[0]).toContain("name=Tehran");
    expect(calls[1]).toContain("api.open-meteo.com/v1/forecast");
    expect(calls[1]).toContain("latitude=35.689198");
    expect(calls[1]).toContain("longitude=51.388973");
    expect(calls[1]).toContain("forecast_days=3");
    expect(calls[1]).toContain("timezone=auto");
  });

  test("coordinates-direct path skips the geocode call", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    const tool = createWeatherTool({ fetchFn });
    const out = await tool.run({ latitude: 35.6892, longitude: 51.389 }, ctx());

    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("api.open-meteo.com/v1/forecast");
    expect(calls[0]).toContain("latitude=35.6892");
    expect(calls[0]).toContain("longitude=51.389");
    expect(out.location.name).toBe("35.69, 51.39");
    expect(out.current.condition).toBe("clear");
  });

  test("coordinates win over a location name (no geocode call)", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    const tool = createWeatherTool({ fetchFn });
    const out = await tool.run(
      { location: "Tehran", latitude: 48.8566, longitude: 2.3522 },
      ctx(),
    );
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("latitude=48.8566");
    expect(calls[0]).toContain("longitude=2.3522");
    expect(out.location.name).toBe("Tehran");
  });

  test("place not found is an honest not_found", async () => {
    for (const geoBody of [{ results: [] }, { generationtime_ms: 0.1 }]) {
      const { fetchFn } = makeFakeFetch({ geoBody });
      const tool = createWeatherTool({ fetchFn });
      const err = await runErr(tool, { location: "Nowheresville" });
      expect(err.kind).toBe("not_found");
      expect(err.message).toBe("I couldn't find that place.");
    }
  });

  test("HTTP failures collapse to one honest internal error, leaking nothing", async () => {
    const cases: FakeOpts[] = [
      { geoStatus: 500, geoBody: { error: true, reason: "raw upstream detail" } },
      { forecastStatus: 503, forecastBody: "raw upstream detail" },
      { jsonThrows: "geo" },
      { jsonThrows: "forecast" },
      { throwError: true },
      { forecastBody: { nope: true } },
    ];
    for (const opts of cases) {
      const { fetchFn } = makeFakeFetch(opts);
      const tool = createWeatherTool({ fetchFn });
      const err = await runErr(tool, { location: "Tehran" });
      expect(err.kind, JSON.stringify(opts)).toBe("internal");
      expect(err.message).toBe("Weather is unavailable right now.");
      expect(err.message).not.toContain("raw");
      expect(err.message).not.toContain("open-meteo");
    }
  });

  test("missing location and coordinates is invalid_input", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    const tool = createWeatherTool({ fetchFn });
    for (const input of [
      {},
      { location: "" },
      { location: "   " },
      { latitude: 35.6892 },
      { longitude: 51.389 },
    ] as WeatherInput[]) {
      const err = await runErr(tool, input);
      expect(err.kind, JSON.stringify(input)).toBe("invalid_input");
    }
    expect(calls.length).toBe(0);
  });

  test("out-of-range coordinates are invalid_input", async () => {
    const { fetchFn } = makeFakeFetch();
    const tool = createWeatherTool({ fetchFn });
    for (const input of [
      { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: -181 },
      { latitude: Number.NaN, longitude: 0 },
    ] as WeatherInput[]) {
      const err = await runErr(tool, input);
      expect(err.kind, JSON.stringify(input)).toBe("invalid_input");
    }
  });

  test("days is clamped into 1..7 and truncated", async () => {
    const cases: Array<{ days: number; url: string }> = [
      { days: 99, url: "forecast_days=7" },
      { days: 0, url: "forecast_days=1" },
      { days: -3, url: "forecast_days=1" },
      { days: 2.9, url: "forecast_days=2" },
      { days: 5, url: "forecast_days=5" },
    ];
    for (const c of cases) {
      const { fetchFn, calls } = makeFakeFetch();
      const tool = createWeatherTool({ fetchFn });
      await tool.run({ location: "Tehran", days: c.days }, ctx());
      expect(calls[1], `days=${c.days}`).toContain(c.url);
    }
  });
});

// ---------------------------------------------------------------------------
// WMO condition mapping
// ---------------------------------------------------------------------------

describe("weatherCondition", () => {
  test("maps the WMO table and falls back to unknown", () => {
    const table: Array<[number, string]> = [
      [0, "clear"],
      [1, "mainly clear"],
      [2, "partly cloudy"],
      [3, "overcast"],
      [45, "fog"],
      [48, "fog"],
      [51, "drizzle"],
      [53, "drizzle"],
      [55, "drizzle"],
      [56, "freezing drizzle"],
      [57, "freezing drizzle"],
      [61, "rain"],
      [63, "rain"],
      [65, "rain"],
      [66, "freezing rain"],
      [67, "freezing rain"],
      [71, "snow"],
      [73, "snow"],
      [75, "snow"],
      [77, "snow"],
      [80, "rain showers"],
      [81, "rain showers"],
      [82, "rain showers"],
      [85, "snow showers"],
      [86, "snow showers"],
      [95, "thunderstorm"],
      [96, "thunderstorm with hail"],
      [99, "thunderstorm with hail"],
      [4, "unknown"],
      [999, "unknown"],
      [-1, "unknown"],
    ];
    for (const [code, text] of table) {
      expect(weatherCondition(code), `code ${code}`).toBe(text);
    }
  });
});

// ---------------------------------------------------------------------------
// fetchWeatherLine (the digest seam's payload)
// ---------------------------------------------------------------------------

describe("fetchWeatherLine", () => {
  test("returns the one-line summary on success", async () => {
    const { fetchFn } = makeFakeFetch();
    const line = await fetchWeatherLine(fetchFn, "Tehran");
    expect(line).toBe("Tehran: 18°C, clear — today 12–21°C");
  });

  test("returns undefined on any failure", async () => {
    const failing: FakeOpts[] = [
      { throwError: true },
      { geoStatus: 500 },
      { forecastStatus: 503 },
      { geoBody: { results: [] } },
      { jsonThrows: "forecast" },
    ];
    for (const opts of failing) {
      const { fetchFn } = makeFakeFetch(opts);
      expect(await fetchWeatherLine(fetchFn, "Tehran"), JSON.stringify(opts)).toBeUndefined();
    }
    const { fetchFn } = makeFakeFetch();
    expect(await fetchWeatherLine(fetchFn, "")).toBeUndefined();
    expect(await fetchWeatherLine(fetchFn, "   ")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Digest seam (DigestDeps.weatherLine)
// ---------------------------------------------------------------------------

const WEATHER_LINE = "Tehran: 18°C, clear — today 12–21°C";

function digestDeps(over: Partial<DigestDeps> = {}): DigestDeps {
  return {
    storage: Storage.open(":memory:"),
    proposalStore: new ProposalStore(new Database(":memory:")),
    userId: OWNER,
    now: () => NOW_MS,
    ...over,
  };
}

describe("digest weather seam", () => {
  test("dep absent → output unchanged", async () => {
    const baseline = renderDigestText(await buildDigestData(digestDeps()), "en");
    const absent = renderDigestText(await buildDigestData(digestDeps({})), "en");
    expect(absent).toBe(baseline);
    expect(absent).not.toContain("Weather");
    expect(absent).not.toContain(WEATHER_LINE);
  });

  test("dep returns a line → the line appears as its own section", async () => {
    const sections = await buildDigestData(
      digestDeps({ weatherLine: async () => WEATHER_LINE }),
    );
    expect(sections[1]).toEqual({ kind: "weather", line: WEATHER_LINE });

    const text = renderDigestText(sections, "en");
    expect(text).toContain("🌤️ Weather");
    expect(text).toContain(WEATHER_LINE);
    // It sits right after the date header, before the tasks section.
    expect(text.indexOf(WEATHER_LINE)).toBeLessThan(text.indexOf("Today's tasks"));

    // The legacy API renders it too.
    const legacy = formatDigest(
      await buildDigest(digestDeps({ weatherLine: async () => WEATHER_LINE })),
    );
    expect(legacy).toContain(WEATHER_LINE);
  });

  test("dep returns undefined/empty → output byte-identical to no dep", async () => {
    const baseline = renderDigestText(await buildDigestData(digestDeps()), "en");
    for (const weatherLine of [
      async () => undefined,
      async () => "",
      async () => "   ",
    ]) {
      const text = renderDigestText(
        await buildDigestData(digestDeps({ weatherLine })),
        "en",
      );
      expect(text).toBe(baseline);
    }
  });

  test("dep throws → digest survives, output unchanged, failure logged", async () => {
    const logs: string[] = [];
    const baseline = renderDigestText(await buildDigestData(digestDeps()), "en");
    const text = renderDigestText(
      await buildDigestData(
        digestDeps({
          log: (m) => logs.push(m),
          weatherLine: async () => {
            throw new Error("weather down");
          },
        }),
      ),
      "en",
    );
    expect(text).toBe(baseline);
    expect(logs.some((m) => m.includes("weather"))).toBe(true);
  });

  test("end-to-end: fetchWeatherLine feeds the seam", async () => {
    const { fetchFn } = makeFakeFetch();
    const text = renderDigestText(
      await buildDigestData(
        digestDeps({ weatherLine: () => fetchWeatherLine(fetchFn, "Tehran") }),
      ),
      "en",
    );
    expect(text).toContain(WEATHER_LINE);
  });
});
