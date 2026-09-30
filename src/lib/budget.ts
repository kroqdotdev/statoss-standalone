import type Database from "better-sqlite3";
import { rollupSummary, type WindowSummary } from "./queries";

const MINUTE_MS = 60_000;

/** [start, end) of the UTC month that contains `ts`. */
export function monthWindow(ts: number): { start: number; end: number } {
  const d = new Date(ts);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start, end };
}

/** "September 2026", in UTC. */
export function monthName(ts: number): string {
  return new Date(ts).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export interface ErrorBudget {
  /** The uptime target in percent. */
  target: number;
  /** Checks passed over checks run this month, in percent, or null before any. */
  uptime: number | null;
  /** The month's allowance, from the target and the month's length. */
  budgetMinutes: number;
  /** The share of failed checks applied to the time the checks covered. */
  downMinutes: number;
  slowMinutes: number;
  remainingMinutes: number;
  /** Minutes of the month gone by. */
  elapsedMinutes: number;
  monthMinutes: number;
}

/**
 * Sums summaries across a site's monitors. The mean response time is over
 * the readings each part's mean was taken from, so a heartbeat (no response
 * time) does not pull it down.
 */
export function combine(parts: WindowSummary[]): WindowSummary {
  const total = parts.reduce((n, p) => n + p.total, 0);
  const up = parts.reduce((n, p) => n + p.up, 0);
  const weight = (p: WindowSummary) =>
    p.latencyMs === null ? 0 : (p.latencyN ?? p.up);
  const readings = parts.reduce((n, p) => n + weight(p), 0);
  const latencySum = parts.reduce(
    (n, p) => n + (p.latencyMs ?? 0) * weight(p),
    0,
  );
  const hours = parts.some((p) => p.hours !== undefined)
    ? Math.max(...parts.map((p) => p.hours ?? 0))
    : undefined;
  return {
    total,
    up,
    timeouts: parts.reduce((n, p) => n + p.timeouts, 0),
    slow: parts.reduce((n, p) => n + p.slow, 0),
    maintenance: parts.reduce((n, p) => n + p.maintenance, 0),
    latencyMs: readings > 0 ? Math.round(latencySum / readings) : null,
    latencyN: readings,
    ...(hours !== undefined ? { hours } : {}),
  };
}

/**
 * The minutes a share of checks stands for. Checks cover the hours they
 * ran in, not the whole span: a monitor added on the 28th that failed a
 * tenth of its checks was down a tenth of two days, not of the month.
 */
export function minutesCovered(
  part: number,
  totals: WindowSummary,
  spanMinutes: number,
): number {
  if (totals.total === 0) return 0;
  const covered =
    totals.hours !== undefined
      ? Math.min(spanMinutes, totals.hours * 60)
      : spanMinutes;
  return Math.round((part / totals.total) * covered);
}

/**
 * The month so far against a target. Down time is the share of checks that
 * failed applied to the minutes they covered. Maintenance checks are not in
 * the totals, so they never spend budget.
 */
export function errorBudget(
  totals: WindowSummary,
  target: number,
  now: number,
): ErrorBudget {
  const { start, end } = monthWindow(now);
  const monthMinutes = Math.round((end - start) / MINUTE_MS);
  const elapsedMinutes = Math.max(1, Math.round((now - start) / MINUTE_MS));
  // Whole minutes, except that a 99.999% target leaves under a minute a
  // month and rounding that to nothing would read as "0 min budget".
  const rawBudget = ((100 - target) / 100) * monthMinutes;
  const budgetMinutes = rawBudget < 1 ? rawBudget : Math.round(rawBudget);
  const uptime = totals.total === 0 ? null : (totals.up / totals.total) * 100;
  const downMinutes = minutesCovered(
    totals.total - totals.up,
    totals,
    elapsedMinutes,
  );
  const slowMinutes = minutesCovered(totals.slow, totals, elapsedMinutes);
  return {
    target,
    uptime,
    budgetMinutes,
    downMinutes,
    slowMinutes,
    remainingMinutes: budgetMinutes - downMinutes,
    elapsedMinutes,
    monthMinutes,
  };
}

/** This month's totals for a site's monitors, from the hourly totals. */
export function monthTotals(
  db: Database.Database,
  site: string,
  monitors: string[],
  now: number,
): WindowSummary {
  const { start, end } = monthWindow(now);
  return combine(
    monitors.map((monitor) => rollupSummary(db, site, monitor, start, end)),
  );
}

/** "99.97%" or "100%". Rounded down: one failed check never reads as 100. */
export function formatUptime(pct: number | null): string {
  if (pct === null) return "";
  if (pct >= 100) return "100%";
  return `${(Math.floor(pct * 100) / 100).toFixed(2)}%`;
}

/** "1 h 12 min", "12 min", "0 min", "under a minute". */
export function formatMinutes(minutes: number): string {
  if (minutes > 0 && minutes < 1) return "under a minute";
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

/**
 * The one sentence the page shows when a target is set. Example:
 * "September so far: 99.97% up against a 99.9% target. 12 min of the 43 min
 * downtime budget spent."
 */
export function describeBudget(b: ErrorBudget, now: number): string {
  const month = monthName(now).split(" ")[0];
  if (b.uptime === null)
    return `${month}: no checks yet against a ${b.target}% target.`;
  const spent =
    b.downMinutes === 0
      ? `None of the ${formatMinutes(b.budgetMinutes)} downtime budget spent`
      : b.remainingMinutes >= 0
        ? `${formatMinutes(b.downMinutes)} of the ${formatMinutes(b.budgetMinutes)} downtime budget spent`
        : `${formatMinutes(b.downMinutes)} down, ${formatMinutes(-b.remainingMinutes)} over the ${formatMinutes(b.budgetMinutes)} budget`;
  // The month's total, not a streak: the monitor rows show streaks.
  const slow =
    b.slowMinutes > 0 ? ` ${formatMinutes(b.slowMinutes)} slow in total.` : "";
  return `${month} so far: ${formatUptime(b.uptime)} up against a ${b.target}% target. ${spent}.${slow}`;
}
