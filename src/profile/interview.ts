/**
 * Owner interview (platform Phase 4) — the fixed question set that fills
 * the owner-profile slots the seed cannot derive from stored data.
 *
 * Pure data + a pure transform: `applyInterviewAnswer` never touches
 * storage, never mutates its input, and an unknown question id (or an
 * empty answer) returns the profile unchanged.
 *
 * Answer formats: most slots are plain string lists — the answer text is
 * appended verbatim (trimmed). Two slots are structured:
 *  - `people`:  "Name — role — note", "Name: note", or a bare name.
 *  - `projects`: "Name: note" / "Name — note", or a bare description
 *    (stored under the structural name "Project").
 * The question texts ask for exactly those shapes.
 */
import type { OwnerProfile } from "./owner_profile";

export interface InterviewQuestion {
  /** Stable question id, e.g. "call_name". */
  id: string;
  /** Interview topic id — the value tracked in OwnerProfile.openSlots. */
  topic: string;
  /** Profile slot the answer writes into (a path, e.g. "identity.basics"). */
  slot: string;
  questionFa: string;
  questionEn: string;
}

export const INTERVIEW_QUESTIONS: readonly InterviewQuestion[] = [
  // ---- basics -------------------------------------------------------------
  {
    id: "call_name",
    topic: "basics",
    slot: "identity.callName",
    questionFa: "دوست داری چی صدات کنم؟ «محمد» یا اسم/لقب دیگه‌ای؟",
    questionEn: "What should I call you — Mohammad, or another name/nickname?",
  },
  {
    id: "basics_location",
    topic: "basics",
    slot: "identity.basics",
    questionFa: "کجا زندگی می‌کنی (شهر/کشور) و منطقه زمانیت چیه؟",
    questionEn: "Where do you live (city/country), and what is your timezone?",
  },
  {
    id: "basics_background",
    topic: "basics",
    slot: "identity.basics",
    questionFa: "یه معرفی کوتاه از خودت: سن، تحصیل یا پیشینه‌ت، هرچی دوست داری درباره‌ت بدونم؟",
    questionEn: "A short intro: your age, education or background — anything you want me to know about you?",
  },
  // ---- work / projects ------------------------------------------------------
  {
    id: "work_focus",
    topic: "work_focus",
    slot: "projects",
    questionFa: "الان تمرکز اصلی کاریت روی چیه؟ این‌طوری جواب بده: اسم کار/پروژه: الان در چه مرحله‌ایه و قدم بعدی چیه.",
    questionEn: "What is your main work focus right now? Answer like: name: where it stands and what the next step is.",
  },
  {
    id: "projects_list",
    topic: "projects",
    slot: "projects",
    questionFa: "پروژه‌ها یا کارهای دیگه‌ای که در جریانه رو بگو: اسم پروژه: یه خط توضیح و وضعیتش.",
    questionEn: "List your other ongoing projects/work: project name: a one-line note and its status.",
  },
  // ---- taste / preferences --------------------------------------------------
  {
    id: "taste_likes",
    topic: "taste_preferences",
    slot: "communication.preferences",
    questionFa: "سلیقه‌ت چیه؟ چیزایی که دوست داری (خوراک، موسیقی، فیلم، هرچی) رو بگو.",
    questionEn: "What is your taste? List things you like (food, music, films, anything).",
  },
  {
    id: "taste_dislikes",
    topic: "taste_preferences",
    slot: "communication.preferences",
    questionFa: "از چی بدت میاد یا اذیتت می‌کنه؟ چیزایی که باید ازشون دوری کنم.",
    questionEn: "What do you dislike or find annoying — things I should steer away from?",
  },
  // ---- communication ----------------------------------------------------------
  {
    id: "communication_style",
    topic: "communication_style",
    slot: "communication.style",
    questionFa: "دوست داری چطور باهات حرف بزنم؟ لحن، طول جواب، رسمی یا خودمونی — هرچی مهمه.",
    questionEn: "How should I talk to you? Tone, answer length, formal or casual — whatever matters.",
  },
  {
    id: "communication_donts",
    topic: "communication_donts",
    slot: "communication.preferences",
    questionFa: "تو حرف زدن باهات چی کار نکنم؟ (مثلاً توضیح اضافه، تعریف و تمجید، ایموجی زیاد…)",
    questionEn: "What should I NOT do when talking to you? (e.g. over-explaining, flattery, too many emojis…)",
  },
  // ---- people -------------------------------------------------------------------
  {
    id: "people_important",
    topic: "people_details",
    slot: "people",
    questionFa: "آدمای مهم زندگیت کیان؟ این‌طوری بگو: اسم — نقش/نسبت — هرچی باید درباره‌ش بدونم.",
    questionEn: "Who are the important people in your life? Answer like: name — role/relation — anything I should know.",
  },
  {
    id: "people_context",
    topic: "people_details",
    slot: "people",
    questionFa: "درباره خانواده یا نزدیک‌ترین دوستات چی باید بدونم؟ این‌طوری بگو: اسم — نقش/نسبت — نکته مهم.",
    questionEn: "What should I know about your family or closest friends? Answer like: name — role/relation — key note.",
  },
  // ---- routines -------------------------------------------------------------------
  {
    id: "routines_daily",
    topic: "routines_schedule",
    slot: "routines",
    questionFa: "روتین روزانه‌ت چطوره؟ از صبح تا شب، ساعتای مهمش رو بگو.",
    questionEn: "What does your daily routine look like? Morning to night, with the key times.",
  },
  {
    id: "routines_sleep",
    topic: "routines_schedule",
    slot: "routines",
    questionFa: "معمولاً کی بیدار می‌شی و کی می‌خوابی؟ ساعت کاری یا درسی ثابتی هم داری؟",
    questionEn: "When do you usually wake up and sleep? Any fixed work or study hours?",
  },
  // ---- technical --------------------------------------------------------------------
  {
    id: "technical_setup",
    topic: "technical_facts",
    slot: "technicalFacts",
    questionFa: "از نظر فنی چی باید بدونم؟ ابزار و استکت (زبان، فریم‌ورک)، دستگاه‌هات، محیط کارت.",
    questionEn: "What technical facts should I know? Your stack/tools (languages, frameworks), devices, and setup.",
  },
  // ---- standing rules -----------------------------------------------------------------
  {
    id: "standing_red_lines",
    topic: "standing_rules",
    slot: "standingRules",
    questionFa: "خط قرمزهات چیه؟ کارایی که تحت هیچ شرایطی نباید بکنم.",
    questionEn: "What are your red lines — things I must never do, under any circumstances?",
  },
  {
    id: "standing_privacy",
    topic: "standing_rules",
    slot: "standingRules",
    questionFa: "قانون ثابتت درباره حریم خصوصی و اطلاعاتت چیه؟ چی رو با کی می‌تونم یا نمی‌تونم به اشتراک بذارم؟",
    questionEn: "What are your standing rules on privacy and your information — what may or may not be shared, and with whom?",
  },
  // ---- goals -----------------------------------------------------------------------------
  {
    id: "goals_short_term",
    topic: "goals",
    slot: "goals",
    questionFa: "هدفای کوتاه‌مدتت چیه؟ (این ماه / چند ماه آینده)",
    questionEn: "What are your short-term goals? (This month / the next few months.)",
  },
  {
    id: "goals_long_term",
    topic: "goals",
    slot: "goals",
    questionFa: "هدفای بلندمدتت چیه؟ یک سال و بیشتر از این به بعد چی می‌خوای ساخته باشی؟",
    questionEn: "What are your long-term goals? A year and beyond — what do you want to have built?",
  },
];

