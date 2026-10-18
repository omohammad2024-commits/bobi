/**
 * Tests for src/i18n (Phase D5) and the menu/bot string migration.
 *
 * The fa pack must stay byte-identical to the Persian text the bot used
 * before i18n; the en pack must cover every key. No network, no Telegram.
 */
import { describe, expect, test } from "bun:test";
import { t, resolveLang, LANG_PREF_KEY, fa, en } from "../src/i18n";
import {
  MAIN_MENU_LABELS,
  MENU_REPLIES,
  CALLBACKS,
  buildMainMenu,
  replyForCallback,
  toolListText,
} from "../src/bot/menu";
import {
  VOICE_FAILED_NOTE,
  VOICE_TRUNCATED_NOTE,
  COMPRESS_REPLIES,
  COMMAND_HELP,
  visibleCommandHelp,
  formatCommandHelp,
  handleHelpCommand,
  handleResetCommand,
  handleCompressCommand,
  handleStopCommand,
  handleVoiceCommand,
  handlePersonalityCommand,
  type VoiceCommandEnv,
} from "../src/bot/bot";
import { buildSystemPrompt } from "../src/agent/prompt";

// ---------------------------------------------------------------------------
// fa pack: byte-identical to the pre-i18n Persian strings.
// ---------------------------------------------------------------------------

/**
 * Every migrated key with its exact pre-i18n Persian text.
 *
 * These literals were copied from src/bot/menu.ts and src/bot/bot.ts before
 * migration; the test fails if the fa pack ever drifts from them.
 */
