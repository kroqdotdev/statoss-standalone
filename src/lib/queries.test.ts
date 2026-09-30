import { describe, expect, it } from "vitest";
import { insertCheck, openDb } from "./db";
import {
  DEFAULT_RANGE,
  RANGES,
  bucketSeries,
  failureRuns,
  parseRange,
  rangeWindow,
  rollupSeries,
  rollupSummary,
  windowSummary,
} from "./queries";

const DAY = 24 * 60 * 60 * 1000;
// 2024-01-10T12:00:00Z: a fixed "now", so dates are deterministic
const NOW = Date.UTC(2024, 0, 10, 12, 0, 0);

function seed(
  db: ReturnType<typeof openDb>,
  ts: number,
  ok: 0 | 1,
  latencyMs: number | null,
) {
  insertCheck(db, {
    site: "s",
    monitor: "c",
    ts,
    ok,
    statusCode: ok ? 200 : 500,
    latencyMs,
    error: ok ? null : "unexpected status 500",
  });
}

describe("rangeWindow", () => {
  it("aligns daily buckets to UTC midnight and ends after now", () => {
    const { start, end } = rangeWindow(RANGES["90d"], NOW);
    expect(end).toBe(Date.UTC(2024, 0, 11));
    expect(start).toBe(Date.UTC(2023, 9, 13));
    expect((end - start) / DAY).toBe(90);
  });

  it("uses 5-minute buckets for 24 hours", () => {
    const { start, end } = rangeWindow(RANGES["24h"], NOW);
    expect(end - start).toBe(DAY);
    expect(end % 300_000).toBe(0);
    expect(end).toBeGreaterThan(NOW);
  });
});

describe("parseRange", () => {
  it("accepts known keys and falls back to the default", () => {
    expect(parseRange("7d")).toBe("7d");
    expect(parseRange("1y")).toBe("1y");
    expect(parseRange("2y")).toBe(DEFAULT_RANGE);
    expect(parseRange("toString")).toBe(DEFAULT_RANGE);
    expect(parseRange(undefined, "90d")).toBe("90d");
    expect(parseRange(undefined)).toBe(DEFAULT_RANGE);
    expect(parseRange(["24h"])).toBe(DEFAULT_RANGE);
  });
});

describe("bucketSeries", () => {
  it("returns one bucket per slot with counts, timeouts and mean latency", () => {
    const db = openDb(":memory:");
    const spec = RANGES["24h"];
    const { start } = rangeWindow(spec, NOW);
    const slot = start + 10 * spec.bucketMs;
    seed(db, slot + 1000, 1, 100);
    seed(db, slot + 2000, 1, 300);
    insertCheck(db, {
      site: "s",
      monitor: "c",
      ts: slot + 3000,
      ok: 0,
      statusCode: null,
      latencyMs: 10_000,
      error: "timeout",
    });
    seed(db, slot + 4000, 0, 50);

    const buckets = bucketSeries(db, "s", "c", spec, NOW);
    expect(buckets).toHaveLength(spec.buckets);
    expect(buckets[0]).toEqual({
      ts: start,
      total: 0,
      up: 0,
      timeouts: 0,
      slow: 0,
      maintenance: 0,
      latencyMs: null,
    });
    expect(buckets[10]).toEqual({
      ts: slot,
      total: 4,
      up: 2,
      timeouts: 1,
      slow: 0,
      maintenance: 0,
      latencyMs: 200,
    });
  });

  it("ignores checks before the window", () => {
    const db = openDb(":memory:");
    seed(db, rangeWindow(RANGES["24h"], NOW).start - 1, 1, 100);
    const buckets = bucketSeries(db, "s", "c", RANGES["24h"], NOW);
    expect(buckets.every((b) => b.total === 0)).toBe(true);
  });
});

describe("windowSummary", () => {
  it("totals checks, successes, timeouts and mean latency", () => {
    const db = openDb(":memory:");
    seed(db, NOW - 3000, 1, 100);
    seed(db, NOW - 2000, 1, 200);
    insertCheck(db, {
      site: "s",
      monitor: "c",
      ts: NOW - 1000,
      ok: 0,
      statusCode: null,
      latencyMs: 10_000,
      error: "timeout",
    });
    expect(windowSummary(db, "s", "c", NOW - DAY, NOW + 1)).toEqual({
      total: 3,
      up: 2,
      timeouts: 1,
      slow: 0,
      maintenance: 0,
      latencyMs: 150,
    });
  });

  it("returns zeros for an empty window", () => {
    expect(windowSummary(openDb(":memory:"), "s", "c", 0, NOW)).toEqual({
      total: 0,
      up: 0,
      timeouts: 0,
      slow: 0,
      maintenance: 0,
      latencyMs: null,
    });
  });

  it("counts slow successes against a threshold", () => {
    const db = openDb(":memory:");
    seed(db, NOW - 3000, 1, 100);
    seed(db, NOW - 2000, 1, 900);
    seed(db, NOW - 1000, 0, 2000);
    expect(windowSummary(db, "s", "c", NOW - DAY, NOW + 1, 500)).toMatchObject({
      total: 3,
      up: 2,
      slow: 1,
    });
    expect(windowSummary(db, "s", "c", NOW - DAY, NOW + 1)).toMatchObject({
      slow: 0,
    });
    const spec = RANGES["24h"];
    const filled = bucketSeries(db, "s", "c", spec, NOW, 500).filter(
      (b) => b.total > 0,
    );
    expect(filled).toHaveLength(1);
    expect(filled[0]).toMatchObject({ total: 3, up: 2, slow: 1 });
  });

  it("keeps maintenance checks apart from the totals", () => {
    const db = openDb(":memory:");
    seed(db, NOW - 3000, 1, 100);
    insertCheck(db, {
      site: "s",
      monitor: "c",
      ts: NOW - 2000,
      ok: 0,
      statusCode: 500,
      latencyMs: 30,
      error: "unexpected status 500",
      maintenance: 1,
    });
    expect(windowSummary(db, "s", "c", NOW - DAY, NOW + 1)).toEqual({
      total: 1,
      up: 1,
      timeouts: 0,
      slow: 0,
      maintenance: 1,
      latencyMs: 100,
    });
    const filled = bucketSeries(db, "s", "c", RANGES["24h"], NOW).filter(
      (b) => b.total > 0 || b.maintenance > 0,
    );
    expect(filled).toHaveLength(1);
    expect(filled[0]).toMatchObject({
      total: 1,
      maintenance: 1,
      latencyMs: 100,
    });
    expect(failureRuns(db, "s", "c", NOW - DAY, NOW + 1)).toEqual([]);
  });
});

