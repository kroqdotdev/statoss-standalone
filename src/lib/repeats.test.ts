import { describe, expect, it } from "vitest";
import {
  longestWindow,
  startsBetween,
  weekOfMonth,
  zonedTime,
  type SeriesTimes,
} from "./repeats";

const iso = (ts: number) => new Date(ts).toISOString().replace(".000", "");
const at = (text: string) => Date.parse(text);
const DAY = 24 * 60 * 60_000;
const YEAR = 366 * DAY;

function starts(series: SeriesTimes, count: number): string[] {
  return startsBetween(
    series,
    series.firstStartsAt - 1,
    series.firstStartsAt + 2 * YEAR,
    count,
  ).map(iso);
}

describe("when repeating maintenance falls", () => {
  it("keeps a weekly window at its wall-clock time across daylight saving", () => {
    // 03:00 in Copenhagen each Sunday: summer time, then winter time.
    const series: SeriesTimes = {
      repeat: "weekly",
      zone: "Europe/Copenhagen",
      firstStartsAt: at("2026-10-18T01:00:00Z"),
    };
    expect(starts(series, 3)).toEqual([
      "2026-10-18T01:00:00Z",
      "2026-10-25T02:00:00Z",
      "2026-11-01T02:00:00Z",
    ]);
    // In UTC it stays at the same UTC time.
    expect(starts({ ...series, zone: "UTC" }, 2)).toEqual([
      "2026-10-18T01:00:00Z",
      "2026-10-25T01:00:00Z",
    ]);
  });

  it("keeps a window west of UTC on its local day when that is the next day in UTC", () => {
    // Sunday 22:00 in New York is Monday in UTC, and moves an hour in November.
    const series: SeriesTimes = {
      repeat: "weekly",
      zone: "America/New_York",
      firstStartsAt: at("2026-10-26T02:00:00Z"),
    };
    expect(starts(series, 3)).toEqual([
      "2026-10-26T02:00:00Z",
      "2026-11-02T03:00:00Z",
      "2026-11-09T03:00:00Z",
    ]);
  });

  it("moves a time the clocks skip on by the jump", () => {
    // 02:30 does not happen in Copenhagen on 28 March 2027.
    expect(iso(zonedTime(2027, 2, 28, 2, 30, "Europe/Copenhagen"))).toBe(
      "2027-03-28T01:30:00Z",
    );
    expect(iso(zonedTime(2027, 2, 21, 2, 30, "Europe/Copenhagen"))).toBe(
      "2027-03-21T01:30:00Z",
    );
    expect(iso(zonedTime(2027, 3, 4, 2, 30, "Europe/Copenhagen"))).toBe(
      "2027-04-04T00:30:00Z",
    );
    expect(iso(zonedTime(2026, 10, 8, 9, 0, "America/New_York"))).toBe(
      "2026-11-08T14:00:00Z",
    );
  });

  it("puts a monthly date a month does not have on its last day", () => {
    const series: SeriesTimes = {
      repeat: "monthly",
      zone: "UTC",
      firstStartsAt: at("2027-01-31T10:00:00Z"),
    };
    expect(starts(series, 5)).toEqual([
      "2027-01-31T10:00:00Z",
      "2027-02-28T10:00:00Z",
      "2027-03-31T10:00:00Z",
      "2027-04-30T10:00:00Z",
      "2027-05-31T10:00:00Z",
    ]);
    // 2028 is a leap year.
    expect(
      startsBetween(
        series,
        at("2028-02-01T00:00:00Z"),
        at("2028-03-01T00:00Z"),
      ).map(iso),
    ).toEqual(["2028-02-29T10:00:00Z"]);
  });

  it("keeps a monthly date in its zone where that is the day before in UTC", () => {
    // 08:00 on the 1st in Auckland is the evening before in UTC, on the
    // last day of the month before, whatever its length.
    const series: SeriesTimes = {
      repeat: "monthly",
      zone: "Pacific/Auckland",
      firstStartsAt: at("2027-01-31T19:00:00Z"),
    };
    expect(starts(series, 4)).toEqual([
      "2027-01-31T19:00:00Z",
      "2027-02-28T19:00:00Z",
      "2027-03-31T19:00:00Z",
      // Daylight saving ends in Auckland on 4 April 2027.
      "2027-04-30T20:00:00Z",
    ]);
  });

  it("finds the second Tuesday, and the last Friday, of each month", () => {
    const tuesday: SeriesTimes = {
      repeat: "monthly-weekday",
      zone: "UTC",
      firstStartsAt: at("2026-10-13T22:00:00Z"),
    };
    expect(starts(tuesday, 4)).toEqual([
      "2026-10-13T22:00:00Z",
      "2026-11-10T22:00:00Z",
      "2026-12-08T22:00:00Z",
      "2027-01-12T22:00:00Z",
    ]);
    const friday: SeriesTimes = {
      repeat: "monthly-weekday",
      zone: "UTC",
      firstStartsAt: at("2026-10-30T06:00:00Z"),
    };
    expect(starts(friday, 3)).toEqual([
      "2026-10-30T06:00:00Z",
      "2026-11-27T06:00:00Z",
      "2026-12-25T06:00:00Z",
    ]);
    expect([1, 7, 8, 28, 29, 31].map(weekOfMonth)).toEqual([1, 1, 2, 4, 5, 5]);
  });

  it("reads the weekday of the month in its zone", () => {
    // The first Monday at 07:00 in Tokyo is a Sunday in UTC.
    const series: SeriesTimes = {
      repeat: "monthly-weekday",
      zone: "Asia/Tokyo",
      firstStartsAt: at("2026-10-04T22:00:00Z"),
    };
    expect(starts(series, 3)).toEqual([
      "2026-10-04T22:00:00Z",
      "2026-11-01T22:00:00Z",
      "2026-12-06T22:00:00Z",
    ]);
  });

  it("gives the starts after one moment and up to another, however long it has run", () => {
    const series: SeriesTimes = {
      repeat: "weekly",
      zone: "UTC",
      firstStartsAt: at("2020-01-05T02:00:00Z"),
    };
    expect(
      startsBetween(
        series,
        at("2026-10-04T02:00:00Z"),
        at("2026-10-18T02:00:00Z"),
      ).map(iso),
    ).toEqual(["2026-10-11T02:00:00Z", "2026-10-18T02:00:00Z"]);
    expect(
      startsBetween(
        series,
        at("2026-10-04T02:00:00Z"),
        at("2026-10-05T00:00:00Z"),
      ),
    ).toEqual([]);
    const monthly: SeriesTimes = {
      ...series,
      repeat: "monthly",
      zone: "Europe/Copenhagen",
    };
    expect(
      startsBetween(
        monthly,
        at("2026-10-01T00:00:00Z"),
        at("2026-12-31T00:00:00Z"),
      ).map(iso),
    ).toEqual([
      "2026-10-05T01:00:00Z",
      "2026-11-05T02:00:00Z",
      "2026-12-05T02:00:00Z",
    ]);
  });

  it("stops looking at a time past what a date can hold", () => {
    const series: SeriesTimes = {
      repeat: "weekly",
      zone: "UTC",
      firstStartsAt: 8.64e15 - 60 * 60_000,
    };
    expect(startsBetween(series, 0, Infinity)).toEqual([]);
    expect(startsBetween(series, series.firstStartsAt - 1, 8.64e15)).toEqual([
      series.firstStartsAt,
    ]);
    // Two hours ahead of UTC, the wall-clock time is already past it.
    expect(
      startsBetween(
        { ...series, zone: "Europe/Copenhagen" },
        series.firstStartsAt - 1,
        8.64e15,
      ),
    ).toEqual([]);
  });

  it("keeps the seconds of the first start", () => {
    const series: SeriesTimes = {
      repeat: "weekly",
      zone: "Europe/Copenhagen",
      firstStartsAt: at("2026-10-18T01:00:30.250Z"),
    };
    expect(
      startsBetween(series, series.firstStartsAt - 1, at("2026-11-01T03:00Z")),
    ).toEqual([
      series.firstStartsAt,
      at("2026-10-25T02:00:30.250Z"),
      at("2026-11-01T02:00:30.250Z"),
    ]);
    // Just after a repeat's minute begins, that repeat is still ahead.
    expect(
      startsBetween(
        series,
        at("2026-10-25T02:00:00Z"),
        at("2026-10-25T03:00:00Z"),
      ),
    ).toEqual([at("2026-10-25T02:00:30.250Z")]);
  });

  it("lets a window last up to a week, or four weeks", () => {
    expect(longestWindow("weekly")).toBe(7 * DAY);
    expect(longestWindow("monthly")).toBe(28 * DAY);
    expect(longestWindow("monthly-weekday")).toBe(28 * DAY);
  });
});
