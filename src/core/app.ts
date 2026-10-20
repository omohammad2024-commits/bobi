import { readFileSync } from "node:fs";

export const APP_NAME = "BOBI";

/**
 * The app version — package.json is the single source of truth (read once
 * at module load, same pattern as the /version command in index.ts). The
 * fallback only fires if package.json is somehow unreadable (e.g. a source
 * tree copied without it), so /health never reports an empty version.
 */
export const APP_VERSION: string = (() => {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : "0.0.1";
  } catch {
    return "0.0.1";
  }
})();

/** Returns a human-readable status line for the running foundation. */
export function bootstrapMessage(): string {
  return `${APP_NAME} foundation ready`;
}
