/* BOBI Mini App — API client.
 *
 * apiCall(endpoint, params) → POST /miniapp/api/<endpoint>
 * Body: { initData: Telegram.WebApp.initData, ...params }
 * Timeout: 120s for `turn`, 30s for everything else.
 * On error throws { code, message }.
 *
 * Expected backend contract (server side implements these):
 *   turn                    { conversationId, text } -> { text }
 *   providers.list          {} -> { providers: [{ id, label, adapter, enabled,
 *                               hasKey, modelCount, activeModel?, status,
 *                               lastProbe: { ok, ms, at } | null }] }
 *   providers.get           { id } -> { provider, models: [{ id, label?, enabled, active }] }
 *   providers.add           { kind, presetId?, adapter, label, baseUrl, key, modelId? } -> { id }
 *   providers.update        { id, label, baseUrl } -> {}
 *   providers.setKey        { id, key } -> {}
 *   providers.clearKey      { id } -> {}
 *   providers.toggle        { id, enabled } -> {}
 *   providers.probe         { id } -> { ok, ms, message }
 *   providers.delete        { id } -> {}
 *   models.discover         { providerId } -> { models: [string] }
 *   models.add              { providerId, id } -> {}
 *   models.update           { providerId, id, enabled } -> {}
 *   models.delete           { providerId, id } -> {}
 *   models.setActive        { providerId, id } -> {}
 *   users.list              {} -> { users: [{ id, name, username, banned, note? }] }
 *   users.ban               { id } -> {}
 *   users.unban             { id } -> {}
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
