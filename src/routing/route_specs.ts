/**
 * Intent-router application for the agent turn (core-upgrade wiring).
 *
 * The router itself (`detectIntents`, see INTEGRATION.md) only SUGGESTS
 * tools; this module applies a suggestion to the tool specs the model
 * sees. It is deliberately advisory-only:
 *
 * - Any usable hints (weak or strong): the FULL input spec set is
 *   returned, with hinted tools' specs moved first (stable order
 *   otherwise), plus a one-line note from the top usable hint.
 * - No hints (or router off): specs returned untouched, same order.
 *
 * Routing reorders + advises, NEVER removes. No tool is hidden: a
 * regex misfire must never make a tool unrecoverable in-turn, so the
 * model always sees every spec it was offered.
 *
 * SECURITY: this is an ergonomics optimization, never a permission
 * boundary. Hints are intersected with the offered specs — a hint for a
 * tool the actor may not run (already filtered out of the specs by
 * ToolService) is dropped, and the Executor enforces permissions on every
 * actual call.
 *
 * Kill switch: BOBI_INTENT_ROUTER=0 makes detectIntents return [] and
 * this function becomes the identity (specs and order unchanged, no note).
 *
 * The manifest catalog arrives as a PARAMETER (fetched by the caller via
 * ToolService.pluginCatalog), never a barrel import: this module is
 * imported by the conversation engine, which evaluates before
 * tools/service.ts, and importing tools/plugins here would re-enter
 * service.ts mid-evaluation of the barrel (delegate → service cycle) and
 * crash the process at startup.
 */
import type { ToolSpec } from "../ai/provider";
import type { ToolManifest } from "../tools/manifest";
import { detectIntents, type IntentHint } from "./intent";

/** Cap for the rendered router note, so it stays a nudge, not a section. */
const ROUTER_NOTE_MAX_CHARS = 120;

export interface RoutedSpecs {
  /** The specs the model should see this turn. */
  specs: ToolSpec[];
  /** One-line system note with pre-extracted args, when a hint had any. */
  note?: string;
}

/** Render one extracted-args note from the top hint, ≤ a short line. */
function routerNote(hint: IntentHint): string | undefined {
  const pairs = Object.entries(hint.extractedArgs).map(([k, v]) => {
    const raw = typeof v === "string" ? v : JSON.stringify(v) ?? "";
    const clipped = raw.length > 60 ? `${raw.slice(0, 57)}…` : raw;
    return `${k}=${clipped}`;
  });
  const args = pairs.join(", ");
  const note = args.length > 0
    ? `[router] suggested: ${hint.toolId}(${args})`
    : `[router] suggested: ${hint.toolId}`;
  return note.length > ROUTER_NOTE_MAX_CHARS
    ? note.slice(0, ROUTER_NOTE_MAX_CHARS - 1) + "…"
    : note;
}

/**
 * Apply router hints to the actor-filtered tool specs.
 *
 * Pure: hints are intersected against `specs` (the caller's
 * ToolService.toolSpecsFor output), so only offered tools can be
 * reordered. The full spec set is always returned — routing never
 * removes a spec. Router failures can never break the turn —
 * any exception falls back to the untouched specs.
 */
export function applyIntentRouting(
  specs: readonly ToolSpec[],
  userText: string,
  catalog: readonly ToolManifest[],
): RoutedSpecs {
  const base = [...specs];
  if (userText.trim().length === 0) return { specs: base };

  let hints: IntentHint[];
  try {
    hints = detectIntents(userText, catalog);
  } catch {
    return { specs: base };
  }
  if (hints.length === 0) return { specs: base };

  const offered = new Set(base.map((s) => s.name));
  const usable = hints.filter((h) => offered.has(h.toolId));
  if (usable.length === 0) return { specs: base };

  const note =
    usable[0] !== undefined ? routerNote(usable[0]) : undefined;
  const withNote = (specList: ToolSpec[]): RoutedSpecs =>
    note !== undefined ? { specs: specList, note } : { specs: specList };

  // Advisory only: full catalog, hinted tools first (stable order otherwise).
  const priority = new Map<string, number>();
  usable.forEach((h, i) => {
    if (!priority.has(h.toolId)) priority.set(h.toolId, i);
  });
  const ordered = [...base].sort((a, b) => {
    const pa = priority.get(a.name) ?? -1;
    const pb = priority.get(b.name) ?? -1;
    if (pa === pb) return 0; // both unhinted (or same hint): keep input order
    if (pa === -1) return 1; // unhinted sink below hinted
    if (pb === -1) return -1;
    return pa - pb;
  });
  return withNote(ordered);
}
