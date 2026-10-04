import { clockParts, type Parts } from "./format";

/*
 * When maintenance that repeats falls. A window keeps the first one's
 * wall-clock time in a zone, so a window at 02:00 in Copenhagen stays at
 * 02:00 on both sides of daylight saving.
 */

export const REPEATS = ["weekly", "monthly", "monthly-weekday"] as const;
export type Repeat = (typeof REPEATS)[number];

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const WEEK_MS = 7 * DAY_MS;
/** The furthest a Date reaches. */
const LAST_MOMENT = 8.64e15;

/** How long a window may last, so it ends before the next one starts. */
export function longestWindow(repeat: Repeat): number {
  return repeat === "weekly" ? WEEK_MS : 28 * DAY_MS;
}

/** The zone's offset from UTC at `ts`, in ms, to the minute. */
function offsetAt(ts: number, zone: string): number {
  if (!(Math.abs(ts) <= LAST_MOMENT)) return NaN;
  const p = clockParts(ts, zone);
  const wall = Date.UTC(p.year, p.month, p.day, p.hour, p.minute);
  return wall - Math.floor(ts / MINUTE_MS) * MINUTE_MS;
}

/**
 * The moment a wall-clock time in `zone` names. A time the clocks skip
 * (02:30 on the night they go forward) moves on by the jump, to 03:30.
 * NaN past what a date can hold.
 */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): number {
  const wall = Date.UTC(year, month, day, hour, minute);
  const first = offsetAt(wall, zone);
  const guess = wall - first;
  const second = offsetAt(guess, zone);
  if (second === first) return guess;
  const again = wall - second;
  if (offsetAt(again, zone) === second) return again;
  // Neither offset reads back as this wall time: it is in the gap.
  return wall - Math.min(first, second);
}

/** The days in a month; `month` may run past 11 into the next year. */
function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** The date of the nth `weekday` of a month, or its last with `nth` 5. */
function nthWeekday(
  year: number,
  month: number,
  weekday: number,
  nth: number,
): number {
  if (nth >= 5) {
    const last = daysIn(year, month);
    const lastWeekday = new Date(Date.UTC(year, month, last)).getUTCDay();
    return last - ((lastWeekday - weekday + 7) % 7);
  }
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((weekday - firstWeekday + 7) % 7) + (nth - 1) * 7;
}

/**
 * Which of its weekdays in the month a day is: 1 to 4, or 5 for the last.
 * The 29th, 30th and 31st are always the last.
 */
export function weekOfMonth(day: number): number {
  return Math.min(5, Math.ceil(day / 7));
}

export interface SeriesTimes {
  repeat: Repeat;
  zone: string;
  firstStartsAt: number;
}

/** The start of the kth window, the first being k = 0. */
function nthStart(series: SeriesTimes, first: Parts, k: number): number {
  if (series.repeat === "weekly") {
    const d = new Date(Date.UTC(first.year, first.month, first.day + 7 * k));
    return zonedTime(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      first.hour,
      first.minute,
      series.zone,
    );
  }
  const month = first.month + k;
  const year = first.year + Math.floor(month / 12);
  const m = ((month % 12) + 12) % 12;
  const day =
    series.repeat === "monthly"
      ? Math.min(first.day, daysIn(year, m))
      : nthWeekday(year, m, first.weekday, weekOfMonth(first.day));
  return zonedTime(year, m, day, first.hour, first.minute, series.zone);
}

/**
 * The starts after `after` and up to `until`, oldest first, at most
 * `limit` of them. It looks at no more than `limit` windows past the one
 * before `after`, so a time it cannot read ends the search.
 */
export function startsBetween(
  series: SeriesTimes,
  after: number,
  until: number,
  limit = 100,
): number[] {
  if (
    !Number.isFinite(series.firstStartsAt) ||
    !Number.isFinite(after) ||
    !Number.isFinite(until)
  )
    return [];
  const first = clockParts(series.firstStartsAt, series.zone);
  // The window before the first one after `after`: whole weeks, or whole
  // months counted on the calendar, one short for daylight saving.
  let k0 = 0;
  if (after > series.firstStartsAt) {
    if (series.repeat === "weekly")
      k0 = Math.floor((after - series.firstStartsAt) / WEEK_MS) - 1;
    else {
      const a = clockParts(Math.min(after, LAST_MOMENT), series.zone);
      k0 = (a.year - first.year) * 12 + (a.month - first.month) - 1;
    }
    k0 = Math.max(0, k0);
  }
  const out: number[] = [];
  for (let k = k0; k < k0 + limit + 3 && out.length < limit; k++) {
    const start = nthStart(series, first, k);
    if (!Number.isFinite(start) || start > until) break;
    if (start > after) out.push(start);
  }
  return out;
}
