import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "./cache";
import { parseConfig } from "./config";
import { insertCheck, openDb, setState } from "./db";
import type { IncidentView, SiteIncidents } from "./incidents";
import {
  badgeJson,
  badgeSvg,
  feedAtom,
  feedEntry,
  feedXml,
  incidentUrl,
  maintenanceIcs,
  statusJson,
  widgetJs,
} from "./public-feeds";

const CONFIG = parseConfig(`
sites:
  - name: webhooks.cc
    host: status.webhooks.cc
    monitors:
      - name: Main site
        group: Web
        url: https://webhooks.cc
      - name: API
        url: https://api.webhooks.cc
`);
const SITE = CONFIG.sites[0];
const NOW = Date.UTC(2026, 8, 12, 15);
const NONE: SiteIncidents = { current: [], past: [] };

describe("statusJson", () => {
  // The day's response times are kept between calls, by site and monitor.
  beforeEach(() => clearCache());

  it("reports each monitor's state and the last day's figures", () => {
    const db = openDb(":memory:");
    setState(db, {
      site: SITE.name,
      monitor: "Main site",
      status: "up",
      consecutiveFails: 0,
      consecutiveSlow: 0,
      since: NOW - 60_000,
      lastAlertAt: null,
    });
    for (const [ts, ok, latencyMs] of [
      [NOW - 3000, 1, 100],
      [NOW - 2000, 1, 300],
      [NOW - 1000, 0, null],
    ] as const) {
      insertCheck(db, {
        site: SITE.name,
        monitor: "Main site",
        ts,
        ok,
        statusCode: ok ? 200 : 500,
        latencyMs,
        error: ok ? null : "unexpected status 500",
      });
    }
    const json = statusJson(db, SITE, NONE, NOW);
    // The old name stays for scripts written against 0.1.
    expect(json.checkpoints).toEqual(json.monitors);
    expect(json.site).toEqual({
      name: "webhooks.cc",
      url: "https://status.webhooks.cc",
      status: "operational",
      updatedAt: "2026-09-12T15:00:00.000Z",
    });
    expect(json.monitors).toEqual([
      {
        name: "Main site",
        type: "http",
        group: "Web",
        status: "up",
        since: new Date(NOW - 60_000).toISOString(),
        lastCheckedAt: null,
        stale: false,
        expiresAt: null,
        uptime24h: 66.67,
        // The median, by nearest rank: the lower of the two.
        latencyMs24h: 100,
      },
      {
        name: "API",
        type: "http",
        group: null,
        status: "unknown",
        since: null,
        lastCheckedAt: null,
        stale: false,
        expiresAt: null,
        uptime24h: null,
        latencyMs24h: null,
      },
    ]);
    expect(json.incidents).toEqual([]);
    expect(json.maintenance).toEqual([]);
  });

  it("gives the day's median response time, which one slow check does not move", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 60; i++)
      insertCheck(db, {
        site: SITE.name,
        monitor: "API",
        ts: NOW - (i + 1) * 60_000,
        ok: 1,
        statusCode: 200,
        latencyMs: i === 30 ? 9000 : 120 + (i % 3),
        error: null,
      });
    const api = statusJson(db, SITE, NONE, NOW).monitors[1];
    expect(api.name).toBe("API");
    expect(api.latencyMs24h).toBe(121);
  });

  it("lets an open incident set the headline", () => {
    const db = openDb(":memory:");
    const incidents: SiteIncidents = {
      current: [
        {
          id: "x",
          kind: "incident",
          title: "Login broken",
          status: "identified",
          impact: "major",
          startedAt: NOW - 60_000,
          endsAt: null,
          resolvedAt: null,
          auto: false,
          states: {},
          postmortem: null,
          monitors: [],
          updates: [],
        },
      ],
      past: [],
    };
    const json = statusJson(db, SITE, incidents, NOW);
    expect(json.site.status).toBe("major");
    expect(json.incidents).toHaveLength(1);
  });
});

describe("badges", () => {
  it("draws a badge with the label and state", () => {
    const svg = badgeSvg("partial", "api");
    expect(svg).toContain("<svg");
    expect(svg).toContain(">api<");
    expect(svg).toContain(">partly down<");
    expect(svg).toContain("#b8740f");
    expect(badgeSvg("operational", "a<b")).toContain("a&lt;b");
  });

  it("answers in the shields.io endpoint format", () => {
    expect(badgeJson("major")).toEqual({
      schemaVersion: 1,
      label: "status",
      message: "down",
      color: "red",
    });
  });
});

