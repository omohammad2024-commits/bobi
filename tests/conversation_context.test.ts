import { describe, expect, test } from "bun:test";
import { ConversationEngine } from "../src/conversation/engine";
import type {
  AiProvider,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
} from "../src/ai/provider";
import {
  ASSISTANT_SPEAKER_NAME,
  UNKNOWN_GROUP_SPEAKER,
  extractSpeakerLabel,
  formatHistoryForModel,
  hasSpeakerLabel,
  labelAssistantTurn,
  labelUserTurn,
  sanitizeSpeakerName,
  withSpeakerLabel,
} from "../src/conversation/speakers";
import {
  BASE_SCORE,
  FACT_SCORE,
  FILLER_SCORE,
  PINNED_SCORE,
  defaultImportance,
  isCorrectionMessage,
  isFactOrDecision,
  isFiller,
  prioritizeHistory,
} from "../src/conversation/prioritize";

const u = (content: string): ChatMessage => ({ role: "user", content });
const a = (content: string): ChatMessage => ({ role: "assistant", content });
const sys = (content: string): ChatMessage => ({ role: "system", content });

describe("speaker labels", () => {
  test("group: every role gets an explicit label, never bare text", () => {
    expect(withSpeakerLabel("user", "سلام", { isGroup: true })).toBe("[Member]: سلام");
    expect(withSpeakerLabel("assistant", "hey", { isGroup: true })).toBe("[Bobi]: hey");
  });

  test("private: user stays bare, assistant is marked as the bot's own", () => {
    expect(withSpeakerLabel("user", "سلام", { isGroup: false })).toBe("سلام");
    expect(withSpeakerLabel("assistant", "hey", { isGroup: false })).toBe("[Bobi]: hey");
  });

  test("system and tool turns are never speaker-labeled", () => {
    expect(withSpeakerLabel("system", "summary…", { isGroup: true })).toBe("summary…");
    expect(withSpeakerLabel("tool", "result", { isGroup: true })).toBe("result");
  });

  test("labeling is idempotent — never double-labels", () => {
    expect(withSpeakerLabel("user", "[Sara]: سلام", { isGroup: true })).toBe("[Sara]: سلام");
    expect(withSpeakerLabel("assistant", "[Bobi]: hey", { isGroup: false })).toBe(
      "[Bobi]: hey",
    );
    expect(
      withSpeakerLabel("user", "[Sara]: hi", { isGroup: true, senderName: "Mohammad" }),
    ).toBe("[Sara]: hi");
  });

  test("labelUserTurn uses the trusted sender name only for the live turn", () => {
    expect(labelUserTurn("hi", { isGroup: true, senderName: "Sara" })).toBe("[Sara]: hi");
    expect(labelUserTurn("hi", { isGroup: true })).toBe(`[${UNKNOWN_GROUP_SPEAKER}]: hi`);
    expect(labelUserTurn("hi", { isGroup: false, senderName: "Sara" })).toBe("hi");
  });

  test("labelAssistantTurn always marks the bot's own reply", () => {
    expect(labelAssistantTurn("done")).toBe(`[${ASSISTANT_SPEAKER_NAME}]: done`);
  });

  test("sanitizeSpeakerName strips label-breaking characters", () => {
    expect(sanitizeSpeakerName("Sara\n[Evil]: ")).toBe("SaraEvil:");
    expect(sanitizeSpeakerName("   ")).toBe(UNKNOWN_GROUP_SPEAKER);
    expect(sanitizeSpeakerName("")).toBe(UNKNOWN_GROUP_SPEAKER);
    expect(sanitizeSpeakerName("a".repeat(100)).length).toBe(40);
  });

  test("hasSpeakerLabel / extractSpeakerLabel", () => {
    expect(hasSpeakerLabel("[Sara]: hi")).toBe(true);
    expect(hasSpeakerLabel("hi")).toBe(false);
    expect(hasSpeakerLabel("[not closed: hi")).toBe(false);
    expect(extractSpeakerLabel("[Sara]: hi")).toBe("Sara");
    expect(extractSpeakerLabel("hi")).toBeUndefined();
  });

  test("formatHistoryForModel never misattributes old turns to the current sender", () => {
    const history = [u("old message from someone else"), a("old reply")];
    const out = formatHistoryForModel(history, { isGroup: true });
    // The unlabeled group user message gets the generic fallback — NOT the
    // current sender's name — so nobody is impersonated.
    expect(out[0]!.content).toBe("[Member]: old message from someone else");
    expect(out[1]!.content).toBe("[Bobi]: old reply");
    // Input untouched.
    expect(history[0]!.content).toBe("old message from someone else");
  });

  test("formatHistoryForModel does not mutate its input", () => {
    const history = [u("hi"), a("hey")];
    const snapshot = history.map((m) => m.content);
    formatHistoryForModel(history, { isGroup: true });
    expect(history.map((m) => m.content)).toEqual(snapshot);
  });
});

