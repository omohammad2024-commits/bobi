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
 * card does not register. Every field of ToolManifest is required and
 * validate_manifest enforces the shapes; the registry rejects a tool
 * whose attached card is incomplete, and the boot catalog assert
 * rejects an incomplete catalog card.
 *
 * The pure manifest TYPES (ToolManifest and the tiers/confusable it is
 * built from) live in ./types next to the Tool contract (platform
 * Phase 5 — this also breaks the former types↔manifest type cycle);
 * they are re-exported below so every existing `./manifest` import
 * path keeps working. This module keeps only the runtime helper.
 */
import type { ToolManifest } from "./types";

export type {
  ToolManifest,
  ToolCostTier,
  ToolLatencyTier,
  ToolConfusable,
  ToolTriggerPatterns,
} from "./types";

/**
 * Identity helper so a manifest literal gets the full type check at its
 * definition site. Tool factories attach the card to the Tool object
 * (`manifest` field); plugins.ts catalogs the cards and the boot assert
 * checks the ids agree.
 */
export function defineManifest(manifest: ToolManifest): ToolManifest {
  return manifest;
}
