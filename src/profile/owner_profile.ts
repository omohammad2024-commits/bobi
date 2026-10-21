/**
 * Owner profile (platform Phase 4) — one structured document describing
 * Mohammad: who he is, how he communicates, his hard rules, projects,
 * people, routines, technical facts and goals.
 *
 * Storage: a single JSON document in the `owner_profile` table (schema 23),
 * read/written opaquely through Storage.getOwnerProfileDoc /
 * setOwnerProfileDoc. This module owns the shape, validation, the prompt
 * rendering, and the one-time seed.
 *
 * SEED DISCIPLINE: `ensureSeeded` builds the first draft ONLY from facts
 * already stored in the database — the creator identity baked into
 * src/agent/prompt.ts, the owner's long-term memories, and his stored
 * language/personality prefs. Nothing is invented: every seeded field is
 * reported with its source, unclassifiable memories are skipped (never
 * dumped raw), and every topic the seed cannot fill stays in `openSlots`
 * for the interview (src/profile/interview.ts).
 */
import type { MemoryRecord, Storage } from "../storage/storage";
import { estimatePromptTokens } from "../agent/prompt";
import { INTERVIEW_TOPICS } from "./topics";

export interface OwnerProfile {
  version: number;
  identity: { name: string; callName?: string; basics: string[] };
  communication: { style: string[]; preferences: string[] };
  /** Hard rules / red lines. Seeded only from a stored rule, never invented. */
  standingRules: string[];
  projects: Array<{ name: string; note: string }>;
  people: Array<{ name: string; role: string; note?: string }>;
  routines: string[];
  technicalFacts: string[];
  goals: string[];
  /** Interview topic ids not yet filled (see INTERVIEW_TOPICS). */
  openSlots: string[];
  updatedAtMs: number;
}

/** The current profile-document version written by this build. */
export const OWNER_PROFILE_VERSION = 1;

/** The creator fact seeded into identity.basics (verbatim from prompt.ts). */
const CREATOR_FACT = "Mohammad is the creator and father of Bobi.";

/** Source label for fields seeded from the baked-in creator identity. */
const CREATOR_SOURCE = "prompt.ts:CREATOR_IDENTITY";

/** The empty skeleton: no facts at all. Renders as "". */
export function emptyOwnerProfile(): OwnerProfile {
  return {
    version: OWNER_PROFILE_VERSION,
    identity: { name: "", basics: [] },
    communication: { style: [], preferences: [] },
    standingRules: [],
    projects: [],
    people: [],
    routines: [],
    technicalFacts: [],
    goals: [],
    openSlots: [],
    updatedAtMs: 0,
  };
}

// ---- validation / (de)serialization ---------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isNamedList(
  v: unknown,
  noteRequired: boolean,
): v is Array<{ name: string; note: string }> {
  return (
    Array.isArray(v) &&
    v.every(
      (x) =>
        isRecord(x) &&
        typeof x.name === "string" &&
        (noteRequired
          ? typeof x.note === "string"
          : x.note === undefined || typeof x.note === "string"),
    )
  );
}

/**
 * Parse a stored owner-profile document. Strict-ish: every section must be
 * present with the right shape; unknown extra fields are dropped. Returns
 * undefined on any garbage (non-JSON, wrong types, missing sections).
 */
