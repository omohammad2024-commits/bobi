/**
 * Hermes-parity automation commands (Phase: commands-auto).
 *
 * /bg /btw /queue /steer /agents /goal /subgoal /heartbeat /loop /cron
 * /suggestions /blueprint /refine /review /plan /moa /memory /learn /bundles
 *
 * Conventions (per `src/bot/cmd_context.ts`):
 * - logic lives in exported `handleXxx(deps, …)` functions taking plain
 *   values; the grammy wrappers in `registerAutoCommands` stay thin,
 * - user-facing strings come from `./cmd_auto_strings` (Persian default),
 * - the group/user gates run before every handler.
 *
 * SECURITY MODEL (read before touching this file):
 *
 *  1. ACTORS ARE BUILT SERVER-SIDE. `actorForTelegramUser` derives the tool
 *     actor from the trusted numeric `from.id` through the Authorization
 *     Core (`authorizeToolUse`), exactly like the message path. Message text,
 *     callback data, and chat ids can never widen a grant. A user-supplied
 *     id is NEVER trusted for authority.
 *
 *  2. OWNER-ONLY IS GATED TWICE. The grammy wrapper rejects non-owners with
 *     a Persian reply (never silently), and the authorization bridge
 *     additionally withholds owner-only permission keys from non-owners —
 *     so even a hand-built actor cannot run schedule_task/add_goal/etc.
 *
 *  3. PER-USER SCOPING. Background tasks, queues, pending steers, and memory
 *     reads are all keyed by the sender's id. User A's `/bg list` can never
 *     see user B's tasks (tested in `tests/cmd_auto.test.ts`).
 *
 *  4. NO RAW TEXT INTO TOOL ARGS WITHOUT VALIDATION. Every free-text
 *     argument is trimmed and length-capped before it reaches a tool or the
 *     engine; the engine/tools treat it as data, never as instructions.
 *
 *  5. `/learn` PATH TRAVERSAL GUARD. The skill name must match
 *     `^[a-z0-9-]{1,40}$`; anything else is rejected. The draft is returned
 *     as a document for the owner to place — this module never writes to
 *     the skills directory itself.
 *
 *  6. `/bg` DELIVERY. Results go out through `bot.api.sendMessage`; a dead
 *     chat is dropped and logged, never retried forever.
 */
import type { Bot } from "grammy";
import { InputFile } from "grammy";
import type { HermesCommandDef, HermesCommandDeps } from "./cmd_context";
import type {
  ConversationEngine,
  ConversationInput,
  ConversationOutput,
} from "../conversation/engine";
import { splitForTelegram } from "../conversation/engine";
import type { ToolActor, ToolRunResult } from "../tools/types";
import type { ToolService } from "../tools/service";
import type { Storage } from "../storage/storage";
import type { AuthorizationService } from "../auth/service";
import type { UserPrefStore } from "./bot";
import { authorizeToolUse, toToolActor } from "../auth/tool_bridge";
import { gateGroup, gateUser, isOwnerSender, senderLang } from "./bot";
import { tr, type AutoLang } from "./cmd_auto_strings";

// ---------------------------------------------------------------------------
// Command definitions (menu entries, merged by the coordinator)
// ---------------------------------------------------------------------------

export const COMMAND_DEFS: HermesCommandDef[] = [
  { command: "bg", descriptionFa: "اجرای دستور در پس‌زمینه", descriptionEn: "Run a prompt in the background", ownerOnly: false },
  { command: "btw", descriptionFa: "پرسش جانبی", descriptionEn: "Side question in a separate thread", ownerOnly: false },
  { command: "queue", descriptionFa: "صف‌بندی پیام", descriptionEn: "Queue a prompt", ownerOnly: false },
  { command: "steer", descriptionFa: "تزریق راهنمایی", descriptionEn: "Inject guidance into the turn", ownerOnly: false },
  { command: "agents", descriptionFa: "ایجنت‌های فعال", descriptionEn: "List active agents and tasks", ownerOnly: false },
  { command: "goal", descriptionFa: "هدف ماندگار", descriptionEn: "Manage persistent goals", ownerOnly: true },
  { command: "subgoal", descriptionFa: "زیراهداف", descriptionEn: "Manage subgoals", ownerOnly: true },
  { command: "heartbeat", descriptionFa: "یادآور دوره‌ای", descriptionEn: "Periodic heartbeat reminder", ownerOnly: true },
  { command: "loop", descriptionFa: "تکرار خودکار", descriptionEn: "Repeating task loop", ownerOnly: true },
  { command: "cron", descriptionFa: "وظایف زمان‌بندی‌شده", descriptionEn: "Scheduled tasks", ownerOnly: true },
  { command: "suggestions", descriptionFa: "اتوماسیون‌های پیشنهادی", descriptionEn: "Suggested automations", ownerOnly: false },
  { command: "blueprint", descriptionFa: "اتوماسیون از قالب", descriptionEn: "Automation from a blueprint", ownerOnly: false },
  { command: "refine", descriptionFa: "استخراج درس از گفت‌وگو", descriptionEn: "Extract lessons from the conversation", ownerOnly: false },
  { command: "review", descriptionFa: "بازبینی مستقل", descriptionEn: "Independent review by a subagent", ownerOnly: false },
  { command: "plan", descriptionFa: "طرح اجرایی", descriptionEn: "Step-by-step plan, no execution", ownerOnly: false },
  { command: "moa", descriptionFa: "اجرای چندمدلی", descriptionEn: "Multi-model consultation", ownerOnly: false },
  { command: "memory", descriptionFa: "مدیریت حافظه", descriptionEn: "Manage long-term memory", ownerOnly: false },
  { command: "learn", descriptionFa: "آموزش مهارت", descriptionEn: "Draft a new skill", ownerOnly: true },
  { command: "bundles", descriptionFa: "بسته‌های مهارت", descriptionEn: "Skill bundles", ownerOnly: false },
];

// ---------------------------------------------------------------------------
// Deps, actors, tool calls
// ---------------------------------------------------------------------------

/**
 * Narrow view of HermesCommandDeps these handlers need. A full
 * HermesCommandDeps is structurally assignable, so `registerAutoCommands`
 * passes it straight through; tests build this shape with stubs.
 */
export interface AutoDeps {
  engine: Pick<ConversationEngine, "respond" | "isConversationRunning" | "cancel">;
  storage?: Storage;
  tools?: ToolService;
  prefs?: UserPrefStore;
  auth?: AuthorizationService;
  ownerId?: number;
}

/** Plain sender identity, derived from the trusted update fields. */
export interface SenderRef {
  /** String form of the Telegram numeric id (storage keys). */
  userId: string;
  /** Trusted numeric Telegram id (actor building). */
  telegramId: number;
  /** String form of the chat id (conversation scoping, delivery). */
  chatId: string;
}

/**
 * Build the tool-layer actor for a Telegram user, server-side.
 *
 * Mirrors `toolActorFor` in `bot.ts` (which is module-private): identity
 * comes from the trusted numeric id only, and `authorizeToolUse` applies the
 * server-side permission policy — including withholding owner-only keys from
 * non-owners. Without auth there is no identity to prove, so the actor is
 * "unknown" with no permissions (fail-closed, same as the message path).
 */
export function actorForTelegramUser(deps: AutoDeps, telegramId: number): ToolActor {
  const { auth } = deps;
  if (!auth) return { userId: "unknown", permissions: [] };
  const actor = auth.actorFromTelegramUser({ id: telegramId });
  const registered = deps.tools?.registry.list() ?? [];
  return toToolActor(authorizeToolUse(auth, actor, registered));
}

export interface ToolCallOutcome {
  ok: boolean;
  data?: unknown;
  message?: string;
}

/**
 * Run a tool as an already-authorized actor through `ToolService.execute`.
 *
 * The actor is always built by `actorForTelegramUser` (server-side); the
 * tool name and input are the only caller-controlled parts, and the
 * Executor re-validates permissions and input at run time. `conversationId`
 * is passed only from server context (e.g. remind_at's destination chat),
 * never from user text.
 */
export async function callToolAs(
  deps: AutoDeps,
  toolName: string,
  input: unknown,
  actor: ToolActor,
  conversationId?: string,
): Promise<ToolCallOutcome> {
  const tools = deps.tools;
  if (!tools) {
    return { ok: false, message: tr("fa", "cmd_auto.need_tools") };
  }
  let res: ToolRunResult;
  try {
    res = await tools.execute({
      tool: toolName,
      input,
      actor,
      ...(conversationId !== undefined ? { conversationId } : {}),
    });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === "ok") return { ok: true, data: res.data };
  return { ok: false, message: res.message ?? tr("fa", "cmd_auto.tool_failed") };
}

