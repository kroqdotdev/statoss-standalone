---
# A template for an incident written up once it is over. With every time
# more than an hour back, it is filed in the history and nobody is sent a
# message.
title: What went wrong, in a few words
started: 2026-01-01T00:00:00Z
resolved: 2026-01-01T01:15:00Z
impact: partial
monitors: [API health]
updates:
  - at: 2026-01-01T00:00:00Z
    status: investigating
    body: What was seen first.
  - at: 2026-01-01T01:15:00Z
    status: resolved
    body: What ended it.
---

## What happened

What people saw, from when to when.

## Why

The cause, as far back as it is known.

## What we changed

What is different now, and what is still to do.
