/**
 * Owner profile → prompt wiring (platform Phase 4, worker B).
 *
 * Two layers:
 *  1. Prompt layer: buildSystemPrompt pastes `ownerProfileBlock` ONLY on
 *     a verified-owner turn (isOwner === true) with a non-empty block —
 *     a block handed in for a non-owner turn must NEVER reach the
 *     prompt (privacy pin, defense in depth).
 *  2. Engine layer: ConversationEngine obtains the block from the real
 *     OwnerProfileService over a real (in-memory) Storage — lazy-seeded
 *     once, owner turns only. A public user's turn never seeds, never
 *     renders, and never contains profile text even when a profile
 *     already exists in storage.
 *
 * The engine tests are shape-agnostic about the profile document: the
 * expected block is whatever the real service seeds + the real
 * renderer renders for the same storage (oracle pattern).
 */
import { describe, expect, test } from "bun:test";
import {
  buildSystemPrompt,
  type PromptContext,
} from "../src/agent/prompt";
import {
  ConversationEngine,
  type EngineOptions,
} from "../src/conversation/engine";
import { ToolService } from "../src/tools/service";
import { Storage } from "../src/storage/storage";
import {
  OwnerProfileService,
  renderOwnerProfileBlock,
} from "../src/profile/owner_profile";
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
} from "../src/ai/provider";

const NOW = new Date("2026-10-20T12:00:00+03:30");
const baseCtx = (over: Partial<PromptContext> = {}): PromptContext => ({
  tools: [],
  now: NOW,
  timezone: "Asia/Tehran",
  ...over,
});

/** The framing line prompt.ts puts in front of the pasted block. */
const FRAME = "do NOT recite it back at him unprompted";
/** A sentinel block, shaped like renderer output but unmistakably ours. */
const SENTINEL_BLOCK = [
  "Owner profile — who Mohammad is (the owner, name: Mohammad):",
  "- Basics: PROFILE_SENTINEL_7f3a — terse replies, Tehran-based",
].join("\n");

// ---------- prompt layer ----------

describe("buildSystemPrompt owner profile block", () => {
  test("owner turn + block: block present, framed, right after owner recognition", () => {
    const prompt = buildSystemPrompt(
      baseCtx({ isOwner: true, ownerProfileBlock: SENTINEL_BLOCK }),
    );
    expect(prompt).toContain("PROFILE_SENTINEL_7f3a");
    // Framing: personalization/assumptions/tone, NOT recitation.
    expect(prompt).toContain("Owner profile — who Mohammad is");
    expect(prompt).toContain("personalize");
    expect(prompt).toContain(FRAME);
    // Placement: after the owner-recognition block, before the language rule.
    const recogIdx = prompt.indexOf("IS Mohammad — your verified creator");
    const frameIdx = prompt.indexOf(FRAME);
    const langIdx = prompt.indexOf("RESPONSE LANGUAGE");
    expect(recogIdx).toBeGreaterThan(-1);
    expect(frameIdx).toBeGreaterThan(recogIdx);
    expect(frameIdx).toBeLessThan(langIdx);
  });

  test("PRIVACY PIN: isOwner=false + block passed → block absent", () => {
    const prompt = buildSystemPrompt(
      baseCtx({ isOwner: false, ownerProfileBlock: SENTINEL_BLOCK }),
    );
    expect(prompt).not.toContain("PROFILE_SENTINEL_7f3a");
    expect(prompt).not.toContain(FRAME);
  });

  test("PRIVACY PIN: isOwner absent + block passed → block absent", () => {
    const prompt = buildSystemPrompt(
      baseCtx({ ownerProfileBlock: SENTINEL_BLOCK }),
    );
    expect(prompt).not.toContain("PROFILE_SENTINEL_7f3a");
    expect(prompt).not.toContain(FRAME);
  });

  test("owner turn + empty/whitespace block → nothing pasted, no framing", () => {
    for (const ownerProfileBlock of ["", "   \n  "]) {
      const prompt = buildSystemPrompt(
        baseCtx({ isOwner: true, ownerProfileBlock }),
      );
      expect(prompt).not.toContain(FRAME);
      // Owner recognition itself is unaffected.
      expect(prompt).toContain("IS Mohammad — your verified creator");
    }
  });

  test("owner turn without a block → recognition present, no profile section", () => {
    const prompt = buildSystemPrompt(baseCtx({ isOwner: true }));
    expect(prompt).toContain("IS Mohammad — your verified creator");
    expect(prompt).not.toContain(FRAME);
  });

  test("non-owner prompt never contains profile text (incl. group turns)", () => {
    for (const over of [
      { isOwner: false },
      { isOwner: false, isGroup: true },
      { isGroup: true },
      {},
    ] as const) {
      const prompt = buildSystemPrompt(
        baseCtx({ ...over, ownerProfileBlock: SENTINEL_BLOCK }),
      );
      expect(prompt).not.toContain("PROFILE_SENTINEL_7f3a");
      expect(prompt).not.toContain(FRAME);
    }
  });
});

// ---------- engine layer ----------

const OWNER = "4242";
const PUBLIC = "9999";

/** Provider that plays back a fixed answer, recording every request. */
class ScriptedProvider implements AiProvider {
  readonly name = "scripted";
  readonly requests: CompletionRequest[] = [];
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(req);
    return { text: "test answer", model: "m" };
  }
}

function makeEngine(
  provider: AiProvider,
  storage: Storage,
  overrides: Partial<EngineOptions> = {},
) {
  return new ConversationEngine({
    provider,
    model: "m",
    timeoutMs: 5_000,
    maxConcurrent: 4,
    tools: new ToolService(),
    storage,
    timezone: "Asia/Tehran",
    summariseHistory: false,
    ...overrides,
  });
}

