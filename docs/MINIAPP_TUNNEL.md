# Mini App public tunnel

Telegram Mini Apps only open `https://` URLs reachable from the user's phone, so
BOBI's local HTTP API (`127.0.0.1:8471`) is published through a Cloudflare **quick
tunnel** (`https://*.trycloudflare.com`) — free, no account needed.

## How it works

1. `scripts/miniapp-tunnel.sh` waits for the bot's HTTP API (`/health`) to answer,
   then starts `cloudflared tunnel --url http://127.0.0.1:8471 --no-autoupdate`.
2. It watches cloudflared's log for the assigned `https://*.trycloudflare.com`
   URL and writes it to `<deploy-dir>/miniapp.url` (any stale file is deleted on
   every start, so the bot never renders a dead button).
3. The script then keeps the **same** cloudflared process alive via `wait`. (A
   re-exec would mint a new random tunnel URL and invalidate the file, so the
   original connection is kept instead of exec'd.)
4. If cloudflared dies, the script exits and systemd restarts it — a fresh
   tunnel is opened and `miniapp.url` is rewritten.

`bobi-tunnel.service` (systemd) runs that script with `Restart=always` /
`RestartSec=30` and `BindsTo=bobi.service`, so the tunnel follows the bot down
and up and retries quietly when Cloudflare is unreachable.

## Mini App URL resolution order (for the bot)

1. `BOBI_MINIAPP_URL` env var wins — use it for a pinned/stable URL.
2. Otherwise the `<deploy-dir>/miniapp.url` file written by the tunnel service.
3. Otherwise the Mini App button is **not rendered** (fail-closed).

## VM replacement

`scripts/install-service.sh` installs, enables, and starts **both** units
(`bobi.service` and `bobi-tunnel.service`). After a VM replacement, running it
restores the bot and the tunnel; the tunnel mints a fresh `*.trycloudflare.com`
URL on first start. `/usr/local/bin/cloudflared` is expected to exist on the
image (it does on the current one).

## Switching to a stable named tunnel / own domain later

Quick-tunnel URLs are random and change on every restart, which is fine for
testing but annoying for a pinned Mini App button. When ready, create a named
tunnel once (`cloudflared tunnel login`, `cloudflared tunnel create bobi`,
route a DNS record for your own domain to it), run cloudflared with that tunnel
instead of `--url`, and set `BOBI_MINIAPP_URL=https://miniapp.yourdomain.com`
on the bot — per the resolution order above it then wins over the
`miniapp.url` file and the button URL never changes again.

## Security notes

- The tunnel exposes **only** the bot's own HTTP API on 127.0.0.1:8471.
- Every Mini App/dashboard endpoint is auth-gated (Telegram `initData` HMAC
  verification + owner check); `/health` stays public by design and returns no
  sensitive data (status, version, uptime, tool count).
- Unknown paths return a bare `404` with no information leak.

## Known limitation (2026-10-19)

The sandbox VM's egress currently blocks the quick-tunnel API
(`api.trycloudflare.com` — connections are intercepted and the TLS handshake
fails), so `bobi-tunnel.service` cannot mint a URL from this host and sits in
its restart loop by design. Everything is in place and it will start working
automatically if egress policy changes, or on any host with normal internet
egress. Alternatives if a public URL is needed now: run the same
`miniapp-tunnel.sh` from a machine with unrestricted egress and copy the
resulting URL into `BOBI_MINIAPP_URL`, connect Tailscale and use
`tailscale funnel`, or move to a named tunnel on the owner's own domain (above).
