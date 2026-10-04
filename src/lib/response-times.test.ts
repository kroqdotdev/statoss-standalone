import { describe, expect, it } from "vitest";
import {
  hoursOf,
  median,
  periodQuantile,
  quantile,
  rawResponseTimes,
  rollupResponseTimes,
  windowFigures,
  type HourFigures,
  type Reading,
} from "./response-times";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.UTC(2026, 8, 30, 0);
/** A day of five-minute bars, as the 24-hour range has them. */
const DAY_GRID = { start: START, bucketMs: 5 * MINUTE, buckets: 288 };

/** A reading every `every` minutes, from `from`, `count` of them. */
function readings(
  ms: number | ((i: number) => number),
  { from = START, every = 1, count = 1440 } = {},
): Reading[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: from + i * every * MINUTE,
    ms: typeof ms === "number" ? ms : ms(i),
  }));
}

describe("medians and percentiles", () => {
  it("takes the nearest rank", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(quantile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.95)).toBe(100);
    expect(median([300, 100, 200])).toBe(200);
    expect(median([])).toBeNull();
  });

  it("gives alike hours their own median and 95th percentile", () => {
    const hours = [
      { n: 60, p50: 100, p95: 180 },
      { n: 60, p50: 100, p95: 180 },
    ];
    expect(periodQuantile(hours, 0.5)).toBeCloseTo(100, 1);
    expect(periodQuantile(hours, 0.95)).toBeCloseTo(180, 1);
  });

  it("puts unlike hours' median between theirs, nearer the one with more checks", () => {
    const mid = periodQuantile(
      [
        { n: 90, p50: 100, p95: 150 },
        { n: 30, p50: 200, p95: 300 },
      ],
      0.5,
    );
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(150);
    expect(periodQuantile([], 0.5)).toBeNull();
    expect(periodQuantile([{ n: 0, p50: 100, p95: 100 }], 0.5)).toBeNull();
  });

  it("keeps the tail of an hour whose median was 0 ms", () => {
    const lan = [{ n: 60, p50: 0, p95: 1 }];
    expect(Math.round(periodQuantile(lan, 0.5) ?? -1)).toBe(0);
    expect(periodQuantile(lan, 0.95)).toBeCloseTo(1, 1);
    const week = rollupResponseTimes(
      Array.from({ length: 168 }, (_, i) => ({
        ts: START + i * HOUR,
        n: 60,
        p50: 0,
        p95: 3,
      })),
      { start: START, bucketMs: HOUR, buckets: 168 },
    );
    expect(week.buckets.every((ms) => ms === 0)).toBe(true);
    expect(week.medianMs).toBe(0);
    expect(week.p95Ms).toBe(3);
  });

  it("takes an hour whose readings were all alike as exactly that", () => {
    expect(periodQuantile([{ n: 60, p50: 0, p95: 0 }], 0.5)).toBe(0);
    expect(periodQuantile([{ n: 60, p50: 80, p95: 80 }], 0.95)).toBe(80);
  });

  it("groups readings into their hours", () => {
    expect(
      hoursOf([
        { ts: START, ms: 100 },
        { ts: START + MINUTE, ms: 300 },
        { ts: START + 2 * MINUTE, ms: 200 },
        { ts: START + HOUR, ms: 50 },
      ]),
    ).toEqual([
      { ts: START, n: 3, p50: 200, p95: 300 },
      { ts: START + HOUR, n: 1, p50: 50, p95: 50 },
    ]);
  });

  it("gives a window's median and 95th percentile", () => {
    const all = readings((i) => (i % 10 === 0 ? 900 : 100));
    expect(windowFigures(all, START, START + 24 * HOUR)).toEqual({
      medianMs: 100,
      p95Ms: 900,
      n: 1440,
    });
    expect(windowFigures(all, START - HOUR, START)).toEqual({
      medianMs: null,
      p95Ms: null,
      n: 0,
    });
  });
});

