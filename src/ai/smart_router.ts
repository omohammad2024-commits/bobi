/**
 * Smart routing — pick the cheapest/fastest provider+model pair that can
 * serve a given request, instead of always using the owner's single active
 * selection.
 *
 * WHY: owners may connect several providers (a fast cheap one for everyday
 * chat, a powerful expensive one for hard work). Without routing, every
 * request lands on one pair, which wastes money on "hi" and underpowers
 * deep analysis. The router classifies the request into a task tier, scores
 * each eligible provider/model candidate, and picks the cheapest candidate
 * that satisfies the tier.
 *
 * RULES:
 * - Never picks a disabled provider/model or one without a credential.
 * - A hard capability gate (tools, vision, documents) filters candidates
 *   BEFORE cost is considered: cheap is irrelevant when it cannot answer.
 * - Deterministic: equal scores first prefer the owner's active selection
 *   (passed as a hint), then tie-break on (providerId, modelId).
 * - Kill switch: BOBI_SMART_ROUTING=0 ("false"/"no"/"off" too) disables
 *   routing entirely; the gateway then keeps its existing behavior.
 * - Breaker-aware: when the gateway injects its circuit-breaker registry,
 *   a provider whose breaker is open is never picked, and a half-open one
 *   is heavily penalized (it may serve one probe, not the main traffic).
 * - Health-aware: a provider whose latest probe failed within
 *   PROVIDER_DEAD_FRESH_MS is hard-excluded while any alternative exists;
 *   an older failure (up to 24 h) costs STALE_FAILURE_PENALTY points, and
 *   a recent success earns a bonus minus a term from the probe's measured
 *   latencyMs. A (provider, model) pair in the model quarantine is
 *   likewise excluded while any non-quarantined candidate exists.
 * - The router never touches credentials or the network: it reads storage
 *   rows and the registry's static capability descriptions only.
 */
import type { Storage } from "../storage/storage";
import type {
  AiModelRow,
  AiProviderHealthRow,
  AiProviderRow,
} from "../storage/storage";
import type { AdapterRegistry } from "./adapter_registry";
import type { ChatMessage, CompletionRequest, ToolSpec } from "./provider";
import type { CircuitStateReader, CircuitStateView } from "./circuit_breaker";
import { modelSupportsTools } from "./model_capabilities";

/** Env var that disables smart routing. Default: routing is ON. */
export const SMART_ROUTING_ENV_VAR = "BOBI_SMART_ROUTING";

/**
 * Whether smart routing is enabled.
 *
 * `BOBI_SMART_ROUTING=0` (also "false", "no", "off", case-insensitive) turns
 * it off; anything else — including unset — leaves it on. Same convention
 * as BOBI_STREAMING and BOBI_SEMANTIC_MEMORY.
 */
