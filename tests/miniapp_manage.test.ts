/**
 * Mini App management APIs (src/miniapp/api_manage.ts).
 *
 * Covers: auth (401 on missing/bad initData, generic error), non-manage
 * path fall-through, users (list/ban/unban + confirm + self-ban guard),
 * memory search/list, curator proposals/decide, events, bench
 * runs/trends/schedule/alerts, schedulers toggle, digest config get/set,
 * group digests, skills install/toggle/uninstall, trust registry, usage
 * report, tasks (reminders/goals/scheduled), groups assistant + moderation.
 *
 * Real :memory: Storage / ProposalStore; BenchHistory on a temp file so the
 * alerts reader (readonly db over dbPath) sees the same data.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Storage } from "../src/storage/storage";
import { handleManageApi, type ManageApiDeps } from "../src/miniapp/api_manage";
import { ProposalStore } from "../src/curator/proposals";
import { BenchHistory } from "../src/bench/history";
import { EventStore } from "../src/memory/events";
import { resolveMemoryProvider } from "../src/memory/factory";
import { prepareSkillInstall, writeSkillFile } from "../src/skills/install";
import { buildReport } from "../bench/run";

const BOT_TOKEN = "test-bot-token-0123456789abcdef";
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
let proposalStore: ProposalStore;
let benchDbPath: string;
let benchHistory: BenchHistory;
let skillsDir: string;
let deps: ManageApiDeps;
let initData: string;

beforeEach(() => {
  storage = Storage.open(":memory:");
  proposalStore = new ProposalStore(new Database(":memory:"));
  benchDbPath = join(mkdtempSync(join(tmpdir(), "bobi-bench-")), "bench.db");
  benchHistory = new BenchHistory(new Database(benchDbPath));
  skillsDir = mkdtempSync(join(tmpdir(), "bobi-skills-"));
  deps = {
    storage,
    skillsDir,
    dbPath: benchDbPath,
    botToken: BOT_TOKEN,
    ownerId: OWNER_ID,
    proposalStore,
    benchHistory,
  };
  initData = makeInitData(OWNER_ID);
});

afterEach(() => {
  storage.close();
});

async function call(path: string, body: Record<string, unknown> = {}): Promise<{ status: number; json: any }> {
  const res = await handleManageApi(path, { initData, ...body }, deps);
  if (res === undefined) throw new Error(`expected a Response for ${path}`);
  return { status: res.status, json: await res.json() };
}

async function callNoAuth(path: string, body: Record<string, unknown> = {}): Promise<{ status: number; json: any }> {
  const res = await handleManageApi(path, body, deps);
  if (res === undefined) throw new Error(`expected a Response for ${path}`);
  return { status: res.status, json: await res.json() };
}

describe("routing + auth", () => {
  test("non-manage path falls through (undefined)", async () => {
    expect(await handleManageApi("/miniapp/api_providers/x", { initData }, deps)).toBeUndefined();
    expect(await handleManageApi("/other", { initData }, deps)).toBeUndefined();
  });

  test("missing initData -> 401 generic", async () => {
    const { status, json } = await callNoAuth("/miniapp/api/users.list");
    expect(status).toBe(401);
    expect(json.error).toBe("احراز هویت نامعتبر است.");
  });

  test("tampered initData -> 401 generic", async () => {
    const bad = initData.replace(/hash=[^&]*/, "hash=deadbeef");
    const res = await handleManageApi("/miniapp/api/users.list", { initData: bad }, deps);
    expect(res!.status).toBe(401);
    expect((await res!.json()).error).toBe("احراز هویت نامعتبر است.");
  });

  test("non-owner initData -> 401", async () => {
    const res = await handleManageApi(
      "/miniapp/api/users.list",
      { initData: makeInitData("123456") },
      deps,
    );
    expect(res!.status).toBe(401);
  });

  test("unknown endpoint -> 404", async () => {
    const { status, json } = await call("/miniapp/api/nope");
    expect(status).toBe(404);
    expect(json.ok).toBe(false);
  });
});

