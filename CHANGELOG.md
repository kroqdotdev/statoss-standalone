# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- Vendor components follow pages on Instatus, Better Stack, status.io (GitLab, Neon) and Sorry (Postmark), and Slack's, Heroku's and Stripe's status. A page's platform is found by asking each in turn, and the one that answered is asked first after that. A feed's address in `vendor` is taken as its page's.
- A component that follows a vendor alerts email, Slack, Discord and ntfy destinations when the vendor reports an outage, trouble, or things working again, with up to three of its open incidents. PagerDuty, Opsgenie and webhooks get none. The first reading sends nothing, and a restart repeats nothing. `vendors: false` under `alerts`, or under a site's `alerts`, turns them off.
- Maintenance that repeats: `repeat: weekly`, `monthly` or `monthly-weekday` on a window, and `until` for the last day one may start. A repeat keeps the window's time of day in the site's `timezone`, is planned a week before it starts, and is then shown, announced to the alert destinations (planned, started, over, once each) and given a page like a window written by hand, with an id made from its own start and title.
- A calendar of each site's maintenance at `/maintenance.ics`: the last 30 days, every window written for later and the repeats of the next 90 days, each under one UID from planned to over. Get updates on the page links to it.
- The checks behind a bar show where each one's time went: the DNS lookup, the connection, the TLS handshake and the first byte, for HTTP, TCP and certificate monitors. A check that timed out says where it stopped. `/checks` gives the same as `timing` on each check. A 0.3 database gets the columns for them on its first start; its older checks show as before.

### Changed

- A host's addresses are tried side by side, the next one starting a quarter second after the last, instead of each being dropped after a quarter second, so a far host with several addresses no longer reads a quarter second slower for each one. Every HTTP check opens its own connection, with a full TLS handshake, and times are read from a clock that a change to the system time does not move.
- The image sets `UV_THREADPOOL_SIZE=32`, so a few host lookups that hang do not hold up the other checks' lookups.

### Fixed

- A header a request cannot carry is refused when the configuration is loaded, and the message names the monitor and the header: a name that is not letters, digits and dashes, or a value with a character such as a curly quote or a line break. A line break at the end of a value is trimmed, as fetch would.
- Dates from another year say which year: the bars of the 90-day and 1-year views, and the checks behind one of them.
- An outage is dated from its first failed check, not the second that confirmed it: the monitor's "Down for" and "since", the headline, `status.json`, the incident it opens and where that shows on the strips and in the history, and `downSince` in alerts and the webhook body. It is never dated from before a gap in the checks of more than three intervals (five minutes at least), such as while the server was off.
- Instatus pages, which answer `/api/v2/summary.json` in their own shape, could not be read.
- The image installs Debian's security updates when it is built, so a fix such as the October 2026 openssl and pcre2 updates does not wait for a new Node base image.

### Development

- `pnpm audit` ignores GHSA-vfj7-8cjw-p6xm, a braces advisory with no fixed release, reached only through ESLint.

## 0.3.0 - 2026-09-30

### Added

Monitors:

- Six more kinds of monitor, chosen with `type`: `tcp`, `dns`, `ping`, `certificate`, `domain` and `heartbeat`. Certificate and domain monitors fail inside a warning window before expiry and show the date on the page and in `status.json`. A heartbeat gives a scheduled job a URL to ping at `/heartbeat/<token>`, is judged every round, and goes down a round after a ping is overdue (its interval plus a tenth of it as grace); a ping to a monitor that is down is judged at once.
- `intervalSeconds` on a monitor, for one that should be checked less often than the rest.
- Components: parts of the product with no check, listed under `components` with a state set in the configuration or by an open incident that names them, and a strip of the states they were in.
- Vendor components: a component with `vendor` follows a Statuspage, incident.io or StatOSS status page, or one `part` of it, and is shown under Third-party services with the vendor's open incidents. A vendor's trouble does not move the headline, the badge or `status.json`'s site status.
- Stale is not up: a monitor whose checks have stopped arriving says when it was last checked, in grey, and counts as unknown in the headline, the badge and `status.json` (`stale`, `lastCheckedAt`).

History:

