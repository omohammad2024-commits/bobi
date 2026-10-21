/**
 * Mini App owner-profile APIs (src/miniapp/api_profile.ts) + frontend
 * registration contracts (src/miniapp/web/sections/profile.js).
 *
 * Privacy pin: the owner profile is unreachable without valid owner
 * initData — missing, tampered, and non-owner initData all get a generic
 * 401, both at the sub-router and end-to-end through createMiniAppHandler.
 *
 * Real :memory: Storage + real OwnerProfileService (the handler builds it
 * from deps.storage), so profile.get exercises the real Phase-4 seed.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Storage } from "../src/storage/storage";
import { handleProfileApi, type ProfileApiDeps } from "../src/miniapp/api_profile";
import { createMiniAppHandler } from "../src/miniapp/api";

const BOT_TOKEN = "test-bot-token-profile-0123456789";
const OWNER_ID = "777001";

function makeInitData(userId: string): string {
  const params = new URLSearchParams();
  params.set("auth_date", String(Math.floor(Date.now() / 1000)));
  params.set("query_id", "q1");
  params.set("user", JSON.stringify({ id: Number(userId), first_name: "T" }));
  const pairs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort();
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN, "utf8").digest();
  const hash = createHmac("sha256", secret).update(pairs.join("\n"), "utf8").digest("hex");
  params.set("hash", hash);
  return params.toString();
}

let storage: Storage;
let deps: ProfileApiDeps;
let initData: string;

beforeEach(() => {
  storage = Storage.open(":memory:");
  deps = { storage, botToken: BOT_TOKEN, ownerId: OWNER_ID };
  initData = makeInitData(OWNER_ID);
});

afterEach(() => {
  storage.close();
});

async function call(
  name: string,
  body: Record<string, unknown> = {},
  withAuth = true,
): Promise<{ status: number; json: any }> {
  const res = await handleProfileApi(
    `/miniapp/api/${name}`,
    withAuth ? { initData, ...body } : body,
    deps,
  );
  if (res === undefined) throw new Error(`expected a Response for ${name}`);
  return { status: res.status, json: await res.json() };
}

describe("routing + auth (privacy pin)", () => {
  test("non-profile path falls through (undefined)", async () => {
    expect(await handleProfileApi("/miniapp/api/users.list", { initData }, deps)).toBeUndefined();
    expect(await handleProfileApi("/other", { initData }, deps)).toBeUndefined();
  });

  test("profile.get without initData -> 401 generic fa error, no profile leaked", async () => {
    const { status, json } = await call("profile.get", {}, false);
    expect(status).toBe(401);
    expect(json.ok).toBe(false);
    expect(typeof json.error).toBe("string");
    expect(json.error.length).toBeGreaterThan(0);
    expect(json.profile).toBeUndefined();
  });

  test("profile.get with tampered initData -> 401", async () => {
    const bad = initData.replace(/hash=[^&]*/, "hash=deadbeef");
    const res = await handleProfileApi("/miniapp/api/profile.get", { initData: bad }, deps);
    expect(res!.status).toBe(401);
    expect((await res!.json()).profile).toBeUndefined();
  });

  test("profile.get with non-owner initData -> 401", async () => {
    const res = await handleProfileApi(
      "/miniapp/api/profile.get",
      { initData: makeInitData("123456") },
      deps,
    );
    expect(res!.status).toBe(401);
  });

  test("profile.save without initData -> 401 and nothing is persisted", async () => {
    const { status } = await call("profile.save", { profile: { version: 1 } }, false);
    expect(status).toBe(401);
    expect(storage.getOwnerProfileDoc()).toBeUndefined();
  });
});

describe("profile.get", () => {
  test("valid owner initData -> seeded profile with every section", async () => {
    const { status, json } = await call("profile.get");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    const p = json.profile;
    expect(p).toBeDefined();
    // The real Phase-4 seed: creator identity from prompt.ts.
    expect(p.identity.name).toBe("Mohammad");
    expect(Array.isArray(p.identity.basics)).toBe(true);
    expect(p.identity.basics.length).toBeGreaterThan(0);
    for (const section of [
      "communication",
      "standingRules",
      "projects",
      "people",
      "routines",
      "technicalFacts",
      "goals",
      "openSlots",
    ]) {
      expect(p[section], `section ${section}`).toBeDefined();
    }
    expect(Array.isArray(p.openSlots)).toBe(true);
    // Seeding persisted the doc, and a second get returns the same profile.
    expect(storage.getOwnerProfileDoc()).toBeDefined();
    const again = await call("profile.get");
    expect(again.json.profile).toEqual(p);
  });
});