describe("feedXml", () => {
  it("lists incidents newest first with their updates", () => {
    const incidents: SiteIncidents = {
      current: [],
      past: [
        {
          id: "old",
          kind: "incident",
          title: "Old & resolved",
          status: "resolved",
          impact: "none",
          startedAt: NOW - 3 * 60 * 60_000,
          endsAt: null,
          resolvedAt: NOW - 2 * 60 * 60_000,
          auto: false,
          states: {},
          postmortem: null,
          monitors: [],
          updates: [
            {
              status: "resolved",
              body: "Fixed.",
              createdAt: NOW - 2 * 60 * 60_000,
            },
            {
              status: "investigating",
              body: "Looking.",
              createdAt: NOW - 3 * 60 * 60_000,
            },
          ],
        },
        {
          id: "maintenance-0",
          kind: "maintenance",
          title: "Upgrade",
          status: "monitoring",
          impact: "none",
          startedAt: NOW - 60 * 60_000,
          endsAt: NOW - 30 * 60_000,
          resolvedAt: null,
          auto: false,
          states: {},
          postmortem: null,
          monitors: [],
          updates: [],
        },
      ],
    };
    const xml = feedXml(SITE, incidents, NOW);
    expect(xml).toContain("<title>webhooks.cc status</title>");
    expect(xml.indexOf("Maintenance: Upgrade")).toBeLessThan(
      xml.indexOf("Old &amp; resolved"),
    );
    expect(xml).toContain(
      "2026-09-12 12:00 UTC, Investigating: Looking.\n\n2026-09-12 13:00 UTC, Resolved: Fixed.",
    );
    expect(xml).toContain(
      "Was planned 2026-09-12 14:00 UTC to 2026-09-12 14:30 UTC.",
    );
    expect(xml).toContain(
      '<guid isPermaLink="false">urn:statoss:incident:old</guid>',
    );
    expect(xml).toContain(
      "<link>https://status.webhooks.cc/incidents/old</link>",
    );

    const atom = feedAtom(SITE, incidents, NOW);
    expect(atom).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(atom).toContain(
      '<link rel="self" href="https://status.webhooks.cc/feed.atom"/>',
    );
    expect(atom).toContain("<id>urn:statoss:incident:old</id>");
    expect(atom).toContain(
      `<updated>${new Date(NOW - 2 * 60 * 60_000).toISOString()}</updated>`,
    );
  });

  it("dates a window still ahead by now, and carries the post-mortem", () => {
    const ahead: IncidentView = {
      id: "m",
      kind: "maintenance",
      title: "Upgrade",
      status: "monitoring",
      impact: "none",
      startedAt: NOW + 60 * 60_000,
      endsAt: NOW + 2 * 60 * 60_000,
      resolvedAt: null,
      auto: false,
      states: {},
      postmortem: null,
      monitors: ["API"],
      updates: [{ status: "monitoring", body: "Short pause.", createdAt: NOW }],
    };
    expect(feedEntry(ahead, NOW)).toEqual({
      title: "Maintenance: Upgrade",
      stamp: NOW,
      published: NOW,
      body: "Planned 2026-09-12 16:00 UTC to 2026-09-12 17:00 UTC.\n\nAffects API.\n\nShort pause.",
    });
    expect(
      feedEntry(
        {
          ...ahead,
          kind: "incident",
          startedAt: NOW,
          postmortem: "A disk filled.",
        },
        NOW,
      ).body,
    ).toContain("Post-mortem: A disk filled.");
  });
});