const FA_EXPECTED: Readonly<Record<string, string>> = {
  "menu.label.chat": "گفت‌وگو",
  "menu.label.tools": "ابزارها",
  "menu.label.about": "درباره بابی",
  "menu.reply.chat": "گفت‌وگو: به‌زودی می‌توانی با بابی حرف بزنی.",
  "menu.reply.tools": "ابزارها: فهرست ابزارها در مرحلهٔ بعد اضافه می‌شود.",
  "menu.reply.about": "بابی — ربات ایجنت همه‌کاره. نسخهٔ آزمایشی.",
  "menu.reply.unknown": "گزینهٔ نامشخص.",
  "menu.tool.calculator": "ماشین‌حساب",
  "menu.tool.date_time": "تاریخ و ساعت",
  "menu.tool.text_utilities": "ابزار متن",
  "menu.tool.unit_converter": "تبدیل واحد",
  "menu.tool.fetch_url": "خواندن صفحهٔ وب",
  "menu.tool.web_search": "جستجوی وب",
  "menu.tools.title": "ابزارهای فعال بابی:",
  "menu.tools.empty": "ابزارها: هیچ ابزار فعالی وجود ندارد.",
  "menu.tools.note":
    "فهرست بالا یعنی ابزارها در دسترس‌اند؛ اجرای هر کدام به مجوز شما بستگی دارد.",
  "menu.tools.item": "{index}. {label}",
  "start.greeting": "سلام! من BOBI هستم. یک گزینه را انتخاب کن:",
  "help.title": "دستورهای موجود:",
  "help.entry": "/{name} — {description}",
  "help.cmd.start": "شروع و نمایش منوی اصلی",
  "help.cmd.help": "راهنمای دستورها",
  "help.cmd.personality": "نمایش یا تغییر لحن پاسخ‌گویی",
  "help.cmd.voice": "روشن/خاموش کردن پاسخ صوتی",
  "help.cmd.compress": "خلاصه‌سازی فوری گفت‌وگوهای قدیمی",
  "help.cmd.reset": "پاک کردن تاریخچهٔ همین گفت‌وگو",
  "help.cmd.stop": "توقف پاسخ در حال اجرا",
  "help.cmd.admin": "پنل مدیریت ربات",
  "help.cmd.ai": "مدیریت ارائه‌دهندهٔ هوش مصنوعی",
  "voice.not_configured": "تبدیل متن به صدا پیکربندی نشده است؛ حالت صوتی در دسترس نیست.",
  "voice.enabled": "حالت صوتی روشن شد 🎙️ از این به بعد پاسخ‌ها را به‌صورت پیام صوتی می‌فرستم.",
  "voice.disabled": "حالت صوتی خاموش شد؛ پاسخ‌ها دوباره به‌صورت متن ارسال می‌شوند.",
  "voice.tts_failed": "تبدیل متن به صدا ناموفق بود؛ پاسخ را به‌صورت متن می‌فرستم.",
  "voice.truncated": "پاسخ طولانی بود؛ ادامه را به‌صورت متن می‌فرستم:",
  "prefs.save_failed": "ذخیرهٔ تنظیم ناموفق بود؛ دوباره تلاش کن.",
  "personality.unavailable": "تغییر شخصیت در دسترس نیست.",
  "personality.current_title": "شخصیت فعلی پاسخ‌گویی:",
  "personality.list_item": "• {name} — {label}: {description}{mark}",
  "personality.current_mark": " ← فعلی",
  "personality.usage": "برای تغییر: /personality <نام>",
  "personality.unknown": "شخصیت «{name}» ناشناخته است. گزینه‌ها: {options}",
  "personality.changed": "شخصیت پاسخ‌گویی به «{label}» تغییر کرد.",
  "reset.done": "تاریخچهٔ این گفت‌وگو پاک شد. 🧹",
  "compress.compressed":
    "خلاصه‌سازی انجام شد ✅ گفت‌وگوهای قدیمی فشرده شدند و خلاصه‌شان نگه داشته شد.",
  "compress.nothing": "هنوز پیام کافی برای خلاصه‌سازی جمع نشده است.",
  "compress.failed": "خلاصه‌سازی ناموفق بود؛ بعداً دوباره تلاش کن.",
  "compress.unavailable": "خلاصه‌سازی در این حالت فعال نیست.",
  "stop.nothing": "چیزی در حال اجرا نبود.",
  "stop.done": "متوقف شد ✅",
  "lang.prompt": "زبان رابط کاربری را انتخاب کن:",
  "lang.label.fa": "فارسی",
  "lang.label.en": "English",
  "lang.changed": "زبان به «{label}» تغییر کرد ✅",
  "lang.unknown": "گزینهٔ زبان نامشخص است.",
  "lang.unavailable": "تغییر زبان در دسترس نیست.",
  "help.cmd.lang": "تغییر زبان رابط کاربری",
  "help.cmd.history": "نمایش تاریخچهٔ گفت‌وگو",
  "help.cmd.save": "ذخیرهٔ گفت‌وگو به‌صورت فایل",
  "help.cmd.retry": "تلاش دوبارهٔ آخرین پیام",
  "help.cmd.undo": "بازگشت و بازنویسی",
  "help.cmd.title": "تنظیم عنوان گفت‌وگو",
  "help.cmd.branch": "شاخه‌سازی گفت‌وگو",
  "help.cmd.resume": "ازسرگیری نشست",
  "help.cmd.sessions": "نشست‌های قبلی",
  "help.cmd.status": "وضعیت",
  "help.cmd.context": "وضعیت حافظهٔ زمینه",
  "help.cmd.busy": "رفتار هنگام مشغولی",
  "help.cmd.whoami": "نقش من",
  "help.cmd.footer": "پانویس فنی",
  "help.cmd.version": "نسخهٔ بابی",
  "help.cmd.new": "شروع نشست تازه",
  "help.cmd.bg": "اجرای دستور در پس‌زمینه",
  "help.cmd.btw": "پرسش جانبی",
  "help.cmd.queue": "صف‌بندی پیام",
  "help.cmd.steer": "تزریق راهنمایی",
  "help.cmd.agents": "ایجنت‌های فعال",
  "help.cmd.suggestions": "اتوماسیون‌های پیشنهادی",
  "help.cmd.blueprint": "اتوماسیون از قالب",
  "help.cmd.refine": "استخراج درس از گفت‌وگو",
  "help.cmd.review": "بازبینی مستقل",
  "help.cmd.plan": "طرح اجرایی",
  "help.cmd.moa": "اجرای چندمدلی",
  "help.cmd.memory": "مدیریت حافظه",
  "help.cmd.bundles": "بسته‌های مهارت",
  "help.cmd.snapshot": "پشتیبان‌گیری از وضعیت",
  "help.cmd.restart": "راه‌اندازی مجدد ربات",
  "help.cmd.update": "به‌روزرسانی بابی",
  "help.cmd.debug": "گزارش اشکال‌زدایی",
  "help.cmd.usage": "مصرف توکن",
  "help.cmd.insights": "تحلیل مصرف",
  "help.cmd.model": "تغییر مدل",
  "help.cmd.reasoning": "سطح استدلال",
  "help.cmd.autoprune": "حذف خودکار نشست‌ها",
  "help.cmd.tools": "مدیریت ابزارها",
  "help.cmd.skills": "مدیریت مهارت‌ها",
  "help.cmd.curator": "نگهداری حافظه",
  "help.cmd.plugins": "افزونه‌ها",
  "help.cmd.reload_mcp": "بارگذاری مجدد MCP",
  "help.cmd.reload_skills": "اسکن مجدد مهارت‌ها",
  "help.cmd.approve": "تأیید درخواست",
  "help.cmd.deny": "رد درخواست",
  "help.cmd.sethome": "کانال اصلی",
  "help.cmd.pause": "توقف اضطراری",
  "help.cmd.goal": "هدف ماندگار",
  "help.cmd.subgoal": "زیراهداف",
  "help.cmd.heartbeat": "یادآور دوره‌ای",
  "help.cmd.loop": "تکرار خودکار",
  "help.cmd.cron": "وظایف زمان‌بندی‌شده",
  "help.cmd.learn": "آموزش مهارت",
  "gate.group_not_ready":
    "این ربات در این گروه هنوز فعال نیست. مالک ربات باید ابتدا دسترسی را تأیید کند.",
};

