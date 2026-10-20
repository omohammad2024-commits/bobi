/**
 * Provider health service — a connection test the owner can run from the panel.
 *
 * The probe is deliberately cheap and self-contained: it asks the service for a
 * minimal completion (or, when the adapter supports it, its model list) and
 * records only the outcome. The result message is chosen by this module, never
 * copied from a provider response, so a body that echoes the request cannot
 * leak a key into the database or a Telegram message.
 *
 * The service also hosts the opt-in BACKGROUND prober (startBackgroundProbes):
 * a periodic pass that re-probes providers whose circuit breaker is open or
 * whose last probe failed, and records recovery into the shared breaker
 * registry so a healed provider returns to rotation without waiting for a
 * user turn to discover it.
 */
import {
  AiError,
  emptyResponseError,
  isEmptyResponseError,
} from "./provider";
import type { ChatMessage, ToolSpec } from "./provider";
import type { AIProviderAdapter } from "./adapter";
import type { ProviderSecretStore } from "./secret_store";
import { AdapterRegistry } from "./adapter_registry";
import type { Storage } from "../storage/storage";
import type { ProviderService } from "./provider_service";
import type { CircuitStateReader, CircuitStateView } from "./circuit_breaker";
import {
  connectionManagerEnabled,
  type ConnectionStatsView,
} from "./connection_manager";
import {
  modelQuarantineEnabled,
  sharedModelQuarantine,
} from "./model_quarantine";

export interface ProbeResult {
  ok: boolean;
  /** Short, safe message. Never contains a key or a raw response. */
  message?: string;
  /** unix ms */
  checkedAt: number;
  /**
   * HTTP status of the failure, when the adapter reported one. Additive —
   * absent on success and on configuration failures (no request was sent).
   * Mirrors the stored health record's `status` field.
   */
  status?: number;
  /**
   * Wall-clock ms the probe took, on provider-level probes (probe()).
   * Mirrors the stored health record's `latencyMs` field.
   */
  latencyMs?: number;
  /**
   * The gateway's circuit-breaker snapshot for this provider, when a
   * breaker source was injected (the constructor's trailing optional).
   * The probe never consults the breaker — its whole job is to test the
   * provider directly — this is read-only observability for the panel.
   */
  circuit?: CircuitStateView;
  /**
   * Connection-layer stats for this provider's host, when a connection
   * stats source was injected and the host has pooled-connection history.
   * Additive and sparse — absent entirely when there is nothing to report
   * (same pattern as the memory recall telemetry fields).
   */
  connection?: ConnectionStatsView;
  /**
   * True when the tested model is currently inside its gateway quarantine
   * window (3+ consecutive failures) — the reason the gateway is skipping
   * it. Present on probeModel results (and provider probes, via the
   * default model); sparse — absent when the model is not quarantined.
   */
  quarantined?: boolean;
  /**
   * Stage detail of a two-stage model test (probeModel): stage (a), the
   * cheap ping. Absent on provider-level probes and on pre-check failures
   * (unknown model, missing credential) where no request was sent.
   */
  ping?: ModelProbeStage;
  /**
   * Stage (b) of a two-stage model test: a REALISTIC turn simulation
   * (streaming, full tool-spec payload, real-size system prompt). This is
   * the stage that sees what a Telegram turn sees. Absent when the ping
   * stage already failed — a provider that cannot answer a postcard is
   * not billed for the full simulation.
   */
  real?: ModelProbeStage;
}

/** One stage's outcome inside a two-stage model test. */
export interface ModelProbeStage {
  ok: boolean;
  /** Wall-clock ms this stage took. */
  latencyMs?: number;
  /** First chars of the model's answer (real stage, on success only). */
  textPreview?: string;
  /** Safe message when !ok — chosen by this module, never a raw body. */
  error?: string;
  /** Machine-safe note, e.g. "empty response", "stream". */
  detail?: string;
}

/**
 * Read-only connection-stats source for the `connection` probe field.
 * The connection manager satisfies this structurally.
 */
export interface ConnectionStatsSource {
  statsForUrl(baseUrl: string, allowLocalTargets: boolean): ConnectionStatsView | undefined;
}

