/**
 * Plugin barrel — the ONE place built-in tools are listed.
 *
 * Before this module, service.ts hard-imported every tool by name: the
 * core's registration file was also its catalog, and adding a tool
 * meant editing core wiring. Now:
 *
 * - `pluginTools` — the statically constructible tools (no deps).
 *   service.ts registers exactly these as its defaults and imports
 *   NOTHING else from the tool modules.
 * - `getPluginManifests()` — the discovery catalog for ALL built-in
 *   tools, including the factory-built ones (memory, reminders, …)
 *   whose instances only exist after the composition root injects
 *   their deps. The intent router ranks on this catalog.
 *
 * Adding a tool = create the tool file (with its manifest const) +
 * add ONE line below. A duplicate or malformed entry fails the boot
 * assert in ToolService's constructor, naming the offending file.
 *
 * The catalog is assembled lazily (memoized function, not module-init
 * constants) because some tool modules import service.ts back
 * (delegate.ts) — reading their manifest consts during module init
 * would hit the cycle mid-initialization. By construction time every
 * module is loaded, so the assert sees the full catalog.
 */
import type { ToolManifest } from "./manifest";
import type { Tool } from "./types";
import { validateCatalog } from "./validate_manifest";

import { calculatorTool } from "./calculator";
import { dateTimeTool } from "./date_time";
import { fetchUrlTool } from "./fetch_url";
import { textUtilitiesTool } from "./text_utilities";
import { unitConverterTool } from "./unit_converter";

import { calculatorManifest } from "./calculator";
import { commandsManifest } from "./commands";
import { consultModelsManifest } from "./consult_models";
import { dateTimeManifest } from "./date_time";
import { delegateManifest } from "./delegate";
import { buildDigestManifest } from "./digest_tool";
import { downloadMediaManifest } from "./downloader";
import { fetchUrlManifest } from "./fetch_url";
import {
  addGoalManifest,
  completeGoalManifest,
  listGoalsManifest,
} from "./goals";
import { searchHistoryManifest } from "./history";
import { generateImageManifest } from "./image_gen";
import {
  forgetManifest,
  recallManifest,
  rememberManifest,
} from "./memory";
import {
  ackNudgeManifest,
  listNudgesManifest,
  noteFollowupManifest,
  snoozeNudgeManifest,
} from "./nudge_tool";
import {
  cancelReminderManifest,
  listRemindersManifest,
  remindAtManifest,
  remindNlManifest,
} from "./reminders";
import {
  cancelTaskManifest,
  listTasksManifest,
  scheduleTaskManifest,
} from "./scheduled_tasks";
import {
  shortcutAddManifest,
  shortcutDeleteManifest,
  shortcutListManifest,
} from "./shortcuts";
import { textUtilitiesManifest } from "./text_utilities";
import { toolSearchManifest } from "./tool_search";
import { unitConverterManifest } from "./unit_converter";
import { usageReportManifest } from "./usage_report";
import { generateVideoManifest } from "./video_gen";
import { webSearchManifest } from "./web_search";

import { runBenchManifest } from "../bench/tool";
import {
  curateMemoriesManifest,
  curatorDecideManifest,
  listEventsManifest,
  noteEventManifest,
  summarizeMemoriesManifest,
} from "../curator/tools";
import { groupDigestManifest } from "../groups/group_digest";
import { skillsManifest } from "../skills/tool";

/**
 * Statically constructible tools, in menu order.
 *
 * `web_search` and the factory tools are absent on purpose: they need
 * configured deps (a provider, storage, trackers), so the composition
 * root (src/index.ts) builds them and registers them via
 * ToolServiceOptions.extraTools. Their manifests ARE in the catalog
 * below — discovery does not require an instance.
 */
export const pluginTools: readonly Tool<unknown, unknown>[] = [
  calculatorTool,
  dateTimeTool,
  textUtilitiesTool,
  unitConverterTool,
  fetchUrlTool,
] as unknown as readonly Tool<unknown, unknown>[];

interface CatalogEntry {
  readonly manifest: ToolManifest;
  /** Defining module, named in boot-assert failures. */
  readonly source: string;
}

