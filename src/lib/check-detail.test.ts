import { describe, expect, it } from "vitest";
import { checkDetail, DETAIL_ROWS } from "./check-detail";
import { insertCheck, openDb } from "./db";

const HOUR = 60 * 60 * 1000;
const T = Date.UTC(2026, 8, 30, 12);

function seed(
  db: ReturnType<typeof openDb>,
  ts: number,
  ok: 0 | 1,
  latencyMs: number,
  error: string | null = null,
  maintenance: 0 | 1 = 0,
) {
  insertCheck(db, {
    site: "s",
    monitor: "m",
    ts,
    ok,
    statusCode: ok ? 200 : null,
    latencyMs,
    error,
    maintenance,
  });
}

describe("checkDetail", () => {
  it("lists every check in a bar, newest first, in the page's words", () => {
    const db = openDb(":memory:");
    seed(db, T + 1000, 1, 100);
    seed(db, T + 2000, 1, 900);
    seed(db, T + 3000, 0, 10_000, "timeout");
    seed(db, T + 4000, 0, 12, "fetch failed (ECONNREFUSED 10.0.0.7:443)");
    seed(db, T + 5000, 1, 50, null, 1);
    seed(db, T + HOUR, 1, 1);
    const detail = checkDetail(db, "s", "m", 500, T, T + HOUR);
    expect(detail).toMatchObject({
      total: 4,
      passed: 2,
      timeouts: 1,
      slow: 1,
      maintenance: 1,
      latency: { mean: 500, min: 100, max: 900 },
      listed: "all",
    });
    expect(detail.checks.map((c) => [c.ok, c.slow, c.problem])).toEqual([
      [true, false, null],
      [false, false, "Connection refused"],
      [false, false, "Timed out"],
      [true, true, null],
      [true, false, null],
    ]);
    expect(detail.checks[0].maintenance).toBe(true);
    // The stored error, which names an address, never leaves.
    expect(JSON.stringify(detail)).not.toContain("10.0.0.7");
  });

  it("lists only the trouble when there are too many", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < DETAIL_ROWS + 50; i++) seed(db, T + i * 1000, 1, 40);
    seed(db, T + 900_000, 0, 5, "unexpected status 503");
    const detail = checkDetail(db, "s", "m", null, T, T + HOUR);
    expect(detail.listed).toBe("trouble");
    expect(detail.total).toBe(DETAIL_ROWS + 51);
    expect(detail.checks.map((c) => c.problem)).toEqual(["HTTP 503"]);
  });

  it("falls back to the hours' totals once the checks are gone", () => {
    const db = openDb(":memory:");
    seed(db, T + 1000, 1, 100);
    seed(db, T + 2000, 0, 5, "timeout");
    db.exec("DELETE FROM checks");
    const detail = checkDetail(db, "s", "m", null, T, T + HOUR);
    expect(detail).toMatchObject({
      total: 2,
      passed: 1,
      timeouts: 1,
      listed: "none",
      checks: [],
    });
  });

  it("says so when only some of them are left", () => {
    const db = openDb(":memory:");
    seed(db, T + 1000, 1, 100);
    seed(db, T + 2000, 1, 300);
    db.prepare("DELETE FROM checks WHERE ts = ?").run(T + 1000);
    const detail = checkDetail(db, "s", "m", null, T, T + HOUR);
    expect(detail.listed).toBe("partial");
    expect(detail.total).toBe(2);
    expect(detail.checks).toHaveLength(1);
  });
});