/** User-safe one-liner for an engine failure. */
function engineFailed(lang: AutoLang): string {
  return tr(lang, "cmd_auto.engine_failed");
}

/** Short, log-safe description of an unexpected error. */
function shortError(err: unknown): string {
  return err instanceof Error ? `${err.name}` : String(err).slice(0, 80);
}

// ---------------------------------------------------------------------------
// /bg — background tasks
// ---------------------------------------------------------------------------

type BgStatus = "running" | "done" | "failed" | "cancelled";

interface BgTask {
  id: string;
  userId: string;
  prompt: string;
  status: BgStatus;
  createdAt: number;
}

/** Module-level registry, keyed `${userId}:${id}` — per-user isolation. */
const bgTasks = new Map<string, BgTask>();
let bgCounter = 0;

const MAX_BG_PER_USER = 3;
const MAX_BG_PROMPT_CHARS = 2000;
/** Completed tasks are pruned beyond this many per user (memory hygiene). */
const MAX_BG_STORED_PER_USER = 20;

const BG_STATUS_KEY: Record<BgStatus, string> = {
  running: "cmd_auto.bg.status.running",
  done: "cmd_auto.bg.status.done",
  failed: "cmd_auto.bg.status.failed",
  cancelled: "cmd_auto.bg.status.cancelled",
};

export type BgDeliver = (chatId: string, text: string) => Promise<unknown>;

function bgKey(userId: string, id: string): string {
  return `${userId}:${id}`;
}

function pruneBgTasks(userId: string): void {
  const mine = [...bgTasks.entries()]
    .filter(([, t]) => t.userId === userId)
    .sort((a, b) => b[1].createdAt - a[1].createdAt);
  for (const [key, t] of mine.slice(MAX_BG_STORED_PER_USER)) {
    if (t.status !== "running") bgTasks.delete(key);
  }
}

function bgConversationId(userId: string, id: string): string {
  return `bg:${userId}:${id}`;
}

/**
 * /bg <prompt> — run the prompt as a background task.
 *
 * The engine turn is started WITHOUT awaiting: the reply ack is immediate
 * and the result is delivered later through `deliver`. The background turn
 * runs in its own conversation id so it never disturbs the main thread.
 * Cap: 3 concurrent running tasks per user.
 */
export async function handleBgStart(
  deps: AutoDeps,
  sender: SenderRef,
  prompt: string,
  deliver: BgDeliver,
  lang: AutoLang = "fa",
): Promise<string> {
  const text = prompt.trim();
  if (text.length === 0) return tr(lang, "cmd_auto.empty_prompt");
  if (text.length > MAX_BG_PROMPT_CHARS) return tr(lang, "cmd_auto.bg.too_long");

  const running = [...bgTasks.values()].filter(
    (t) => t.userId === sender.userId && t.status === "running",
  ).length;
  if (running >= MAX_BG_PER_USER) return tr(lang, "cmd_auto.bg.busy");

  const id = `bg-${++bgCounter}`;
  const key = bgKey(sender.userId, id);
  const task: BgTask = {
    id,
    userId: sender.userId,
    prompt: text.length > 120 ? text.slice(0, 120) + "…" : text,
    status: "running",
    createdAt: Date.now(),
  };
  bgTasks.set(key, task);
  pruneBgTasks(sender.userId);

  const actor = actorForTelegramUser(deps, sender.telegramId);
  const conversationId = bgConversationId(sender.userId, id);
  const input: ConversationInput = {
    conversationId,
    userId: sender.userId,
    userText: text,
    actor,
  };

  // Deliberately un-awaited: the ack below goes out immediately.
  void deps.engine
    .respond(input)
    .then((out: ConversationOutput) => {
      const t = bgTasks.get(key);
      // A cancel that landed mid-run suppresses the delivery.
      if (!t || t.status !== "running") return;
      t.status = "done";
      const reply = tr(lang, "cmd_auto.bg.done_prefix", { id }) + out.chunks.join("\n");
      for (const chunk of splitForTelegram(reply)) {
        // Guard: a deleted chat drops the message and logs — never retries.
        deliver(sender.chatId, chunk).catch((err) => {
          console.error("[bobi] bg deliver failed", { id, error: shortError(err) });
        });
      }
    })
    .catch((err: unknown) => {
      const t = bgTasks.get(key);
      if (!t || t.status !== "running") return;
      t.status = "failed";
      deliver(
        sender.chatId,
        tr(lang, "cmd_auto.bg.failed_note", { id, error: shortError(err) }),
      ).catch((derr: unknown) => {
        console.error("[bobi] bg deliver failed", { id, error: shortError(derr) });
      });
    });

  return tr(lang, "cmd_auto.bg.queued", { id });
}

/** /bg list — the sender's own tasks only. */
export function handleBgList(
  _deps: AutoDeps,
  sender: SenderRef,
  lang: AutoLang = "fa",
): string {
  const mine = [...bgTasks.values()]
    .filter((t) => t.userId === sender.userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10);
  if (mine.length === 0) return tr(lang, "cmd_auto.bg.list_empty");
  return mine
    .map((t) =>
      tr(lang, "cmd_auto.bg.list_item", {
        id: t.id,
        status: tr(lang, BG_STATUS_KEY[t.status]),
        prompt: t.prompt,
      }),
    )
    .join("\n");
}

/** /bg cancel <id> — aborts the in-flight turn and suppresses delivery. */
export function handleBgCancel(
  deps: AutoDeps,
  sender: SenderRef,
  id: string,
  lang: AutoLang = "fa",
): string {
  const clean = id.trim();
  if (clean.length === 0) return tr(lang, "cmd_auto.bg.cancel_usage");
  const key = bgKey(sender.userId, clean);
  const task = bgTasks.get(key);
  if (!task) return tr(lang, "cmd_auto.bg.not_found", { id: clean });
  if (task.status === "running") {
    // Best-effort abort of the engine turn; the completion handler checks the
    // status flag and stays silent either way.
    try {
      deps.engine.cancel(bgConversationId(sender.userId, clean));
    } catch {
      // Cancellation is advisory; the status flag is authoritative.
    }
    task.status = "cancelled";
  }
  return tr(lang, "cmd_auto.bg.cancelled", { id: clean });
}

/** Test seam: drop all background-task state. */
export function clearBgTasksForTests(): void {
  bgTasks.clear();
  bgCounter = 0;
}

// ---------------------------------------------------------------------------
// /btw — one-shot side Q&A in a throwaway conversation
// ---------------------------------------------------------------------------

/**
 * /btw <question> — answer in a SEPARATE throwaway conversation id so the
 * main thread's history is undisturbed. The side thread is kept (the engine
 * stores it under its id); the reply tells the user that id.
 */
export async function handleBtw(
  deps: AutoDeps,
  sender: SenderRef,
  question: string,
  lang: AutoLang = "fa",
): Promise<string> {
  const q = question.trim();
  if (q.length === 0) return tr(lang, "cmd_auto.empty_prompt");
  if (q.length > MAX_BG_PROMPT_CHARS) return tr(lang, "cmd_auto.bg.too_long");

  const conversationId = `btw:${sender.userId}:${Date.now()}`;
  const actor = actorForTelegramUser(deps, sender.telegramId);
  let out: ConversationOutput;
  try {
    out = await deps.engine.respond({
      conversationId,
      userId: sender.userId,
      userText: q,
      actor,
    });
  } catch {
    return engineFailed(lang);
  }
  return (
    out.chunks.join("\n") + "\n\n" + tr(lang, "cmd_auto.btw.thread_kept", { id: conversationId })
  );
}

// ---------------------------------------------------------------------------
// /queue — prompt queue (store + list/clear; auto-drain is a follow-up)
// ---------------------------------------------------------------------------

const queues = new Map<string, string[]>();
const MAX_QUEUE_ITEMS = 10;
const MAX_QUEUE_ITEM_CHARS = 2000;

function queueKey(userId: string, chatId: string): string {
  return `${userId}:${chatId}`;
}

/**
 * /queue — queue a prompt for later.
 *
 * HONEST LIMITATION: the queue is stored per conversation and can be
 * listed/cleared, but automatically prepending it to the user's next message
 * needs a seam in the engine's message path (coordinator follow-up). Nothing
 * here fakes that: the reply says so plainly.
 */
