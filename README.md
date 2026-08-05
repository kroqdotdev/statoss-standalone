# status-page

Self-hosted status page for multiple sites. One Next.js app + SQLite; an embedded
checker hits every configured checkpoint on an interval, records uptime and latency,
and emails on state changes. Each site is served on its own hostname.

## Configuration

Sites, checkpoints, and SMTP settings live in `config.yaml` (see the file in this
repo for the format). The SMTP password is read from the `SMTP_PASS` environment
variable — locally from the gitignored `.env` file.

- A checkpoint passes on a 2xx response (or exactly `expectStatus` if set).
- A checkpoint is marked down after 2 consecutive failures and up on the first success.
- One email per transition (down / recovered).

## Development

```bash
pnpm install
pnpm dev        # http://localhost:3000 — send a Host header to select a site:
                # curl -H 'Host: status.webhooks.cc' http://localhost:3000/
pnpm test
pnpm lint
```

## Deployment (VPS with Caddy)

1. On the VPS, clone the repo and create the data directory:

   ```bash
   mkdir -p data
   cp config.yaml data/config.yaml     # edit as needed on the server
   echo 'SMTP_PASS=...' > .env
   docker compose up -d --build
   ```

   The container listens on `127.0.0.1:3000` and keeps its config and SQLite
   database in `./data`. After editing `data/config.yaml`, restart:
   `docker compose restart`. Note that `docker compose restart` re-reads
   `data/config.yaml`, but a changed `SMTP_PASS` in `.env` requires
   `docker compose up -d` to take effect.

2. Add one block per site to your Caddyfile (Caddy terminates TLS and routes by
   hostname; the app picks the site from the `Host` header):

   ```
   status.webhooks.cc {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   Reload Caddy: `sudo systemctl reload caddy` (or `caddy reload`).

3. Point DNS for each `status.<domain>` at the VPS.

## Adding a site or checkpoint

Edit `data/config.yaml` (add the site with its `host` and checkpoints), restart the
container, then add the matching Caddyfile block and DNS record.
