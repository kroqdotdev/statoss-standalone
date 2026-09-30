FROM node:22-trixie-slim AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
# better-sqlite3 ships a binding.gyp and sets "gypfile": false (npm's signal
# to skip auto-building) with no install/postinstall script. pnpm's native-
# build detection keys off the binding.gyp file regardless and runs an
# implicit `node-gyp rebuild` during install anyway. It only touches stamp
# files (the real runtime binary comes from prebuilds/), but node-gyp still
# needs python3/make/g++ present to get through its bootstrap, or install
# fails outright. Those prebuilt binaries require glibc >= 2.38, so the base
# image is Debian trixie (glibc 2.41), not bookworm (glibc 2.36, too old,
# which causes an ERR_DLOPEN_FAILED at runtime).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build
# better-sqlite3 ships a prebuilt binary for every platform. Keep only the
# one for the platform this stage builds for, which is the one it loads.
RUN find .next/standalone/node_modules -path '*/better-sqlite3/prebuilds/*.node' \
    ! -name "linux-$(node -p process.arch).node" -delete

FROM node:22-trixie-slim AS run
LABEL org.opencontainers.image.title="statoss-standalone" \
      org.opencontainers.image.description="Self-hosted status page in one container: uptime checks, SQLite storage, a public page for each site, and alerts." \
      org.opencontainers.image.source="https://github.com/kroqdotdev/statoss-standalone" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
# Everything the app keeps lives in /data: the configuration it reads
# (/data/config.yaml), the incident files (/data/incidents) and the SQLite
# database (/data/status.db).
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    CONFIG_PATH=/data/config.yaml \
    DB_PATH=/data/status.db
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# /data belongs to the node user (uid 1000), so a new named volume starts
# out writable. A bind-mounted directory must be writable by uid 1000 too.
RUN mkdir /data && chown node:node /data
# For ping monitors. Setuid, so the node user can send an echo on hosts
# that do not open ICMP sockets to every group.
RUN apt-get update && apt-get install -y --no-install-recommends iputils-ping \
    && rm -rf /var/lib/apt/lists/* \
    && chmod u+s "$(command -v ping)"
VOLUME ["/data"]
USER node
EXPOSE 3000
# There is no health route. Any HTTP answer means the server is up: an
# unknown Host gets a 404, which is fine here. Only a connection failure or
# a 5xx marks the container bad.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/').then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server.js"]