export function handleQueue(
  _deps: AutoDeps,
  sender: SenderRef,
  arg: string,
  lang: AutoLang = "fa",
): string {
  const key = queueKey(sender.userId, sender.chatId);
  const tokens = arg.trim().split(/\s+/);
  const sub = (tokens[0] ?? "").toLowerCase();

  if (sub === "list") {
    const items = queues.get(key) ?? [];
    if (items.length === 0) return tr(lang, "cmd_auto.queue.empty");
    return (
      items.map((t, i) => tr(lang, "cmd_auto.queue.item", { n: i + 1, text: t })).join("\n") +
      "\n\n" +
      tr(lang, "cmd_auto.queue.note")
    );
  }

  if (sub === "clear") {
    const n = (queues.get(key) ?? []).length;
    queues.delete(key);
    return tr(lang, "cmd_auto.queue.cleared", { n });
  }

  if (sub === "" || sub === "help") {
    return tr(lang, "cmd_auto.queue.help");
  }

  const text = arg.trim();
  if (text.length > MAX_QUEUE_ITEM_CHARS) return tr(lang, "cmd_auto.bg.too_long");
  const items = queues.get(key) ?? [];
  if (items.length >= MAX_QUEUE_ITEMS) {
    return tr(lang, "cmd_auto.queue.full", { max: MAX_QUEUE_ITEMS });
  }
  items.push(text);
  queues.set(key, items);
  return (
    tr(lang, "cmd_auto.queue.added", { n: items.length }) + "\n" + tr(lang, "cmd_auto.queue.note")
  );
}

/** Test seam. */
export function clearQueuesForTests(): void {
  queues.clear();
}

// ---------------------------------------------------------------------------
// /steer — inject guidance
// ---------------------------------------------------------------------------

const steers = new Map<string, string>();
const MAX_STEER_CHARS = 2000;

function steerKey(userId: string, chatId: string): string {
  return `${userId}:${chatId}`;
}

/**
 * /steer <guidance> — steer the conversation.
 *
 * If a turn is running in this chat, the guidance is stored as a pending
 * steer (visible via /agents) for the user's next message. Otherwise it is
 * prepended to an immediate engine run.
 *
 * HONEST LIMITATION: automatically injecting the pending steer into the next
 * user message needs a seam in the engine's message path (coordinator
 * follow-up) — the stored steer is shown to the user instead of silently
 * dropped.
 */
export async function handleSteer(
  deps: AutoDeps,
  sender: SenderRef,
  guidance: string,
  lang: AutoLang = "fa",
): Promise<string> {
  const g = guidance.trim();
  if (g.length === 0) return tr(lang, "cmd_auto.steer.help");
  if (g.length > MAX_STEER_CHARS) return tr(lang, "cmd_auto.bg.too_long");

  // The engine keys running turns by conversation id = the chat id.
  if (deps.engine.isConversationRunning(sender.chatId)) {
    steers.set(steerKey(sender.userId, sender.chatId), g);
    return tr(lang, "cmd_auto.steer.pending") + "\n" + tr(lang, "cmd_auto.steer.note");
  }

  const actor = actorForTelegramUser(deps, sender.telegramId);
  let out: ConversationOutput;
  try {
    out = await deps.engine.respond({
      conversationId: sender.chatId,
      userId: sender.userId,
      userText: g,
      actor,
    });
  } catch {
    return engineFailed(lang);
  }
  return tr(lang, "cmd_auto.steer.applied") + "\n\n" + out.chunks.join("\n");
}

/** Test seam. */
export function clearSteersForTests(): void {
  steers.clear();
}

// ---------------------------------------------------------------------------
// /agents — active background tasks + running conversations
// ---------------------------------------------------------------------------

/**
 * /agents — what's active right now: the sender's background tasks, whether
 * a turn is running in this chat, any pending steer, and whether the
 * delegate tool exists. There is no delegate-activity registry (see
 * `src/tools/delegate.ts`), so recent delegate runs are not listed — the
 * reply does not pretend otherwise.
 */