describe("users", () => {
  test("list empty", async () => {
    const { status, json } = await call("/miniapp/api/users.list");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.users).toEqual([]);
  });

  test("ban requires confirm, then bans", async () => {
    storage.createPendingUser({ userId: "111222" });
    const first = await call("/miniapp/api/users.ban", { id: "111222" });
    expect(first.json.needsConfirm).toBe(true);
    // not banned yet
    expect(storage.userAccess("111222")?.state).toBe("pending");

    const second = await call("/miniapp/api/users.ban", { id: "111222", confirm: true });
    expect(second.json.ok).toBe(true);
    expect(second.json.state).toBe("rejected");
    expect(storage.userAccess("111222")?.state).toBe("rejected");

    const list = await call("/miniapp/api/users.list");
    expect(list.json.users[0].isBanned).toBe(true);
    expect(list.json.users[0].id).toBe("111222");
  });

  test("ban rejects bad id and self", async () => {
    const bad = await call("/miniapp/api/users.ban", { id: "abc", confirm: true });
    expect(bad.json.ok).toBe(false);
    const self = await call("/miniapp/api/users.ban", { id: OWNER_ID, confirm: true });
    expect(self.json.ok).toBe(false);
  });

  test("unban lifts a ban", async () => {
    storage.createPendingUser({ userId: "333444" });
    await call("/miniapp/api/users.ban", { id: "333444", confirm: true });
    const un = await call("/miniapp/api/users.unban", { id: "333444" });
    expect(un.json.ok).toBe(true);
    expect(storage.userAccess("333444")?.state).toBe("approved");
  });

  test("list q filters", async () => {
    storage.createPendingUser({ userId: "555666", username: "someuser" });
    const { json } = await call("/miniapp/api/users.list", { q: "someuser" });
    expect(json.total).toBe(1);
    expect(json.users[0].username).toBe("someuser");
  });
});

describe("memory / curator / events", () => {
  test("memory.list and memory.search", async () => {
    storage.upsertMemory({ userId: OWNER_ID, key: "food", content: "قرمه‌سبزی دوست دارد" });
    storage.upsertMemory({ userId: OWNER_ID, key: "city", content: "تهران" });
    const list = await call("/miniapp/api/memory.list", { limit: 10 });
    expect(list.json.ok).toBe(true);
    expect(list.json.total).toBe(2);
    expect(list.json.mems[0].key).toBeDefined();

    const search = await call("/miniapp/api/memory.search", { q: "قرمه" });
    expect(search.json.mems.length).toBe(1);
    expect(search.json.mems[0].key).toBe("food");
  });

  test("curator.proposals + decide approve applies the action", async () => {
    storage.upsertMemory({ userId: OWNER_ID, key: "stale-key", content: "قدیمی" });
    proposalStore.saveProposals(OWNER_ID, [
      {
        id: "p1",
        kind: "stale",
        memoryIds: ["stale-key"],
        summaryFa: "حذف «stale-key»",
        suggestedAction: { type: "delete", keys: ["stale-key"] },
      },
    ]);

    const props = await call("/miniapp/api/curator.proposals");
    expect(props.json.count).toBe(1);
    expect(props.json.proposals[0].kindFa).toBeDefined();

    const decide = await call("/miniapp/api/curator.decide", { id: "p1", approve: true });
    expect(decide.json.ok).toBe(true);
    expect(decide.json.applied).toBe(true);
    expect(storage.listMemories(OWNER_ID, 10).find((m) => m.key === "stale-key")).toBeUndefined();
    expect(proposalStore.listPending(OWNER_ID)).toEqual([]);
  });

  test("curator.decide reject does not apply", async () => {
    storage.upsertMemory({ userId: OWNER_ID, key: "keep-me", content: "مهم" });
    proposalStore.saveProposals(OWNER_ID, [
      {
        id: "p2",
        kind: "stale",
        memoryIds: ["keep-me"],
        summaryFa: "حذف «keep-me»",
        suggestedAction: { type: "delete", keys: ["keep-me"] },
      },
    ]);
    const decide = await call("/miniapp/api/curator.decide", { id: "p2", approve: false });
    expect(decide.json.ok).toBe(true);
    expect(decide.json.applied).toBe(false);
    expect(storage.listMemories(OWNER_ID, 10).find((m) => m.key === "keep-me")).toBeDefined();
  });

  test("curator.decide unknown id -> error", async () => {
    const { json } = await call("/miniapp/api/curator.decide", { id: "nope", approve: true });
    expect(json.ok).toBe(false);
  });

  test("events.list returns upcoming events", async () => {
    const store = new EventStore(resolveMemoryProvider(storage));
    // A "once" event 3 days out is always inside the 7-day upcoming horizon.
    const fmt = new Intl.DateTimeFormat("en-u-ca-persian", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      timeZone: "Asia/Tehran",
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(Date.now() + 3 * 24 * 60 * 60 * 1000).map((p) => [p.type, p.value]),
    );
    await store.add(OWNER_ID, {
      name: "قرار کاری",
      kind: "once",
      jYear: Number(parts["year"]),
      jMonth: Number(parts["month"]),
      jDay: Number(parts["day"]),
      labelFa: "سه روز دیگر",
    });
    const { json } = await call("/miniapp/api/events.list");
    expect(json.ok).toBe(true);
    expect(json.count).toBe(1);
    expect(json.events[0].name).toBe("قرار کاری");
    expect(json.events[0].daysUntil).toBe(3);
  });
});

