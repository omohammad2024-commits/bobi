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
  test("natural, warm, witty-when-apt phrasing is present", () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain("text like a real person, not a bot");
    expect(prompt).toContain("Witty when the vibe invites it");
    expect(prompt).toContain("never forced");
    expect(prompt).toContain("warm and familiar like a sharp friend");
    expect(prompt).toContain("never cold");
    expect(prompt).toContain("no sycophancy");
    expect(prompt).toContain("Emoji: max one");
    expect(prompt).toContain("خودمونی");
    expect(prompt).toContain("match the user's energy");
  });

  test("the old rigid one-word-in-one-word-out rule is gone", () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).not.toContain("one word in, one word out");
    expect(prompt).not.toContain("Say less, hit harder");
  });

  test("PERSONALITY block stays within the 180-token budget", () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(estimatePromptTokens(personalityBlock(prompt))).toBeLessThanOrEqual(180);
  });

  test("owner and group blocks still assemble alongside the new tone", () => {
    const owner = buildSystemPrompt({ ...BASE_CTX, isOwner: true });
    expect(owner).toContain("IS Mohammad");
    expect(owner).toContain("Greet him like family");
    expect(owner).toContain("text like a real person");
    const group = buildSystemPrompt({ ...BASE_CTX, isGroup: true });
    expect(group).toContain("You are in a Telegram group");
    expect(group).toContain("text like a real person");
  });
});