describe("statusJson with components, stated rows and stale checks", () => {
  const config = parseConfig(`
sites:
  - name: shop
    host: status.shop.example
    monitors:
      - name: Web
        url: https://shop.example
      - name: API
        url: https://api.shop.example
    components:
      - name: Mobile app
      - name: Payments
        state: degraded
`);
  const site = config.sites[0];
  const open: IncidentView = {
    id: "2026-09-12-api",
    kind: "incident",
    title: "API errors",
    status: "identified",
    impact: "none",
    startedAt: NOW - 60_000,
    endsAt: null,
    resolvedAt: null,
    auto: false,
    states: { API: "major", "Mobile app": "partial" },
    postmortem: null,
    monitors: ["API", "Mobile app"],
    updates: [],
  };

  it("gives a row the worse of its checks and what the incident says", () => {
    const db = openDb(":memory:");
    for (const monitor of ["Web", "API"])
      setState(db, {
        site: "shop",
        monitor,
        status: "up",
        consecutiveFails: 0,
        consecutiveSlow: 0,
        since: NOW - 60_000,
        lastAlertAt: null,
        checkedAt: monitor === "Web" ? NOW - 30 * 60_000 : NOW - 1000,
      });
    const json = statusJson(db, site, { current: [open], past: [] }, NOW);
    expect(json.monitors.map((m) => [m.name, m.status, m.stale])).toEqual([
      ["Web", "unknown", true],
      ["API", "down", false],
    ]);
    expect(json.components).toEqual([
      { name: "Mobile app", group: null, status: "partial" },
      { name: "Payments", group: null, status: "degraded" },
    ]);
    // Web unknown, API up by its checks, one component down, one slow.
    expect(json.site.status).toBe("partial");
  });

  it("counts a component's own state toward the site's", () => {
    const db = openDb(":memory:");
    const json = statusJson(db, site, NONE, NOW);
    expect(json.site.status).toBe("degraded");
  });
});

describe("widgetJs", () => {
  it("reads status.json next to itself", () => {
    const js = widgetJs();
    expect(js).toContain('replace(/widget\\.js$/,"")');
    expect(js).toContain('base+"status.json"');
    expect(js).toContain("d.site.status");
  });

  /**
   * Runs the script as a page would load it from `src`, and says what it
   * asked for and where its link goes.
   */
  function runWidget(src: string) {
    const fetched: string[] = [];
    const placed: Array<{ href: string }> = [];
    const element = () => ({
      style: {},
      href: "",
      textContent: "",
      appendChild() {},
    });
    const script = {
      src,
      getAttribute: () => null,
      parentNode: { insertBefore: (el: { href: string }) => placed.push(el) },
    };
    const fetch = (url: string) => {
      fetched.push(url);
      return new Promise(() => {});
    };
    new Function("document", "fetch", "setInterval", widgetJs())(
      { currentScript: script, createElement: element },
      fetch,
      () => 0,
    );
    return { fetched, href: placed[0]?.href };
  }

  it("links to the page it came from and reads its status.json", () => {
    expect(runWidget("https://status.example.com/widget.js")).toEqual({
      fetched: ["https://status.example.com/status.json"],
      href: "https://status.example.com",
    });
  });

  it("does the same under a base path, passing on the embed key", () => {
    expect(
      runWidget("https://example.com/status/widget.js?key=embed-key"),
    ).toEqual({
      fetched: ["https://example.com/status/status.json?key=embed-key"],
      href: "https://example.com/status",
    });
  });
});

describe("under a base path", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const site = parseConfig(`
sites:
  - name: Example
    host: example.com
    monitors:
      - name: API
        url: https://api.example.com
    maintenance:
      - title: Backups
        start: 2026-09-12T16:00:00Z
        end: 2026-09-12T17:00:00Z
`).sites[0];
  const incidents: SiteIncidents = {
    current: [],
    past: [
      {
        id: "slow search",
        kind: "incident",
        title: "Slow search",
        status: "resolved",
        impact: "degraded",
        startedAt: NOW - 3 * 60 * 60_000,
        endsAt: null,
        resolvedAt: NOW - 2 * 60 * 60_000,
        auto: false,
        states: {},
        postmortem: null,
        monitors: [],
        updates: [],
      },
    ],
  };

  it("puts the path in every address status.json, the feeds and the calendar name", () => {
    vi.stubEnv("STATOSS_BASE_PATH", "/status");
    expect(incidentUrl(site, "slow search")).toBe(
      "https://example.com/status/incidents/slow%20search",
    );
    expect(statusJson(openDb(":memory:"), site, NONE, NOW).site.url).toBe(
      "https://example.com/status",
    );
    const rss = feedXml(site, incidents, NOW);
    expect(rss).toContain("<link>https://example.com/status</link>");
    expect(rss).toContain(
      "<link>https://example.com/status/incidents/slow%20search</link>",
    );
    const atom = feedAtom(site, incidents, NOW);
    expect(atom).toContain('<link href="https://example.com/status"/>');
    expect(atom).toContain(
      '<link rel="self" href="https://example.com/status/feed.atom"/>',
    );
    expect(atom).toContain(
      '<link href="https://example.com/status/incidents/slow%20search"/>',
    );
    expect(maintenanceIcs(site, NOW).replaceAll("\r\n ", "")).toContain(
      "URL:https://example.com/status/incidents/maintenance-2026-09-12-1600-backups\r\n",
    );
  });

  it("leaves them at the root without one", () => {
    expect(incidentUrl(site, "slow search")).toBe(
      "https://example.com/incidents/slow%20search",
    );
    expect(feedAtom(site, incidents, NOW)).toContain(
      '<link rel="self" href="https://example.com/feed.atom"/>',
    );
  });
});

