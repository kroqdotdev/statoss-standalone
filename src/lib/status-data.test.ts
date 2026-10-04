import { beforeEach, describe, expect, it } from "vitest";
import { clearCache } from "./cache";
import { parseConfig } from "./config";
import { insertCheck, openDb } from "./db";
import { finishHours } from "./hour-figures";
import { dayFigures, monitorView, withFigures, withTimes } from "./status-data";
import { EMPTY_BUCKET } from "./queries";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 1, 12, 2, 30);

const SITE = parseConfig(`
sites:
  - name: s
    host: status.example.com
    monitors:
      - name: Web
        url: https://example.com
        slowThresholdMs: 500
      - name: Cert
        type: certificate
        host: example.com
`).sites[0];
const [WEB, CERT] = SITE.monitors;

/** A check a minute for `days` up to now: 100 ms, with one of 5,000 every hour. */
function seed(db: ReturnType<typeof openDb>, days: number) {
  for (let t = NOW - days * DAY; t < NOW; t += MINUTE)
    insertCheck(db, {
      site: "s",
      monitor: "Web",
      ts: t,
      ok: 1,
      statusCode: 200,
      latencyMs: Math.floor(t / MINUTE) % 60 === 30 ? 5000 : 100,
      error: null,
    });
}

describe("monitorView", () => {
  beforeEach(() => clearCache());

  it("gives the 24 hours median bars, and the median and 95th percentile above them", () => {
    const db = openDb(":memory:");
    seed(db, 2);
    const view = monitorView(db, SITE, WEB, "24h", NOW);
    const drawn = view.buckets.filter((b) => b.total > 0);
    expect(drawn).toHaveLength(288);
    // An hourly 5-second check makes no spike.
    expect(drawn.every((b) => b.latencyMs === 100)).toBe(true);
    expect(view.summary).toMatchObject({ latencyMs: 100, latencyP95: 100 });
    expect(view.last24h).toMatchObject({ latencyMs: 100, latencyP95: 100 });
    expect(dayFigures(db, "s", "Web", NOW)).toMatchObject({
      medianMs: 100,
      p95Ms: 100,
    });
  });

  it("gives the longer ranges the hours' medians", () => {
    const db = openDb(":memory:");
    seed(db, 3);
    finishHours(db, [{ site: "s", monitor: "Web" }], NOW);
    const week = monitorView(db, SITE, WEB, "7d", NOW);
    const drawn = week.buckets.filter((b) => b.latencyMs !== null);
    expect(drawn.length).toBeGreaterThanOrEqual(72);
    expect(drawn.every((b) => b.latencyMs === 100)).toBe(true);
    expect(week.summary).toMatchObject({ latencyMs: 100, latencyP95: 100 });
    const days = monitorView(db, SITE, WEB, "90d", NOW).buckets.filter(
      (b) => b.latencyMs !== null,
    );
    expect(days.map((b) => b.latencyMs)).toEqual([100, 100, 100, 100]);
  });

  it("gives a monitor without response times none", () => {
    const db = openDb(":memory:");
    insertCheck(db, {
      site: "s",
      monitor: "Cert",
      ts: NOW - MINUTE,
      ok: 1,
      statusCode: null,
      latencyMs: null,
      error: null,
    });
    const view = monitorView(db, SITE, CERT, "24h", NOW);
    expect(view.timed).toBe(false);
    expect(view.summary).toMatchObject({ latencyMs: null, latencyP95: null });
    expect(view.buckets.every((b) => b.latencyMs === null)).toBe(true);
  });
});

describe("withTimes and withFigures", () => {
  it("draw no response time for a bar or a window whose checks all failed", () => {
    expect(
      withTimes(
        [
          { ts: 0, ...EMPTY_BUCKET, total: 2, up: 2, latencyMs: 300 },
          { ts: 1, ...EMPTY_BUCKET, total: 2, up: 0, latencyMs: 300 },
        ],
        { buckets: [120, 130] },
      ).map((b) => b.latencyMs),
    ).toEqual([120, null]);
    const summary = { ...EMPTY_BUCKET, total: 2, up: 0, latencyMs: 300 };
    expect(
      withFigures(summary, { medianMs: 120, p95Ms: 200, n: 2 }),
    ).toMatchObject({ latencyMs: null, latencyP95: null });
    expect(
      withFigures({ ...summary, up: 2 }, { medianMs: 120, p95Ms: 200, n: 2 }),
    ).toMatchObject({ latencyMs: 120, latencyP95: 200 });
  });
});
