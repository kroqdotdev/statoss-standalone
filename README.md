# statoss-standalone

[![CI](https://github.com/kroqdotdev/statoss-standalone/actions/workflows/ci.yml/badge.svg)](https://github.com/kroqdotdev/statoss-standalone/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A self-hosted status page in one container. It checks your URLs every minute, stores every result in SQLite, and serves a public page for each site on its own hostname.

![The status page for one site with two checkpoints](docs/screenshot.png)

## Features

- **Every failed check is visible.** Each checkpoint has a strip of bars. Bar height is response time. A mark at the top of a bar shows the failed checks in that time slot: amber for a timeout, red for any other failure. One failed check out of 1,440 in a day still gets a visible mark.
- **Three views.** The last 24 hours in 5-minute slots, 7 days in 1-hour slots, or 90 days in 1-day slots. Point at a bar, or use the arrow keys, to read the numbers for one slot.
- **Failed checks are listed.** Consecutive failures are grouped into runs. Each run shows the reason (timeout, HTTP status, or connection error), when it started, and how long the checkpoint did not respond.
- **Email alerts.** One email when a checkpoint goes down, one when it recovers. Alerts are optional.
- **One YAML file.** No admin interface, no accounts, no external services.
- **One process.** A Next.js server with an embedded checker and a SQLite file. Deploy it with Docker Compose behind any reverse proxy.

## How it works

You list sites in `config.yaml`. Each site has a hostname and one or more checkpoints. A checkpoint is a URL and, optionally, the HTTP status you expect.

The checker runs inside the server process:

1. Every `checkIntervalSeconds`, it requests every checkpoint URL with a 10-second timeout.
2. A check passes on a 2xx response, or on the exact `expectStatus` if you set one.
3. A checkpoint becomes **down** after 2 failed checks in a row and **up** again after 1 successful check. Each change of state sends one email, if alerts are configured.
4. Results are kept for 90 days. Older rows are deleted once a day.

The server reads the `Host` header of each request and shows the site with the matching hostname. Any other hostname gets a 404. All times on the page are UTC.

## Requirements

- Docker with Docker Compose, to run it.
- A reverse proxy that terminates TLS, for example Caddy or nginx.
- Node.js 22 and pnpm, only if you want to develop it.

## Quick start with Docker

1. Clone the repository and enter it.
2. Create the data directory and the configuration:

   ```sh
   mkdir data
   cp config.example.yaml data/config.yaml
   ```

3. Edit `data/config.yaml`. The example file explains every field.
4. If you use email alerts, put the SMTP password in `.env`:

   ```sh
   echo 'SMTP_PASS=your-password' > .env
   ```

5. Build and start the container:

   ```sh
   sudo chown -R 1000:1000 data
   docker compose up -d --build
   ```

The container listens on `127.0.0.1:3000` and runs as the `node` user (user ID 1000), so the `data` directory must be writable by that user.

6. Point your reverse proxy at it. For Caddy, add one block for each site:

   ```
   status.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

7. Create a DNS record for each status hostname.

Open `https://status.example.com` to see the page.

## Configuration

`config.yaml` is read once at startup. Restart the container after you change it.

| Field                                | Required | Default | Description                                                      |
| ------------------------------------ | -------- | ------- | ---------------------------------------------------------------- |
| `checkIntervalSeconds`               | no       | `60`    | Seconds between checks. Minimum 10.                              |
| `alerts.smtp.host`                   | no       |         | SMTP server. Omit the whole `alerts` block to disable email.     |
| `alerts.smtp.port`                   | no       |         | `465` uses TLS from the start. Other ports require STARTTLS.     |
| `alerts.smtp.user`                   | no       |         | SMTP login. The password comes from the `SMTP_PASS` variable.    |
| `alerts.smtp.from`                   | no       |         | Sender address.                                                  |
| `alerts.smtp.to`                     | no       |         | Recipient address.                                               |
| `sites[].name`                       | yes      |         | Shown in the headline, for example `example.com is up.`          |
| `sites[].host`                       | yes      |         | Hostname that serves this site's page. Must be unique.           |
| `sites[].checkpoints[].name`         | yes      |         | Shown above the strip. Must be unique within the site.           |
| `sites[].checkpoints[].url`          | yes      |         | The URL to request.                                              |
| `sites[].checkpoints[].expectStatus` | no       | any 2xx | The check passes only on this exact status. 3xx is not followed. |

Environment variables:

| Variable      | Default            | Description                             |
| ------------- | ------------------ | --------------------------------------- |
| `SMTP_PASS`   |                    | SMTP password, only needed with alerts. |
| `CONFIG_PATH` | `./config.yaml`    | Path of the configuration file.         |
| `DB_PATH`     | `./data/status.db` | Path of the SQLite database.            |
| `PORT`        | `3000`             | Port the server listens on.             |

The Docker image sets `CONFIG_PATH=/data/config.yaml` and `DB_PATH=/data/status.db`. Docker Compose mounts `./data` there.

Renaming a checkpoint starts a new history under the new name. The old rows stay until they are 90 days old.

## Operate it

- **Change the configuration:** edit `data/config.yaml`, then run `docker compose restart`.
- **Change `.env`:** run `docker compose up -d`. A restart alone does not load new environment variables.
- **Update to a new version:** pull the new code, then run `docker compose up -d --build`.
- **Check health:** `docker compose ps` shows `healthy` when the server answers requests.
- **Back up:** copy `data/status.db` while the container is stopped, or use `sqlite3 data/status.db ".backup backup.db"` while it runs.

## Develop it

```sh
pnpm install
cp config.example.yaml config.yaml
pnpm dev
```

The dev server picks the site by hostname, so request it with a `Host` header:

```sh
curl -H 'Host: status.example.com' http://localhost:3000/
```

Or set `host: localhost` for one site in `config.yaml` and open <http://localhost:3000> in a browser.

Useful commands:

| Command             | What it does                        |
| ------------------- | ----------------------------------- |
| `pnpm test`         | Runs the unit tests.                |
| `pnpm lint`         | Runs ESLint.                        |
| `pnpm format`       | Formats all files with Prettier.    |
| `pnpm format:check` | Fails if any file is not formatted. |
| `pnpm build`        | Builds the production server.       |

[docs/architecture.md](docs/architecture.md) describes how the pieces fit together.

## Contribute

Bug reports, questions, and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to set up the project and what a good pull request looks like. Please follow the [code of conduct](CODE_OF_CONDUCT.md).

To report a security problem, follow [SECURITY.md](SECURITY.md). Do not open a public issue for it.

## License

MIT. See [LICENSE](LICENSE).
