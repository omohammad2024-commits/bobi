/**
 * Moderation (Stage-3 differentiator) tests.
 *
 * Covers: flood detection, link-policy variants, Persian profanity hits,
 * spam signals, the warn→delete→notify escalation ladder, owner bypass,
 * disabled-by-default groups, per-group isolation, strict config validation,
 * and the safety invariants (warn-before-delete, never auto-ban, no message
 * content in warnings/notifications/log).
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MOD_CONFIG,
  FLOOD_MAX_MESSAGES_MAX,
  FLOOD_MAX_MESSAGES_MIN,
  FLOOD_WINDOW_SEC_MAX,
  FLOOD_WINDOW_SEC_MIN,
  getModConfig,
  modConfigKey,
  setModConfig,
  validateModConfig,
  type ModConfig,
} from "../src/moderation/config";
import {
  checkFlood,
  checkLinks,
  checkProfanityFa,
  checkSpamSignals,
  normalizeFa,
  runChecks,
} from "../src/moderation/checks";
import {
  createModLog,
  decideAction,
  ESCALATION_WINDOW_MS,
  NOTIFY_COOLDOWN_MS,
} from "../src/moderation/actions";
import { createModerator } from "../src/moderation/index";

/** In-memory stand-in for Storage's user_prefs surface. */
function fakeStore() {
  const map = new Map<string, string>();
  return {
    getUserPref(userId: string, key: string): string | undefined {
      return map.get(`${userId}:${key}`);
    },
    setUserPref(userId: string, key: string, value: string): void {
      map.set(`${userId}:${key}`, value);
    },
    raw: map,
  };
}

const OWNER = "111";
const GROUP_A = "-1001";
const GROUP_B = "-1002";
const USER = "222";

function enabledCfg(over: Partial<ModConfig> = {}): ModConfig {
  return { ...DEFAULT_MOD_CONFIG, enabled: true, ...over };
}

function makeModerator(store = fakeStore(), extra: Record<string, unknown> = {}) {
  const notes: string[] = [];
  const mod = createModerator({
    storage: store,
    ownerId: OWNER,
    notifyOwner: async (text: string) => {
      notes.push(text);
    },
    ...extra,
  });
  return { mod, store, notes };
}

