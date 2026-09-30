import type Database from "better-sqlite3";
import { describeError } from "./format";
import { rollupSummary } from "./queries";

/**
 * What a bar on a strip opens to: the checks behind it, one by one. Read
 * from the checks themselves; a bar older than those are kept has its
 * hourly totals only.
 */

const HOUR_MS = 60 * 60 * 1000;
/** The widest bar there is: a day on the 90-day and 1-year views. */
export const MAX_DETAIL_WINDOW_MS = 24 * HOUR_MS;
/** How many checks are listed. A day at a check a minute is 1,440. */
export const DETAIL_ROWS = 300;

export interface DetailCheck {
  ts: number;
  ok: boolean;
  slow: boolean;
  maintenance: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  /**
   * What went wrong, in the page's own words: "Timed out". Null on a pass.
   * The stored error is not sent: it can name a host or an address the
   * public page does not show.
   */
  problem: string | null;
}

export interface CheckDetail {
  from: number;
  to: number;
  total: number;
  passed: number;
  timeouts: number;
  slow: number;
  maintenance: number;
  /** min and max are null when the figures come from the hours' totals, which keep a mean only. */
  latency: { mean: number; min: number | null; max: number | null } | null;
  checks: DetailCheck[];
  /**
   * all: every check in the window is listed. trouble: there were too
   * many, so only those that did not pass cleanly are. none: the checks
   * are gone and the figures come from the hourly totals. partial: some
   * are gone, so the figures come from the totals and the list holds what
   * is left.
   */
  listed: "all" | "trouble" | "none" | "partial";
}

interface Row {
  ts: number;
  ok: 0 | 1;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
  maintenance: 0 | 1;
}

export function checkDetail(
  db: Database.Database,
  site: string,
  monitor: string,
  slowThresholdMs: number | null,
  from: number,
  to: number,
): CheckDetail {
  const where = "site = ? AND monitor = ? AND ts >= ? AND ts < ?";
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(maintenance = 0), 0) AS total,
              COALESCE(SUM(ok = 1 AND maintenance = 0), 0) AS passed,
              COALESCE(SUM(ok = 0 AND maintenance = 0 AND error = 'timeout'), 0) AS timeouts,
              COALESCE(SUM(ok = 1 AND maintenance = 0 AND ? IS NOT NULL AND latency_ms > ?), 0) AS slow,
              COALESCE(SUM(maintenance = 1), 0) AS maintenance,
              ROUND(AVG(CASE WHEN ok = 1 AND maintenance = 0 THEN latency_ms END)) AS mean,
              MIN(CASE WHEN ok = 1 AND maintenance = 0 THEN latency_ms END) AS min,
              MAX(CASE WHEN ok = 1 AND maintenance = 0 THEN latency_ms END) AS max,
              COUNT(*) AS kept
       FROM checks WHERE ${where}`,
    )
    .get(slowThresholdMs, slowThresholdMs, site, monitor, from, to) as {
    total: number;
    passed: number;
    timeouts: number;
    slow: number;
    maintenance: number;
    mean: number | null;
    min: number | null;
    max: number | null;
    kept: number;
  };
  // What the hours say was there, for a window that reaches back past the
  // checks that are kept. Whole hours only, so it is asked only for those.
  const wholeHours = from % HOUR_MS === 0 && to % HOUR_MS === 0;
  const hours = wholeHours ? rollupSummary(db, site, monitor, from, to) : null;
  const had = hours ? hours.total + hours.maintenance : totals.kept;
  const gone = hours !== null && had > totals.kept;

  const tooMany = totals.kept > DETAIL_ROWS;
  const rows = db
    .prepare(
      `SELECT ts, ok, status_code AS statusCode, latency_ms AS latencyMs, error, maintenance
       FROM checks WHERE ${where}
       ${tooMany ? "AND (ok = 0 OR maintenance = 1 OR (? IS NOT NULL AND latency_ms > ?))" : ""}
       ORDER BY ts DESC LIMIT ${DETAIL_ROWS}`,
    )
    .all(
      ...(tooMany
        ? [site, monitor, from, to, slowThresholdMs, slowThresholdMs]
        : [site, monitor, from, to]),
    ) as Row[];

  const figures =
    gone && hours
      ? {
          total: hours.total,
          passed: hours.up,
          timeouts: hours.timeouts,
          slow: hours.slow,
          maintenance: hours.maintenance,
          latency:
            hours.latencyMs === null
              ? null
              : { mean: hours.latencyMs, min: null, max: null },
        }
      : {
          total: totals.total,
          passed: totals.passed,
          timeouts: totals.timeouts,
          slow: totals.slow,
          maintenance: totals.maintenance,
          latency:
            totals.mean === null
              ? null
              : {
                  mean: totals.mean,
                  min: totals.min ?? totals.mean,
                  max: totals.max ?? totals.mean,
                },
        };
  return {
    from,
    to,
    ...figures,
    checks: rows.map((row) => ({
      ts: row.ts,
      ok: row.ok === 1,
      slow:
        row.ok === 1 &&
        slowThresholdMs !== null &&
        row.latencyMs !== null &&
        row.latencyMs > slowThresholdMs,
      maintenance: row.maintenance === 1,
      statusCode: row.statusCode,
      latencyMs: row.latencyMs,
      problem: row.ok === 1 ? null : describeError(row.error),
    })),
    listed:
      totals.kept === 0 && had > 0
        ? "none"
        : gone
          ? "partial"
          : tooMany
            ? "trouble"
            : "all",
  };
}
