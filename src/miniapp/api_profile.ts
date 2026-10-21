/**
 * Mini App backend: owner profile view/edit (Phase 4).
 *
 * Mounted by the Mini App router (src/miniapp/api.ts) at POST /miniapp/api/*.
 * Every call carries `{ initData }` in the JSON body; auth runs through
 * `validateInitData` (initData HMAC validation + owner check) from ./auth —
 * a failure returns a generic 401, never a reason. The profile is the
 * owner's private data: there is NO unauthenticated path to it, mirroring
 * api_manage.ts exactly (and the router in api.ts has already validated
 * initData before dispatching here — this is defense in depth).
 *
 * Persistence goes through OwnerProfileService (src/profile/owner_profile.ts)
 * only — no duplicated storage logic. Edits are shape-checked with
 * `parseOwnerProfile` on the serialized form before anything is saved.
 *
 * Conventions (mirroring api_manage.ts):
 * - success bodies are `{ ok: true, ... }`;
 * - error bodies are `{ ok: false, error: "<fa string>" }` — Persian is the
 *   ground truth (the api.ts envelope shape), generic, never a stack trace;
 * - NO secrets/keys exist anywhere in this surface: the profile carries
 *   identity/communication/rules/projects/people/routines/technical facts/
 *   goals/open slots only, exactly as OwnerProfile defines it.
 */
import { processEnv } from "../config/env";
import { validateInitData } from "./auth";
import type { Storage } from "../storage/storage";
import {
  OwnerProfileService,
  parseOwnerProfile,
  type OwnerProfile,
} from "../profile/owner_profile";

// ------------------------------------------------------------ deps ----------

export interface ProfileApiDeps {
  storage: Storage;
  /** Test/env overrides; default to TELEGRAM_BOT_TOKEN / OWNER_TELEGRAM_ID. */
  botToken?: string;
  ownerId?: string;
  /** Injectable service so tests never touch the real profile row. */
  profileService?: OwnerProfileService;
}

// ------------------------------------------------------------ plumbing ------

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const ok = (body: Record<string, unknown> = {}): Response =>
  json(200, { ok: true, ...body });

const fail = (status: number, error: string): Response =>
  json(status, { ok: false, error });

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Serialized-profile size cap, consistent with MAX_BODY_BYTES in
 * src/miniapp/api.ts (the router rejects larger bodies before dispatch;
 * this keeps the standalone handler bounded too). Kept as a local constant
 * to avoid an import cycle with the router.
 */
export const MAX_PROFILE_BYTES = 64 * 1024;

// ------------------------------------------------------------ auth ----------

/** Owner id from initData, or undefined on any auth failure (reason hidden). */
function authOwner(deps: ProfileApiDeps, body: Record<string, unknown>): string | undefined {
  const initData = asString(body["initData"]) ?? "";
  const botToken = (deps.botToken ?? processEnv().TELEGRAM_BOT_TOKEN ?? "").trim();
  const ownerId = (deps.ownerId ?? processEnv().OWNER_TELEGRAM_ID ?? "").trim();
  if (initData === "" || botToken === "" || ownerId === "") return undefined;
  const v = validateInitData(initData, botToken, ownerId);
  return v.ok ? v.userId : undefined;
}

// ------------------------------------------------------------ stores --------

function profileServiceFor(deps: ProfileApiDeps): OwnerProfileService {
  return deps.profileService ?? new OwnerProfileService(deps.storage);
}

/** Best-effort audit; a failing audit must never block the mutation. */
function audit(
  storage: Storage,
  operation: string,
  actorId: string,
  outcome: "success" | "denied" | "error",
  detail: string,
): void {
  try {
    storage.access.appendAudit({ operation, outcome, actorId, detail });
  } catch {
    // ignore
  }
}

// ------------------------------------------------------------ router --------

const PREFIX = "/miniapp/api/";

/**
 * Owner-profile API sub-router. Returns undefined for non-profile paths so
 * the caller (src/miniapp/api.ts) falls through; every profile path returns
 * a Response — including auth failures.
 */
export function handleProfileApi(
  path: string,
  body: Record<string, unknown>,
  deps: ProfileApiDeps,
): Promise<Response> | undefined {
  if (!path.startsWith(PREFIX)) return undefined;
  const name = path.slice(PREFIX.length);
  if (name !== "profile.get" && name !== "profile.save") return undefined;
  return route(name, body, deps);
}

async function route(
  name: string,
  body: Record<string, unknown>,
  deps: ProfileApiDeps,
): Promise<Response> {
  if (body === null || typeof body !== "object") {
    return fail(400, "بدنه درخواست نامعتبر است.");
  }
  const ownerId = authOwner(deps, body);
  if (ownerId === undefined) {
    return fail(401, "احراز هویت نامعتبر است.");
  }
  try {
    switch (name) {
      case "profile.get":
        return handleProfileGet(deps, ownerId);
      case "profile.save":
        return handleProfileSave(deps, ownerId, body);
      default:
        return fail(404, "درخواست نامعتبر است.");
    }
  } catch {
    return fail(500, "خطای داخلی رخ داد.");
  }
}

// ------------------------------------------------------------ handlers ------

/**
 * profile.get — ensure the profile is seeded for the owner (from the
 * server-side owner id, never from the request body), then return it.
 */
function handleProfileGet(deps: ProfileApiDeps, ownerId: string): Response {
  const service = profileServiceFor(deps);
  const seeded = service.ensureSeeded(ownerId);
  // load() is the stored truth; the ensureSeeded result is the fallback for
  // a stored doc that no longer parses (the service reports the empty
  // skeleton instead of overwriting it in that case).
  const profile = service.load() ?? seeded?.profile;
  if (profile === undefined) {
    return fail(500, "خطای داخلی رخ داد.");
  }
  return ok({ profile });
}

/**
 * profile.save — accept an edited profile object under `profile`, validate
 * its shape via parseOwnerProfile on the serialized form, enforce the size
 * cap, persist through the service, and return the saved profile.
 */
function handleProfileSave(
  deps: ProfileApiDeps,
  ownerId: string,
  body: Record<string, unknown>,
): Response {
  const candidate = body["profile"];
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    audit(deps.storage, "miniapp.profile.save", ownerId, "denied", "missing profile object");
    return fail(400, "پروفایل نامعتبر است.");
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(candidate);
  } catch {
    audit(deps.storage, "miniapp.profile.save", ownerId, "denied", "unserializable profile");
    return fail(400, "پروفایل نامعتبر است.");
  }
  if (serialized.length > MAX_PROFILE_BYTES) {
    audit(deps.storage, "miniapp.profile.save", ownerId, "denied", "profile too large");
    return fail(413, "بدنه درخواست بیش از حد بزرگ است.");
  }

  // Shape check on the serialized form: parseOwnerProfile is the single
  // source of truth for what a valid OwnerProfile looks like. It may signal
  // "invalid" by returning undefined/null or by throwing — both reject.
  let parsed: OwnerProfile | undefined;
  try {
    parsed = parseOwnerProfile(serialized) ?? undefined;
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    audit(deps.storage, "miniapp.profile.save", ownerId, "denied", "profile failed shape check");
    return fail(400, "پروفایل نامعتبر است.");
  }

  const service = profileServiceFor(deps);
  service.ensureSeeded(ownerId);
  service.save(parsed);
  audit(deps.storage, "miniapp.profile.save", ownerId, "success", "profile updated");
  return ok({ profile: parsed });
}
