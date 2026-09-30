---
# A template for something that works, but badly: slow responses, a share
# of requests failing, a delayed queue.
title: Slow responses
started: 2026-01-01T00:00:00Z
impact: degraded
monitors:
  - name: Main site
    state: degraded
updates:
  - at: 2026-01-01T00:00:00Z
    status: investigating
    body: Pages are loading more slowly than usual. We are looking into it.
---
