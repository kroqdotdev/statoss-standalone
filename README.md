# status-page

A self-hosted status page for your websites.

The application is one Next.js server with an embedded uptime checker and a SQLite database. The checker sends an HTTP request to each configured URL at a set interval. The public page shows the results.

- Uptime bars for the last 90 days, one bar for each day
- A latency chart for the last 24 hours
- One status page for each site, served on its own hostname
- Optional email alerts when a checkpoint goes down and when it recovers
- One YAML configuration file, no admin interface, no external services

## How it works

You define sites in `config.yaml`. Each site has a hostname and one or more checkpoints. A checkpoint is a URL and an optional expected HTTP status.

The checker runs inside the server process. A check passes on a 2xx response, or on the exact `expectStatus` value if you set one. A checkpoint becomes **down** after 2 failed checks in a row. It becomes **up** again after 1 successful check. The application sends one email for each change of state. The database keeps 90 days of results.

The server reads the `Host` header of each request. It shows the site with the matching hostname. It returns 404 for all other hostnames.

## Requirements

- Node.js 22 and pnpm, for development
- Docker with Docker Compose, for deployment
- A reverse proxy that terminates TLS, for example Caddy

## Configuration

1. Copy `config.example.yaml` to `config.yaml`.
2. Change the values. The example file explains each field.

To enable email alerts, keep the `alerts` block and set the `SMTP_PASS` environment variable. To disable email alerts, remove the `alerts` block.

## Development

1. Install the dependencies: `pnpm install`
2. Create your configuration: `cp config.example.yaml config.yaml`
3. Start the server: `pnpm dev`
4. Open a site with its hostname: `curl -H 'Host: status.example.com' http://localhost:3000/`

Run the tests with `pnpm test`. Run the linter with `pnpm lint`.

## Deployment

1. Clone the repository on your server.
2. Create the data directory: `mkdir data`
3. Create the configuration: `cp config.example.yaml data/config.yaml` and change the values.
4. If you use email alerts, write the SMTP password to `.env`: `echo 'SMTP_PASS=your-password' > .env`
5. Build and start the container: `docker compose up -d --build`

The container listens on `127.0.0.1:3000`. It keeps the configuration and the database in `./data`.

Add one block for each site to your Caddyfile:

```
status.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Then reload Caddy: `sudo systemctl reload caddy`

Point the DNS record of each status hostname at your server.

**Note:** After a change to `data/config.yaml`, run `docker compose restart`. After a change to `.env`, run `docker compose up -d`. A restart alone does not apply `.env` changes.

## Add a site

1. Add the site with its `host` and its checkpoints to `data/config.yaml`.
2. Restart the container: `docker compose restart`
3. Add the matching block to your Caddyfile and reload Caddy.
4. Add the DNS record.

## License

MIT. See [LICENSE](LICENSE).
