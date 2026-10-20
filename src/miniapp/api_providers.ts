/**
 * Mini App providers & models API — the backend for the management surface's
 * providers tab.
 *
 * Everything here reuses the existing AI layer; nothing is reimplemented:
 *   - CRUD via ProviderService / ModelService (src/ai/provider_service.ts)
 *   - live probe via ProviderHealthService (src/ai/health.ts)
 *   - model discovery via the adapter's listModels (same pattern as
 *     ai_controller.runAuthorizedDiscovery)
 *   - URL policy via validateTarget (src/ai/target.ts); the DNS-level SSRF
 *     guard (src/ai/dns_guard.ts) runs inside the adapters at request time.
 *
 * The Mini App is owner-only (initData validated + userId === ownerId in the
 * API layer), so the write operations here need no further gating.
 *
 * Credential rule: a full key is NEVER returned. Views carry `keyPresent`
 * and `keyHint` ("••••" + last 4 chars) only.
 */
import { AdapterRegistry } from "../ai/adapter_registry";
import {
  ADAPTER_TEMPLATES,
  PROVIDER_PRESETS,
  isAdapterType,
  providerPreset,
} from "../ai/adapter";
import { checkProviderUrl } from "../ai/provider_url_guard";
import { withHttpStatusSuffix } from "../ai/http_status";
import { validateTarget } from "../ai/target";
import { AiError } from "../ai/provider";
import type { Storage } from "../storage/storage";
import type {
  ModelService,
  ProviderService,
  ProviderView,
} from "../ai/provider_service";
import type { ProviderHealthService, ProbeResult } from "../ai/health";

const MAX_MODEL_IDS = 200;
const MAX_URL_CHARS = 512;