/**
 * A breaker the background prober may DRIVE on recovery. The registry from
 * the reliability core satisfies this; the prober never writes a second
 * breaker — on a successful recovery probe it records the success into
 * the shared registry, whose own semantics close/half-open the breaker.
 */
export interface BreakerDriver extends CircuitStateReader {
  recordSuccess(providerId: number): void;
}

/** Env var for the background probe interval, ms. Default 60000; 0 = off. */
export const HEALTH_PROBE_MS_ENV_VAR = "BOBI_HEALTH_PROBE_MS";

/** Background probe interval, ms. 0 disables; invalid → the 60s default. */
export function healthProbeIntervalMs(): number {
  const raw = process.env[HEALTH_PROBE_MS_ENV_VAR];
  if (raw === undefined) return 60_000;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

export interface ProbeOptions {
  /** Override the timeout for this probe only. */
  timeoutMs?: number;
  /**
   * Tool specs for probeModel's realistic stage — the same payload shape
   * the agent loop sends (ToolService.toolSpecsFor). When omitted, the
   * stage derives representative specs from the plugin manifests.
   */
  tools?: readonly ToolSpec[];
  /** System prompt for the realistic stage. Defaults to a representative one. */
  systemPrompt?: string;
  /** Timeout for the realistic stage only. Default: max(default, 30s). */
  realisticTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Output cap of the realistic probe stage. A real agent turn generates
 * hundreds of tokens; 16 (the ping cap) cannot reproduce gateways that
 * give up — or return reasoning only — on real-size generations.
 */
const REALISTIC_PROBE_MAX_TOKENS = 300;

/** Floor for the realistic stage's timeout: real generations are slow. */
const REALISTIC_PROBE_TIMEOUT_MS = 30_000;

/** Preview length for the realistic stage's answer snippet. */
const REALISTIC_PREVIEW_CHARS = 120;

/**
 * A representative system prompt for the realistic probe stage.
 *
 * NOT the engine's real prompt (that is assembled per user from private
 * memory and never leaves the turn) — a fixed stand-in at the same scale:
 * identity, tone rules, a tool-catalog summary, memory etiquette, safety.
 * What matters for the gateways this stage exists to catch is the SHAPE
 * of a real request: a multi-thousand-token prompt, not "ping". Contains
 * no user data by construction.
 */
export const REALISTIC_PROBE_SYSTEM_PROMPT = [
  "You are BOBI, a personal AI agent living inside Telegram. You were created by Mohammad, your owner, and you serve him and the people he allows. Answer in the language the user writes in (Persian in, Persian out; English in, English out).",
  "",
  "PERSONALITY: playful, confident, cheeky, deadpan. Default to 1-3 short lines; write long-form only when explicitly asked, and wrap it in a markdown blockquote. Mirror the user's message length: a one-word hello gets a one-line answer, never an essay. No filler, no corporate politeness, no emoji spam.",
  "",
  "TOOLS: you act through tools, you never merely describe acting. When the user sends a media link, use the downloader. When they ask to remember something, use the memory tools; when they ask what you remember, recall before answering. Reminders, scheduled tasks, goals, unit conversion, calculation, date/time (including the Jalali calendar), image and video generation, model consultation, session history and usage reporting are all tools — pick the one whose description matches the intent, extract its arguments from the message, and call it. A denied or failed tool is reported back to you as data; adjust and continue, never invent a result.",
  "",
  "MEMORY: durable facts about the owner (names, preferences, projects, people) are worth remembering; transient chatter is not. When stored facts contradict a newer statement, the newer statement wins and the old fact is superseded. Never reveal one user's memories to another user; every conversation is isolated.",
  "",
  "SAFETY: owner-only capabilities (providers, keys, admin, user management) are invisible to the public and refused politely when requested by anyone else. Never print API keys, tokens or credentials. Media you download is delivered to the user, not described.",
  "",
  "GROUPS: in group chats you answer when addressed by name, by mention, or by a reply to your message. You may summarise the group conversation and run polls when the group assistant is enabled.",
  "",
  "If a request is ambiguous, make the reasonable choice and proceed; ask only when the wrong guess would waste real work. When you cannot do something, say so plainly in one line and offer the closest thing you can do.",
].join("\n");

/** The realistic stage's user turn: a small, ordinary owner-style ask. */
const REALISTIC_PROBE_USER_MESSAGE =
  "سلام! ساعت تهران الان چنده؟ یه جمله کوتاه جواب بده.";

export class ProviderHealthService {
  constructor(
    private readonly storage: Storage,
    private readonly providers: ProviderService,
    private readonly secrets: ProviderSecretStore,
    private readonly adapters: AdapterRegistry = new AdapterRegistry(),
    /** Overridable for tests that must not wait on a real deadline. */
    private readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS,
    /**
     * Optional breaker-state reader (the gateway's shared registry).
     * Populates `circuit` on results for panel observability. Trailing
     * optional, so existing constructions keep working unchanged.
     */
    private readonly circuitSource?: CircuitStateReader,
    /**
     * Optional connection-stats source (the connection manager).
     * Populates `connection` on results when the provider's host has
     * pooled-connection history. Trailing optional, like circuitSource.
     */
    private readonly connections?: ConnectionStatsSource,
  ) {}

  /** Latest recorded outcome for a provider. */
  last(providerId: number): ProbeResult | undefined {
    const h = this.storage.getProviderHealth(providerId);
    if (!h) return undefined;
    return {
      ok: h.ok,
      checkedAt: h.checkedAt,
      ...(h.message !== undefined ? { message: h.message } : {}),
      ...(h.status !== undefined ? { status: h.status } : {}),
      ...(h.latencyMs !== undefined ? { latencyMs: h.latencyMs } : {}),
      ...this.circuitField(providerId),
      ...this.connectionField(providerId),
      ...this.quarantineField(providerId, this.defaultModelId(providerId)),
    };
  }

  /** The breaker snapshot spread, when a source was injected. */
  private circuitField(providerId: number): { circuit?: CircuitStateView } {
    if (this.circuitSource === undefined) return {};
    try {
      return { circuit: this.circuitSource.state(providerId) };
    } catch {
      return {};
    }
  }

  /** The connection-stats spread, when a source was injected and has data. */
  private connectionField(providerId: number): { connection?: ConnectionStatsView } {
    if (this.connections === undefined) return {};
    try {
      const provider = this.storage.getProvider(providerId);
      if (provider === undefined) return {};
      const view = this.connections.statsForUrl(provider.baseUrl, provider.allowLocal);
      return view !== undefined ? { connection: view } : {};
    } catch {
      return {};
    }
  }

  /**
   * Probe a provider and record the result.
   *
   * A missing credential is a configuration failure, reported as such; it is
   * never worked around by sending an unauthenticated request.
   */
  async probe(providerId: number, opts: ProbeOptions = {}): Promise<ProbeResult> {
    const provider = this.storage.getProvider(providerId);
    if (!provider) {
      return this.record(providerId, false, "Provider not found.");
    }
    if (!provider.enabled) {
      return this.record(providerId, false, "Provider is disabled.");
    }

    let apiKey: string | undefined;
    try {
      apiKey = this.providers.credentialFor(providerId);
    } catch {
      return this.record(providerId, false, "Credential could not be decrypted.");
    }

    if (apiKey === undefined || apiKey.length === 0) {
      return this.record(providerId, false, "Credential is not set.");
    }

    // No model, no probe: sending a completion against an invented model
    // id ("default") makes strict services 404/400 it, and the recorded
    // health then blames the service for what is a configuration gap.
    const modelId = this.defaultModelId(providerId);
    if (modelId === undefined) {
      return this.record(
        providerId,
        false,
        "No model configured — discover or add a model first, then test.",
      );
    }

    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    // The adapter owns the request timeout: it aborts at its own deadline and
    // reports AiError("timeout"). A second, racing timer here would abort the
    // caller signal first, and the adapter would then report "aborted" instead
    // of a timeout — hiding a slow service behind a wrong diagnosis. So the
    // health service supplies a signal it never fires.
    const neverAborted = new AbortController().signal;
    const started = Date.now();

    try {
      const adapter = this.adapters.create(provider.adapter, {
        baseUrl: provider.baseUrl,
        apiKey,
        // The probe needs a model id that exists: the provider's default.
        model: modelId,
        // The owner may have granted this provider the local-target exception;
        // the probe must honor the same boundary as the runtime, or a local
        // provider would always report "unreachable" right after being allowed.
        ...(provider.allowLocal ? { allowLocalTargets: true } : {}),
      });

      // Always verify with a real completion on the provider's default model.
      // listModels only checks API reachability — a provider can list models
      // fine while the specific model is rate-limited, disabled, or broken.
      // The completion test catches those cases.
      await adapter.complete({
        messages: [{ role: "user", content: "ping" }],
        model: modelId,
        // A probe only needs ANY answer back; capping generation keeps it
        // fast (and cheap) instead of waiting for a full-length reply.
        maxTokens: 16,
        timeoutMs,
        signal: neverAborted,
      });

      return this.record(providerId, true, "Connection succeeded.", {
        latencyMs: Date.now() - started,
      });
    } catch (err) {
      return this.record(providerId, false, probeMessage(err), {
        latencyMs: Date.now() - started,
        ...(err instanceof AiError && err.status !== undefined
          ? { status: err.status }
          : {}),
      });
    }
  }

  /**
   * Probe ONE specific model, without recording provider health. Used by
   * the per-model "Test" button in the panel.
   *
   * A model test is deliberately NOT provider health: it never touches
   * storage.setProviderHealth, so testing an individual model cannot
   * overwrite the provider-level outcome. A flaky model gets reported
   * inline; the provider row keeps its own status.
   *
   * TWO STAGES (the honest probe):
   *   (a) ping — the historical cheap check: one 16-token non-streaming
   *       completion. Free gateways answer this even when they cannot
   *       serve a real turn, which is exactly how a green ⚡Test used to
   *       coexist with a dead chat.
   *   (b) real — a realistic turn simulation: streaming ON, the full
   *       tool-spec payload the loop sends, a real-size system prompt,
   *       maxTokens 300. It detects empty streams, empty content, and
   *       quota/auth failures that only appear on real-size requests.
   * Stage (b) runs only when (a) passed. The top-level ok is the AND of
   * both stages; the message names the failing stage's cause.
   */
  async probeModel(
    providerId: number,
    modelId: string,
    opts: ProbeOptions = {},
  ): Promise<ProbeResult> {
    const provider = this.storage.getProvider(providerId);
    if (!provider) {
      return this.result(providerId, false, "Provider not found.");
    }
    if (!provider.enabled) {
      return this.result(providerId, false, "Provider is disabled.");
    }
    if (
      this.storage.listModels(providerId).every((m) => m.modelId !== modelId)
    ) {
      return this.result(providerId, false, "Model not found for this provider.", modelId);
    }

    let apiKey: string | undefined;
    try {
      apiKey = this.providers.credentialFor(providerId);
    } catch {
      return this.result(providerId, false, "Credential could not be decrypted.", modelId);
    }

    if (apiKey === undefined || apiKey.length === 0) {
      return this.result(providerId, false, "Credential is not set.", modelId);
    }

    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    // Same reasoning as probe(): the health service supplies a signal it
    // never fires, so the adapter reports its own timeout diagnosis.
    const neverAborted = new AbortController().signal;

    const adapter = this.adapters.create(provider.adapter, {
      baseUrl: provider.baseUrl,
      apiKey,
      model: modelId,
      ...(provider.allowLocal ? { allowLocalTargets: true } : {}),
    });

    // ---- stage (a): the ping -------------------------------------------
    const pingStarted = Date.now();
    let ping: ModelProbeStage;
    try {
      await adapter.complete({
        messages: [{ role: "user", content: "ping" }],
        model: modelId,
        // Same cap as probe(): the test needs any answer, fast.
        maxTokens: 16,
        timeoutMs,
        signal: neverAborted,
      });
      ping = { ok: true, latencyMs: Date.now() - pingStarted };
    } catch (err) {
      ping = {
        ok: false,
        latencyMs: Date.now() - pingStarted,
        error: probeMessage(err),
        ...(isEmptyResponseError(err) ? { detail: "empty response" } : {}),
      };
      return this.result(providerId, false, probeMessage(err), modelId, { ping });
    }

    // ---- stage (b): the realistic turn ----------------------------------
    const real = await this.probeRealistic(adapter, modelId, opts, neverAborted);
    if (!real.ok) {
      // The stage error already names the cause safely (mapped, or the
      // fixed empty-response template) — surface it as the test's message
      // so the panel shows WHY the real turn would fail, not just that.
      return this.result(
        providerId,
        false,
        real.error ?? "Realistic check failed.",
        modelId,
        { ping, real },
      );
    }
    return this.result(providerId, true, "Connection succeeded.", modelId, { ping, real });
  }

  /**
   * Stage (b) of probeModel: one realistic turn against the model.
   *
   * The request mirrors what the agent loop actually sends — a system
   * prompt at real scale, one user turn, the full tool-spec payload,
   * streaming, and a real generation budget — because the failures this
   * stage exists to catch (empty streams, empty content, size-triggered
   * quota/auth rejections) are invisible to the 16-token ping.
   */
  private async probeRealistic(
    adapter: AIProviderAdapter,
    modelId: string,
    opts: ProbeOptions,
    signal: AbortSignal,
  ): Promise<ModelProbeStage> {
    const timeoutMs =
      opts.realisticTimeoutMs ?? Math.max(this.defaultTimeoutMs, REALISTIC_PROBE_TIMEOUT_MS);
    const tools = opts.tools ?? (await defaultRealisticToolSpecs());
    const messages: ChatMessage[] = [
      { role: "system", content: opts.systemPrompt ?? REALISTIC_PROBE_SYSTEM_PROMPT },
      { role: "user", content: REALISTIC_PROBE_USER_MESSAGE },
    ];
    const req = {
      messages,
      model: modelId,
      maxTokens: REALISTIC_PROBE_MAX_TOKENS,
      timeoutMs,
      signal,
      ...(tools.length > 0 ? { tools } : {}),
    };
    const started = Date.now();
    const fail = (err: unknown, detail: string): ModelProbeStage => ({
      ok: false,
      latencyMs: Date.now() - started,
      // The empty-response message is a fixed template with machine-safe
      // detail only (finish reason, reasoning flags) — safe to surface
      // verbatim; everything else goes through the mapped messages.
      error: isEmptyResponseError(err) ? err.message : probeMessage(err),
      detail: isEmptyResponseError(err) ? "empty response" : detail,
    });

    if (typeof adapter.completeStream === "function") {
      let text = "";
      let toolCalls = 0;
      try {
        for await (const ev of adapter.completeStream(req)) {
          if (ev.type === "text") text += ev.delta;
          if (ev.type === "end") {
            text = ev.text;
            toolCalls = ev.toolCalls.length;
          }
        }
      } catch (err) {
        return fail(err, "stream");
      }
      if (text.trim().length === 0 && toolCalls === 0) {
        // Defensive: adapters raise this themselves now, but a custom
        // adapter that still returns an empty end must not read as green.
        return fail(emptyResponseError("stream"), "empty response");
      }
      return {
        ok: true,
        latencyMs: Date.now() - started,
        ...(text.trim().length > 0
          ? { textPreview: text.slice(0, REALISTIC_PREVIEW_CHARS) }
          : {}),
        detail: "stream",
      };
    }

    try {
      const res = await adapter.complete(req);
      if (res.text.trim().length === 0 && (res.toolCalls ?? []).length === 0) {
        return fail(emptyResponseError(), "empty response");
      }
      return {
        ok: true,
        latencyMs: Date.now() - started,
        ...(res.text.trim().length > 0
          ? { textPreview: res.text.slice(0, REALISTIC_PREVIEW_CHARS) }
          : {}),
      };
    } catch (err) {
      return fail(err, "complete");
    }
  }

  /* ---------------- background health + auto-recovery ---------------- */

  private probeTimer: ReturnType<typeof setInterval> | undefined;
  private probePassInFlight = false;

  /** True while the background prober is scheduled. */
  backgroundProbesRunning(): boolean {
    return this.probeTimer !== undefined;
  }

  /**
   * Start the periodic background prober.
   *
   * Every BOBI_HEALTH_PROBE_MS (default 60000; 0 = off) one pass probes the
   * configured providers that need attention — breaker OPEN (or half-open)
   * or last recorded probe failed — using the same cheap probe() the panel
   * runs. A pass never overlaps itself: a slow provider cannot stack
   * passes up. Recovery is driven through the SHARED breaker registry
   * passed as `driver`: a successful probe of an open/half-open provider
   * records a success there, and the registry's own semantics close the
   * breaker. A failed probe records nothing into the breaker — probe
   * failures include configuration faults (auth, missing credential) that
   * must never trip it; the gateway's real traffic keeps it honest.
   *
   * Opt-in by construction: nothing runs until start is called. Also a
   * no-op when the connection manager is disabled (BOBI_CONN_MANAGER=0)
   * or the interval is 0. The timer is unref'd.
   */
  startBackgroundProbes(driver?: BreakerDriver, opts: { intervalMs?: number } = {}): void {
    if (this.probeTimer !== undefined) return;
    if (!connectionManagerEnabled()) return;
    const intervalMs = opts.intervalMs ?? healthProbeIntervalMs();
    if (intervalMs <= 0) return;
    this.probeTimer = setInterval(() => {
      void this.runBackgroundProbePass(driver);
    }, intervalMs);
    // Probing must never keep a process (or a test run) alive.
    this.probeTimer.unref?.();
  }

  /** Stop the background prober. An in-flight pass finishes on its own. */
  stopBackgroundProbes(): void {
    if (this.probeTimer !== undefined) {
      clearInterval(this.probeTimer);
      this.probeTimer = undefined;
    }
  }

  /**
   * One background probe pass. Public so tests (and a future manual
   * "recheck now" surface) can drive it without waiting on the timer.
   * Returns how many providers were probed.
   */
  async runBackgroundProbePass(driver?: BreakerDriver): Promise<number> {
    if (this.probePassInFlight) return 0;
    this.probePassInFlight = true;
    let probed = 0;
    try {
      for (const provider of this.storage.listProviders()) {
        if (!provider.enabled) continue;
        const breakerState =
          driver?.state(provider.id).state ?? this.circuitSource?.state(provider.id).state;
        const breakerNeedsRecovery = breakerState === "open" || breakerState === "half_open";
        const lastFailed = this.storage.getProviderHealth(provider.id)?.ok === false;
        if (!breakerNeedsRecovery && !lastFailed) continue;
        const res = await this.probe(provider.id);
        probed += 1;
        if (res.ok && breakerNeedsRecovery && driver !== undefined) {
          // Recovery, recorded into the shared registry — its semantics
          // close the breaker; no second breaker exists to disagree.
          driver.recordSuccess(provider.id);
        }
      }
    } catch {
      // A background pass must never throw into the timer or the caller:
      // individual probe failures are already recorded as health rows.
    } finally {
      this.probePassInFlight = false;
    }
    return probed;
  }

  /** The provider's default model id, when one is set and enabled. */
  private defaultModelId(providerId: number): string | undefined {
    const models = this.storage.listModels(providerId);
    return (models.find((m) => m.isDefault && m.enabled) ?? models.find((m) => m.enabled))?.modelId;
  }

  private record(
    providerId: number,
    ok: boolean,
    message: string,
    extra: { status?: number; latencyMs?: number } = {},
  ): ProbeResult {
    const checkedAt = Date.now();
    this.storage.setProviderHealth({ providerId, ok, message, ...extra });
    return {
      ok,
      message,
      checkedAt,
      ...(extra.status !== undefined ? { status: extra.status } : {}),
      ...(extra.latencyMs !== undefined ? { latencyMs: extra.latencyMs } : {}),
      ...this.circuitField(providerId),
      ...this.connectionField(providerId),
      ...this.quarantineField(providerId, this.defaultModelId(providerId)),
    };
  }

  /**
   * A probe outcome that is reported only to the caller. Unlike record(),
   * this deliberately skips setProviderHealth — per-model tests must not
   * overwrite the provider-level health row.
   */
  private result(
    providerId: number,
    ok: boolean,
    message: string,
    modelId?: string,
    stages?: { ping?: ModelProbeStage; real?: ModelProbeStage },
  ): ProbeResult {
    return {
      ok,
      message,
      checkedAt: Date.now(),
      ...this.circuitField(providerId),
      ...this.connectionField(providerId),
      ...this.quarantineField(providerId, modelId),
      ...(stages?.ping !== undefined ? { ping: stages.ping } : {}),
      ...(stages?.real !== undefined ? { real: stages.real } : {}),
    };
  }

  /**
   * The sparse `quarantined: true` spread, read from the SHARED registry
   * the gateway writes — sparse so a healthy model carries no field at
   * all (same pattern as the circuit/connection fields).
   */
  private quarantineField(
    providerId: number,
    modelId: string | undefined,
  ): { quarantined?: boolean } {
    if (modelId === undefined || !modelQuarantineEnabled()) return {};
    try {
      return sharedModelQuarantine.isQuarantined(providerId, modelId)
        ? { quarantined: true }
        : {};
    } catch {
      return {};
    }
  }
}

/**
 * Representative tool specs for the realistic probe stage, derived from
 * the plugin manifests (name = the tool's registered id, description =
 * its catalog line). This mirrors the payload SHAPE the loop sends via
 * ToolService.toolSpecsFor — one entry per tool, real descriptions —
 * without importing the tool service into the AI layer at module scope:
 * the barrel is loaded lazily, at probe time, when the module graph is
 * fully evaluated. Any failure falls back to an empty list (the stage
 * still exercises streaming + prompt size, just without tools).
 */
async function defaultRealisticToolSpecs(): Promise<readonly ToolSpec[]> {
  try {
    const { getPluginManifests } = await import("../tools/plugins");
    return getPluginManifests().map((m) => ({
      name: m.id,
      description: m.description,
      parameters: { type: "object", properties: {}, additionalProperties: true },
    }));
  } catch {
    return [];
  }
}

/**
 * Map an adapter failure onto a short, safe English message.
 *
 * Messages are chosen here, never copied from a provider response. One
 * narrow exception, by design: an "unknown" AiError that carries an HTTP
 * status surfaces its own message, because that status could only have
 * been attached by the status mapper, whose templates are fixed strings
 * naming the real cause (e.g. "Unexpected provider response (HTTP 302).").
 * An unknown with no status has no such provenance and stays opaque:
 * "Probe failed."
 */
function probeMessage(err: unknown): string {
  if (err instanceof AiError) {
    if (
      err.kind === "unknown" &&
      err.status !== undefined &&
      err.message.trim().length > 0
    ) {
      return err.message;
    }
    let base: string;
    switch (err.kind) {
      case "auth":
        base = "Key or address was not accepted.";
        break;
      case "quota":
        // 402 is balance exhaustion, not a rate limit — say so (a fixed
        // string keyed by the status number; the error's own message is
        // NOT surfaced for this kind).
        base =
          err.status === 402
            ? "Provider balance or quota is exhausted (HTTP 402)."
            : "Service rate limit is full.";
        break;
      case "timeout":
        base = "No response arrived in time.";
        break;
      case "aborted":
        base = "Probe was cancelled.";
        break;
      case "network":
        base = "Could not connect.";
        break;
      case "invalid_response":
        base = "Service response was invalid.";
        break;
      default:
        base = "Probe failed.";
        break;
    }
    // Preserve the HTTP status whenever the error carries one, phrased the
    // way http_status.ts phrases it: a bare "Could not connect." cannot
    // tell a 500 from a 503, and a bare "invalid" cannot tell a 404 (wrong
    // address) from a 400 (bad request) — the number IS the diagnosis.
    if (err.status !== undefined && !base.includes(`(HTTP ${err.status})`)) {
      base = `${base.replace(/\.$/, "")} (HTTP ${err.status}).`;
    }
    return base;
  }
  return "Probe failed.";
}
