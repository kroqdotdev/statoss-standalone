---
title: Elevated API errors
# The site's name or host. Optional when the configuration has one site.
site: example.com
started: 2026-09-12T14:05:00Z
# none (default), degraded, partial or major. Anything but none sets the
# headline of the page while the incident is open.
impact: partial
# Checkpoints affected. Optional.
checkpoints: [API health]
updates:
  - at: 2026-09-12T14:05:00Z
    status: investigating
    body: Some API requests are answering with 500. We are looking into it.
  - at: 2026-09-12T14:30:00Z
    status: identified
    body: The primary database has run out of connections.
  - at: 2026-09-12T15:10:00Z
    status: resolved
    body: The connection limit was raised and errors have stopped.
---

The database connection pool was sized for last year's traffic. A deploy at
13:50 UTC doubled the number of API workers, and each worker opened its own
pool, which took the database past its limit within a quarter of an hour.

We raised the database limit and made the pool size part of the deploy
checklist. A check on the connection count now alerts at 80 percent.
