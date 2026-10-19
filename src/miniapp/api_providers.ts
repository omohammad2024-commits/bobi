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
  providerPreset,
} from "../ai/adapter";
import { validateTarget } from "../ai/target";
import { AiError } from "../ai/provider";
import type { Storage } from "../storage/storage";
import type {
  ModelService,
  ProviderService,
  ProviderView,
} from "../ai/provider_service";
import type { ProviderHealthService } from "../ai/health";

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
  health: Pick<ProviderHealthService, "probe">;
  /** Overridable in tests; defaults to the real registry. */
  adapters?: AdapterRegistry;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** A client-facing API failure: Persian message + HTTP status. */
export class ProviderApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
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
    default:
      throw new ProviderApiError(404, "درخواست نامعتبر است.");
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

interface ProbeView {
  ok: boolean;
  atMs: number;
  latencyMs: number | null;
  message?: string;
}

function lastProbeView(view: ProviderView): ProbeView | null {
  if (view.lastTestOk === undefined || view.lastTestAt === undefined) return null;
  const out: ProbeView = {
    ok: view.lastTestOk,
    atMs: view.lastTestAt,
    // The health store does not record latency; a fresh probe reports its own.
    latencyMs: null,
  };
  if (view.lastTestMessage !== undefined) out.message = view.lastTestMessage;
  return out;
}