describe("fa pack", () => {
  test("every migrated key is byte-identical to the pre-i18n Persian text", () => {
    for (const [key, expected] of Object.entries(FA_EXPECTED)) {
      expect(t(key, "fa")).toBe(expected);
    }
  });

  test("the pack covers exactly the migrated keys", () => {
    expect(Object.keys(fa).sort()).toEqual(Object.keys(FA_EXPECTED).sort());
  });

  test("menu ground-truth exports still match the pack", () => {
    expect(t("menu.label.chat", "fa")).toBe(MAIN_MENU_LABELS.chat);
    expect(t("menu.label.tools", "fa")).toBe(MAIN_MENU_LABELS.tools);
    expect(t("menu.label.about", "fa")).toBe(MAIN_MENU_LABELS.about);
    expect(t("menu.reply.chat", "fa")).toBe(MENU_REPLIES[CALLBACKS.chat]);
    expect(t("menu.reply.tools", "fa")).toBe(MENU_REPLIES[CALLBACKS.tools]);
    expect(t("menu.reply.about", "fa")).toBe(MENU_REPLIES[CALLBACKS.about]);
  });

  test("bot ground-truth exports still match the pack", () => {
    expect(t("voice.tts_failed", "fa")).toBe(VOICE_FAILED_NOTE);
    expect(t("voice.truncated", "fa")).toBe(VOICE_TRUNCATED_NOTE);
    expect(t("compress.compressed", "fa")).toBe(COMPRESS_REPLIES.compressed);
    expect(t("compress.nothing", "fa")).toBe(COMPRESS_REPLIES.nothing_to_compress);
    expect(t("compress.failed", "fa")).toBe(COMPRESS_REPLIES.failed);
    expect(t("compress.unavailable", "fa")).toBe(COMPRESS_REPLIES.unavailable);
    for (const c of COMMAND_HELP) {
      expect(t(`help.cmd.${c.name}`, "fa")).toBe(c.descriptionFa);
    }
  });
});

// ---------------------------------------------------------------------------
// en pack: complete, non-empty, natural.
// ---------------------------------------------------------------------------

describe("en pack", () => {
  test("covers exactly the same keys as fa, none empty", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fa).sort());
    for (const [key, value] of Object.entries(en)) {
      expect(typeof value).toBe("string");
      expect(value.length, key).toBeGreaterThan(0);
    }
  });

  test("spot-checks read as natural English", () => {
    expect(t("menu.label.chat", "en")).toBe("Chat");
    expect(t("start.greeting", "en")).toBe("Hi! I'm BOBI. Pick an option:");
    expect(t("stop.done", "en")).toBe("Stopped ✅");
    expect(t("help.title", "en")).toBe("Available commands:");
  });
});

// ---------------------------------------------------------------------------
// t(): fallback and interpolation.
// ---------------------------------------------------------------------------

