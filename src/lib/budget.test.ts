import { describe, expect, it } from "vitest";
import {
  combine,
  describeBudget,
  errorBudget,
  formatMinutes,
  formatUptime,
  monthTotals,
  monthWindow,
} from "./budget";
import { insertCheck, openDb } from "./db";
import type { WindowSummary } from "./queries";

// 16 September 2026, 00:00 UTC: half of a 30-day month gone.
const NOW = Date.UTC(2026, 8, 16);

const totals = (over: Partial<WindowSummary>): WindowSummary => ({
  total: 0,
  up: 0,
  timeouts: 0,
  slow: 0,
  maintenance: 0,
  latencyMs: null,
  ...over,
});

describe("errorBudget", () => {
  it("takes the month's allowance from the target", () => {
    const b = errorBudget(totals({ total: 1000, up: 1000 }), 99.9, NOW);
    expect(monthWindow(NOW)).toEqual({
      start: Date.UTC(2026, 8, 1),
      end: Date.UTC(2026, 9, 1),
    });
    expect(b.monthMinutes).toBe(43_200);
    expect(b.budgetMinutes).toBe(43);
    expect(b.downMinutes).toBe(0);
    expect(describeBudget(b, NOW)).toBe(
      "September so far: 100% up against a 99.9% target. None of the 43 min downtime budget spent.",
    );
  });

  it("applies the share of failed checks to the time the checks covered", () => {
    // 1 in 100 failed over 50 hours of checks: half an hour down.
    const b = errorBudget(
      totals({ total: 3000, up: 2970, slow: 60, hours: 50 }),
      99.9,
      NOW,
    );
    expect(b.downMinutes).toBe(30);
    expect(b.slowMinutes).toBe(60);
    expect(b.remainingMinutes).toBe(13);
    expect(describeBudget(b, NOW)).toBe(
      "September so far: 99.00% up against a 99.9% target. 30 min of the 43 min downtime budget spent. 1 h slow in total.",
    );
  });

  it("says by how much the budget is overspent", () => {
    const b = errorBudget(totals({ total: 100, up: 50, hours: 4 }), 99.9, NOW);
    expect(describeBudget(b, NOW)).toContain(
      "2 h down, 1 h 17 min over the 43 min budget",
    );
  });

  it("has a sentence for a month with no checks yet", () => {
    expect(describeBudget(errorBudget(totals({}), 99.5, NOW), NOW)).toBe(
      "September: no checks yet against a 99.5% target.",
    );
  });
});

describe("formatting", () => {
  it("never rounds a failure up to 100%", () => {
    expect(formatUptime(99.999)).toBe("99.99%");
    expect(formatUptime(100)).toBe("100%");
    expect(formatMinutes(0.4)).toBe("under a minute");
    expect(formatMinutes(72)).toBe("1 h 12 min");
  });
});

describe("monthTotals", () => {
  it("adds a site's monitors up for the month, weighing the mean by its readings", () => {
    const db = openDb(":memory:");
    const row = { site: "s", statusCode: 200, error: null } as const;
    insertCheck(db, {
      ...row,
      monitor: "a",
      ts: NOW - 1000,
      ok: 1,
      latencyMs: 100,
    });
    insertCheck(db, {
      ...row,
      monitor: "a",
      ts: NOW - 2000,
      ok: 1,
      latencyMs: 100,
    });
    insertCheck(db, {
      ...row,
      monitor: "b",
      ts: NOW - 3000,
      ok: 1,
      latencyMs: 400,
    });
    insertCheck(db, {
      ...row,
      monitor: "b",
      ts: NOW - 4000,
      ok: 0,
      latencyMs: 1,
    });
    // Last month: not counted.
    insertCheck(db, {
      ...row,
      monitor: "a",
      ts: Date.UTC(2026, 7, 31, 12),
      ok: 0,
      latencyMs: 1,
    });
    expect(monthTotals(db, "s", ["a", "b"], NOW)).toMatchObject({
      total: 4,
      up: 3,
      latencyMs: 200,
      hours: 1,
    });
    expect(combine([])).toMatchObject({ total: 0, latencyMs: null });
  });
});