describe("bench", () => {
  function recordTwoRuns() {
    const r1 = buildReport(
      [
        {
          taskId: "t1",
          title_fa: "تسک یک",
          category: "c",
          passed: true,
          score: 8,
          maxScore: 10,
          checks: [],
          turns: [],
          totalLatencyMs: 100,
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0,
          costEstimated: true,
        },
      ],
      { mode: "offline", provider: "p", model: "m1" },
    );
    benchHistory.recordRun(r1, "ok");
    const r2 = buildReport([], { mode: "offline", provider: "p", model: "m1" });
    benchHistory.recordRun(r2, "ok");
  }

  test("runs + trends", async () => {
    recordTwoRuns();
    const runs = await call("/miniapp/api/bench.runs", { limit: 10 });
    expect(runs.json.ok).toBe(true);
    expect(runs.json.runs.length).toBe(2);
    expect(runs.json.runs[0].mode).toBe("offline");

    const trends = await call("/miniapp/api/bench.trends", {});
    expect(trends.json.ok).toBe(true);
    expect(trends.json.pair).toEqual({ mode: "offline", model: "m1" });
    expect(trends.json.runs.length).toBe(2);

    const taskTrend = await call("/miniapp/api/bench.trends", {
      mode: "offline",
      model: "m1",
      task: "t1",
    });
    expect(taskTrend.json.task.points.length).toBe(1);
    expect(taskTrend.json.task.points[0].scorePct).toBe(80);
  });

  test("trends invalid mode rejected", async () => {
    const { json } = await call("/miniapp/api/bench.trends", { mode: "bad!!", model: "m1" });
    expect(json.ok).toBe(false);
  });

  test("schedule get/set", async () => {
    const get0 = await call("/miniapp/api/bench.schedule");
    expect(get0.json.schedule.exists).toBe(false);

    const set = await call("/miniapp/api/bench.schedule", { enabled: true, cadence: "daily" });
    expect(set.json.ok).toBe(true);
    expect(set.json.cron).toBe("0 3 * * *");

    const get1 = await call("/miniapp/api/bench.schedule");
    expect(get1.json.schedule.exists).toBe(true);
    expect(get1.json.schedule.enabled).toBe(true);

    const bad = await call("/miniapp/api/bench.schedule", { enabled: true, cron: "* * * * *" });
    expect(bad.json.ok).toBe(false); // too frequent

    const off = await call("/miniapp/api/bench.schedule", { enabled: false });
    expect(off.json.ok).toBe(true);
    const get2 = await call("/miniapp/api/bench.schedule");
    expect(get2.json.schedule.enabled).toBe(false);
  });

  test("alerts", async () => {
    benchHistory.markAlertSent("bench-worker-failures", Date.now());
    const { json } = await call("/miniapp/api/bench.alerts");
    expect(json.ok).toBe(true);
    expect(json.alerts.length).toBe(1);
    expect(json.alerts[0].key).toBe("bench-worker-failures");
    expect(json.alerts[0].labelFa).toBeDefined();
  });
});

