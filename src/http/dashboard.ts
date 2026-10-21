/**
 * RETIRED — the owner web dashboard (platform Phase 10).
 *
 * The dashboard (login shell, SPA, and the /api/v1/dashboard/* JSON API)
 * was deleted: the Mini App is the one canonical web surface. The
 * coverage checklist that gated the deletion — every dashboard action
 * mapped to its Mini App equivalent, including the actions added to the
 * Mini App for parity in Phase 10 — is docs/DASHBOARD_COVERAGE.md.
 *
 * What remains here is only the old-URL behavior, so bookmarks and
 * stale clients land somewhere honest instead of a bare 404:
 *
 *   GET  /dashboard, /dashboard/        → 301 to /miniapp/
 *   any  /api/v1/dashboard[/...]       → 410 Gone (JSON, no data)
 *   anything else                      → undefined (not our path)
 *
 * No authentication is involved: the handler serves no data at all.
 * The BOBI_DASHBOARD env knob retired with the surface and now does
 * nothing.
 */

const API_PREFIX = "/api/v1/dashboard";
const PAGE_PATHS = new Set(["/dashboard", "/dashboard/"]);

export function handleDashboardRequest(req: Request): Response | undefined {
  const path = new URL(req.url).pathname;
  if (PAGE_PATHS.has(path)) {
    if (req.method !== "GET") {
      return json(405, { error: "Method not allowed." });
    }
    return new Response(null, {
      status: 301,
      headers: { location: "/miniapp/", "cache-control": "no-store" },
    });
  }
  if (path === API_PREFIX || path.startsWith(API_PREFIX + "/")) {
    return json(410, {
      error: "The web dashboard has been retired. Use the Mini App (/miniapp/) instead.",
    });
  }
  return undefined;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
