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
 *                               activeModelId, lastProbe: { ok, atMs, latencyMs, message? } | null }] }
 *   providers.presets       {} -> { presets: [{ id, label, baseUrl, suggestedModel?,
 *                               hasPlaceholder, requiredPlaceholder?, note? }], templates }
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
 * Success shape: { ok: true, ...data }. Failure shape:
 *   { ok: false, error: { code, message } } — or non-JSON / HTTP errors,
 *   which are normalized to { code: "http_<status>" | "network" | "timeout" }.
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

    if (!res.ok) {
      // The backend returns { error: "<fa string>" } (a plain string); be
      // liberal and accept an { code, message } object too.
      const rawErr = body && body.error;
      const err = typeof rawErr === "string" ? { message: rawErr } : rawErr || {};
      throw { code: err.code || "http_" + res.status, message: err.message || "HTTP " + res.status };
    }
    if (body && body.ok === false) {
      const rawErr = body.error;
      const err = typeof rawErr === "string" ? { message: rawErr } : rawErr || {};
      throw { code: err.code || "server", message: err.message || "Server error" };
    }
    return body || {};
  }

  window.MiniApi = { apiCall: apiCall };
})();
