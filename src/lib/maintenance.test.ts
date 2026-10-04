import { describe, expect, it } from "vitest";
import { parseConfig, type SiteConfig } from "./config";
import { openDb } from "./db";
import { maintenanceId } from "./incidents";
import {
  inMaintenance,
  maintenanceWindows,
  PLAN_AHEAD_MS,
  REPEATS_BACK_MS,
  siteMaintenanceViews,
} from "./maintenance";
import { dueNotices } from "./notices";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// Sunday 4 October 2026, 02:00 in Copenhagen.
const FIRST = Date.parse("2026-10-04T00:00:00Z");

function site(window: string, timezone = "Europe/Copenhagen"): SiteConfig {
  return parseConfig(`
sites:
  - name: Example
    host: status.example.com
    timezone: ${timezone}
    monitors:
      - name: API
        url: https://api.example.com
      - name: Web
        url: https://example.com
    maintenance:
${window}`).sites[0];
}

const WEEKLY = site(`      - title: Database upgrade
        start: 2026-10-04T00:00:00Z
        end: 2026-10-04T02:00:00Z
        monitors: [API]
        notes: The API may be slow.
        repeat: weekly
`);

const ids = (s: SiteConfig, now: number, from = 0) =>
  siteMaintenanceViews(s, now, from).map((v) => v.id);

describe("maintenance that repeats", () => {
  it("plans each repeat a week before it starts, with an id of its own", () => {
    expect(ids(WEEKLY, FIRST - 2 * DAY)).toEqual([
      "maintenance-2026-10-04-0000-database-upgrade",
    ]);
    expect(ids(WEEKLY, FIRST + WEEK - PLAN_AHEAD_MS - MIN)).toHaveLength(1);
    expect(ids(WEEKLY, FIRST + WEEK - PLAN_AHEAD_MS)).toEqual([
      "maintenance-2026-10-04-0000-database-upgrade",
      "maintenance-2026-10-11-0000-database-upgrade",
    ]);
    // Winter time from 25 October: 02:00 in Copenhagen is 01:00 UTC, and
    // the id says so.
    expect(ids(WEEKLY, FIRST + 3 * WEEK + HOUR).slice(-2)).toEqual([
      "maintenance-2026-10-25-0100-database-upgrade",
      "maintenance-2026-11-01-0100-database-upgrade",
    ]);
    const [, second] = siteMaintenanceViews(WEEKLY, FIRST + WEEK);
    expect(second).toMatchObject({
      kind: "maintenance",
      title: "Database upgrade",
      startedAt: FIRST + WEEK,
      endsAt: FIRST + WEEK + 2 * HOUR,
      monitors: ["API"],
      updates: [{ body: "The API may be slow." }],
    });
  });

  it("gives the same ids however often it is asked, and from any moment", () => {
    const early = ids(WEEKLY, FIRST + 10 * WEEK);
    const late = ids(WEEKLY, FIRST + 20 * WEEK);
    expect(new Set(early).size).toBe(early.length);
    expect(late.slice(0, early.length)).toEqual(early);
    expect(ids(WEEKLY, FIRST + 20 * WEEK, FIRST + 15 * WEEK)).toEqual(
      late.filter((id) => id >= "maintenance-2027-01-17"),
    );
  });

  it("keeps a written window however far ahead, and repeats for 400 days", () => {
    const far = site(`      - title: Move
        start: 2027-06-01T00:00:00Z
        end: 2027-06-01T01:00:00Z
`);
    expect(ids(far, FIRST)).toEqual(["maintenance-2027-06-01-0000-move"]);
    const now = FIRST + 100 * WEEK;
    const windows = maintenanceWindows(
      WEEKLY.maintenance,
      WEEKLY.timezone,
      now,
    );
    // The written one stays; the repeats go back 400 days.
    expect(windows[0]).toMatchObject({ start: FIRST, written: true });
    expect(windows[1].start).toBeGreaterThan(now - REPEATS_BACK_MS - WEEK);
    expect(windows[1].written).toBe(false);
    expect(windows.at(-1)!.start).toBeLessThanOrEqual(now + PLAN_AHEAD_MS);
    expect(windows).toHaveLength(1 + 59);
  });

  it("stops after the day in until, which is a day in the site's zone", () => {
    // Sunday 22:00 in New York, which is Monday in UTC.
    const evening = site(
      `      - title: Patching
        start: 2026-10-26T02:00:00Z
        end: 2026-10-26T03:00:00Z
        repeat: weekly
        until: 2026-11-08
`,
      "America/New_York",
    );
    expect(
      maintenanceWindows(
        evening.maintenance,
        evening.timezone,
        Date.parse("2026-12-01T00:00:00Z"),
      ).map((w) => new Date(w.start).toISOString()),
    ).toEqual([
      "2026-10-26T02:00:00.000Z",
      "2026-11-02T03:00:00.000Z",
      "2026-11-09T03:00:00.000Z",
    ]);
  });

  it("counts a written window and a repeat with one title in one minute once", () => {
    const both = site(`      - title: Database upgrade
        start: 2026-10-11T00:00:00Z
        end: 2026-10-11T05:00:00Z
        notes: Longer this time.
      - title: Database upgrade
        start: 2026-10-04T00:00:00Z
        end: 2026-10-04T02:00:00Z
        repeat: weekly
`);
    const views = siteMaintenanceViews(both, FIRST + 2 * WEEK);
    expect(views.map((v) => [v.id, v.endsAt])).toEqual([
      ["maintenance-2026-10-04-0000-database-upgrade", FIRST + 2 * HOUR],
      ["maintenance-2026-10-11-0000-database-upgrade", FIRST + WEEK + 5 * HOUR],
      [
        "maintenance-2026-10-18-0000-database-upgrade",
        FIRST + 2 * WEEK + 2 * HOUR,
      ],
    ]);
  });

  it("covers its monitors during each repeat, and only then", () => {
    const list = WEEKLY.maintenance;
    const zone = WEEKLY.timezone;
    expect(inMaintenance(list, "API", FIRST, zone)).toBe(true);
    expect(inMaintenance(list, "API", FIRST + WEEK + HOUR, zone)).toBe(true);
    expect(inMaintenance(list, "API", FIRST + WEEK + 2 * HOUR, zone)).toBe(
      false,
    );
    expect(inMaintenance(list, "API", FIRST + WEEK - 1, zone)).toBe(false);
    expect(inMaintenance(list, "Web", FIRST + WEEK + HOUR, zone)).toBe(false);
    // After daylight saving ends, at its new UTC time.
    const winter = Date.parse("2026-10-25T01:30:00Z");
    expect(inMaintenance(list, "API", winter, zone)).toBe(true);
    expect(inMaintenance(list, "API", winter - HOUR, zone)).toBe(false);
  });

  it("covers a written window that does not repeat as before", () => {
    const T = Date.UTC(2026, 8, 12, 14, 5);
    const window = { title: "Upgrade", start: T, end: T + 2 * HOUR };
    expect(inMaintenance([window], "API", T)).toBe(true);
    expect(inMaintenance([window], "API", T + 2 * HOUR)).toBe(false);
    expect(inMaintenance([window], "API", T - 1)).toBe(false);
    expect(inMaintenance([{ ...window, monitors: ["Web"] }], "API", T)).toBe(
      false,
    );
  });
});

