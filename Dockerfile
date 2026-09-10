FROM node:22-trixie-slim AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
# better-sqlite3 ships a binding.gyp and sets "gypfile": false (npm's signal
# to skip auto-building) with no install/postinstall script. pnpm's native-
# build detection keys off the binding.gyp file regardless and runs an
# implicit `node-gyp rebuild` during install anyway — it only touches stamp
# files (the real runtime binary comes from prebuilds/), but node-gyp still
# needs python3/make/g++ present to get through its bootstrap, or install
# fails outright. Those prebuilt binaries require glibc >= 2.38, so the base
# image is Debian trixie (glibc 2.41), not bookworm (glibc 2.36, too old —
# causes an ERR_DLOPEN_FAILED at runtime).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:22-trixie-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    CONFIG_PATH=/data/config.yaml \
    DB_PATH=/data/status.db
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# The mounted /data directory must be writable by this user (uid 1000).
USER node
EXPOSE 3000
# Any HTTP answer means the server is up. An unknown Host gets a 404, which
# is fine here; only a connection failure or a 5xx marks the container bad.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server.js"]
