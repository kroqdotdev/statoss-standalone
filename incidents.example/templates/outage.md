---
# A template. Copy it into the incidents folder under a name like
# 2026-09-12-api-outage.md, fill it in, and the page shows it at once.
title: Service outage
started: 2026-01-01T00:00:00Z
impact: major
# Each name is a monitor or component of the site. With a state, the row
# shows it while the incident is open: degraded, partial, major or none.
monitors:
  - name: API health
    state: major
updates:
  - at: 2026-01-01T00:00:00Z
    status: investigating
    body: We are looking into reports that the service is not responding.
  # - at: 2026-01-01T00:20:00Z
  #   status: identified
  #   body: The cause is found and a fix is being put in place.
  # - at: 2026-01-01T00:45:00Z
  #   status: monitoring
  #   body: The fix is in place and we are watching the results.
  # - at: 2026-01-01T01:15:00Z
  #   status: resolved
  #   body: The service has been running normally for half an hour.
---
