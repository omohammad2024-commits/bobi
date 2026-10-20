import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, estimatePromptTokens } from "../src/agent/prompt";

const BASE_CTX = {
  tools: [],
  now: new Date("2026-10-18T12:00:00Z"),
  timezone: "Asia/Tehran",
};

/**
 * Extract the PERSONALITY block from the assembled prompt: it runs from the
 * "Personality:" line through the blockquote-convention line.
 */
function personalityBlock(prompt: string): string {
  const lines = prompt.split("\n");
  const start = lines.findIndex((l) => l.startsWith("Personality:"));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex(
    (l, i) => i > start && l.includes("(collapses the quote)."),
  );
  expect(end).toBeGreaterThan(start);
  return lines.slice(start, end + 1).join("\n");
}

describe("personality tuning (worker-3)", () => {
  test("Michael default: cold, dry, heavy, ultra-terse, precise, anti-cliché", () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain("cold");
    expect(prompt).toContain("dry");
    expect(prompt).toContain("heavy");
    expect(prompt).toContain("ultra-terse");
    expect(prompt).toContain("precise");
    expect(prompt).toContain("anti-cliché");
    expect(prompt).toContain("Short imperative sentences");
    expect(prompt).toContain("Zero service-politeness");
    expect(prompt).toContain("no stock phrases");
    expect(prompt).toContain("No sycophancy");
    expect(prompt).toContain("Emoji: max one");
    expect(prompt).toContain("خودمونی");
  });

  test("destructive edge with guardrails: playful, never hostile or insulting", () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain("destructive");
    expect(prompt).toContain("roast bad ideas");
    expect(prompt).toContain("Playful");
    expect(prompt).toContain("never genuinely hostile");
    expect(prompt).toContain("never insulting toward users");
    // Mohammad gets the same voice, but familiar — insider/family, not a stranger.
    expect(prompt).toContain("insider, family, never a stranger");
  });

  test("length: shortest natural answer, greeting nudge, no narration unless asked", () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain("shortest natural answer");
    expect(prompt).toContain("often a few words, one line");
    // Greetings/small talk: dry minimum + brusque get-to-the-point nudge.
    expect(prompt).toContain("سلام. بنال. کارتو بگو.");
    expect(prompt).toContain("No padding, no recap");
    expect(prompt).toContain("no \"here's what I did\" narration unless asked");
    // Expansion only when the task needs it.
    expect(prompt).toContain("Expand only for results, asked-for explanations, or long-form on explicit ask");
  });

  test("brevity survives a personality skin", () => {
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      personality: "Be extra cheerful.",
    });
    expect(prompt).toContain("Be extra cheerful.");
    expect(prompt).toContain("ultra-terse");
    expect(prompt).toContain("shortest natural answer");
    expect(prompt).toContain("سلام. بنال. کارتو بگو.");
  });

  test("the old rigid one-word-in-one-word-out rule is gone", () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).not.toContain("one word in, one word out");
    expect(prompt).not.toContain("Say less, hit harder");
  });

  test("PERSONALITY block stays within the 595-token budget", () => {
    // Raised from 280 by the owner's sharpening order (sparring/mirror-back,
    // indifference, the wall, the escalation arc — his verbatim reference
    // lines cannot fit 280); the block must still practice the brevity it
    // preaches, so the pin tracks the measured size with thin headroom.
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(estimatePromptTokens(personalityBlock(prompt))).toBeLessThanOrEqual(595);
  });

  test("posture: no time to waste, toward everyone — Mohammad gets the full version", () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain("no time to waste");
    expect(prompt).toContain("empty talk gets cut, from everyone");
    // The harshness is the character: applied to Mohammad at full strength,
    // familiarity is recognition — never a softened register.
    expect(prompt).toContain("full version, never softened");
  });

  test("sparring: roast in kind, mirror flipped, one line, no escalation past the mirror", () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain("roast in kind");
    expect(prompt).toContain("mirror their words back flipped");
    expect(prompt).toContain("«دلقک» → «دلقک هم خودتی»");
    expect(prompt).toContain("no escalation past the mirror");
    // Dismissive state-your-business imperatives, in the reference style.
    expect(prompt).toContain("«حرف حسابت چیه؟»");
    expect(prompt).toContain("«یا کارت رو بگو یا پیام نده»");
  });

  test("indifference: no approval-seeking, never softens to please", () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain("no approval-seeking");
    expect(prompt).toContain("never soften to please");
    expect(prompt).toContain("خوشت اومده یا نه برام مهم نیست");
    // Satisfaction-pleasing closers are banned by name.
    expect(prompt).toContain("«امیدوارم راضی باشی» and its kin: never");
  });

  test("the wall: public/clown probing refused; Mohammad's straight questions answered for real", () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain("ANY probing from the public");
    expect(prompt).toContain("«به تو ربطی نداره. فضولی نکن.»");
    // The creator asking straight gets a straight, short, REAL answer —
    // the distinction is framing and intent, never the topic itself.
    expect(prompt).toContain("Mohammad's straight questions about you get straight, short, real answers");
    expect(prompt).toContain("framing and intent decide, not topic");
  });

  test("malformed question: one dry correction plus the door, then it answers a proper re-ask", () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain("«یا سوال درست بپرس یا سکوت کن»");
    expect(prompt).toContain("re-asked properly, answer it");
  });

  test("escalation arc: brush-off → final warning → deadpan fake-ban, repeated flatly", () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain("dry brush-off → «آخرین بارته» → deadpan fake-ban");
    expect(prompt).toContain("«به دلیل لودگی مکرر، ترول و تلف کردن منابع از بات بن شده‌اید»");
    expect(prompt).toContain("repeated flatly if they persist");
  });

  test("the fake-ban is theater only: no real ban, no access change, genuine requests still served", () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain("THEATER ONLY — never a real ban, never access changes");
    expect(prompt).toContain("genuine requests after the bit are served normally");
  });

  test("tone never blocks work; the persona never apologizes for the tone or breaks character", () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    // Harshness lives only in the wrapping words — a real task runs at once,
    // in full, whatever the register is doing.
    expect(prompt).toContain("Tone never blocks work");
    expect(prompt).toContain("real tasks execute immediately, in full");
    expect(prompt).toContain("harshness is wrapping only");
    // Challenged on the tone, the answer is the reference's own line.
    expect(prompt).toContain("«من همینم که هستم»");
    expect(prompt).toContain("never apologize, never break character");
  });

  test("colloquial register: spoken Persian, bookish bans, bad→good example", () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    // Persian is spoken محاوره‌ای: everyday spoken forms named explicitly.
    expect(prompt).toContain("محاوره‌ای");
    expect(prompt).toContain("می‌خوام، می‌تونم، بده، بگو، خب، دیگه");
    expect(prompt).toContain("short lines, fragments ok");
    // Bookish / translation-ese Persian is hard-banned by name.
    expect(prompt).toContain("Never bookish");
    expect(prompt).toContain("می‌باشد");
    expect(prompt).toContain("همچنین");
    expect(prompt).toContain("لذا");
    expect(prompt).toContain("در صورت تمایل");
    // A concrete bad→good pair steers the register better than adjectives.
    expect(prompt).toContain("بد: «همچنین ازش استفاده می‌کنم»");
    expect(prompt).toContain("خوب: «بفرست، می‌گیرمش»");
  });

  test("no form-letter openings: contractions, no Certainly!, no I'd be happy to", () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain("Contractions");
    expect(prompt).toContain("no \"Certainly!\"");
    expect(prompt).toContain("no \"I'd be happy to\"");
    expect(prompt).toContain("Emoji: max one, when it lands");
  });

  test("colloquial register survives a personality skin", () => {
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      personality: "Be extra cheerful.",
    });
    expect(prompt).toContain("Be extra cheerful.");
    expect(prompt).toContain("محاوره‌ای");
    expect(prompt).toContain("Never bookish");
    expect(prompt).toContain("خوب: «بفرست، می‌گیرمش»");
    expect(prompt).toContain("ultra-terse");
  });

  test("owner and group blocks still assemble alongside the new tone", () => {
    const owner = buildSystemPrompt({ ...BASE_CTX, isOwner: true });
    expect(owner).toContain("IS Mohammad");
    expect(owner).toContain("Greet him like family");
    expect(owner).toContain("ultra-terse");
    const group = buildSystemPrompt({ ...BASE_CTX, isGroup: true });
    expect(group).toContain("You are in a Telegram group");
    expect(group).toContain("ultra-terse");
  });
});
