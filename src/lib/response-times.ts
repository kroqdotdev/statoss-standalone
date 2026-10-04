/*
 * Response times as the page shows them: medians, so one slow check makes
 * no spike and the bars hold still from one minute to the next.
 *
 * - On the 24-hour range each bar is the median of the eleven readings
 *   around it: its own last reading and five either side, fewer at the
 *   live end. Centred, a slowdown shows where it began.
 * - On the longer ranges a bar is the median of its hour or its day, from
 *   each hour's median and 95th percentile as the hourly totals keep them.
 * - Above the strip are the median over the range and the 95th
 *   percentile: the figure 95% of checks came in under.
 *
 * Everything here is pure: the readings and the hours are passed in.
 */

/** One passed check with a response time: when, and how long it took. */
export interface Reading {
  ts: number;
  ms: number;
}

/** An hour's passed checks with a response time: how many, their median and 95th percentile. */
export interface HourFigures {
  ts: number;
  n: number;
  p50: number;
  p95: number;
}

/** A range's buckets: `buckets` of `bucketMs` from `start`. */
export interface Grid {
  start: number;
  bucketMs: number;
  buckets: number;
}

export interface Figures {
  medianMs: number | null;
  /** 95 in 100 readings were at or under this. */
  p95Ms: number | null;
  /** How many readings these are over. */
  n: number;
}

export interface ResponseTimes extends Figures {
  /** Per bucket, what its bar shows, or null without a reading. */
  buckets: Array<number | null>;
}

/**
 * A 24-hour bar is the median of the readings around it: its last one in
 * the bar and this many either side. On the hosted StatOSS sites, eleven
 * held consecutive bars to a change of 2% at the median, against 9% for
 * the last five readings alone.
 */
export const ROLLING_AROUND = 5;

const HOUR_MS = 60 * 60 * 1000;