describe("notices for maintenance that repeats", () => {
  const UTC_WEEKLY = site(
    `      - title: Backups
        start: 2026-10-04T00:00:00Z
        end: 2026-10-04T02:00:00Z
        repeat: weekly
`,
    "UTC",
  );
  const sent = (db: ReturnType<typeof openDb>, now: number) =>
    dueNotices(
      db,
      UTC_WEEKLY,
      siteMaintenanceViews(UTC_WEEKLY, now, now - DAY),
      now,
    ).map((n) => `${n.kind} ${n.id}`);
  const id = (start: number) => maintenanceId({ title: "Backups", start });

  it("announces each repeat once, a week ahead, then its start and its end", () => {
    const db = openDb(":memory:");
    expect(sent(db, FIRST - 2 * DAY)).toEqual([
      `maintenance-scheduled ${id(FIRST)}`,
    ]);
    expect(sent(db, FIRST - 2 * DAY + MIN)).toEqual([]);
    expect(sent(db, FIRST)).toEqual([
      `maintenance-started ${id(FIRST)}`,
      `maintenance-scheduled ${id(FIRST + WEEK)}`,
    ]);
    expect(sent(db, FIRST + MIN)).toEqual([]);
    expect(sent(db, FIRST + 2 * HOUR)).toEqual([
      `maintenance-ended ${id(FIRST)}`,
    ]);
    expect(sent(db, FIRST + WEEK)).toEqual([
      `maintenance-started ${id(FIRST + WEEK)}`,
      `maintenance-scheduled ${id(FIRST + 2 * WEEK)}`,
    ]);
    expect(sent(db, FIRST + WEEK + 2 * HOUR)).toEqual([
      `maintenance-ended ${id(FIRST + WEEK)}`,
    ]);
    // Asked again at any of those moments, it has nothing more to say.
    for (const now of [FIRST, FIRST + 2 * HOUR, FIRST + WEEK + 2 * HOUR])
      expect(sent(db, now)).toEqual([]);
  });

  it("tells nothing of a repeat that was over or long under way before it was seen", () => {
    const db = openDb(":memory:");
    // Off for three weeks: the one under way started 90 minutes ago.
    expect(sent(db, FIRST + 3 * WEEK + 90 * MIN)).toEqual([
      `maintenance-scheduled ${id(FIRST + 4 * WEEK)}`,
    ]);
  });
});