describe("prioritizeHistory", () => {
  test("short history passes through unchanged and in order", () => {
    const history = [u("a"), a("b"), u("c")];
    const out = prioritizeHistory(history, { budget: 50 });
    expect(out.map((m) => m.content)).toEqual(["a", "b", "c"]);
    expect(out).not.toBe(history);
  });

  test("zero budget returns nothing", () => {
    expect(prioritizeHistory([u("a")], { budget: 0 })).toEqual([]);
  });

  test("keeps the recent window verbatim and chronological", () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) history.push(i % 2 === 0 ? u(`q${i}`) : a(`r${i}`));
    const out = prioritizeHistory(history, { budget: 12, recentMessages: 10 });
    expect(out).toHaveLength(12);
    const contents = out.map((m) => m.content);
    // Chronological order preserved …
    expect([...contents].sort()).not.toEqual(contents); // sanity: not alpha-sorted
    for (let i = 1; i < contents.length; i++) {
      expect(history.findIndex((m) => m.content === contents[i - 1])).toBeLessThan(
        history.findIndex((m) => m.content === contents[i]),
      );
    }
    // … and the last 10 are exactly the tail, verbatim.
    expect(contents.slice(-10)).toEqual(history.slice(-10).map((m) => m.content));
  });

  test("a user-stated fact in the middle survives while filler is dropped", () => {
    const history: ChatMessage[] = [u("my name is Sara")];
    for (let i = 0; i < 30; i++) history.push(i % 2 === 0 ? u("باشه") : a("ok"));
    const out = prioritizeHistory(history, { budget: 12, recentMessages: 10 });
    expect(out.map((m) => m.content)).toContain("my name is Sara");
    expect(out).toHaveLength(12);
  });

  test("a correction pins the statement it corrects — the pair survives", () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 20; i++) history.push(i % 2 === 0 ? u("باشه") : a("ok"));
    history.push(a("your name is Mohammad")); // the wrong statement
    history.push(u("نه اشتباهه، اسمم ساراست")); // the correction
    for (let i = 0; i < 20; i++) history.push(i % 2 === 0 ? u("باشه") : a("ok"));
    const out = prioritizeHistory(history, { budget: 12, recentMessages: 8 });
    const contents = out.map((m) => m.content);
    expect(contents).toContain("your name is Mohammad");
    expect(contents).toContain("نه اشتباهه، اسمم ساراست");
  });

  test("under extreme pressure the correction survives, never the original alone", () => {
    const history = [a("your name is Mohammad"), u("that's wrong, I'm Sara")];
    const out = prioritizeHistory(history, { budget: 1, recentMessages: 0 });
    expect(out).toHaveLength(1);
    // The forbidden outcome is keeping the wrong statement while dropping the
    // correction. The correction (newer) must win the tie.
    expect(out[0]!.content).toBe("that's wrong, I'm Sara");
  });

  test("the rolling summary is always kept", () => {
    const history: ChatMessage[] = [sys("خلاصهٔ گفت‌وگوی قبلی:\n…")];
    for (let i = 0; i < 30; i++) history.push(i % 2 === 0 ? u("باشه") : a("ok"));
    const out = prioritizeHistory(history, { budget: 6, recentMessages: 4 });
    expect(out[0]).toBe(history[0]);
  });

  test("a custom scorer is respected", () => {
    const history = [u("keep me"), u("drop me"), u("recent")];
    const out = prioritizeHistory(history, {
      budget: 2,
      recentMessages: 1,
      importanceOf: (m) => (m.content === "keep me" ? 0.9 : 0.1),
    });
    expect(out.map((m) => m.content)).toEqual(["keep me", "recent"]);
  });

  test("correction pairing applies even on top of a custom scorer", () => {
    const history = [a("wrong fact"), u("نه اشتباهه"), u("باشه"), u("ok")];
    const out = prioritizeHistory(history, {
      budget: 3,
      recentMessages: 2,
      importanceOf: () => 0.1,
    });
    const contents = out.map((m) => m.content);
    expect(contents).toContain("wrong fact");
    expect(contents).toContain("نه اشتباهه");
  });
});