export function handleAgents(
  deps: AutoDeps,
  sender: SenderRef,
  lang: AutoLang = "fa",
): string {
  const lines: string[] = [tr(lang, "cmd_auto.agents.title")];

  const mine = [...bgTasks.values()]
    .filter((t) => t.userId === sender.userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10);
  for (const t of mine) {
    lines.push(
      tr(lang, "cmd_auto.agents.bg_item", { id: t.id, status: tr(lang, BG_STATUS_KEY[t.status]) }),
    );
  }

  if (deps.engine.isConversationRunning(sender.chatId)) {
    lines.push(tr(lang, "cmd_auto.agents.running"));
  }

  const steer = steers.get(steerKey(sender.userId, sender.chatId));
  if (steer !== undefined) {
    lines.push(
      tr(lang, "cmd_auto.agents.steer_item", {
        text: steer.length > 80 ? steer.slice(0, 80) + "…" : steer,
      }),
    );
  }

  const delegateExists =
    deps.tools?.registry.list().some((t) => t.name === "delegate") === true;
  if (delegateExists) lines.push(tr(lang, "cmd_auto.agents.delegate"));

  if (lines.length === 1) return tr(lang, "cmd_auto.agents.none");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// /goal — persistent goals (owner), wrapping the goal tools
// ---------------------------------------------------------------------------

interface GoalRow {
  id: number;
  title: string;
  status: string;
}

/**
 * /goal set <text> | show | clear — thin wrapper over the add_goal /
 * list_goals / complete_goal tools, executed with the owner's server-built
 * actor. Owner-only at the command layer AND at the tool layer.
 */
export async function handleGoal(
  deps: AutoDeps,
  sender: SenderRef,
  isOwner: boolean,
  arg: string,
  lang: AutoLang = "fa",
): Promise<string> {
  if (!isOwner) return tr(lang, "cmd_auto.owner_only");
  const tokens = arg.trim().split(/\s+/);
  const sub = (tokens[0] ?? "").toLowerCase();
  const actor = actorForTelegramUser(deps, sender.telegramId);

  if (sub === "set") {
    const title = arg.trim().slice(3).trim();
    if (title.length === 0) return tr(lang, "cmd_auto.empty_prompt");
    const res = await callToolAs(deps, "add_goal", { title }, actor);
    if (!res.ok) return res.message ?? tr(lang, "cmd_auto.tool_failed");
    const d = res.data as { id: number; title: string };
    return tr(lang, "cmd_auto.goal.set", { title: d.title, id: d.id });
  }

  if (sub === "show") {
    const res = await callToolAs(deps, "list_goals", {}, actor);
    if (!res.ok) return res.message ?? tr(lang, "cmd_auto.tool_failed");
    const goals = (res.data as { goals: GoalRow[] }).goals ?? [];
    if (goals.length === 0) return tr(lang, "cmd_auto.goal.show_empty");
    return goals
      .map((g) => tr(lang, "cmd_auto.goal.item", { id: g.id, status: g.status, title: g.title }))
      .join("\n");
  }

  if (sub === "clear") {
    const list = await callToolAs(deps, "list_goals", { status: "active" }, actor);
    if (!list.ok) return list.message ?? tr(lang, "cmd_auto.tool_failed");
    const goals = (list.data as { goals: GoalRow[] }).goals ?? [];
    let n = 0;
    for (const g of goals) {
      const done = await callToolAs(deps, "complete_goal", { id: g.id }, actor);
      if (done.ok) n++;
    }
    return tr(lang, "cmd_auto.goal.cleared", { n });
  }

  return tr(lang, "cmd_auto.goal.help");
}

// ---------------------------------------------------------------------------
// /subgoal — subgoals as naming-convention goals (owner)
// ---------------------------------------------------------------------------

/**
 * The goals schema has no subgoals, so a subgoal is a goal whose title
 * starts with `↳ <parent title> — `. The convention is documented in
 * `docs/phase-commands-auto.md`; filtering is purely by that prefix.
 */
export const SUBGOAL_PREFIX = "↳";

function subgoalTitle(parentTitle: string, text: string): string {
  const full = `${SUBGOAL_PREFIX} ${parentTitle} — ${text}`;
  // add_goal caps titles at 120 chars; stay inside it deterministically.
  return full.length <= 120 ? full : full.slice(0, 119) + "…";
}

async function listAllGoals(
  deps: AutoDeps,
  actor: ToolActor,
): Promise<{ ok: boolean; goals?: GoalRow[]; message: string | undefined }> {
  const res = await callToolAs(deps, "list_goals", {}, actor);
  if (!res.ok) return { ok: false, message: res.message };
  return { ok: true, goals: (res.data as { goals: GoalRow[] }).goals ?? [], message: undefined };
}

/**
 * /subgoal add <parent-id> <text> | list [parent-id] | clear <parent-id>.
 */
export async function handleSubgoal(
  deps: AutoDeps,
  sender: SenderRef,
  isOwner: boolean,
  arg: string,
  lang: AutoLang = "fa",
): Promise<string> {
  if (!isOwner) return tr(lang, "cmd_auto.owner_only");
  const tokens = arg.trim().split(/\s+/);
  const sub = (tokens[0] ?? "").toLowerCase();
  const actor = actorForTelegramUser(deps, sender.telegramId);

  if (sub === "add") {
    const parentId = parseInt(tokens[1] ?? "", 10);
    const text = tokens.slice(2).join(" ").trim();
    if (!Number.isSafeInteger(parentId) || parentId < 1 || text.length === 0) {
      return tr(lang, "cmd_auto.subgoal.help");
    }
    const list = await listAllGoals(deps, actor);
    if (!list.ok) return list.message ?? tr(lang, "cmd_auto.tool_failed");
    const parent = list.goals!.find((g) => g.id === parentId);
    if (!parent) return tr(lang, "cmd_auto.subgoal.parent_missing", { id: parentId });
    const title = subgoalTitle(parent.title, text);
    const res = await callToolAs(deps, "add_goal", { title }, actor);
    if (!res.ok) return res.message ?? tr(lang, "cmd_auto.tool_failed");
    const d = res.data as { id: number; title: string };
    return tr(lang, "cmd_auto.subgoal.added", { title: d.title, id: d.id });
  }

  if (sub === "list" || sub === "clear") {
    const parentId = tokens[1] !== undefined ? parseInt(tokens[1], 10) : undefined;
    const list = await listAllGoals(deps, actor);
    if (!list.ok) return list.message ?? tr(lang, "cmd_auto.tool_failed");
    let subs = list.goals!.filter((g) => g.title.startsWith(SUBGOAL_PREFIX));
    if (parentId !== undefined) {
      if (!Number.isSafeInteger(parentId) || parentId < 1) {
        return tr(lang, "cmd_auto.subgoal.help");
      }
      const parent = list.goals!.find((g) => g.id === parentId);
      if (!parent) return tr(lang, "cmd_auto.subgoal.parent_missing", { id: parentId });
      const prefix = `${SUBGOAL_PREFIX} ${parent.title}`;
      subs = subs.filter((g) => g.title.startsWith(prefix));
    }
    if (sub === "list") {
      if (subs.length === 0) return tr(lang, "cmd_auto.subgoal.list_empty");
      return subs
        .map((g) =>
          tr(lang, "cmd_auto.subgoal.item", { id: g.id, status: g.status, title: g.title }),
        )
        .join("\n");
    }
    let n = 0;
    for (const g of subs) {
      if (g.status !== "active") continue;
      const done = await callToolAs(deps, "complete_goal", { id: g.id }, actor);
      if (done.ok) n++;
    }
    return tr(lang, "cmd_auto.subgoal.cleared", { n });
  }

  return tr(lang, "cmd_auto.subgoal.help");
}

// ---------------------------------------------------------------------------
// Shared: interval parsing + scheduled-task helpers
// ---------------------------------------------------------------------------

/**
 * Parse a short interval ("30m", "2h", "1d") into a 5-field cron expression.
 * Returns undefined for anything else — the caller replies with the hint.
 */
export function parseIntervalToCron(raw: string): string | undefined {
  const m = raw.trim().match(/^(\d+)(m|h|d)$/);
  if (!m) return undefined;
  const n = parseInt(m[1]!, 10);
  if (m[2] === "m" && n >= 1 && n <= 59) return `*/${n} * * * *`;
  if (m[2] === "h" && n >= 1 && n <= 23) return `0 */${n} * * *`;
  if (m[2] === "d" && n >= 1 && n <= 31) return `0 0 */${n} * *`;
  return undefined;
}

interface TaskRow {
  id: number;
  name: string;
  cron: string;
  timezone: string;
  nextRunAt?: string;
}

async function listTasksAs(
  deps: AutoDeps,
  actor: ToolActor,
): Promise<{ ok: boolean; tasks?: TaskRow[]; message: string | undefined }> {
  const res = await callToolAs(deps, "list_tasks", {}, actor);
  if (!res.ok) return { ok: false, message: res.message };
  return { ok: true, tasks: (res.data as { tasks: TaskRow[] }).tasks ?? [], message: undefined };
}

// ---------------------------------------------------------------------------
// /heartbeat — periodic reminder (owner)
// ---------------------------------------------------------------------------

export interface HeartbeatInfo {
  enabled: boolean;
  /** Human interval, e.g. "30m". */
  interval: string;
}

/**
 * Optional provider for the GLOBAL heartbeat service state. The service
 * instance lives in the process wiring (index.ts), which this module cannot
 * see — the coordinator sets this so `/heartbeat status` can report it.
 * Without it, status reports what it can (scheduled heartbeat reminders)
 * and says the rest is unknown, honestly.
 */
let heartbeatInfoProvider: (() => HeartbeatInfo | undefined) | undefined;

export function setHeartbeatInfoProvider(
  fn: (() => HeartbeatInfo | undefined) | undefined,
): void {
  heartbeatInfoProvider = fn;
}

/**
 * /heartbeat status | every <interval> <prompt>.
 *
 * Per-user heartbeats ride the task scheduler: `every` creates a
 * scheduled_task (agent action) that runs the prompt and delivers to this
 * chat. The global heartbeat service itself is only reported, never
 * reconfigured, from here.
 */
export async function handleHeartbeat(
  deps: AutoDeps,
  sender: SenderRef,
  isOwner: boolean,
  arg: string,
  lang: AutoLang = "fa",
): Promise<string> {
  if (!isOwner) return tr(lang, "cmd_auto.owner_only");
  const tokens = arg.trim().split(/\s+/);
  const sub = (tokens[0] ?? "").toLowerCase();
  const actor = actorForTelegramUser(deps, sender.telegramId);

  if (sub === "status") {
    const lines: string[] = [];
    const info = heartbeatInfoProvider?.();
    if (info === undefined) {
      lines.push(tr(lang, "cmd_auto.hb.status_unknown"));
    } else if (info.enabled) {
      lines.push(tr(lang, "cmd_auto.hb.status_on", { interval: info.interval }));
    } else {
      lines.push(tr(lang, "cmd_auto.hb.status_off"));
    }
    const list = await listTasksAs(deps, actor);
    if (list.ok) {
      const n = list.tasks!.filter((t) => t.name.startsWith("heartbeat:")).length;
      lines.push(tr(lang, "cmd_auto.hb.tasks", { n }));
    }
    return lines.join("\n");
  }

  if (sub === "every") {
    const interval = tokens[1] ?? "";
    const prompt = tokens.slice(2).join(" ").trim();
    const cron = parseIntervalToCron(interval);
    if (!cron || prompt.length === 0) return tr(lang, "cmd_auto.hb.bad_interval");
    if (prompt.length > 4000) return tr(lang, "cmd_auto.bg.too_long");
    const res = await callToolAs(
      deps,
      "schedule_task",
      {
        name: `heartbeat: ${prompt.slice(0, 40)}`,
        cron,
        timezone: "Asia/Tehran",
        action: { type: "agent", chatId: sender.chatId, prompt },
      },
      actor,
    );
    if (!res.ok) return res.message ?? tr(lang, "cmd_auto.tool_failed");
    const d = res.data as { id: number };
    return tr(lang, "cmd_auto.hb.created", { id: d.id, interval });
  }

  return tr(lang, "cmd_auto.hb.help");
}

// ---------------------------------------------------------------------------
// /loop — repeating task (owner): direct scheduler mapping
// ---------------------------------------------------------------------------

/**
 * /loop every <interval> <prompt> | stop <id> — a thin alias over the
 * scheduled-task tools: a loop IS a repeating scheduled task.
 */
export async function handleLoop(
  deps: AutoDeps,
  sender: SenderRef,
  isOwner: boolean,
  arg: string,
  lang: AutoLang = "fa",
): Promise<string> {
  if (!isOwner) return tr(lang, "cmd_auto.owner_only");
  const tokens = arg.trim().split(/\s+/);
  const sub = (tokens[0] ?? "").toLowerCase();
  const actor = actorForTelegramUser(deps, sender.telegramId);

  if (sub === "every") {
    const interval = tokens[1] ?? "";
    const prompt = tokens.slice(2).join(" ").trim();
    const cron = parseIntervalToCron(interval);
    if (!cron || prompt.length === 0) return tr(lang, "cmd_auto.hb.bad_interval");
    if (prompt.length > 4000) return tr(lang, "cmd_auto.bg.too_long");
    const res = await callToolAs(
      deps,
      "schedule_task",
      {
        name: `loop: ${prompt.slice(0, 40)}`,
        cron,
        timezone: "Asia/Tehran",
        action: { type: "agent", chatId: sender.chatId, prompt },
      },
      actor,
    );
    if (!res.ok) return res.message ?? tr(lang, "cmd_auto.tool_failed");
    const d = res.data as { id: number };
    return tr(lang, "cmd_auto.loop.created", { id: d.id, interval });
  }

  if (sub === "stop") {
    const id = parseInt(tokens[1] ?? "", 10);
    if (!Number.isSafeInteger(id) || id < 1) return tr(lang, "cmd_auto.loop.bad_id");
    const res = await callToolAs(deps, "cancel_task", { id }, actor);
    if (!res.ok) return res.message ?? tr(lang, "cmd_auto.tool_failed");
    const d = res.data as { cancelled: boolean };
    return d.cancelled
      ? tr(lang, "cmd_auto.loop.stopped", { id })
      : tr(lang, "cmd_auto.loop.not_found", { id });
  }

  return tr(lang, "cmd_auto.loop.help");
}

// ---------------------------------------------------------------------------
// /cron — scheduled tasks (owner)
// ---------------------------------------------------------------------------

function parseCronAdd(arg: string): { cron: string; text: string } | undefined {
  const tokens = arg.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === "") return undefined;
  let cron: string;
  let rest: string[];
  if (tokens[0]!.startsWith("@")) {
    cron = tokens[0]!;
    rest = tokens.slice(1);
  } else {
    if (tokens.length < 6) return undefined;
    cron = tokens.slice(0, 5).join(" ");
    rest = tokens.slice(5);
  }
  const text = rest.join(" ").trim();
  if (text.length === 0 || text.length > 2000) return undefined;
  return { cron, text };
}

