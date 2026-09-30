import type { IncidentView } from "./incidents";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Months on one page of the history, newest first. */
export const HISTORY_MONTHS_PER_PAGE = 3;
/** The history always reaches back at least this far, incidents or not. */
export const HISTORY_MIN_DAYS = 90;

export interface HistoryMonth {
  /** "2026-09". */
  key: string;
  /** "September 2026". */
  label: string;
  /** Newest first. */
  incidents: IncidentView[];
}

/** The year and month of a moment in `tz`, as "2026-09". */
export function monthKey(ts: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(ts));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}`;
}

function monthLabel(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(Date.UTC(year, month - 1, 15));
}

/** The month before "2026-09": "2026-08". */
function previousMonth(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, "0")}`;
}

/**
 * Every month from now back to the oldest incident (three months at the
 * least), newest first, in the page's zone, each with the incidents that
 * started in it. A month without any is kept, so a quiet month reads as
 * quiet. Incidents and maintenance still ahead are left out.
 */
export function historyMonths(
  views: IncidentView[],
  now: number,
  tz: string,
): HistoryMonth[] {
  const listed = views.filter((v) => v.startedAt <= now);
  const oldest = Math.min(
    now - HISTORY_MIN_DAYS * DAY_MS,
    ...listed.map((v) => v.startedAt),
  );
  const first = monthKey(oldest, tz);
  const months: HistoryMonth[] = [];
  for (let key = monthKey(now, tz); key >= first; key = previousMonth(key))
    months.push({ key, label: monthLabel(key), incidents: [] });
  const byKey = new Map(months.map((m) => [m.key, m]));
  for (const view of listed)
    byKey.get(monthKey(view.startedAt, tz))?.incidents.push(view);
  for (const month of months)
    month.incidents.sort((a, b) => b.startedAt - a.startedAt);
  return months;
}

/** One page of months, and whether there are later or earlier ones. */
export function historyPage(
  months: HistoryMonth[],
  page: number,
): { months: HistoryMonth[]; page: number; later: boolean; earlier: boolean } {
  const last = Math.max(
    0,
    Math.ceil(months.length / HISTORY_MONTHS_PER_PAGE) - 1,
  );
  const at = Math.min(Math.max(0, Math.floor(page) || 0), last);
  return {
    months: months.slice(
      at * HISTORY_MONTHS_PER_PAGE,
      (at + 1) * HISTORY_MONTHS_PER_PAGE,
    ),
    page: at,
    later: at > 0,
    earlier: at < last,
  };
}
