# Status Page — Design

Date: 2026-08-05
Status: Approved

## Purpose

A self-hosted status page for the user's own sites, running on a small VPS behind an existing Caddy instance. Each site gets its own status page served on its own hostname (e.g. `status.webhooks.cc`), and each site can have multiple checkpoints (e.g. webhooks.cc checks both `https://webhooks.cc` and `https://go.webhooks.cc`).

## Architecture

A single Next.js (App Router, TypeScript) application containing both the public status pages and an embedded background checker. The checker starts from `instrumentation.ts` when the Next server boots and runs on an interval inside the same process. Storage is a local SQLite database. One process to deploy and supervise.

- **Stack:** Next.js via pnpm, Tailwind CSS, `better-sqlite3`, `nodemailer`, zod (config validation).
- **Tooling:** ESLint and Prettier configured from the start; Vitest for tests.

## Configuration

All sites, checkpoints, and alert settings live in a `config.yaml` read at startup and validated with zod (fail fast with a clear error on invalid config). Adding a site is an edit + restart — no rebuild, no admin UI.

```yaml
checkIntervalSeconds: 60 # optional, default 60
alerts:
  smtp:
    host: smtp.example.com
    port: 587
    user: alerts@example.com
    from: alerts@example.com
    to: kroqdotdev@users.noreply.github.com
  # SMTP password is provided via the SMTP_PASS environment variable
sites:
  - name: webhooks.cc
    host: status.webhooks.cc # hostname this site's page is served under
    checkpoints:
      - name: Main site
        url: https://webhooks.cc
      - name: Redirector
        url: https://go.webhooks.cc
        expectStatus: 200 # optional; default is any 2xx
```

The `alerts` block is optional; without it the app is display-only.

## Checker

- Runs inside the Next server process, started from `instrumentation.ts` (Node runtime), guarded with a `globalThis` flag so dev hot-reload does not start it twice.
- Every `checkIntervalSeconds`, fetch each checkpoint URL with a 10-second timeout. Record `ok`, `status_code`, `latency_ms`, and `error` (timeout / connection error / unexpected status) to SQLite.
- A check passes when the response status is 2xx, or exactly `expectStatus` when configured.
- **State machine:** a checkpoint transitions to **down** after 2 consecutive failures and back to **up** on the first success. Transitions drive email alerts; a single failed check changes nothing visible except the recorded result.
- Raw check rows older than 90 days are pruned (once per day, from the same loop).

## Storage (SQLite)

Two tables:

- `checks` — append-only results: `id`, `site`, `checkpoint`, `ts`, `ok`, `status_code`, `latency_ms`, `error`. Indexed on `(site, checkpoint, ts)`.
- `checkpoint_state` — one row per checkpoint: current status (`up`/`down`), consecutive-failure count, timestamp the current state began. Used for transition detection and outage-duration reporting.

Daily uptime percentages for the history bars are computed by query from `checks` (the index makes this cheap at this scale: ~1,440 checks/day/checkpoint, ≤90 days retained).

Checkpoints are identified by their configured site + checkpoint names. Renaming a checkpoint in config starts a fresh history for the new name; old rows age out via pruning.

## Pages

- The root page resolves the requesting `Host` header against `sites[].host` and renders that site's status page only. Unknown hostnames get a plain 404.
- Page content, per site:
  - Overall banner: "All systems operational" when every checkpoint is up, otherwise "Partial outage" (or "Major outage" when all are down).
  - Per checkpoint: name, current status, the 90-day uptime bar strip (one bar per day with daily uptime %, tooltip on hover), and a latency chart of the last 24 hours rendered as lightweight inline SVG — no chart library.
- Pages render dynamically (they depend on the `Host` header); the client re-fetches data every 60 seconds so an open tab stays current.

## Email alerts

Via `nodemailer` using the configured SMTP settings:

- On a **down** transition (2nd consecutive failure): site, checkpoint, URL, and the error detail.
- On **recovery**: same, plus the duration of the outage.
- One email per transition — no repeats while a checkpoint stays down.
- Send failures are logged and never crash the checker.

## Deployment

- Docker image built from Next's standalone output; the container listens on `:3000`.
- A `docker-compose.yml` in the repo mounts a volume containing `config.yaml` and the SQLite database file, and passes `SMTP_PASS`.
- Caddy runs on the host as today. The repo documents a Caddyfile snippet: one `status.<domain>` site block per configured site, each `reverse_proxy localhost:3000`. Caddy provides TLS per hostname; the app distinguishes sites by the forwarded `Host` header.

## Testing

Vitest units for:

- State-transition logic (down after 2 consecutive failures, recovery on first success, alert firing exactly on transitions).
- Config parsing/validation (valid config accepted, missing/invalid fields rejected with useful messages).
- Daily-uptime aggregation (known check rows in, expected daily percentages out).
- The HTTP check function against a local mock server (2xx pass, non-2xx fail, `expectStatus` handling, timeout).

## Out of scope (v1)

- Admin UI (config file only)
- Incident / maintenance posts
- Keyword or content-match checks
- Alert channels other than email
- Combined all-sites overview page