/** /cron list | add <cron-expr> <text> — via the scheduled-task tools. */
export async function handleCron(
  deps: AutoDeps,
  sender: SenderRef,
  isOwner: boolean,
  arg: string,
  lang: AutoLang = "fa",
): Promise<string> {
  if (!isOwner) return tr(lang, "cmd_auto.owner_only");
  const tokens = arg.trim().split(/\s+/);
  const sub = (tokens[0] ?? "").toLowerCase();
  const actor = actorForTelegramUser(deps, sender.telegramId);

  if (sub === "list") {
    const list = await listTasksAs(deps, actor);
    if (!list.ok) return list.message ?? tr(lang, "cmd_auto.tool_failed");
    if (list.tasks!.length === 0) return tr(lang, "cmd_auto.cron.list_empty");
    return list
      .tasks!.map((t) =>
        tr(lang, "cmd_auto.cron.item", { id: t.id, name: t.name, cron: t.cron, tz: t.timezone }),
      )
      .join("\n");
  }

  if (sub === "add") {
    const parsed = parseCronAdd(tokens.slice(1).join(" "));
    if (!parsed) return tr(lang, "cmd_auto.cron.help");
    const res = await callToolAs(
      deps,
      "schedule_task",
      {
        name: `cron: ${parsed.text.slice(0, 40)}`,
        cron: parsed.cron,
        timezone: "Asia/Tehran",
        action: { type: "message", chatId: sender.chatId, text: parsed.text },
      },
      actor,
    );
    if (!res.ok) return res.message ?? tr(lang, "cmd_auto.tool_failed");
    const d = res.data as { id: number; nextRunAt: string };
    return tr(lang, "cmd_auto.cron.added", { id: d.id, next: d.nextRunAt });
  }

  return tr(lang, "cmd_auto.cron.help");
}

// ---------------------------------------------------------------------------
// /suggestions — heuristic automation suggestions (user)
// ---------------------------------------------------------------------------

interface Suggestion {
  text: string;
  cmd: string;
}

/**
 * /suggestions — suggest automations from real signals in the user's recent
 * messages. Deliberately simple heuristics, clearly labeled as such in the
 * reply ("ابتکاری"/heuristic) — never presented as model insight.
 */
export function handleSuggestions(
  deps: AutoDeps,
  sender: SenderRef,
  isOwner: boolean,
  lang: AutoLang = "fa",
): string {
  let recent = "";
  try {
    const rows = deps.storage?.history(sender.userId, sender.chatId, 20) ?? [];
    recent = rows
      .filter((r) => r.role === "user")
      .map((r) => r.content)
      .join("\n");
  } catch {
    recent = "";
  }

  const out: Suggestion[] = [];
  if (/یادآوری|یادم بنداز|یادم بماند|هر روز|هر هفته|سر ساعت|یادآوری کن/.test(recent)) {
    out.push({
      text:
        lang === "fa"
          ? "درخواست‌های تکراری/یادآوری در پیام‌هایت هست"
          : "Recurring reminder-like requests in your messages",
      cmd: "/loop every 1d <متن> یا /blueprint run reminder 60 <متن>",
    });
  }
  if (/https?:\/\//.test(recent)) {
    out.push({
      text:
        lang === "fa" ? "لینک فرستاده‌ای؛ بستهٔ پژوهش به کارت می‌آید" : "You shared links; the research bundle fits",
      cmd: "/bundles use research",
    });
  }
  if (isOwner && /هدف|برنامه/.test(recent)) {
    out.push({
      text: lang === "fa" ? "از هدف و برنامه حرف زدی" : "You mentioned goals/plans",
      cmd: "/goal set <متن>",
    });
  }
  if (/خلاصه|گزارش|مرور/.test(recent)) {
    out.push({
      text: lang === "fa" ? "به خلاصهٔ خودکار علاقه نشان دادی" : "You showed interest in automatic digests",
      cmd: "/blueprint list",
    });
  }

  const top = out.slice(0, 3);
  if (top.length === 0) return tr(lang, "cmd_auto.sug.none");
  return (
    tr(lang, "cmd_auto.sug.title") +
    "\n" +
    top.map((s) => tr(lang, "cmd_auto.sug.item", { text: s.text, cmd: s.cmd })).join("\n")
  );
}

// ---------------------------------------------------------------------------
// /blueprint — automation from a template (user)
// ---------------------------------------------------------------------------

export interface Blueprint {
  name: string;
  descFa: string;
  descEn: string;
  hint: string;
}

export const BLUEPRINTS: Blueprint[] = [
  {
    name: "morning_digest",
    descFa: "خلاصهٔ صبحگاهی روزانه ساعت ۸:۰۰ تهران (وظیفهٔ زمان‌بندی‌شده)",
    descEn: "Daily 8:00 (Tehran) morning digest (scheduled task)",
    hint: "/blueprint run morning_digest",
  },
  {
    name: "reminder",
    descFa: "یادآور یک‌باره: /blueprint run reminder <دقیقه> <متن>",
    descEn: "One-shot reminder: /blueprint run reminder <minutes> <text>",
    hint: "/blueprint run reminder 30 آب خوردن",
  },
  {
    name: "weekly_review",
    descFa: "مرور هفتگی جمعه‌ها ساعت ۹:۰۰ تهران (وظیفهٔ زمان‌بندی‌شده)",
    descEn: "Weekly Friday 9:00 (Tehran) review (scheduled task)",
    hint: "/blueprint run weekly_review",
  },
];

/**
 * /blueprint list | run <name> [args].
 *
 * Blueprints create real scheduled tasks / reminders for the CALLER.
 * schedule_task is owner-only: a non-owner running morning_digest or
 * weekly_review gets a clear denial (the tool layer would refuse anyway;
 * the message here explains why). The one-shot reminder uses remind_at,
 * which is NOT owner-only, so it works for approved users too.
 */
