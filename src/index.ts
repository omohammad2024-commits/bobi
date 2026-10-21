/**
 * Thin Telegram starter: load config → build the platform once
 * (src/bootstrap.ts) → start the Telegram surface. All construction and
 * all starting logic live in the bootstrap / platform facades.
 */
import { loadConfig } from "./config/config";
import { processEnv, readNamed } from "./config/env";
import { formatConfigProblems, validateEnv } from "./config/validate";
import { buildPlatform, startTelegramSurface } from "./bootstrap";

async function main(): Promise<void> {
  // Phase 7: typed knobs are validated before anything is built. Problems
  // are LOUD (stderr) but non-fatal by default — consumers keep their
  // documented clamp/fallback semantics. BOBI_CONFIG_STRICT=1 makes an
  // invalid typed value a hard boot failure.
  const problems = validateEnv(processEnv());
  if (problems.length > 0) {
    console.error(formatConfigProblems(problems));
    if (readNamed(processEnv(), "BOBI_CONFIG_STRICT") === "1") {
      throw new Error(
        `invalid configuration (${problems.length} problem(s)); BOBI_CONFIG_STRICT=1 refuses to boot`,
      );
    }
  }
  const config = loadConfig();
  const platform = await buildPlatform(config);
  // Undefined = the fail-closed owner gate already reported the reason
  // to stderr and set process.exitCode — exactly as before.
  if (platform === undefined) return;
  await startTelegramSurface(platform);
}

main().catch((err: unknown) => {
  // Short, non-secret error — never print config/token.
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`startup failed: ${msg}`);
  process.exitCode = 1;
});
