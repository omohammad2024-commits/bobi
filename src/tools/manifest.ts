/**
 * Tool plugin manifest — the discovery contract for every BOBI tool.
 *
 * Architecture rule (owner directive, Oct 2026): tools are independent
 * plugins. The AI core knows NOTHING about a tool's internals; it only ever
 * sees (a) the execution contract on the Tool object (name, input spec,
 * permissions, run) and (b) this manifest — the declarative discovery
 * metadata the intent router and catalogs rank on.
 *
 * What lives here vs. on the Tool object:
 * - The Tool object is the EXECUTION contract and the single source of
 *   truth for input schema, permissions, enabled state and timeout —
 *   those fields are deliberately NOT duplicated into the manifest,
 *   because two copies of an executable field always drift apart.
 * - The manifest is the DISCOVERY contract: stable identity, catalog
 *   text, deterministic intent triggers, and a cost tier a router can
 *   weigh without running anything.
 *
 * A manifest's `id` MUST equal the Tool's registered `name`. BOBI tool
 * names are snake_case by the Tool contract (see types.ts), so manifest
 * ids are snake_case too — one identifier space, no mapping table.
 */
import type { ToolTriggerPatterns } from "./types";

export type { ToolTriggerPatterns };

/** Relative execution cost, for routing preference. */
export type ToolCostTier = "free" | "cheap" | "heavy";

/**
 * Declarative discovery metadata for one tool.
 *
 * Pure data: a manifest must never contain functions, class instances,
 * or anything that would make importing it side-effectful. Every tool
 * module exports its manifest as a top-level const next to the tool.
 */
export interface ToolManifest {
  /** Plugin id — exactly the Tool's registered name (snake_case). */
  readonly id: string;
  /** Contract version of the plugin, semver-shaped ("1.0.0"). */
  readonly version: string;
  /** Short display title for menus and catalogs. */
  readonly title: string;
  /**
   * 1-2 lines for the model's tool catalog and for router ranking.
   * 10-300 chars (enforced by validate_manifest).
   */
  readonly description: string;
  /** One line: what a successful run returns (5-150 chars). */
  readonly outputSummary: string;
  /**
   * Grouping for catalogs and routing. Follows the toolset vocabulary
   * where one exists ("utils", "web", "media", "memory", "schedule",
   * "agents", "system"); free-form otherwise.
   */
  readonly category: string;
  /** Deterministic intent triggers consumed by src/routing/intent.ts. */
  readonly triggers?: ToolTriggerPatterns;
  /**
   * Declared execution budget for this plugin, ms — mirrors the Tool's
   * own timeoutMs when the tool declares one (range [1000, 600000],
   * enforced by validate_manifest). Omitted = executor default.
   */
  readonly timeoutMs?: number;
  /** Relative cost tier. Omitted = "free". */
  readonly costTier?: ToolCostTier;
}

/**
 * Identity helper so a manifest literal gets the full type check at its
 * definition site. attachManifest() in plugins.ts pairs manifests with
 * tool instances and asserts the ids agree.
 */
export function defineManifest(manifest: ToolManifest): ToolManifest {
  return manifest;
}