describe("maintenanceIcs", () => {
  const DAY = 24 * 60 * 60_000;
  const WEEK = 7 * DAY;
  // Sunday 4 October 2026, 02:00 in Copenhagen.
  const FIRST = Date.parse("2026-10-04T00:00:00Z");
  const site = parseConfig(`
sites:
  - name: Example
    host: Status.Example.com
    url: https://status.example.com
    timezone: Europe/Copenhagen
    monitors:
      - name: API
        url: https://api.example.com
      - name: Web
        url: https://example.com
    maintenance:
      - title: Database upgrade
        start: 2026-10-04T00:00:00Z
        end: 2026-10-04T02:00:00Z
        monitors: [API, Web]
        notes: The API may be slow, and writes pause; then all is well.
        repeat: weekly
      - title: Router swap
        start: 2027-06-01T00:00:00Z
        end: 2027-06-01T01:00:00Z
      - title: Old work
        start: 2026-08-01T00:00:00Z
        end: 2026-08-01T01:00:00Z
`).sites[0];
  const unfold = (text: string) => text.replaceAll("\r\n ", "");
  const uid = (date: string, slug: string) =>
    `UID:maintenance-${date}-${slug}@status.example.com\r\n`;

  it("lists what is planned and what will repeat, each under one UID throughout", () => {
    const raw = maintenanceIcs(site, FIRST - 2 * DAY);
    expect(raw.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(raw.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(raw).not.toMatch(/[^\r]\n/);
    // Long lines are folded at 75 octets.
    for (const line of raw.split("\r\n"))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    const before = unfold(raw);
    expect(before).toContain("X-WR-CALNAME:Example maintenance\r\n");
    expect(before).toContain("SUMMARY:Example: Database upgrade\r\n");
    expect(before).toContain(
      "DTSTART:20261004T000000Z\r\nDTEND:20261004T020000Z\r\n",
    );
    expect(before).toContain(
      "DESCRIPTION:The API may be slow\\, and writes pause\\; then all is well.\\n\\nAffects API\\, Web.\r\n",
    );
    // A repeat not planned yet is in the calendar already, and links to the page.
    const second = uid("2026-10-11-0000", "database-upgrade");
    expect(before).toContain(
      `${second}DTSTAMP:20261002T000000Z\r\nDTSTART:20261011T000000Z`,
    );
    expect(before).toMatch(
      /DTSTART:20261011T000000Z[^]*?URL:https:\/\/status\.example\.com\r\n/,
    );
    // Planned, a week ahead, it keeps its UID and links to its own page.
    const after = unfold(maintenanceIcs(site, FIRST));
    expect(after.split(second)).toHaveLength(2);
    expect(after).toContain(
      "URL:https://status.example.com/incidents/maintenance-2026-10-11-0000-database-upgrade\r\n",
    );
    // Every Sunday to 90 days ahead, and the window written for June.
    expect(before.match(/BEGIN:VEVENT/g)).toHaveLength(13 + 1);
    expect(before).toContain(uid("2027-06-01-0000", "router-swap"));
    // Winter time: 02:00 in Copenhagen is 01:00 UTC.
    expect(before).toContain(
      `${uid("2026-10-25-0100", "database-upgrade")}DTSTAMP:20261002T000000Z\r\nDTSTART:20261025T010000Z\r\n`,
    );
  });

  it("keeps the last 30 days and lets older windows go", () => {
    const now = Date.parse("2026-08-20T00:00:00Z");
    expect(unfold(maintenanceIcs(site, now))).toContain(
      uid("2026-08-01-0000", "old-work"),
    );
    expect(maintenanceIcs(site, now + 30 * DAY)).not.toContain("Old work");
    const later = unfold(maintenanceIcs(site, FIRST + 10 * WEEK));
    expect(later).not.toContain(uid("2026-10-04-0000", "database-upgrade"));
    expect(later).toContain(uid("2026-11-22-0100", "database-upgrade"));
  });
});
