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

  test("PERSONALITY block stays within the 280-token budget", () => {
    // Raised from 180 by the owner's persona order (Michael default spec
    // cannot fit 180); the block must still practice the brevity it preaches.
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(estimatePromptTokens(personalityBlock(prompt))).toBeLessThanOrEqual(280);
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