/**
 * Every interview topic id, in question order (deduplicated).
 *
 * The list itself lives in ./topics (a dependency-free leaf module,
 * platform Phase 5 — it was previously derived here, which forced
 * owner_profile.ts to import a value from this module while this
 * module imports the OwnerProfile type from it). Re-exported here so
 * existing imports from ./interview keep working.
 */
export { INTERVIEW_TOPICS } from "./topics";

/** One question by id, or undefined. */
export function interviewQuestion(id: string): InterviewQuestion | undefined {
  return INTERVIEW_QUESTIONS.find((q) => q.id === id);
}

/** Split "Name: rest" / "Name — rest" into its head and the remainder. */
function splitHead(text: string): { head: string; rest: string } | undefined {
  const colon = text.indexOf(":");
  const dash = text.search(/\s[—–]\s/);
  let idx = -1;
  let sepLen = 0;
  if (colon > 0 && (dash < 0 || colon < dash)) {
    idx = colon;
    sepLen = 1;
  } else if (dash > 0) {
    idx = dash;
    sepLen = 3; // space + dash + space
  }
  if (idx < 0) return undefined;
  const head = text.slice(0, idx).trim();
  const rest = text.slice(idx + sepLen).trim();
  if (head.length === 0 || head.length > 60) return undefined;
  return { head, rest };
}

