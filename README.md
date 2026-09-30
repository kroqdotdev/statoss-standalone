# statoss-standalone

[![CI](https://github.com/kroqdotdev/statoss-standalone/actions/workflows/ci.yml/badge.svg)](https://github.com/kroqdotdev/statoss-standalone/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A self-hosted status page in one container. It checks your URLs, ports, DNS records, certificates, domains and scheduled jobs every minute, stores every result in SQLite, and serves a public page for each site on its own hostname, with incidents, maintenance windows, alerts to email, Slack, Discord and webhooks, and a JSON, badge, RSS and widget endpoint next to every page.

![The status page for one site with two monitors](docs/screenshot.png)

## Features

- **Every failed check is visible.** Each monitor has a strip of bars. Bar height is response time. A mark at the top of a bar shows the failed checks in that time slot: amber for a timeout, red for any other failure. One failed check out of 1,440 in a day still gets a visible mark.
- **Three views.** The last 24 hours in 5-minute slots, 7 days in 1-hour slots, or 90 days in 1-day slots. Point at a bar, or use the arrow keys, to read the numbers for one slot.
- **Failed checks are listed.** Consecutive failures are grouped into runs. Each run shows the reason (timeout, HTTP status, keyword, or connection error), when it started, and how long the monitor did not respond.
- **Seven kinds of monitor.** HTTP, TCP port, DNS, ping, certificate expiry, domain expiry, and a heartbeat that a scheduled job pings.
- **Any request.** An HTTP monitor can use any method, send headers and a body, expect an exact status, and require a keyword in the response, or require its absence.
- **Slow is a state.** Give a monitor a threshold and it turns slow after two slow responses and back after one fast one. Slow buckets are drawn in indigo under a dashed line at the threshold.
- **Groups.** Monitors with the same group name are shown together under one heading with a one-line summary.
- **Incidents and maintenance.** Write incidents as Markdown or YAML files in a folder; the page picks them up without a restart. Plan maintenance windows in the configuration: checks during a window are shown but not counted, and no alert goes out. A monitor that goes down opens an incident by itself and resolves it on recovery.
- **Alerts where you are.** Email, Slack, Discord, and a signed webhook, per site or for all of them, with an optional repeat while a monitor stays down.
- **Endpoints for machines.** `status.json`, `badge.svg` and `badge.json` for shields.io, `feed.xml`, and `widget.js` to embed a live status dot anywhere.
- **One YAML file.** No admin interface, no accounts, no external services.
- **One process.** A Next.js server with an embedded checker and a SQLite file. Deploy it with Docker Compose behind any reverse proxy.

## How it works

You list sites in `config.yaml`. Each site has a hostname and one or more monitors. A monitor has a type, `http` unless you say otherwise. An HTTP monitor is a URL and, optionally, the method, headers and body to send, the HTTP status you expect, a keyword the response must contain, a slow threshold, and a group. The other types are described under [Monitor types](#monitor-types).

The checker runs inside the server process:

1. Every `checkIntervalSeconds`, it runs every monitor that is due, with a 10-second timeout. A monitor with `intervalSeconds` runs less often. The checks of one round are spread over the first three quarters of the interval (45 seconds at most) so that they do not slow each other down.
2. An HTTP check passes on a 2xx response, or on the exact `expectStatus` if you set one, and, with a `keyword`, only when the body contains it (or does not, with `keywordMode: absent`). Bodies are read up to 1 MB.
3. A monitor becomes **down** after 2 failed checks in a row and **up** again after 1 successful check. With a `slowThresholdMs`, it becomes **slow** after 2 successful checks over the threshold and back to normal after 1 under it. Each change of state sends one alert to every destination of the site. With `repeatMinutes`, a monitor that stays down sends a "still down" notice at that interval.
4. A monitor going down opens an incident on the page; the first success after it resolves the incident.
5. Checks made inside a maintenance window are stored with a flag. The page shows them in grey and leaves them out of every total, and they change no state and send no alert.
6. Results are kept for 90 days. Older rows are deleted once a day.

The server reads the `Host` header of each request and shows the site with the matching hostname. Any other hostname gets a 404. All times on the page are UTC.

## Requirements

- Docker, to run it. Docker Compose is optional.
- A reverse proxy that terminates TLS, for example Caddy or nginx.
- Node.js 22 and pnpm, only if you want to develop it.

## Quick start

A ready image is published for linux/amd64 and linux/arm64:

```
ghcr.io/kroqdotdev/statoss-standalone
```

`latest` follows the main branch. Releases are also tagged by version, for example `1.2.3`, `1.2` and `1`. Every build is tagged `sha-` and the short commit hash.

The container runs as the `node` user (user ID 1000). It reads `/data/config.yaml`, reads incidents from `/data/incidents`, and keeps its database in `/data/status.db`.

### Run the image with docker run

1. Download the example configuration and edit it. The file explains every field.

   ```sh
   curl -o config.yaml https://raw.githubusercontent.com/kroqdotdev/statoss-standalone/main/config.example.yaml
   ```

2. Start the container:

   ```sh
   docker run -d --name statoss --restart unless-stopped -p 127.0.0.1:3000:3000 -v "$PWD/config.yaml:/data/config.yaml:ro" -v statoss-data:/data ghcr.io/kroqdotdev/statoss-standalone:latest
   ```

The database is kept in the `statoss-data` volume. For email alerts, add `-e SMTP_PASS=your-password`. To write incident files on the host, create an `incidents` folder and add `-v "$PWD/incidents:/data/incidents:ro"`.

### Run the image with Docker Compose

1. Create a folder for it with a `data` directory and the example configuration:

   ```sh
   mkdir -p statoss/data && cd statoss
   curl -o data/config.yaml https://raw.githubusercontent.com/kroqdotdev/statoss-standalone/main/config.example.yaml
   ```

2. Edit `data/config.yaml`. The example file explains every field.
3. Save this as `docker-compose.yml`:

   ```yaml
   services:
     statoss:
       image: ghcr.io/kroqdotdev/statoss-standalone:latest
       restart: unless-stopped
       ports:
         - "127.0.0.1:3000:3000"
       environment:
         - SMTP_PASS=${SMTP_PASS}
       volumes:
         - ./data:/data
   ```

4. If you use email alerts, put the SMTP password in `.env`:

   ```sh
   echo 'SMTP_PASS=your-password' > .env
   ```

   Any other secret the configuration refers to as `${NAME}` goes in `.env` too, and in the `environment` list of `docker-compose.yml`, so the container can see it.

5. Make the `data` directory writable by user ID 1000 and start the container:

   ```sh
   sudo chown -R 1000:1000 data
   docker compose up -d
   ```

### Build from source

1. Clone the repository and enter it.
2. Create the data directory and the configuration, then edit `data/config.yaml`:

   ```sh
   mkdir data
   cp config.example.yaml data/config.yaml
   ```

3. Put secrets in `.env` as in the Compose steps above.
4. Build and start the container. `docker-compose.build.yml` adds the build to the Compose file in the repository.

   ```sh
   sudo chown -R 1000:1000 data
   docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
   ```

### Put it online

The container listens on `127.0.0.1:3000`.

1. Point your reverse proxy at it. For Caddy, add one block for each site:

   ```
   status.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

2. Create a DNS record for each status hostname.

Open `https://status.example.com` to see the page.

## Configuration

`config.yaml` is read once at startup. Restart the container after you change it. Write `${NAME}` anywhere in the file to use the environment variable `NAME`; an unset variable is an error.

| Field                                | Required | Default          | Description                                                                                       |
| ------------------------------------ | -------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `checkIntervalSeconds`               | no       | `60`             | Seconds between checks. Minimum 10.                                                               |
| `alerts.smtp.host`                   | no       |                  | SMTP server. Needed for email destinations.                                                       |
| `alerts.smtp.port`                   | no       |                  | `465` uses TLS from the start. Other ports require STARTTLS.                                      |
| `alerts.smtp.user`                   | no       |                  | SMTP login. The password comes from the `SMTP_PASS` variable.                                     |
| `alerts.smtp.from`                   | no       |                  | Sender address.                                                                                   |
| `alerts.smtp.to`                     | no       |                  | A shorthand for one email destination in `alerts.to`.                                             |
| `alerts.to[]`                        | no       | `[]`             | Destinations for every site without a list of its own. See below.                                 |
| `alerts.repeatMinutes`               | no       | `0`              | Minutes between "still down" notices while a monitor stays down. `0` sends none.                  |
| `sites[].name`                       | yes      |                  | Shown in the headline, for example `example.com is up.`                                           |
| `sites[].host`                       | yes      |                  | Hostname that serves this site's page. Must be unique.                                            |
| `sites[].url`                        | no       | `https://<host>` | Where alerts and feeds link to.                                                                   |
| `sites[].alerts`                     | no       |                  | `false` to send no alerts for this site, or an object with `to` and `repeatMinutes` for it alone. |
| `sites[].monitors[].name`            | yes      |                  | Shown above the strip. Must be unique within the site.                                            |
| `sites[].monitors[].type`            | no       | `http`           | `http`, `tcp`, `dns`, `ping`, `certificate`, `domain` or `heartbeat`. See Monitor types.          |
| `sites[].monitors[].url`             | for http |                  | The URL to request.                                                                               |
| `sites[].monitors[].intervalSeconds` | no       |                  | Seconds between this monitor's checks, when longer than `checkIntervalSeconds`.                   |
| `sites[].monitors[].group`           | no       |                  | Monitors with the same group are shown together.                                                  |
| `sites[].monitors[].method`          | no       | `GET`            | `GET`, `HEAD`, `POST`, `PUT`, `PATCH` or `DELETE`.                                                |
| `sites[].monitors[].headers`         | no       |                  | Request headers, as a map.                                                                        |
| `sites[].monitors[].body`            | no       |                  | Request body, sent as-is with every method but `GET` and `HEAD`.                                  |
| `sites[].monitors[].expectStatus`    | no       | any 2xx          | The check passes only on this exact status. 3xx is not followed.                                  |
| `sites[].monitors[].keyword`         | no       |                  | Text the response body must contain.                                                              |
| `sites[].monitors[].keywordMode`     | no       | `present`        | `absent` fails the check when the keyword is found.                                               |
| `sites[].monitors[].slowThresholdMs` | no       |                  | A successful response slower than this counts as slow. At most 9999. For http, tcp, dns and ping. |
| `sites[].maintenance[].title`        | yes      |                  | Shown on the page while the window is planned, running, or in the last 30 days.                   |
| `sites[].maintenance[].start`, `end` | yes      |                  | ISO 8601. A date and time without a zone is read as UTC.                                          |
| `sites[].maintenance[].monitors`     | no       | all              | Names of the monitors the window covers.                                                          |
| `sites[].maintenance[].notes`        | no       |                  | A sentence or two, shown under the title.                                                         |

A configuration written for 0.1 that says `checkpoints` where this one says `monitors` still works.

### Monitor types

Every type but `http` takes a `host` instead of a `url`. A field that does not belong to a monitor's type is an error.

| Type          | Fields                                   | Passes when                                                                                                                       |
| ------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `http`        | `url` and the request options above      | The response has a 2xx status, or the one you expect, and the keyword matches.                                                    |
| `tcp`         | `host`, `port`                           | The port accepts a connection.                                                                                                    |
| `dns`         | `host`, `record` (default `A`), `expect` | The name has a record of that type (`A`, `AAAA`, `CNAME`, `MX`, `TXT` or `NS`) and, with `expect`, one answer contains that text. |
| `ping`        | `host`                                   | One ICMP echo is answered. The image carries `ping`; elsewhere a missing `ping` command is reported as such.                      |
| `certificate` | `host`, `port` (default 443), `warnDays` | The TLS certificate is valid for the host and does not expire within `warnDays` (default 14). Checked once an hour at most.       |
| `domain`      | `host`, `warnDays`                       | The registry (through rdap.org) says the domain does not expire within `warnDays` (default 30). Checked every six hours at most.  |
| `heartbeat`   | `token`, `intervalSeconds`               | Your job requested `/heartbeat/<token>` within the last `intervalSeconds`. Nothing is recorded before the first ping.             |

```yaml
monitors:
  - name: Database
    type: tcp
    host: db.example.com
    port: 5432
  - name: Mail records
    type: dns
    host: example.com
    record: MX
    expect: mail.example.com
  - name: Certificate
    type: certificate
    host: example.com
    warnDays: 21
  - name: Nightly backup
    type: heartbeat
    token: ${BACKUP_HEARTBEAT}
    intervalSeconds: 86400
```

A heartbeat is for a job that runs on a schedule. End the job with a request to `https://status.example.com/heartbeat/<token>`, with any method, for example `curl -fsS https://status.example.com/heartbeat/$BACKUP_HEARTBEAT`. The token is at least 8 letters, digits, dashes or underscores, and no two monitors may share one. Set `intervalSeconds` to how often the job runs: the monitor goes down after two intervals in a row without a ping.

Certificate and domain monitors show the date they expire on the page and in `status.json`. They, and heartbeats, have no response time, so their strips are drawn at one height.

A destination is one entry in a `to` list, of one of these shapes:

```yaml
- email: alerts@example.com
- slack: https://hooks.slack.com/services/T000/B000/XXXX
- discord: https://discord.com/api/webhooks/000/XXXX
- webhook: https://example.com/statoss
  secret: ${WEBHOOK_SECRET}
```

The webhook receives a JSON body with `event` (`went-down`, `recovered`, `went-slow`, `back-to-normal` or `still-down`), `site`, `monitor` (also sent as `checkpoint`, its name in 0.1), `url` (what the monitor points at: the URL, `host:port`, or the host), `pageUrl`, `error`, `downSince`, `latencyMs`, `thresholdMs` and `at`, an `X-StatOSS-Event` header, and an `X-StatOSS-Signature` header holding `sha256=` and the hex HMAC-SHA256 of the raw body under the secret.

Environment variables:

| Variable        | Default                        | Description                                         |
| --------------- | ------------------------------ | --------------------------------------------------- |
| `SMTP_PASS`     |                                | SMTP password, only needed with email destinations. |
| `CONFIG_PATH`   | `./config.yaml`                | Path of the configuration file.                     |
| `INCIDENTS_DIR` | `incidents` next to the config | Folder of incident files.                           |
| `DB_PATH`       | `./data/status.db`             | Path of the SQLite database.                        |
| `PORT`          | `3000`                         | Port the server listens on.                         |

The Docker image sets `CONFIG_PATH=/data/config.yaml` and `DB_PATH=/data/status.db`, so incidents live in `/data/incidents`. Docker Compose mounts `./data` there.

Renaming a monitor starts a new history under the new name. The old rows stay until they are 90 days old.

### Incidents

An incident is one file in the incidents folder (`data/incidents/` with Docker). The folder is read again whenever a file changes, so writing an incident needs no restart. A file that does not parse is logged and skipped. Two forms are accepted:

`2026-09-12-elevated-api-errors.md`, YAML front matter with the post-mortem below it:

```markdown
---
title: Elevated API errors
site: example.com # the site's name or host; optional with one site
started: 2026-09-12T14:05:00Z
impact: partial # none, degraded, partial or major
monitors: [API health]
updates:
  - at: 2026-09-12T14:05:00Z
    status: investigating # investigating, identified, monitoring or resolved
    body: Some API requests are answering with 500.
  - at: 2026-09-12T15:10:00Z
    status: resolved
    body: The connection limit was raised and errors have stopped.
---

The post-mortem, as plain text. Paragraphs are separated by blank lines.
```

Or a `.yaml` file with the same fields and an optional `postmortem` key. An incident is open until an update has the status `resolved` or the file has a `resolved` time. While it is open, its `impact` sets the headline: `partial` says part of the site is down even when every check passes. Open incidents and planned or running maintenance are shown at the top of the page; resolved ones stay in the list at the bottom for 30 days. `incidents.example/` holds the two examples above.

### Endpoints

Next to every page, on the same hostname:

| Path           | What it is                                                                                                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/status.json` | The site's state, every monitor with its status, uptime and mean response time over the last day (also listed as `checkpoints`, their name in 0.1), and current incidents.                                                                               |
| `/badge.svg`   | A badge in the shields.io style. Add `?label=api` to change the left half.                                                                                                                                                                               |
| `/badge.json`  | The same in the [shields.io endpoint format](https://shields.io/badges/endpoint-badge), for a badge shields.io draws.                                                                                                                                    |
| `/feed.xml`    | An RSS feed of incidents and maintenance.                                                                                                                                                                                                                |
| `/widget.js`   | A script that draws a status dot and a link where it is placed: `<script src="https://status.example.com/widget.js"></script>`. Override the words with `data-operational`, `data-degraded`, `data-partial`, `data-major` and `data-unknown` attributes. |

The JSON and badge endpoints allow cross-origin requests.

## Operate it

- **Change the configuration:** edit `data/config.yaml`, then run `docker compose restart`.
- **Open an incident:** add a file to `data/incidents/`. The page shows it on the next request. Edit the file to post updates and to resolve it.
- **Change `.env`:** run `docker compose up -d`. A restart alone does not load new environment variables.
- **Update to a new version:** run `docker compose pull`, then `docker compose up -d`. From source, pull the new code and run the build command again. A database from an older version gets its new columns on the first start.
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
