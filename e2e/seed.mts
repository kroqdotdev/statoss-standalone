// Everything the journeys' server starts from, written to .e2e/: a
// configuration with an open site (localhost) and a password site
// (127.0.0.1), a folder of incidents dated around now, and a database with
// a year of hourly totals, a day of checks, a deploy and a component's past.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { insertCheck, openDb, recordDeploy, setState } from "../src/lib/db.ts";

const DIR = ".e2e";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = Date.now();
const iso = (ts: number) => new Date(ts).toISOString();

rmSync(DIR, { recursive: true, force: true });
mkdirSync(`${DIR}/incidents`, { recursive: true });

writeFileSync(
  `${DIR}/logo.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="40" height="40" rx="8" fill="#6d2a7a"/></svg>`,
);

writeFileSync(
  `${DIR}/config.yaml`,
  `checkIntervalSeconds: 10
sites:
  - name: Northwind
    host: localhost
    description: Everything Northwind runs for its customers.
    logo: logo.svg
    accent: "#6d2a7a"
    supportUrl: mailto:help@northwind.example
    uptimeTarget: 99.9
    monitors:
      - name: Website
        group: Web
        url: http://127.0.0.1:3224/ok
        slowThresholdMs: 300
      - name: A rather long monitor name that has to wrap on a phone
        group: Web
        url: http://127.0.0.1:3224/ok
      - name: Search
        group: Web
        url: http://127.0.0.1:3224/slow
        slowThresholdMs: 300
      - name: Exports
        url: http://127.0.0.1:3224/down
      - name: Database port
        type: tcp
        host: 127.0.0.1
        port: 3224
      - name: Nightly backup
        type: heartbeat
        token: journey-heartbeat
        intervalSeconds: 3600
    components:
      - name: Mobile app
        group: Apps
        description: iOS and Android
      - name: Card payments
        group: Apps
        state: degraded
    maintenance:
      - title: Database upgrade
        start: ${iso(now - 20 * MINUTE)}
        end: ${iso(now + 40 * MINUTE)}
        monitors: [Database port]
        notes: Writes pause for a minute.
      - title: Router swap
        start: ${iso(now - 10 * DAY)}
        end: ${iso(now - 10 * DAY + 2 * HOUR)}
  - name: Internal tools
    host: 127.0.0.1
    password: journey-password
    embedKey: journey-embed-key
    theme: dark
    monitors:
      - name: Wiki
        url: http://127.0.0.1:3224/ok
`,
);

writeFileSync(
  `${DIR}/incidents/open-uploads.md`,
  `---
title: Uploads are failing for some customers
site: Northwind
started: ${iso(now - 40 * MINUTE)}
impact: partial
monitors:
  - name: Website
    state: degraded
  - name: Mobile app
    state: partial
updates:
  - at: ${iso(now - 40 * MINUTE)}
    status: investigating
    body: Some uploads are answered with an error. We are looking into it.
  - at: ${iso(now - 10 * MINUTE)}
    status: identified
    body: A storage node is out of space. We are moving traffic off it.
---
`,
);

writeFileSync(
  `${DIR}/incidents/slow-search.md`,
  `---
title: Slow search
site: Northwind
started: ${iso(now - 2 * DAY)}
impact: degraded
monitors: [Search]
updates:
  - at: ${iso(now - 2 * DAY)}
    status: investigating
    body: Search is answering slowly.
  - at: ${iso(now - 2 * DAY + 50 * MINUTE)}
    status: resolved
    body: An index was rebuilt and search is fast again.
---

## What happened

Search took several seconds to answer for about fifty minutes.

## What we changed

The index is rebuilt nightly.
`,
);

writeFileSync(
  `${DIR}/incidents/old-dns.yaml`,
  `title: DNS provider outage
site: Northwind
started: ${iso(now - 150 * DAY)}
resolved: ${iso(now - 150 * DAY + 40 * MINUTE)}
impact: major
updates:
  - at: ${iso(now - 150 * DAY)}
    status: investigating
    body: Names did not resolve for some visitors.
`,
);

const db = openDb(`${DIR}/status.db`);
let seed = 7;
const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

const hour = db.prepare(
  `INSERT OR REPLACE INTO check_hour
     (site, monitor, ts, total, up, timeouts, slow, maintenance, latency_sum, latency_n)
   VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
);
db.transaction(() => {
  for (const monitor of ["Website", "Search"]) {
    const base = monitor === "Search" ? 180 : 60;
    // A year of hours, up to a day ago.
    for (let h = 365 * 24; h > 24; h--) {
      const ts = Math.floor((now - h * HOUR) / HOUR) * HOUR;
      const bad = random() < 0.004 ? 1 + Math.floor(random() * 20) : 0;
      const latency = base + Math.floor(random() * 40);
      hour.run(
        "Northwind",
        monitor,
        ts,
        60,
        60 - bad,
        Math.floor(bad / 2),
        latency * (60 - bad),
        60 - bad,
      );
    }
    // The last day, check by check, with an outage five hours back.
    for (let i = 24 * 60; i >= 1; i--) {
      const failed = i > 300 && i < 309;
      insertCheck(db, {
        site: "Northwind",
        monitor,
        ts: now - i * MINUTE,
        ok: failed ? 0 : 1,
        statusCode: failed ? 503 : 200,
        latencyMs: failed ? 12 : base + Math.floor(random() * 40),
        error: failed ? "unexpected status 503" : null,
      });
    }
    setState(db, {
      site: "Northwind",
      monitor,
      status: "up",
      consecutiveFails: 0,
      consecutiveSlow: 0,
      since: now - 300 * MINUTE,
      lastAlertAt: null,
      checkedAt: now - MINUTE,
    });
  }
})();

recordDeploy(db, "Northwind", {
  version: "v1.4.0",
  note: "Faster search",
  url: null,
  at: now - 3 * HOUR,
});
// Both components were operational a month ago; the configuration's
// "degraded" for Card payments is noted when the server starts.
for (const component of ["Mobile app", "Card payments"])
  db.prepare(
    "INSERT INTO component_state (site, component, state, at) VALUES (?, ?, ?, ?)",
  ).run("Northwind", component, "operational", now - 30 * DAY);
db.close();
console.log("[seed] wrote .e2e");