describe("schedulers + digest", () => {
  test("schedulers.list + toggle", async () => {
    await call("/miniapp/api/bench.schedule", { enabled: true, cadence: "daily" });
    const list = await call("/miniapp/api/schedulers.list");
    expect(list.json.schedulers.length).toBe(1);
    const id = list.json.schedulers[0].id;

    const toggled = await call("/miniapp/api/schedulers.toggle", { id, enabled: false });
    expect(toggled.json.ok).toBe(true);
    const list2 = await call("/miniapp/api/schedulers.list");
    expect(list2.json.schedulers[0].enabled).toBe(false);

    const missing = await call("/miniapp/api/schedulers.toggle", { id: 99999, enabled: true });
    expect(missing.status).toBe(404);
  });

  test("digest.config get when missing, set prompt/time after creating the row", async () => {
    const get0 = await call("/miniapp/api/digest.config");
    expect(get0.json.exists).toBe(false);
    expect(get0.json.ownedBy).toBe("blueprint");

    const id = storage.createTask({
      name: "blueprint: morning_digest",
      cronExpr: "0 8 * * *",
      timezone: "Asia/Tehran",
      actionJson: JSON.stringify({ type: "agent", chatId: OWNER_ID, prompt: "old prompt" }),
      createdByUserId: OWNER_ID,
      nextRunAtMs: Date.now() + 3600_000,
      enabled: true,
    });
    expect(id).toBeGreaterThan(0);

    const get1 = await call("/miniapp/api/digest.config");
    expect(get1.json.exists).toBe(true);
    expect(get1.json.prompt).toBe("old prompt");
    expect(get1.json.isCustomPrompt).toBe(true);

    const setPrompt = await call("/miniapp/api/digest.config", { prompt: "پرامپت جدید" });
    expect(setPrompt.json.ok).toBe(true);
    expect(setPrompt.json.isCustomPrompt).toBe(true);

    const setTime = await call("/miniapp/api/digest.config", { time: "09:30" });
    expect(setTime.json.ok).toBe(true);
    expect(setTime.json.time).toBe("09:30");

    const badTime = await call("/miniapp/api/digest.config", { time: "99:99" });
    expect(badTime.json.ok).toBe(false);
  });

  test("digest.preview renders text", async () => {
    const { json } = await call("/miniapp/api/digest.preview");
    expect(json.ok).toBe(true);
    expect(typeof json.text).toBe("string");
    expect(json.text.length).toBeGreaterThan(0);
  });

  test("group digests need assistant mode first", async () => {
    const chatId = "-100123";
    const noMode = await call("/miniapp/api/groupdigests.set", {
      chatId,
      digestEnabled: true,
    });
    expect(noMode.json.ok).toBe(false);

    const a = await call("/miniapp/api/groups.assistant.set", {
      groupId: chatId,
      enabled: true,
    });
    expect(a.json.ok).toBe(true);
    expect(a.json.config.enabled).toBe(true);

    const on = await call("/miniapp/api/groupdigests.set", {
      chatId,
      digestEnabled: true,
      time: "08:00",
    });
    expect(on.json.ok).toBe(true);
    expect(on.json.digestEnabled).toBe(true);

    const list = await call("/miniapp/api/groupdigests.list");
    expect(list.json.groups.length).toBe(1);
    expect(list.json.groups[0].chatId).toBe(chatId);
    expect(list.json.groups[0].digestEnabled).toBe(true);

    const one = await call("/miniapp/api/groups.digests", { groupId: chatId });
    expect(one.json.chatId).toBe(chatId);

    const viaGroups = await call("/miniapp/api/groups.digests.set", {
      chatId,
      digestEnabled: false,
    });
    expect(viaGroups.json.ok).toBe(true);
  });
});

