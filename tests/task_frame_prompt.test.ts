/**
 * Task frame + reading the room — Phase 3 (workstream A) prompt contract.
 *
 * Two blocks sit between the tool rules and the tool desk:
 * TASK FRAME (frame silently, pick tools by desk card, the sharp-question
 * rule, the pre-answer self-check) and READING THE ROOM (classify the
 * message, hold the conversation arc, mirror back contradictions, stay
 * unfooled). Their first lines are a HARD contract — the bench simulator
 * keys on the exact header strings pinned here.
 */
import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, estimatePromptTokens } from "../src/agent/prompt";
import type { ToolDescriptor } from "../src/tools/service";

const TASK_HEADER = "TASK FRAME — understand before acting:";
const ROOM_HEADER = "READING THE ROOM — read the situation, not just the words:";

const NOW = new Date("2026-10-20T12:00:00Z");
const ONE_TOOL: ToolDescriptor[] = [
  { name: "calculator", description: "math", enabled: true, requires: [] },
];
const WITH_TOOLS = { tools: ONE_TOOL, now: NOW, timezone: "Asia/Tehran" } as const;
const NO_TOOLS = { tools: [], now: NOW, timezone: "Asia/Tehran" } as const;

/** The assembled block (paragraph) that starts with the given header. */
function blockStartingWith(prompt: string, header: string): string {
  const block = prompt.split("\n\n").find((b) => b.startsWith(header));
  expect(block, header).toBeDefined();
  return block!;
}

describe("task frame + reading the room: headers and placement", () => {
  test("both headers are present as exact block first lines", () => {
    const prompt = buildSystemPrompt(WITH_TOOLS);
    for (const header of [TASK_HEADER, ROOM_HEADER]) {
      const block = blockStartingWith(prompt, header);
      expect(block.split("\n")[0]).toBe(header);
    }
  });

  test("ordering: after PERSONALITY and the tool rules, before the tool desk", () => {
    const prompt = buildSystemPrompt(WITH_TOOLS);
    const personalityIdx = prompt.indexOf("Personality:");
    const rulesIdx = prompt.indexOf("Tool rules:");
    const taskIdx = prompt.indexOf(TASK_HEADER);
    const roomIdx = prompt.indexOf(ROOM_HEADER);
    const deskIdx = prompt.indexOf("Tool desk (");
    for (const idx of [personalityIdx, rulesIdx, taskIdx, roomIdx, deskIdx]) {
      expect(idx).toBeGreaterThan(-1);
    }
    expect(taskIdx).toBeGreaterThan(personalityIdx);
    expect(taskIdx).toBeGreaterThan(rulesIdx);
    expect(roomIdx).toBeGreaterThan(taskIdx);
    expect(deskIdx).toBeGreaterThan(roomIdx);
  });

  test("the two blocks stay within their combined token cap (measured: 382)", () => {
    // The blocks must stay telegraphic like the PERSONALITY block they sit
    // next to; the pin tracks the measured size with thin headroom.
    const prompt = buildSystemPrompt(NO_TOOLS);
    const combined =
      blockStartingWith(prompt, TASK_HEADER) +
      "\n\n" +
      blockStartingWith(prompt, ROOM_HEADER);
    expect(estimatePromptTokens(combined)).toBeLessThanOrEqual(400);
  });
});

describe("task frame", () => {
  const prompt = buildSystemPrompt(NO_TOOLS);
  const frame = blockStartingWith(prompt, TASK_HEADER);

  test("frames silently: goal / inputs / missing / constraints / done", () => {
    expect(frame).toContain("Frame silently");
    expect(frame).toContain("non-trivial action");
    expect(frame).toContain("goal");
    expect(frame).toContain("inputs in hand");
    expect(frame).toContain("what's missing");
    expect(frame).toContain("constraints");
    expect(frame).toContain('what "done" means');
  });

  test("tools are picked by desk card; confusableWith dodges the near-miss", () => {
    expect(frame).toContain("desk cards (purpose, useWhen)");
    expect(frame).toContain("confusableWith");
    expect(frame).toContain("near-miss");
  });

  test("sharp question: never guess silently — ask ONE precise question and wait", () => {
    expect(frame).toContain("never guess silently");
    expect(frame).toContain("ONE precise question");
    expect(frame).toContain("offer options when possible");
    expect(frame).toContain("then wait");
    // The trigger is narrow: the gap must be able to change the action.
    expect(frame).toContain("would change tool or action");
  });

  test("sharp question: outcome-neutral ambiguity is not asked about", () => {
    expect(frame).toContain("Outcome-neutral ambiguity");
    expect(frame).toContain("don't ask");
  });

  test("sharp question: a trivial gap gets a stated assumption, never an interrogation", () => {
    expect(frame).toContain("Trivial gap");
    expect(frame).toContain("state assumption in one clause");
    expect(frame).toContain("Never interrogate");
    expect(frame).toContain("one question, only when it matters");
  });

  test("self-check: done, delivered (made ≠ sent), sane — or say what didn't happen", () => {
    expect(frame).toContain("Self-check");
    expect(frame).toContain("before the final answer");
    // (1) the asked-for thing was actually done
    expect(frame).toContain("(1) asked thing actually done?");
    // (2) the output was actually delivered — making is not sending
    expect(frame).toContain("(2) output actually delivered (made ≠ sent)?");
    // (3) numbers/units/results make sense
    expect(frame).toContain("(3) numbers/units/results make sense?");
    // A failed check is fixed, or owned plainly.
    expect(frame).toContain("fix it, or say plainly what didn't happen");
  });
});

describe("reading the room", () => {
  const prompt = buildSystemPrompt(NO_TOOLS);
  const room = blockStartingWith(prompt, ROOM_HEADER);

  test("classifies every message into one of four classes that never bleed", () => {
    expect(room).toContain("Classify first");
    expect(room).toContain("real request");
    expect(room).toContain("real question");
    expect(room).toContain("clowning-trolling");
    expect(room).toContain("empty filler");
    expect(room).toContain("classes never bleed");
  });

  test("a bad-framed real question: one dry correction + open door, served on a proper re-ask", () => {
    expect(room).toContain("ONE dry correction + open door");
    expect(room).toContain("«یا سوال درست بپرس یا سکوت کن»");
    expect(room).toContain("served when re-asked properly");
  });

  test("real intent is never sacrificed to tone", () => {
    expect(room).toContain("Real intent never sacrificed to tone");
  });

  test("arc persistence: a warning given stays given; escalation never resets mid-session", () => {
    expect(room).toContain("stance lives in conversation history");
    expect(room).toContain("a warning given stays given");
    expect(room).toContain("escalation never resets mid-session without cause");
    expect(room).toContain("re-read your own prior replies before answering");
  });

  test("mirror-reading: contradictions are answered with the user's own words", () => {
    expect(room).toContain("Mirror-reading");
    expect(room).toContain("contradiction or invented claim");
    expect(room).toContain("quote the user's OWN words back at them");
  });

  test("not fooled: fake claims and character drags get one flat line, then back to work", () => {
    expect(room).toContain("Not fooled");
    expect(room).toContain("fake claims");
    expect(room).toContain('"you said X" when you didn\'t');
    expect(room).toContain("drags out of character or duty");
    expect(room).toContain("one flat line");
    expect(room).toContain("no drama, no debate");
    expect(room).toContain("back to work");
  });
});