/** One line per built-in tool, sorted by plugin id. */
const CATALOG_ENTRIES: readonly CatalogEntry[] = [
  { manifest: ackNudgeManifest, source: "src/tools/nudge_tool.ts" },
  { manifest: addGoalManifest, source: "src/tools/goals.ts" },
  { manifest: buildDigestManifest, source: "src/tools/digest_tool.ts" },
  { manifest: calculatorManifest, source: "src/tools/calculator.ts" },
  { manifest: cancelReminderManifest, source: "src/tools/reminders.ts" },
  { manifest: cancelTaskManifest, source: "src/tools/scheduled_tasks.ts" },
  { manifest: commandsManifest, source: "src/tools/commands.ts" },
  { manifest: completeGoalManifest, source: "src/tools/goals.ts" },
  { manifest: consultModelsManifest, source: "src/tools/consult_models.ts" },
  { manifest: curateMemoriesManifest, source: "src/curator/tools.ts" },
  { manifest: curatorDecideManifest, source: "src/curator/tools.ts" },
  { manifest: dateTimeManifest, source: "src/tools/date_time.ts" },
  { manifest: delegateManifest, source: "src/tools/delegate.ts" },
  { manifest: downloadMediaManifest, source: "src/tools/downloader.ts" },
  { manifest: fetchUrlManifest, source: "src/tools/fetch_url.ts" },
  { manifest: forgetManifest, source: "src/tools/memory.ts" },
  { manifest: generateImageManifest, source: "src/tools/image_gen.ts" },
  { manifest: generateVideoManifest, source: "src/tools/video_gen.ts" },
  { manifest: groupDigestManifest, source: "src/groups/group_digest.ts" },
  { manifest: listEventsManifest, source: "src/curator/tools.ts" },
  { manifest: listGoalsManifest, source: "src/tools/goals.ts" },
  { manifest: listNudgesManifest, source: "src/tools/nudge_tool.ts" },
  { manifest: listRemindersManifest, source: "src/tools/reminders.ts" },
  { manifest: listTasksManifest, source: "src/tools/scheduled_tasks.ts" },
  { manifest: noteEventManifest, source: "src/curator/tools.ts" },
  { manifest: noteFollowupManifest, source: "src/tools/nudge_tool.ts" },
  { manifest: recallManifest, source: "src/tools/memory.ts" },
  { manifest: remindAtManifest, source: "src/tools/reminders.ts" },
  { manifest: remindNlManifest, source: "src/tools/reminders.ts" },
  { manifest: rememberManifest, source: "src/tools/memory.ts" },
  { manifest: runBenchManifest, source: "src/bench/tool.ts" },
  { manifest: scheduleTaskManifest, source: "src/tools/scheduled_tasks.ts" },
  { manifest: searchHistoryManifest, source: "src/tools/history.ts" },
  { manifest: shortcutAddManifest, source: "src/tools/shortcuts.ts" },
  { manifest: shortcutDeleteManifest, source: "src/tools/shortcuts.ts" },
  { manifest: shortcutListManifest, source: "src/tools/shortcuts.ts" },
  { manifest: skillsManifest, source: "src/skills/tool.ts" },
  { manifest: snoozeNudgeManifest, source: "src/tools/nudge_tool.ts" },
  { manifest: summarizeMemoriesManifest, source: "src/curator/tools.ts" },
  { manifest: textUtilitiesManifest, source: "src/tools/text_utilities.ts" },
  { manifest: toolSearchManifest, source: "src/tools/tool_search.ts" },
  { manifest: unitConverterManifest, source: "src/tools/unit_converter.ts" },
  { manifest: usageReportManifest, source: "src/tools/usage_report.ts" },
  { manifest: webSearchManifest, source: "src/tools/web_search.ts" },
];

let cachedManifests: readonly ToolManifest[] | undefined;

/** The full built-in plugin manifest catalog (memoized). */
export function getPluginManifests(): readonly ToolManifest[] {
  if (cachedManifests === undefined) {
    cachedManifests = CATALOG_ENTRIES.map((e) => e.manifest);
  }
  return cachedManifests;
}

/** Manifest lookup by plugin id. */
export function pluginManifest(id: string): ToolManifest | undefined {
  return getPluginManifests().find((m) => m.id === id);
}

/**
 * Boot assert for the plugin catalog.
 *
 * Throws — naming the offending file — when a manifest is malformed,
 * an id is duplicated, or a statically-registered tool is missing its
 * manifest (or carries one whose id disagrees with its name).
 * ToolService's constructor runs this, so a broken plugin fails the
 * boot instead of degrading discovery silently.
 */
export function assertPluginCatalog(): void {
  const sources = new Map<string, string>();
  for (const entry of CATALOG_ENTRIES) {
    if (!sources.has(entry.manifest.id)) sources.set(entry.manifest.id, entry.source);
  }
  const problems = validateCatalog(getPluginManifests(), pluginTools, sources);
  if (problems.length > 0) {
    throw new Error(`invalid plugin catalog:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}
