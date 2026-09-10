# Architecture

statoss-standalone is one Node.js process. It contains a Next.js server for the public pages, a checker that runs on a timer, and a SQLite database on disk.

```
config.yaml ──► scheduler ──► checker ──► checks table ──► queries ──► page
                    │                         │
                    └──► checkpoint_state ────┴──► alerts (email)
```

## Files

| Path                     | Job                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `src/instrumentation.ts` | Starts the scheduler when the server boots.                                                                   |
| `src/lib/config.ts`      | Reads and validates `config.yaml` with zod. Fails fast on a bad file.                                         |
| `src/lib/scheduler.ts`   | Runs one tick per interval: check every checkpoint, store, update state, alert. Never runs two ticks at once. |
| `src/lib/checker.ts`     | Requests one URL with a timeout and reports pass or fail with the reason.                                     |
| `src/lib/state.ts`       | The up/down state machine and the roll-up into one site status.                                               |
| `src/lib/db.ts`          | Opens SQLite, creates the schema, inserts checks, reads and writes state.                                     |
| `src/lib/queries.ts`     | Reads for the page: bucketed series, window totals, runs of failed checks.                                    |
| `src/lib/cache.ts`       | Caches page data per scheduler tick.                                                                          |
| `src/lib/alerts.ts`      | Builds and sends the down and recovery emails.                                                                |
| `src/lib/format.ts`      | Text helpers: durations, UTC times, error labels.                                                             |
| `src/app/page.tsx`       | The status page. Picks the site by `Host` header.                                                             |
| `src/components/`        | The headline, range switch, check strip, and failed-check list.                                               |

## Database

Two tables, created on first start. Existing databases need no migration.

- `checks`: one row per check with `site`, `checkpoint`, `ts`, `ok`, `status_code`, `latency_ms`, and `error`. Indexed on `(site, checkpoint, ts)` and on `ts`.
- `checkpoint_state`: one row per checkpoint with the current `status`, the count of consecutive failures, and `since`, the time the current status began.

Rows in `checks` older than 90 days are deleted once a day.

## State machine

A checkpoint starts as **up**. It becomes **down** after 2 failed checks in a row and **up** again after 1 successful check. Only these transitions send an email, so a flapping checkpoint sends one pair of emails per outage, not one per check. A single failed check changes nothing except the stored row, which the page still shows.

## Queries

The page never reads raw rows. Three queries do the work, each scoped to one checkpoint and one time window:

- **Bucketed series** groups checks into slots of 5 minutes, 1 hour, or 1 day and returns the count, the successes, the timeouts, and the mean response time of the successful checks. Slots align to multiples of the slot length since the epoch, so daily slots start at UTC midnight.
- **Window totals** returns the same numbers for the whole window.
- **Failed runs** groups consecutive failures with a window function: a running count of successful checks gives every failure between two successes the same group number. The query also finds the first success after each run, which gives the duration.

Results are cached in memory and keyed by site, checkpoint, and range. The scheduler bumps a version number after every tick, and the cache recomputes only when the version has changed. A request between ticks costs a few milliseconds.

## Rendering

The page is a server component. It reads the `Host` header and the `range` query parameter, runs the queries, and renders everything except the check strip on the server. The strip is a client component so that it can show the readout for the slot under the pointer or keyboard focus. Times are formatted in UTC on the server, so the HTML is the same on the server and the client.

The page refreshes itself every check interval while its tab is visible.

## Deployment

The Docker image is built from Next's standalone output and runs as the `node` user with a health check. Docker Compose mounts `./data` at `/data` for the configuration and the database. A reverse proxy terminates TLS and forwards the `Host` header, which is how one container serves many sites.