export function parseOwnerProfile(json: string): OwnerProfile | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  if (typeof raw.version !== "number" || !Number.isFinite(raw.version)) return undefined;
  if (typeof raw.updatedAtMs !== "number" || !Number.isFinite(raw.updatedAtMs)) return undefined;
  if (!isRecord(raw.identity)) return undefined;
  if (typeof raw.identity.name !== "string") return undefined;
  if (
    raw.identity.callName !== undefined &&
    typeof raw.identity.callName !== "string"
  ) {
    return undefined;
  }
  if (!isStringArray(raw.identity.basics)) return undefined;
  if (!isRecord(raw.communication)) return undefined;
  if (!isStringArray(raw.communication.style)) return undefined;
  if (!isStringArray(raw.communication.preferences)) return undefined;
  if (!isStringArray(raw.standingRules)) return undefined;
  if (!isNamedList(raw.projects, true)) return undefined;
  if (
    !Array.isArray(raw.people) ||
    !raw.people.every(
      (x) =>
        isRecord(x) &&
        typeof x.name === "string" &&
        typeof x.role === "string" &&
        (x.note === undefined || typeof x.note === "string"),
    )
  ) {
    return undefined;
  }
  if (!isStringArray(raw.routines)) return undefined;
  if (!isStringArray(raw.technicalFacts)) return undefined;
  if (!isStringArray(raw.goals)) return undefined;
  if (!isStringArray(raw.openSlots)) return undefined;

  const people = raw.people as Array<{ name: string; role: string; note?: string }>;
  return {
    version: raw.version,
    identity: {
      name: raw.identity.name,
      ...(raw.identity.callName !== undefined
        ? { callName: raw.identity.callName }
        : {}),
      basics: [...(raw.identity.basics as string[])],
    },
    communication: {
      style: [...(raw.communication.style as string[])],
      preferences: [...(raw.communication.preferences as string[])],
    },
    standingRules: [...(raw.standingRules as string[])],
    projects: (raw.projects as Array<{ name: string; note: string }>).map((p) => ({
      name: p.name,
      note: p.note,
    })),
    people: people.map((p) => ({
      name: p.name,
      role: p.role,
      ...(p.note !== undefined ? { note: p.note } : {}),
    })),
    routines: [...(raw.routines as string[])],
    technicalFacts: [...(raw.technicalFacts as string[])],
    goals: [...(raw.goals as string[])],
    openSlots: [...(raw.openSlots as string[])],
    updatedAtMs: raw.updatedAtMs,
  };
}

/** Serialize a profile for storage (plain JSON, no pretty-printing). */
export function serializeOwnerProfile(p: OwnerProfile): string {
  return JSON.stringify(p);
}

// ---- prompt rendering ------------------------------------------------------

/** Hard budget for the rendered block, in estimatePromptTokens units. */
export const OWNER_PROFILE_TOKEN_BUDGET = 600;

/**
 * Per-section caps applied before the budget loop. They keep one loud
 * section from starving the rest even when the total would still fit.
 */
const RENDER_CAPS = {
  basics: 6,
  style: 4,
  preferences: 6,
  standingRules: 6,
  projects: 5,
  people: 6,
  routines: 5,
  technicalFacts: 6,
  goals: 4,
} as const;

/** Max rendered characters per item (code-point safe truncation). */
const MAX_ITEM_CHARS = 180;

function trunc(s: string, max: number): string {
  const points = Array.from(s);
  return points.length <= max ? s : `${points.slice(0, max - 1).join("")}…`;
}

/** True when the profile carries at least one fact beyond name/skeleton. */
function hasFacts(p: OwnerProfile): boolean {
  return (
    p.identity.basics.length > 0 ||
    p.communication.style.length > 0 ||
    p.communication.preferences.length > 0 ||
    p.standingRules.length > 0 ||
    p.projects.length > 0 ||
    p.people.length > 0 ||
    p.routines.length > 0 ||
    p.technicalFacts.length > 0 ||
    p.goals.length > 0
  );
}

/**
 * Render the compact prompt block framing who Mohammad is.
 *
 * Budget: the result always measures ≤ OWNER_PROFILE_TOKEN_BUDGET (600)
 * with the repo estimator. Method is deterministic: per-section caps
 * first, then — while still over budget — drop the LAST item of the list
 * with the greatest total rendered length (ties break in fixed section
 * order). Returns "" when the profile carries no facts beyond the empty
 * skeleton (a name alone is skeleton, not a fact).
 */
