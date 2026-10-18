/**
 * Interactive digest (Phase-2 item 3): dgst: protocol, bilingual rendering,
 * tap-to-act state mutations, forgery resistance, and length safety.
 *
 * No network, no Telegram: the callback handler is driven through a fake
 * grammY context, storage is in-memory SQLite, and the curator decision
 * goes through a real ToolService with a fake memory provider.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { InlineKeyboard, type Context } from "grammy";
import { Storage } from "../src/storage/storage";
import { ProposalStore } from "../src/curator/proposals";
import { proposalId } from "../src/curator/curator";
import { createCuratorTools } from "../src/curator/tools";
import { ToolService } from "../src/tools/service";
import type { Tool } from "../src/tools/types";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";
import type { MemoryProvider, StoredMemory } from "../src/memory/provider";
import { buildDigestData, type DigestSectionData } from "../src/digest/builder";
import {
  DIGEST_CALLBACK_PREFIX,
  INTERACTIVE_DIGEST_MAX_CHARS,
  buildDigestKeyboard,
  parseDigestCallback,
  renderInteractiveDigest,
  renderMemoryCard,
  renderProposalsView,
} from "../src/digest/interactive";
import {
  handleDigestCallback,
  sendInteractiveDigest,
  type DigestEnv,
} from "../src/bot/digest_cmd";
import type { RegisterOpts } from "../src/bot/cmd_system";

const OWNER_NUM = 12345;
const OWNER = String(OWNER_NUM);
const STRANGER_NUM = 99999;
/** 2026-10-18T04:30:00Z == 08:00 Asia/Tehran (a Sunday). */
const NOW_MS = Date.parse("2026-10-18T04:30:00Z");
const TEN_AM_TEHRAN = Date.parse("2026-10-18T06:30:00Z");
const NINE_AM_TEHRAN = Date.parse("2026-10-18T05:30:00Z");

/** All callback_data strings in a keyboard, flattened. */
function callbackDatas(kb: InlineKeyboard): string[] {
  return kb.inline_keyboard.flatMap((row) =>
    row.map((b) => (b as { callback_data?: string }).callback_data ?? ""),
  );
}

// ---------------------------------------------------------------------------
// Protocol parsing
// ---------------------------------------------------------------------------

