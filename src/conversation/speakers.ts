/**
 * Speaker attribution for conversation history.
 *
 * Background: in group chats several humans share one "user" role, and some
 * models get confused about who said what — the reported mimicry bug had the
 * model echoing the user back. Bare text is ambiguous; an explicit `[Name]:`
 * label on every turn is not.
 *
 * Two layers, both pure and idempotent:
 *
 * 1. Commit-time (engine.commitTurn): in groups, each stored turn is prefixed
 *    with its speaker (`[Sara]: hi`, `[Bobi]: hey`) using the trusted
 *    `senderName` the caller resolved server-side. The persisted transcript
 *    therefore knows who said what forever — no schema change needed, and old
 *    rows simply stay unlabeled.
 * 2. Request-time (formatHistoryForModel / labelUserTurn): whatever reaches
 *    the model gets a label check. Assistant turns are always marked as the
 *    bot's own (`[Bobi]:`), group user turns always carry a speaker label
 *    (falling back to `[Member]:` when the name was never recorded), and
 *    private user turns stay bare — one human is talking, every assistant
 *    turn is labeled, so a bare user turn is unambiguous.
 *
 * Both layers check `hasSpeakerLabel` first, so re-labeling is a no-op: a
 * message labeled at commit time is never double-labeled at request time.
 */
import type { ChatMessage, ChatRole } from "../ai/provider";

/**
 * Display name used for the bot's own turns. Matches the identity block in
 * src/agent/prompt.ts ("You are Bobi, an all-purpose agent...").
 */
export const ASSISTANT_SPEAKER_NAME = "Bobi";

/**
 * Fallback label for a group user message whose sender name was never
 * recorded (legacy rows, or a caller that did not pass `senderName`).
 */
export const UNKNOWN_GROUP_SPEAKER = "Member";

/**
 * `[Name]:` at the very start of a message — the label format both layers
 * produce and recognise.
 */
const SPEAKER_LABEL_RE = /^\[([^\][\n]{1,60})\]:\s?/;

/** True when the content already carries a speaker label. */
export function hasSpeakerLabel(content: string): boolean {
  return SPEAKER_LABEL_RE.test(content);
}

/**
 * The speaker label for a labeled message, e.g. `[Sara]` — or undefined when
 * the message carries no label.
 */
export function extractSpeakerLabel(content: string): string | undefined {
  const m = SPEAKER_LABEL_RE.exec(content);
  return m?.[1];
}

/**
 * Clean a raw display name for use inside a `[Name]:` label.
 *
 * Display names come from the chat platform and are untrusted: newlines would
 * break the label onto its own line and brackets would fake the label format,
 * so both are stripped. Falls back to `UNKNOWN_GROUP_SPEAKER` when nothing
 * usable remains.
 */
export function sanitizeSpeakerName(name: string): string {
  const cleaned = name
    .replace(/[\[\]\n\r]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : UNKNOWN_GROUP_SPEAKER;
}

/** `[Name]: `, with the name sanitised. */
export function speakerTag(name: string): string {
  return `[${sanitizeSpeakerName(name)}]: `;
}

export interface LabelOptions {
  /** True in group chats: every message gets a label, never bare text. */
  isGroup: boolean;
  /**
   * Sender of the live turn. Only meaningful for the current user message —
   * never applied to history, where each row already carries (or lacks) its
   * own label and guessing would misattribute old turns.
   */
  senderName?: string | undefined;
}

/**
 * Label one message's content for the model. Pure and idempotent.
 *
 * - Already-labeled content passes through untouched.
 * - `assistant` turns are always labeled `[Bobi]:` — in groups AND private.
 *   This is the anti-mimicry rule: the model can never mistake its own past
 *   reply for something the user said.
 * - `user` turns in groups are always labeled (`[Sara]:` or `[Member]:`);
 *   in private they stay bare, which is unambiguous next to labeled
 *   assistant turns.
 * - `system` and `tool` turns are already role-delimited for the provider; a
 *   speaker label would only muddy them.
 */
export function withSpeakerLabel(
  role: ChatRole,
  content: string,
  opts: LabelOptions,
): string {
  if (hasSpeakerLabel(content)) return content;
  switch (role) {
    case "assistant":
      return `${speakerTag(ASSISTANT_SPEAKER_NAME)}${content}`;
    case "user":
      if (!opts.isGroup) return content;
      return `${speakerTag(opts.senderName ?? UNKNOWN_GROUP_SPEAKER)}${content}`;
    default:
      return content;
  }
}

/**
 * Label a stored history for the model request. Pure: returns copies, never
 * mutates its input (the engine reuses the stored array across turns).
 *
 * Note the deliberate absence of `senderName` here: history rows keep their
 * own labels. An unlabeled group user message gets the `[Member]:` fallback
 * rather than the current sender's name, because attributing Sara's old
 * message to Mohammad would be worse than a generic label.
 */
export function formatHistoryForModel(
  history: readonly ChatMessage[],
  opts: { isGroup: boolean },
): ChatMessage[] {
  return history.map((m) => {
    const content = withSpeakerLabel(m.role, m.content, { isGroup: opts.isGroup });
    return content === m.content ? m : { ...m, content };
  });
}

/**
 * Label the live user turn. This is the ONLY place `senderName` is used:
 * the caller resolved it server-side (e.g. Telegram `from.first_name`), so it
 * is trusted, unlike anything the model or the chat text could claim.
 */
export function labelUserTurn(content: string, opts: LabelOptions): string {
  return withSpeakerLabel("user", content, opts);
}

/** Label the bot's reply for group storage (`[Bobi]: ...`). */
export function labelAssistantTurn(content: string): string {
  return withSpeakerLabel("assistant", content, { isGroup: true });
}