/** Parse a `people` answer into a profile person entry. */
function parsePerson(answer: string): { name: string; role: string; note?: string } {
  // "Name — role — note": em/en-dash separated segments.
  const segments = answer.split(/\s+[—–]\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (segments.length >= 3) {
    const [name, role, ...rest] = segments as [string, string, ...string[]];
    return { name, role, note: rest.join(" — ") };
  }
  if (segments.length === 2) {
    const [name, note] = segments as [string, string];
    return { name, role: "", note };
  }
  const head = splitHead(answer);
  if (head) {
    return head.rest.length > 0
      ? { name: head.head, role: "", note: head.rest }
      : { name: head.head, role: "" };
  }
  // Bare answer: the first few words are the name; the full text is the note.
  const name = answer.split(/\s+/).slice(0, 3).join(" ");
  return name === answer ? { name, role: "" } : { name, role: "", note: answer };
}

/** Parse a `projects` answer into a profile project entry. */
function parseProject(answer: string): { name: string; note: string } {
  const head = splitHead(answer);
  if (head && head.rest.length > 0) return { name: head.head, note: head.rest };
  if (head) return { name: head.head, note: "" };
  // No "name: note" shape — "Project" is a structural label, not a fact.
  return { name: "Project", note: answer };
}

/** Append to a string list unless the exact entry is already there. */
function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/**
 * Apply one interview answer to a profile. Pure: the input is not mutated
 * (a deep copy is returned), `updatedAtMs` is stamped, and the question's
 * topic is removed from `openSlots`. Unknown id or an empty answer returns
 * the input profile unchanged (same reference).
 */
export function applyInterviewAnswer(
  profile: OwnerProfile,
  questionId: string,
  answerText: string,
): OwnerProfile {
  const question = interviewQuestion(questionId);
  const answer = answerText.trim();
  if (!question || answer.length === 0) return profile;

  const next: OwnerProfile = JSON.parse(JSON.stringify(profile)) as OwnerProfile;
  switch (question.slot) {
    case "identity.callName":
      next.identity.callName = answer;
      break;
    case "identity.basics":
      pushUnique(next.identity.basics, answer);
      break;
    case "communication.style":
      pushUnique(next.communication.style, answer);
      break;
    case "communication.preferences":
      pushUnique(next.communication.preferences, answer);
      break;
    case "standingRules":
      pushUnique(next.standingRules, answer);
      break;
    case "routines":
      pushUnique(next.routines, answer);
      break;
    case "technicalFacts":
      pushUnique(next.technicalFacts, answer);
      break;
    case "goals":
      pushUnique(next.goals, answer);
      break;
    case "projects": {
      const entry = parseProject(answer);
      if (!next.projects.some((p) => p.name === entry.name && p.note === entry.note)) {
        next.projects.push(entry);
      }
      break;
    }
    case "people": {
      const entry = parsePerson(answer);
      if (
        !next.people.some(
          (p) => p.name === entry.name && p.role === entry.role && p.note === entry.note,
        )
      ) {
        next.people.push(entry);
      }
      break;
    }
    default:
      // A slot this build does not know how to write: leave data untouched
      // (but the topic still counts as answered below — unreachable with the
      // shipped question set).
      break;
  }
  next.openSlots = next.openSlots.filter((t) => t !== question.topic);
  next.updatedAtMs = Date.now();
  return next;
}
