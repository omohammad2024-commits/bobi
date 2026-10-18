#!/bin/sh
# Railway mounts volumes owned by root, so a process running as an unprivileged
# user cannot write to them. The database lives on that volume, so the ownership
# is corrected here before dropping privileges.
#
# The correction is best-effort: if the volume happens to already be writable,
# a failure here must not stop the bot from starting.
chown bun:bun /data 2>/dev/null || true

# Run as the non-root user the base image provides, rather than as root.
exec runuser -u bun -- bun run src/index.ts