describe("failureRuns", () => {
  function fail(db: ReturnType<typeof openDb>, ts: number, error: string) {
    insertCheck(db, {
      site: "s",
      monitor: "c",
      ts,
      ok: 0,
      statusCode: error.startsWith("unexpected") ? 503 : null,
      latencyMs: null,
      error,
    });
  }

  it("groups consecutive failures and lists them newest first", () => {
    const db = openDb(":memory:");
    const t0 = NOW - 60 * 60_000;
    seed(db, t0, 1, 100);
    fail(db, t0 + 1 * 60_000, "timeout"); // run A: one timeout
    seed(db, t0 + 2 * 60_000, 1, 100);
    seed(db, t0 + 3 * 60_000, 1, 100);
    fail(db, t0 + 4 * 60_000, "unexpected status 503"); // run B: 3 checks
    fail(db, t0 + 5 * 60_000, "unexpected status 503");
    fail(db, t0 + 6 * 60_000, "timeout");
    seed(db, t0 + 7 * 60_000, 1, 100);

    const runs = failureRuns(db, "s", "c", NOW - DAY, NOW + 1);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      startTs: t0 + 4 * 60_000,
      endTs: t0 + 6 * 60_000,
      checks: 3,
      timeouts: 1,
      recoveredTs: t0 + 7 * 60_000,
      ongoing: false,
    });
    expect([...runs[0].errors].sort()).toEqual([
      "timeout",
      "unexpected status 503",
    ]);
    expect(runs[1]).toMatchObject({
      startTs: t0 + 60_000,
      endTs: t0 + 60_000,
      checks: 1,
      timeouts: 1,
      errors: ["timeout"],
      recoveredTs: t0 + 2 * 60_000,
      ongoing: false,
    });
  });

  it("marks a run that includes the latest check as ongoing", () => {
    const db = openDb(":memory:");
    seed(db, NOW - 3 * 60_000, 1, 100);
    fail(db, NOW - 2 * 60_000, "timeout");
    fail(db, NOW - 1 * 60_000, "timeout");
    const runs = failureRuns(db, "s", "c", NOW - DAY, NOW + 1);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      checks: 2,
      recoveredTs: null,
      ongoing: true,
    });
  });

  it("starts a run at the first check when it fails", () => {
    const db = openDb(":memory:");
    fail(db, NOW - 60_000, "fetch failed (ECONNREFUSED)");
    seed(db, NOW - 30_000, 1, 100);
    const runs = failureRuns(db, "s", "c", NOW - DAY, NOW + 1);
    expect(runs).toHaveLength(1);
    expect(runs[0].errors).toEqual(["fetch failed (ECONNREFUSED)"]);
  });

  it("returns nothing without failures", () => {
    const db = openDb(":memory:");
    seed(db, NOW - 60_000, 1, 100);
    expect(failureRuns(db, "s", "c", NOW - DAY, NOW + 1)).toEqual([]);
  });
});

describe("rollups", () => {
  it("draw the long ranges from the hourly totals, the same as the checks would", () => {
    const db = openDb(":memory:");
    const HOUR = 60 * 60 * 1000;
    seed(db, NOW - 3 * DAY, 1, 100);
    seed(db, NOW - 3 * DAY + 60_000, 1, 300);
    seed(db, NOW - 3 * DAY + 2 * HOUR, 0, 50);
    seed(db, NOW - 60_000, 1, 80);
    for (const key of ["7d", "90d", "1y"] as const) {
      const fromHours = rollupSeries(db, "s", "c", RANGES[key], NOW);
      const fromChecks = bucketSeries(db, "s", "c", RANGES[key], NOW);
      expect(fromHours).toEqual(fromChecks);
    }
    const day = rollupSeries(db, "s", "c", RANGES["1y"], NOW).filter(
      (b) => b.total > 0,
    );
    expect(day).toHaveLength(2);
    expect(day[0]).toMatchObject({ total: 3, up: 2, latencyMs: 200 });
  });

  it("sum a window, with the hours that had checks and the readings behind the mean", () => {
    const db = openDb(":memory:");
    seed(db, NOW - 2 * DAY, 1, 100);
    seed(db, NOW - 2 * DAY + 1000, 0, 10);
    seed(db, NOW - DAY, 1, 300);
    expect(rollupSummary(db, "s", "c", NOW - 3 * DAY, NOW)).toEqual({
      total: 3,
      up: 2,
      timeouts: 0,
      slow: 0,
      maintenance: 0,
      latencyMs: 200,
      latencyN: 2,
      hours: 2,
    });
    expect(
      rollupSummary(db, "s", "c", NOW - 10 * DAY, NOW - 5 * DAY),
    ).toMatchObject({ total: 0, latencyMs: null, hours: 0 });
  });
});
