/**
 * Manifest contract validation — the lint that keeps the plugin
 * catalog honest.
 *
 * `validateManifest` returns a list of human-readable problems (empty =
 * valid) for one manifest; `validateCatalog` checks a whole set for
 * duplicate ids and id/tool-name agreement. plugins.ts runs these at
 * boot over the built-in catalog, and tests run them over the real
 * registry — a bad manifest fails loudly, never silently.
 *
 * Rules (each maps to one line a plugin author can act on):
 * - id: snake_case, starts with a letter, [a-z0-9_]+.
 * - version: semver-shaped "MAJOR.MINOR.PATCH".
 * - title: 1-80 chars.
 * - purpose: 5-40 chars (the desk catalog's one-line "what").
 * - useWhen: 5-40 chars (the desk catalog's "when to pick it up").
 * - doNotUseWhen: 5-140 chars (the anti-triggers).
 * - confusableWith: an array (possibly empty) of {tool, difference};
 *   tool is a snake_case id different from the card's own id, and
 *   difference is 5-120 chars. validateCatalog additionally requires
 *   every target to exist in the catalog.
 * - latencyTier: one of instant|seconds|minutes.
 * - description: 10-300 chars (catalog text the model reads).
 * - outputSummary: 5-150 chars.
 * - category: non-empty.
 * - timeoutMs (when present): integer in [1000, 600000] — the range the
 *   Executor already sanctions (600s exists for the media downloader).
 * - costTier (when present): one of free|cheap|heavy.
 * - triggers: every pattern is a non-empty string that compiles as a
 *   RegExp, and mimeTypes look like "type/subtype" or "type/*".
 */
import type { ToolManifest } from "./manifest";
import type { Tool } from "./types";

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/(\*|[a-z0-9][a-z0-9.+-]*)$/i;
const COST_TIERS: ReadonlySet<string> = new Set(["free", "cheap", "heavy"]);
const LATENCY_TIERS: ReadonlySet<string> = new Set(["instant", "seconds", "minutes"]);

export const CARD_PURPOSE_MIN = 5;
export const CARD_PURPOSE_MAX = 40;
export const CARD_USE_WHEN_MIN = 5;
export const CARD_USE_WHEN_MAX = 40;
export const CARD_DO_NOT_USE_MIN = 5;
export const CARD_DO_NOT_USE_MAX = 140;
export const CARD_DIFFERENCE_MIN = 5;
export const CARD_DIFFERENCE_MAX = 120;

export const MANIFEST_TIMEOUT_MIN_MS = 1_000;
export const MANIFEST_TIMEOUT_MAX_MS = 600_000;