export interface ProviderApiDeps {
  storage: Storage;
  providerSvc: Pick<
    ProviderService,
    | "listViews"
    | "view"
    | "create"
    | "update"
    | "setEnabled"
    | "remove"
    | "clearCredential"
    | "credentialFor"
    | "isActive"
    | "ensureSelection"
  >;
  modelSvc: Pick<
    ModelService,
    | "list"
    | "get"
    | "add"
    | "setEnabled"
    | "remove"
    | "setDefault"
    | "isActive"
    | "enabledModels"
  >;
  health: Pick<ProviderHealthService, "probe" | "probeModel"> & {
    /**
     * Optional: the real health service carries `last()` (with the
     * gateway's circuit-breaker / model-quarantine snapshot attached).
     * listProviders surfaces it when present; test fakes without it
     * simply omit the additive card fields.
     */
    last?: ProviderHealthService["last"];
  };
  /** Overridable in tests; defaults to the real registry. */
  adapters?: AdapterRegistry;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** A client-facing API failure: Persian message + HTTP status. */
export class ProviderApiError extends Error {
  /** Machine error code, when the failure has one (e.g. the URL guard). */
  readonly code?: string;
  /** Corrected value the client can offer, when one is unambiguous. */
  readonly suggestion?: string;
  constructor(
    readonly status: number,
    message: string,
    extra?: { code?: string; suggestion?: string },
  ) {
    super(message);
    if (extra?.code !== undefined) this.code = extra.code;
    if (extra?.suggestion !== undefined) this.suggestion = extra.suggestion;
  }
}

export async function handleProviderApi(
  action: string,
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Promise<Record<string, unknown>> {
  const adapters = deps.adapters ?? new AdapterRegistry();
  switch (action) {
    case "providers.list":
      return { providers: listProviders(deps) };
    case "providers.presets":
      return presetsView();
    case "providers.add":
      return addProvider(params, deps);
    case "providers.update":
      return updateProvider(params, deps);
    case "providers.toggle":
      return toggleProvider(params, deps);
    case "providers.delete":
      return deleteProvider(params, deps);
    case "providers.probe":
      return probeProvider(params, deps);
    case "providers.setKey":
      return setProviderKey(params, deps);
    case "providers.clearKey":
      return clearProviderKey(params, deps);
    case "providers.setActive":
      return setActiveProvider(params, deps);
    case "models.list":
      return { models: listModels(params, deps) };
    case "models.discover":
      return discoverModels(params, deps, adapters);
    case "models.discoverDraft":
      return discoverDraftModels(params, deps, adapters);
    case "models.import":
      return importModels(params, deps);
    case "models.add":
      return addModel(params, deps);
    case "models.toggle":
      return toggleModel(params, deps);
    case "models.delete":
      return deleteModel(params, deps);
    case "models.setActive":
      return setActiveModel(params, deps);
    case "models.test":
      return testModel(params, deps);
    default:
      throw new ProviderApiError(404, "Invalid request.");
  }
}

// ------------------------------------------------------------- helpers ----

function asId(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function asNonEmptyString(value: unknown, max = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  if (t === "" || t.length > max) return undefined;
  return t;
}

/** A key hint for the UI: masked, last 4 chars only. Never the full key. */
function keyHint(deps: ProviderApiDeps, providerId: number): string | null {
  let key: string | undefined;
  try {
    key = deps.providerSvc.credentialFor(providerId);
  } catch {
    // Undecryptable: the UI shows "set" without a hint.
    return null;
  }
  if (key === undefined || key === "") return null;
  return `••••${key.slice(-4)}`;
}

/**
 * Auto-select after an add: when no valid provider/model is currently
 * selected, activate the first usable one (the just-added provider when it
 * qualifies). Returns what was activated, or undefined when a selection
 * already existed or nothing usable exists yet. The UI uses this to tell the
 * owner "you're live" vs "now pick a model".
 */
function autoSelectIfNone(
  deps: ProviderApiDeps,
): { providerId: number; modelId: number } | undefined {
  let before: { activeProviderId: number | null; activeModelId: number | null };
  try {
    before = deps.storage.getRuntimeSettings();
  } catch {
    return undefined;
  }
  const sel = deps.providerSvc.ensureSelection();
  if (sel === undefined) return undefined;
  // Report only when the selection actually CHANGED. Comparing against the
  // pair that was there before is what makes this accurate: ensureSelection
  // heals a broken-but-present selection (e.g. the active provider's key was
  // cleared, so it silently switched to another provider), and the old
  // "a provider row existed" check would have swallowed exactly that case.
  if (
    sel.providerId === before.activeProviderId &&
    sel.modelId === before.activeModelId
  ) {
    return undefined;
  }
  return sel;
}

interface ProbeView {
  ok: boolean;
  atMs: number;
  latencyMs: number | null;
  message?: string;
  /** HTTP status of the failed probe, when the adapter reported one. */
  status?: number;
}

function lastProbeView(
  deps: ProviderApiDeps,
  view: ProviderView,
): ProbeView | null {
  if (view.lastTestOk === undefined || view.lastTestAt === undefined) return null;
  // The health record persists status + real latency (the ProviderView
  // does not carry them); read them from storage so a stored probe row
  // shows why it failed and how long it took, not just ✓/✗ + time.
  let health: ReturnType<Storage["getProviderHealth"]>;
  try {
    health = deps.storage.getProviderHealth(view.id);
  } catch {
    health = undefined;
  }
  const out: ProbeView = {
    ok: view.lastTestOk,
    atMs: view.lastTestAt,
    latencyMs: health?.latencyMs ?? null,
  };
  if (view.lastTestMessage !== undefined) out.message = view.lastTestMessage;
  if (health?.status !== undefined) out.status = health.status;
  return out;
}

/**
 * Compact circuit-breaker / model-quarantine card fields, read from the
 * health service's `last()` snapshot (the production service is built
 * with the gateway's shared breaker registry, so this needs no extra
 * plumbing). Sparse: absent entirely when no source is injected or the
 * breaker is closed and nothing is quarantined.
 */
function reliabilityView(
  deps: ProviderApiDeps,
  providerId: number,
): Record<string, unknown> {
  if (deps.health.last === undefined) return {};
  let last: ReturnType<NonNullable<ProviderApiDeps["health"]["last"]>>;
  try {
    last = deps.health.last(providerId);
  } catch {
    return {};
  }
  if (last === undefined) return {};
  const out: Record<string, unknown> = {};
  if (last.circuit !== undefined) {
    out["breaker"] = {
      state: last.circuit.state,
      open: last.circuit.state === "open",
      consecutiveFailures: last.circuit.consecutiveFailures,
      ...(last.circuit.nextRetryAt !== undefined
        ? { nextRetryAt: last.circuit.nextRetryAt }
        : {}),
    };
    out["breakerOpen"] = last.circuit.state === "open";
  }
  if (last.quarantined === true) out["quarantined"] = true;
  return out;
}

function listProviders(deps: ProviderApiDeps): Record<string, unknown>[] {
  const settings = deps.storage.getRuntimeSettings();
  return deps.providerSvc.listViews().map((v) => ({
    id: v.id,
    label: v.label,
    adapterType: v.adapter,
    adapterLabel: v.adapterLabel,
    baseUrl: v.baseUrl,
    enabled: v.enabled,
    keyPresent: v.hasCredential,
    keyHint: keyHint(deps, v.id),
    modelCount: v.modelCount,
    isActive: v.isActive,
    activeModelId: v.isActive ? settings.activeModelId : null,
    lastProbe: lastProbeView(deps, v),
    ...reliabilityView(deps, v.id),
  }));
}

function presetsView(): Record<string, unknown> {
  return {
    presets: PROVIDER_PRESETS.map((p) => ({
      id: p.id,
      label: p.label,
      baseUrl: p.baseUrl,
      ...(p.suggestedModel !== undefined ? { suggestedModel: p.suggestedModel } : {}),
      hasPlaceholder: p.requiredPlaceholder !== undefined,
      ...(p.requiredPlaceholder !== undefined ? { requiredPlaceholder: p.requiredPlaceholder } : {}),
      note: p.note,
    })),
    // ALL adapter templates — native types (gemini, anthropic) included.
    // Filtering them out is what made a native provider uncreatable from
    // the miniapp (audit C2); each entry exposes its adapter type so the
    // add form can lock the type to the template.
    templates: ADAPTER_TEMPLATES.map((t) => ({
      type: t.type,
      adapterType: t.type,
      label: t.label,
      suggestedBaseUrl: t.suggestedBaseUrl,
      ...(t.suggestedModel !== undefined ? { suggestedModel: t.suggestedModel } : {}),
      notes: t.capabilities.notes,
    })),
  };
}

/**
 * Validate a provider base URL: https only, no credentials in the URL, no
 * unfilled placeholders, and the lexical SSRF policy from the AI layer
 * (loopback/private/link-local hosts refused unless the provider is granted
 * the local exception separately). Returns the normalized base URL.
 */
function validateProviderUrl(raw: unknown): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed === "") {
    throw new ProviderApiError(400, "Service address is required.");
  }
  if (trimmed.length > MAX_URL_CHARS) {
    throw new ProviderApiError(400, "Service address is too long.");
  }
  if (/[{}]/.test(trimmed)) {
    throw new ProviderApiError(
      400,
      "The service address contains an unfilled placeholder; replace it with the real value.",
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ProviderApiError(400, "Service address is invalid.");
  }
  // Scheme + private-host policy is enforced by validateTarget below (http
  // and https both allowed; private/link-local/metadata hosts rejected).
  // Plain http is legitimate here: self-hosted routers on bare IPs (where
  // no public CA will issue a cert) are a normal case for this form.
  try {
    const { baseUrl } = validateTarget({ baseUrl: trimmed, apiKey: undefined });
    return baseUrl;
  } catch (err) {
    if (err instanceof AiError) {
      throw new ProviderApiError(400, err.message);
    }
    throw new ProviderApiError(400, "Service address is invalid.");
  }
}

/**
 * The adapter type a payload explicitly asks for (`adapter`, `type`, or
 * `template` — the add/discover forms have used all three spellings).
 * Returns undefined when the payload names none; throws when it names
 * one that is not a registered adapter type.
 */
function payloadAdapterType(params: Record<string, unknown>): string | undefined {
  const raw =
    asNonEmptyString(params["adapter"], 64) ??
    asNonEmptyString(params["type"], 64) ??
    asNonEmptyString(params["template"], 64);
  if (raw === undefined) return undefined;
  if (!isAdapterType(raw)) {
    throw new ProviderApiError(400, "Invalid provider type.");
  }
  return raw;
}

/**
 * Server-side type ↔ URL cross-check (audit C3): refuse to save a known
 * vendor address under the wrong wire format. The rejection carries the
 * guard's message with the corrected address appended, plus the stable
 * code/suggestion on the error for clients that render them.
 */
function assertUrlMatchesType(adapterType: string, baseUrl: string): void {
  const issue = checkProviderUrl(adapterType, baseUrl);
  if (issue === null) return;
  const message =
    issue.suggestion !== undefined
      ? `${issue.message} Suggested address: ${issue.suggestion}`
      : issue.message;
  throw new ProviderApiError(400, message, {
    code: "provider_url_mismatch",
    ...(issue.suggestion !== undefined ? { suggestion: issue.suggestion } : {}),
  });
}

/**
 * Surface a model-discovery failure honestly (audit H4): an adapter
 * AiError keeps its message and HTTP status (appended when the message
 * does not already name it) instead of collapsing into a generic 502
 * sentence that makes a 401, a 404 and a dead network indistinguishable.
 * The provider's own error words ride along when the response carried
 * any — discovery is where a wrong address or key is usually diagnosed.
 */
function discoveryError(err: unknown): ProviderApiError {
  if (err instanceof AiError) {
    let message = err.message;
    if (err.status !== undefined) {
      message = withHttpStatusSuffix(message, err.status);
    }
    if (err.providerMessage !== undefined && err.providerMessage.length > 0) {
      message = `${message} Provider said: ${err.providerMessage}`;
    }
    const status =
      err.status !== undefined && err.status >= 400 && err.status < 600
        ? err.status
        : 502;
    return new ProviderApiError(status, message);
  }
  return new ProviderApiError(
    502,
    "Model discovery failed; check the connection or address.",
  );
}

function labelTaken(deps: ProviderApiDeps, label: string): boolean {
  const needle = label.trim().toLowerCase();
  return deps.storage
    .listProviders()
    .some((p) => p.label.trim().toLowerCase() === needle);
}

// ------------------------------------------------------------ providers ----

function addProvider(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown> {
  const kind = params["kind"];
  if (kind === "preset") {
    return addFromPreset(params, deps);
  }
  if (kind === "template") {
    return addFromTemplate(params, deps);
  }
  if (kind === "custom" || kind === "nine_router") {
    return addCustom(params, deps, kind);
  }
  throw new ProviderApiError(400, "Invalid provider add type.");
}

function addFromPreset(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown> {
  const presetId = asNonEmptyString(params["preset"], 64);
  const preset = presetId !== undefined ? providerPreset(presetId) : undefined;
  if (!preset) {
    // Not a service preset: the id may name an adapter template (the
    // gallery lists both) — create it with the template's own type.
    const template =
      presetId !== undefined
        ? ADAPTER_TEMPLATES.find((t) => t.type === presetId)
        : undefined;
    if (template !== undefined) {
      return addFromTemplate(params, deps, template.type);
    }
    throw new ProviderApiError(400, "Unknown service.");
  }
  // The owner may rename the provider; fall back to the preset label.
  const label = asNonEmptyString(params["label"], 64) ?? preset.label;
  if (labelTaken(deps, label)) {
    throw new ProviderApiError(400, "A provider with this name is already registered.");
  }
  // The form may send a placeholder-resolved base URL (e.g. Cloudflare);
  // prefer it over the raw preset template.
  const override = asNonEmptyString(params["baseUrl"], MAX_URL_CHARS);
  const resolved = override ?? preset.baseUrl;
  if (
    preset.requiredPlaceholder !== undefined &&
    resolved.includes(`{${preset.requiredPlaceholder}}`)
  ) {
    throw new ProviderApiError(
      400,
      `The address still contains {${preset.requiredPlaceholder}}; replace it with the real value.`,
    );
  }
  const baseUrl = validateProviderUrl(resolved);
  // Service presets are OpenAI-compatible by construction; an explicit
  // adapter type in the payload (the gallery locks one per entry) wins.
  const adapter = payloadAdapterType(params) ?? "openai_compatible";
  assertUrlMatchesType(adapter, baseUrl);

  const key = asNonEmptyString(params["key"], 1024);
  const created = deps.providerSvc.create({
    label,
    adapter,
    baseUrl,
    ...(key !== undefined ? { apiKey: key } : {}),
  });
  if (!created.ok) {
    throw new ProviderApiError(400, created.message);
  }
  const providerId = created.data;
  const out: Record<string, unknown> = { id: providerId };

  if (preset.suggestedModel !== undefined) {
    const added = deps.modelSvc.add({
      providerId,
      modelId: preset.suggestedModel,
      label: preset.suggestedModel,
    });
    if (added.ok) out["modelId"] = added.data;
  }
  // Auto-select: when nothing valid is selected yet (fresh setup), the new
  // provider becomes active immediately — no separate "select" step.
  const auto = autoSelectIfNone(deps);
  if (auto !== undefined) out["autoSelected"] = auto;
  return out;
}

/**
 * Add from an adapter template (audit C2): the provider is created with
 * the TEMPLATE's adapter type — this is the only route that can create a
 * native gemini/anthropic provider — and the template's suggested base
 * URL unless the form sent an edited one.
 */
function addFromTemplate(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
  forcedType?: string,
): Record<string, unknown> {
  const type = forcedType ?? payloadAdapterType(params);
  const template =
    type !== undefined
      ? ADAPTER_TEMPLATES.find((t) => t.type === type)
      : undefined;
  if (template === undefined) {
    throw new ProviderApiError(400, "Unknown provider type.");
  }
  const label = asNonEmptyString(params["label"], 64) ?? template.label;
  if (labelTaken(deps, label)) {
    throw new ProviderApiError(400, "A provider with this name is already registered.");
  }
  const override = asNonEmptyString(params["baseUrl"], MAX_URL_CHARS);
  const baseUrl = validateProviderUrl(override ?? template.suggestedBaseUrl);
  assertUrlMatchesType(template.type, baseUrl);

  const key = asNonEmptyString(params["key"], 1024);
  const created = deps.providerSvc.create({
    label,
    adapter: template.type,
    baseUrl,
    ...(key !== undefined ? { apiKey: key } : {}),
  });
  if (!created.ok) {
    throw new ProviderApiError(400, created.message);
  }
  const providerId = created.data;
  const out: Record<string, unknown> = { id: providerId };

  const modelId =
    asNonEmptyString(params["model"], 128) ??
    asNonEmptyString(params["suggestedModel"], 128) ??
    template.suggestedModel;
  if (modelId !== undefined) {
    const added = deps.modelSvc.add({ providerId, modelId, label: modelId });
    if (added.ok) out["modelId"] = added.data;
  }
  const auto = autoSelectIfNone(deps);
  if (auto !== undefined) out["autoSelected"] = auto;
  return out;
}

function addCustom(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
  kind: "custom" | "nine_router",
): Record<string, unknown> {
  const label = asNonEmptyString(params["label"], 64);
  if (label === undefined) {
    throw new ProviderApiError(400, "A display name for the provider is required.");
  }
  if (labelTaken(deps, label)) {
    throw new ProviderApiError(400, "A provider with this name is already registered.");
  }
  const baseUrl = validateProviderUrl(params["baseUrl"]);
  const key = asNonEmptyString(params["key"], 1024);

  const model = asNonEmptyString(params["model"], 128);
  if (kind === "nine_router") {
    if (key === undefined) {
      throw new ProviderApiError(400, "A 9Router key is required.");
    }
    if (model === undefined) {
      throw new ProviderApiError(400, "A 9Router model is required.");
    }
  }

  // An explicit adapter type in the payload wins (audit C2); nine_router
  // keeps its own type regardless, everything else defaults to
  // openai_compatible as before.
  const adapter =
    kind === "nine_router"
      ? "nine_router"
      : (payloadAdapterType(params) ?? "openai_compatible");
  assertUrlMatchesType(adapter, baseUrl);

  const created = deps.providerSvc.create({
    label,
    adapter,
    baseUrl,
    ...(key !== undefined ? { apiKey: key } : {}),
  });
  if (!created.ok) {
    throw new ProviderApiError(400, created.message);
  }
  const providerId = created.data;
  const out: Record<string, unknown> = { id: providerId };

  const modelId = model ?? asNonEmptyString(params["suggestedModel"], 128);
  if (modelId !== undefined) {
    const added = deps.modelSvc.add({ providerId, modelId, label: modelId });
    if (added.ok) out["modelId"] = added.data;
  }
  // Auto-select: when nothing valid is selected yet (fresh setup), the new
  // provider becomes active immediately — no separate "select" step.
  const auto = autoSelectIfNone(deps);
  if (auto !== undefined) out["autoSelected"] = auto;
  return out;
}

function updateProvider(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown> {
  const id = asId(params["id"]);
  if (id === undefined) throw new ProviderApiError(400, "Invalid provider ID.");
  const existing = deps.providerSvc.view(id);
  if (!existing) {
    throw new ProviderApiError(404, "Provider not found.");
  }

  const patch: { label?: string; baseUrl?: string } = {};
  if (params["label"] !== undefined) {
    const label = asNonEmptyString(params["label"], 64);
    if (label === undefined) {
      throw new ProviderApiError(400, "Invalid provider display name.");
    }
    // The add path refuses duplicate labels; the rename path must too, or a
    // rename can create the exact ambiguity the add check exists to prevent.
    const needle = label.toLowerCase();
    const clash = deps.storage
      .listProviders()
      .some((p) => p.id !== id && p.label.trim().toLowerCase() === needle);
    if (clash) {
      throw new ProviderApiError(400, "A provider with this name is already registered.");
    }
    patch.label = label;
  }
  if (params["baseUrl"] !== undefined) {
    patch.baseUrl = validateProviderUrl(params["baseUrl"]);
    // Type ↔ URL cross-check on change (audit C3): an edit must not be
    // able to recreate the incident combo the add path now refuses.
    if (patch.baseUrl !== existing.baseUrl) {
      assertUrlMatchesType(existing.adapter, patch.baseUrl);
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new ProviderApiError(400, "No fields to change were given.");
  }
  const r = deps.providerSvc.update(id, patch);
  // Service-layer refusals (e.g. the active-provider lock, audit L1)
  // reach the client with their actionable message intact.
  if (!r.ok) throw new ProviderApiError(400, r.message);
  return { ok: true };
}

function toggleProvider(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown> {
  const id = asId(params["id"]);
  if (id === undefined) throw new ProviderApiError(400, "Invalid provider ID.");
  if (typeof params["enabled"] !== "boolean") {
    throw new ProviderApiError(400, "Invalid status.");
  }
  const r = deps.providerSvc.setEnabled(id, params["enabled"]);
  if (!r.ok) throw new ProviderApiError(400, r.message);
  return { ok: true };
}

function deleteProvider(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown> {
  const id = asId(params["id"]);
  if (id === undefined) throw new ProviderApiError(400, "Invalid provider ID.");
  if (!deps.providerSvc.view(id)) {
    throw new ProviderApiError(404, "Provider not found.");
  }
  if (params["confirm"] !== true) {
    return { needsConfirm: true };
  }
  const r = deps.providerSvc.remove(id);
  if (!r.ok) throw new ProviderApiError(400, r.message);
  return { ok: true };
}

async function probeProvider(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Promise<Record<string, unknown>> {
  const id = asId(params["id"]);
  if (id === undefined) throw new ProviderApiError(400, "Invalid provider ID.");
  if (!deps.providerSvc.view(id)) {
    throw new ProviderApiError(404, "Provider not found.");
  }
  // Reuses the same probe the panel's test button runs; it records the
  // outcome via storage itself and never surfaces key material.
  const started = Date.now();
  let result: { ok: boolean; message?: string; checkedAt: number };
  try {
    result = await deps.health.probe(id);
  } catch {
    throw new ProviderApiError(500, "Probe failed.");
  }
  const out: Record<string, unknown> = {
    ok: result.ok,
    latencyMs: Date.now() - started,
    atMs: result.checkedAt,
  };
  if (result.message !== undefined) out["message"] = result.message;
  return out;
}

function setProviderKey(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown> {
  const id = asId(params["id"]);
  if (id === undefined) throw new ProviderApiError(400, "Invalid provider ID.");
  const key = asNonEmptyString(params["key"], 4096);
  if (key === undefined) throw new ProviderApiError(400, "Key is not valid.");
  if (!deps.providerSvc.view(id)) {
    throw new ProviderApiError(404, "Provider not found.");
  }
  // Write-only: the service encrypts before storing; the key is never read
  // back or included in any response.
  const r = deps.providerSvc.update(id, { apiKey: key });
  if (!r.ok) throw new ProviderApiError(400, r.message);
  return { ok: true, keyPresent: true };
}

function clearProviderKey(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown> {
  const id = asId(params["id"]);
  if (id === undefined) throw new ProviderApiError(400, "Invalid provider ID.");
  if (!deps.providerSvc.view(id)) {
    throw new ProviderApiError(404, "Provider not found.");
  }
  if (params["confirm"] !== true) {
    return { needsConfirm: true };
  }
  const r = deps.providerSvc.clearCredential(id);
  if (!r.ok) throw new ProviderApiError(400, r.message);
  return { ok: true, keyPresent: false };
}

/**
 * Activate a provider: the provider must exist, be enabled, and have a
 * credential and at least one enabled model. The model picked is the current
 * runtime model when it belongs to this provider and is enabled, otherwise
 * the provider's default, otherwise its first enabled model.
 */
function setActiveProvider(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Promise<Record<string, unknown>> {
  const id = asId(params["id"]);
  if (id === undefined) throw new ProviderApiError(400, "Invalid provider ID.");
  const view = deps.providerSvc.view(id);
  if (!view) throw new ProviderApiError(404, "Provider not found.");
  if (!view.enabled) {
    throw new ProviderApiError(400, "Provider is disabled; enable it first.");
  }
  if (!view.hasCredential) {
    throw new ProviderApiError(400, "This provider has no credential set.");
  }

  const models = deps.modelSvc.enabledModels(id);
  if (models.length === 0) {
    throw new ProviderApiError(400, "This provider has no enabled models; add a model first.");
  }
  const settings = deps.storage.getRuntimeSettings();
  const current =
    settings.activeModelId !== null
      ? models.find((m) => m.id === settings.activeModelId)
      : undefined;
  const chosen =
    current ?? models.find((m) => m.isDefault) ?? (models[0] as (typeof models)[number]);
  try {
    deps.storage.setRuntimeSelection({ providerId: id, modelId: chosen.id });
  } catch {
    throw new ProviderApiError(500, "Activation failed.");
  }
  const out: Record<string, unknown> = {
    ok: true,
    providerId: id,
    modelId: chosen.id,
    label: chosen.label,
  };
  // Probe on select: warn inline when the fresh selection doesn't answer, so
  // the owner discovers a dead provider here — not by chatting into the void.
  // A failed probe never blocks the selection itself.
  return (async () => {
    try {
      const started = Date.now();
      const result = await deps.health.probe(id);
      out["probe"] = {
        ok: result.ok,
        latencyMs: Date.now() - started,
        ...(result.message !== undefined ? { message: result.message } : {}),
      };
    } catch {
      out["probe"] = { ok: false, message: "Connection probe failed." };
    }
    return out;
  })();
}

// --------------------------------------------------------------- models ----

function listModels(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown>[] {
  const providerId = asId(params["providerId"]);
  if (providerId === undefined) {
    throw new ProviderApiError(400, "Invalid provider ID.");
  }
  if (!deps.storage.getProvider(providerId)) {
    throw new ProviderApiError(404, "Provider not found.");
  }
  return deps.modelSvc.list(providerId).map((m) => ({
    id: m.id,
    label: m.label,
    modelId: m.modelId,
    enabled: m.enabled,
    isActive: deps.modelSvc.isActive(m.id),
  }));
}

/**
 * Fetch the provider's remote model list without touching the local store —
 * the same discover the panel uses. Returns every remote id with an
 * `imported` flag for the ones already stored.
 */
async function discoverModels(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
  adapters: AdapterRegistry,
): Promise<Record<string, unknown>> {
  const providerId = asId(params["providerId"]);
  if (providerId === undefined) {
    throw new ProviderApiError(400, "Invalid provider ID.");
  }
  const provider = deps.storage.getProvider(providerId);
  if (!provider) {
    throw new ProviderApiError(404, "Provider not found.");
  }
  // A row saved before the guard existed can still hold a known-broken
  // type ↔ URL pair: refuse with the guard's fix (same fail-fast as
  // draft discovery) instead of sending a request that can only 404.
  assertUrlMatchesType(provider.adapter, provider.baseUrl);
  if (!adapters.describes(provider.adapter).listModels) {
    throw new ProviderApiError(400, "This provider type cannot list models.");
  }

  let apiKey: string | undefined;
  try {
    apiKey = deps.providerSvc.credentialFor(providerId);
  } catch {
    throw new ProviderApiError(400, "Credential could not be read.");
  }
  if (apiKey === undefined || apiKey === "") {
    throw new ProviderApiError(400, "This provider has no credential set.");
  }

  // The adapter applies the DNS-level SSRF guard (pinned addresses, no
  // redirects) before any connection is made. The owner's local-target
  // exception, when granted, applies to discovery exactly as it does to the
  // runtime and the panel's own discover — otherwise a local provider could
  // never list its models from the mini app.
  const adapter = adapters.create(provider.adapter, {
    baseUrl: provider.baseUrl,
    apiKey,
    model: "discover",
    ...(provider.allowLocal ? { allowLocalTargets: true } : {}),
  });
  if (!adapter.listModels) {
    throw new ProviderApiError(400, "This provider does not support model discovery.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let remote: readonly { id: string; label?: string }[];
  try {
    remote = await adapter.listModels({
      target: { baseUrl: provider.baseUrl, apiKey },
      timeoutMs: 15_000,
      signal: controller.signal,
    });
  } catch (err) {
    throw discoveryError(err);
  } finally {
    clearTimeout(timer);
  }

  const known = new Set(deps.storage.listModels(providerId).map((m) => m.modelId));
  return {
    models: remote.map((r) => ({
      modelId: r.id,
      label: r.label ?? r.id,
      imported: known.has(r.id),
    })),
  };
}

/**
 * Draft discovery: list a provider's models BEFORE it is saved, from the
 * key + base URL the owner just typed in the add form. Same SSRF posture as
 * discoverModels (validateTarget + the adapter's DNS guard); the key is used
 * once for this call and never stored or logged.
 */
async function discoverDraftModels(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
  adapters: AdapterRegistry,
): Promise<Record<string, unknown>> {
  const kind = params["kind"];
  let baseUrl: string;
  // Build the adapter for the type the form actually asked for (audit
  // H4/C2) — a draft Gemini provider must be discovered through the
  // native Gemini wire format, not a hardcoded openai_compatible one.
  let adapterType = "openai_compatible";
  if (kind === "preset") {
    const presetId = asNonEmptyString(params["preset"], 64);
    const preset = presetId !== undefined ? providerPreset(presetId) : undefined;
    if (!preset) {
      throw new ProviderApiError(400, "Unknown service.");
    }
    // The form may send a placeholder-resolved base URL (e.g. Cloudflare).
    const override = asNonEmptyString(params["baseUrl"], MAX_URL_CHARS);
    baseUrl = validateProviderUrl(override ?? preset.baseUrl);
    adapterType = payloadAdapterType(params) ?? "openai_compatible";
  } else if (kind === "custom" || kind === "template") {
    adapterType = payloadAdapterType(params) ?? "openai_compatible";
    const template =
      kind === "template"
        ? ADAPTER_TEMPLATES.find((t) => t.type === adapterType)
        : undefined;
    const override = asNonEmptyString(params["baseUrl"], MAX_URL_CHARS);
    baseUrl = validateProviderUrl(
      override ?? template?.suggestedBaseUrl ?? params["baseUrl"],
    );
  } else {
    throw new ProviderApiError(400, "Invalid provider type for model discovery.");
  }
  // Draft discovery is a pre-save check: run the type ↔ URL guard here
  // too, so the incident combo is refused before a provider exists.
  assertUrlMatchesType(adapterType, baseUrl);

  const apiKey = asNonEmptyString(params["key"], 1024);
  if (apiKey === undefined) {
    throw new ProviderApiError(400, "An API key is required to fetch models.");
  }

  if (!adapters.describes(adapterType).listModels) {
    throw new ProviderApiError(400, "This provider type does not support model discovery.");
  }
  const adapter = adapters.create(adapterType, {
    baseUrl,
    apiKey,
    model: "discover",
  });
  if (!adapter.listModels) {
    throw new ProviderApiError(400, "This provider does not support model discovery.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let remote: readonly { id: string; label?: string }[];
  try {
    remote = await adapter.listModels({
      target: { baseUrl, apiKey },
      timeoutMs: 15_000,
      signal: controller.signal,
    });
  } catch (err) {
    throw discoveryError(err);
  } finally {
    clearTimeout(timer);
  }
  return {
    models: remote.map((r) => ({ modelId: r.id, label: r.label ?? r.id })),
  };
}

function importModels(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown> {
  const providerId = asId(params["providerId"]);
  if (providerId === undefined) {
    throw new ProviderApiError(400, "Invalid provider ID.");
  }
  if (!deps.storage.getProvider(providerId)) {
    throw new ProviderApiError(404, "Provider not found.");
  }
  const raw = params["modelIds"];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MODEL_IDS) {
    throw new ProviderApiError(400, "Model list is invalid.");
  }
  const known = new Set(deps.storage.listModels(providerId).map((m) => m.modelId));
  let imported = 0;
  let skipped = 0;
  for (const entry of raw) {
    const modelId = asNonEmptyString(entry, 128);
    if (modelId === undefined || known.has(modelId)) {
      skipped += 1;
      continue;
    }
    const r = deps.modelSvc.add({ providerId, modelId, label: modelId });
    if (r.ok) {
      known.add(modelId);
      imported += 1;
    } else {
      skipped += 1;
    }
  }
  const out: Record<string, unknown> = { imported, skipped };
  const auto = autoSelectIfNone(deps);
  if (auto !== undefined) out["autoSelected"] = auto;
  return out;
}

function addModel(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown> {
  const providerId = asId(params["providerId"]);
  if (providerId === undefined) {
    throw new ProviderApiError(400, "Invalid provider ID.");
  }
  if (!deps.storage.getProvider(providerId)) {
    throw new ProviderApiError(404, "Provider not found.");
  }
  const modelId = asNonEmptyString(params["modelId"], 128);
  if (modelId === undefined) {
    throw new ProviderApiError(400, "Model ID is required.");
  }
  const label = asNonEmptyString(params["label"], 64) ?? modelId;
  const r = deps.modelSvc.add({ providerId, modelId, label });
  if (!r.ok) throw new ProviderApiError(400, r.message);
  const out: Record<string, unknown> = { id: r.data };
  const auto = autoSelectIfNone(deps);
  if (auto !== undefined) out["autoSelected"] = auto;
  return out;
}

function toggleModel(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown> {
  const id = asId(params["id"]);
  if (id === undefined) throw new ProviderApiError(400, "Invalid model ID.");
  if (typeof params["enabled"] !== "boolean") {
    throw new ProviderApiError(400, "Invalid status.");
  }
  const r = deps.modelSvc.setEnabled(id, params["enabled"]);
  if (!r.ok) throw new ProviderApiError(400, r.message);
  return { ok: true };
}

function deleteModel(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown> {
  const id = asId(params["id"]);
  if (id === undefined) throw new ProviderApiError(400, "Invalid model ID.");
  if (!deps.modelSvc.get(id)) {
    throw new ProviderApiError(404, "Model not found.");
  }
  if (params["confirm"] !== true) {
    return { needsConfirm: true };
  }
  const r = deps.modelSvc.remove(id);
  if (!r.ok) throw new ProviderApiError(400, r.message);
  return { ok: true };
}

/**
 * Activate a model (and its provider), mirroring the panel's model picker:
 * the model and its provider must exist and be enabled.
 */
function setActiveModel(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Promise<Record<string, unknown>> {
  const id = asId(params["id"]);
  if (id === undefined) throw new ProviderApiError(400, "Invalid model ID.");
  const model = deps.modelSvc.get(id);
  if (!model || !model.enabled) {
    throw new ProviderApiError(400, "Model not found or disabled.");
  }
  const provider = deps.storage.getProvider(model.providerId);
  if (!provider || !provider.enabled) {
    throw new ProviderApiError(400, "This model’s provider is disabled.");
  }
  try {
    deps.storage.setRuntimeSelection({ providerId: model.providerId, modelId: id });
  } catch {
    throw new ProviderApiError(500, "Activation failed.");
  }
  const out: Record<string, unknown> = {
    ok: true,
    providerId: model.providerId,
    modelId: id,
    label: model.label,
  };
  // Probe on select: warn inline when the fresh selection doesn't answer.
  return (async () => {
    try {
      const started = Date.now();
      const result = await deps.health.probe(model.providerId);
      out["probe"] = {
        ok: result.ok,
        latencyMs: Date.now() - started,
        ...(result.message !== undefined ? { message: result.message } : {}),
      };
    } catch {
      out["probe"] = { ok: false, message: "Connection probe failed." };
    }
    return out;
  })();
}

/**
 * Test ONE model with a real completion (the model row's "Test" button).
 * Unlike the provider probe this never records provider health — it only
 * reports whether that specific model answers.
 */
async function testModel(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Promise<Record<string, unknown>> {
  const providerId = asId(params["providerId"]);
  if (providerId === undefined) {
    throw new ProviderApiError(400, "Invalid provider ID.");
  }
  const modelId = asNonEmptyString(params["modelId"], 128);
  if (modelId === undefined) {
    throw new ProviderApiError(400, "Model ID is required.");
  }
  if (!deps.providerSvc.view(providerId)) {
    throw new ProviderApiError(404, "Provider not found.");
  }
  const started = Date.now();
  let result: ProbeResult;
  try {
    result = await deps.health.probeModel(providerId, modelId);
  } catch {
    throw new ProviderApiError(500, "Model test failed.");
  }
  const out: Record<string, unknown> = {
    ok: result.ok,
    latencyMs: Date.now() - started,
    atMs: result.checkedAt,
  };
  if (result.message !== undefined) out["message"] = result.message;
  // Two-stage detail (additive): the UI renders "Ping ✅ x ms · Real ✅/⚠️".
  if (result.ping !== undefined) out["ping"] = result.ping;
  if (result.real !== undefined) out["real"] = result.real;
  if (result.quarantined === true) out["quarantined"] = true;
  return out;
}
