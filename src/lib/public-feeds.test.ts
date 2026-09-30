import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";
import { insertCheck, openDb, setState } from "./db";
import type { IncidentView, SiteIncidents } from "./incidents";
import {
  badgeJson,
  badgeSvg,
  feedAtom,
  feedEntry,
  feedXml,
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
        latencyMs24h: 200,
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
});
