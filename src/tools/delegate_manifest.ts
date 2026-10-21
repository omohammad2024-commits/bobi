/**
 * delegate manifest — pure-data leaf.
 *
 * Extracted from delegate.ts to break the tools import cycle
 * (service.ts -> plugins.ts -> delegate.ts -> service.ts): plugins.ts
 * imports this leaf instead of delegate.ts, and delegate.ts re-exports
 * the manifest so existing consumers keep working. This module must
 * stay a leaf — imports only ./manifest (and ./types if needed),
 * never ./delegate or ./service.
 */
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";

/** Plugin discovery manifest for `delegate`. */
export const delegateManifest: ToolManifest = defineManifest({
  id: "delegate",
  version: "1.0.0",
  title: "Delegate Subtask",
  description: "Hand an independent subtask to a child agent with limited tools and a time budget. Use it for side work that should not clutter the main conversation; returns a short summary.",
  purpose: "subtask via child",
  useWhen: "side subtask",
  doNotUseWhen: "Main task or simple one-step work — do it directly; the child also has no delegate tool, so subtasks cannot nest.",
  confusableWith: [
    { tool: "consult_models", difference: "consult_models asks models one question and synthesizes; delegate runs a tool-using child agent on a subtask." },
    { tool: "schedule_task", difference: "schedule_task runs work later on a schedule; delegate runs a child agent now." },
  ],
  latencyTier: "minutes",
  outputSummary: "Returns the child agent's short summary, or an error on failure.",
  category: "agents",
  timeoutMs: 60000,
  costTier: "heavy",
});