/** Validate one manifest. Returns problem strings; [] means valid. */
export function validateManifest(manifest: ToolManifest): string[] {
  const problems: string[] = [];
  const id = typeof manifest.id === "string" ? manifest.id : "";
  const where = id.length > 0 ? `manifest "${id}"` : "manifest (missing id)";

  if (!ID_PATTERN.test(id)) {
    problems.push(`${where}: id must be snake_case ([a-z0-9_], starting with a letter).`);
  }
  if (typeof manifest.version !== "string" || !VERSION_PATTERN.test(manifest.version)) {
    problems.push(`${where}: version must look like "1.0.0".`);
  }
  if (typeof manifest.title !== "string" || manifest.title.length < 1 || manifest.title.length > 80) {
    problems.push(`${where}: title must be 1-80 characters.`);
  }
  if (
    typeof manifest.purpose !== "string" ||
    manifest.purpose.length < CARD_PURPOSE_MIN ||
    manifest.purpose.length > CARD_PURPOSE_MAX
  ) {
    problems.push(
      `${where}: purpose must be ${CARD_PURPOSE_MIN}-${CARD_PURPOSE_MAX} characters (the desk catalog's one-line "what").`,
    );
  }
  if (
    typeof manifest.useWhen !== "string" ||
    manifest.useWhen.length < CARD_USE_WHEN_MIN ||
    manifest.useWhen.length > CARD_USE_WHEN_MAX
  ) {
    problems.push(
      `${where}: useWhen must be ${CARD_USE_WHEN_MIN}-${CARD_USE_WHEN_MAX} characters (when to pick the tool up).`,
    );
  }
  if (
    typeof manifest.doNotUseWhen !== "string" ||
    manifest.doNotUseWhen.length < CARD_DO_NOT_USE_MIN ||
    manifest.doNotUseWhen.length > CARD_DO_NOT_USE_MAX
  ) {
    problems.push(
      `${where}: doNotUseWhen must be ${CARD_DO_NOT_USE_MIN}-${CARD_DO_NOT_USE_MAX} characters (the anti-triggers).`,
    );
  }
  if (!Array.isArray(manifest.confusableWith)) {
    problems.push(`${where}: confusableWith must be an array (empty when nothing is confusable).`);
  } else {
    for (const entry of manifest.confusableWith) {
      if (entry === null || typeof entry !== "object") {
        problems.push(`${where}: confusableWith entries must be {tool, difference} objects.`);
        continue;
      }
      if (typeof entry.tool !== "string" || !ID_PATTERN.test(entry.tool)) {
        problems.push(
          `${where}: confusableWith tool must be a snake_case plugin id: ${JSON.stringify(entry.tool)}`,
        );
      } else if (entry.tool === id) {
        problems.push(`${where}: confusableWith must not name the tool itself.`);
      }
      if (
        typeof entry.difference !== "string" ||
        entry.difference.length < CARD_DIFFERENCE_MIN ||
        entry.difference.length > CARD_DIFFERENCE_MAX
      ) {
        problems.push(
          `${where}: confusableWith "${String(entry.tool)}" difference must be ${CARD_DIFFERENCE_MIN}-${CARD_DIFFERENCE_MAX} characters.`,
        );
      }
    }
  }
  if (typeof manifest.latencyTier !== "string" || !LATENCY_TIERS.has(manifest.latencyTier)) {
    problems.push(`${where}: latencyTier must be one of instant|seconds|minutes.`);
  }
  if (
    typeof manifest.description !== "string" ||
    manifest.description.length < 10 ||
    manifest.description.length > 300
  ) {
    problems.push(`${where}: description must be 10-300 characters.`);
  }
  if (
    typeof manifest.outputSummary !== "string" ||
    manifest.outputSummary.length < 5 ||
    manifest.outputSummary.length > 150
  ) {
    problems.push(`${where}: outputSummary must be 5-150 characters.`);
  }
  if (typeof manifest.category !== "string" || manifest.category.length === 0) {
    problems.push(`${where}: category must not be empty.`);
  }
  if (manifest.timeoutMs !== undefined) {
    if (
      !Number.isInteger(manifest.timeoutMs) ||
      manifest.timeoutMs < MANIFEST_TIMEOUT_MIN_MS ||
      manifest.timeoutMs > MANIFEST_TIMEOUT_MAX_MS
    ) {
      problems.push(
        `${where}: timeoutMs must be an integer in [${MANIFEST_TIMEOUT_MIN_MS}, ${MANIFEST_TIMEOUT_MAX_MS}].`,
      );
    }
  }
  if (manifest.costTier !== undefined && !COST_TIERS.has(manifest.costTier)) {
    problems.push(`${where}: costTier must be one of free|cheap|heavy.`);
  }

  const triggers = manifest.triggers;
  if (triggers !== undefined) {
    for (const [kind, patterns] of [
      ["urlPatterns", triggers.urlPatterns],
      ["keywordPatterns", triggers.keywordPatterns],
    ] as const) {
      if (patterns === undefined) continue;
      for (const pattern of patterns) {
        if (typeof pattern !== "string" || pattern.length === 0) {
          problems.push(`${where}: triggers.${kind} contains an empty pattern.`);
          continue;
        }
        try {
          new RegExp(pattern, "iu");
        } catch {
          problems.push(`${where}: triggers.${kind} pattern does not compile: ${JSON.stringify(pattern)}`);
        }
      }
    }
    if (triggers.mimeTypes !== undefined) {
      for (const mime of triggers.mimeTypes) {
        if (typeof mime !== "string" || !MIME_PATTERN.test(mime)) {
          problems.push(`${where}: triggers.mimeTypes entry is not a MIME type: ${JSON.stringify(mime)}`);
        }
      }
    }
  }

  return problems;
}

/**
 * Validate a whole catalog: every manifest individually valid, ids
 * unique, and — when the matching tool instances are supplied — every
 * tool carries the manifest whose id equals its name (and vice versa:
 * every manifest names a tool in the set).
 *
 * `sources` optionally maps manifest id → defining file, so failures
 * can name the offending module (used by plugins.ts at boot).
 */
export function validateCatalog(
  manifests: readonly ToolManifest[],
  tools?: readonly Tool<unknown, unknown>[],
  sources?: ReadonlyMap<string, string>,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const manifest of manifests) {
    problems.push(...validateManifest(manifest));
    if (seen.has(manifest.id)) {
      const from = sources?.get(manifest.id);
      problems.push(
        `manifest "${manifest.id}": duplicate plugin id${from !== undefined ? ` (declared in ${from})` : ""}.`,
      );
    }
    seen.add(manifest.id);
  }

  // Desk-card cross-references: a confusableWith target that is not on
  // the desk would send the model (and the owner) chasing a ghost tool.
  for (const manifest of manifests) {
    if (!Array.isArray(manifest.confusableWith)) continue;
    for (const entry of manifest.confusableWith) {
      if (entry !== null && typeof entry === "object" && typeof entry.tool === "string" && !seen.has(entry.tool)) {
        problems.push(
          `manifest "${manifest.id}": confusableWith names unknown tool "${entry.tool}".`,
        );
      }
    }
  }

  if (tools !== undefined) {
    const byId = new Map(manifests.map((m) => [m.id, m]));
    for (const tool of tools) {
      const manifest = byId.get(tool.name);
      if (manifest === undefined) {
        problems.push(`tool "${tool.name}": no manifest in the plugin catalog.`);
        continue;
      }
      if (tool.manifest === undefined) {
        problems.push(`tool "${tool.name}": instance does not carry its manifest.`);
      } else if (tool.manifest.id !== tool.name) {
        problems.push(
          `tool "${tool.name}": attached manifest id "${tool.manifest.id}" does not match the tool name.`,
        );
      }
      if (manifest.timeoutMs !== undefined && tool.timeoutMs !== undefined && manifest.timeoutMs !== tool.timeoutMs) {
        problems.push(
          `tool "${tool.name}": manifest timeoutMs (${manifest.timeoutMs}) disagrees with the tool's timeoutMs (${tool.timeoutMs}).`,
        );
      }
    }
  }

  return problems;
}