describe("profile.save", () => {
  test("round-trips an edit: get -> edit -> save -> get shows the edit", async () => {
    const got = await call("profile.get");
    const edited = structuredClone(got.json.profile);
    edited.identity.name = "Mohammad";
    edited.identity.callName = "Mo";
    edited.standingRules = [...edited.standingRules, "Never share secrets."];
    edited.goals = [...edited.goals, "Ship BOBI v2"];
    edited.projects = [...edited.projects, { name: "BOBI", note: "Telegram agent bot" }];
    edited.people = [...edited.people, { name: "Geo", role: "friend" }];
    edited.updatedAtMs = Date.now();

    const saved = await call("profile.save", { profile: edited });
    expect(saved.status).toBe(200);
    expect(saved.json.ok).toBe(true);
    expect(saved.json.profile.identity.callName).toBe("Mo");
    expect(saved.json.profile.standingRules).toContain("Never share secrets.");

    const again = await call("profile.get");
    expect(again.json.profile.identity.callName).toBe("Mo");
    expect(again.json.profile.goals).toContain("Ship BOBI v2");
    expect(again.json.profile.projects.some((x: any) => x.name === "BOBI")).toBe(true);
    expect(again.json.profile.people.some((x: any) => x.name === "Geo" && x.role === "friend")).toBe(true);
  });

  test("garbage profile bodies are rejected and nothing is persisted over the seed", async () => {
    const got = await call("profile.get");
    const before = storage.getOwnerProfileDoc();
    expect(before).toBeDefined();

    for (const bad of [
      { profile: "not-an-object" },
      { profile: 42 },
      { profile: [1, 2, 3] },
      { profile: { hello: "world" } },
      { profile: { ...got.json.profile, standingRules: "not-an-array" } },
      { profile: { ...got.json.profile, identity: { name: 5, basics: [] } } },
      { profile: { ...got.json.profile, projects: [{ name: "x" }] } }, // note required
      {}, // no profile field at all
    ]) {
      const { status, json } = await call("profile.save", bad);
      expect(status, JSON.stringify(bad).slice(0, 60)).toBe(400);
      expect(json.ok).toBe(false);
      expect(typeof json.error).toBe("string");
      expect(json.error.length).toBeGreaterThan(0);
    }
    expect(storage.getOwnerProfileDoc()).toBe(before);
  });

  test("oversized profile is rejected with 413", async () => {
    const got = await call("profile.get");
    const huge = structuredClone(got.json.profile);
    huge.technicalFacts = ["x".repeat(70 * 1024)];
    const { status, json } = await call("profile.save", { profile: huge });
    expect(status).toBe(413);
    expect(json.ok).toBe(false);
  });

  test("no secret-shaped fields are introduced by get/save responses", async () => {
    const got = await call("profile.get");
    const raw = JSON.stringify(got.json);
    expect(raw).not.toMatch(/apiKey|botToken|credential|password/i);
  });
});

describe("end-to-end through createMiniAppHandler (api.ts router)", () => {
  function handler() {
    return createMiniAppHandler({
      storage,
      botToken: BOT_TOKEN,
      ownerId: OWNER_ID,
      webDir: join(import.meta.dir, "../src/miniapp/web"),
      engineFactory: () => ({ respond: async () => ({ chunks: [] }) }),
      actorForOwner: () => ({}),
    } as any);
  }

  function post(action: string, body: Record<string, unknown>): Promise<Response> {
    const h = handler();
    const req = new Request(`http://localhost/miniapp/api/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = h(req);
    if (res === undefined) throw new Error("handler fell through");
    return res;
  }

  test("unauthenticated profile.get is rejected by the router (401)", async () => {
    const res = await post("profile.get", {});
    expect(res.status).toBe(401);
    const json: any = await res.json();
    expect(json.profile).toBeUndefined();
    expect(typeof json.error).toBe("string");
  });

  test("owner profile.get + profile.save round-trip through the router", async () => {
    const res = await post("profile.get", { initData });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(json.profile.identity.name).toBe("Mohammad");

    const edited = { ...json.profile, routines: ["Morning digest at 8"] };
    const saveRes = await post("profile.save", { initData, profile: edited });
    expect(saveRes.status).toBe(200);
    const saveJson: any = await saveRes.json();
    expect(saveJson.profile.routines).toContain("Morning digest at 8");
  });
});

describe("frontend registration contracts (profile section)", () => {
  const WEB = join(import.meta.dir, "../src/miniapp/web");
  const PROFILE_JS = readFileSync(join(WEB, "sections/profile.js"), "utf8");
  const APP_JS = readFileSync(join(WEB, "app.js"), "utf8");
  const INDEX_HTML = readFileSync(join(WEB, "index.html"), "utf8");

  test("profile.js registers the profile section with the user icon", () => {
    expect(PROFILE_JS).toContain('registerSection("profile"');
    expect(PROFILE_JS).toContain('titleKey: "sec.profile"');
    expect(PROFILE_JS).toContain('icon: "user"');
    expect(PROFILE_JS).toContain('"sec.profile":');
  });

  test("profile.js talks to profile.get / profile.save via ctx.api only", () => {
    expect(PROFILE_JS).toContain('ctx.api("profile.get"');
    expect(PROFILE_JS).toContain('ctx.api("profile.save", { profile: model })');
    expect(PROFILE_JS).not.toContain("fetch(");
  });

  test("every profile section is rendered, openSlots as not-yet-asked placeholders", () => {
    for (const key of [
      "identity",
      "communication",
      "standingRules",
      "projects",
      "people",
      "routines",
      "technicalFacts",
      "goals",
      "openSlots",
    ]) {
      expect(PROFILE_JS, `section ${key}`).toContain(`key: "${key}"`);
    }
    expect(PROFILE_JS).toContain('"prof.openSlots":');
    expect(PROFILE_JS).toContain('"prof.notYetAsked":');
    expect(PROFILE_JS).toContain('t("prof.notYetAsked")');
  });

  test("every prof.* string rendered is registered in the RS block", () => {
    const used = new Set(
      [...PROFILE_JS.matchAll(/t\("(prof\.[A-Za-z]+)"/g)].map((m) => m[1] as string),
    );
    expect(used.size).toBeGreaterThan(5);
    for (const k of used) {
      expect(PROFILE_JS, `registered: ${k}`).toContain(`"${k}":`);
    }
  });

  test("app.js registers the tab (order, short label, file) and index.html loads it", () => {
    expect(APP_JS).toContain('"profile",');
    expect(APP_JS).toContain('profile: "Profile"');
    expect(APP_JS).toContain('profile: "sections/profile.js"');
    expect(INDEX_HTML).toContain("sections/profile.js");
  });
});