/** The value at share `q` (0 to 1) of sorted numbers, by nearest rank. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  return quantile(
    [...values].sort((a, b) => a - b),
    0.5,
  );
}

/** The standard normal's distribution function, to seven places (Abramowitz and Stegun 7.1.26). */
function normalShare(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    t *
      (0.254829592 +
        t *
          (-0.284496736 +
            t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) *
      Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** How far the 95th percentile sits above the median, in standard deviations. */
const Z95 = 1.6448536;
/**
 * What an hour's median of 0 ms stands for when its 95th percentile is
 * above it: readings are whole milliseconds, so 0 was under 1, and a
 * log-normal needs a median above 0 to carry the tail. Under half a
 * millisecond, so it still rounds to 0.
 */
const ZERO_MS = 0.4;

/**
 * The value under which a share `q` of the readings fall, from hours that
 * kept only their count, median and 95th percentile. Each hour is taken
 * as log-normal through those two, the usual shape of response times:
 * most readings close to the median, a long tail above it. Exact when the
 * hours are alike; between them when they are not.
 */
export function periodQuantile(
  periods: Array<Pick<HourFigures, "n" | "p50" | "p95">>,
  q: number,
): number | null {
  const kept = periods
    .filter((p) => p.n > 0)
    .map((p) => {
      // A LAN ping or a DNS lookup can read 0 ms most of the time and 1 ms
      // or more now and then; its tail is kept.
      const p50 = p.p50 <= 0 && p.p95 > ZERO_MS ? ZERO_MS : p.p50;
      return {
        n: p.n,
        p50,
        mu: Math.log(Math.max(p50, 1e-6)),
        sigma: p.p95 > p50 && p50 > 0 ? Math.log(p.p95 / p50) / Z95 : 0,
      };
    });
  if (kept.length === 0) return null;
  const total = kept.reduce((s, p) => s + p.n, 0);
  const under = (ms: number) => {
    const at = Math.log(Math.max(ms, 1e-6));
    let n = 0;
    for (const p of kept)
      n +=
        p.sigma === 0
          ? ms < p.p50
            ? 0
            : p.n
          : p.n * normalShare((at - p.mu) / p.sigma);
    return n / total;
  };
  // Between the fastest median and the slowest tail, well past its 95th.
  let lo = Infinity;
  let hi = 0;
  for (const p of kept) {
    lo = Math.min(lo, p.p50 * Math.exp(-4 * p.sigma));
    hi = Math.max(hi, p.p50 * Math.exp(4 * p.sigma));
  }
  if (under(lo) >= q) return lo;
  // To a hundredth of a millisecond: the page rounds to whole ones, and a
  // year is 8,760 hours to sum at every step.
  for (let i = 0; i < 60 && hi - lo > 0.01; i++) {
    const mid = (lo + hi) / 2;
    if (under(mid) >= q) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Readings grouped into their hours, as the hourly totals keep them. */
export function hoursOf(readings: Reading[]): HourFigures[] {
  const groups = new Map<number, number[]>();
  for (const r of readings) {
    const hour = Math.floor(r.ts / HOUR_MS) * HOUR_MS;
    const list = groups.get(hour);
    if (list) list.push(r.ms);
    else groups.set(hour, [r.ms]);
  }
  return [...groups].map(([ts, values]) => {
    const sorted = values.sort((a, b) => a - b);
    return {
      ts,
      n: sorted.length,
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
    };
  });
}

function round(v: number | null): number | null {
  return v === null ? null : Math.round(v);
}

/** The median and the 95th percentile of the readings in [since, until). */
export function windowFigures(
  readings: Reading[],
  since: number,
  until: number,
): Figures {
  const values = readings
    .filter((r) => r.ts >= since && r.ts < until)
    .map((r) => r.ms)
    .sort((a, b) => a - b);
  return values.length === 0
    ? { medianMs: null, p95Ms: null, n: 0 }
    : {
        medianMs: Math.round(quantile(values, 0.5)),
        p95Ms: Math.round(quantile(values, 0.95)),
        n: values.length,
      };
}

/**
 * Response times over a range from the checks themselves. `readings` may
 * start before the grid, so its first bars have readings to take a median
 * of. A bucket with a reading of its own shows the median of the readings
 * around its last one (ROLLING_AROUND); one without shows none.
 */
export function rawResponseTimes(
  readings: Reading[],
  grid: Grid,
): ResponseTimes {
  const list = [...readings].sort((a, b) => a.ts - b.ts);
  const end = grid.start + grid.buckets * grid.bucketMs;
  const buckets = new Array<number | null>(grid.buckets).fill(null);
  let i = -1;
  for (let b = 0; b < grid.buckets; b++) {
    const from = grid.start + b * grid.bucketMs;
    const to = from + grid.bucketMs;
    while (i + 1 < list.length && list[i + 1].ts < to) i++;
    if (i < 0 || list[i].ts < from) continue;
    const around = list
      .slice(Math.max(0, i - ROLLING_AROUND), i + ROLLING_AROUND + 1)
      .map((r) => r.ms);
    buckets[b] = round(median(around));
  }
  return { buckets, ...windowFigures(list, grid.start, end) };
}

/**
 * Response times over a range from the hours: a bar is the median of its
 * bucket's hours, and the figures are over every hour in the range.
 */
export function rollupResponseTimes(
  hours: HourFigures[],
  grid: Grid,
): ResponseTimes {
  const end = grid.start + grid.buckets * grid.bucketMs;
  const inRange = hours.filter((h) => h.ts >= grid.start && h.ts < end);
  const per: HourFigures[][] = Array.from({ length: grid.buckets }, () => []);
  for (const h of inRange)
    per[Math.floor((h.ts - grid.start) / grid.bucketMs)].push(h);
  return {
    buckets: per.map((list) => round(periodQuantile(list, 0.5))),
    medianMs: round(periodQuantile(inRange, 0.5)),
    p95Ms: round(periodQuantile(inRange, 0.95)),
    n: inRange.reduce((s, h) => s + h.n, 0),
  };
}
