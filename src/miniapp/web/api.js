/* BOBI Mini App — API client.
 *
 * apiCall(endpoint, params) → POST /miniapp/api/<endpoint>
 * Body: { initData: Telegram.WebApp.initData, ...params }
 * Timeout: 120s for `turn`, 30s for everything else.
 * On error throws { code, message }.
 *
 * Backend contract (the server implements these; see src/miniapp/api.ts,
 * api_providers.ts, api_manage.ts):
 *   turn                    { conversationId, text } -> { reply }
 *   providers.list          {} -> { providers: [{ id, label, adapterType, adapterLabel,
 *                               enabled, keyPresent, keyHint, modelCount, isActive,
 *                               baseUrl, activeModelId,
 *                               lastProbe: { ok, atMs, latencyMs, message?, status? } | null }] }
 *   providers.presets       {} -> { presets: [{ id, label, baseUrl, suggestedModel?,
 *                               hasPlaceholder, requiredPlaceholder?, note? }],
 *                               templates: [{ type, label, suggestedBaseUrl, … }] (ALL
 *                               adapter types, incl. gemini + anthropic) }
 *   providers.add           preset: { kind:"preset", preset, label?, baseUrl?, key? } -> { id, modelId?, autoSelected? }
 *                           custom: { kind:"custom", label, baseUrl, key?, model?|suggestedModel? }
 *                           9Router: { kind:"nine_router", label, baseUrl, key, model }
 *   providers.update        { id, label?, baseUrl? } -> { ok:true }
 *   providers.toggle        { id, enabled:boolean } -> { ok:true }
 *   providers.delete        { id, confirm:true } -> { ok:true }
 *   providers.probe         { id } -> { ok, latencyMs, atMs, message? }
 *   providers.setKey        { id, key } -> { ok:true, keyPresent:true }
 *   providers.clearKey      { id, confirm:true } -> { ok:true, keyPresent:false }
 *   providers.setActive     { id } -> { ok, providerId, modelId, label, probe:{ ok, latencyMs, message? } }
 *   models.list             { providerId } -> { models: [{ id, label, modelId, enabled, isActive }] }
 *   models.discover         { providerId } -> { models: [{ modelId, label, imported }] }
 *   models.discoverDraft    { kind:"preset", preset, key, baseUrl? } |
 *                           { kind:"custom", baseUrl, key } -> { models: [{ modelId, label }] }
 *   models.import           { providerId, modelIds } -> { imported, skipped, autoSelected? }
 *   models.add              { providerId, modelId, label? } -> { id, autoSelected? }
 *   models.toggle           { id, enabled:boolean } -> { ok:true }
 *   models.delete           { id, confirm:true } -> { ok:true }
 *   models.setActive        { id } -> { ok, providerId, modelId, label, probe:{...} }
 *   models.test             { providerId, modelId } -> { ok, latencyMs, atMs, message? }
 *   users.list              { q?, limit? } -> { users: [{ id, state, isBanned, username?, firstName? }], total }
 *   users.ban               { id, confirm:true } -> { userId, state }
 *   users.unban             { id } -> { userId, state }
 *   memory.search           { q, limit? } -> { mems: [{ key, content, createdAt, updatedAt }], total, offset, limit }
 *   memory.list             { limit?, offset? } -> same
 *   curator.proposals       {} -> { proposals: [{ id, kind, kindFa, memoryIds, summaryFa, createdAt }], count }
 *   curator.decide          { id, approve:boolean } -> { proposalId, decision, applied, summaryFa }
 *   events.list             {} -> { events: [{ key, name, kind, labelFa, daysUntil, note? }], count }
 *   bench.runs              { limit? } -> { runs: [{ id, runStamp, tsMs, mode, provider, model,
 *                               taskCount, passed, failed, avgScorePct, ... }] }
 *   bench.trends            { n?, mode?, model?, task? } -> { pair, runs: [{ runId, tsMs, avgScorePct }], pairs, tasks, task }
 *   bench.schedule          {} -> { schedule: { exists, enabled, cron?, nextRunAtMs?, ... } }
 *                           { enabled:true, cron|cadence } / { enabled:false }
 *   bench.alerts            {} -> { alerts: [{ key, labelFa, lastSentMs }] }
 *   schedulers.list         {} -> { schedulers: [{ id, name, enabled, cron, timezone, nextRunAtMs, runCount, ... }] }
 *   schedulers.toggle       { id, enabled } -> { id, enabled }
 *   digest.preview          {} -> { text }
 *   digest.config           {} -> { exists, enabled, time?, prompt?, chatId?, ... } (flat; set with flat params)
 *   groupdigests.list       {} -> { groups: [{ chatId, assistantEnabled, digestEnabled, digestTime, task }] }
 *   groupdigests.set        { chatId, digestEnabled, time? } -> { chatId, digestEnabled, ... }
 *   skills.list             {} -> { skills: [{ name, enabled, trusted, version? }] }
 *   skills.toggle           { name, enabled } -> { name, enabled }
 *   skills.install          { source, confirm? } -> { review, needsConfirm:true } | { installed:true, name, enabled:false }
 *   skills.uninstall        { name, confirm:true } -> { name, removed:true }
 *   trust.list              {} -> { publishers: [{ keyId, shortKeyId, label, addedAtMs }] }
 *   trust.add               { publisher, label? } -> { keyId, label, added }
 *   trust.remove            { publisher, confirm:true } -> { keyId, removed:true }
 *   usage.report            { days? } -> { days, runs, inputTokens, outputTokens, estimatedUsd, byModel: [...] }
 *   tasks.list              {} -> { reminders, tasks, goals } (each with kind)
 *   tasks.complete          { kind, id } -> { kind, id }   (reminder|goal only)
 *   tasks.cancel            { kind, id, confirm? } -> { kind, id }   (reminder|task w/ confirm only)
 *   groups.list             {} -> { groups: [{ chatId, assistantEnabled, digestEnabled, moderationEnabled }] }
 *   groups.assistant        { groupId } -> { groupId, config }
 *   groups.assistant.set    { groupId, enabled, smart? } -> { groupId, config }
 *   groups.digests          { groupId } -> { chatId, assistantEnabled, digestEnabled, digestTime, task }
 *   groups.digests.set      { chatId, digestEnabled, time? } -> { chatId, digestEnabled, ... }
 *   moderation.get          { groupId } -> { groupId, config }
 *   moderation.set          { groupId, ...patch } -> { groupId, config }
 *
 * Success shape: { ok: true, ...data }. Two different `ok: false` shapes:
 *   - Transport/API failure: { ok: false, error: { code, message, suggestion? } }
 *     (or error as a plain string) → apiCall throws an Error carrying the
 *     REAL message, plus .code / .suggestion when present.
 *   - Domain result (probe / model-test outcomes): { ok: false, message?,
 *     status?, latencyMs?, ping?, real?, … } with NO `error` field → the
 *     body is returned to the caller untouched; a failed probe is data,
 *     not an exception.
 *   Non-JSON / HTTP / network failures are normalized to a thrown
 *   { code: "http_<status>" | "network" | "timeout" | "server", message }.
 */