describe("importance heuristics", () => {
  test("isCorrectionMessage: Persian and English cues", () => {
    expect(isCorrectionMessage("نه اشتباهه")).toBe(true);
    expect(isCorrectionMessage("غلطه، این درست نیست")).toBe(true);
    expect(isCorrectionMessage("that's wrong")).toBe(true);
    expect(isCorrectionMessage("You're wrong about that")).toBe(true);
    expect(isCorrectionMessage("ok")).toBe(false);
    expect(isCorrectionMessage("نه")).toBe(false);
    expect(isCorrectionMessage("what's the weather")).toBe(false);
  });

  test("isFactOrDecision", () => {
    expect(isFactOrDecision("my name is Sara")).toBe(true);
    expect(isFactOrDecision("یادت باشه تولدم نزدیکه")).toBe(true);
    expect(isFactOrDecision("we decided to ship Friday")).toBe(true);
    expect(isFactOrDecision("hello")).toBe(false);
  });

  test("isFiller", () => {
    expect(isFiller("باشه")).toBe(true);
    expect(isFiller("ok")).toBe(true);
    expect(isFiller("👍")).toBe(true);
    expect(isFiller("hello there")).toBe(false);
  });

  test("defaultImportance tiers", () => {
    expect(defaultImportance(sys("s"), 0, [])).toBe(PINNED_SCORE);
    expect(defaultImportance(u("نه اشتباهه"), 0, [])).toBe(PINNED_SCORE);
    expect(defaultImportance(u("my name is Sara"), 0, [])).toBe(FACT_SCORE);
    expect(defaultImportance(u("باشه"), 0, [])).toBe(FILLER_SCORE);
    expect(defaultImportance(u("what time is it"), 0, [])).toBe(BASE_SCORE);
  });
});

describe("engine: speaker labels end to end", () => {
  /** Provider that records the request it received and answers "ack". */
  function capturingProvider() {
    const requests: CompletionRequest[] = [];
    const provider: AiProvider = {
      name: "capture",
      async complete(req: CompletionRequest): Promise<CompletionResponse> {
        requests.push(req);
        return { text: "ack", model: "x" };
      },
    };
    return { provider, requests };
  }

  test("group turns are stored with speaker labels; the model sees labels everywhere", async () => {
    const { provider, requests } = capturingProvider();
    const eng = new ConversationEngine({
      provider,
      model: "x",
      timeoutMs: 5_000,
      maxConcurrent: 4,
    });
    await eng.respond({
      conversationId: "g1",
      userText: "سلام",
      isGroup: true,
      senderName: "Sara",
    });
    // Stored transcript keeps the label.
    const stored = eng.getHistory("g1");
    expect(stored[0]!.content).toBe("[Sara]: سلام");
    expect(stored[1]!.content).toBe("[Bobi]: ack");

    await eng.respond({
      conversationId: "g1",
      userText: "خوبی؟",
      isGroup: true,
      senderName: "Mohammad",
    });
    const seen = requests[1]!.messages;
    // History: both speakers labeled, the bot's own reply marked as its own.
    expect(seen[0]!.content).toBe("[Sara]: سلام");
    expect(seen[1]!.content).toBe("[Bobi]: ack");
    // The live turn carries the current sender's label.
    expect(seen[2]!.content).toBe("[Mohammad]: خوبی؟");
    expect(seen[2]!.role).toBe("user");
  });

  test("group without a sender name falls back to [Member], never bare", async () => {
    const { provider, requests } = capturingProvider();
    const eng = new ConversationEngine({
      provider,
      model: "x",
      timeoutMs: 5_000,
      maxConcurrent: 4,
    });
    await eng.respond({ conversationId: "g2", userText: "hi", isGroup: true });
    expect(requests[0]!.messages.at(-1)!.content).toBe("[Member]: hi");
    expect(eng.getHistory("g2")[0]!.content).toBe("[Member]: hi");
  });

  test("private chats stay clean in storage; the model still sees the bot's label", async () => {
    const { provider, requests } = capturingProvider();
    const eng = new ConversationEngine({
      provider,
      model: "x",
      timeoutMs: 5_000,
      maxConcurrent: 4,
    });
    await eng.respond({ conversationId: "p1", userText: "سلام" });
    await eng.respond({ conversationId: "p1", userText: "چطوری" });
    // Storage is unlabeled in private.
    const stored = eng.getHistory("p1");
    expect(stored.map((m) => m.content)).toEqual(["سلام", "ack", "چطوری", "ack"]);
    // The model sees: bare user turns, labeled assistant turns.
    const seen = requests[1]!.messages.map((m) => m.content);
    expect(seen).toEqual(["سلام", "[Bobi]: ack", "چطوری"]);
  });

  test("in-memory history is bounded by the limit on the request", async () => {
    const { provider, requests } = capturingProvider();
    const eng = new ConversationEngine({
      provider,
      model: "x",
      timeoutMs: 5_000,
      maxConcurrent: 4,
      historyLimit: 10,
    });
    for (let i = 0; i < 20; i++) {
      await eng.respond({ conversationId: "p2", userText: `m${i}` });
    }
    // 40 turns were committed, but the model never sees more than the window
    // (10 history + the live turn) — the in-memory path used to be unbounded.
    const last = requests[requests.length - 1]!.messages;
    expect(last.length).toBeLessThanOrEqual(11);
    // And the tail is verbatim: the newest turns are all there.
    expect(last.at(-1)!.content).toBe("m19");
  });
});
