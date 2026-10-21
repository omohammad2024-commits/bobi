/**
 * weather — current conditions and a short daily forecast for a place,
 * from Open-Meteo.
 *
 * Open-Meteo is KEYLESS: no API key, no account, no configuration. This
 * tool is therefore live by default — it must never be gated as
 * "unconfigured" the way a keyed provider would be.
 *
 * Flow (two plain HTTPS GETs, both against public Open-Meteo hosts):
 *   1. Geocode the place name (skipped when the caller supplies
 *      coordinates — coordinates win over the name).
 *   2. Fetch the forecast for the resolved latitude/longitude.
 *
 * Errors are honest and leak nothing: a missing place/coords is the
 * caller's `invalid_input`, an unknown place is `not_found`, and every
 * HTTP or parse failure collapses to one `internal` message — raw
 * upstream bodies are never quoted back.
 *
 * The HTTP seam is injectable (`createWeatherTool({ fetchFn })`) so
 * tests run against fixtures in the real Open-Meteo shapes with no
 * network. The default is the global fetch.
 */
import { ToolError } from "./errors";
import type { Tool, ToolContext } from "./types";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";

export const WEATHER_PERMISSION = "tools:weather";

/**
 * Minimal structural fetch the weather flow needs. The global fetch
 * satisfies it; tests inject a fake returning fixtures.
 */
export type WeatherFetchFn = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface WeatherToolDeps {
  /** HTTP implementation. Defaults to the global fetch. */
  fetchFn?: WeatherFetchFn;
}

export interface WeatherInput {
  /** City/place name, e.g. "Tehran". Either this or coordinates. */
  location?: string;
  /** Latitude in degrees (-90..90). Wins over `location` when given. */
  latitude?: number;
  /** Longitude in degrees (-180..180). Must accompany `latitude`. */
  longitude?: number;
  /** Forecast days, 1-7 (clamped). Defaults to 3. */
  days?: number;
}

export interface WeatherLocation {
  name: string;
  country: string;
  admin1?: string;
}

export interface WeatherCurrent {
  temperatureC: number;
  feelsLikeC: number;
  humidityPct: number;
  windKph: number;
  condition: string;
}

export interface WeatherDaily {
  date: string;
  condition: string;
  minC: number;
  maxC: number;
  precipitationProbabilityPct?: number;
}

export interface WeatherOutput {
  location: WeatherLocation;
  timezone: string;
  current: WeatherCurrent;
  daily: WeatherDaily[];
  source: "Open-Meteo";
}

const DEFAULT_DAYS = 3;
const MIN_DAYS = 1;
const MAX_DAYS = 7;

/**
 * Hard cap on the digest weather line's fetches. `fetchWeatherLine`
 * otherwise passes no signal, so a hung Open-Meteo response would
 * stall digest generation until some outer deadline fired.
 */
export const WEATHER_FETCH_TIMEOUT_MS = 10_000;

const UNAVAILABLE = "Weather is unavailable right now.";

export const weatherManifest: ToolManifest = defineManifest({
  id: "weather",
  version: "1.0.0",
  title: "Weather",
  description:
    "Current weather and daily forecast for a place by name or coordinates, from Open-Meteo (no key needed).",
  purpose: "current weather + forecast",
  useWhen: "weather/forecast asked",
  doNotUseWhen:
    "News or general web info — web_search searches the web; a date/time question alone is date_time.",
  confusableWith: [
    {
      tool: "web_search",
      difference:
        "web_search is for news/pages; this returns structured weather for a place",
    },
    {
      tool: "date_time",
      difference: "date_time computes dates; this reports conditions/forecast",
    },
  ],
  latencyTier: "seconds",
  outputSummary:
    "Location, timezone, current conditions and a daily forecast.",
  category: "utils",
  triggers: {
    keywordPatterns: [
      "weather",
      "forecast",
      "هوا",
      "آب‌وهوا",
      "بارون",
      "دما",
      "what(?:'s| is) the weather",
      "will it rain",
    ],
  },
  costTier: "free",
});

/** WMO weather code → short English condition text. Unknown → "unknown". */
export function weatherCondition(code: number): string {
  switch (code) {
    case 0:
      return "clear";
    case 1:
      return "mainly clear";
    case 2:
      return "partly cloudy";
    case 3:
      return "overcast";
    case 45:
    case 48:
      return "fog";
    case 51:
    case 53:
    case 55:
      return "drizzle";
    case 56:
    case 57:
      return "freezing drizzle";
    case 61:
    case 63:
    case 65:
      return "rain";
    case 66:
    case 67:
      return "freezing rain";
    case 71:
    case 73:
    case 75:
    case 77:
      return "snow";
    case 80:
    case 81:
    case 82:
      return "rain showers";
    case 85:
    case 86:
      return "snow showers";
    case 95:
      return "thunderstorm";
    case 96:
    case 99:
      return "thunderstorm with hail";
    default:
      return "unknown";
  }
}