describe("skills + trust", () => {
  const SKILL_MD = `---
name: test-skill
description: a test skill
version: 1.2.3
---

# test-skill

Does things.
`;

  function installDisabled(name: string): void {
    const plan = prepareSkillInstall({ text: SKILL_MD.replace("test-skill", name).replace("# test-skill", `# ${name}`), source: "text", dir: skillsDir });
    if (!plan.ok) throw new Error("prepare failed");
    writeSkillFile(skillsDir, plan.validated);
  }

  test("list / toggle / uninstall", async () => {
    installDisabled("alpha-skill");
    const list = await call("/miniapp/api/skills.list");
    expect(list.json.skills.length).toBe(1);
    expect(list.json.skills[0].name).toBe("alpha-skill");
    expect(list.json.skills[0].version).toBe("1.2.3");
    expect(list.json.skills[0].trusted).toBe(false);

    const toggled = await call("/miniapp/api/skills.toggle", {
      name: "alpha-skill",
      enabled: false,
    });
    expect(toggled.json.ok).toBe(true);
    expect(toggled.json.enabled).toBe(false);

    const first = await call("/miniapp/api/skills.uninstall", { name: "alpha-skill" });
    expect(first.json.needsConfirm).toBe(true);
    const second = await call("/miniapp/api/skills.uninstall", {
      name: "alpha-skill",
      confirm: true,
    });
    expect(second.json.ok).toBe(true);
    const list2 = await call("/miniapp/api/skills.list");
    expect(list2.json.skills).toEqual([]);
  });

  test("toggle validates name", async () => {
    const { json } = await call("/miniapp/api/skills.toggle", {
      name: "../evil",
      enabled: true,
    });
    expect(json.ok).toBe(false);
  });

  test("install returns review card, then installs disabled on confirm", async () => {
    const review = await call("/miniapp/api/skills.install", { source: SKILL_MD });
    expect(review.json.ok).toBe(true);
    expect(review.json.needsConfirm).toBe(true);
    expect(review.json.review.name).toBe("test-skill");
    expect(review.json.review.warnings).toEqual([]);

    // nothing written yet
    const list0 = await call("/miniapp/api/skills.list");
    expect(list0.json.skills).toEqual([]);

    const done = await call("/miniapp/api/skills.install", {
      source: SKILL_MD,
      confirm: true,
    });
    expect(done.json.ok).toBe(true);
    expect(done.json.installed).toBe(true);
    expect(done.json.enabled).toBe(false);

    const list1 = await call("/miniapp/api/skills.list");
    expect(list1.json.skills.length).toBe(1);
    expect(list1.json.skills[0].enabled).toBe(true); // file written enabled by writeSkillFile
  });

  test("install rejects garbage text", async () => {
    const { json } = await call("/miniapp/api/skills.install", { source: "hello world" });
    expect(json.ok).toBe(false);
  });

  test("trust add/list/remove", async () => {
    const keyId = "ab".repeat(32);
    const added = await call("/miniapp/api/trust.add", {
      publisher: keyId,
      label: "acme",
    });
    expect(added.json.ok).toBe(true);
    expect(added.json.added).toBe(true);

    const list = await call("/miniapp/api/trust.list");
    expect(list.json.publishers.length).toBe(1);
    expect(list.json.publishers[0].label).toBe("acme");
    expect(list.json.publishers[0].keyId).toBe(keyId);

    const bad = await call("/miniapp/api/trust.add", { publisher: "not-a-key" });
    expect(bad.json.ok).toBe(false);

    const first = await call("/miniapp/api/trust.remove", { publisher: keyId });
    expect(first.json.needsConfirm).toBe(true);
    const second = await call("/miniapp/api/trust.remove", {
      publisher: keyId,
      confirm: true,
    });
    expect(second.json.ok).toBe(true);
    const list2 = await call("/miniapp/api/trust.list");
    expect(list2.json.publishers).toEqual([]);
  });
});