function listProviders(deps: ProviderApiDeps): Record<string, unknown>[] {
  const settings = deps.storage.getRuntimeSettings();
  return deps.providerSvc.listViews().map((v) => ({
    id: v.id,
    label: v.label,
    adapterType: v.adapter,
    adapterLabel: v.adapterLabel,
    enabled: v.enabled,
    keyPresent: v.hasCredential,
    keyHint: keyHint(deps, v.id),
    modelCount: v.modelCount,
    isActive: v.isActive,
    activeModelId: v.isActive ? settings.activeModelId : null,
    lastProbe: lastProbeView(v),
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
    templates: ADAPTER_TEMPLATES.filter(
      (t) => t.type === "openai_compatible" || t.type === "nine_router",
    ).map((t) => ({
      type: t.type,
      label: t.label,
      suggestedBaseUrl: t.suggestedBaseUrl,
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
    throw new ProviderApiError(400, "آدرس سرویس لازم است.");
  }
  if (trimmed.length > MAX_URL_CHARS) {
    throw new ProviderApiError(400, "آدرس سرویس خیلی طولانی است.");
  }
  if (/[{}]/.test(trimmed)) {
    throw new ProviderApiError(
      400,
      "آدرس سرویس شامل مقدار جایگزین‌نشده است؛ آن را با مقدار واقعی عوض کن.",
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ProviderApiError(400, "آدرس سرویس نامعتبر است.");
  }
  if (url.protocol !== "https:") {
    throw new ProviderApiError(400, "آدرس سرویس باید با https شروع شود.");
  }
  try {
    const { baseUrl } = validateTarget({ baseUrl: trimmed, apiKey: undefined });
    return baseUrl;
  } catch (err) {
    if (err instanceof AiError) {
      throw new ProviderApiError(400, err.message);
    }
    throw new ProviderApiError(400, "آدرس سرویس نامعتبر است.");
  }
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
  if (kind === "custom" || kind === "nine_router") {
    return addCustom(params, deps, kind);
  }
  throw new ProviderApiError(400, "نوع افزودن پروایدر نامعتبر است.");
}

function addFromPreset(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown> {
  const presetId = asNonEmptyString(params["preset"], 64);
  const preset = presetId !== undefined ? providerPreset(presetId) : undefined;
  if (!preset) {
    throw new ProviderApiError(400, "این سرویس شناخته نشده است.");
  }
  if (labelTaken(deps, preset.label)) {
    throw new ProviderApiError(400, "پروایدری با این نام قبلاً ثبت شده است.");
  }
  if (
    preset.requiredPlaceholder !== undefined &&
    preset.baseUrl.includes(`{${preset.requiredPlaceholder}}`)
  ) {
    throw new ProviderApiError(
      400,
      `آدرس هنوز شامل {${preset.requiredPlaceholder}} است؛ آن را با مقدار واقعی عوض کن.`,
    );
  }
  const baseUrl = validateProviderUrl(preset.baseUrl);

  const key = asNonEmptyString(params["key"], 1024);
  const created = deps.providerSvc.create({
    label: preset.label,
    adapter: "openai_compatible",
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
  return out;
}

function addCustom(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
  kind: "custom" | "nine_router",
): Record<string, unknown> {
  const label = asNonEmptyString(params["label"], 64);
  if (label === undefined) {
    throw new ProviderApiError(400, "نام نمایشی پروایدر لازم است.");
  }
  if (labelTaken(deps, label)) {
    throw new ProviderApiError(400, "پروایدری با این نام قبلاً ثبت شده است.");
  }
  const baseUrl = validateProviderUrl(params["baseUrl"]);
  const key = asNonEmptyString(params["key"], 1024);

  const model = asNonEmptyString(params["model"], 128);
  if (kind === "nine_router") {
    if (key === undefined) {
      throw new ProviderApiError(400, "کلید 9Router لازم است.");
    }
    if (model === undefined) {
      throw new ProviderApiError(400, "مدل 9Router لازم است.");
    }
  }

  const created = deps.providerSvc.create({
    label,
    adapter: kind === "nine_router" ? "nine_router" : "openai_compatible",
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
  return out;
}

function updateProvider(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown> {
  const id = asId(params["id"]);
  if (id === undefined) throw new ProviderApiError(400, "شناسهٔ پروایدر نامعتبر است.");
  if (!deps.providerSvc.view(id)) {
    throw new ProviderApiError(404, "پروایدر یافت نشد.");
  }

  const patch: { label?: string; baseUrl?: string } = {};
  if (params["label"] !== undefined) {
    const label = asNonEmptyString(params["label"], 64);
    if (label === undefined) {
      throw new ProviderApiError(400, "نام نمایشی پروایدر نامعتبر است.");
    }
    patch.label = label;
  }
  if (params["baseUrl"] !== undefined) {
    patch.baseUrl = validateProviderUrl(params["baseUrl"]);
  }
  if (Object.keys(patch).length === 0) {
    throw new ProviderApiError(400, "فیلدی برای تغییر داده نشد.");
  }
  const r = deps.providerSvc.update(id, patch);
  if (!r.ok) throw new ProviderApiError(400, r.message);
  return { ok: true };
}

function toggleProvider(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown> {
  const id = asId(params["id"]);
  if (id === undefined) throw new ProviderApiError(400, "شناسهٔ پروایدر نامعتبر است.");
  if (typeof params["enabled"] !== "boolean") {
    throw new ProviderApiError(400, "وضعیت نامعتبر است.");
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
  if (id === undefined) throw new ProviderApiError(400, "شناسهٔ پروایدر نامعتبر است.");
  if (!deps.providerSvc.view(id)) {
    throw new ProviderApiError(404, "پروایدر یافت نشد.");
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
  if (id === undefined) throw new ProviderApiError(400, "شناسهٔ پروایدر نامعتبر است.");
  if (!deps.providerSvc.view(id)) {
    throw new ProviderApiError(404, "پروایدر یافت نشد.");
  }
  // Reuses the same probe the panel's test button runs; it records the
  // outcome via storage itself and never surfaces key material.
  const started = Date.now();
  let result: { ok: boolean; message?: string; checkedAt: number };
  try {
    result = await deps.health.probe(id);
  } catch {
    throw new ProviderApiError(500, "آزمایش ناموفق بود.");
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
  if (id === undefined) throw new ProviderApiError(400, "شناسهٔ پروایدر نامعتبر است.");
  const key = asNonEmptyString(params["key"], 4096);
  if (key === undefined) throw new ProviderApiError(400, "کلید معتبر نیست.");
  if (!deps.providerSvc.view(id)) {
    throw new ProviderApiError(404, "پروایدر یافت نشد.");
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
  if (id === undefined) throw new ProviderApiError(400, "شناسهٔ پروایدر نامعتبر است.");
  if (!deps.providerSvc.view(id)) {
    throw new ProviderApiError(404, "پروایدر یافت نشد.");
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
): Record<string, unknown> {
  const id = asId(params["id"]);
  if (id === undefined) throw new ProviderApiError(400, "شناسهٔ پروایدر نامعتبر است.");
  const view = deps.providerSvc.view(id);
  if (!view) throw new ProviderApiError(404, "پروایدر یافت نشد.");
  if (!view.enabled) {
    throw new ProviderApiError(400, "پروایدر غیرفعال است؛ ابتدا آن را فعال کن.");
  }
  if (!view.hasCredential) {
    throw new ProviderApiError(400, "اعتبارنامهٔ این پروایدر تنظیم نشده است.");
  }

  const models = deps.modelSvc.enabledModels(id);
  if (models.length === 0) {
    throw new ProviderApiError(400, "این پروایدر مدل فعالی ندارد؛ ابتدا یک مدل اضافه کن.");
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
    throw new ProviderApiError(500, "فعال‌سازی ناموفق بود.");
  }
  return { ok: true, providerId: id, modelId: chosen.id, label: chosen.label };
}

// --------------------------------------------------------------- models ----

function listModels(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown>[] {
  const providerId = asId(params["providerId"]);
  if (providerId === undefined) {
    throw new ProviderApiError(400, "شناسهٔ پروایدر نامعتبر است.");
  }
  if (!deps.storage.getProvider(providerId)) {
    throw new ProviderApiError(404, "پروایدر یافت نشد.");
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
    throw new ProviderApiError(400, "شناسهٔ پروایدر نامعتبر است.");
  }
  const provider = deps.storage.getProvider(providerId);
  if (!provider) {
    throw new ProviderApiError(404, "پروایدر یافت نشد.");
  }
  if (!adapters.describes(provider.adapter).listModels) {
    throw new ProviderApiError(400, "این نوع پروایدر امکان مشاهدهٔ لیست مدل‌ها را ندارد.");
  }

  let apiKey: string | undefined;
  try {
    apiKey = deps.providerSvc.credentialFor(providerId);
  } catch {
    throw new ProviderApiError(400, "اعتبارنامه قابل خواندن نبود.");
  }
  if (apiKey === undefined || apiKey === "") {
    throw new ProviderApiError(400, "اعتبارنامهٔ این پروایدر تنظیم نشده است.");
  }

  // The adapter applies the DNS-level SSRF guard (pinned addresses, no
  // redirects) before any connection is made.
  const adapter = adapters.create(provider.adapter, {
    baseUrl: provider.baseUrl,
    apiKey,
    model: "discover",
  });
  if (!adapter.listModels) {
    throw new ProviderApiError(400, "این پروایدر کشف مدل را پشتیبانی نمی‌کند.");
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
  } catch {
    throw new ProviderApiError(502, "کشف مدل‌ها ناموفق بود؛ اتصال یا آدرس را بررسی کن.");
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

function importModels(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown> {
  const providerId = asId(params["providerId"]);
  if (providerId === undefined) {
    throw new ProviderApiError(400, "شناسهٔ پروایدر نامعتبر است.");
  }
  if (!deps.storage.getProvider(providerId)) {
    throw new ProviderApiError(404, "پروایدر یافت نشد.");
  }
  const raw = params["modelIds"];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MODEL_IDS) {
    throw new ProviderApiError(400, "لیست مدل‌ها نامعتبر است.");
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
  return { imported, skipped };
}

function addModel(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown> {
  const providerId = asId(params["providerId"]);
  if (providerId === undefined) {
    throw new ProviderApiError(400, "شناسهٔ پروایدر نامعتبر است.");
  }
  if (!deps.storage.getProvider(providerId)) {
    throw new ProviderApiError(404, "پروایدر یافت نشد.");
  }
  const modelId = asNonEmptyString(params["modelId"], 128);
  if (modelId === undefined) {
    throw new ProviderApiError(400, "شناسهٔ مدل لازم است.");
  }
  const label = asNonEmptyString(params["label"], 64) ?? modelId;
  const r = deps.modelSvc.add({ providerId, modelId, label });
  if (!r.ok) throw new ProviderApiError(400, r.message);
  return { id: r.data };
}

function toggleModel(
  params: Record<string, unknown>,
  deps: ProviderApiDeps,
): Record<string, unknown> {
  const id = asId(params["id"]);
  if (id === undefined) throw new ProviderApiError(400, "شناسهٔ مدل نامعتبر است.");
  if (typeof params["enabled"] !== "boolean") {
    throw new ProviderApiError(400, "وضعیت نامعتبر است.");
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
  if (id === undefined) throw new ProviderApiError(400, "شناسهٔ مدل نامعتبر است.");
  if (!deps.modelSvc.get(id)) {
    throw new ProviderApiError(404, "مدل یافت نشد.");
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
): Record<string, unknown> {
  const id = asId(params["id"]);
  if (id === undefined) throw new ProviderApiError(400, "شناسهٔ مدل نامعتبر است.");
  const model = deps.modelSvc.get(id);
  if (!model || !model.enabled) {
    throw new ProviderApiError(400, "مدل یافت نشد یا غیرفعال است.");
  }
  const provider = deps.storage.getProvider(model.providerId);
  if (!provider || !provider.enabled) {
    throw new ProviderApiError(400, "پروایدر این مدل غیرفعال است.");
  }
  try {
    deps.storage.setRuntimeSelection({ providerId: model.providerId, modelId: id });
  } catch {
    throw new ProviderApiError(500, "فعال‌سازی ناموفق بود.");
  }
  return { ok: true, providerId: model.providerId, modelId: id, label: model.label };
}
