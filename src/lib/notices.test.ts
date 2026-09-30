import { describe, expect, it } from "vitest";
import { openDb } from "./db";
import { maintenanceView, type IncidentView } from "./incidents";
import { dueNotices, NOTICE_WINDOW_MS } from "./notices";

const NOW = Date.UTC(2026, 8, 30, 12, 0);
const MIN = 60_000;
const SITE = { name: "example.com", host: "status.example.com" };

function incident(updates: Array<[number, "investigating" | "resolved"]>) {
  return {
    id: "2026-09-30-api",
    kind: "incident",
    title: "API errors",
    status: "investigating",
    impact: "partial",
    startedAt: NOW - 10 * MIN,
    endsAt: null,
    resolvedAt: null,
    auto: false,
    states: {},
    postmortem: null,
    monitors: ["API"],
    updates: updates
      .map(([at, status]) => ({ status, body: `at ${at}`, createdAt: at }))
      .sort((a, b) => b.createdAt - a.createdAt),
  } satisfies IncidentView;
}

describe("dueNotices", () => {
  it("sends each update once, oldest first", () => {
    const db = openDb(":memory:");
    const view = incident([
      [NOW - 10 * MIN, "investigating"],
      [NOW - 2 * MIN, "resolved"],
    ]);
    const first = dueNotices(db, SITE, [view], NOW);
    expect(first.map((n) => n.status)).toEqual(["Investigating", "Resolved"]);
    expect(first[0]).toMatchObject({
      kind: "incident-update",
      site: "example.com",
      pageUrl: "https://status.example.com",
      title: "API errors",
      monitors: ["API"],
    });
    expect(dueNotices(db, SITE, [view], NOW + MIN)).toEqual([]);
  });

  it("files an update more than an hour old without a message", () => {
    const db = openDb(":memory:");
    const old = NOW - NOTICE_WINDOW_MS - MIN;
    const view = incident([
      [old, "investigating"],
      [NOW - MIN, "resolved"],
    ]);
    expect(dueNotices(db, SITE, [view], NOW).map((n) => n.status)).toEqual([
      "Resolved",
    ]);
  });

  it("waits for an update dated ahead", () => {
    const db = openDb(":memory:");
    const view = incident([[NOW + 5 * MIN, "investigating"]]);
    expect(dueNotices(db, SITE, [view], NOW)).toEqual([]);
    expect(dueNotices(db, SITE, [view], NOW + 6 * MIN)).toHaveLength(1);
  });

  it("says nothing about outages the checker opened", () => {
    const db = openDb(":memory:");
    const view = { ...incident([[NOW - MIN, "investigating"]]), auto: true };
    expect(dueNotices(db, SITE, [view], NOW)).toEqual([]);
  });

  it("announces a maintenance window, its start and its end", () => {
    const db = openDb(":memory:");
    const view = maintenanceView({
      title: "Database upgrade",
      start: NOW + 30 * MIN,
      end: NOW + 90 * MIN,
      notes: "Writes pause.",
    });
    const kinds = (now: number) =>
      dueNotices(db, SITE, [view], now).map((n) => n.kind);
    expect(kinds(NOW)).toEqual(["maintenance-scheduled"]);
    expect(kinds(NOW + MIN)).toEqual([]);
    expect(kinds(NOW + 31 * MIN)).toEqual(["maintenance-started"]);
    expect(kinds(NOW + 91 * MIN)).toEqual(["maintenance-ended"]);
    expect(kinds(NOW + 92 * MIN)).toEqual([]);
  });

  it("stays quiet about a window that was over long before it was seen", () => {
    const db = openDb(":memory:");
    const view = maintenanceView({
      title: "Old work",
      start: NOW - 300 * MIN,
      end: NOW - 200 * MIN,
    });
    expect(dueNotices(db, SITE, [view], NOW)).toEqual([]);
  });
});
