# Architecture

statoss-standalone is one Node.js process. It contains a Next.js server for the public pages, a checker that runs on a timer, and a SQLite database on disk.

```
config.yaml ──► scheduler ──► checker ──► checks table ──► queries ──► page, status.json, badges
                    │                          │
                    ├──► checkpoint_state ─────┴──► alerts (email, Slack, Discord, webhook)
                    └──► auto_incident ──┐
incidents/*.md, *.yaml ──────────────────┴──► incidents ──► page, feed.xml
```

## Files

| Path                        | Job                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/instrumentation.ts`    | Starts the scheduler when the server boots.                                                                   |
| `src/lib/config.ts`         | Reads and validates `config.yaml` with zod. Fails fast on a bad file.                                         |
| `src/lib/scheduler.ts`      | Runs one tick per interval: check every checkpoint, store, update state, alert. Never runs two ticks at once. |
| `src/lib/checker.ts`        | Requests one URL with a timeout and reports pass or fail with the reason.                                     |
| `src/lib/state.ts`          | The up/down state machine and the roll-up into one site status.                                               |
| `src/lib/db.ts`             | Opens SQLite, creates the schema, inserts checks, reads and writes state.                                     |
| `src/lib/queries.ts`        | Reads for the page: bucketed series, window totals, runs of failed checks.                                    |
| `src/lib/cache.ts`          | Caches page data per scheduler tick.                                                                          |
| `src/lib/alerts.ts`         | The words of an alert, and delivery to email, Slack, Discord and a signed webhook.                            |
| `src/lib/incidents.ts`      | Incident files, maintenance windows and automatic incidents, and which of them the page shows.                |
| `src/lib/incident-files.ts` | Reads the incidents folder, again whenever a file changes.                                                    |
| `src/lib/status-data.ts`    | Gathers what a page or endpoint needs for one site: checkpoint views and incidents.                           |
| `src/lib/public-feeds.ts`   | status.json, the badges, the RSS feed and the widget script.                                                  |
| `src/lib/site-routes.ts`    | The route handlers for those endpoints, picking the site by `Host` header.                                    |
| `src/lib/format.ts`         | Text helpers: durations, UTC times, error labels.                                                             |
| `src/app/page.tsx`          | The status page. Picks the site by `Host` header.                                                             |
| `src/app/*/route.ts`        | `status.json`, `badge.svg`, `badge.json`, `feed.xml` and `widget.js`.                                         |
| `src/components/`           | The headline, incidents, range switch, groups, check strip, and failed-check list.                            |

## Database

Three tables, created on first start. A database from the first release gets the columns added since on the next start; `openDb` checks `PRAGMA table_info` and runs `ALTER TABLE ADD COLUMN` for each one missing.

- `checks`: one row per check with `site`, `checkpoint`, `ts`, `ok`, `status_code`, `latency_ms`, `error`, and `maintenance`, which is 1 for a check made inside a maintenance window. Indexed on `(site, checkpoint, ts)` and on `ts`.
- `checkpoint_state`: one row per checkpoint with the current `status` (`up`, `slow` or `down`), the counts of consecutive failures and consecutive slow responses, `since`, the time the current status began, and `last_alert_at`, for repeat notices.
- `auto_incident`: one row per outage the checker saw, with `started_at`, `resolved_at` and the first error.

Rows in `checks` older than 90 days, and resolved outages that old, are deleted once a day.

## State machine

A checkpoint starts as **up**. It becomes **down** after 2 failed checks in a row and **up** again after 1 successful check. With a slow threshold it becomes **slow** after 2 successful checks over the threshold and **up** again after 1 under it; a checkpoint that recovers from down with a slow response is up first, so the recovery is reported, and turns slow on the next slow check. Only these transitions send an alert, so a flapping checkpoint sends one pair of alerts per outage, not one per check. A single failed check changes nothing except the stored row, which the page still shows. Slowness is judged at query time against the threshold in force now, so changing the threshold recolours history.

A check made inside a maintenance window is stored with the `maintenance` flag and goes no further: no state change, no alert, no incident.

## Incidents

The page merges three sources: files in the incidents folder, maintenance windows from the configuration, and the `auto_incident` rows the scheduler writes. The folder is listed on every request and the files are parsed again only when a name, size or modification time has changed. An open incident with an impact raises the headline above what the checks say; it never lowers it.

## Queries

The page never reads raw rows. Three queries do the work, each scoped to one checkpoint and one time window:

- **Bucketed series** groups checks into slots of 5 minutes, 1 hour, or 1 day and returns the count, the successes, the timeouts, and the mean response time of the successful checks. Slots align to multiples of the slot length since the epoch, so daily slots start at UTC midnight.
- **Window totals** returns the same numbers for the whole window.
- **Failed runs** groups consecutive failures with a window function: a running count of successful checks gives every failure between two successes the same group number. The query also finds the first success after each run, which gives the duration.

Results are cached in memory and keyed by site, checkpoint, and range. The scheduler bumps a version number after every tick, and the cache recomputes only when the version has changed. A request between ticks costs a few milliseconds.

## Rendering

The page is a server component. It reads the `Host` header and the `range` query parameter, runs the queries, and renders everything except the check strip on the server. The strip is a client component so that it can show the readout for the slot under the pointer or keyboard focus. Times are formatted in UTC on the server, so the HTML is the same on the server and the client.

The page refreshes itself every check interval while its tab is visible.

The endpoints next to the page are route handlers that share the same data: `status.json` and the badges read the current states and open incidents, `feed.xml` reads the incidents, and `widget.js` is a fixed script that fetches `status.json` from the origin it was loaded from.

## Deployment

The Docker image is built from Next's standalone output and runs as the `node` user with a health check. Docker Compose mounts `./data` at `/data` for the configuration and the database. A reverse proxy terminates TLS and forwards the `Host` header, which is how one container serves many sites.
