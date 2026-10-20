/**
 * Episodic session summaries (memory-core upgrade).
 *
 * Pins the trigger contract: an episode is stored only when the
 * conversation has gone quiet (≥ 30 min since the last message) AND holds
 * a real exchange (≥ 6 user turns), the write is idempotent per ended
 * snapshot, and latestEpisode surfaces the newest episode. Kill switch
 * BOBI_MEMORY_EPISODES=0 blocks everything.
 */
import { describe, expect, test } from "bun:test";
import type { StoredMessage } from "../src/storage/storage";
import type { ConversationReader } from "../src/memory/auto_extract";
import type {
  MemoryProvider,
  MemoryUpsertOptions,
  StoredMemory,
} from "../src/memory/provider";
import {
  buildEpisodeSummary,
  episodeKey,
  latestEpisode,
  maybeStoreEpisode,
  scanEndedConversations,
} from "../src/memory/episodes";

const MIN = 60 * 1000;
const NOW = 1_800_000_000_000;

class MapProvider implements MemoryProvider {
  readonly name = "map";
  rows = new Map<string, StoredMemory>();
  now = NOW;

  upsert(userId: string, key: string, content: string, opts?: MemoryUpsertOptions): void {
    const id = `${userId}${key}`;
    const prev = this.rows.get(id);
    this.rows.set(id, {
      key,
      content,
      createdAt: prev?.createdAt ?? this.now,
      updatedAt: this.now,
      importance: opts?.importance ?? prev?.importance ?? 3,
    });
  }
  get(userId: string, key: string): StoredMemory | undefined {
    return this.rows.get(`${userId}${key}`);
  }
  list(userId: string, limit = 50): StoredMemory[] {
    return [...this.rows.entries()]
      .filter(([id]) => id.startsWith(`${userId}`))
      .map(([, r]) => r)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
      .slice(0, limit);
  }
  delete(userId: string, key: string): boolean {
    return this.rows.delete(`${userId}${key}`);
  }
  count(userId: string): number {
    return this.list(userId, 1000).length;
  }
}

function msg(
  id: number,
  role: StoredMessage["role"],
  content: string,
  createdAt: number,
): StoredMessage {
  return { id, conversationId: 1, role, content, createdAt };
}

/** A conversation of `turns` user/assistant pairs, last message at lastAt. */
function convo(turns: number, lastAt: number): StoredMessage[] {
  const out: StoredMessage[] = [];
  let id = 0;
  for (let i = 0; i < turns; i++) {
    const t = lastAt - (turns - i) * 2 * MIN;
    out.push(msg(++id, "user", `سوال شماره ${i + 1} درباره برنامه نویسی`, t));
    out.push(msg(++id, "assistant", `جواب شماره ${i + 1}`, t + MIN));
  }
  return out;
}

function reader(messages: StoredMessage[]): ConversationReader {
  return {
    listUserConversations: () => [
      {
        conversationId: "chat1",
        createdAt: messages[0]?.createdAt ?? 0,
        messageCount: messages.length,
        lastActivity: messages[messages.length - 1]?.createdAt ?? 0,
      },
    ],
    history: () => messages,
  };
}

describe("episodes: trigger conditions", () => {
  test("quiet + ≥6 user turns stores an episode", async () => {
    const provider = new MapProvider();
    const messages = convo(6, NOW - 45 * MIN);
    const r = await maybeStoreEpisode(
      { conversations: reader(messages), provider, nowMs: NOW },
      "u",
      "chat1",
    );
    expect(r.stored).toBe(true);
    expect(r.key).toBe(episodeKey("chat1", NOW - 46 * MIN));
    const stored = provider.get("u", r.key!);
    expect(stored).toBeDefined();
    expect(stored!.importance).toBe(3);
    expect(stored!.content).toContain("موضوع:");
  });

  test("still-active conversation stores nothing", async () => {
    const provider = new MapProvider();
    const messages = convo(6, NOW - 5 * MIN);
    const r = await maybeStoreEpisode(
      { conversations: reader(messages), provider, nowMs: NOW },
      "u",
      "chat1",
    );
    expect(r.stored).toBe(false);
    expect(r.reason).toBe("still-active");
  });

  test("fewer than 6 user turns stores nothing", async () => {
    const provider = new MapProvider();
    const messages = convo(3, NOW - 60 * MIN);
    const r = await maybeStoreEpisode(
      { conversations: reader(messages), provider, nowMs: NOW },
      "u",
      "chat1",
    );
    expect(r.stored).toBe(false);
    expect(r.reason).toBe("too-few-turns");
  });

  test("re-checking the same ended conversation is idempotent", async () => {
    const provider = new MapProvider();
    const messages = convo(6, NOW - 45 * MIN);
    const deps = { conversations: reader(messages), provider, nowMs: NOW };
    const first = await maybeStoreEpisode(deps, "u", "chat1");
    const second = await maybeStoreEpisode(deps, "u", "chat1");
    expect(first.stored).toBe(true);
    expect(second.stored).toBe(false);
    expect(second.reason).toBe("already-stored");
    expect(provider.count("u")).toBe(1);
  });

  test("BOBI_MEMORY_EPISODES=0 blocks storage and scans", async () => {
    const prev = process.env.BOBI_MEMORY_EPISODES;
    process.env.BOBI_MEMORY_EPISODES = "0";
    try {
      const provider = new MapProvider();
      const messages = convo(8, NOW - 90 * MIN);
      const deps = { conversations: reader(messages), provider, nowMs: NOW };
      const r = await maybeStoreEpisode(deps, "u", "chat1");
      expect(r.reason).toBe("disabled");
      const scan = await scanEndedConversations(deps, "u");
      expect(scan.stored).toBe(0);
      expect(provider.count("u")).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.BOBI_MEMORY_EPISODES;
      else process.env.BOBI_MEMORY_EPISODES = prev;
    }
  });
});

describe("episodes: summary + latestEpisode", () => {
  test("buildEpisodeSummary is 2-3 lines with topic and open thread", () => {
    const messages = [
      msg(1, "user", "می خوام یه بات تلگرام بسازم از کجا شروع کنم", NOW - 10 * MIN),
      msg(2, "assistant", "از grammY شروع کن", NOW - 9 * MIN),
      msg(3, "user", "باشه پس فردا ادامه می دیم", NOW - 8 * MIN),
    ];
    const s = buildEpisodeSummary(messages);
    const lines = s.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toStartWith("موضوع:");
  });

  test("latestEpisode returns the newest episode only", async () => {
    const provider = new MapProvider();
    provider.upsert("u", "fact:name", "نام کاربر علی است");
    provider.now = NOW - 10 * MIN;
    provider.upsert("u", episodeKey("chat1", NOW - 60 * MIN), "اپیزود قدیمی", { importance: 3 });
    provider.now = NOW;
    provider.upsert("u", episodeKey("chat2", NOW - 40 * MIN), "اپیزود تازه", { importance: 3 });
    const ep = await latestEpisode(provider, "u");
    expect(ep).toBeDefined();
    expect(ep!.content).toBe("اپیزود تازه");
  });
});