export async function handleBlueprint(
  deps: AutoDeps,
  sender: SenderRef,
  arg: string,
  lang: AutoLang = "fa",
): Promise<string> {
  const tokens = arg.trim().split(/\s+/);
  const sub = (tokens[0] ?? "").toLowerCase();

  if (sub === "list" || sub === "" || sub === "help") {
    const lines = BLUEPRINTS.map((b) =>
      tr(lang, "cmd_auto.bp.item", {
        name: b.name,
        desc: lang === "fa" ? b.descFa : b.descEn,
      }),
    );
    return tr(lang, "cmd_auto.bp.list_title") + "\n" + lines.join("\n");
  }

  if (sub !== "run") return tr(lang, "cmd_auto.bp.help");

  const name = (tokens[1] ?? "").toLowerCase();
  const rest = tokens.slice(2).join(" ").trim();
  const actor = actorForTelegramUser(deps, sender.telegramId);

  if (name === "morning_digest" || name === "weekly_review") {
    // schedule_task is ownerOnly: check the caller's grant up front so the
    // denial names the reason instead of surfacing a bare tool refusal.
    if (!deps.tools) return tr(lang, "cmd_auto.need_tools");
    if (!deps.tools.can("schedule_task", actor)) {
      return tr(lang, "cmd_auto.bp.owner_only_tool");
    }
    const cron = name === "morning_digest" ? "0 8 * * *" : "0 9 * * 5";
    const prompt =
      name === "morning_digest"
        ? "خلاصهٔ صبحگاهی به فارسی: مهم‌ترین کارهای امروز، یادآورهای نزدیک و هدف‌های فعال را کوتاه خلاصه کن."
        : "مرور هفتگی به فارسی: دستاوردهای هفته، هدف‌های فعال و پیشنهاد ۳ کار برای هفتهٔ آینده.";
    const res = await callToolAs(
      deps,
      "schedule_task",
      {
        name: `blueprint: ${name}`,
        cron,
        timezone: "Asia/Tehran",
        action: { type: "agent", chatId: sender.chatId, prompt },
      },
      actor,
    );
    if (!res.ok) return res.message ?? tr(lang, "cmd_auto.tool_failed");
    const d = res.data as { id: number };
    return tr(lang, "cmd_auto.bp.created_task", { name, id: d.id });
  }

  if (name === "reminder") {
    const minutes = parseInt(tokens[2] ?? "", 10);
    const text = tokens.slice(3).join(" ").trim();
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 43200 || text.length === 0) {
      return tr(lang, "cmd_auto.bp.bad_args", { hint: "/blueprint run reminder 30 <متن>" });
    }
    if (text.length > 500) return tr(lang, "cmd_auto.bg.too_long");
    const dueAt = new Date(Date.now() + minutes * 60_000).toISOString();
    const res = await callToolAs(
      deps,
      "remind_at",
      { text, dueAt, repeat: "none" },
      actor,
      // Server-side destination: the chat this command came from. The
      // remind_at tool takes its chat from here, never from user text.
      sender.chatId,
    );
    if (!res.ok) return res.message ?? tr(lang, "cmd_auto.tool_failed");
    return tr(lang, "cmd_auto.bp.created_reminder", { minutes });
  }

  return tr(lang, "cmd_auto.bp.unknown", {
    name: tokens[1] ?? "",
    names: BLUEPRINTS.map((b) => b.name).join(", "),
  });
}

// ---------------------------------------------------------------------------
// /refine — extract durable lessons from the conversation (user)
// ---------------------------------------------------------------------------

const MAX_REFINE_HISTORY_CHARS = 6000;

/**
 * /refine — run an engine turn in a side conversation with the directive to
 * review THIS conversation's recent history (read-only, via storage) and
 * save durable lessons with the remember tool. The caller actor is passed
 * so remember writes land in the caller's own memory.
 */
export async function handleRefine(
  deps: AutoDeps,
  sender: SenderRef,
  lang: AutoLang = "fa",
): Promise<string> {
  let rows: Array<{ role: string; content: string }> = [];
  try {
    rows = deps.storage?.history(sender.userId, sender.chatId, 30) ?? [];
  } catch {
    rows = [];
  }
  if (rows.length === 0) return tr(lang, "cmd_auto.refine.no_history");

  const context = rows
    .slice(-20)
    .map((r) => `${r.role === "user" ? "کاربر" : "دستیار"}: ${r.content}`)
    .join("\n")
    .slice(0, MAX_REFINE_HISTORY_CHARS);

  const directive =
    "تاریخچهٔ زیر از یک گفتگوست. آن را مرور کن؛ درس‌های ماندگار و کاربردی " +
    "(ترجیحات کاربر، تصمیم‌های مهم، حقایق پایدار) را با ابزار remember ذخیره کن — " +
    "نه چیزهای زودگذر و نه کل گفتگو را. در پایان، خلاصه‌ای کوتاه از آنچه ذخیره کردی بنویس.\n\n" +
    "تاریخچه:\n" +
    context;

  const actor = actorForTelegramUser(deps, sender.telegramId);
  let out: ConversationOutput;
  try {
    out = await deps.engine.respond({
      conversationId: `refine:${sender.userId}:${Date.now()}`,
      userId: sender.userId,
      userText: directive,
      actor,
    });
  } catch {
    return engineFailed(lang);
  }
  return out.chunks.join("\n");
}

// ---------------------------------------------------------------------------
// /review — independent review via the delegate tool (user)
// ---------------------------------------------------------------------------

/**
 * /review <topic> — hand the topic to a bounded child agent (delegate tool)
 * with a review directive and return its summary. The delegate tool's own
 * security model applies (same actor, depth-1, capped budgets).
 */
export async function handleReview(
  deps: AutoDeps,
  sender: SenderRef,
  topic: string,
  lang: AutoLang = "fa",
): Promise<string> {
  const t = topic.trim();
  if (t.length === 0) return tr(lang, "cmd_auto.bad_args", { hint: "/review <موضوع>" });
  if (t.length > 2000) return tr(lang, "cmd_auto.bg.too_long");

  const actor = actorForTelegramUser(deps, sender.telegramId);
  const res = await callToolAs(
    deps,
    "delegate",
    {
      task:
        "بازبینی مستقل و نقادانهٔ این موضوع به فارسی. نقاط قوت، ضعف‌ها و " +
        "پیشنهادهای مشخص را بگو؛ فقط خلاصهٔ نهایی را برگردان، بدون سؤال:\n" +
        t,
    },
    actor,
  );
  if (!res.ok) return tr(lang, "cmd_auto.review.failed", { error: res.message ?? "" });
  const d = res.data as { ok?: boolean; summary?: string; error?: string };
  if (d.ok === true && typeof d.summary === "string") return d.summary;
  return tr(lang, "cmd_auto.review.failed", { error: d.error ?? "" });
}

// ---------------------------------------------------------------------------
// /plan — step-by-step plan, no execution (user)
// ---------------------------------------------------------------------------

/**
 * /plan <goal> — engine turn with a planning-only directive.
 *
 * HONEST LIMITATION: there is no per-call tool strip on ConversationInput,
 * so "no tools" is enforced at the prompt level only. A model that ignores
 * the directive could still call tools — the turn runs with the caller's
 * normal actor, so nothing runs beyond their own permissions.
 */
export async function handlePlan(
  deps: AutoDeps,
  sender: SenderRef,
  goal: string,
  lang: AutoLang = "fa",
): Promise<string> {
  const g = goal.trim();
  if (g.length === 0) return tr(lang, "cmd_auto.bad_args", { hint: "/plan <هدف>" });
  if (g.length > 2000) return tr(lang, "cmd_auto.bg.too_long");

  const actor = actorForTelegramUser(deps, sender.telegramId);
  let out: ConversationOutput;
  try {
    out = await deps.engine.respond({
      conversationId: `plan:${sender.userId}:${Date.now()}`,
      userId: sender.userId,
      userText:
        "فقط یک طرح مرحله‌به‌مرحلهٔ شماره‌دار به فارسی تولید کن. " +
        "هیچ ابزاری را صدا نزن و هیچ کاری را اجرا نکن — فقط طرح بنویس، بدون اجرا.\n\nهدف: " +
        g,
      actor,
    });
  } catch {
    return engineFailed(lang);
  }
  return out.chunks.join("\n");
}

// ---------------------------------------------------------------------------
// /moa — multi-model consultation (user)
// ---------------------------------------------------------------------------

/**
 * /moa <question> — call the consult_models tool and return the synthesized
 * answer plus which models were consulted.
 */