(function () {
  "use strict";

  const BASE = "/miniapp/api/";
  const LONG_ENDPOINTS = { turn: 120000 };
  const DEFAULT_TIMEOUT = 30000;

  function timeoutFor(endpoint) {
    return LONG_ENDPOINTS[endpoint] || DEFAULT_TIMEOUT;
  }

  async function apiCall(endpoint, params) {
    const timeout = timeoutFor(endpoint);
    const ctrl = new AbortController();
    const timer = setTimeout(function () {
      ctrl.abort();
    }, timeout);

    let initData = "";
    try {
      initData =
        (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) || "";
    } catch (_) {}

    let res;
    try {
      res = await fetch(BASE + encodeURIComponent(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ initData: initData }, params || {})),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === "AbortError") {
        throw { code: "timeout", message: "Request timed out" };
      }
      throw { code: "network", message: (e && e.message) || "Network error" };
    }
    clearTimeout(timer);

    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      body = null;
    }

    // Envelope rule: `ok === false` WITH an `error` field is a transport/API
    // failure — throw an Error carrying the real message (never a synthetic
    // "Server error" when the server actually said what went wrong).
    if (body && body.ok === false && body.error !== undefined && body.error !== null) {
      const rawErr = body.error;
      const errObj = typeof rawErr === "string" ? { message: rawErr } : rawErr || {};
      const message =
        errObj.message ??
        (typeof rawErr === "string" ? rawErr : undefined) ??
        body.message ??
        "Server error";
      const err = new Error(message);
      err.code = errObj.code || (res.ok ? "server" : "http_" + res.status);
      const suggestion = errObj.suggestion ?? body.suggestion;
      if (suggestion !== undefined) err.suggestion = suggestion;
      throw err;
    }
    if (!res.ok) {
      // Non-JSON / HTTP failure with no usable error envelope: synthesize.
      const rawErr = body && body.error;
      const errObj = typeof rawErr === "string" ? { message: rawErr } : rawErr || {};
      const err = new Error(errObj.message || "HTTP " + res.status);
      err.code = errObj.code || "http_" + res.status;
      if (errObj.suggestion !== undefined) err.suggestion = errObj.suggestion;
      throw err;
    }
    // `ok === false` with NO `error` field is a domain result (a failed
    // probe / model test): hand it to the caller untouched.
    return body || {};
  }

  window.MiniApi = { apiCall: apiCall };
})();