- A 1-year view, and hourly totals behind it: every check is added to its hour's totals, which are kept for 400 days. A 0.2 database gets them filled in from its checks on the first start.
- `retentionDays`, for how long single checks are kept. The default stays 90.
- An error budget: `uptimeTarget` on a site puts the month's uptime against the target, and the downtime allowance spent, at the foot of the page and in `status.json`.
- Every bar on a strip opens a list of the checks behind it: when each ran, what it found and its response time. A bar older than the checks that are kept shows its hours' totals.
- Pointing at a bar names the incidents and maintenance windows that touched it.
- Deploy markers: with `DEPLOY_TOKEN` set, `POST /deploys` from CI draws a dashed line with the version on every strip of the site. `GET /deploys` lists them and `status.json` carries the last five.

Incidents:

- A page for every incident and maintenance window at `/incidents/<id>`, and `/history`, which lists them by month.
- An incident gives each monitor or component it names a state while it is open (`state: degraded`, `partial`, `major` or `none`), shown on the row when it is worse than the checks. Rows under a maintenance window in progress say "Under maintenance".
- Headings in a post-mortem: a line that starts with `#`.
- Three incident templates in `incidents.example/templates/`.

Alerts:

- PagerDuty, Opsgenie and ntfy as alert destinations. A monitor going down opens an alert on PagerDuty or Opsgenie and its recovery closes it; slowness is a second, lower alert.
- Incident updates and maintenance windows (planned, started, over) go to the alert destinations, once each. `updates: false` turns that off.
- A send that fails is tried again after one, five and fifteen minutes, unless the monitor has changed state since. Every send, failure and retry is logged.
- A down alert says when the first failed check was (`failingSince` in the webhook body).

The page:

- The look of a page, per site: `logo`, `favicon`, `accent`, `theme` (light, dark or the visitor's system), `description` and `supportUrl`. Under the headline the page says when it was updated and offers Get updates and Contact support.
- Times follow the visitor: every time on the page is written in the browser's own time zone, and the foot of the page names it. `timezone` is the zone used until the browser has loaded.
- Password pages: `password` on a site locks the page, its incident pages, the history and every endpoint. `embedKey` lets a badge, `status.json`, a feed or the widget in with `?key=`.
- `defaultRange` opens the page on 7 days, 90 days or a year, `foldGroups` folds the groups in which everything is up, and `noindex` keeps a page out of search engines.

For programs:

- An Atom feed at `/feed.atom`. Both feeds carry a window's times, each update's status word and the post-mortem, and link to the incident's page.
- A read-only MCP endpoint at `/mcp` with `get_status`, `list_incidents` and `get_error_budget`, and `/llms.txt`, next to every page.

The image:

- The image carries `ping`, and no longer carries npm, corepack and yarn, which come with the Node image, never run in it, and brought known vulnerabilities in their own dependencies.

### Changed

- After a restart a monitor waits out what is left of its interval from its last check instead of running at once, so certificates and domains keep to their hourly and six-hourly floors through restarts.
- Two rows whose names make the same anchor on the page (like "API v2" and "API-v2"), and two maintenance windows with one title starting in the same minute, are refused by the configuration.
- A round no longer waits for the last one to finish. With a short `checkIntervalSeconds` and a check waiting on its timeout, every other round used to be skipped; now only that monitor waits.
- Moving from a bar to the list of its checks keeps the bar read out, so on a phone the list no longer moves under a finger half way through a tap.
- A strip is drawn as one SVG path per colour instead of two or three rectangles per bar, about a quarter of the markup.
- The status page lists the resolved incidents of the last 7 days instead of 30; the rest are under Incident history. Open incidents are ordered: what somebody wrote first, the worst first, then the outages the checker opened, folded into one card when there are several.
- A site may have no monitors. It says nothing is checked yet, and its state is unknown instead of up.
- A feed entry's guid is `urn:statoss:incident:<id>` and no longer changes with each update, so feed readers will show current entries once more.
- An incident with a start in the future is not shown until then.
- The 7-day and 90-day views are read from the hourly totals and kept for 5 and 15 minutes, or until a monitor changes state, instead of being added up from every check after every round.
- A maintenance window's id is made from its start and title (`maintenance-2026-09-20-0100-database-upgrade`) instead of its place in the list. It appears in `status.json` and as the feed's guid, so a feed reader may show current windows once more.
- The checks of one round are spread over the first three quarters of the interval, 45 seconds at most, instead of all starting at once, which made each response time count the others' handshakes.
- `slowThresholdMs` is at most 9999, under the 10-second timeout. A higher value is now an error.
- The webhook body's `url` is what the monitor points at: the URL, `host:port`, or the host.

### Development

- Browser journeys (`pnpm e2e`) run the built server against a seeded database at desktop and phone width, and fail on anything that runs off the side of a screen. CI runs them on every pull request.
- CI runs `pnpm audit` and a type check; a weekly workflow scans the image for known vulnerabilities.
- brace-expansion 1.1.21 and 5.0.12 through overrides, for the advisories reached through ESLint.

## 0.2.0 - 2026-09-29

### Added

- Check options: `method`, `headers`, `body`, `expectStatus`, `keyword` with `keywordMode: present|absent`, and `slowThresholdMs`. Slow is a state, with its own alerts, drawn in indigo under a dashed line at the threshold.
- Groups: monitors with the same `group` are shown together under one heading with a one-line summary.
- Public endpoints on every site's hostname: `status.json`, `badge.svg`, `badge.json` (the shields.io endpoint format), `feed.xml` and `widget.js`.
- Alert channels: email, Slack, Discord, and a webhook signed with HMAC SHA-256, for all sites or per site; `alerts: false` turns a site off, `repeatMinutes` sends "still down" notices, and `${NAME}` in the configuration reads an environment variable. The old `smtp.to` still works.
- Incidents as Markdown or YAML files in an `incidents/` folder, read again when a file changes, with post-mortems; planned maintenance windows in the configuration, whose checks are shown but not counted and send no alert. A monitor going down opens an incident by itself and resolves it on recovery.
- A published image for linux/amd64 and linux/arm64 at `ghcr.io/kroqdotdev/statoss-standalone`, built by the Image workflow on every push to main and every version tag.
- `docker-compose.build.yml`, to build the image from a checkout instead.

### Changed

- Checkpoints are called monitors: on the page, in the configuration, the docs, `status.json` and the webhook body. Nothing written for 0.1 breaks: `checkpoints:` in a configuration or an incident file still works, `status.json` also lists them as `checkpoints`, the webhook body also carries `checkpoint`, and a 0.1 database is renamed in place on the next start.
- The status page has the look of the pages StatOSS hosts: Barlow and Barlow Condensed, self-hosted, and a neutral paper by day and charcoal by night.
- `docker-compose.yml` runs the published image. The quick start begins with `docker run` and Docker Compose on that image.
- The image declares `/data` as a volume owned by the `node` user, so a new named volume is writable without a `chown`.
- The image keeps only the SQLite binary for its own platform.

### Security

- Next.js 16.3.6, which fixes two critical advisories: remote code execution through the image optimiser, and on servers running on Windows. Anyone running 0.1 or an earlier image should update.
- nodemailer 10.0.12, fixing its advisories about address parsing, file access and DNS caching.
- vitest 4.1.11 for development, and patched versions of sharp, js-yaml and nanoid underneath. `pnpm audit` finds nothing.

## 0.1.0 - 2026-09-10

First public release as statoss-standalone.

### Added

- One check strip per checkpoint with 24-hour, 7-day, and 90-day views. Bar height is response time; a mark at the top shows failed checks, amber for timeouts and red for other failures.
- A hover and keyboard readout for each time slot.
- A list of failed checks grouped into runs, with the reason and how long the checkpoint did not respond.
- A headline that states the site status in one sentence, and an "unknown" state until the first check has run.
- Email alerts on down and recovery, over SMTP with TLS required.
- A Docker image that runs as the `node` user with a health check, and a self-hosted font so builds need no network.
- Validation that rejects duplicate checkpoint names and duplicate site hosts.

### Changed

- The project is named statoss-standalone. The Docker Compose service is named `statoss`.
