# Intent Router — Integration Guide

`detectIntents(text, catalog)` in `intent.ts` is a pure, deterministic,
LLM-free function: given the user's message and the plugin manifest
catalog (`getPluginManifests()` from `src/tools/plugins.ts`), it returns up
to 3 `IntentHint`s — which plugin the message is almost certainly for,
with best-effort pre-extracted args.

This module is deliberately NOT wired into the agent loop yet. This
document is the contract for the follow-up wiring.

## The hint shape

```ts
interface IntentHint {
  toolId: string;                          // == the Tool's registered name
  confidence: number;                      // 0..1
  extractedArgs: Record<string, unknown>;  // partial, best-effort
  reason: string;                          // debug/log only, never user-facing
}
```

## How a consumer should use it

Call it once per user turn, before assembling the model's tool specs:

```ts
import { getPluginManifests } from "../tools/plugins";
import { detectIntents, hasStrongIntent } from "../routing/intent";

const hints = detectIntents(userText, getPluginManifests());
```

Then:

1. **Strong intent (`hasStrongIntent(hints)`, any confidence ≥ 0.9)**
   — narrow the tool specs passed to the model to the hinted tools
   PLUS the always-on core tools (memory recall, commands). A bare
   YouTube link should not ship a 35-tool catalog in the prompt.
   The Executor still enforces permissions independently; narrowing
   is an ergonomics/latency optimization, never a security boundary.

2. **Weak hints only (0.7-0.89)** — do NOT narrow. Pass the hints as a
   catalog ORDER preference: hinted tools' specs first, so the model
   sees the likely tools at the top of the list.

3. **No hints** — pass the full catalog, unchanged (today's behavior).

4. **`extractedArgs`** — offer them to the model as a system-side note
   (e.g. "Router pre-extracted: url=…, dueAt=…"), or pre-fill the tool
   call arguments when the turn is executed without a model round-trip
   (fast-lane). Never execute a tool from a hint alone without the
   model's confirmation in agent mode: hints are suggestions with a
   confidence score, not commands. The one exception is the existing
   fast-lane for `commands` (static catalog) if one is introduced.

5. **Permissions and visibility still apply.** A hint for a tool the
   actor may not run (owner-only, disabled, filtered toolset) must be
   dropped before narrowing — reuse `ToolService.can()` /
   `toolSpecsFor()` as the filter, exactly like `tool_search` does.

## Kill switch

`BOBI_INTENT_ROUTER=0` makes `detectIntents` return `[]` for every
input. Consumers do not need their own check: an empty hint list is
already the "full catalog" path.

## Costs

Regex-only over the manifest catalog (35 manifests): well under 1ms
per message. Persian date parsing adds a bounded scan of the message.
No I/O, no timers, no model calls.