describe("usage + tasks", () => {
  test("usage.report", async () => {
    storage.recordUsage({
      userId: OWNER_ID,
      conversationId: 1,
      providerId: 1,
      modelId: "gpt-test",
      inputTokens: 100,
      outputTokens: 50,
      atMs: Date.now(),
    });
    const { json } = await call("/miniapp/api/usage.report", { days: 1 });
    expect(json.ok).toBe(true);
    expect(json.days).toBe(1);
    expect(json.runs).toBe(1);
    expect(json.inputTokens).toBe(100);
    expect(json.byModel[0].modelId).toBe("gpt-test");
    expect(typeof json.estimatedUsd).toBe("number");
  });

  test("tasks list/complete/cancel", async () => {
    const goalId = storage.createGoal({ title: "goal one", createdBy: OWNER_ID });
    const remId = storage.createReminder({
      userId: OWNER_ID,
      chatId: OWNER_ID,
      text: "remind me",
      dueAt: Date.now() + 1000,
      repeat: "none",
    });
    const taskId = storage.createTask({
      name: "custom task",
      cronExpr: "0 9 * * *",
      timezone: "Asia/Tehran",
      actionJson: JSON.stringify({ type: "message", chatId: OWNER_ID, text: "hi" }),
      createdByUserId: OWNER_ID,
      nextRunAtMs: Date.now() + 1000,
      enabled: true,
    });

    const list = await call("/miniapp/api/tasks.list");
    expect(list.json.goals.length).toBe(1);
    expect(list.json.goals[0].id).toBe(goalId);
    expect(list.json.reminders.length).toBe(1);
    expect(list.json.reminders[0].id).toBe(remId);
    expect(list.json.tasks.find((t: any) => t.id === taskId)).toBeDefined();

    const doneGoal = await call("/miniapp/api/tasks.complete", { kind: "goal", id: goalId });
    expect(doneGoal.json.ok).toBe(true);
    expect(storage.getGoal(OWNER_ID, goalId)?.status).toBe("done");

    const doneRem = await call("/miniapp/api/tasks.complete", { kind: "reminder", id: remId });
    expect(doneRem.json.ok).toBe(true);

    const cancelTaskFirst = await call("/miniapp/api/tasks.cancel", { kind: "task", id: taskId });
    expect(cancelTaskFirst.json.needsConfirm).toBe(true);
    const cancelTask = await call("/miniapp/api/tasks.cancel", {
      kind: "task",
      id: taskId,
      confirm: true,
    });
    expect(cancelTask.json.ok).toBe(true);

    const cancelGoal = await call("/miniapp/api/tasks.cancel", { kind: "goal", id: goalId });
    expect(cancelGoal.json.ok).toBe(false); // goals have no delete

    const badKind = await call("/miniapp/api/tasks.complete", { kind: "nope", id: 1 });
    expect(badKind.json.ok).toBe(false);
  });
});

describe("groups + moderation", () => {
  test("groups.list + assistant get/set", async () => {
    const empty = await call("/miniapp/api/groups.list");
    expect(empty.json.groups).toEqual([]);

    const set = await call("/miniapp/api/groups.assistant.set", {
      groupId: "-100999",
      enabled: true,
      smart: true,
    });
    expect(set.json.ok).toBe(true);
    expect(set.json.config.smartSummary).toBe(true);

    const get = await call("/miniapp/api/groups.assistant", { groupId: "-100999" });
    expect(get.json.config.enabled).toBe(true);

    const list = await call("/miniapp/api/groups.list");
    expect(list.json.groups.length).toBe(1);
    expect(list.json.groups[0].assistantEnabled).toBe(true);

    const bad = await call("/miniapp/api/groups.assistant.set", {
      groupId: "not an id",
      enabled: true,
    });
    expect(bad.json.ok).toBe(false);
  });

  test("moderation get/set", async () => {
    const get = await call("/miniapp/api/moderation.get", { groupId: "-100999" });
    expect(get.json.ok).toBe(true);
    expect(get.json.config.enabled).toBe(false); // default, opt-in

    const set = await call("/miniapp/api/moderation.set", {
      groupId: "-100999",
      enabled: true,
      linkPolicy: "warn",
      floodMaxMessages: 8,
    });
    expect(set.json.ok).toBe(true);
    expect(set.json.config.enabled).toBe(true);
    expect(set.json.config.linkPolicy).toBe("warn");

    const badField = await call("/miniapp/api/moderation.set", {
      groupId: "-100999",
      nope: true,
    });
    expect(badField.json.ok).toBe(false); // unknown fields rejected

    const badRange = await call("/miniapp/api/moderation.set", {
      groupId: "-100999",
      floodMaxMessages: 999,
    });
    expect(badRange.json.ok).toBe(false);
  });
});
