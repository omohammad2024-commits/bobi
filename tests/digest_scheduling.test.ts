/**
 * Platform Phase 10 — digest scheduling behind the one facade.
 *
 * DigestSchedulingService (src/digest/scheduling.ts) is the single
 * implementation of morning + group digest scheduling; the Mini App's
 * digest handlers are adapters over it (covered by miniapp_manage
 * tests). These tests pin the service directly and its exposure through
 * SchedulingFacade (platform.scheduling.digests).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Storage } from "../src/storage/storage";
import {
  DIGEST_TASK_NAME,
  DigestSchedulingService,
  digestTimeOf,
} from "../src/digest/scheduling";
import { SchedulingFacade } from "../src/platform/scheduling";

const OWNER = "777001";

let storage: Storage;
let svc: DigestSchedulingService;
let audits: Array<{ outcome: string; detail: string }>;
const audit = (outcome: "success" | "denied" | "error", detail: string) => {
  audits.push({ outcome, detail });
};

beforeEach(() => {
  storage = Storage.open(":memory:");
  svc = new DigestSchedulingService(storage);
  audits = [];
});

afterEach(() => {
  storage.close();
});

function seedMorningTask(): void {
  storage.scheduling.createTask({
    name: DIGEST_TASK_NAME,
    cronExpr: "0 8 * * *",
    timezone: "Asia/Tehran",
    actionJson: JSON.stringify({ type: "agent", chatId: OWNER, prompt: "custom prompt" }),
    createdByUserId: OWNER,
    nextRunAtMs: Date.now() + 3_600_000,
    enabled: true,
  });
}

describe("DigestSchedulingService — morning digest", () => {
  test("view reports a missing digest honestly", () => {
    expect(svc.morningView(OWNER)).toMatchObject({ exists: false, enabled: false });
  });

  test("view reflects the seeded task (time, custom prompt, destination)", () => {
    seedMorningTask();
    const view = svc.morningView(OWNER);
    expect(view).toMatchObject({
      exists: true,
      enabled: true,
      time: "08:00",
      custom: false,
      prompt: "custom prompt",
      isCustomPrompt: true,
      chatId: OWNER,
      isDefaultDestination: true,
    });
  });

  test("morningConfig with no fields is the GET view; with a time it reschedules + audits", async () => {
    seedMorningTask();
    const view = await svc.morningConfig(OWNER, {}, audit).json();
    expect(view.exists).toBe(true);

    const res = svc.morningConfig(OWNER, { time: "09:30" }, audit);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ enabled: true, time: "09:30" });
    expect(svc.morningTask(OWNER)?.cronExpr).toBe("30 9 * * *");
    expect(audits.at(-1)?.outcome).toBe("success");
  });

  test("morningConfig on a missing digest is a 400 with a denied audit", async () => {
    const res = svc.morningConfig(OWNER, { prompt: "new" }, audit);
    expect(res.status).toBe(400);
    expect(audits).toEqual([{ outcome: "denied", detail: "no digest task" }]);
  });

  test("digestTimeOf parses only the daily shape", () => {
    expect(digestTimeOf("30 9 * * *")).toBe("09:30");
    expect(digestTimeOf("*/15 * * * *")).toBeNull();
  });
});

describe("SchedulingFacade exposure", () => {
  test("digests is reachable through the facade when wired", () => {
    const facade = new SchedulingFacade({
      reminders: undefined as never,
      tasks: undefined as never,
      heartbeat: undefined as never,
      digests: svc,
    });
    expect(facade.digests).toBe(svc);
    expect(facade.digests?.morningView(OWNER)).toMatchObject({ exists: false });
  });

  test("digests is undefined in a partial embedding (no fake)", () => {
    const facade = new SchedulingFacade({
      reminders: undefined as never,
      tasks: undefined as never,
      heartbeat: undefined as never,
    });
    expect(facade.digests).toBeUndefined();
  });
});