export async function handleMoa(
  deps: AutoDeps,
  sender: SenderRef,
  question: string,
  lang: AutoLang = "fa",
): Promise<string> {
  const q = question.trim();
  if (q.length === 0) return tr(lang, "cmd_auto.bad_args", { hint: "/moa <سؤال>" });
  if (q.length > 2000) return tr(lang, "cmd_auto.bg.too_long");

  const actor = actorForTelegramUser(deps, sender.telegramId);
  const res = await callToolAs(deps, "consult_models", { question: q }, actor);
  if (!res.ok) return res.message ?? tr(lang, "cmd_auto.tool_failed");
  const d = res.data as { answer: string; modelsUsed?: string[] };
  const models =
    Array.isArray(d.modelsUsed) && d.modelsUsed.length > 0
      ? tr(lang, "cmd_auto.moa.models", { models: d.modelsUsed.join("، ") })
      : "";
  return d.answer + models;
}

// ---------------------------------------------------------------------------
// /memory — long-term memory management (user, caller-scoped)
// ---------------------------------------------------------------------------

/**
 * /memory list [n] | search <q> | del <key> — via the recall/forget tools
 * executed with the CALLER's actor. Per-user isolation is enforced below
 * the tools (see `src/tools/memory.ts`): the actor id selects the memory
 * space, so one user can never read another's memories.
 */
export async function handleMemory(
  deps: AutoDeps,
  sender: SenderRef,
  arg: string,
  lang: AutoLang = "fa",
): Promise<string> {
  const tokens = arg.trim().split(/\s+/);
  const sub = (tokens[0] ?? "").toLowerCase();
  const actor = actorForTelegramUser(deps, sender.telegramId);

  if (sub === "list") {
    const raw = parseInt(tokens[1] ?? "5", 10);
    const n = Number.isSafeInteger(raw) ? Math.min(Math.max(raw, 1), 20) : 5;
    const res = await callToolAs(deps, "recall", { limit: n }, actor);
    if (!res.ok) return res.message ?? tr(lang, "cmd_auto.tool_failed");
    const mems = (res.data as { memories: Array<{ key: string; content: string }> }).memories ?? [];
    if (mems.length === 0) return tr(lang, "cmd_auto.mem.empty");
    return mems
      .map((m) => tr(lang, "cmd_auto.mem.item", { key: m.key, content: m.content }))
      .join("\n");
  }

  if (sub === "search") {
    const q = tokens.slice(1).join(" ").trim();
    if (q.length === 0) return tr(lang, "cmd_auto.mem.help");
    const res = await callToolAs(deps, "recall", { query: q, limit: 10 }, actor);
    if (!res.ok) return res.message ?? tr(lang, "cmd_auto.tool_failed");
    const mems = (res.data as { memories: Array<{ key: string; content: string }> }).memories ?? [];
    if (mems.length === 0) return tr(lang, "cmd_auto.mem.empty");
    return mems
      .map((m) => tr(lang, "cmd_auto.mem.item", { key: m.key, content: m.content }))
      .join("\n");
  }

  if (sub === "del") {
    const key = tokens.slice(1).join(" ").trim();
    if (key.length === 0) return tr(lang, "cmd_auto.mem.help");
    const res = await callToolAs(deps, "forget", { key }, actor);
    if (!res.ok) return res.message ?? tr(lang, "cmd_auto.tool_failed");
    const d = res.data as { removed: boolean; key: string };
    return d.removed
      ? tr(lang, "cmd_auto.mem.deleted", { key: d.key })
      : tr(lang, "cmd_auto.mem.not_found", { key });
  }

  return tr(lang, "cmd_auto.mem.help");
}

// ---------------------------------------------------------------------------
// /learn — draft a skill (owner)
// ---------------------------------------------------------------------------

/** Skill file names: lowercase latin, digits, dashes — no path separators. */
export const SKILL_NAME_RE = /^[a-z0-9-]{1,40}$/;

export type LearnResult =
  | { ok: true; fileName: string; markdown: string }
  | { ok: false; error: string };

/**
 * /learn <name> | <description> — draft a skill markdown via an engine turn.
 *
 * HONEST LIMITATION: this module has no handle on the configured skills
 * directory (it lives in the process wiring), so the draft is NOT written
 * to disk here. The wrapper sends it as a document and the owner places it.
 * The name regex is the path-traversal guard: no slashes, no dots, no
 * escapes — `../../x` cannot pass.
 */
export async function handleLearn(
  deps: AutoDeps,
  sender: SenderRef,
  isOwner: boolean,
  arg: string,
  lang: AutoLang = "fa",
): Promise<LearnResult> {
  if (!isOwner) return { ok: false, error: tr(lang, "cmd_auto.owner_only") };
  const pipe = arg.indexOf("|");
  const name = (pipe === -1 ? arg : arg.slice(0, pipe)).trim().toLowerCase();
  const description = (pipe === -1 ? "" : arg.slice(pipe + 1)).trim();
  if (!SKILL_NAME_RE.test(name) || description.length === 0) {
    return { ok: false, error: tr(lang, "cmd_auto.learn.bad_name") };
  }
  if (description.length > 2000) {
    return { ok: false, error: tr(lang, "cmd_auto.bg.too_long") };
  }

  const actor = actorForTelegramUser(deps, sender.telegramId);
  let out: ConversationOutput;
  try {
    out = await deps.engine.respond({
      conversationId: `learn:${sender.userId}:${Date.now()}`,
      userId: sender.userId,
      userText:
        `یک مهارت (skill) جدید طراحی کن و فقط محتوای فایل markdown آن را برگردان — بدون توضیح اضافه.\n` +
        `نام مهارت: ${name}\n` +
        `توضیح مالک: ${description}\n\n` +
        `ساختار فایل: ابتدا frontmatter با فیلدهای name (برابر «${name}») و description (یک جملهٔ فارسی دقیق)، ` +
        `سپس بدنه با بخش‌های: هدف، چه زمانی استفاده شود، مراحل اجرا. ` +
        `متن بدنه فارسی باشد؛ name و ساختار انگلیسی بماند.`,
      actor,
    });
  } catch {
    return { ok: false, error: engineFailed(lang) };
  }
  return { ok: true, fileName: `${name}.md`, markdown: out.chunks.join("\n").trim() };
}

// ---------------------------------------------------------------------------
// /bundles — skill bundles (user, advisory)
// ---------------------------------------------------------------------------

export interface Bundle {
  name: string;
  tools: string[];
  descFa: string;
  descEn: string;
}

export const BUNDLES: Bundle[] = [
  {
    name: "research",
    tools: ["web_search", "fetch_url", "remember"],
    descFa: "پژوهش وب: جستجو، خواندن صفحه، ذخیرهٔ یافته‌ها",
    descEn: "Web research: search, fetch pages, save findings",
  },
  {
    name: "memory",
    tools: ["remember", "recall", "forget"],
    descFa: "کار با حافظهٔ بلندمدت",
    descEn: "Long-term memory work",
  },
  {
    name: "media",
    tools: ["generate_image", "generate_video", "fetch_url"],
    descFa: "تولید و گردآوری رسانه",
    descEn: "Media generation and gathering",
  },
  {
    name: "planning",
    tools: ["add_goal", "list_goals", "schedule_task"],
    descFa: "هدف‌گذاری و زمان‌بندی (شامل ابزارهای مالک)",
    descEn: "Goals and scheduling (includes owner tools)",
  },
];

/** user_prefs key holding the sender's active bundle name. */
export const ACTIVE_BUNDLE_PREF = "active_bundle";

/**
 * /bundles list | use <name> — named tool sets.
 *
 * Advisory only: `use` stores the bundle name in the user's prefs as their
 * active toolkit note. The toolset filter does not honor it yet — the reply
 * says so, so nobody mistakes it for an enforcement mechanism.
 */
export function handleBundles(
  deps: AutoDeps,
  sender: SenderRef,
  arg: string,
  lang: AutoLang = "fa",
): string {
  const tokens = arg.trim().split(/\s+/);
  const sub = (tokens[0] ?? "").toLowerCase();

  if (sub === "list" || sub === "" || sub === "help") {
    const lines = BUNDLES.map((b) =>
      tr(lang, "cmd_auto.bundles.item", {
        name: b.name,
        tools: b.tools.join(" + "),
        desc: lang === "fa" ? b.descFa : b.descEn,
      }),
    );
    return tr(lang, "cmd_auto.bundles.title") + "\n" + lines.join("\n");
  }

  if (sub === "use") {
    const name = (tokens[1] ?? "").toLowerCase();
    const bundle = BUNDLES.find((b) => b.name === name);
    if (!bundle) {
      return tr(lang, "cmd_auto.bundles.unknown", {
        name: tokens[1] ?? "",
        names: BUNDLES.map((b) => b.name).join(", "),
      });
    }
    if (!deps.prefs) return tr(lang, "cmd_auto.bundles.no_prefs");
    try {
      deps.prefs.setUserPref(sender.userId, ACTIVE_BUNDLE_PREF, bundle.name);
    } catch {
      return tr(lang, "cmd_auto.bundles.no_prefs");
    }
    return tr(lang, "cmd_auto.bundles.used", { name: bundle.name });
  }

  return tr(lang, "cmd_auto.bundles.help");
}