export function renderOwnerProfileBlock(p: OwnerProfile): string {
  if (!hasFacts(p)) return "";

  const cap = <T,>(list: readonly T[], n: number): T[] => list.slice(0, n);
  const sections: Array<{ label: string; items: string[] }> = [
    {
      label: "Basics",
      items: cap(p.identity.basics, RENDER_CAPS.basics).map((s) => trunc(s, MAX_ITEM_CHARS)),
    },
    {
      label: "Communication style",
      items: cap(p.communication.style, RENDER_CAPS.style).map((s) => trunc(s, MAX_ITEM_CHARS)),
    },
    {
      label: "Preferences",
      items: cap(p.communication.preferences, RENDER_CAPS.preferences).map((s) =>
        trunc(s, MAX_ITEM_CHARS),
      ),
    },
    {
      label: "Standing rules (hard — never break)",
      items: cap(p.standingRules, RENDER_CAPS.standingRules).map((s) =>
        trunc(s, MAX_ITEM_CHARS),
      ),
    },
    {
      label: "Projects",
      items: cap(p.projects, RENDER_CAPS.projects).map((pr) =>
        trunc(pr.note ? `${pr.name} — ${pr.note}` : pr.name, MAX_ITEM_CHARS),
      ),
    },
    {
      label: "People",
      items: cap(p.people, RENDER_CAPS.people).map((pe) =>
        trunc(
          [pe.name, pe.role ? `(${pe.role})` : "", pe.note ? `— ${pe.note}` : ""]
            .filter((x) => x.length > 0)
            .join(" "),
          MAX_ITEM_CHARS,
        ),
      ),
    },
    {
      label: "Routines",
      items: cap(p.routines, RENDER_CAPS.routines).map((s) => trunc(s, MAX_ITEM_CHARS)),
    },
    {
      label: "Technical",
      items: cap(p.technicalFacts, RENDER_CAPS.technicalFacts).map((s) =>
        trunc(s, MAX_ITEM_CHARS),
      ),
    },
    {
      label: "Goals",
      items: cap(p.goals, RENDER_CAPS.goals).map((s) => trunc(s, MAX_ITEM_CHARS)),
    },
  ];

  const build = (): string => {
    const name = trunc(p.identity.name || "Mohammad", 60);
    const call = p.identity.callName ? ` (call him: ${trunc(p.identity.callName, 40)})` : "";
    const lines = [`Owner profile — who Mohammad is (the owner, name: ${name}${call}):`];
    for (const s of sections) {
      if (s.items.length > 0) lines.push(`- ${s.label}: ${s.items.join("; ")}`);
    }
    return lines.join("\n");
  };

  let block = build();
  while (estimatePromptTokens(block) > OWNER_PROFILE_TOKEN_BUDGET) {
    // Longest list (by total rendered length) loses its last item.
    let longest: { items: string[] } | undefined;
    let longestLen = 0;
    for (const s of sections) {
      const len = s.items.reduce((acc, x) => acc + x.length, 0);
      if (s.items.length > 0 && len > longestLen) {
        longest = s;
        longestLen = len;
      }
    }
    if (!longest) break; // Nothing left to trim; the header alone fits.
    longest.items.pop();
    block = build();
  }
  return block;
}

// ---- seed classification -----------------------------------------------------

/**
 * Where one memory lands in the profile. The mapping is deliberately
 * small and deterministic, checked in this exact order:
 *  1. Key-prefix rules (`rule:`/`project:`/`person:`/…) — the key is the
 *     label the model chose when storing the memory, so it wins.
 *  2. Keyword rules over key+content (standing-rule words first, so a
 *     "never …" memory can never be filed as a mere preference).
 *  3. `identity.basics` ONLY when the text is clearly about the owner
 *     (mentions Mohammad/محمد/the owner, or an identity/about key).
 *  4. Otherwise the memory is skipped — never dumped raw.
 */
type MemoryTarget =
  | "standingRules"
  | "projects"
  | "people"
  | "routines"
  | "goals"
  | "technicalFacts"
  | "communicationStyle"
  | "communicationPreferences"
  | "identityBasics"
  | "skip";

const KEY_PREFIX_TARGETS: Array<[RegExp, MemoryTarget]> = [
  [/^(standing[-_ ]?rule|rule|red[-_ ]?line)s?[:/_-]/, "standingRules"],
  [/^projects?[:/_-]/, "projects"],
  [/^(person|people|friend|contact|family)[:/_-]/, "people"],
  [/^routines?[:/_-]/, "routines"],
  [/^goals?[:/_-]/, "goals"],
  [/^(tech|technical|stack|setup)[:/_-]/, "technicalFacts"],
  [/^style[:/_-]/, "communicationStyle"],
  [/^(pref|preference|preferences|taste|likes?)[:/_-]/, "communicationPreferences"],
  [/^(identity|about|owner|profile|name)[:/_-]/, "identityBasics"],
];

const STANDING_WORDS = [
  "never ", "must not", "do not", "don't", "forbidden", "prohibit", "red line",
  "standing rule", "always share", "هرگز", "نباید", "خط قرمز",
];
const ROUTINE_WORDS = [
  "routine", "every day", "daily", "every morning", "every evening", "wakes",
  "wake up", "sleeps", "schedule", "روتین", "هر روز", "صبحا", "بیدار می",
];
const GOAL_WORDS = ["goal", "aims to", "aiming", "wants to build", "plans to", "هدف", "می‌خواد بسازه"];
const PROJECT_WORDS = ["project", "repo", "repository", "working on", "پروژه"];
const PREFERENCE_WORDS = [
  "prefers", "prefer", "preference", "likes", "dislikes", "favorite", "favourite",
  "ترجیح می", "دوست داره", "دوست دارد",
];
const STYLE_WORDS = ["tone", "communication style", "reply style", "speaks", "language", "persian", "farsi", "لحن", "فارسی"];
const TECHNICAL_WORDS = [
  "typescript", "javascript", "bun", "sqlite", "code", "coding", "software",
  "developer", "programming", "server", "api", "git", "linux", "کدنویسی",
];
const OWNER_WORDS = ["mohammad", "محمد", "the owner", "his name", "he is a", "he lives"];