function clampDays(raw: number | undefined): number {
  if (raw === undefined || typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_DAYS;
  }
  const n = Math.trunc(raw);
  if (n < MIN_DAYS) return MIN_DAYS;
  return n > MAX_DAYS ? MAX_DAYS : n;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * One JSON GET, with every transport/HTTP/parse failure collapsed to the
 * single honest `internal` error. Raw bodies are never read, let alone
 * quoted — there is nothing in them the model (or user) should see.
 */
async function fetchJson(
  fetchFn: WeatherFetchFn,
  url: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  let res: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    res = await fetchFn(url, signal !== undefined ? { signal } : undefined);
  } catch {
    throw new ToolError("internal", UNAVAILABLE);
  }
  if (!isRecord(res) || typeof res.ok !== "boolean" || !res.ok) {
    throw new ToolError("internal", UNAVAILABLE);
  }
  try {
    return await res.json();
  } catch {
    throw new ToolError("internal", UNAVAILABLE);
  }
}

interface ResolvedPlace {
  latitude: number;
  longitude: number;
  location: WeatherLocation;
}

/** Geocode a place name to its first Open-Meteo match. */
async function geocode(
  fetchFn: WeatherFetchFn,
  name: string,
  signal: AbortSignal | undefined,
): Promise<ResolvedPlace> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en`;
  const data = await fetchJson(fetchFn, url, signal);
  const results = isRecord(data) ? data["results"] : undefined;
  if (!Array.isArray(results) || results.length === 0) {
    throw new ToolError("not_found", "I couldn't find that place.");
  }
  const first: unknown = results[0];
  if (!isRecord(first)) throw new ToolError("internal", UNAVAILABLE);
  const latitude = num(first["latitude"]);
  const longitude = num(first["longitude"]);
  if (latitude === undefined || longitude === undefined) {
    throw new ToolError("internal", UNAVAILABLE);
  }
  const admin1 = str(first["admin1"]);
  return {
    latitude,
    longitude,
    location: {
      name: str(first["name"]) ?? name,
      country: str(first["country"]) ?? "",
      ...(admin1 !== undefined ? { admin1 } : {}),
    },
  };
}

/** The core flow, shared by the tool body and `fetchWeatherLine`. */
async function getWeather(
  fetchFn: WeatherFetchFn,
  input: WeatherInput,
  signal: AbortSignal | undefined,
): Promise<WeatherOutput> {
  const raw = (input ?? {}) as unknown as Record<string, unknown>;

  const locationRaw = raw["location"];
  if (locationRaw !== undefined && typeof locationRaw !== "string") {
    throw new ToolError("invalid_input", "Provide a location name or latitude and longitude.");
  }
  const location =
    typeof locationRaw === "string" && locationRaw.trim().length > 0
      ? locationRaw.trim()
      : undefined;

  const latRaw = raw["latitude"];
  const lonRaw = raw["longitude"];
  const hasLat = latRaw !== undefined;
  const hasLon = lonRaw !== undefined;
  if (hasLat !== hasLon) {
    throw new ToolError(
      "invalid_input",
      "Provide both latitude and longitude, or a location name.",
    );
  }

  let place: ResolvedPlace;
  if (hasLat && hasLon) {
    // Coordinates win over the name — and skip the geocode call entirely.
    const latitude = num(latRaw);
    const longitude = num(lonRaw);
    if (
      latitude === undefined ||
      longitude === undefined ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new ToolError("invalid_input", "Invalid latitude or longitude.");
    }
    place = {
      latitude,
      longitude,
      location: {
        name: location ?? `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`,
        country: "",
      },
    };
  } else if (location !== undefined) {
    place = await geocode(fetchFn, location, signal);
  } else {
    throw new ToolError(
      "invalid_input",
      "Provide a location name or latitude and longitude.",
    );
  }

  const days = clampDays(
    typeof raw["days"] === "number" ? raw["days"] : undefined,
  );
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&forecast_days=${days}&timezone=auto`;
  const data = await fetchJson(fetchFn, url, signal);
  if (!isRecord(data)) throw new ToolError("internal", UNAVAILABLE);

  const timezone = str(data["timezone"]) ?? "UTC";

  const currentRaw = data["current"];
  if (!isRecord(currentRaw)) throw new ToolError("internal", UNAVAILABLE);
  const temperatureC = num(currentRaw["temperature_2m"]);
  const feelsLikeC = num(currentRaw["apparent_temperature"]);
  const humidityPct = num(currentRaw["relative_humidity_2m"]);
  const windKph = num(currentRaw["wind_speed_10m"]);
  const currentCode = num(currentRaw["weather_code"]);
  if (
    temperatureC === undefined ||
    feelsLikeC === undefined ||
    humidityPct === undefined ||
    windKph === undefined ||
    currentCode === undefined
  ) {
    throw new ToolError("internal", UNAVAILABLE);
  }

  const dailyRaw = data["daily"];
  if (!isRecord(dailyRaw)) throw new ToolError("internal", UNAVAILABLE);
  const dates = dailyRaw["time"];
  const codes = dailyRaw["weather_code"];
  const maxes = dailyRaw["temperature_2m_max"];
  const mins = dailyRaw["temperature_2m_min"];
  const precips = dailyRaw["precipitation_probability_max"];
  if (
    !Array.isArray(dates) ||
    !Array.isArray(codes) ||
    !Array.isArray(maxes) ||
    !Array.isArray(mins)
  ) {
    throw new ToolError("internal", UNAVAILABLE);
  }
  const daily: WeatherDaily[] = [];
  for (let i = 0; i < dates.length; i++) {
    const date = str(dates[i]);
    const code = num(codes[i]);
    const maxC = num(maxes[i]);
    const minC = num(mins[i]);
    // A malformed day is skipped, never guessed at.
    if (date === undefined || code === undefined || maxC === undefined || minC === undefined) {
      continue;
    }
    const precip = Array.isArray(precips) ? num(precips[i]) : undefined;
    daily.push({
      date,
      condition: weatherCondition(code),
      minC,
      maxC,
      ...(precip !== undefined ? { precipitationProbabilityPct: precip } : {}),
    });
  }

  return {
    location: place.location,
    timezone,
    current: {
      temperatureC,
      feelsLikeC,
      humidityPct,
      windKph,
      condition: weatherCondition(currentCode),
    },
    daily,
    source: "Open-Meteo",
  };
}

