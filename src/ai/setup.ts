/**
 * One-step provider setup.
 *
 * Adding a provider used to take five screens and two hand-typed forms: pick a
 * service, type a URL, type a key, then separately add a model, then activate
 * it. Every step was a place to mis-type something, and a mistake in the first
 * form discarded the whole attempt.
 *
 * This module collapses it to one message. Everything the owner is not
 * genuinely the authority on — the endpoint, the adapter type, a starting
 * model — comes from the preset; the only thing they must supply is the key.
 *
 * WHY IT IS A SERVICE RATHER THAN MORE CONTROLLER CODE:
 *
 * The steps are a transaction in spirit: a half-configured provider (created,
 * no model, not active) is worse than none, because it looks configured while
 * refusing every request. The rollback logic that keeps that from happening
 * belongs next to the storage calls, where it can be tested without Telegram,
 * not buried in a callback handler.
 */
import type { Storage } from "../storage/storage";
import { providerPreset } from "./adapter";
import type { ProviderPreset } from "./adapter";
import type { ModelService, ProviderService } from "./provider_service";
import type { ProviderSecretStore } from "./secret_store";

export interface SetupResult {
  ok: boolean;
  /** Short, user-safe message describing what happened. */
  message: string;
  providerId?: number;
  modelId?: number;
  /** The model that was activated, for the confirmation text. */
  activatedModel?: string;
  /** Steps that succeeded but are worth mentioning. */
  notes: string[];
}

export interface SetupDeps {
  storage: Storage;
  providers: ProviderService;
  models: ModelService;
  /** Encrypts the key; the same vault every provider credential uses. */
  secrets: ProviderSecretStore;
}

/**
 * Create a provider from a preset, add its suggested model, and activate it.
 *
 * The key is the only required input. An empty key is allowed when the preset
 * does not need one (a local endpoint), which is why it is not rejected
 * outright.
 */
export function setupFromPreset(
  deps: SetupDeps,
  presetId: string,
  apiKey: string,
  baseUrlOverride?: string,
): SetupResult {
  const preset = providerPreset(presetId);
  if (preset === undefined) {
    return { ok: false, message: "Unknown service.", notes: [] };
  }

  const baseUrl = (baseUrlOverride ?? "").trim() || preset.baseUrl;

  // A URL still carrying its placeholder would be saved verbatim and fail at
  // request time with a confusing error, so it is refused here with a clear one.
  if (preset.requiredPlaceholder !== undefined && baseUrl.includes(`{${preset.requiredPlaceholder}}`)) {
    return {
      ok: false,
      message: `The address still contains {${preset.requiredPlaceholder}}; replace it with the real value.`,
      notes: [],
    };
  }

  const notes: string[] = [];

  // 1. The provider itself. `create` fails as a whole if the key cannot be
  //    encrypted, so a provider is never created without its credential.
  const created = deps.providers.create({
    label: preset.label,
    adapter: "openai_compatible",
    baseUrl,
    apiKey: apiKey.trim(),
  });
  if (!created.ok) {
    return { ok: false, message: created.message, notes };
  }
  const providerId = created.data;

  // 2. A starting model. Without one the provider can be enabled but cannot
  //    answer, which reads as broken.
  if (preset.suggestedModel === undefined) {
    notes.push("This service has no suggested model; add one from the models menu.");
    return {
      ok: true,
      message: `Provider "${preset.label}" was created.`,
      providerId,
      notes,
    };
  }

  const added = deps.models.add({
    providerId,
    modelId: preset.suggestedModel,
    label: preset.suggestedModel,
  });
  if (!added.ok) {
    // The provider exists; only the model failed. Say so rather than rolling
    // back, because the owner can add a model by hand and the provider is fine.
    notes.push(`Suggested model was not added: ${added.message}`);
    return { ok: true, message: `Provider "${preset.label}" was created.`, providerId, notes };
  }
  const modelId = added.data;

  // 3. Activate the pair together, so the runtime is never half-set.
  try {
    deps.storage.setRuntimeSelection({ providerId, modelId });
  } catch {
    notes.push("Auto-activation did not happen; activate it from the provider & model picker.");
    return {
      ok: true,
      message: `Provider "${preset.label}" was created.`,
      providerId,
      modelId,
      notes,
    };
  }

  return {
    ok: true,
    message: `"${preset.label}" was created, activated, and is ready to use.`,
    providerId,
    modelId,
    activatedModel: preset.suggestedModel,
    notes,
  };
}

/**
 * The prompt shown when the owner picks a preset: one line, the key.
 *
 * English-only (the UI is English-only as of v1.0). The `lang` parameter is
 * retained so existing callers keep compiling; it no longer changes the output.
 */
export function setupPrompt(preset: ProviderPreset, lang: "fa" | "en" = "en"): string {
  void lang;
  const lines = [
    `Adding ${preset.label}`,
    "",
    "Send the API key in your next message. That's it.",
  ];

  if (preset.suggestedModel !== undefined) {
    lines.push(
      "",
      `Model ${preset.suggestedModel} will be added and activated automatically.`,
    );
  }
  if (preset.requiredPlaceholder !== undefined) {
    lines.push(
      "",
      `⚠️ This service also needs ${preset.requiredPlaceholder}.`,
      `Send key and value separated by a comma:  key, ${preset.requiredPlaceholder}`,
    );
  }

  lines.push(
    "",
    `Note: ${preset.note}`,
    "",
    "To cancel, use the Cancel button below.",
  );
  return lines.join("\n");
}

/**
 * Split a one-line submission into a key and an optional placeholder value.
 *
 * Accepts `key`, or `key, VALUE` when the service needs something else (an
 * account id). The order is fixed and documented in the prompt, so there is
 * nothing to label and nothing to mis-type.
 */
export function parseSetupReply(
  text: string,
  needsPlaceholder: boolean,
): { apiKey: string; extra?: string } | undefined {
  const parts = text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (parts.length === 0) return undefined;

  if (!needsPlaceholder) {
    // A key may contain commas, so only the first line is taken and the rest
    // joined back — splitting a key would silently truncate it.
    const single = text.trim();
    return single.length > 0 ? { apiKey: single } : undefined;
  }

  if (parts.length < 2) return undefined;
  return { apiKey: parts[0]!, extra: parts[1]! };
}
