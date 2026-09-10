# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

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
