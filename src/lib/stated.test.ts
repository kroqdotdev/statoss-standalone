import { describe, expect, it } from "vitest";
import type { IncidentView } from "./incidents";
import {
  componentState,
  componentStatus,
  shownState,
  statedByName,
  statusWithStated,
} from "./stated";

const NOW = Date.UTC(2026, 8, 30, 12);
const HOUR = 60 * 60_000;

const incident = (over: Partial<IncidentView>): IncidentView => ({
  id: "i",
  kind: "incident",
  title: "Trouble",
  status: "investigating",
  impact: "partial",
  startedAt: NOW - HOUR,
  endsAt: null,
  resolvedAt: null,
  auto: false,
  postmortem: null,
  monitors: [],
  states: {},
  updates: [],
  ...over,
});

describe("statedByName", () => {
  it("takes the worst state open incidents give a row", () => {
    const stated = statedByName(
      [
        incident({ id: "a", monitors: ["API"], states: { API: "degraded" } }),
        incident({ id: "b", monitors: ["API"], states: { API: "major" } }),
        incident({
          id: "c",
          monitors: ["API"],
          states: { API: "major" },
          resolvedAt: NOW,
        }),
      ],
      ["API", "Web"],
      NOW,
    );
    expect(stated.get("API")).toMatchObject({
      impact: "major",
      incident: { id: "b" },
    });
    expect(stated.get("Web")).toBeUndefined();
  });

  it("marks a row an incident names without a state, when the incident has an impact", () => {
    const stated = statedByName(
      [
        incident({ id: "a", monitors: ["API"] }),
        incident({ id: "quiet", impact: "none", monitors: ["Web"] }),
      ],
      ["API", "Web"],
      NOW,
    );
    expect(stated.get("API")).toMatchObject({
      impact: null,
      incident: { id: "a" },
    });
    expect(stated.get("Web")?.incident).toBeNull();
  });

  it("covers the named rows, or all of them, while a window is in progress", () => {
    const window = incident({
      kind: "maintenance",
      impact: "none",
      startedAt: NOW - HOUR,
      endsAt: NOW + HOUR,
    });
    const all = statedByName([window], ["API", "Web"], NOW);
    expect(all.get("Web")?.maintenanceUntil).toBe(NOW + HOUR);
    const one = statedByName(
      [{ ...window, monitors: ["API"] }],
      ["API", "Web"],
      NOW,
    );
    expect(one.get("Web")).toBeUndefined();
    const ahead = statedByName(
      [{ ...window, startedAt: NOW + 1 }],
      ["API"],
      NOW,
    );
    expect(ahead.size).toBe(0);
  });
});

describe("what a row shows", () => {
  const stated = (impact: "degraded" | "partial" | "major") => ({
    impact,
    since: NOW,
    incident: { id: "i", title: "t" },
    maintenanceUntil: null,
  });

  it("is the incident's state when that is worse than the checks", () => {
    expect(shownState("up", stated("degraded"))).toBe("stated");
    expect(shownState("slow", stated("degraded"))).toBe("checks");
    expect(shownState("down", stated("major"))).toBe("checks");
    expect(statusWithStated("up", stated("degraded"))).toBe("slow");
    expect(statusWithStated("up", stated("partial"))).toBe("down");
    expect(statusWithStated("down", stated("degraded"))).toBe("down");
  });

  it("is maintenance while a window covers it and nothing worse is said", () => {
    const window = {
      impact: null,
      since: null,
      incident: null,
      maintenanceUntil: NOW + HOUR,
    };
    expect(shownState("down", window)).toBe("maintenance");
    expect(shownState("up", undefined)).toBe("checks");
  });
});

describe("components", () => {
  it("are in the worse of the file's state and an open incident's", () => {
    const major = {
      impact: "major" as const,
      since: NOW,
      incident: null,
      maintenanceUntil: null,
    };
    expect(componentState("operational", undefined)).toBe("operational");
    expect(componentState("degraded", major)).toBe("major");
    expect(componentState("major", { ...major, impact: "degraded" })).toBe(
      "major",
    );
    expect(
      ["operational", "degraded", "partial", "major"].map((s) =>
        componentStatus(s as "major"),
      ),
    ).toEqual(["up", "slow", "down", "down"]);
  });
});
