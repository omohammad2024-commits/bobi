# Hermes adapter — running the same tasks headless against Hermes

This adapter runs the `bench/tasks/*.yaml` suite against the real Hermes
agent (`~/workspace/hermes-ref`) and scores the results with BOBI's
deterministic scorer — the same scorer, the same tasks, no LLM-as-judge on
either side.

## What exists in hermes-ref (verified)

- `batch_runner.py` — a real non-interactive batch runner (fire CLI). Input:
  a JSONL dataset where each entry has a `prompt` field. Output per run:
  `data/<run_name>/batch_N.jsonl`, one JSON row per prompt.
- Each success row carries:
  - `prompt_index` — the dataset entry's 0-based index (the row does NOT
    echo the prompt text, so the index sidecar below is required),
  - `conversations` — the trajectory: a list of `{"from": "system" |
    "human" | "gpt" | "tool", "value": str}`,
  - `metadata`, `completed`, `partial`, `api_calls`, `toolsets_used`,
  - `tool_stats` / `tool_error_counts` — per-tool counts, keyed by Hermes's
    own tool names.
- Tool calls inside a trajectory are inline in `"gpt"` turns as
  `<tool_call>\n{"name": "...", "arguments": {...}}\n</tool_call>`
  (see `agent/agent_runtime_helpers.py::_trajectory_tool_call_turn`).
- Discarded/failed samples are written as tombstone rows
  (`{"prompt_index": N, "discarded": "no_reasoning", ...}`) with no
  trajectory — the parser below marks them as errors, never as passes.
- Toolset distributions (from `toolset_distributions.py`): `default`,
  `safe` ("All tools except terminal for safety"), `minimal` ("Only web
  tools"), `research`, `development`, `browser_use`, and others.

## Step-by-step head-to-head

All paths below are relative to the BOBI repo root unless stated otherwise.

### 1. Convert tasks to a Hermes dataset

```bash
bun bench/hermes_adapter.ts to-jsonl --out bench/hermes_dataset.jsonl
```

Writes `bench/hermes_dataset.jsonl` (one `{"prompt": ...}` per task, in
`loadTasks` order) and `bench/hermes_dataset.jsonl.index.json`
(`prompt_index` → task id, plus `multi_turn_joined` flags).

### 2. Run Hermes batch mode (in hermes-ref, with its environment)

Prerequisites (owner's job): set up the Hermes checkout per its own README
(`setup-hermes.sh`; at the time of writing the venv on this VM was not
functional — `source ./activate` yields no python), and have a model API key
ready. Hermes reads `OPENROUTER_API_KEY` from the environment, or pass
`--api_key`.

```bash
cd ~/workspace/hermes-ref
# source ./activate   # once the hermes env is functional
python batch_runner.py \
  --dataset_file=/home/hatch/workspace/bobi-agent/extracted/BOBI\ AGENT/bench/hermes_dataset.jsonl \
  --batch_size=4 \
  --run_name=bench_YYYYMMDD \
  --model='<SAME MODEL AS THE BOBI LIVE RUN>' \
  --distribution=safe \
  --max_turns=10
```

Fairness notes:

- **Same model id on both sides.** Pass the exact model string used for
  `bun bench/run.ts --live` (BOBI's active model from `/ai`).
- **`--distribution=safe`** excludes the terminal toolset. The injection
  tasks contain adversarial tool output; running them with terminal/file
  write access is the owner's explicit risk decision — `safe` is the
  recommended default, `minimal` (web tools only) is the most conservative.
- Hermes executes **real** tools (web fetch, browser, file writes depending
  on distribution). Do not point it at a production checkout.

### 3. Parse trajectories to the external-results format

```bash
python3 bench/hermes_adapter.py \
  --run-dir ~/workspace/hermes-ref/data/bench_YYYYMMDD \
  --index bench/hermes_dataset.jsonl.index.json \
  --model '<SAME MODEL>' \
  --out bench/results/hermes_<stamp>.json
```

`extract_trace()` pulls the ordered tool-call sequence
(`[{"name", "args"}]`) and the final assistant text (last `"gpt"` turn,
`<think>` and `<tool_call>` blocks stripped) from each trajectory. Samples
without a trajectory are emitted with an `"error"` marker and score zero —
results are never fabricated.

### 4. Score with BOBI's scorer

```bash
bun bench/run.ts --score-only bench/results/hermes_<stamp>.json \
  --tool-map bench/hermes_tool_map.json \
  --out bench/results
```

Produces `bench/results/<stamp>-external.json` and the Persian
`<stamp>-external.md` report — the same report shape as a BOBI run, so the
two can be compared cell by cell.

## The tool-name map (fill-in-the-blank)

Hermes tool names differ from BOBI's, so `exact_tools` / `tool_args`
tasks need an explicit rename map before scoring. The map is
`bench/hermes_tool_map.json`:

```json
{
  "HERMES_TOOL_NAME": "bobi_tool_name"
}
```

How to fill it (no guessing): after step 2, read the actual tool names
from any `batch_N.jsonl` row's `tool_stats` keys, then map each one you
recognise to the BOBI equivalent. Blanks left unfilled keep the Hermes
name, which will fail name-sensitive checks honestly rather than silently.

Known blanks (fill after your first Hermes run):

| Hermes tool name | BOBI equivalent |
| --- | --- |
| _(from `tool_stats` keys, e.g. web search tool)_ | `web_search` |
| _(from `tool_stats` keys, e.g. calculator/utility)_ | `calculator` |
| _(from `tool_stats` keys, e.g. page fetch)_ | `fetch_url` |
| _(Hermes has no reminder/scheduler/memory equivalent — verify)_ | `remind_at`, `schedule_task`, `remember`, `recall` |

Tasks whose tools have no Hermes equivalent (`remind_at`,
`schedule_task`, `remember`, …) cannot pass name-sensitive checks on the
Hermes side; that is a real, reportable parity gap, not a harness bug —
the report shows it as failed checks, and the head-to-head summary should
note the category as "not applicable to Hermes" rather than counting it as
a BOBI win by default.

## Known limitations (documented, not hidden)

1. **Multi-turn tasks** (`mem_*`): Hermes batch mode runs one prompt per
   sample with no conversation carry-over, so the adapter joins the turns
   into a single prompt (`[نوبت بعد]` separator, flagged
   `multi_turn_joined: true` in the index). Memory-across-turns is not
   faithfully measurable this way; evaluate those three tasks interactively
   if the head-to-head hinges on them.
2. **No latency/token/cost comparison**: Hermes batch rows expose
   `api_calls` but not token counts, so the external report leaves those
   columns at zero. Compare pass rates and check-level scores, not cost.
3. **System prompts differ**: each agent runs its own system prompt and
   personality. The suite measures end-to-end behaviour, not prompt quality.
4. **BOBI web tasks use mocked search/fetch** (deterministic, offline);
   Hermes hits the real web. Web-task scores are therefore
   determinism-vs-realism, not apples-to-apples — read them as such.