describe("the 24-hour range", () => {
  it("makes no spike of one slow check", () => {
    const all = readings((i) => (i === 600 ? 5000 : 100));
    const times = rawResponseTimes(all, DAY_GRID);
    expect(times.buckets.every((ms) => ms === 100)).toBe(true);
    expect(times.medianMs).toBe(100);
    expect(times.p95Ms).toBe(100);
    expect(times.n).toBe(1440);
  });

  it("draws 150, 350, 210 and 90 in turn as the median of the eleven readings around each bar", () => {
    const cycle = [150, 350, 210, 90];
    const times = rawResponseTimes(
      readings((i) => cycle[i % 4]),
      DAY_GRID,
    );
    expect(times.buckets).toHaveLength(288);
    expect(times.buckets.every((ms) => ms === 150 || ms === 210)).toBe(true);
    expect(times.medianMs).toBe(150);
    expect(times.p95Ms).toBe(350);
  });

  it("shows a slowdown from the bar it began in", () => {
    // 100 ms until noon, 400 from then on: the bar before noon still
    // reads 100, the first after it 400.
    const noon = START + 12 * HOUR;
    const times = rawResponseTimes(
      readings((i) => (START + i * MINUTE >= noon ? 400 : 100)),
      DAY_GRID,
    );
    const at = (noon - START) / DAY_GRID.bucketMs;
    expect(times.buckets[at - 2]).toBe(100);
    expect(times.buckets[at]).toBe(400);
    expect(times.buckets[at + 1]).toBe(400);
  });

  it("uses readings from before the range for its first bars, and leaves a bar with none of its own empty", () => {
    const before = readings(500, { from: START - HOUR, count: 60 });
    const times = rawResponseTimes(
      [...before, ...readings(100, { every: 10, count: 144 })],
      DAY_GRID,
    );
    // The first bar's reading has five slow ones before it and five fast
    // ones after it, with itself the sixth fast one.
    expect(times.buckets[0]).toBe(100);
    expect(times.buckets[1]).toBeNull();
    expect(times.buckets[2]).toBe(100);
    // The figures are over the range alone.
    expect(times.n).toBe(144);
    expect(times.p95Ms).toBe(100);
  });

  it("reads its readings in any order", () => {
    const all = readings((i) => 100 + (i % 7));
    const shuffled = [...all].reverse();
    expect(rawResponseTimes(shuffled, DAY_GRID)).toEqual(
      rawResponseTimes(all, DAY_GRID),
    );
  });
});

describe("ranges read from the hours", () => {
  const WEEK = { start: START, bucketMs: HOUR, buckets: 168 };
  const YEAR_DAYS = { start: START, bucketMs: 24 * HOUR, buckets: 7 };
  function hours(p50: number, p95: number, count = 168): HourFigures[] {
    return Array.from({ length: count }, (_, i) => ({
      ts: START + i * HOUR,
      n: 60,
      p50,
      p95,
    }));
  }

  it("gives each bar its hour's median, and the range its median and 95th percentile", () => {
    const times = rollupResponseTimes(hours(100, 150), WEEK);
    expect(times.buckets[0]).toBe(100);
    expect(times.buckets.every((ms) => ms === 100)).toBe(true);
    expect(times.medianMs).toBe(100);
    expect(times.p95Ms).toBe(150);
    expect(times.n).toBe(168 * 60);
  });

  it("gives a day's bar the median of its hours, and leaves days without hours empty", () => {
    const list = [
      ...hours(100, 120, 23),
      { ts: START + 23 * HOUR, n: 60, p50: 2000, p95: 4000 },
    ];
    const times = rollupResponseTimes(list, YEAR_DAYS);
    // One slow hour in a day moves the day's median by little.
    expect(times.buckets[0]).toBeGreaterThanOrEqual(100);
    expect(times.buckets[0]).toBeLessThan(110);
    expect(times.buckets.slice(1)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("leaves hours outside the range out", () => {
    const times = rollupResponseTimes(
      [{ ts: START - HOUR, n: 60, p50: 900, p95: 900 }, ...hours(100, 100, 2)],
      WEEK,
    );
    expect(times.medianMs).toBe(100);
    expect(times.n).toBe(120);
  });
});
