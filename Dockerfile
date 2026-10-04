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
# Serves the app under a path of a domain, like /status, when given:
# --build-arg BASE_PATH=/status. The published image has none.
ARG BASE_PATH=""
RUN pnpm build
# better-sqlite3 ships a prebuilt binary for every platform. Keep only the
# one for the platform this stage builds for, which is the one it loads.
RUN find .next/standalone/node_modules -path '*/better-sqlite3/prebuilds/*.node' \
    ! -name "linux-$(node -p process.arch).node" -delete
# import-kuma uses the server's better-sqlite3, which Next keeps under a
# hashed name. Give it its own name too.
RUN cd .next/standalone/node_modules \
    && ln -s .pnpm/better-sqlite3@*/node_modules/better-sqlite3 better-sqlite3 \
    && test -f better-sqlite3/package.json

FROM node:22-trixie-slim AS run
LABEL org.opencontainers.image.title="statoss-standalone" \
      org.opencontainers.image.description="Self-hosted status page in one container: uptime checks, SQLite storage, a public page for each site, and alerts." \
      org.opencontainers.image.source="https://github.com/kroqdotdev/statoss-standalone" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
# Everything the app keeps lives in /data: the configuration it reads
# (/data/config.yaml), the incident files (/data/incidents) and the SQLite
# database (/data/status.db).
# Host lookups share libuv's thread pool, four threads unless told. A few
# names that hang would hold up every other check's lookup and add to its
# time, so the pool is larger.
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    CONFIG_PATH=/data/config.yaml \
    DB_PATH=/data/status.db \
    UV_THREADPOOL_SIZE=32
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# import-kuma turns an Uptime Kuma database into a configuration. Node runs
# its TypeScript as it is, so the sources are all it needs.
COPY --chown=node:node scripts/import-kuma.mts ./scripts/
COPY --chown=node:node src/lib/kuma/*.mts ./src/lib/kuma/
RUN printf '#!/bin/sh\nexec node /app/scripts/import-kuma.mts "$@"\n' \
    > /usr/local/bin/import-kuma && chmod 755 /usr/local/bin/import-kuma
# /data belongs to the node user (uid 1000), so a new named volume starts
# out writable. A bind-mounted directory must be writable by uid 1000 too.
RUN mkdir /data && chown node:node /data
# Debian's security fixes reach the Node image only when it is rebuilt, so
# they are installed here. Then ping, for ping monitors: setuid, so the node
# user can send an echo on hosts that do not open ICMP sockets to every group.
# A build cache would keep an old upgrade; the image workflow passes a new
# PACKAGES_CHECKED on every build, so this step runs each time.
ARG PACKAGES_CHECKED=never
RUN echo "packages checked: ${PACKAGES_CHECKED}" && apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends iputils-ping \
    && rm -rf /var/lib/apt/lists/* \
    && chmod u+s "$(command -v ping)"
# npm, corepack and yarn come with the Node image and never run here; they
# go, with the vulnerabilities in their own dependencies.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg
VOLUME ["/data"]
USER node
EXPOSE 3000
# There is no health route. Any HTTP answer means the server is up: an
# unknown Host gets a 404, which is fine here. Only a connection failure or
# a 5xx marks the container bad.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/').then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server.js"]
