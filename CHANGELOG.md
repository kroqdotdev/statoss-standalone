# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

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