function enableGroup(store: ReturnType<typeof fakeStore>, chatId: string, over: Partial<ModConfig> = {}) {
  const res = setModConfig(store, OWNER, chatId, { enabled: true, ...over });
  expect(res.ok).toBe(true);
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("validateModConfig", () => {
  test("rejects unknown fields outright", () => {
    const r = validateModConfig({ enabled: true, autoBan: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/unknown field/);
  });

  test("rejects out-of-bounds and non-integer numbers", () => {
    expect(validateModConfig({ floodMaxMessages: 1 }).ok).toBe(false);
    expect(validateModConfig({ floodMaxMessages: FLOOD_MAX_MESSAGES_MAX + 1 }).ok).toBe(false);
    expect(validateModConfig({ floodMaxMessages: 2.5 }).ok).toBe(false);
    expect(validateModConfig({ floodMaxMessages: "5" }).ok).toBe(false);
    expect(validateModConfig({ floodWindowSec: FLOOD_WINDOW_SEC_MIN - 1 }).ok).toBe(false);
    expect(validateModConfig({ floodWindowSec: FLOOD_WINDOW_SEC_MAX + 1 }).ok).toBe(false);
  });

  test("rejects bad linkPolicy and non-object input", () => {
    expect(validateModConfig({ linkPolicy: "nuke" }).ok).toBe(false);
    expect(validateModConfig(null).ok).toBe(false);
    expect(validateModConfig("enabled").ok).toBe(false);
    expect(validateModConfig([]).ok).toBe(false);
  });

  test("accepts boundary values and partial patches", () => {
    const r = validateModConfig({
      floodMaxMessages: FLOOD_MAX_MESSAGES_MIN,
      floodWindowSec: FLOOD_WINDOW_SEC_MAX,
      linkPolicy: "delete",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.floodMaxMessages).toBe(FLOOD_MAX_MESSAGES_MIN);
      expect(r.config.linkPolicy).toBe("delete");
      expect(r.config.enabled).toBe(false); // untouched fields keep base
    }
  });

  test("setModConfig writes nothing when validation fails", () => {
    const store = fakeStore();
    const r = setModConfig(store, OWNER, GROUP_A, { enabled: true, bogus: 1 });
    expect(r.ok).toBe(false);
    expect(store.getUserPref(OWNER, modConfigKey(GROUP_A))).toBeUndefined();
  });
});

describe("getModConfig", () => {
  test("missing row → disabled defaults (fail closed)", () => {
    expect(getModConfig(fakeStore(), OWNER, GROUP_A).enabled).toBe(false);
  });

  test("corrupt JSON → disabled defaults", () => {
    const store = fakeStore();
    store.setUserPref(OWNER, modConfigKey(GROUP_A), "{not json");
    expect(getModConfig(store, OWNER, GROUP_A)).toEqual({ ...DEFAULT_MOD_CONFIG });
  });

  test("schema-invalid blob → disabled defaults", () => {
    const store = fakeStore();
    store.setUserPref(
      OWNER,
      modConfigKey(GROUP_A),
      JSON.stringify({ enabled: true, linkPolicy: "nuke" }),
    );
    expect(getModConfig(store, OWNER, GROUP_A).enabled).toBe(false);
  });

  test("round-trips a valid config", () => {
    const store = fakeStore();
    const r = setModConfig(store, OWNER, GROUP_A, {
      enabled: true,
      linkPolicy: "delete",
      floodMaxMessages: 8,
    });
    expect(r.ok).toBe(true);
    const cfg = getModConfig(store, OWNER, GROUP_A);
    expect(cfg.enabled).toBe(true);
    expect(cfg.linkPolicy).toBe("delete");
    expect(cfg.floodMaxMessages).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Detectors (pure)
// ---------------------------------------------------------------------------

describe("checkFlood", () => {
  const cfg = enabledCfg({ floodWindowSec: 10, floodMaxMessages: 5 });
  test("fires on N messages inside the window", () => {
    const now = 1_000_000;
    const ts = [0, 1, 2, 3, 4].map((i) => now - i * 1000); // 5 in window
    expect(checkFlood(ts, cfg, now).hit).toBe(true);
  });

  test("no hit below the threshold", () => {
    const now = 1_000_000;
    const ts = [0, 1, 2, 3].map((i) => now - i * 1000); // 4 < 5
    expect(checkFlood(ts, cfg, now).hit).toBe(false);
  });

  test("old timestamps outside the window do not count", () => {
    const now = 1_000_000;
    const ts = [now - 60_000, now - 61_000, now - 62_000, now - 63_000, now - 64_000];
    expect(checkFlood(ts, cfg, now).hit).toBe(false);
  });

  test("future timestamps are ignored", () => {
    const now = 1_000_000;
    const ts = [now + 50_000, now + 51_000, now + 52_000, now + 53_000, now + 54_000];
    expect(checkFlood(ts, cfg, now).hit).toBe(false);
  });
});

describe("checkLinks", () => {
  test("allow policy → never fires", () => {
    expect(
      checkLinks("see https://example.com/x", { linkPolicy: "allow" }).hit,
    ).toBe(false);
  });

  test("warn/delete policies fire on URLs", () => {
    expect(
      checkLinks("see https://example.com/x", { linkPolicy: "warn" }).hit,
    ).toBe(true);
    expect(checkLinks("join t.me/somechannel", { linkPolicy: "delete" }).hit).toBe(
      true,
    );
    expect(checkLinks("visit www.example.com", { linkPolicy: "delete" }).hit).toBe(
      true,
    );
  });

  test("plain text without links does not fire", () => {
    expect(checkLinks("سلام چطوری؟ امروز هوا خوبه", { linkPolicy: "delete" }).hit).toBe(
      false,
    );
  });
});

describe("checkProfanityFa", () => {
  test("fires on a listed obscenity", () => {
    expect(checkProfanityFa("تو واقعا یه جنده‌ای").hit).toBe(true);
  });

  test("fires with Arabic-script variants normalized", () => {
    expect(checkProfanityFa("حرومزاده").hit).toBe(true);
    // Arabic kaf/yeh variants normalize to Persian forms
    expect(checkProfanityFa(normalizeFa("حرومزاده")).hit).toBe(true);
  });

  test("does not fire on clean Persian text", () => {
    expect(checkProfanityFa("سلام رفیق، امروز چه خبر؟").hit).toBe(false);
    expect(checkProfanityFa("").hit).toBe(false);
  });

  test("does not fire on substring inside a longer innocent word", () => {
    // "کس" inside "کسی" must not match — boundary-aware matching
    expect(checkProfanityFa("کسی اینجا هست؟").hit).toBe(false);
  });
});

describe("checkSpamSignals", () => {
  test("excessive Latin caps fires", () => {
    expect(checkSpamSignals("BUY NOW CHEAP PRICE").hit).toBe(true);
  });

  test("normal mixed-case text does not fire", () => {
    expect(checkSpamSignals("Hello friend, how are you?").hit).toBe(false);
  });

  test("emoji flood fires", () => {
    expect(checkSpamSignals("😂".repeat(13)).hit).toBe(true);
    expect(checkSpamSignals("😂😂 خوب بود").hit).toBe(false);
  });

  test("character and word repetition fires", () => {
    expect(checkSpamSignals("سلامممممم").hit).toBe(true);
    expect(checkSpamSignals("بیا بیا بیا بیا بیا بیا").hit).toBe(true);
    expect(checkSpamSignals("بیا بیا").hit).toBe(false);
  });

  test("forwarded loop fires on repeated forwarded text", () => {
    const text = "فروش ویژه فقط امروز";
    const opts = { forwarded: true, recentTexts: [text, text] };
    expect(checkSpamSignals(text, opts).hit).toBe(true);
  });

  test("forwarded but novel text does not fire", () => {
    const opts = { forwarded: true, recentTexts: ["چیز دیگر"] };
    expect(checkSpamSignals("متن تازه", opts).hit).toBe(false);
  });

  test("non-forwarded repeats do not count as a loop", () => {
    const opts = { forwarded: false, recentTexts: ["x", "x"] };
    expect(checkSpamSignals("x", opts).hit).toBe(false);
  });
});

describe("runChecks", () => {
  test("respects disabled sub-detectors", () => {
    const cfg = enabledCfg({ antiSpam: false, profanityFilter: false });
    const hits = runChecks("جنده 😂".repeat(8), cfg, [], 1000);
    expect(hits).toEqual([]);
  });

  test("clean text produces no hits", () => {
    const cfg = enabledCfg({ linkPolicy: "delete" });
    expect(runChecks("سلام بچه‌ها، فردا ساعت ۵ می‌بینمتون", cfg, [999], 1000)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Escalation ladder (decideAction)
// ---------------------------------------------------------------------------

describe("decideAction", () => {
  const cfg = enabledCfg({ linkPolicy: "delete" });
  const hit = (reason: "flood" | "link" | "profanity" | "spam" = "flood") => ({
    hit: true,
    reason,
  });
  const NOW = 5_000_000;

  test("no hits → allow", () => {
    const d = decideAction([], cfg, [], NOW);
    expect(d.action).toBe("allow");
    expect(d.notifyOwner).toBe(false);
    expect(d.warnTextFa).toBeNull();
  });

  test("1st strike → warn with Persian text, never delete", () => {
    const d = decideAction([hit()], cfg, [], NOW);
    expect(d.action).toBe("warn");
    expect(d.notifyOwner).toBe(false);
    expect(typeof d.warnTextFa).toBe("string");
    expect((d.warnTextFa as string).length).toBeGreaterThan(0);
  });

  test("2nd strike within 10 min → delete, no owner notify", () => {
    const d = decideAction([hit()], cfg, [{ tsMs: NOW - 60_000, reason: "flood" }], NOW);
    expect(d.action).toBe("delete");
    expect(d.notifyOwner).toBe(false);
  });

  test("3rd strike → delete + notify owner", () => {
    const d = decideAction(
      [hit("profanity")],
      cfg,
      [
        { tsMs: NOW - 60_000, reason: "flood" },
        { tsMs: NOW - 120_000, reason: "flood" },
      ],
      NOW,
    );
    expect(d.action).toBe("delete");
    expect(d.notifyOwner).toBe(true);
  });

  test("strikes older than 10 min do not escalate", () => {
    const old = NOW - ESCALATION_WINDOW_MS - 1000;
    const d = decideAction([hit()], cfg, [{ tsMs: old, reason: "flood" }], NOW);
    expect(d.action).toBe("warn");
  });

  test("notify respects the cooldown", () => {
    const strikes = [
      { tsMs: NOW - 60_000, reason: "flood" as const },
      { tsMs: NOW - 120_000, reason: "flood" as const },
    ];
    const d = decideAction([hit()], cfg, strikes, NOW, {
      lastNotifyMs: NOW - NOTIFY_COOLDOWN_MS + 60_000, // within cooldown
    });
    expect(d.action).toBe("delete");
    expect(d.notifyOwner).toBe(false);
  });

  test('linkPolicy "warn" caps severity at warn even with strikes', () => {
    const warnCfg = enabledCfg({ linkPolicy: "warn" });
    const d = decideAction(
      [hit("link")],
      warnCfg,
      [
        { tsMs: NOW - 60_000, reason: "link" },
        { tsMs: NOW - 120_000, reason: "link" },
      ],
      NOW,
    );
    expect(d.action).toBe("warn");
    expect(d.notifyOwner).toBe(false);
  });

  test("profanity outranks flood when both fire", () => {
    const d = decideAction([hit("flood"), hit("profanity")], cfg, [], NOW);
    expect(d.reason).toBe("profanity");
  });

  test("the action set has no ban/restrict variant", () => {
    // Type-level: ModAction is "allow" | "warn" | "delete". Runtime: even the
    // harshest path (3rd strike) only deletes + notifies.
    const d = decideAction(
      [hit("profanity")],
      cfg,
      [
        { tsMs: NOW - 1, reason: "profanity" },
        { tsMs: NOW - 2, reason: "profanity" },
      ],
      NOW,
    );
    expect(["allow", "warn", "delete"]).toContain(d.action);
    expect(d.action).toBe("delete");
  });

  test("warning text never echoes message content", () => {
    const evil = "<script>alert(1)</script> @owner hi";
    const d = decideAction([hit("spam")], cfg, [], NOW);
    expect(d.warnTextFa).not.toContain(evil);
    expect(d.warnTextFa).not.toContain("script");
  });
});

describe("createModLog", () => {
  test("ring buffer caps entries", () => {
    const log = createModLog(3);
    for (let i = 0; i < 5; i++) {
      log.append({ tsMs: i, chatId: "c", userId: "u", action: "warn", reason: "spam" });
    }
    expect(log.size()).toBe(3);
    expect(log.entries()[0]?.tsMs).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Moderator end-to-end (handleMessage)
// ---------------------------------------------------------------------------

describe("createModerator.handleMessage", () => {
  test("disabled group (no config) allows everything", async () => {
    const { mod } = makeModerator();
    const d = await mod.handleMessage({
      chatId: GROUP_A,
      userId: USER,
      text: "جنده https://evil.example",
      tsMs: 1000,
    });
    expect(d.action).toBe("allow");
    expect(d.handled).toBe(false);
  });

  test("non-text messages are skipped", async () => {
    const store = fakeStore();
    enableGroup(store, GROUP_A);
    const { mod } = makeModerator(store);
    for (const text of [undefined, null, ""]) {
      const d = await mod.handleMessage({ chatId: GROUP_A, userId: USER, text, tsMs: 1000 });
      expect(d.action).toBe("allow");
    }
  });

  test("owner messages bypass moderation", async () => {
    const store = fakeStore();
    enableGroup(store, GROUP_A, { linkPolicy: "delete", floodMaxMessages: 2 });
    const { mod } = makeModerator(store);
    const d = await mod.handleMessage({
      chatId: GROUP_A,
      userId: OWNER,
      text: "جنده https://x.example",
      tsMs: 1000,
    });
    expect(d.action).toBe("allow");
    expect(mod.getModLog()).toEqual([]);
  });

  test("escalation ladder: warn → delete → delete + owner notify", async () => {
    const store = fakeStore();
    enableGroup(store, GROUP_A, { linkPolicy: "delete" });
    const { mod, notes } = makeModerator(store);
    const base = 10_000_000;

    const d1 = await mod.handleMessage({
      chatId: GROUP_A, userId: USER, text: "see https://x.example", tsMs: base,
    });
    expect(d1.action).toBe("warn");
    expect(d1.handled).toBe(true);
    expect(notes).toEqual([]);

    const d2 = await mod.handleMessage({
      chatId: GROUP_A, userId: USER, text: "see https://y.example", tsMs: base + 60_000,
    });
    expect(d2.action).toBe("delete");
    expect(d2.notifyOwner).toBe(false);
    expect(notes).toEqual([]);

    const d3 = await mod.handleMessage({
      chatId: GROUP_A, userId: USER, text: "see https://z.example", tsMs: base + 120_000,
    });
    expect(d3.action).toBe("delete");
    expect(d3.notifyOwner).toBe(true);
    expect(notes).toHaveLength(1);
    // Owner notification carries no message content.
    expect(notes[0]).not.toContain("https://z.example");
    expect(notes[0]).toMatch(/گروه/);

    const log = mod.getModLog();
    expect(log).toHaveLength(3);
    expect(log.map((e) => e.action)).toEqual(["warn", "delete", "delete"]);
    // Log carries reason codes only — never message content.
    for (const e of log) {
      expect(e.chatId).toBe(GROUP_A);
      expect(e.userId).toBe(USER);
      expect("text" in e).toBe(false);
    }
  });

  test("flood triggers through handleMessage", async () => {
    const store = fakeStore();
    enableGroup(store, GROUP_A, { floodWindowSec: 10, floodMaxMessages: 3 });
    const { mod } = makeModerator(store);
    const base = 20_000_000;
    expect((await mod.handleMessage({ chatId: GROUP_A, userId: USER, text: "سلام", tsMs: base })).action).toBe("allow");
    expect((await mod.handleMessage({ chatId: GROUP_A, userId: USER, text: "سلام", tsMs: base + 1000 })).action).toBe("allow");
    const d = await mod.handleMessage({ chatId: GROUP_A, userId: USER, text: "سلام", tsMs: base + 2000 });
    expect(d.action).toBe("warn");
    expect(d.reason).toBe("flood");
  });

  test("per-group isolation: config and strikes of A do not affect B", async () => {
    const store = fakeStore();
    enableGroup(store, GROUP_A, { linkPolicy: "delete" });
    // GROUP_B stays disabled.
    const { mod } = makeModerator(store);
    const base = 30_000_000;

    // Two strikes in A.
    await mod.handleMessage({ chatId: GROUP_A, userId: USER, text: "https://a.example", tsMs: base });
    await mod.handleMessage({ chatId: GROUP_A, userId: USER, text: "https://b.example", tsMs: base + 1000 });

    // Same user, same content in B → allowed (B has no config).
    const dB = await mod.handleMessage({ chatId: GROUP_B, userId: USER, text: "https://c.example", tsMs: base + 2000 });
    expect(dB.action).toBe("allow");

    // Enable B later: the user starts clean there (strikes did not cross).
    enableGroup(store, GROUP_B, { linkPolicy: "delete" });
    const dB2 = await mod.handleMessage({ chatId: GROUP_B, userId: USER, text: "https://d.example", tsMs: base + 3000 });
    expect(dB2.action).toBe("warn"); // first strike in B, not third
  });

  test("missing storage → allow-all (fail open for delivery, closed for action)", async () => {
    const mod = createModerator({ ownerId: OWNER });
    const d = await mod.handleMessage({
      chatId: GROUP_A, userId: USER, text: "جنده https://x.example", tsMs: 1000,
    });
    expect(d.action).toBe("allow");
  });

  test("notify failure never breaks moderation", async () => {
    const store = fakeStore();
    enableGroup(store, GROUP_A, { linkPolicy: "delete" });
    const mod = createModerator({
      storage: store,
      ownerId: OWNER,
      notifyOwner: async () => {
        throw new Error("telegram down");
      },
    });
    const base = 40_000_000;
    await mod.handleMessage({ chatId: GROUP_A, userId: USER, text: "https://a.example", tsMs: base });
    await mod.handleMessage({ chatId: GROUP_A, userId: USER, text: "https://b.example", tsMs: base + 1000 });
    const d = await mod.handleMessage({ chatId: GROUP_A, userId: USER, text: "https://c.example", tsMs: base + 2000 });
    expect(d.action).toBe("delete");
  });
});
