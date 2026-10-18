#!/usr/bin/env python3
"""Hermes trajectory -> bench external-results JSON.

Parses Hermes batch_runner.py output (data/<run_name>/batch_*.jsonl) and
extracts, per sample, the ordered tool-call sequence and the final assistant
text — the exact trace shape `bun bench/run.ts --score-only` consumes.

Trajectory format (from agent/agent_runtime_helpers.py):
  conversations = [{"from": "system"|"human"|"gpt"|"tool", "value": str}, ...]
  tool calls appear inside "gpt" turns as:
      <tool_call>\n{"name": "...", "arguments": {...}}\n</tool_call>
  final text = last "gpt" turn with <think> and <tool_call> blocks stripped.

Usage:
  python3 bench/hermes_adapter.py \\
      --run-dir /path/to/hermes-ref/data/<run_name> \\
      --index bench/hermes_dataset.jsonl.index.json \\
      --model "anthropic/claude-sonnet-4.6" \\
      --out bench/results/hermes_<stamp>.json

Then:
  bun bench/run.ts --score-only bench/results/hermes_<stamp>.json --out bench/results

Stdlib only. Never fabricates results: samples without a trajectory
(discarded / failed rows) are emitted with an explicit error marker and score
zero.
"""

import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime, timezone

TOOL_CALL_RE = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.DOTALL)
THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
TAG_RE = re.compile(r"</?tool_call>")


def extract_trace(conversations):
    """(tool_calls, final_text) from a Hermes trajectory."""
    tool_calls = []
    final_text = ""
    for turn in conversations or []:
        if not isinstance(turn, dict):
            continue
        if turn.get("from") != "gpt":
            continue
        value = turn.get("value") or ""
        for m in TOOL_CALL_RE.finditer(value):
            try:
                payload = json.loads(m.group(1))
            except json.JSONDecodeError:
                continue
            tool_calls.append(
                {"name": payload.get("name", "unknown"),
                 "args": payload.get("arguments", {})}
            )
        # Candidate final text: strip tool calls and think blocks.
        cleaned = THINK_RE.sub("", TOOL_CALL_RE.sub("", value)).strip()
        cleaned = TAG_RE.sub("", cleaned).strip()
        if cleaned:
            final_text = cleaned
    return tool_calls, final_text


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run-dir", required=True,
                   help="Hermes batch output dir, e.g. hermes-ref/data/<run_name>")
    p.add_argument("--index", required=True,
                   help="prompt_index -> task id map from hermes_adapter.ts to-jsonl")
    p.add_argument("--model", default="unknown", help="Model id used for the Hermes run")
    p.add_argument("--out", required=True, help="External-results JSON to write")
    return p.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    with open(args.index, encoding="utf-8") as f:
        index = json.load(f)

    by_index = {}  # prompt_index -> parsed sample
    files = sorted(glob.glob(os.path.join(args.run_dir, "batch_*.jsonl")))
    if not files:
        print(f"no batch_*.jsonl under {args.run_dir}", file=sys.stderr)
        return 1
    for path in files:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                idx = str(row.get("prompt_index"))
                if row.get("discarded") or not row.get("conversations"):
                    by_index[idx] = {"error": row.get("discarded", "no_trajectory")}
                    continue
                tool_calls, final_text = extract_trace(row["conversations"])
                by_index[idx] = {
                    "tool_calls": tool_calls,
                    "final_text": final_text,
                    "completed": bool(row.get("completed")),
                    "partial": bool(row.get("partial")),
                }

    results = []
    for idx in sorted(index, key=int):
        entry = index[idx]
        sample = by_index.get(idx)
        if sample is None:
            results.append({"taskId": entry["taskId"],
                            "turns": [{"toolCalls": [], "finalText": ""}],
                            "error": "missing_from_batch_output"})
        elif "error" in sample:
            results.append({"taskId": entry["taskId"],
                            "turns": [{"toolCalls": [], "finalText": ""}],
                            "error": sample["error"]})
        else:
            results.append({
                "taskId": entry["taskId"],
                "turns": [{
                    "toolCalls": [
                        {"name": c["name"], "args": c["args"]}
                        for c in sample["tool_calls"]
                    ],
                    "finalText": sample["final_text"],
                }],
            })

    payload = {
        "provider": "hermes",
        "model": args.model,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "results": results,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    ok = sum(1 for r in results if "error" not in r)
    print(f"parsed {ok}/{len(results)} samples with trajectories -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
