# Bobi — deploy image.
#
# Bun is the runtime, not Node: the project uses `bun:sqlite` for storage, which
# is a Bun built-in and has no Node equivalent. The Debian variant is used rather
# than Alpine so the SQLite and TLS system libraries are the ones the runtime
# actually expects.
FROM oven/bun:1-debian

# ca-certificates for outbound HTTPS, curl for the healthcheck,
# ffmpeg + yt-dlp for the universal media downloader (download_media tool).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && curl -fsSL -o /usr/local/bin/yt-dlp \
        https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    && chmod a+x /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json bun.lock* ./
# No --production: the build needs TypeScript, and the image is not size-critical.
RUN bun install --frozen-lockfile || bun install

COPY . .

# The database lives on a mounted volume. Creating it here means the directory
# exists with the right owner even before a volume is attached.
ENV NODE_ENV=production
ENV BOBI_DB_PATH=/data/bobi.db
RUN mkdir -p /data && chown -R bun:bun /data /app

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Railway polls this to decide whether the deploy is alive. Without it the
# platform sees a container with no listening socket and rolls the deploy back
# in a restart loop.
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
    CMD curl -fs "http://127.0.0.1:${PORT:-8080}/health" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
