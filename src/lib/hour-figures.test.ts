import { describe, expect, it } from "vitest";
import { insertCheck, openDb } from "./db";
import { FINISH_AFTER_MS, finishHours } from "./hour-figures";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Date.UTC(2026, 8, 30, 0);
const MONITORS = [{ site: "s", monitor: "m" }];

function check(
  db: ReturnType<typeof openDb>,
  ts: number,
  latencyMs: number,
  ok: 0 | 1 = 1,
  monitor = "m",
) {
  insertCheck(db, {
    site: "s",
    monitor,
    ts,
    ok,
    statusCode: ok ? 200 : null,
    latencyMs,
    error: ok ? null : "timeout",
  });
}

function figures(db: ReturnType<typeof openDb>, monitor = "m") {
  return db
    .prepare(
      `SELECT ts, latency_p50 AS p50, latency_p95 AS p95 FROM check_hour
       WHERE monitor = ? ORDER BY ts`,
    )
    .all(monitor);
}

describe("finishHours", () => {
  it("gives an hour that is over the median and 95th percentile of its checks", () => {
    const db = openDb(":memory:");
    // Twenty checks an hour: one slow, and a failure that is not a reading.
    for (let i = 0; i < 20; i++)
      check(db, T + i * 3 * MINUTE, i === 7 ? 900 : 100 + i);
    check(db, T + 59 * MINUTE, 5, 0);
    check(db, T + HOUR + MINUTE, 50);
    const now = T + HOUR + FINISH_AFTER_MS;
    expect(finishHours(db, MONITORS, now)).toEqual({
      finished: 1,
      more: false,
    });
    expect(figures(db)).toEqual([
      { ts: T, p50: 110, p95: 119 },
      // This hour is not over yet.
      { ts: T + HOUR, p50: null, p95: null },
    ]);
    // Nothing is taken twice.
    expect(finishHours(db, MONITORS, now).finished).toBe(0);
  });

  it("waits a few minutes after an hour ends", () => {
    const db = openDb(":memory:");
    check(db, T + MINUTE, 100);
    expect(finishHours(db, MONITORS, T + HOUR + MINUTE).finished).toBe(0);
    expect(finishHours(db, MONITORS, T + HOUR + FINISH_AFTER_MS).finished).toBe(
      1,
    );
  });

  it("works through a backlog newest first, a batch at a time", () => {
    const db = openDb(":memory:");
    for (let h = 0; h < 10; h++) {
      check(db, T + h * HOUR + MINUTE, 100 + h);
      check(db, T + h * HOUR + MINUTE, 200 + h, 1, "other");
    }
    const monitors = [...MONITORS, { site: "s", monitor: "other" }];
    const now = T + 10 * HOUR + FINISH_AFTER_MS;
    expect(finishHours(db, monitors, now, { limit: 4 })).toEqual({
      finished: 4,
      more: true,
    });
    expect(
      figures(db)
        .filter((h) => (h as { p50: number | null }).p50 !== null)
        .map((h) => (h as { ts: number }).ts),
    ).toEqual([6, 7, 8, 9].map((h) => T + h * HOUR));
    expect(finishHours(db, monitors, now, { limit: 100 })).toEqual({
      finished: 16,
      more: false,
    });
    expect(figures(db, "other")[0]).toEqual({ ts: T, p50: 200, p95: 200 });
  });

  it("leaves the hours before `since`, and those at `before` or after", () => {
    const db = openDb(":memory:");
    for (let h = 0; h < 4; h++) check(db, T + h * HOUR + MINUTE, 100);
    const now = T + 4 * HOUR + FINISH_AFTER_MS;
    finishHours(db, MONITORS, now, { since: T + HOUR, before: T + 3 * HOUR });
    expect(figures(db).map((h) => (h as { p50: number | null }).p50)).toEqual([
      null,
      100,
      100,
      null,
    ]);
  });

  it("leaves an hour whose checks are gone to stand in with its mean", () => {
    const db = openDb(":memory:");
    check(db, T + MINUTE, 100);
    check(db, T + 2 * MINUTE, 300);
    check(db, T + HOUR + MINUTE, 50);
    db.prepare("DELETE FROM checks WHERE ts < ?").run(T + HOUR);
    finishHours(db, MONITORS, T + 2 * HOUR + FINISH_AFTER_MS);
    expect(figures(db)).toEqual([
      { ts: T, p50: null, p95: null },
      { ts: T + HOUR, p50: 50, p95: 50 },
    ]);
  });

  it("takes an hour again after a response time lands in it late", () => {
    const db = openDb(":memory:");
    check(db, T + MINUTE, 100);
    const now = T + HOUR + FINISH_AFTER_MS;
    finishHours(db, MONITORS, now);
    check(db, T + 2 * MINUTE, 500);
    check(db, T + 3 * MINUTE, 500);
    finishHours(db, MONITORS, now);
    expect(figures(db)).toEqual([{ ts: T, p50: 500, p95: 500 }]);
  });
});
