import type Database from "better-sqlite3";

const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET_MS = 5 * 60 * 1000;

export interface DayUptime {
  date: string;
  total: number;
  up: number;
  uptimePct: number | null;
}

export interface LatencyPoint {
  ts: number;
  latencyMs: number;
}

function startOfUtcDay(ts: number): number {
  return Math.floor(ts / DAY_MS) * DAY_MS;
}

export function dailyUptime(
  db: Database.Database,
  site: string,
  checkpoint: string,
  days = 90,
  now = Date.now(),
): DayUptime[] {
  const since = startOfUtcDay(now) - (days - 1) * DAY_MS;
  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS date,
              COUNT(*) AS total,
              SUM(ok) AS up
       FROM checks
       WHERE site = ? AND checkpoint = ? AND ts >= ?
       GROUP BY date`,
    )
    .all(site, checkpoint, since) as Array<{
    date: string;
    total: number;
    up: number;
  }>;
  const byDate = new Map(rows.map((row) => [row.date, row]));

  const result: DayUptime[] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(since + i * DAY_MS).toISOString().slice(0, 10);
    const row = byDate.get(date);
    result.push(
      row
        ? {
            date,
            total: row.total,
            up: row.up,
            uptimePct: Math.round((row.up / row.total) * 1000) / 10,
          }
        : { date, total: 0, up: 0, uptimePct: null },
    );
  }
  return result;
}

export function latencySeries(
  db: Database.Database,
  site: string,
  checkpoint: string,
  sinceMs: number,
  untilMs: number,
): LatencyPoint[] {
  return db
    .prepare(
      `SELECT (ts / ${BUCKET_MS}) * ${BUCKET_MS} AS ts,
              ROUND(AVG(latency_ms)) AS latencyMs
       FROM checks
       WHERE site = ? AND checkpoint = ? AND ts >= ? AND ts <= ?
         AND ok = 1 AND latency_ms IS NOT NULL
       GROUP BY (ts / ${BUCKET_MS}) * ${BUCKET_MS}
       ORDER BY ts`,
    )
    .all(site, checkpoint, sinceMs, untilMs) as LatencyPoint[];
  // Note: integer division — ts and BUCKET_MS are both integers in SQLite.
}
