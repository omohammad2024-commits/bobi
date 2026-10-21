# Web dashboard retirement — Mini App coverage checklist

Platform Phase 10 verdict: **the web dashboard is DELETED**
(`src/http/dashboard.ts`, `dashboard_pages.ts`, `dashboard_render.ts`).
The Mini App is the one canonical web surface. This checklist is the
evidence: every dashboard route/action, mapped to the Mini App action
that covers it. Actions that existed only in the dashboard were added
to `src/miniapp/api_manage.ts` in Phase 10 (marked ★) before the
dashboard was removed.

Auth equivalence: dashboard routes sat behind the shared Bearer token
(`BOBI_API_TOKEN`); every Mini App API call is authenticated with
Telegram initData (HMAC) plus a server-side owner check. Owner-only on
both surfaces.

## Route-by-route coverage

| Dashboard route | Mini App coverage |
|---|---|
| `GET /dashboard` (login shell / SPA shell) | The Mini App itself, `GET /miniapp/` |
| `GET /api/v1/dashboard/ping` | Any authenticated manage call (initData validated per call) |
| `GET /api/v1/dashboard/providers` | `providers.list` |
| `POST /api/v1/dashboard/providers/enable` | `providers.toggle` |
| `POST /api/v1/dashboard/providers/activate` | `providers.setActive` |
| `POST /api/v1/dashboard/models/enable` | `models.toggle` |
| `POST /api/v1/dashboard/models/activate` | `models.setActive` / `models.setDefault` |
| `GET /api/v1/dashboard/memory?q=&limit=` | `memory.list` / `memory.search` — including the phase-5 `embedding` index-health field ★ (wired from the platform's semantic index) |
| `GET /api/v1/dashboard/users` | `users.list` |
| `POST /api/v1/dashboard/users/restrict` `ban` / `unban` | `users.ban` / `users.unban` |
| `POST /api/v1/dashboard/users/restrict` `mute` / `unmute` | ★ `users.mute` / `users.unmute` (added in Phase 10) |
| `GET /api/v1/dashboard/benchmarks` | `bench.runs` (same run summaries, from BenchHistory) |
| `GET /api/v1/dashboard/benchmarks/report?name=` | ★ `bench.report` (added in Phase 10; same allowlist discipline: strict name regex + live directory listing + path containment) |
| `GET /api/v1/dashboard/benchmarks/trends` | `bench.trends` |
| `GET /api/v1/dashboard/benchmarks/live/stream` (SSE) | ★ `bench.live` (added in Phase 10) — a polling snapshot of the same worker state; a Telegram Web App cannot hold the dashboard's initData-less SSE stream, so the stream itself is retired and the data is served per-poll |
| `GET /api/v1/dashboard/schedulers` | `schedulers.list` |
| `POST /api/v1/dashboard/schedulers/bench` | `bench.schedule` |
| `POST /api/v1/dashboard/schedulers/digest` | `digest.config` (enabled/time/cron) |
| `GET /api/v1/dashboard/digest/config` | `digest.config` (no fields = the view) |
| `POST /api/v1/dashboard/digest/prompt` | `digest.config` with `{prompt}` |
| `POST /api/v1/dashboard/digest/prompt/reset` | `digest.config` with `{prompt: <defaultPrompt from the view>}` |
| `POST /api/v1/dashboard/digest/destination` | `digest.config` with `{chatId}` |
| `GET /api/v1/dashboard/group-digests` | `groupdigests.list` |
| `POST /api/v1/dashboard/group-digests/set` | `groupdigests.set` |

## Old-URL behavior after retirement

Served by the small retirement handler that keeps the
`src/http/dashboard.ts` module path (see that file):

| URL | Behavior |
|---|---|
| `GET /dashboard`, `GET /dashboard/` | **301 → `/miniapp/`** (bookmarks keep working) |
| any `/api/v1/dashboard` or `/api/v1/dashboard/*` | **410 Gone**, JSON `{ error: "The web dashboard has been retired. Use the Mini App (/miniapp/) instead." }` — no auth required, no data served |
| anything else | falls through to the server's normal routing (unchanged) |

The `BOBI_DASHBOARD` env knob is retired with the surface: it no
longer enables anything (the registry entry in `src/config/env.ts`
says so, and `docs/CONFIG.md` mirrors it).

## Notes

- The Mini App also covers areas the dashboard never had: curator
  proposals, skills + trust registry, usage reports, tasks, group
  assistant/moderation config, the owner profile, and — new in
  Phase 10 — the tool desk (`desk.list` / `desk.toggle`).
- Digest prompt/destination/schedule edits now run through
  `DigestSchedulingService` (Phase 10), the same service the platform
  scheduling facade exposes; the dashboard's private copies of that
  logic died with it.
