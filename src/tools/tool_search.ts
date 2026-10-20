/**
 * tool_search — dynamic tool discovery (Phase E4, Hermes parity).
 *
 * When the tool catalog grows beyond what fits comfortably in the prompt,
 * the model can ask this tool to find a tool by keyword and then call it by
 * name. The ranking mirrors the skills search scoring style (name hits beat
 * everything, toolset beats description), and tokenization is shared with it
 * so Persian queries behave the same way in both searches.
 *
 * SECURITY MODEL
 * - This tool reveals only what the actor may already see: name, description,
 *   toolset, and the declarative input schema — the same fields `toolSpecsFor`
 *   hands the model for listed tools. No permissions, no internals.
 * - It searches ONLY the actor's visible set, handed in through deps as a
 *   pre-filtered list (enabled + permitted + active toolsets). The factory
 *   takes a `(actor) => VisibleToolInfo[]` viewer, never the raw registry —
 *   in production the wiring passes
 *   `(actor) => toolService.searchableTools(actor)`, which applies the exact
 *   same filter as `toolSpecsFor`, including the authorization bridge's
 *   ownerOnly withholding. A non-owner therefore cannot discover that
 *   ownerOnly tools exist, because they never appear in their visible set.
 * - The tool itself is NOT ownerOnly: any actor who holds
 *   `tools:tool_search` may discover the tools they are allowed to use.
 */
import type { FieldType, Tool, ToolActor, ToolContext } from "./types";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";
import { tokenize } from "../skills/search";

/** Permission key that gates this tool. Granted like any other tool key. */
export const TOOL_SEARCH_PERMISSION = "tools:tool_search";

/** Name under which the tool registers. */
export const TOOL_SEARCH_TOOL_NAME = "tool_search";

export const TOOL_SEARCH_DEFAULT_LIMIT = 5;
export const TOOL_SEARCH_MAX_LIMIT = 10;
export const TOOL_SEARCH_MAX_QUERY = 200;

/**
 * One tool the actor may see. Built by the wiring from the actor-filtered
 * service view — NOT from the raw registry.
 */
export interface VisibleToolInfo {
  /** Unique tool name, as the model would call it. */
  name: string;
  /** One-line description. */
  description: string;
  /** Toolset the tool belongs to, if it declares one. */
  toolset?: string;
  /** Declarative input fields, derived from the tool's validated spec. */
  fields: ReadonlyArray<{
    name: string;
    type: FieldType;
    required: boolean;
  }>;
}

export interface ToolSearchDeps {
  /**
   * Tools visible to a given actor, already filtered (enabled, permitted,
   * active toolsets). SECURITY: wire the actor-filtered view here — passing
   * the raw registry would leak ownerOnly tools' existence to non-owners.
   */
  visibleTools: (actor: ToolActor) => readonly VisibleToolInfo[];
}

/** Validated input. `limit` is capped; defaults apply in run(). */
export interface ToolSearchInput {
  query: string;
  limit?: number;
}

export interface ToolSearchHitField {
  name: string;
  type: FieldType;
  required: boolean;
}

export interface ToolSearchHit {
  name: string;
  description: string;
  toolset?: string;
  /** Enough of the input schema for the model to call the tool by name. */
  inputFields: ToolSearchHitField[];
}

export interface ToolSearchOutput {
  results: ToolSearchHit[];
}

// Same scoring style as skills search: an exact name hit beats a toolset hit
// beats a description hit. Scores are ranking weights only, not probabilities.
const SCORE_NAME_HIT = 100;
const SCORE_TOOLSET_HIT = 40;
const SCORE_DESCRIPTION_HIT = 20;

/**
 * Rank visible tools against a query. Pure: scoring only, no I/O. Returns at
 * most `limit` tools with a positive score, best first, ties broken by name
 * for determinism.
 */
export function searchVisibleTools(
  tools: readonly VisibleToolInfo[],
  query: string,
  limit: number = TOOL_SEARCH_DEFAULT_LIMIT,
): ToolSearchHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0 || limit <= 0) return [];

  const scored: Array<{ tool: VisibleToolInfo; score: number }> = [];
  for (const tool of tools) {
    const score = scoreTool(tool, tokens);
    if (score > 0) scored.push({ tool, score });
  }
  scored.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : a.tool.name < b.tool.name
        ? -1
        : a.tool.name > b.tool.name
          ? 1
          : 0,
  );
  return scored.slice(0, limit).map(({ tool }) => ({
    name: tool.name,
    description: tool.description,
    // exactOptionalPropertyTypes: omit the key rather than pass undefined.
    ...(tool.toolset !== undefined ? { toolset: tool.toolset } : {}),
    inputFields: tool.fields.map((f) => ({
      name: f.name,
      type: f.type,
      required: f.required,
    })),
  }));
}

function scoreTool(tool: VisibleToolInfo, tokens: string[]): number {
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  const toolset = (tool.toolset ?? "").toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (token.length < 2 && tokens.length > 1) continue; // one-char noise
    if (name.includes(token)) score += SCORE_NAME_HIT;
    if (toolset.length > 0 && toolset.includes(token)) score += SCORE_TOOLSET_HIT;
    if (description.includes(token)) score += SCORE_DESCRIPTION_HIT;
  }
  return score;
}

/** Build the tool_search tool. Not ownerOnly: approved users may discover. */
/** Plugin discovery manifest for `tool_search`. */
export const toolSearchManifest: ToolManifest = defineManifest({
  id: "tool_search",
  version: "1.0.0",
  title: "Tool Search",
  description: "Search tools by keyword; when the tool you need is not in the main list, find its name, description and inputs, then call it by name.",
  outputSummary: "Returns matching tools: name, description, toolset and input schema.",
  category: "system",
  costTier: "cheap",
});

export function createToolSearchTool(
  deps: ToolSearchDeps,
): Tool<ToolSearchInput, ToolSearchOutput> {
  return {
    name: TOOL_SEARCH_TOOL_NAME,
    manifest: toolSearchManifest,
    description:
      "Search tools by keyword; when the tool you need is not in the main list, find its name, description and inputs, then call it by name.",
    enabled: true,
    permission: { requires: [TOOL_SEARCH_PERMISSION] },
    toolset: "system",
    input: {
      fields: {
        query: {
          type: "string",
          required: true,
          description: "Search word or phrase, e.g. \"reminder\" or \"image\".",
          minLength: 1,
          maxLength: TOOL_SEARCH_MAX_QUERY,
        },
        limit: {
          type: "integer",
          required: false,
          description: "Maximum number of results (default 5).",
          minimum: 1,
          maximum: TOOL_SEARCH_MAX_LIMIT,
        },
      },
    },

    async run(
      input: ToolSearchInput,
      ctx: ToolContext,
    ): Promise<ToolSearchOutput> {
      // The actor is already authorized by the Executor (permission check);
      // the viewer it consults is the actor-filtered set, so this search can
      // never surface a tool the actor may not call.
      const visible = deps.visibleTools(ctx.actor);
      const results = searchVisibleTools(
        visible,
        input.query,
        input.limit ?? TOOL_SEARCH_DEFAULT_LIMIT,
      );
      return { results };
    },
  };
}