// ---------------------------------------------------------------------------
// Registration — thin grammy wrappers
// ---------------------------------------------------------------------------

/** Text after the `/command` (and optional @botname) prefix. */
function commandArg(ctx: { msg?: { text?: string } | undefined }): string {
  const text = ctx.msg?.text ?? "";
  return text.replace(/^\/[a-z0-9_]+(@[a-zA-Z0-9_]+)?\s*/i, "");
}

/** Reply, splitting on Telegram's length limit. Never throws. */
async function replyLong(
  ctx: { reply(text: string): Promise<unknown> },
  text: string,
): Promise<void> {
  for (const chunk of splitForTelegram(text)) {
    try {
      await ctx.reply(chunk);
    } catch {
      // A deleted chat is not an error worth propagating.
      return;
    }
  }
}

function senderOf(ctx: {
  from?: { id: number } | undefined;
  chat?: { id: number | string } | undefined;
}): SenderRef | undefined {
  if (!ctx.from || !ctx.chat) return undefined;
  return {
    userId: String(ctx.from.id),
    telegramId: ctx.from.id,
    chatId: String(ctx.chat.id),
  };
}

/**
 * Register all 19 automation commands. Called by the coordinator from
 * `createBot`; COMMAND_DEFS is merged into the single setMyCommands call.
 *
 * Every wrapper runs the group/user gates first (same as the built-in
 * commands), resolves the sender from the trusted update fields, and keeps
 * its logic in the exported handleXxx function above.
 */
export function registerAutoCommands(bot: Bot, deps: HermesCommandDeps): void {
  const d: AutoDeps = deps;

  // ---- /bg ----
  bot.command("bg", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    const arg = commandArg(ctx);
    const head = arg.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    try {
      if (head === "list") {
        await replyLong(ctx, handleBgList(d, sender, lang));
      } else if (head === "cancel") {
        const id = arg.trim().split(/\s+/).slice(1).join(" ");
        await replyLong(ctx, handleBgCancel(d, sender, id, lang));
      } else if (head === "" || head === "help") {
        await replyLong(ctx, tr(lang, "cmd_auto.bg.help"));
      } else {
        // Delivery goes through the live bot API; a dead chat drops + logs.
        const deliver: BgDeliver = (chatId, text) => bot.api.sendMessage(chatId, text);
        await replyLong(ctx, await handleBgStart(d, sender, arg, deliver, lang));
      }
    } catch {
      await replyLong(ctx, tr(lang, "cmd_auto.tool_failed"));
    }
  });

  // ---- /btw ----
  bot.command("btw", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    try {
      await replyLong(ctx, await handleBtw(d, sender, commandArg(ctx), lang));
    } catch {
      await replyLong(ctx, tr(lang, "cmd_auto.tool_failed"));
    }
  });

  // ---- /queue ----
  bot.command("queue", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    await replyLong(ctx, handleQueue(d, sender, commandArg(ctx), lang));
  });

  // ---- /steer ----
  bot.command("steer", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    try {
      await replyLong(ctx, await handleSteer(d, sender, commandArg(ctx), lang));
    } catch {
      await replyLong(ctx, tr(lang, "cmd_auto.tool_failed"));
    }
  });

  // ---- /agents ----
  bot.command("agents", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    await replyLong(ctx, handleAgents(d, sender, lang));
  });

  // ---- /goal (owner) ----
  bot.command("goal", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    try {
      await replyLong(ctx, await handleGoal(d, sender, isOwnerSender(ctx, deps), commandArg(ctx), lang));
    } catch {
      await replyLong(ctx, tr(lang, "cmd_auto.tool_failed"));
    }
  });

  // ---- /subgoal (owner) ----
  bot.command("subgoal", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    try {
      await replyLong(
        ctx,
        await handleSubgoal(d, sender, isOwnerSender(ctx, deps), commandArg(ctx), lang),
      );
    } catch {
      await replyLong(ctx, tr(lang, "cmd_auto.tool_failed"));
    }
  });

  // ---- /heartbeat (owner) ----
  bot.command("heartbeat", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    try {
      await replyLong(
        ctx,
        await handleHeartbeat(d, sender, isOwnerSender(ctx, deps), commandArg(ctx), lang),
      );
    } catch {
      await replyLong(ctx, tr(lang, "cmd_auto.tool_failed"));
    }
  });

  // ---- /loop (owner) ----
  bot.command("loop", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    try {
      await replyLong(
        ctx,
        await handleLoop(d, sender, isOwnerSender(ctx, deps), commandArg(ctx), lang),
      );
    } catch {
      await replyLong(ctx, tr(lang, "cmd_auto.tool_failed"));
    }
  });

  // ---- /cron (owner) ----
  bot.command("cron", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    try {
      await replyLong(
        ctx,
        await handleCron(d, sender, isOwnerSender(ctx, deps), commandArg(ctx), lang),
      );
    } catch {
      await replyLong(ctx, tr(lang, "cmd_auto.tool_failed"));
    }
  });

  // ---- /suggestions ----
  bot.command("suggestions", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    await replyLong(ctx, handleSuggestions(d, sender, isOwnerSender(ctx, deps), lang));
  });

  // ---- /blueprint ----
  bot.command("blueprint", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    try {
      await replyLong(ctx, await handleBlueprint(d, sender, commandArg(ctx), lang));
    } catch {
      await replyLong(ctx, tr(lang, "cmd_auto.tool_failed"));
    }
  });

  // ---- /refine ----
  bot.command("refine", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    try {
      await replyLong(ctx, tr(lang, "cmd_auto.refine.working"));
      await replyLong(ctx, await handleRefine(d, sender, lang));
    } catch {
      await replyLong(ctx, tr(lang, "cmd_auto.tool_failed"));
    }
  });

  // ---- /review ----
  bot.command("review", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    try {
      await replyLong(ctx, await handleReview(d, sender, commandArg(ctx), lang));
    } catch {
      await replyLong(ctx, tr(lang, "cmd_auto.tool_failed"));
    }
  });

  // ---- /plan ----
  bot.command("plan", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    try {
      await replyLong(ctx, await handlePlan(d, sender, commandArg(ctx), lang));
    } catch {
      await replyLong(ctx, tr(lang, "cmd_auto.tool_failed"));
    }
  });

  // ---- /moa ----
  bot.command("moa", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    try {
      await replyLong(ctx, await handleMoa(d, sender, commandArg(ctx), lang));
    } catch {
      await replyLong(ctx, tr(lang, "cmd_auto.tool_failed"));
    }
  });

  // ---- /memory ----
  bot.command("memory", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    try {
      await replyLong(ctx, await handleMemory(d, sender, commandArg(ctx), lang));
    } catch {
      await replyLong(ctx, tr(lang, "cmd_auto.tool_failed"));
    }
  });

  // ---- /learn (owner) ----
  bot.command("learn", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    try {
      const res = await handleLearn(d, sender, isOwnerSender(ctx, deps), commandArg(ctx), lang);
      if (!res.ok) {
        await replyLong(ctx, res.error);
        return;
      }
      // The draft is delivered as a document for the owner to place — this
      // module never writes into the skills directory itself.
      await replyLong(
        ctx,
        tr(lang, "cmd_auto.learn.ready", { name: res.fileName.replace(/\.md$/, "") }) +
          "\n" +
          tr(lang, "cmd_auto.learn.place_note"),
      );
      await ctx.replyWithDocument(new InputFile(Buffer.from(res.markdown, "utf-8"), res.fileName));
    } catch {
      await replyLong(ctx, tr(lang, "cmd_auto.tool_failed"));
    }
  });

  // ---- /bundles ----
  bot.command("bundles", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    await replyLong(ctx, handleBundles(d, sender, commandArg(ctx), lang));
  });
}
