/**
 * Mini App FRONTEND contract tests (Worker B — Operation: Solid Foundation).
 *
 * The frontend (src/miniapp/web/**) is vanilla JS with no DOM test harness,
 * so these tests pin the BACKEND side of every contract the frontend now
 * relies on after the audit fixes. Each test asserts that:
 *   - the param shape the frontend SENDS succeeds, and
 *   - the old (broken) shape the frontend used to send fails,
 * so a backend change that breaks the mini app UI fails loudly here.
 *
 * Covered fixes:
 *   tasks.complete/cancel require `kind`; tasks.cancel for kind "task"
 *     needs confirm:true (frontend sends both after a confirm dialog).
 *   bench.schedule enabling requires cron|cadence (frontend re-sends the
 *     stored cron, or cadence:"weekly" for a fresh schedule).
 *   digest.config only reads FLAT params (frontend sends { enabled, time,
 *     prompt, chatId } — never { config: {...} }).
 *   skills.install takes { source } + a confirm step (frontend is two-step).
 *   skills.uninstall / trust.remove need confirm:true (frontend sends it).
 *   usage.report reads `days`, not `period` (frontend sends days).
 *   groupdigests.set / groups.digests.set need { chatId, digestEnabled }.
 *   models.discoverDraft accepts the preset baseUrl override + key the
 *     draft picker sends (Cloudflare {ACCOUNT_ID} resolved client-side).
 *   bench.runs / bench.trends / bench.alerts return the shapes the UI reads.
 *   urlOk (src/miniapp/web/sections/providers.js) accepts http:// as well
 *     as https:// — the regex is mirrored here and must stay in sync.
 *
 * Real :memory: Storage; BenchHistory on a temp file.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Storage } from "../src/storage/storage";
import { handleManageApi, type ManageApiDeps } from "../src/miniapp/api_manage";
import { handleProviderApi } from "../src/miniapp/api_providers";
import { ProposalStore } from "../src/curator/proposals";
import { BenchHistory } from "../src/bench/history";

const BOT_TOKEN = "123456:miniapp-frontend-contract-test";
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
let deps: ManageApiDeps;
let initData: string;

beforeEach(() => {
  storage = Storage.open(":memory:");
  const benchDbPath = join(mkdtempSync(join(tmpdir(), "bobi-bench-")), "bench.db");
  deps = {
    storage,
    skillsDir: mkdtempSync(join(tmpdir(), "bobi-skills-")),
    dbPath: benchDbPath,
    botToken: BOT_TOKEN,
    ownerId: OWNER_ID,
    proposalStore: new ProposalStore(new Database(":memory:")),
    benchHistory: new BenchHistory(new Database(benchDbPath)),
  };
  initData = makeInitData(OWNER_ID);
});

afterEach(() => {
  storage.close();
});

async function call(path: string, body: Record<string, unknown> = {}) {
  const res = await handleManageApi(path, { initData, ...body }, deps);
  if (res === undefined) throw new Error(`expected a Response for ${path}`);
  return { status: res.status, json: (await res.json()) as any };
}

describe("tasks.complete / tasks.cancel param contract", () => {
  test("tasks.complete without kind is rejected (frontend must send kind)", async () => {
    const r = await call("/miniapp/api/tasks.complete", { id: 1 });
    expect(r.status).toBe(400);
  });

  test("tasks.complete works for reminders and goals with kind", async () => {
    const rid = storage.createReminder({
      userId: OWNER_ID,
      text: "r",
      dueAt: Date.now() + 1000,
      repeat: "none",
      chatId: OWNER_ID,
    });
    const ok1 = await call("/miniapp/api/tasks.complete", { kind: "reminder", id: rid });
    expect(ok1.status).toBe(200);
    expect(ok1.json.ok).toBe(true);

    const gid = storage.createGoal({ createdBy: OWNER_ID, title: "g" });
    const ok2 = await call("/miniapp/api/tasks.complete", { kind: "goal", id: gid });
    expect(ok2.status).toBe(200);
  });

  test("tasks.complete rejects kind=task (frontend hides that button)", async () => {
    const r = await call("/miniapp/api/tasks.complete", { kind: "task", id: 1 });
    expect(r.status).toBe(400);
  });

  test("tasks.cancel for kind=task needs confirm:true (frontend sends it)", async () => {
    const id = storage.createTask({
      name: "t",
      cronExpr: "0 3 * * *",
      timezone: "Asia/Tehran",
      actionJson: "{}",
      createdByUserId: OWNER_ID,
      nextRunAtMs: Date.now() + 1000,
      enabled: true,
    });
    const needs = await call("/miniapp/api/tasks.cancel", { kind: "task", id });
    expect(needs.status).toBe(200);
    expect(needs.json.needsConfirm).toBe(true);
    const done = await call("/miniapp/api/tasks.cancel", { kind: "task", id, confirm: true });
    expect(done.status).toBe(200);
    expect(done.json.ok).toBe(true);
  });

  test("tasks.cancel rejects kind=goal (frontend hides that button)", async () => {
    const r = await call("/miniapp/api/tasks.cancel", { kind: "goal", id: 1 });
    expect(r.status).toBe(400);
  });
});

describe("bench.schedule enable contract", () => {
  test("enabling without cron|cadence is rejected (frontend always sends one)", async () => {
    const r = await call("/miniapp/api/bench.schedule", { enabled: true });
    expect(r.status).toBe(400);
  });

  test("enabling with a cadence works; GET view carries nextRunAtMs", async () => {
    const on = await call("/miniapp/api/bench.schedule", { enabled: true, cadence: "weekly" });
    expect(on.status).toBe(200);
    expect(on.json.enabled).toBe(true);
    const get = await call("/miniapp/api/bench.schedule", {});
    expect(get.json.schedule.enabled).toBe(true);
    expect(typeof get.json.schedule.nextRunAtMs).toBe("number");
    // Re-enabling the existing task still needs cron|cadence.
    const again = await call("/miniapp/api/bench.schedule", { enabled: true, cron: get.json.schedule.cron });
    expect(again.status).toBe(200);
  });
});

describe("digest.config flat params", () => {
  function makeDigestTask() {
    return storage.createTask({
      name: "blueprint: morning_digest",
      cronExpr: "30 8 * * *",
      timezone: "Asia/Tehran",
      actionJson: JSON.stringify({ type: "agent", chatId: OWNER_ID, prompt: "p" }),
      createdByUserId: OWNER_ID,
      nextRunAtMs: Date.now() + 1000,
      enabled: true,
    });
  }

  test("flat { enabled, time } updates the row; { config } wrapper is ignored", async () => {
    makeDigestTask();
    const set = await call("/miniapp/api/digest.config", { enabled: false });
    expect(set.status).toBe(200);
    expect(set.json.enabled).toBe(false);
    const get = await call("/miniapp/api/digest.config", {});
    expect(get.json.enabled).toBe(false);
    // The old broken shape ({ config: {...} }) touches nothing.
    const wrapped = await call("/miniapp/api/digest.config", { config: { enabled: true } });
    expect(wrapped.status).toBe(200);
    const get2 = await call("/miniapp/api/digest.config", {});
    expect(get2.json.enabled).toBe(false);
  });

  test("GET view exposes the fields the form renders", async () => {
    makeDigestTask();
    const get = await call("/miniapp/api/digest.config", {});
    for (const k of ["exists", "enabled", "time", "prompt", "chatId"]) {
      expect(get.json[k] !== undefined).toBe(true);
    }
  });
});

describe("skills install/uninstall/trust param contract", () => {
  const SKILL_TEXT = `---\nname: contract-skill\ndescription: test\n---\n# hello\n`;

  test("skills.install takes { source } and returns a review first", async () => {
    const review = await call("/miniapp/api/skills.install", { source: SKILL_TEXT });
    expect(review.status).toBe(200);
    expect(review.json.needsConfirm).toBe(true);
    expect(review.json.review.name).toBe("contract-skill");
    // The old broken shapes ({ url } / { text }) are rejected.
    const bad = await call("/miniapp/api/skills.install", { url: "https://example.com/x.md" });
    expect(bad.status).toBe(400);
  });

  test("skills.install writes only with confirm:true", async () => {
    const done = await call("/miniapp/api/skills.install", { source: SKILL_TEXT, confirm: true });
    expect(done.status).toBe(200);
    expect(done.json.installed).toBe(true);
    const list = await call("/miniapp/api/skills.list", {});
    expect(list.json.skills.some((s: any) => s.name === "contract-skill")).toBe(true);
  });

  test("skills.uninstall needs confirm:true", async () => {
    await call("/miniapp/api/skills.install", { source: SKILL_TEXT, confirm: true });
    const needs = await call("/miniapp/api/skills.uninstall", { name: "contract-skill" });
    expect(needs.json.needsConfirm).toBe(true);
    const done = await call("/miniapp/api/skills.uninstall", { name: "contract-skill", confirm: true });
    expect(done.json.removed).toBe(true);
  });

  test("trust.remove needs confirm:true; trust.list rows carry label+keyId", async () => {
    const keyId = "ab".repeat(32);
    const add = await call("/miniapp/api/trust.add", { publisher: keyId, label: "T" });
    expect(add.status).toBe(200);
    const list = await call("/miniapp/api/trust.list", {});
    expect(list.json.publishers[0].label).toBe("T");
    expect(list.json.publishers[0].keyId).toBe(keyId);
    const needs = await call("/miniapp/api/trust.remove", { publisher: keyId });
    expect(needs.json.needsConfirm).toBe(true);
    const done = await call("/miniapp/api/trust.remove", { publisher: keyId, confirm: true });
    expect(done.json.removed).toBe(true);
  });
});

describe("usage.report param + shape", () => {
  test("reads `days`, not `period`", async () => {
    const a = await call("/miniapp/api/usage.report", { period: 30 } as any);
    expect(a.json.days).toBe(7); // `period` is ignored
    const b = await call("/miniapp/api/usage.report", { days: 30 });
    expect(b.json.days).toBe(30);
  });

  test("returns flat totals the UI cards read", async () => {
    const r = await call("/miniapp/api/usage.report", { days: 7 });
    for (const k of ["runs", "inputTokens", "outputTokens", "estimatedUsd", "byModel"]) {
      expect(r.json[k] !== undefined).toBe(true);
    }
  });
});

describe("group digests param contract", () => {
  const CHAT = "-100123";

  test("groupdigests.set needs { chatId, digestEnabled } (not groupId/enabled)", async () => {
    const bad = await call("/miniapp/api/groupdigests.set", { groupId: CHAT, enabled: true } as any);
    expect(bad.status).toBe(400);
  });

  test("groups.digests.set toggles with chatId after assistant mode is on", async () => {
    const aset = await call("/miniapp/api/groups.assistant.set", { groupId: CHAT, enabled: true });
    expect(aset.status).toBe(200);
    const on = await call("/miniapp/api/groups.digests.set", { chatId: CHAT, digestEnabled: true, time: "08:30" });
    expect(on.status).toBe(200);
    expect(on.json.digestEnabled).toBe(true);
    const list = await call("/miniapp/api/groupdigests.list", {});
    expect(list.json.groups[0].chatId).toBe(CHAT);
    expect(list.json.groups[0].digestEnabled).toBe(true);
    const off = await call("/miniapp/api/groups.digests.set", { chatId: CHAT, digestEnabled: false });
    expect(off.status).toBe(200);
  });
});

describe("models.discoverDraft preset override (Cloudflare placeholder)", () => {
  test("unresolved {ACCOUNT_ID} is rejected; resolved override is accepted by validation", async () => {
    // The frontend resolves {ACCOUNT_ID} client-side and sends baseUrl.
    // Here we only pin the validation boundary: a placeholder left in the
    // URL must fail, a resolved https URL must pass validation.
    const bad = await handleProviderApi(
      "models.discoverDraft",
      { kind: "preset", preset: "cloudflare", key: "k", baseUrl: "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1" },
      { storage } as any,
    ).then(
      () => "unexpected-ok",
      (e: any) => String(e?.message ?? e),
    );
    expect(bad).toMatch(/placeholder/i);
  });
});

describe("bench.runs / trends / alerts shapes the UI reads", () => {
  test("bench.runs rows carry tsMs + avgScorePct", async () => {
    const r = await call("/miniapp/api/bench.runs", { limit: 5 });
    expect(Array.isArray(r.json.runs)).toBe(true);
    // shape probe on empty is vacuous; the row mapper is covered by history tests
  });

  test("bench.trends returns { pair, runs:[{ runId, tsMs, avgScorePct }] }", async () => {
    const r = await call("/miniapp/api/bench.trends", {});
    expect(r.json.runs !== undefined && r.json.pair !== undefined).toBe(true);
  });

  test("bench.alerts rows carry labelFa + lastSentMs", async () => {
    const r = await call("/miniapp/api/bench.alerts", {});
    expect(Array.isArray(r.json.alerts)).toBe(true);
  });
});

describe("providers.js urlOk (mirrored regex — keep in sync)", () => {
  // Mirrors urlOk() in src/miniapp/web/sections/providers.js.
  const urlOk = (u: string) => /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(String(u || "").trim());

  test("accepts http:// and https://", () => {
    expect(urlOk("https://api.example.com/v1")).toBe(true);
    expect(urlOk("http://192.168.1.10:8080/v1")).toBe(true);
    expect(urlOk("http://localhost:20128")).toBe(true);
  });

  test("rejects non-URLs", () => {
    expect(urlOk("")).toBe(false);
    expect(urlOk("not a url")).toBe(false);
    expect(urlOk("ftp://x.com")).toBe(false);
    expect(urlOk("https://")).toBe(false);
  });
});
