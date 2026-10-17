# TLS test fixtures

A throwaway self-signed certificate (SAN: `DNS:localhost`, **no IP SAN**) and
its private key, used only by `tests/ai_dns_guard.test.ts` to prove two things
about the pinned transport:

1. Certificate verification is **enabled** — the handshake fails because the
   certificate is not in any trust store.
2. Identity is checked against the **configured hostname**, not the pinned IP.
   With `NODE_EXTRA_CA_CERTS` pointing at this certificate, connecting to
   `https://localhost` on the pinned address `127.0.0.1` succeeds, which can
   only happen if the name compared is `localhost` (the certificate carries no
   IP SAN). Connecting as `wrong-name.test` with the same trusted certificate
   fails.

This key protects nothing and is not a credential: it is regenerated for
offline testing and must never be used by any service.
