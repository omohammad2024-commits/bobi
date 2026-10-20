/**
 * Tool plugin manifest — the DESK CARD every BOBI tool carries.
 *
 * Architecture rule (owner directive, Oct 2026): BOBI is a platform and
 * tools are independent plugins laid out on a desk (میز ابزار); the model
 * mounts on top and picks tools up by their cards. The AI core knows
 * NOTHING about a tool's internals; it only ever sees (a) the execution
 * contract on the Tool object (name, input spec, permissions, run) and
 * (b) this card — the declarative metadata the prompt catalog, the
 * intent router and the miniapp all read. One card, one source: the
 * prompt's one-line catalog entry, the router's hints and the owner's
 * desk view are all rendered from these fields, never re-typed.
 *
 * What lives here vs. on the Tool object:
 * - The Tool object is the EXECUTION contract and the single source of
 *   truth for input schema, permissions, enabled state and timeout —
 *   those fields are deliberately NOT duplicated into the card,
 *   because two copies of an executable field always drift apart.
 *   (The card's `needs` from the roadmap is exactly the Tool's input
 *   spec; `returns` is the card's `outputSummary` below.)
 * - The card is the DISCOVERY contract: stable identity, the compact
 *   purpose + when-to-use lines the model reads in the prompt, the
 *   anti-triggers and confusables that keep tool selection honest,
 *   deterministic intent triggers, and cost/latency classes a router
 *   can weigh without running anything.
 *
 * A manifest's `id` MUST equal the Tool's registered `name`. BOBI tool
 * names are snake_case by the Tool contract (see types.ts), so manifest
 * ids are snake_case too — one identifier space, no mapping table.
 *
 * Registration contract (platform Phase 1): a tool WITHOUT a complete
 * card does not register. Every field below is required and
 * validate_manifest enforces the shapes; the registry rejects a tool
 * whose attached card is incomplete, and the boot catalog assert
 * rejects an incomplete catalog card.
 */
import type { ToolTriggerPatterns } from "./types";

export type { ToolTriggerPatterns };

/** Relative execution cost, for routing preference. */
export type ToolCostTier = "free" | "cheap" | "heavy";

/**
 * How long a run typically takes, in the roadmap's three classes:
 * "instant" = local work, no network or model call; "seconds" = one
 * remote call or a short model call; "minutes" = downloads, media
 * generation, multi-model consults and other long jobs.
 */
export type ToolLatencyTier = "instant" | "seconds" | "minutes";

/** One tool this card is easily confused with, and the difference. */
export interface ToolConfusable {
  /** Plugin id of the confusable tool (must exist in the catalog). */
  readonly tool: string;
  /** One short clause: how the two differ / which one wins when. */
  readonly difference: string;
}

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
   * The card's one-line "what": a telegraphic noun phrase for the
   * prompt's desk catalog (e.g. "media file from a link"). 5-40 chars
   * (enforced by validate_manifest) — the catalog prints one line per
   * tool, so this is written for that line, not for prose.
   */
  readonly purpose: string;
  /**
   * When to pick this tool up, short form (e.g. "media link + a
   * download/get verb"). Printed next to `purpose` in the prompt
   * catalog. 5-40 chars (enforced by validate_manifest).
   */
  readonly useWhen: string;
  /**
   * When NOT to pick this tool up — the anti-triggers (e.g. "user only
   * wants the page text — that is fetch_url"). 5-140 chars (enforced
   * by validate_manifest). Read by the model via tool_search/desk
   * views and by humans auditing the desk; never a gate.
   */
  readonly doNotUseWhen: string;
  /**
   * Tools this one is confused with, each with the difference that
   * separates them. May be empty when nothing is confusable. Targets
   * must be real catalog ids (enforced by validateCatalog).
   */
  readonly confusableWith: readonly ToolConfusable[];
  /** Typical run duration class (see ToolLatencyTier). */
  readonly latencyTier: ToolLatencyTier;
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
 * definition site. Tool factories attach the card to the Tool object
 * (`manifest` field); plugins.ts catalogs the cards and the boot assert
 * checks the ids agree.
 */
export function defineManifest(manifest: ToolManifest): ToolManifest {
  return manifest;
}