/**
 * Build the weather tool. Live by default (Open-Meteo needs no key);
 * pass a fake `fetchFn` in tests.
 */
export function createWeatherTool(
  deps: WeatherToolDeps = {},
): Tool<WeatherInput, WeatherOutput> {
  const fetchFn: WeatherFetchFn =
    deps.fetchFn ?? (globalThis.fetch as unknown as WeatherFetchFn);
  return {
    name: "weather",
    manifest: weatherManifest,
    description:
      "Current weather and daily forecast for a place by name or coordinates, from Open-Meteo (no key needed).",
    enabled: true,
    permission: { requires: [WEATHER_PERMISSION] },
    toolset: "utils",
    input: {
      fields: {
        location: {
          type: "string",
          description: "City or place name, e.g. \"Tehran\". Either this or latitude/longitude.",
          maxLength: 200,
        },
        latitude: {
          type: "number",
          description: "Latitude in degrees. Wins over location; requires longitude.",
          minimum: -90,
          maximum: 90,
        },
        longitude: {
          type: "number",
          description: "Longitude in degrees. Wins over location; requires latitude.",
          minimum: -180,
          maximum: 180,
        },
        days: {
          type: "integer",
          description: `Forecast days (${MIN_DAYS} to ${MAX_DAYS}, default ${DEFAULT_DAYS}).`,
          minimum: MIN_DAYS,
          maximum: MAX_DAYS,
        },
      },
    },

    async run(input: WeatherInput, ctx: ToolContext): Promise<WeatherOutput> {
      return getWeather(fetchFn, input, ctx.signal);
    },
  };
}

/** The default instance, on the global fetch. */
export const weatherTool: Tool<WeatherInput, WeatherOutput> = createWeatherTool();

/**
 * One-line human weather summary for the morning digest, e.g.
 * "Tehran: 18°C, clear — today 12–21°C".
 *
 * Fully defensive by contract: ANY failure (bad place, HTTP error,
 * parse failure, empty location) resolves to `undefined`, so the
 * digest can never break because the weather did.
 */
export async function fetchWeatherLine(
  fetchFn: WeatherFetchFn | undefined | null,
  location: string,
  timeoutMs: number = WEATHER_FETCH_TIMEOUT_MS,
): Promise<string | undefined> {
  try {
    if (typeof location !== "string" || location.trim().length === 0) {
      return undefined;
    }
    const fn: WeatherFetchFn =
      fetchFn ?? (globalThis.fetch as unknown as WeatherFetchFn);
    if (typeof fn !== "function") return undefined;
    const out = await getWeather(
      fn,
      { location: location.trim(), days: 1 },
      AbortSignal.timeout(timeoutMs),
    );
    const head = `${out.location.name}: ${Math.round(out.current.temperatureC)}°C, ${out.current.condition}`;
    const today: WeatherDaily | undefined = out.daily[0];
    if (today === undefined) return head;
    return `${head} — today ${Math.round(today.minC)}–${Math.round(today.maxC)}°C`;
  } catch {
    return undefined;
  }
}