function includesAny(haystack: string, words: readonly string[]): boolean {
  return words.some((w) => haystack.includes(w));
}

export function classifyMemory(m: MemoryRecord): MemoryTarget {
  const key = m.key.toLowerCase();
  for (const [re, target] of KEY_PREFIX_TARGETS) {
    if (re.test(key)) return target;
  }
  const text = `${key} ${m.content}`.toLowerCase();
  if (includesAny(text, STANDING_WORDS)) return "standingRules";
  if (includesAny(text, ROUTINE_WORDS)) return "routines";
  if (includesAny(text, GOAL_WORDS)) return "goals";
  if (includesAny(text, PROJECT_WORDS)) return "projects";
  if (includesAny(text, PREFERENCE_WORDS)) return "communicationPreferences";
  if (includesAny(text, STYLE_WORDS)) return "communicationStyle";
  if (includesAny(text, TECHNICAL_WORDS)) return "technicalFacts";
  if (includesAny(text, OWNER_WORDS)) return "identityBasics";
  return "skip";
}

/** Name/role for a `people` entry derived from a `friend:geo`-style key. */
function personFromKey(key: string): { name: string; role: string } {
  const m = /^([a-z]+)[:/_-](.+)$/i.exec(key.trim());
  if (m) {
    const kind = (m[1] ?? "").toLowerCase();
    const role =
      kind === "friend" ? "friend" : kind === "family" ? "family" : "contact";
    return { name: (m[2] ?? "").trim(), role };
  }
  return { name: key.trim(), role: "contact" };
}

/** Name for a `projects` entry derived from a `project:bobi`-style key. */
function projectNameFromKey(key: string): string {
  const m = /^projects?[:/_-](.+)$/i.exec(key.trim());
  return (m?.[1] ?? key).trim();
}

/** Prefs that seed communication.preferences: language/personality only. */
function isSeedablePrefKey(key: string): boolean {
  return key === "lang" || key === "language" || key === "personality";
}

// ---- service -----------------------------------------------------------------

export interface SeededField {
  /** Profile path the seed wrote, e.g. "identity.name" or "projects[0]". */
  path: string;
  /** Where the fact came from, e.g. "memory:project:bobi". */
  source: string;
}

export interface EnsureSeededResult {
  profile: OwnerProfile;
  created: boolean;
  seededFields: SeededField[];
}

export class OwnerProfileService {
  constructor(private readonly storage: Storage) {}

  /** The stored profile, or undefined when none exists (or it is corrupt). */
  load(): OwnerProfile | undefined {
    const doc = this.storage.misc.getOwnerProfileDoc();
    if (doc === undefined) return undefined;
    return parseOwnerProfile(doc);
  }

  /** Persist a profile verbatim (its updatedAtMs is the caller's to set). */
  save(p: OwnerProfile): void {
    this.storage.misc.setOwnerProfileDoc(serializeOwnerProfile(p));
  }