describe("t()", () => {
  test("unknown keys fall back to the key itself (fa has no entry either)", () => {
    expect(t("no.such.key", "en")).toBe("no.such.key");
    expect(t("no.such.key")).toBe("no.such.key");
  });

  test("interpolates {name}-style vars", () => {
    expect(
      t("personality.unknown", "fa", { name: "foo", options: "a، b" }),
    ).toBe("شخصیت «foo» ناشناخته است. گزینه‌ها: a، b");
    expect(t("menu.tools.item", "en", { index: 2, label: "X" })).toBe("2. X");
    expect(t("help.entry", "en", { name: "start", description: "Start" })).toBe(
      "/start — Start",
    );
  });

  test("a placeholder with no value is left as-is, never blanked", () => {
    const partial = t("personality.unknown", "fa", { name: "x" });
    expect(partial).toContain("{options}");
    expect(partial).toContain("x");
  });

  test("defaults to Persian", () => {
    expect(t("stop.done")).toBe(t("stop.done", "fa"));
  });
});

// ---------------------------------------------------------------------------
// resolveLang(): validated, fail-closed.
// ---------------------------------------------------------------------------

describe("resolveLang", () => {
  test("the pref key is 'lang'", () => {
    expect(LANG_PREF_KEY).toBe("lang");
  });

  test("only the exact string 'en' selects English", () => {
    const get = (v: string | undefined) => () => v;
    expect(resolveLang("u", get("en"))).toBe("en");
    expect(resolveLang("u", get("fa"))).toBe("fa");
    expect(resolveLang("u", get(undefined))).toBe("fa");
    expect(resolveLang("u", get(""))).toBe("fa");
    expect(resolveLang("u", get("de"))).toBe("fa");
    expect(resolveLang("u", get("EN"))).toBe("fa");
    expect(resolveLang("u", get(" en "))).toBe("fa");
  });

  test("a throwing reader falls back to Persian", () => {
    expect(
      resolveLang("u", () => {
        throw new Error("db down");
      }),
    ).toBe("fa");
  });
});

// ---------------------------------------------------------------------------
// prompt.ts: the contextFiles block (D3 wiring point).
// ---------------------------------------------------------------------------

function basePrompt() {
  return {
    tools: [],
    now: new Date("2026-10-18T12:00:00Z"),
    timezone: "UTC",
  };
}

describe("buildSystemPrompt contextFiles", () => {
  test("appends the block under the Persian header", () => {
    const prompt = buildSystemPrompt({ ...basePrompt(), contextFiles: "### AGENTS.md\nrules" });
    expect(prompt).toContain("زمینه‌ی پروژه:\n### AGENTS.md\nrules");
  });

  test("ordering: after skills, before owner extra", () => {
    const prompt = buildSystemPrompt({
      ...basePrompt(),
      skillContext: "SKILL-BLOCK",
      contextFiles: "CTX-BLOCK",
      extra: "EXTRA-BLOCK",
    });
    const skillAt = prompt.indexOf("SKILL-BLOCK");
    const ctxAt = prompt.indexOf("زمینه‌ی پروژه:");
    const extraAt = prompt.indexOf("EXTRA-BLOCK");
    expect(skillAt).toBeGreaterThan(-1);
    expect(ctxAt).toBeGreaterThan(skillAt);
    expect(extraAt).toBeGreaterThan(ctxAt);
  });

  test("absent or blank contextFiles adds nothing", () => {
    expect(buildSystemPrompt(basePrompt())).not.toContain("زمینه‌ی پروژه:");
    expect(
      buildSystemPrompt({ ...basePrompt(), contextFiles: "   \n " }),
    ).not.toContain("زمینه‌ی پروژه:");
  });
});

// ---------------------------------------------------------------------------
// Migrated call sites render the sender's language, defaulting to Persian.
// ---------------------------------------------------------------------------

function fakePrefs(lang: string | undefined) {
  const store = new Map<string, string>();
  if (lang !== undefined) store.set("lang", lang);
  return {
    getUserPref: (userId: string, key: string) => store.get(`${userId}:${key}`) ?? store.get(key),
    setUserPref: (userId: string, key: string, value: string) => {
      store.set(`${userId}:${key}`, value);
    },
  };
}

function replyCtx() {
  const replies: string[] = [];
  return {
    replies,
    ctx: {
      chat: { id: 1 },
      from: { id: 7 },
      message: { text: "" },
      reply: async (text: string) => {
        replies.push(text);
      },
    },
  };
}

