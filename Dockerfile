FROM node:22-trixie-slim AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
# pnpm's build-approval step invokes node-gyp for better-sqlite3 (it has
# "gypfile": true) even though the published package ships only prebuilt
# binaries in prebuilds/ — node-gyp still needs python3/make/g++ present to
# get through its bootstrap. The prebuilt binaries themselves require glibc
# >= 2.38, so the base image is Debian trixie (glibc 2.41), not bookworm
# (glibc 2.36, too old — causes an ERR_DLOPEN_FAILED at runtime).
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
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