  /**
   * Create the seed profile iff no document exists yet. When a document
   * exists — even a corrupt one — it is left byte-for-byte untouched and
   * returned with created=false (a corrupt doc parses to the empty
   * skeleton rather than being overwritten).
   */
  ensureSeeded(ownerUserId: string): EnsureSeededResult {
    const existing = this.storage.misc.getOwnerProfileDoc();
    if (existing !== undefined) {
      return {
        profile: parseOwnerProfile(existing) ?? emptyOwnerProfile(),
        created: false,
        seededFields: [],
      };
    }

    const profile = emptyOwnerProfile();
    const seeded: SeededField[] = [];
    const pushStr = (list: string[], value: string, path: string, source: string): void => {
      const v = value.trim();
      if (v.length === 0 || list.includes(v)) return;
      list.push(v);
      seeded.push({ path: `${path}[${list.length - 1}]`, source });
    };

    // 1. Creator identity — the one fact baked into the code (prompt.ts).
    profile.identity.name = "Mohammad";
    seeded.push({ path: "identity.name", source: CREATOR_SOURCE });
    profile.identity.basics.push(CREATOR_FACT);
    seeded.push({ path: "identity.basics[0]", source: CREATOR_SOURCE });

    // Coverage flags drive openSlots: a topic leaves openSlots only when
    // the seed filled the thing that topic actually asks about. The
    // creator fact does NOT close "basics" (call name / location / intro
    // are still unknown), and a language/personality pref does not close
    // taste or communication don'ts.
    let coveredBasics = false;
    let coveredProjects = false;
    let coveredStyle = false;
    let coveredTaste = false;
    let coveredPeople = false;
    let coveredRoutines = false;
    let coveredTechnical = false;
    let coveredGoals = false;
    let coveredRules = false;

    // 2. Long-term memories, classified deterministically.
    for (const m of this.storage.memories.listMemories(ownerUserId)) {
      const content = m.content.trim();
      if (content.length === 0) continue;
      const source = `memory:${m.key}`;
      switch (classifyMemory(m)) {
        case "standingRules":
          pushStr(profile.standingRules, content, "standingRules", source);
          coveredRules = true;
          break;
        case "projects": {
          const name = projectNameFromKey(m.key);
          if (!profile.projects.some((p) => p.name === name && p.note === content)) {
            profile.projects.push({ name, note: content });
            seeded.push({ path: `projects[${profile.projects.length - 1}]`, source });
          }
          coveredProjects = true;
          break;
        }
        case "people": {
          const { name, role } = personFromKey(m.key);
          if (!profile.people.some((p) => p.name === name && p.note === content)) {
            profile.people.push({ name, role, note: content });
            seeded.push({ path: `people[${profile.people.length - 1}]`, source });
          }
          coveredPeople = true;
          break;
        }
        case "routines":
          pushStr(profile.routines, content, "routines", source);
          coveredRoutines = true;
          break;
        case "goals":
          pushStr(profile.goals, content, "goals", source);
          coveredGoals = true;
          break;
        case "technicalFacts":
          pushStr(profile.technicalFacts, content, "technicalFacts", source);
          coveredTechnical = true;
          break;
        case "communicationStyle":
          pushStr(profile.communication.style, content, "communication.style", source);
          coveredStyle = true;
          break;
        case "communicationPreferences":
          pushStr(profile.communication.preferences, content, "communication.preferences", source);
          coveredTaste = true;
          break;
        case "identityBasics":
          pushStr(profile.identity.basics, content, "identity.basics", source);
          coveredBasics = true;
          break;
        case "skip":
          break;
      }
    }

    // 3. Stored prefs: language/personality only → communication.preferences.
    //    A pref whose key explicitly names a rule may seed standingRules —
    //    the only other pref the seed will ever take.
    for (const key of this.storage.misc.listUserPrefKeys(ownerUserId, "")) {
      const value = this.storage.misc.getUserPref(ownerUserId, key);
      if (value === undefined || value.trim().length === 0) continue;
      const source = `user_prefs:${key}`;
      if (/rule/i.test(key)) {
        pushStr(profile.standingRules, `${key}: ${value.trim()}`, "standingRules", source);
        coveredRules = true;
      } else if (isSeedablePrefKey(key)) {
        pushStr(
          profile.communication.preferences,
          `${key}: ${value.trim()}`,
          "communication.preferences",
          source,
        );
        if (key === "personality") coveredStyle = true;
      }
    }

    // 4. Everything not covered stays open for the interview.
    const covered = new Set<string>();
    if (coveredBasics) covered.add("basics");
    if (coveredProjects) {
      covered.add("work_focus");
      covered.add("projects");
    }
    if (coveredTaste) covered.add("taste_preferences");
    if (coveredStyle) covered.add("communication_style");
    if (coveredRules) covered.add("communication_donts");
    if (coveredPeople) covered.add("people_details");
    if (coveredRoutines) covered.add("routines_schedule");
    if (coveredTechnical) covered.add("technical_facts");
    if (coveredRules) covered.add("standing_rules");
    if (coveredGoals) covered.add("goals");
    profile.openSlots = INTERVIEW_TOPICS.filter((t) => !covered.has(t));

    profile.updatedAtMs = Date.now();
    this.save(profile);
    return { profile, created: true, seededFields: seeded };
  }
}
