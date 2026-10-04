# Architecture

statoss-standalone is one Node.js process. It contains a Next.js server for the public pages, a checker that runs on a timer, and a SQLite database on disk.

```
config.yaml ──► scheduler ──► checker ──► checks + check_hour ──► queries ──► page, status.json, badges, /checks
                    │  │                        │
                    │  ├──► monitor_state ──────┴──► alerts (email, Slack, Discord, PagerDuty, Opsgenie, ntfy, webhook)
                    │  ├──► auto_incident ──┐
                    │  └──► vendors (memory)│
incidents/*.md, *.yaml ─────────────────────┴──► incidents ──► page, incident pages, history, feeds, notices
POST /heartbeat/<token> ──► heartbeat         POST /deploys ──► deploy
```

## Files

| Path                           | Job                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/instrumentation.ts`       | Starts the scheduler when the server boots.                                                                                      |
| `src/lib/config.ts`            | Reads and validates `config.yaml` with zod. Fails fast on a bad file.                                                            |
| `src/lib/scheduler.ts`         | Runs one round per interval: the monitors that are due, spread over the round; state, alerts, notices, vendors, the daily tidy.  |
| `src/lib/checker.ts`           | One check of each type (HTTP, TCP, DNS, ping, certificate, domain) with a timeout, reported as pass or fail with the reason.     |
| `src/lib/state.ts`             | The up, slow and down state machine, the roll-up into one site status, and when a state is too old to trust.                     |
| `src/lib/db.ts`                | Opens SQLite, creates and upgrades the schema, and the small reads and writes on it.                                             |
| `src/lib/queries.ts`           | Reads for the page: bucketed series from checks or hourly totals, window totals, runs of failed checks.                          |
| `src/lib/response-times.ts`    | Response times as medians: the bars, the median and the 95th percentile, from checks or from hours.                              |
| `src/lib/hour-figures.ts`      | Gives each hour that is over the median and 95th percentile of its checks.                                                       |
| `src/lib/cache.ts`             | Caches page data per check, or for minutes for the longer views.                                                                 |
| `src/lib/budget.ts`            | The month's error budget.                                                                                                        |
| `src/lib/alerts.ts`            | The words of alerts and notices, and delivery to every channel, with retries.                                                    |
| `src/lib/notices.ts`           | Which incident updates and maintenance stages are due to go to the alert destinations.                                           |
| `src/lib/incidents.ts`         | Incident files, maintenance windows and automatic incidents, and which of them the page shows, in what order.                    |
| `src/lib/maintenance.ts`       | A site's maintenance windows as they fall: the ones written, and the repeats planned a week ahead.                               |
| `src/lib/repeats.ts`           | When a repeating window falls, at its time of day in a zone.                                                                     |
| `src/lib/incident-files.ts`    | Reads the incidents folder, again whenever a file changes.                                                                       |
| `src/lib/incident-history.ts`  | The history's months and pages.                                                                                                  |
| `src/lib/stated.ts`            | What open incidents and maintenance say about each row, beside what its checks say.                                              |
| `src/lib/component-history.ts` | A component's states over time, for its strip.                                                                                   |
| `src/lib/vendors.ts`           | Reads vendors' status pages for the components that follow them, finding each page's platform.                                   |
| `src/lib/vendor-formats.ts`    | Instatus, Better Stack, status.io, Sorry, Heroku and Slack, each read into one shape.                                            |
| `src/lib/vendor-alerts.ts`     | Which components moved with their vendor since they were last noted, and where that is told.                                     |
| `src/lib/check-detail.ts`      | The checks behind one bar.                                                                                                       |
| `src/lib/strip-shapes.ts`      | A strip's bars as one SVG path per colour.                                                                                       |
| `src/lib/status-data.ts`       | Gathers what a page or endpoint needs for one site: monitor and component views, incidents, the budget.                          |
| `src/lib/public-feeds.ts`      | status.json, the badges, the RSS and Atom feeds, the maintenance calendar and the widget script.                                 |
| `src/lib/ics.ts`               | iCalendar text: escaping, folding and the calendar around the events.                                                            |
| `src/lib/site-routes.ts`       | The route handlers for those endpoints and the others, picking the site by `Host` header and checking the password.              |
| `src/lib/access.ts`            | Password pages: the unlock cookie, the embed key, the brake on guessing.                                                         |
| `src/lib/assets.ts`            | Logos and favicons read from next to the configuration.                                                                          |
| `src/lib/accent.ts`            | Readable shades of a site's accent colour.                                                                                       |
| `src/lib/mcp.ts`               | A stateless MCP server and the three tools it offers.                                                                            |
| `src/lib/format.ts`            | Text helpers: durations, times in a zone, error labels.                                                                          |
| `src/lib/viewer-zone.tsx`      | The visitor's time zone, in the browser.                                                                                         |
| `src/app/page.tsx`             | The status page. Picks the site by `Host` header.                                                                                |
| `src/app/incidents/[id]`       | An incident's or a window's own page.                                                                                            |
| `src/app/history`              | Incidents by month.                                                                                                              |
| `src/app/*/route.ts`           | The endpoints: `status.json`, badges, feeds, `widget.js`, `checks`, `deploys`, `mcp`, `llms.txt`, `heartbeat`, `unlock`, `logo`. |
| `src/components/`              | The headline, incidents, range switch, groups, check strip and its panel, components, vendors, the password form.                |
| `e2e/`                         | The browser journeys, their seed and the server their monitors check.                                                            |
| `src/lib/kuma/`                | The Uptime Kuma importer, run by `scripts/import-kuma.mts`. See [uptime-kuma.md](uptime-kuma.md).                                |

## Database

Created on first start. A database from an earlier release gets the tables and columns added since on the next start; `openDb` checks `PRAGMA table_info` and runs `ALTER TABLE ADD COLUMN` for each one missing, and fills in `check_hour` from `checks` when it is empty.

- `checks`: one row per check with `site`, `monitor`, `ts`, `ok`, `status_code`, `latency_ms` (null for types without a response time), `error`, and `maintenance`, which is 1 for a check made inside a maintenance window. Kept for `retentionDays`.
- `check_hour`: one row per monitor and hour with the counts (`total`, `up`, `timeouts`, `slow`, `maintenance`), the sum and number of response times, and their median and 95th percentile (`latency_p50`, `latency_p95`). Every check is added to its hour in the same transaction that stores it. The median and 95th percentile are taken from the checks after each round, five minutes after the hour ends, and cleared if a response time lands in the hour later; an hour without them is read as its mean. Kept for 400 days; the 7-day, 90-day and 1-year views and the error budget read it.
- `monitor_state`: one row per monitor with the current `status` (`up`, `slow` or `down`), the counts of consecutive failures and slow responses, `since`, `last_alert_at` for repeat notices, `checked_at`, and `expires_at` for certificates and domains.
- `auto_incident`: one row per outage the checker saw, with `started_at`, `resolved_at` and the first error.
- `heartbeat`: when each heartbeat monitor was last pinged.
- `notified`: which incident updates and maintenance stages have gone to the alert destinations.
- `component_state`: each component's configured state, noted at start whenever it changes.
- `deploy`: deploy markers.
- `vendor_state`: what each component that follows a vendor was last told, and since when, so that a change is alerted once.

## State machine

A monitor starts as **up**. It becomes **down** after 2 failed checks in a row and **up** again after 1 successful check. With a slow threshold it becomes **slow** after 2 successful checks over the threshold and **up** again after 1 under it; a monitor that recovers from down with a slow response is up first, so the recovery is reported, and turns slow on the next slow check. Only these transitions send an alert, so a flapping monitor sends one pair of alerts per outage, not one per check. A single failed check changes nothing except the stored row, which the page still shows.

A check made inside a maintenance window is stored with the `maintenance` flag and goes no further: no state change, no alert, no incident.

A heartbeat is judged by the scheduler rather than checked: it passes when a ping arrived within its interval. A state whose last check is older than three intervals (five minutes at least) is shown as unknown.

## Incidents

The page merges three sources: files in the incidents folder, maintenance windows from the configuration with the repeats of those that repeat, and the `auto_incident` rows the scheduler writes. The folder is listed on every request and the files are parsed again only when a name, size or modification time has changed. An open incident with an impact raises the headline above what the checks say; it never lowers it. A state an incident gives a row it names is shown on that row when it is worse than the checks.

After each round the scheduler sends the incident updates and maintenance stages that are new and recent to the alert destinations, and notes them in `notified`.

## Queries

The page never reads raw rows for its bars beyond a day. The 24-hour view groups checks into 5-minute slots; the longer views group the hourly totals into hours or days.

Response times are medians (`src/lib/response-times.ts`). A 24-hour bar is the median of the eleven checks around its last one, read with an hour of checks before the view so the first bars have neighbours. A longer view's bar is the median of its hours, each taken as log-normal through its median and 95th percentile. Above each strip are the median over the view and the 95th percentile, which also tops the scale. `status.json` takes its 24-hour median from the same function as the page. Slots align to multiples of the slot length since the epoch, so daily slots start at UTC midnight. Failed runs are grouped with a window function: a running count of successful checks gives every failure between two successes the same group number.

The 24-hour figures are cached and recomputed after new checks land. The longer views are kept for 5 or 15 minutes, or until the monitor's state or latest result changes.

## Rendering

The page is a server component. It reads the `Host` header and the `range` query parameter, runs the queries, and renders everything except the strips and the times on the server. The strip is a client component so that it can show the readout for the bar under the pointer or keyboard focus, and fetch the checks behind a bar from `/checks`. Times are written in the site's zone on the server and in the visitor's own in the browser.

The root layout reads the site too, for the tab's title and icon, the fixed theme and the accent colour. The page refreshes itself every check interval while its tab is visible.

## Deployment

The Docker image is built from Next's standalone output and runs as the `node` user with a health check. Docker Compose mounts `./data` at `/data` for the configuration, the incidents and the database. A reverse proxy terminates TLS and forwards the `Host` header, which is how one container serves many sites.