function systemPromptOf(provider: ScriptedProvider, requestIndex = 0): string {
  const req = provider.requests[requestIndex];
  const system = req?.messages.find((m) => m.role === "system");
  return system?.content ?? "";
}

/**
 * Storage whose owner has one classifiable memory (plus a stranger's
 * memory that must never seed or leak). Returns the block the real
 * service + renderer produce for it.
 */
function seededFixture(): { storage: Storage; expectedBlock: string } {
  const storage = Storage.open(":memory:");
  storage.upsertMemory({
    userId: OWNER,
    key: "project:bobi",
    content: "Project BOBI: Telegram agent bot in TypeScript",
  });
  storage.upsertMemory({
    userId: PUBLIC,
    key: "project:other",
    content: "Project belonging to someone else",
  });
  const { profile } = new OwnerProfileService(storage).ensureSeeded(OWNER);
  return { storage, expectedBlock: renderOwnerProfileBlock(profile) };
}

describe("engine owner-profile seam", () => {
  test("owner turn prompt contains the seeded profile block, framed", async () => {
    const { storage, expectedBlock } = seededFixture();
    expect(expectedBlock.length).toBeGreaterThan(0); // seed carries facts
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider, storage);
    const out = await engine.respond({
      // conversationId deliberately ≠ userId: the seam must key the
      // profile by the storage user id (input.userId), not the chat id.
      conversationId: "777",
      userId: OWNER,
      userText: "hi",
      isOwner: true,
      actor: { userId: OWNER, permissions: [] },
    });
    expect(out.chunks.join("")).toContain("test answer");
    const prompt = systemPromptOf(provider);
    expect(prompt).toContain(FRAME);
    expect(prompt).toContain(expectedBlock.trim());
    // The memory-derived fact proves ensureSeeded ran under OWNER's id:
    // keyed by any other id, this memory would not have seeded.
    expect(prompt).toContain("Telegram agent bot in TypeScript");
    // The stranger's memory never seeds the owner's profile.
    expect(prompt).not.toContain("Project belonging to someone else");
    storage.close();
  });

  test("a public user's turn never contains profile text — even with a profile in storage", async () => {
    const { storage, expectedBlock } = seededFixture();
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider, storage);
    // Owner turn first, so the profile path is warm in this engine.
    await engine.respond({
      conversationId: OWNER,
      userId: OWNER,
      userText: "hi",
      isOwner: true,
      actor: { userId: OWNER, permissions: [] },
    });
    expect(systemPromptOf(provider, 0)).toContain(expectedBlock.trim());

    await engine.respond({
      conversationId: PUBLIC,
      userId: PUBLIC,
      userText: "hello",
      actor: { userId: PUBLIC, permissions: [] },
    });
    const publicPrompt = systemPromptOf(provider, 1);
    expect(publicPrompt).not.toContain(FRAME);
    expect(publicPrompt).not.toContain(expectedBlock.trim());
    // The rendered seed fact as a sentence — distinct from the base
    // prompt's creator-identity line, which every prompt carries.
    expect(publicPrompt).not.toContain("Mohammad is the creator and father of Bobi.");
    expect(publicPrompt).not.toContain("Telegram agent bot in TypeScript");
    storage.close();
  });

  test("non-owner turns never seed; owner turns seed exactly once per engine", async () => {
    const storage = Storage.open(":memory:");
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider, storage);

    const original = OwnerProfileService.prototype.ensureSeeded;
    const calls: string[] = [];
    OwnerProfileService.prototype.ensureSeeded = function (
      this: OwnerProfileService,
      ownerUserId: string,
    ) {
      calls.push(ownerUserId);
      return original.call(this, ownerUserId);
    };
    try {
      await engine.respond({
        conversationId: PUBLIC,
        userId: PUBLIC,
        userText: "hello",
        actor: { userId: PUBLIC, permissions: [] },
      });
      expect(calls).toEqual([]); // public turn: no seeding at all

      await engine.respond({
        conversationId: OWNER,
        userId: OWNER,
        userText: "hi",
        isOwner: true,
        actor: { userId: OWNER, permissions: [] },
      });
      expect(calls).toEqual([OWNER]); // seeded once, under the owner's id

      await engine.respond({
        conversationId: OWNER,
        userId: OWNER,
        userText: "again",
        isOwner: true,
        actor: { userId: OWNER, permissions: [] },
      });
      expect(calls).toEqual([OWNER]); // second owner turn: load, no re-seed
      // …and the block still reaches the prompt on the load path.
      const lastPrompt = systemPromptOf(provider, provider.requests.length - 1);
      expect(lastPrompt).toContain(FRAME);
    } finally {
      OwnerProfileService.prototype.ensureSeeded = original;
      storage.close();
    }
  });

  test("profile failure degrades silently: the turn still answers, without the block", async () => {
    const storage = Storage.open(":memory:");
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider, storage);

    const original = OwnerProfileService.prototype.ensureSeeded;
    OwnerProfileService.prototype.ensureSeeded = () => {
      throw new Error("profile store down");
    };
    try {
      const out = await engine.respond({
        conversationId: OWNER,
        userId: OWNER,
        userText: "hi",
        isOwner: true,
        actor: { userId: OWNER, permissions: [] },
      });
      expect(out.chunks.join("")).toContain("test answer");
      expect(systemPromptOf(provider)).not.toContain(FRAME);
    } finally {
      OwnerProfileService.prototype.ensureSeeded = original;
      storage.close();
    }
  });
});
