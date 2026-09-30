import type Database from "better-sqlite3";
import {
  DEFAULT_RANGE,
  RANGES,
  parseRange,
  type RangeKey,
  type RangeSpec,
} from "./ranges";

export { DEFAULT_RANGE, RANGES, parseRange, type RangeKey, type RangeSpec };

/**
 * The half-open window [start, end) that a range covers. Buckets align to
 * multiples of `bucketMs` since the epoch, so daily buckets start at UTC
 * midnight. The last bucket is the one that contains `now`.
 */
export function rangeWindow(
  spec: RangeSpec,
  now: number,
): { start: number; end: number } {
  const end = Math.floor(now / spec.bucketMs) * spec.bucketMs + spec.bucketMs;
  return { start: end - spec.buckets * spec.bucketMs, end };
}

export interface Bucket {
  ts: number;
  /** Checks outside maintenance windows. */
  total: number;
  up: number;
  /** Failed checks whose error was a timeout. */
  timeouts: number;
  /** Successful checks over the monitor's slow threshold. */
  slow: number;
  /** Checks that ran inside a maintenance window: shown, not counted. */
  maintenance: number;
  /** Mean response time of the successful checks, or null without any. */
  latencyMs: number | null;
}

export const EMPTY_BUCKET: Omit<Bucket, "ts"> = {
  total: 0,
  up: 0,
  timeouts: 0,
  slow: 0,
  maintenance: 0,
  latencyMs: null,
};

/** One entry per bucket, oldest first. Buckets without checks have total 0. */
export function bucketSeries(
  db: Database.Database,
  site: string,
  monitor: string,
  spec: RangeSpec,
  now = Date.now(),
  slowThresholdMs: number | null = null,
): Bucket[] {
  const { start, end } = rangeWindow(spec, now);
  const { bucketMs } = spec;
  const rows = db
    .prepare(
      `SELECT (ts / ${bucketMs}) * ${bucketMs} AS ts,
              SUM(maintenance = 0) AS total,
              SUM(ok = 1 AND maintenance = 0) AS up,
              SUM(ok = 0 AND maintenance = 0 AND error = 'timeout') AS timeouts,
              SUM(ok = 1 AND maintenance = 0 AND ? IS NOT NULL AND latency_ms > ?) AS slow,
              SUM(maintenance = 1) AS maintenance,
              ROUND(AVG(CASE WHEN ok = 1 AND maintenance = 0 THEN latency_ms END)) AS latencyMs
       FROM checks
       WHERE site = ? AND monitor = ? AND ts >= ? AND ts < ?
       GROUP BY (ts / ${bucketMs}) * ${bucketMs}`,
    )
    .all(
      slowThresholdMs,
      slowThresholdMs,
      site,
      monitor,
      start,
      end,
    ) as Bucket[];
  const byTs = new Map(rows.map((row) => [row.ts, row]));
  const result: Bucket[] = [];
  for (let i = 0; i < spec.buckets; i++) {
    const ts = start + i * bucketMs;
    result.push(byTs.get(ts) ?? { ts, ...EMPTY_BUCKET });
  }
  return result;
}

