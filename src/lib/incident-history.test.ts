import { describe, expect, it } from "vitest";
import { historyMonths, historyPage, monthKey } from "./incident-history";
import type { IncidentView } from "./incidents";

const NOW = Date.UTC(2026, 8, 30, 12);

const at = (id: string, startedAt: number): IncidentView => ({
  id,
  kind: "incident",
  title: id,
  status: "resolved",
  impact: "none",
  startedAt,
  endsAt: null,
  resolvedAt: startedAt + 1,
  auto: false,
  postmortem: null,
  monitors: [],
  states: {},
  updates: [],
});

describe("historyMonths", () => {
  it("reaches back three months when nothing is older, quiet months included", () => {
    const months = historyMonths([at("a", Date.UTC(2026, 8, 12))], NOW, "UTC");
    expect(months.map((m) => [m.label, m.incidents.length])).toEqual([
      ["September 2026", 1],
      ["August 2026", 0],
      ["July 2026", 0],
    ]);
  });

  it("reaches back to the oldest incident, newest first in each month", () => {
    const months = historyMonths(
      [
        at("old", Date.UTC(2025, 11, 31, 23)),
        at("early", Date.UTC(2026, 8, 2)),
        at("late", Date.UTC(2026, 8, 20)),
        at("ahead", NOW + 1),
      ],
      NOW,
      "UTC",
    );
    expect(months).toHaveLength(10);
    expect(months[0].incidents.map((v) => v.id)).toEqual(["late", "early"]);
    expect(months[9]).toMatchObject({ key: "2025-12", label: "December 2025" });
  });

  it("files an incident under the month it started in where the page is", () => {
    expect(monthKey(Date.UTC(2026, 8, 30, 23), "UTC")).toBe("2026-09");
    expect(monthKey(Date.UTC(2026, 8, 30, 23), "Europe/Copenhagen")).toBe(
      "2026-10",
    );
  });
});

describe("historyPage", () => {
  const months = historyMonths([at("old", Date.UTC(2026, 0, 5))], NOW, "UTC");

  it("shows three months a page and says which way there is more", () => {
    expect(historyPage(months, 0)).toMatchObject({
      page: 0,
      later: false,
      earlier: true,
    });
    expect(historyPage(months, 2).months.map((m) => m.key)).toEqual([
      "2026-03",
      "2026-02",
      "2026-01",
    ]);
    expect(historyPage(months, 2).earlier).toBe(false);
  });

  it("clamps a page that does not exist", () => {
    expect(historyPage(months, 99).page).toBe(2);
    expect(historyPage(months, NaN).page).toBe(0);
    expect(historyPage(months, -3).page).toBe(0);
  });
});
