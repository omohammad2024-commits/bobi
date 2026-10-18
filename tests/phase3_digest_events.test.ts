/**
 * Phase-3 item 1: proactive digest of memory — upcoming events in the
 * morning digest.
 *
 * Covers: the events section appears for events within 7 days (and not for
 * distant ones), malformed event payloads are skipped without killing the
 * digest, structured keys (event:/archive:) are excluded from the memory
 * highlights, and rendering is bilingual.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Storage } from "../src/storage/storage";
import { ProposalStore } from "../src/curator/proposals";
import {
  buildDigestData,
  renderDigestText,
  type DigestDeps,
} from "../src/digest/builder";

const OWNER = "12345";
/** 2026-10-18T04:30:00Z == 08:00 Asia/Tehran, a Sunday — Mehr 26, 1405. */
const NOW_MS = Date.parse("2026-10-18T04:30:00Z");

function deps(): DigestDeps {
  return {
    storage: Storage.open(":memory:"),
    proposalStore: new ProposalStore(new Database(":memory:")),
    userId: OWNER,
    now: () => NOW_MS,
  };
}

function seedEvent(
  d: DigestDeps,
  key: string,
  payload: Record<string, unknown>,
): void {
  d.storage.upsertMemory({
    userId: OWNER,
    key,
    content: JSON.stringify(payload),
  });
}

function eventPayload(name: string, jMonth: number, jDay: number) {
  return {
    v: 1,
    name,
    kind: "birthday",
    jMonth,
    jDay,
    labelFa: `${jDay} مهر`,
  };
}

describe("digest events section", () => {
  test("lists events within 7 days, soonest first", async () => {
    const d = deps();
    seedEvent(d, "event:birthday:aaa", eventPayload("علی", 7, 29)); // +3
    seedEvent(d, "event:birthday:bbb", eventPayload("سارا", 7, 26)); // today
    const sections = await buildDigestData(d);
    const events = sections.find((s) => s.kind === "events");
    expect(events).toBeDefined();
    if (events?.kind !== "events") throw new Error("unreachable");
    expect(events.items.map((i) => i.name)).toEqual(["سارا", "علی"]);
    const text = renderDigestText(sections, "fa");
    expect(text).toContain("🎉 رویدادهای پیش رو");
    expect(text).toContain("سارا");
    expect(text).toContain("امروز");
    expect(text).toContain("۳ روز دیگه");
  });

  test("no section when all events are beyond 7 days", async () => {
    const d = deps();
    seedEvent(d, "event:birthday:ccc", eventPayload("دور", 8, 15)); // +19
    const sections = await buildDigestData(d);
    expect(sections.some((s) => s.kind === "events")).toBe(false);
  });

  test("malformed event payloads are skipped, digest survives", async () => {
    const d = deps();
    d.storage.upsertMemory({ userId: OWNER, key: "event:birthday:bad", content: "not-json{{" });
    d.storage.upsertMemory({ userId: OWNER, key: "k1", content: "خاطرهٔ ساده" });
    const sections = await buildDigestData(d);
    expect(sections.some((s) => s.kind === "events")).toBe(false);
    const text = renderDigestText(sections, "fa");
    expect(text).toContain("☀️ صبح بخیر!");
  });

  test("structured keys are excluded from memory highlights", async () => {
    const d = deps();
    seedEvent(d, "event:birthday:aaa", eventPayload("علی", 8, 15));
    d.storage.upsertMemory({ userId: OWNER, key: "archive:2026-10-18", content: "بایگانی" });
    d.storage.upsertMemory({ userId: OWNER, key: "k1", content: "خاطرهٔ واقعی" });
    const sections = await buildDigestData(d);
    const memories = sections.find((s) => s.kind === "memories");
    expect(memories).toBeDefined();
    if (memories?.kind !== "memories") throw new Error("unreachable");
    expect(memories.items.map((i) => i.key)).toEqual(["k1"]);
  });

  test("renders in English too", async () => {
    const d = deps();
    seedEvent(d, "event:birthday:aaa", eventPayload("Ali", 7, 29));
    const sections = await buildDigestData(d);
    const text = renderDigestText(sections, "en");
    expect(text).toContain("🎉 Upcoming events");
    expect(text).toContain("in 3 days");
  });
});