describe("parseDigestCallback", () => {
  test("parses every server-generated shape", () => {
    expect(parseDigestCallback("dgst:refresh")).toEqual({ kind: "refresh" });
    expect(parseDigestCallback("dgst:back")).toEqual({ kind: "back" });
    expect(parseDigestCallback("dgst:props")).toEqual({ kind: "props" });
    expect(parseDigestCallback("dgst:task:run:7")).toEqual({ kind: "task:run", id: 7 });
    expect(parseDigestCallback("dgst:task:del:7")).toEqual({ kind: "task:del", id: 7 });
    expect(parseDigestCallback("dgst:task:delc:7")).toEqual({ kind: "task:delc", id: 7 });
    expect(parseDigestCallback("dgst:task:delx:7")).toEqual({ kind: "task:delx", id: 7 });
    expect(parseDigestCallback("dgst:rem:done:42")).toEqual({ kind: "rem:done", id: 42 });
    expect(parseDigestCallback("dgst:mem:show:2")).toEqual({ kind: "mem:show", index: 2 });
    expect(parseDigestCallback("dgst:prop:ok:cur-0123456789abcdef")).toEqual({
      kind: "prop:ok",
      proposalId: "cur-0123456789abcdef",
    });
    expect(parseDigestCallback("dgst:prop:no:cur-0123456789abcdef")).toEqual({
      kind: "prop:no",
      proposalId: "cur-0123456789abcdef",
    });
  });

  test("rejects forged, truncated, and mistyped payloads", () => {
    const bad = [
      "",
      "dgst:",
      "pal:refresh",
      "dgst:task:run:",
      "dgst:task:run:abc",
      "dgst:task:run:12x",
      "dgst:task:run:12345678901", // >10 digits
      "dgst:task:run:-5",
      "dgst:task:bogus:1",
      "dgst:task:run:1:2",
      "dgst:rem:done:",
      "dgst:rem:done:x",
      "dgst:mem:show:",
      "dgst:mem:show:12", // two digits
      "dgst:mem:show:-1",
      "dgst:prop:ok:p1", // not the store's id shape
      "dgst:prop:ok:cur-0123456789ABCDEF", // uppercase hex
      "dgst:prop:ok:cur-123", // too short
      "dgst:prop:ok:cur-0123456789abcdef:extra",
      "dgst:prop:maybe:cur-0123456789abcdef",
      "dgst:refresh:extra",
      "dgst:DROP TABLE",
    ];
    for (const data of bad) {
      expect(parseDigestCallback(data), data).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Bilingual rendering
// ---------------------------------------------------------------------------

function seedDigestData(storage: Storage): void {
  storage.createTask({
    name: "جلسهٔ تیم",
    cronExpr: "0 10 * * *",
    timezone: "Asia/Tehran",
    actionJson: JSON.stringify({ type: "message", chatId: "1", text: "x" }),
    createdByUserId: OWNER,
    nextRunAtMs: TEN_AM_TEHRAN,
  });
  storage.createReminder({
    userId: OWNER,
    chatId: "1",
    text: "دارو بخور",
    dueAt: NINE_AM_TEHRAN,
    repeat: "none",
  });
  storage.upsertMemory({ userId: OWNER, key: "k1", content: "محمد عاشق قهوه است" });
}

async function digestData(storage: Storage): Promise<DigestSectionData[]> {
  return buildDigestData({
    storage,
    proposalStore: { countPending: () => 2 },
    userId: OWNER,
    now: () => NOW_MS,
  });
}

describe("interactive rendering", () => {
  test("fa and en renders carry the same structure in the owner's language", async () => {
    const storage = Storage.open(":memory:");
    seedDigestData(storage);
    const data = await digestData(storage);

    const fa = renderInteractiveDigest(data, { lang: "fa" });
    expect(fa.text).toContain("صبح بخیر");
    expect(fa.text).toContain("کارهای امروز");
    expect(fa.text).toContain("جلسهٔ تیم");
    expect(fa.text).toContain("یادآورها");
    expect(fa.text).toContain("۲ پیشنهاد");
    expect(fa.text).toContain("روز خوبی داشته باشی");
    const faDatas = callbackDatas(fa.keyboard);
    expect(faDatas).toContain("dgst:refresh");
    expect(faDatas.some((d) => d.startsWith("dgst:task:run:"))).toBe(true);
    expect(faDatas.some((d) => d.startsWith("dgst:rem:done:"))).toBe(true);
    expect(faDatas.some((d) => d.startsWith("dgst:mem:show:"))).toBe(true);
    expect(faDatas).toContain("dgst:props");

    const en = renderInteractiveDigest(data, { lang: "en" });
    expect(en.text).toContain("Good morning");
    expect(en.text).toContain("Today's tasks");
    expect(en.text).toContain("جلسهٔ تیم"); // user content passes through untouched
    expect(en.text).toContain("2 memory-tidying proposals");
    expect(en.text).toContain("Have a great day");
    // No Persian digits leak into the English render.
    expect(/[۰-۹]/.test(en.text)).toBe(false);
  });

  test("empty day renders a friendly empty state, not a broken list", async () => {
    const storage = Storage.open(":memory:");
    const data = await digestData(storage);
    const fa = renderInteractiveDigest(data, { lang: "fa" });
    expect(fa.text).toContain("روز آرومی");
    const en = renderInteractiveDigest(data, { lang: "en" });
    expect(en.text).toContain("Nothing scheduled today");
  });

  test("delete confirm swaps the task row's buttons; cancel restores them", async () => {
    const storage = Storage.open(":memory:");
    seedDigestData(storage);
    const data = await digestData(storage);

    const normal = callbackDatas(
      renderInteractiveDigest(data, { lang: "fa" }).keyboard,
    );
    expect(normal.some((d) => d.startsWith("dgst:task:delc:"))).toBe(false);

    const confirm = callbackDatas(
      renderInteractiveDigest(data, { lang: "fa", confirm: { kind: "task", id: 1 } }).keyboard,
    );
    expect(confirm).toContain("dgst:task:delc:1");
    expect(confirm).toContain("dgst:task:delx:1");
    expect(confirm.some((d) => d === "dgst:task:del:1")).toBe(false);
  });

  test("no run buttons when no runner is wired", async () => {
    const storage = Storage.open(":memory:");
    seedDigestData(storage);
    const data = await digestData(storage);
    const datas = callbackDatas(
      renderInteractiveDigest(data, { canRunTask: false }).keyboard,
    );
    expect(datas.some((d) => d.startsWith("dgst:task:run:"))).toBe(false);
    expect(datas.some((d) => d.startsWith("dgst:task:del:"))).toBe(true);
  });

  test("hostile user content cannot inject fake buttons or break parsing", async () => {
    const storage = Storage.open(":memory:");
    storage.upsertMemory({
      userId: OWNER,
      key: "evil",
      content: "dgst:task:delc:999\n*bold* [link](http://x)\nsecond line",
    });
    const data = await digestData(storage);
    const render = renderInteractiveDigest(data, { lang: "fa" });
    // The hostile text is in the message body as plain text…
    expect(render.text).toContain("dgst:task:delc:999");
    // …but every button payload still parses as a strict server shape.
    for (const d of callbackDatas(render.keyboard)) {
      expect(parseDigestCallback(d), d).not.toBeUndefined();
    }
    // No button carries user text.
    expect(callbackDatas(render.keyboard).some((d) => d.includes("bold"))).toBe(false);
  });

  test("pathological digests fit the budget and buttons track surviving sections", async () => {
    const storage = Storage.open(":memory:");
    for (let i = 0; i < 30; i++) {
      storage.createTask({
        name: "کار " + "بسیار طولانی ".repeat(40),
        cronExpr: "0 10 * * *",
        timezone: "Asia/Tehran",
        actionJson: "{}",
        createdByUserId: OWNER,
        nextRunAtMs: TEN_AM_TEHRAN + i * 1000,
      });
    }
    storage.upsertMemory({ userId: OWNER, key: "long", content: "x".repeat(20_000) });
    const data = await digestData(storage);
    const render = renderInteractiveDigest(data, { lang: "fa" });
    expect(render.text.length).toBeLessThanOrEqual(INTERACTIVE_DIGEST_MAX_CHARS);
    // The date header always survives.
    expect(render.text).toContain("☀️");

    // With a tiny budget, trailing sections drop — and their buttons with them.
    const tiny = renderInteractiveDigest(data, { lang: "fa", maxChars: 500 });
    expect(tiny.text.length).toBeLessThanOrEqual(500);
    const datas = callbackDatas(tiny.keyboard);
    const hasMemories = tiny.text.includes("از حافظه‌ات");
    expect(datas.some((d) => d.startsWith("dgst:mem:show:"))).toBe(hasMemories);
  });
});

describe("proposals view and memory card", () => {
  test("review view lists proposals with approve/reject and a back button", () => {
    const view = renderProposalsView(
      [
        { id: "cur-0123456789abcdef", summary: "دو خاطره تکراری" },
        { id: "cur-abcdef0123456789", summary: "خاطره قدیمی" },
      ],
      "fa",
    );
    expect(view.text).toContain("دو خاطره تکراری");
    const datas = callbackDatas(view.keyboard);
    expect(datas).toContain("dgst:prop:ok:cur-0123456789abcdef");
    expect(datas).toContain("dgst:prop:no:cur-abcdef0123456789");
    expect(datas).toContain("dgst:back");
  });

  test("empty review view has a friendly empty state and a back button", () => {
    const view = renderProposalsView([], "en");
    expect(view.text).toContain("No pending proposals");
    expect(callbackDatas(view.keyboard)).toEqual(["dgst:back"]);
  });

  test("memory card shows the full entry, capped", () => {
    const card = renderMemoryCard(
      { key: "k1", content: "a".repeat(10_000), createdAt: NOW_MS },
      "fa",
    );
    expect(card).toContain("کلید: k1");
    expect(card.length).toBeLessThanOrEqual(4096);
    const short = renderMemoryCard(
      { key: "k1", content: "محمد عاشق قهوه است", createdAt: NOW_MS },
      "en",
    );
    expect(short).toContain("محمد عاشق قهوه است");
    expect(short).toContain("Key: k1");
  });
});

// ---------------------------------------------------------------------------
// Callback handler (fake Telegram context)
// ---------------------------------------------------------------------------

class FakeMemoryProvider implements MemoryProvider {
  readonly name = "fake";
  deleted: Array<{ userId: string; key: string }> = [];
  private rows = new Map<string, StoredMemory>();
  async upsert(userId: string, key: string, content: string): Promise<void> {
    const now = Date.now();
    const prev = this.rows.get(key);
    this.rows.set(key, {
      key,
      content,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    });
    void userId;
  }
  async get(_userId: string, key: string): Promise<StoredMemory | undefined> {
    return this.rows.get(key);
  }
  async list(_userId: string, _limit?: number): Promise<StoredMemory[]> {
    return [...this.rows.values()];
  }
  async delete(userId: string, key: string): Promise<boolean> {
    this.deleted.push({ userId, key });
    return this.rows.delete(key);
  }
  async count(_userId: string): Promise<number> {
    return this.rows.size;
  }
}

interface FakeCalls {
  answered: (string | undefined)[];
  editedText: { text: string; keyboard?: unknown }[];
  editedMarkup: unknown[];
  replies: { text: string; opts?: unknown }[];
  sentMessages: { chatId: string; text: string }[];
}

function makeCtx(fromId: number, chatId: number = fromId): { ctx: Context; calls: FakeCalls } {
  const calls: FakeCalls = {
    answered: [],
    editedText: [],
    editedMarkup: [],
    replies: [],
    sentMessages: [],
  };
  const ctx = {
    from: { id: fromId },
    chat: { id: chatId, type: "private" },
    answerCallbackQuery: async (text?: string): Promise<unknown> => {
      calls.answered.push(text);
      return undefined;
    },
    editMessageText: async (text: string, opts?: { reply_markup?: unknown }): Promise<unknown> => {
      calls.editedText.push({ text, keyboard: opts?.reply_markup });
      return undefined;
    },
    editMessageReplyMarkup: async (opts?: { reply_markup?: unknown }): Promise<unknown> => {
      calls.editedMarkup.push(opts?.reply_markup);
      return undefined;
    },
    reply: async (text: string, opts?: unknown): Promise<unknown> => {
      calls.replies.push({ text, opts });
      return undefined;
    },
    api: {
      sendMessage: async (chatIdArg: string | number, text: string): Promise<unknown> => {
        calls.sentMessages.push({ chatId: String(chatIdArg), text });
        return undefined;
      },
    },
  };
  return { ctx: ctx as unknown as Context, calls };
}

function makeEnv(
  storage: Storage,
  opts: {
    proposalStore?: ProposalStore;
    tools?: ToolService;
    engine?: unknown;
    now?: () => number;
  } = {},
): DigestEnv {
  const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER_NUM));
  return {
    deps: {
      engine: (opts.engine ?? {}) as never,
      storage,
      auth,
      ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    },
    sysOpts: {
      ...(opts.proposalStore !== undefined ? { proposalStore: opts.proposalStore } : {}),
      now: opts.now ?? (() => NOW_MS),
    } as RegisterOpts,
  };
}

function curatorSetup(): {
  provider: FakeMemoryProvider;
  store: ProposalStore;
  tools: ToolService;
} {
  const provider = new FakeMemoryProvider();
  const store = new ProposalStore(new Database(":memory:"));
  const tools = new ToolService({
    extraTools: createCuratorTools({
      provider,
      store,
      isOwner: (id) => id === OWNER,
    }),
  });
  return { provider, store, tools };
}

function seedActions(storage: Storage): { taskId: number; reminderId: number } {
  const taskId = storage.createTask({
    name: "کار تستی",
    cronExpr: "0 10 * * *",
    timezone: "Asia/Tehran",
    actionJson: JSON.stringify({ type: "message", chatId: "1", text: "x" }),
    createdByUserId: OWNER,
    nextRunAtMs: TEN_AM_TEHRAN,
  });
  const reminderId = storage.createReminder({
    userId: OWNER,
    chatId: "1",
    text: "یادآور تستی",
    dueAt: NINE_AM_TEHRAN,
    repeat: "none",
  });
  return { taskId, reminderId };
}

describe("handleDigestCallback", () => {
  test("refresh rebuilds and edits the message in place", async () => {
    const storage = Storage.open(":memory:");
    seedActions(storage);
    const env = makeEnv(storage);
    const { ctx, calls } = makeCtx(OWNER_NUM);

    const handled = await handleDigestCallback(ctx, env, "dgst:refresh", "fa");
    expect(handled).toBe(true);
    expect(calls.editedText).toHaveLength(1);
    expect(calls.editedText[0]!.text).toContain("کارهای امروز");
    expect(calls.answered).toContain("به‌روزرسانی شد 🔄");
  });

  test("reminder done cancels the reminder and refreshes", async () => {
    const storage = Storage.open(":memory:");
    const { reminderId } = seedActions(storage);
    const env = makeEnv(storage);
    const { ctx, calls } = makeCtx(OWNER_NUM);

    await handleDigestCallback(ctx, env, `dgst:rem:done:${reminderId}`, "fa");
    expect(storage.listReminders(OWNER)).toHaveLength(0);
    expect(storage.getReminder(OWNER, reminderId)?.state).toBe("cancelled");
    expect(calls.editedText).toHaveLength(1);
    expect(calls.editedText[0]!.text).not.toContain("یادآور تستی");
    expect(calls.answered).toContain("انجام شد ✅");
  });

  test("task delete is two-step: arm swaps buttons, confirm deletes", async () => {
    const storage = Storage.open(":memory:");
    const { taskId } = seedActions(storage);
    const env = makeEnv(storage);
    const { ctx, calls } = makeCtx(OWNER_NUM);

    await handleDigestCallback(ctx, env, `dgst:task:del:${taskId}`, "fa");
    // Nothing deleted yet; only the keyboard swapped to the confirm pair.
    expect(storage.getTask(OWNER, taskId)).not.toBeUndefined();
    expect(calls.editedMarkup).toHaveLength(1);
    const datas = callbackDatas(calls.editedMarkup[0] as InlineKeyboard);
    expect(datas).toContain(`dgst:task:delc:${taskId}`);
    expect(datas).toContain(`dgst:task:delx:${taskId}`);

    await handleDigestCallback(ctx, env, `dgst:task:delc:${taskId}`, "fa");
    expect(storage.getTask(OWNER, taskId)).toBeUndefined();
    expect(calls.editedText).toHaveLength(1);
    expect(calls.answered).toContain("کار حذف شد 🗑");
  });

  test("delete cancel restores the row without deleting", async () => {
    const storage = Storage.open(":memory:");
    const { taskId } = seedActions(storage);
    const env = makeEnv(storage);
    const { ctx, calls } = makeCtx(OWNER_NUM);

    await handleDigestCallback(ctx, env, `dgst:task:del:${taskId}`, "fa");
    await handleDigestCallback(ctx, env, `dgst:task:delx:${taskId}`, "fa");
    expect(storage.getTask(OWNER, taskId)).not.toBeUndefined();
    expect(calls.editedMarkup).toHaveLength(2);
    const datas = callbackDatas(calls.editedMarkup[1] as InlineKeyboard);
    expect(datas.some((d) => d.startsWith("dgst:task:delc:"))).toBe(false);
    expect(datas).toContain(`dgst:task:del:${taskId}`);
  });

  test("memory details replies with the full entry", async () => {
    const storage = Storage.open(":memory:");
    storage.upsertMemory({ userId: OWNER, key: "k1", content: "متن کامل حافظه" });
    const env = makeEnv(storage);
    const { ctx, calls } = makeCtx(OWNER_NUM);

    await handleDigestCallback(ctx, env, "dgst:mem:show:0", "fa");
    expect(calls.replies).toHaveLength(1);
    expect(calls.replies[0]!.text).toContain("متن کامل حافظه");
    expect(calls.replies[0]!.text).toContain("کلید: k1");
    // The digest message itself is untouched.
    expect(calls.editedText).toHaveLength(0);
  });

  test("memory index out of range is ignored safely", async () => {
    const storage = Storage.open(":memory:");
    const env = makeEnv(storage);
    const { ctx, calls } = makeCtx(OWNER_NUM);
    await handleDigestCallback(ctx, env, "dgst:mem:show:2", "fa");
    expect(calls.replies).toHaveLength(0);
    expect(calls.editedText).toHaveLength(0);
  });

  test("proposal reject resolves without touching memory", async () => {
    const storage = Storage.open(":memory:");
    const { provider, store, tools } = curatorSetup();
    const pid = proposalId("duplicate", ["gone"]);
    store.saveProposals(OWNER, [
      {
        id: pid,
        kind: "duplicate",
        memoryIds: ["gone"],
        summaryFa: "دو خاطره تکراری",
        suggestedAction: { type: "delete", keys: ["gone"] },
      },
    ]);
    const env = makeEnv(storage, { proposalStore: store, tools });
    const { ctx, calls } = makeCtx(OWNER_NUM);

    await handleDigestCallback(ctx, env, `dgst:prop:no:${pid}`, "fa");
    expect(store.getPending(OWNER, pid)).toBeUndefined();
    expect(provider.deleted).toHaveLength(0);
    expect(calls.editedText).toHaveLength(1);
    expect(calls.editedText[0]!.text).toContain("پیشنهاد در انتظاری نداری");
    expect(calls.answered).toContain("رد شد");
  });

  test("proposal approve applies through the curator_decide flow", async () => {
    const storage = Storage.open(":memory:");
    const { provider, store, tools } = curatorSetup();
    const pid = proposalId("duplicate", ["gone"]);
    store.saveProposals(OWNER, [
      {
        id: pid,
        kind: "duplicate",
        memoryIds: ["gone"],
        summaryFa: "دو خاطره تکراری",
        suggestedAction: { type: "delete", keys: ["gone"] },
      },
    ]);
    const env = makeEnv(storage, { proposalStore: store, tools });
    const { ctx, calls } = makeCtx(OWNER_NUM);

    await handleDigestCallback(ctx, env, `dgst:prop:ok:${pid}`, "fa");
    expect(store.getPending(OWNER, pid)).toBeUndefined();
    expect(provider.deleted).toEqual([{ userId: OWNER, key: "gone" }]);
    expect(calls.answered).toContain("تأیید و اعمال شد ✅");
  });

  test("props opens the review view; back returns to the digest", async () => {
    const storage = Storage.open(":memory:");
    const { store } = curatorSetup();
    const pid = proposalId("stale", ["old"]);
    store.saveProposals(OWNER, [
      {
        id: pid,
        kind: "stale",
        memoryIds: ["old"],
        summaryFa: "خاطره قدیمی",
        suggestedAction: { type: "delete", keys: ["old"] },
      },
    ]);
    const env = makeEnv(storage, { proposalStore: store });
    const { ctx, calls } = makeCtx(OWNER_NUM);

    await handleDigestCallback(ctx, env, "dgst:props", "fa");
    expect(calls.editedText).toHaveLength(1);
    expect(calls.editedText[0]!.text).toContain("خاطره قدیمی");

    await handleDigestCallback(ctx, env, "dgst:back", "fa");
    expect(calls.editedText).toHaveLength(2);
    expect(calls.editedText[1]!.text).toContain("صبح بخیر");
  });

  test("run-now executes a tool action through the executor", async () => {
    const storage = Storage.open(":memory:");
    let pinged = 0;
    const pingTool: Tool<unknown, unknown> = {
      name: "ping",
      description: "test ping",
      enabled: true,
      permission: { requires: [] },
      input: { fields: {} },
      async run() {
        pinged++;
        return { pong: true };
      },
    };
    const tools = new ToolService({ extraTools: [pingTool] });
    const taskId = storage.createTask({
      name: "پینگ",
      cronExpr: "0 10 * * *",
      timezone: "Asia/Tehran",
      actionJson: JSON.stringify({ type: "tool", tool: "ping", input: {} }),
      createdByUserId: OWNER,
      nextRunAtMs: TEN_AM_TEHRAN,
    });
    const env = makeEnv(storage, { tools });
    const { ctx, calls } = makeCtx(OWNER_NUM);

    await handleDigestCallback(ctx, env, `dgst:task:run:${taskId}`, "fa");
    expect(pinged).toBe(1);
    expect(calls.answered).toContain("اجرا شد ✅");
    // The schedule is untouched by a run-now.
    expect(storage.getTask(OWNER, taskId)?.nextRunAtMs).toBe(TEN_AM_TEHRAN);
  });

  test("run-now message action delivers only into the tap's own chat", async () => {
    const storage = Storage.open(":memory:");
    const taskId = storage.createTask({
      name: "پیام",
      cronExpr: "0 10 * * *",
      timezone: "Asia/Tehran",
      actionJson: JSON.stringify({ type: "message", chatId: String(OWNER_NUM), text: "سلام" }),
      createdByUserId: OWNER,
      nextRunAtMs: TEN_AM_TEHRAN,
    });
    const env = makeEnv(storage);
    const { ctx, calls } = makeCtx(OWNER_NUM, OWNER_NUM);

    await handleDigestCallback(ctx, env, `dgst:task:run:${taskId}`, "fa");
    expect(calls.sentMessages).toEqual([{ chatId: String(OWNER_NUM), text: "سلام" }]);
    expect(calls.answered).toContain("اجرا شد ✅");
  });

  test("run-now refuses cross-chat delivery with an honest toast", async () => {
    const storage = Storage.open(":memory:");
    const taskId = storage.createTask({
      name: "پیام غریبه",
      cronExpr: "0 10 * * *",
      timezone: "Asia/Tehran",
      actionJson: JSON.stringify({ type: "message", chatId: "424242", text: "سلام" }),
      createdByUserId: OWNER,
      nextRunAtMs: TEN_AM_TEHRAN,
    });
    const env = makeEnv(storage);
    const { ctx, calls } = makeCtx(OWNER_NUM, OWNER_NUM);

    await handleDigestCallback(ctx, env, `dgst:task:run:${taskId}`, "fa");
    expect(calls.sentMessages).toHaveLength(0);
    expect(calls.answered).toContain("اجرای مستقیم فقط برای چت خودت ممکنه");
  });

  test("run-now agent action runs through the engine and delivers chunks", async () => {
    const storage = Storage.open(":memory:");
    const taskId = storage.createTask({
      name: "ایجنت",
      cronExpr: "0 10 * * *",
      timezone: "Asia/Tehran",
      actionJson: JSON.stringify({
        type: "agent",
        chatId: String(OWNER_NUM),
        prompt: "خلاصه بگو",
      }),
      createdByUserId: OWNER,
      nextRunAtMs: TEN_AM_TEHRAN,
    });
    const engine = {
      respond: async () => ({
        chunks: ["پاسخ ایجنت"],
        model: "fake",
        isFake: true,
        steps: [],
        truncated: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        media: [],
      }),
    };
    const env = makeEnv(storage, { engine });
    const { ctx, calls } = makeCtx(OWNER_NUM, OWNER_NUM);

    await handleDigestCallback(ctx, env, `dgst:task:run:${taskId}`, "fa");
    expect(calls.sentMessages).toEqual([{ chatId: String(OWNER_NUM), text: "پاسخ ایجنت" }]);
    expect(calls.answered).toContain("اجرا شد ✅");
  });

  test("a non-owner tap is refused: no mutation, no render", async () => {
    const storage = Storage.open(":memory:");
    const { reminderId } = seedActions(storage);
    const env = makeEnv(storage);
    const { ctx, calls } = makeCtx(STRANGER_NUM);

    const handled = await handleDigestCallback(ctx, env, `dgst:rem:done:${reminderId}`, "fa");
    expect(handled).toBe(true);
    expect(storage.listReminders(OWNER)).toHaveLength(1);
    expect(calls.editedText).toHaveLength(0);
    expect(calls.replies).toHaveLength(0);
    expect(calls.answered).toHaveLength(1);
    expect(calls.answered[0]).toBeUndefined(); // silent refusal, no toast leak
  });

  test("forged callbacks are consumed without effect", async () => {
    const storage = Storage.open(":memory:");
    const { reminderId, taskId } = seedActions(storage);
    const env = makeEnv(storage);
    const { ctx, calls } = makeCtx(OWNER_NUM);

    for (const data of [
      "dgst:task:delc:abc",
      "dgst:rem:done:1;DROP",
      "dgst:prop:ok:p1",
      "dgst:mem:show:9x",
      "dgst:unknown",
    ]) {
      expect(await handleDigestCallback(ctx, env, data, "fa")).toBe(true);
    }
    expect(storage.listReminders(OWNER)).toHaveLength(1);
    expect(storage.getTask(OWNER, taskId)).not.toBeUndefined();
    expect(calls.editedText).toHaveLength(0);
    void reminderId;
  });

  test("unknown ids are handled gracefully", async () => {
    const storage = Storage.open(":memory:");
    seedActions(storage);
    const env = makeEnv(storage);
    const { ctx, calls } = makeCtx(OWNER_NUM);

    await handleDigestCallback(ctx, env, "dgst:task:delc:424242", "fa");
    await handleDigestCallback(ctx, env, "dgst:task:run:424242", "fa");
    await handleDigestCallback(ctx, env, "dgst:rem:done:424242", "fa");
    // No throw; the digest still refreshes.
    expect(calls.editedText.length).toBeGreaterThan(0);
  });

  test("non-digest data is not consumed", async () => {
    const storage = Storage.open(":memory:");
    const env = makeEnv(storage);
    const { ctx } = makeCtx(OWNER_NUM);
    expect(await handleDigestCallback(ctx, env, "pal:cats", "fa")).toBe(false);
  });
});

describe("sendInteractiveDigest", () => {
  test("sends the digest as one message with a keyboard", async () => {
    const storage = Storage.open(":memory:");
    seedActions(storage);
    const env = makeEnv(storage);
    const { ctx, calls } = makeCtx(OWNER_NUM);

    await sendInteractiveDigest(ctx, env, "fa");
    expect(calls.replies).toHaveLength(1);
    expect(calls.replies[0]!.text).toContain("صبح بخیر");
    expect(calls.replies[0]!.text).toContain("کار تستی");
    const opts = calls.replies[0]!.opts as { reply_markup?: InlineKeyboard };
    expect(callbackDatas(opts.reply_markup!)).toContain("dgst:refresh");
  });

  test("without storage the owner gets an honest note", async () => {
    const env = makeEnv(undefined as unknown as Storage);
    const { ctx, calls } = makeCtx(OWNER_NUM);
    await sendInteractiveDigest(ctx, env, "en");
    expect(calls.replies).toHaveLength(1);
    expect(calls.replies[0]!.text).toContain("Digest unavailable.");
  });
});
