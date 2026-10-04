import type Database from "better-sqlite3";
import { passedReadings } from "./queries";
import { hoursOf } from "./response-times";

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long after an hour ends its median is taken. A check is stored when
 * it ends, so an hour has all its checks a few seconds after it is over.
 */
export const FINISH_AFTER_MS = 5 * 60 * 1000;
/** Hours finished per monitor in one go. */
const CHUNK = 200;

/**
 * Gives up to `limit` of a monitor's hours in [since, before) that have
 * response times and no median yet, newest first, the median and 95th
 * percentile of their checks. Only hours whose checks are still kept are
 * looked at; an older one goes on standing in with its mean.
 */
function finishMonitor(
  db: Database.Database,
  site: string,
  monitor: string,
  since: number,
  before: number,
  limit: number,
): number {
  const oldest = db
    .prepare("SELECT MIN(ts) FROM checks WHERE site = ? AND monitor = ?")
    .pluck()
    .get(site, monitor) as number | null;
  if (oldest === null) return 0;
  const from = Math.max(since, Math.floor(oldest / HOUR_MS) * HOUR_MS);
  const pending = db
    .prepare(
      `SELECT ts, latency_sum AS sum, latency_n AS n FROM check_hour
       WHERE site = ? AND monitor = ? AND ts >= ? AND ts < ?
         AND latency_n > 0 AND latency_p50 IS NULL
       ORDER BY ts DESC LIMIT ?`,
    )
    .all(site, monitor, from, before, limit) as Array<{
    ts: number;
    sum: number;
    n: number;
  }>;
  if (pending.length === 0) return 0;
  const read = new Map(
    hoursOf(
      passedReadings(
        db,
        site,
        monitor,
        pending[pending.length - 1].ts,
        pending[0].ts + HOUR_MS,
      ),
    ).map((h) => [h.ts, h]),
  );
  const set = db.prepare(
    `UPDATE check_hour SET latency_p50 = ?, latency_p95 = ?
     WHERE site = ? AND monitor = ? AND ts = ?`,
  );
  db.transaction(() => {
    for (const row of pending) {
      const h = read.get(row.ts);
      const mean = Math.round(row.sum / row.n);
      set.run(h?.p50 ?? mean, h?.p95 ?? mean, site, monitor, row.ts);
    }
  })();
  return pending.length;
}

/**
 * Gives finished hours from `since` on their median and 95th percentile,
 * the figures the 7-day, 90-day and 1-year views draw, about `limit` of
 * them at a time, newest first. `before` holds it to earlier hours. `more`
 * says some were left for the next call: after an upgrade, the hours of
 * the checks that were already kept.
 */
export function finishHours(
  db: Database.Database,
  monitors: Array<{ site: string; monitor: string }>,
  now: number,
  {
    since = 0,
    before = Infinity,
    limit = 600,
  }: { since?: number; before?: number; limit?: number } = {},
): { finished: number; more: boolean } {
  const until = Math.min(
    before,
    Math.floor((now - FINISH_AFTER_MS) / HOUR_MS) * HOUR_MS,
  );
  let finished = 0;
  for (const { site, monitor } of monitors) {
    for (;;) {
      if (finished >= limit) return { finished, more: true };
      const asked = Math.min(CHUNK, limit - finished);
      const n = finishMonitor(db, site, monitor, since, until, asked);
      finished += n;
      if (n < asked) break;
    }
  }
  return { finished, more: false };
}