export function smartRoutingEnabled(): boolean {
  const raw = process.env[SMART_ROUTING_ENV_VAR];
  if (raw === undefined) return true;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

/** Task complexity tiers, in ascending order of demand. */
export type TaskTier = "trivial" | "simple" | "standard" | "complex" | "heavy";

/** Optional hints for one route() call. */
export interface RouteHints {
  /**
   * The owner's active provider/model pair. Used ONLY as a tie-break: when
   * two candidates score equally, the owner's explicit choice wins over the
   * raw providerId ordering. It never overrides a score difference, so the
   * router still deviates when it has a real reason (cheaper / stronger).
   */
  prefer?: { providerId: number; modelId: string };
}

/** A model the owner configured, paired with its provider row. */
export interface RouteCandidate {
  provider: AiProviderRow;
  model: AiModelRow;
}

/** The router's decision for one request. Never includes key material. */
export interface RouteDecision {
  providerId: number;
  providerLabel: string;
  /** The service's model id, as the adapter expects it. */
  modelId: string;
  modelLabel: string;
  tier: TaskTier;
  /** Short human-readable rationale, safe for logs. */
  reason: string;
}

/** Call-scoped gate state, precomputed once per route() call. */
interface RouteGates {
  /** One route() instant, shared by every age computation in the call. */
  now: number;
  /** True when at least one candidate is NOT fresh-failed. */
  freshGateActive: boolean;
  /** True when at least one candidate is NOT quarantined. */
  quarantineGateActive: boolean;
}

/** Cost hints, in abstract "cost units" (lower is cheaper). */
export interface CostHintTable {
  /** Exact model id (case-insensitive) → cost. Highest precedence. */
  exact: Record<string, number>;
  /** Model-id substring (case-insensitive) → cost. First match wins. */
  patterns: Array<{ match: string; cost: number }>;
}

/**
 * A breaker whose provider is serving a half-open probe should be
 * selectable — but never preferred. In score points.
 */
const CIRCUIT_HALF_OPEN_PENALTY = 500;

/**
 * Freshness window for a failed probe to HARD-exclude its provider, ms.
 * Mirrors gateway.ts PROVIDER_HEALTH_FRESH_MS (the same ten minutes) —
 * the value is duplicated here rather than imported, because gateway.ts
 * imports this module and an import back would be a cycle.
 */
export const PROVIDER_DEAD_FRESH_MS = 600_000;

/** Probe rows older than this (24 h) carry no health signal at all. */
const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Penalty for a provider whose latest probe failed 10 min–24 h ago.
 * Must exceed the maximum cost spread (costliest hint 90 × 10 = 900
 * points), so a known-failed provider can never win on price alone.
 */
const STALE_FAILURE_PENALTY = 950;

/** Bonus for a provider whose latest probe succeeded within 24 h. */
const HEALTH_SUCCESS_BONUS = 15;

/** Latency term cap, ms: probes slower than this all cost the same. */
const LATENCY_CAP_MS = 2000;

/** Latency term divisor: one score point per this many ms of latency. */
const LATENCY_MS_PER_POINT = 10;

/** Optional tuning for SmartRouter; everything has sane defaults. */
export interface SmartRouterOptions {
  /**
   * Owner cost overrides. Merged over the defaults: exact matches replace
   * the default exact table entries, patterns are appended (and therefore
   * win over default patterns on first-match ordering).
   */
  costHints?: Partial<CostHintTable>;
  /**
   * Breaker state source (the gateway passes its registry). Providers whose
   * breaker is open are hard-excluded from routing; half-open providers are
   * selectable but heavily penalized. Absent = no breaker awareness.
   */
  circuit?: CircuitStateReader;
  /**
   * Model-quarantine state source (the gateway passes its registry; the
   * structural shape is all the router needs, so ModelQuarantineRegistry
   * satisfies it without an import). A quarantined (provider, model) pair
   * is hard-excluded from routing while any non-quarantined candidate
   * exists. Absent = no quarantine awareness.
   */
  quarantine?: { isQuarantined(providerId: number, modelId: string): boolean };
}

/** What a request needs from a candidate, derived from its content. */
export interface RequestNeeds {
  tier: TaskTier;
  /** The request offers tools the model is expected to call. */
  needsTools: boolean;
  /** The request carries images (vision). */
  needsVision: boolean;
  /** The request carries documents (needs native document handling). */
  needsDocuments: boolean;
}

/** Capability rank of a model id, 0 (light) .. 2 (strong). */
export function modelCapabilityRank(modelId: string): number {
  const id = modelId.toLowerCase();
  if (STRONG_MODEL_RE.test(id)) return 2;
  if (LIGHT_MODEL_RE.test(id)) return 1;
  return 1; // unknown ids are treated as middle-weight, never excluded.
}

/** Minimum capability rank a tier demands. */
export function tierMinimumRank(tier: TaskTier): number {
  switch (tier) {
    case "trivial":
      return 0;
    case "simple":
      return 0;
    case "standard":
      return 1;
    case "complex":
      return 2;
    case "heavy":
      return 2;
  }
}

const STRONG_MODEL_RE =
  /opus|ultra|max|pro|large|xl|70b|405b|8x|reasoning|thinking|deepseek-r1|gpt-5|o1|o3|claude-4/;
const LIGHT_MODEL_RE =
  /nano|mini|lite|flash|haiku|8b|7b|small|turbo|free|fast|instruct$/;

/** The built-in cost table. Units are arbitrary; only ordering matters. */
const DEFAULT_COST_HINTS: CostHintTable = {
  exact: {},
  patterns: [
    // Free / explicitly cheap first.
    { match: "free", cost: 0 },
    { match: "nano", cost: 5 },
    { match: "haiku", cost: 8 },
    { match: "mini", cost: 10 },
    { match: "flash", cost: 10 },
    { match: "lite", cost: 12 },
    { match: "8b", cost: 12 },
    { match: "7b", cost: 12 },
    { match: "turbo", cost: 20 },
    // Middle of the road.
    { match: "sonnet", cost: 40 },
    { match: "gpt-4o-mini", cost: 30 },
    // Expensive.
    { match: "opus", cost: 90 },
    { match: "ultra", cost: 90 },
    { match: "max", cost: 80 },
    { match: "pro", cost: 70 },
    { match: "large", cost: 70 },
    { match: "70b", cost: 60 },
    { match: "gpt-5", cost: 80 },
    { match: "reasoning", cost: 70 },
    { match: "thinking", cost: 70 },
  ],
};

const DEFAULT_COST = 50;

/** Cost for one model id: exact overrides, then first pattern match. */
export function costHint(modelId: string, table: CostHintTable = DEFAULT_COST_HINTS): number {
  const id = modelId.toLowerCase();
  const exact = table.exact[id];
  if (exact !== undefined) return exact;
  for (const p of table.patterns) {
    if (id.includes(p.match.toLowerCase())) return p.cost;
  }
  return DEFAULT_COST;
}

const STEP_INDICATORS: RegExp[] = [
  /step[- ]by[- ]step/i,
  /\bfirst\b[\s\S]{0,80}\bthen\b/i,
  /\bplan\b/i,
  /\broadmap\b/i,
  /\bcompare\b/i,
  /\bcontrast\b/i,
  /analy[sz]e deeply/i,
  /\brefactor\b/i,
  /\bresearch\b/i,
  /\bdesign\b/i,
  /\barchitect/i,
  /\bcodebase\b/i,
  /pros and cons/i,
  /trade[- ]offs/i,
  /explain in detail/i,
];
const CODE_RE = /```|function\s+\w+|const\s+\w+\s*=|class\s+\w+|import\s+.*from|def\s+\w+\(|SELECT\s+.*FROM/i;

/**
 * Classify a request's complexity.
 *
 * Signals: user-visible text length, tool offers or tool-call history
 * (agentic work is never trivial), attachments (document parts are heavy),
 * code blocks, and multi-step indicator phrases. The result is a tier; the
 * scorer turns the tier into a minimum capability requirement.
 */
export function classifyTask(
  messages: readonly ChatMessage[],
  tools?: readonly ToolSpec[],
): TaskTier {
  let score = 0;

  const userText = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");

  let hasImage = false;
  let hasAudio = false;
  let hasDocument = false;
  let toolHistory = false;
  for (const m of messages) {
    for (const part of m.parts ?? []) {
      if (part.type === "image") hasImage = true;
      else if (part.type === "audio") hasAudio = true;
      else if (part.type === "document") hasDocument = true;
    }
    if (m.toolCalls !== undefined && m.toolCalls.length > 0) toolHistory = true;
    if (m.toolCallId !== undefined) toolHistory = true;
  }

  const hasTools = (tools?.length ?? 0) > 0;

  // Agentic work: the turn already used tools, or will offer them.
  if (toolHistory) score += 2;
  else if (hasTools) score += 1;

  // Attachments raise the floor: reading a document is heavy work.
  if (hasDocument) score += 3;
  else if (hasImage || hasAudio) score += 1;

  // Code in the prompt almost always means a working task, not chit-chat.
  if (CODE_RE.test(userText)) score += 1;

  // Multi-step indicators: planning, comparison, deep analysis. Each distinct
  // indicator adds a point (capped), so a genuinely involved plan scores
  // higher than a passing mention of "design".
  let stepHits = 0;
  for (const re of STEP_INDICATORS) {
    if (re.test(userText)) stepHits++;
  }
  score += Math.min(stepHits, 2);

  // Length is the weakest but most general signal; a very long prompt is
  // strong evidence of a working task, not chit-chat.
  const len = userText.length;
  if (len > 4000) score += 3;
  else if (len > 1200) score += 1;

  // A very short message with no other signals is just chit-chat.
  if (len <= 160 && score === 0) return "trivial";

  if (score <= 0) return "simple";
  if (score === 1) return "standard";
  if (score === 2) return "complex";
  return "heavy";
}

/** Derive what a request needs from its messages and tool offers. */
export function requestNeeds(
  messages: readonly ChatMessage[],
  tools?: readonly ToolSpec[],
): RequestNeeds {
  const tier = classifyTask(messages, tools);
  const hasTools = (tools?.length ?? 0) > 0;
  let needsVision = false;
  let needsDocuments = false;
  let toolHistory = false;
  for (const m of messages) {
    for (const part of m.parts ?? []) {
      if (part.type === "image") needsVision = true;
      if (part.type === "document") needsDocuments = true;
    }
    if ((m.toolCalls?.length ?? 0) > 0 || m.toolCallId !== undefined) toolHistory = true;
  }
  return { tier, needsTools: hasTools || toolHistory, needsVision, needsDocuments };
}

/** Adapter types the router knows; unknown types are excluded (fail-closed). */
const KNOWN_ADAPTERS = new Set(["openai_compatible", "nine_router", "gemini", "anthropic"]);

/**
 * Tool support is per-MODEL, not just per-adapter: every shipped adapter
 * serializes tool calls, but non-chat models behind one (embedding,
 * Gemini "aqa", whisper/TTS) cannot use them — modelSupportsTools()
 * (model_capabilities.ts) carries that distinction. KNOWN_ADAPTERS above
 * stays as the separate unknown-adapter gate.
 */

/**
 * The smart router. Constructed per request from the gateway; stateless.
 *
 * Health/latency policy: the health store persists each probe's outcome
 * AND its measured latencyMs, and routing prices both. A provider whose
 * latest probe failed within PROVIDER_DEAD_FRESH_MS is hard-excluded
 * while any alternative exists; a failure up to 24 h old costs
 * STALE_FAILURE_PENALTY (more than the entire cost spread); a success
 * within 24 h earns a small bonus minus a latency term from latencyMs.
 * A quarantined (provider, model) pair is hard-excluded under the same
 * relaxation: when every candidate is gated, the gate lifts — a
 * maybe-dead candidate beats none. Cost comes from the hint table.
 */
export class SmartRouter {
  private readonly storage: Storage;
  private readonly adapters: AdapterRegistry;
  private readonly costs: CostHintTable;
  private readonly circuit: CircuitStateReader | undefined;
  private readonly quarantine: SmartRouterOptions["quarantine"];

  constructor(storage: Storage, adapters: AdapterRegistry, opts: SmartRouterOptions = {}) {
    this.storage = storage;
    this.adapters = adapters;
    this.circuit = opts.circuit;
    this.quarantine = opts.quarantine;
    this.costs = {
      exact: { ...DEFAULT_COST_HINTS.exact, ...(opts.costHints?.exact ?? {}) },
      patterns: [
        ...(opts.costHints?.patterns ?? []),
        ...DEFAULT_COST_HINTS.patterns,
      ],
    };
  }

  /**
   * All eligible provider+model candidates: enabled providers with a
   * credential, and their enabled models. One provider contributes one
   * candidate per enabled model.
   */
  candidates(): RouteCandidate[] {
    const out: RouteCandidate[] = [];
    let providers: AiProviderRow[];
    try {
      providers = this.storage.listProviders();
    } catch {
      return out;
    }
    for (const provider of providers) {
      if (!provider.enabled) continue;
      let hasCred = false;
      try {
        hasCred = this.storage.hasCredential(provider.id);
      } catch {
        continue;
      }
      if (!hasCred) continue;
      let models: AiModelRow[];
      try {
        models = this.storage.listModels(provider.id);
      } catch {
        continue;
      }
      for (const model of models) {
        if (!model.enabled) continue;
        out.push({ provider, model });
      }
    }
    return out;
  }

  /**
   * Score one candidate for a request. Higher is better. Returns undefined
   * when the candidate cannot serve the request at all (hard gate).
   */
  private score(
    candidate: RouteCandidate,
    needs: RequestNeeds,
    gates: RouteGates,
  ): number | undefined {
    const { provider, model } = candidate;

    // Hard gates: capability must come before cost.
    if (!KNOWN_ADAPTERS.has(provider.adapter)) return undefined;
    if (needs.needsTools && !modelSupportsTools(provider.adapter, model.modelId)) return undefined;
    if (needs.needsDocuments) {
      // The request explicitly carries documents, so prefer an adapter that
      // reads them natively over one the bot layer would have to extract
      // locally for.
      if (!this.adapters.describes(provider.adapter).documentInput) return undefined;
    }

    // Tier floor: the candidate must be strong enough. When nothing is
    // strong enough, route() falls back to the strongest available.
    const rank = modelCapabilityRank(model.modelId);
    const floor = tierMinimumRank(needs.tier);
    if (rank < floor) return undefined;

    // Breaker gate: an open breaker means the gateway would skip this
    // provider anyway, so routing to it only wastes the primary slot.
    const circuitPenalty = this.circuitPenalty(provider.id);
    if (circuitPenalty === undefined) return undefined;

    // Fresh-failure gate: a provider whose latest probe just failed is
    // excluded outright — unless EVERY candidate is fresh-failed, in
    // which case route() deactivated the gate (a maybe-dead provider
    // beats none) and the failure is priced by healthBonus instead.
    if (gates.freshGateActive && this.isFreshFailed(provider.id, gates.now)) {
      return undefined;
    }

    // Quarantine gate: same relaxation pattern as the fresh gate.
    if (gates.quarantineGateActive && this.isQuarantined(candidate)) {
      return undefined;
    }

    let score = 1000;

    // Cost dominates: pick the cheapest candidate that satisfies the tier.
    score -= costHint(model.modelId, this.costs) * 10;

    // Probe history: recent success beats no data beats recent failure.
    const bonus = this.healthBonus(provider.id, gates.now);
    score += bonus;

    // A half-open (or cooldown-expired open) provider may serve one probe;
    // it must not beat a healthy candidate.
    score -= circuitPenalty;

    // Among equals, prefer a streaming adapter (faster perceived latency).
    if (provider.adapter === "openai_compatible") score += 2;

    return score;
  }

  /**
   * Breaker penalty for a provider: undefined = hard-excluded (open breaker
   * whose cooldown has not elapsed), 0 = healthy, CIRCUIT_HALF_OPEN_PENALTY
   * = may serve one probe. Never throws: a broken reader must not break
   * routing, so the candidate is simply treated as healthy.
   */
  private circuitPenalty(providerId: number): number | undefined {
    if (this.circuit === undefined) return 0;
    let view: CircuitStateView;
    try {
      view = this.circuit.state(providerId);
    } catch {
      return 0;
    }
    if (view.state === "closed") return 0;
    if (view.state === "half_open") return CIRCUIT_HALF_OPEN_PENALTY;
    // An open breaker whose cooldown has elapsed will admit a probe on the
    // next acquire, so it ranks like half-open; before that it is unusable.
    if (view.nextRetryAt !== undefined && view.nextRetryAt <= Date.now()) {
      return CIRCUIT_HALF_OPEN_PENALTY;
    }
    return undefined;
  }

  /**
   * Availability term from probe history, in score points.
   *
   * The health store keeps the latest probe outcome per provider,
   * including its measured latencyMs. Policy:
   * - A failure fresher than PROVIDER_DEAD_FRESH_MS never reaches here
   *   while the fresh gate is active (score() excluded the candidate).
   *   When the gate is relaxed (every candidate fresh-failed) it is
   *   priced like a stale failure — uniformly, so ordering falls back
   *   to cost and the deterministic tie-breaks.
   * - A failure 10 min–24 h old: −STALE_FAILURE_PENALTY, deliberately
   *   larger than the whole cost spread (90 × 10 = 900), so a
   *   known-failed provider can never win on price alone.
   * - A success within 24 h: +HEALTH_SUCCESS_BONUS plus a latency term
   *   from the row's latencyMs, −round(min(latencyMs, 2000) / 10)
   *   (0..−200). A missing latencyMs contributes 0 for that term.
   * - No row, or a row older than 24 h: 0.
   */
  private healthBonus(providerId: number, now: number): number {
    const row = this.healthRow(providerId);
    if (!row) return 0;
    const ageMs = now - row.checkedAt;
    if (ageMs > HEALTH_WINDOW_MS) return 0;
    if (!row.ok) return -STALE_FAILURE_PENALTY;
    let bonus = HEALTH_SUCCESS_BONUS;
    if (row.latencyMs !== undefined && Number.isFinite(row.latencyMs)) {
      bonus -= Math.round(
        Math.min(row.latencyMs, LATENCY_CAP_MS) / LATENCY_MS_PER_POINT,
      );
    }
    return bonus;
  }

  /** Latest probe row for a provider; unreadable storage reads as none. */
  private healthRow(providerId: number): AiProviderHealthRow | undefined {
    try {
      return this.storage.getProviderHealth(providerId);
    } catch {
      return undefined;
    }
  }

  /**
   * True when the provider's latest probe failed less than
   * PROVIDER_DEAD_FRESH_MS ago (by the route() call's clock snapshot).
   * Mirrors the gateway's plan() freshness test (H6).
   */
  private isFreshFailed(providerId: number, now: number): boolean {
    const row = this.healthRow(providerId);
    return (
      row !== undefined &&
      row.ok === false &&
      now - row.checkedAt < PROVIDER_DEAD_FRESH_MS
    );
  }

  /**
   * True when this (provider, model) pair is in the model quarantine.
   * Never throws: a broken reader must not break routing, so the pair is
   * simply treated as not quarantined (mirrors circuitPenalty).
   */
  private isQuarantined(candidate: RouteCandidate): boolean {
    if (this.quarantine === undefined) return false;
    try {
      return this.quarantine.isQuarantined(
        candidate.provider.id,
        candidate.model.modelId,
      );
    } catch {
      return false;
    }
  }

  /**
   * Pick the cheapest/fastest candidate that satisfies the request.
   * Returns undefined when no candidate can serve it.
   *
   * `hints.prefer` is the owner's active selection: it wins ties only, so
   * an explicit owner choice is never overridden on a coin flip.
   */
  route(
    req: Pick<CompletionRequest, "messages" | "tools">,
    hints: RouteHints = {},
  ): RouteDecision | undefined {
    const needs = requestNeeds(req.messages, req.tools);
    const all = this.candidates();
    if (all.length === 0) return undefined;

    // Gate state for this call, computed once from the full candidate
    // list. Each gate is active only while at least one candidate
    // survives it: if EVERY candidate is fresh-failed (or quarantined),
    // that gate lifts for this call — a maybe-dead candidate beats none.
    // This mirrors the relaxation guards in the gateway's
    // eligibleCandidates / demoteFreshProbeFailures.
    const now = Date.now();
    const gates: RouteGates = {
      now,
      freshGateActive: all.some((c) => !this.isFreshFailed(c.provider.id, now)),
      quarantineGateActive: all.some((c) => !this.isQuarantined(c)),
    };

    const scored: Array<{ candidate: RouteCandidate; score: number }> = [];
    for (const candidate of all) {
      const s = this.score(candidate, needs, gates);
      if (s !== undefined) scored.push({ candidate, score: s });
    }

    let pool = scored;
    if (pool.length === 0) {
      // Nothing met the tier floor: fall back to the strongest candidate(s)
      // that pass the hard capability gates, so the request still goes out
      // rather than failing for lack of a "good enough" model.
      let bestRank = -1;
      const gated: RouteCandidate[] = [];
      for (const candidate of all) {
        const { provider } = candidate;
        if (!KNOWN_ADAPTERS.has(provider.adapter)) continue;
        if (needs.needsTools && !modelSupportsTools(provider.adapter, candidate.model.modelId)) continue;
        if (needs.needsDocuments && !this.adapters.describes(provider.adapter).documentInput) continue;
        // Breaker gate applies here too: an open breaker is unusable even
        // as a last resort. (The gateway's own all-open fallback covers
        // the case where every candidate is open.)
        if (this.circuitPenalty(provider.id) === undefined) continue;
        // Fresh-failure and quarantine gates apply here too, under the
        // same per-call gate state score() used: a gated candidate is
        // not a last resort while the gate is active, and IS one again
        // when route() lifted the gate (every candidate gated).
        if (gates.freshGateActive && this.isFreshFailed(provider.id, gates.now)) continue;
        if (gates.quarantineGateActive && this.isQuarantined(candidate)) continue;
        const rank = modelCapabilityRank(candidate.model.modelId);
        if (rank > bestRank) {
          bestRank = rank;
          gated.length = 0;
          gated.push(candidate);
        } else if (rank === bestRank) {
          gated.push(candidate);
        }
      }
      pool = gated.map((candidate) => ({
        candidate,
        // Re-score without the tier floor for ordering, through the
        // same healthBonus score() uses (stale penalty / latency term).
        score:
          1000 -
          costHint(candidate.model.modelId, this.costs) * 10 +
          this.healthBonus(candidate.provider.id, gates.now) -
          (this.circuitPenalty(candidate.provider.id) ?? 0),
      }));
    }

    if (pool.length === 0) return undefined;

    // Sort by score descending; the owner's active selection wins ties;
    // deterministic tie-break on ids after that.
    const prefer = hints.prefer;
    const isPreferred = (c: RouteCandidate): boolean =>
      prefer !== undefined &&
      c.provider.id === prefer.providerId &&
      c.model.modelId === prefer.modelId;
    pool.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ap = isPreferred(a.candidate) ? 0 : 1;
      const bp = isPreferred(b.candidate) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      const pa = a.candidate.provider.id;
      const pb = b.candidate.provider.id;
      if (pa !== pb) return pa - pb;
      return a.candidate.model.modelId < b.candidate.model.modelId ? -1
        : a.candidate.model.modelId > b.candidate.model.modelId ? 1
        : 0;
    });

    const winner = pool[0]!.candidate;
    const cost = costHint(winner.model.modelId, this.costs);
    return {
      providerId: winner.provider.id,
      providerLabel: winner.provider.label,
      modelId: winner.model.modelId,
      modelLabel: winner.model.label,
      tier: needs.tier,
      reason:
        `tier=${needs.tier} cost=${cost}` +
        (needs.needsTools ? " tools=yes" : "") +
        (needs.needsVision ? " vision=yes" : "") +
        (needs.needsDocuments ? " documents=yes" : ""),
    };
  }

  /**
   * True when routing can change anything: enabled, and 2+ distinct
   * providers are eligible. With a single provider there is nothing to
   * choose, so the gateway keeps its exact existing behavior.
   */
  shouldRoute(): boolean {
    if (!smartRoutingEnabled()) return false;
    const providers = new Set<number>();
    for (const c of this.candidates()) providers.add(c.provider.id);
    return providers.size >= 2;
  }
}
