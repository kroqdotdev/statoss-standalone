import { describe, expect, it } from "vitest";
import {
  componentBuckets,
  pruneComponentStates,
  recordComponentStates,
} from "./component-history";
import { openDb } from "./db";
import type { IncidentView } from "./incidents";
import { RANGES } from "./ranges";

const DAY = 24 * 60 * 60 * 1000;
// Noon on 30 September 2026.
const NOW = Date.UTC(2026, 8, 30, 12);

const site = (state: "operational" | "degraded" | "partial" | "major") => [
  { name: "s", components: [{ name: "App", state }] },
];

const states = (buckets: ReturnType<typeof componentBuckets>) =>
  buckets.map((b) =>
    b.total === 0 ? "-" : b.up === 0 ? "out" : b.slow > 0 ? "slow" : "ok",
  );

describe("component history", () => {
  it("notes a configured state only when it changes", () => {
    const db = openDb(":memory:");
    recordComponentStates(db, site("operational"), NOW - 10 * DAY);
    recordComponentStates(db, site("operational"), NOW - 9 * DAY);
    recordComponentStates(db, site("degraded"), NOW - 3 * DAY);
    expect(
      db.prepare("SELECT state, at FROM component_state ORDER BY at").all(),
    ).toEqual([
      { state: "operational", at: NOW - 10 * DAY },
      { state: "degraded", at: NOW - 3 * DAY },
    ]);
  });

  it("draws the worst state of each bar, and nothing before it was known", () => {
    const db = openDb(":memory:");
    recordComponentStates(db, site("operational"), NOW - 5 * DAY);
    recordComponentStates(db, site("major"), NOW - 3 * DAY);
    recordComponentStates(db, site("operational"), NOW - 3 * DAY + 60_000);
    const last = states(
      componentBuckets(db, "s", "App", [], RANGES["90d"], NOW),
    ).slice(-7);
    expect(last).toEqual(["-", "ok", "ok", "out", "ok", "ok", "ok"]);
  });

  it("lays an incident's state over the span it was open", () => {
    const db = openDb(":memory:");
    recordComponentStates(db, site("operational"), NOW - 20 * DAY);
    const incident: IncidentView = {
      id: "i",
      kind: "incident",
      title: "Trouble",
      status: "resolved",
      impact: "degraded",
      startedAt: NOW - 2 * DAY,
      endsAt: null,
      resolvedAt: NOW - DAY,
      auto: false,
      postmortem: null,
      monitors: ["App", "Other"],
      states: { App: "degraded", Other: "major" },
      updates: [],
    };
    const last = states(
      componentBuckets(db, "s", "App", [incident], RANGES["90d"], NOW),
    ).slice(-4);
    expect(last).toEqual(["ok", "slow", "slow", "ok"]);
  });

  it("forgets old states but keeps the one the range begins in", () => {
    const db = openDb(":memory:");
    recordComponentStates(db, site("operational"), 1000);
    recordComponentStates(db, site("degraded"), 2000);
    recordComponentStates(db, site("operational"), 9000);
    expect(pruneComponentStates(db, 5000)).toBe(1);
    expect(
      db.prepare("SELECT at FROM component_state ORDER BY at").all(),
    ).toEqual([{ at: 2000 }, { at: 9000 }]);
  });
});