describe("menu in English", () => {
  test("main menu buttons use the en pack", () => {
    const kb = buildMainMenu("en");
    expect(kb.inline_keyboard[0]!.map((b) => b.text)).toEqual([
      "Chat",
      "Tools",
      "About BOBI",
    ]);
  });

  test("default stays Persian", () => {
    const kb = buildMainMenu();
    expect(kb.inline_keyboard[0]!.map((b) => b.text)).toEqual([
      MAIN_MENU_LABELS.chat,
      MAIN_MENU_LABELS.tools,
      MAIN_MENU_LABELS.about,
    ]);
  });

  test("unknown callback and tools list translate", () => {
    expect(replyForCallback("menu:nope", undefined, "en")).toBe("Unknown option.");
    expect(toolListText([], "en")).toBe("Tools: there are no active tools.");
    const text = toolListText(["calculator", "mystery_tool"], "en");
    expect(text).toContain("BOBI's active tools:");
    expect(text).toContain("1. Calculator");
    expect(text).toContain("2. mystery_tool");
  });
});

describe("command handlers in English", () => {
  test("/help renders the en pack", async () => {
    const { replies, ctx } = replyCtx();
    await handleHelpCommand(ctx, false, "en");
    expect(replies[0]).toContain("Available commands:");
    expect(replies[0]).toContain("/help — Command reference");
    expect(replies[0]).not.toContain("/admin");
  });

  test("/help defaults to Persian", async () => {
    const { replies, ctx } = replyCtx();
    await handleHelpCommand(ctx, false);
    expect(replies[0]).toContain("دستورهای موجود:");
  });

  test("/stop confirmations translate", async () => {
    const { replies, ctx } = replyCtx();
    await handleStopCommand(ctx, { engine: { cancel: () => {} } }, "en");
    expect(replies).toEqual(["Nothing was running."]);
  });

  test("/reset confirmation translates", async () => {
    const { replies, ctx } = replyCtx();
    await handleResetCommand(
      ctx,
      { engine: { cancel: () => {}, clearHistory: () => {} } },
      "en",
    );
    expect(replies).toEqual(["This conversation's history was cleared. 🧹"]);
  });

  test("/compress failure reply translates", async () => {
    const { replies, ctx } = replyCtx();
    await handleCompressCommand(
      ctx,
      {
        engine: {
          compressNow: async () => {
            throw new Error("boom");
          },
        },
      },
      "en",
    );
    expect(replies).toEqual(["Summarization failed; try again later."]);
  });

  test("/voice not-configured reply translates", async () => {
    const replies: string[] = [];
    const env: VoiceCommandEnv = { prefs: fakePrefs(undefined) };
    await handleVoiceCommand({ from: { id: 7 }, reply: async (t) => { replies.push(t); } }, env, "en");
    expect(replies).toEqual(["Text-to-speech is not configured; voice mode is unavailable."]);
  });

  test("/voice toggle confirmation translates", async () => {
    const replies: string[] = [];
    const env: VoiceCommandEnv = {
      tts: { baseUrl: "http://x", apiKey: "", model: "m", voice: "v" },
      prefs: fakePrefs(undefined),
    };
    await handleVoiceCommand({ from: { id: 7 }, reply: async (t) => { replies.push(t); } }, env, "en");
    expect(replies[0]).toContain("Voice mode is on");
  });

  test("/personality unknown-name reply translates", async () => {
    const { replies, ctx } = replyCtx();
    await handlePersonalityCommand(
      { ...ctx, message: { text: "/personality nope" } },
      { prefs: fakePrefs(undefined) },
      "en",
    );
    expect(replies[0]).toContain("Unknown personality «nope».");
  });

  test("/personality save failure uses the shared prefs key", async () => {
    const { replies, ctx } = replyCtx();
    const prefs = {
      getUserPref: () => undefined,
      setUserPref: () => {
        throw new Error("disk full");
      },
    };
    await handlePersonalityCommand(
      { ...ctx, message: { text: "/personality concise" } },
      { prefs },
      "en",
    );
    expect(replies).toEqual(["Couldn't save the setting; try again."]);
  });
});

describe("formatCommandHelp", () => {
  test("fa pack descriptions match the entries", () => {
    const text = formatCommandHelp(visibleCommandHelp(true), "fa");
    expect(text).toContain("/ai — مدیریت ارائه‌دهندهٔ هوش مصنوعی");
  });

  test("en renders translated descriptions", () => {
    const text = formatCommandHelp(visibleCommandHelp(true), "en");
    expect(text).toContain("/ai — Manage the AI provider");
  });
});