export interface WindowSummary {
  /** Checks outside maintenance windows. */
  total: number;
  up: number;
  timeouts: number;
  slow: number;
  maintenance: number;
  latencyMs: number | null;
  /** How many readings the mean is over, when the totals came from hours. */
  latencyN?: number;
  /** How many hours had a check, when the totals came from hours. */
  hours?: number;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * The same series from the hourly totals, for ranges whose buckets are an
 * hour or longer. It reads a few thousand rows for a year where the raw
 * table would read half a million, and reaches back past the raw rows.
 */
export function rollupSeries(
  db: Database.Database,
  site: string,
  monitor: string,
  spec: RangeSpec,
  now = Date.now(),
): Bucket[] {
  const { start, end } = rangeWindow(spec, now);
  const { bucketMs } = spec;
  const rows = db
    .prepare(
      `SELECT (ts / ${bucketMs}) * ${bucketMs} AS ts,
              SUM(total) AS total,
              SUM(up) AS up,
              SUM(timeouts) AS timeouts,
              SUM(slow) AS slow,
              SUM(maintenance) AS maintenance,
              CASE WHEN SUM(latency_n) > 0
                   THEN ROUND(SUM(latency_sum) * 1.0 / SUM(latency_n)) END AS latencyMs
       FROM check_hour
       WHERE site = ? AND monitor = ? AND ts >= ? AND ts < ?
       GROUP BY (ts / ${bucketMs}) * ${bucketMs}`,
    )
    .all(site, monitor, start, end) as Bucket[];
  const byTs = new Map(rows.map((row) => [row.ts, row]));
  const result: Bucket[] = [];
  for (let i = 0; i < spec.buckets; i++) {
    const ts = start + i * bucketMs;
    result.push(byTs.get(ts) ?? { ts, ...EMPTY_BUCKET });
  }
  return result;
}

/** Totals over the whole hours in [sinceMs, untilMs), from the hourly totals. */
export function rollupSummary(
  db: Database.Database,
  site: string,
  monitor: string,
  sinceMs: number,
  untilMs: number,
): WindowSummary {
  return db
    .prepare(
      `SELECT COALESCE(SUM(total), 0) AS total,
              COALESCE(SUM(up), 0) AS up,
              COALESCE(SUM(timeouts), 0) AS timeouts,
              COALESCE(SUM(slow), 0) AS slow,
              COALESCE(SUM(maintenance), 0) AS maintenance,
              CASE WHEN SUM(latency_n) > 0
                   THEN ROUND(SUM(latency_sum) * 1.0 / SUM(latency_n)) END AS latencyMs,
              COALESCE(SUM(latency_n), 0) AS latencyN,
              COUNT(*) AS hours
       FROM check_hour
       WHERE site = ? AND monitor = ? AND ts >= ? AND ts < ?`,
    )
    .get(
      site,
      monitor,
      Math.floor(sinceMs / HOUR_MS) * HOUR_MS,
      untilMs,
    ) as WindowSummary;
}

/** Totals over [sinceMs, untilMs). Maintenance checks are counted apart. */
export function windowSummary(
  db: Database.Database,
  site: string,
  monitor: string,
  sinceMs: number,
  untilMs: number,
  slowThresholdMs: number | null = null,
): WindowSummary {
  return db
    .prepare(
      `SELECT COALESCE(SUM(maintenance = 0), 0) AS total,
              COALESCE(SUM(ok = 1 AND maintenance = 0), 0) AS up,
              COALESCE(SUM(ok = 0 AND maintenance = 0 AND error = 'timeout'), 0) AS timeouts,
              COALESCE(SUM(ok = 1 AND maintenance = 0 AND ? IS NOT NULL AND latency_ms > ?), 0) AS slow,
              COALESCE(SUM(maintenance = 1), 0) AS maintenance,
              ROUND(AVG(CASE WHEN ok = 1 AND maintenance = 0 THEN latency_ms END)) AS latencyMs
       FROM checks
       WHERE site = ? AND monitor = ? AND ts >= ? AND ts < ?`,
    )
    .get(
      slowThresholdMs,
      slowThresholdMs,
      site,
      monitor,
      sinceMs,
      untilMs,
    ) as WindowSummary;
}

export interface FailureRun {
  /** Time of the first failed check in the run. */
  startTs: number;
  /** Time of the last failed check in the run. */
  endTs: number;
  checks: number;
  timeouts: number;
  /** Distinct stored error strings, in no particular order. */
  errors: string[];
  /** Time of the first successful check after the run, or null if none yet. */
  recoveredTs: number | null;
  /** True when the run includes the monitor's most recent check. */
  ongoing: boolean;
}

/**
 * Consecutive failed checks grouped into runs, newest first. A run ends at the
 * next successful check. This shows a single timeout as clearly as an outage.
 * Checks made during maintenance are left out, so a run never spans a window.
 * Returns every run in the window, so callers can count them exactly.
 */
export function failureRuns(
  db: Database.Database,
  site: string,
  monitor: string,
  sinceMs: number,
  untilMs: number,
): FailureRun[] {
  const latest = db
    .prepare(
      `SELECT MAX(ts) AS ts FROM checks
       WHERE site = ? AND monitor = ? AND maintenance = 0`,
    )
    .get(site, monitor) as { ts: number | null };
  // `grp` counts successful checks so far, so every failed check between two
  // successes shares a value, and the success that ends a run has grp + 1.
  const rows = db
    .prepare(
      `WITH ordered AS (
         SELECT ts, ok, error,
                SUM(ok) OVER (ORDER BY ts ROWS UNBOUNDED PRECEDING) AS grp
         FROM checks
         WHERE site = ? AND monitor = ? AND ts >= ? AND ts < ? AND maintenance = 0
       ),
       runs AS (
         SELECT grp,
                MIN(ts) AS startTs,
                MAX(ts) AS endTs,
                COUNT(*) AS checks,
                SUM(CASE WHEN error = 'timeout' THEN 1 ELSE 0 END) AS timeouts,
                json_group_array(DISTINCT COALESCE(error, '')) AS errors
         FROM ordered
         WHERE ok = 0
         GROUP BY grp
       )
       SELECT runs.*,
              (SELECT MIN(ts) FROM ordered
               WHERE ok = 1 AND grp = runs.grp + 1) AS recoveredTs
       FROM runs
       ORDER BY startTs DESC`,
    )
    .all(site, monitor, sinceMs, untilMs) as Array<{
    startTs: number;
    endTs: number;
    checks: number;
    timeouts: number;
    errors: string;
    recoveredTs: number | null;
  }>;
  return rows.map((row) => ({
    startTs: row.startTs,
    endTs: row.endTs,
    checks: row.checks,
    timeouts: row.timeouts,
    errors: (JSON.parse(row.errors) as string[]).filter((e) => e !== ""),
    recoveredTs: row.recoveredTs,
    ongoing: latest.ts !== null && row.endTs === latest.ts,
  }));
}
