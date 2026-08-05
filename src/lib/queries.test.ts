import { describe, expect, it } from "vitest";
import { insertCheck, openDb } from "./db";
import { dailyUptime, latencySeries } from "./queries";

const DAY = 24 * 60 * 60 * 1000;
// 2024-01-10T12:00:00Z — fixed "now" so dates are deterministic
const NOW = Date.UTC(2024, 0, 10, 12, 0, 0);

function seed(
  db: ReturnType<typeof openDb>,
  ts: number,
  ok: 0 | 1,
  latencyMs: number | null,
) {
  insertCheck(db, {
    site: "s",
    checkpoint: "c",
    ts,
    ok,
    statusCode: ok ? 200 : 500,
    latencyMs,
    error: ok ? null : "unexpected status 500",
  });
}

describe("dailyUptime", () => {
  it("returns one entry per day, oldest first, ending today", () => {
    const days = dailyUptime(openDb(":memory:"), "s", "c", 90, NOW);
    expect(days).toHaveLength(90);
    expect(days[89].date).toBe("2024-01-10");
    expect(days[0].date).toBe("2023-10-13");
    expect(days.every((d) => d.uptimePct === null)).toBe(true);
  });

  it("computes per-day percentages and leaves gap days null", () => {
    const db = openDb(":memory:");
    // 2024-01-09 (yesterday): 3 ok, 1 fail => 75%
    const yesterdayNoon = Date.UTC(2024, 0, 9, 12, 0, 0);
    seed(db, yesterdayNoon, 1, 100);
    seed(db, yesterdayNoon + 60_000, 1, 100);
    seed(db, yesterdayNoon + 120_000, 1, 100);
    seed(db, yesterdayNoon + 180_000, 0, null);
    // 2024-01-10 (today): 1 ok => 100%
    seed(db, NOW - 60_000, 1, 100);

    const days = dailyUptime(db, "s", "c", 3, NOW);
    expect(days.map((d) => d.date)).toEqual([
      "2024-01-08",
      "2024-01-09",
      "2024-01-10",
    ]);
    expect(days[0].uptimePct).toBeNull();
    expect(days[1]).toMatchObject({ total: 4, up: 3, uptimePct: 75 });
    expect(days[2]).toMatchObject({ total: 1, up: 1, uptimePct: 100 });
  });

  it("scopes to the requested checkpoint", () => {
    const db = openDb(":memory:");
    seed(db, NOW - 60_000, 0, null);
    insertCheck(db, {
      site: "s",
      checkpoint: "other",
      ts: NOW - 60_000,
      ok: 1,
      statusCode: 200,
      latencyMs: 5,
      error: null,
    });
    const days = dailyUptime(db, "s", "other", 1, NOW);
    expect(days[0]).toMatchObject({ total: 1, up: 1, uptimePct: 100 });
  });
});

describe("latencySeries", () => {
  it("averages successful checks into 5-minute buckets, ordered by time", () => {
    const db = openDb(":memory:");
    const bucket = Math.floor((NOW - 60 * 60_000) / 300_000) * 300_000;
    seed(db, bucket + 1000, 1, 100);
    seed(db, bucket + 2000, 1, 300);
    seed(db, bucket + 3000, 0, 10_000); // failed: excluded
    seed(db, bucket + 300_000 + 1000, 1, 50);

    const points = latencySeries(db, "s", "c", NOW - DAY, NOW);
    expect(points).toEqual([
      { ts: bucket, latencyMs: 200 },
      { ts: bucket + 300_000, latencyMs: 50 },
    ]);
  });

  it("excludes points outside the window", () => {
    const db = openDb(":memory:");
    seed(db, NOW - 2 * DAY, 1, 100);
    expect(latencySeries(db, "s", "c", NOW - DAY, NOW)).toEqual([]);
  });
});
