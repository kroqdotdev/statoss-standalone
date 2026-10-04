import { describe, expect, it } from "vitest";
import {
  expandEnv,
  monitorIntervalSeconds,
  monitorTarget,
  findSiteByHost,
  parseConfig,
  parseTimestamp,
  siteSendsUpdates,
  siteSendsVendorAlerts,
  siteDestinations,
  siteRepeatMinutes,
  siteUrl,
} from "./config";

const VALID = `
sites:
  - name: webhooks.cc
    host: status.webhooks.cc
    monitors:
      - name: Main site
        url: https://webhooks.cc
      - name: Redirector
        url: https://go.webhooks.cc
        expectStatus: 200
`;

const SMTP = `
alerts:
  smtp:
    host: smtp.example.com
    port: 587
    user: smtp-user@example.com
    from: status@example.com
`;

describe("parseConfig", () => {
  it("reads checkpoints, the old name, as monitors", () => {
    const config = parseConfig(`
sites:
  - name: webhooks.cc
    host: status.webhooks.cc
    checkpoints:
      - name: Main site
        url: https://webhooks.cc
    maintenance:
      - title: Upgrade
        start: 2026-09-12T10:00:00Z
        end: 2026-09-12T11:00:00Z
        checkpoints: [Main site]
`);
    expect(config.sites[0].monitors.map((m) => m.name)).toEqual(["Main site"]);
    expect(config.sites[0].maintenance[0].monitors).toEqual(["Main site"]);
  });

  it("parses a valid config and applies defaults", () => {
    const config = parseConfig(VALID);
    expect(config.checkIntervalSeconds).toBe(60);
    expect(config.alerts).toBeUndefined();
    expect(config.sites).toHaveLength(1);
    const [main, redirector] = config.sites[0].monitors;
    expect(main.expectStatus).toBeUndefined();
    expect(main.method).toBe("GET");
    expect(main.keywordMode).toBe("present");
    expect(main.group).toBeUndefined();
    expect(main.slowThresholdMs).toBeUndefined();
    expect(redirector.expectStatus).toBe(200);
    expect(config.sites[0].maintenance).toEqual([]);
  });

  it("parses every monitor option", () => {
    const config = parseConfig(
      `
sites:
  - name: s
    host: s.example.com
    monitors:
      - name: API
        group: Backend
        url: https://api.example.com/health
        method: post
        headers:
          Authorization: Bearer x
        body: '{}'
        keyword: ok
        keywordMode: absent
        slowThresholdMs: 800
`.replace("method: post", "method: POST"),
    );
    expect(config.sites[0].monitors[0]).toMatchObject({
      group: "Backend",
      method: "POST",
      headers: { Authorization: "Bearer x" },
      body: "{}",
      keyword: "ok",
      keywordMode: "absent",
      slowThresholdMs: 800,
    });
  });

  it("rejects an unknown method", () => {
    expect(() =>
      parseConfig(
        VALID.replace(
          "url: https://webhooks.cc",
          "url: https://webhooks.cc\n        method: FETCH",
        ),
      ),
    ).toThrow(/method/);
  });

  const withHeader = (line: string) =>
    VALID.replace(
      "url: https://webhooks.cc",
      `url: https://webhooks.cc\n        headers:\n          ${line}`,
    );

  it("refuses a header value a request cannot carry, naming the monitor and the header", () => {
    expect(() => parseConfig(withHeader("X-Token: “abc”"))).toThrow(
      'sites.0.monitors.0.headers: the X-Token header of monitor "Main site" has a character a request cannot carry',
    );
    // A line break must not become a second header.
    expect(() =>
      parseConfig(withHeader('X-Token: "abc\\r\\nX-Admin: 1"')),
    ).toThrow("the X-Token header of monitor");
    expect(() => parseConfig(withHeader('X-Token: "a\\u0000b"'))).toThrow(
      "the X-Token header of monitor",
    );
  });

  it("refuses a header name that is not letters, digits and dashes", () => {
    expect(() => parseConfig(withHeader('"X Token": abc'))).toThrow(
      'the header name "X Token" of monitor "Main site" can only have letters, digits and dashes',
    );
    expect(() => parseConfig(withHeader('"X-Token:": abc'))).toThrow(
      "can only have letters, digits and dashes",
    );
  });

  it("keeps a header value with tabs and Latin-1 letters, and trims its ends", () => {
    const config = parseConfig(
      withHeader(
        'X-Name: "Søren\\tÅ"\n          X-Block: |\n            Bearer x',
      ),
    );
    expect(config.sites[0].monitors[0].headers).toEqual({
      "X-Name": "Søren\tÅ",
      "X-Block": "Bearer x",
    });
  });

  it("parses the SMTP shorthand and keeps the old `to` field working", () => {
    const config = parseConfig(VALID + SMTP + "    to: alerts@example.com\n");
    expect(config.alerts?.smtp?.host).toBe("smtp.example.com");
    expect(config.alerts?.smtp?.port).toBe(587);
    expect(siteDestinations(config, config.sites[0])).toEqual([
      { email: "alerts@example.com" },
    ]);
  });

  it("parses a list of destinations and per-site overrides", () => {
    const config = parseConfig(
      VALID +
        `
  - name: other
    host: status.other.example
    alerts:
      to:
        - discord: https://discord.com/api/webhooks/z
      repeatMinutes: 15
    monitors:
      - name: Home
        url: https://other.example
  - name: quiet
    host: status.quiet.example
    alerts: false
    monitors:
      - name: Home
        url: https://quiet.example
` +
        SMTP +
        `
  to:
    - email: ops@example.com
    - slack: https://hooks.slack.com/services/x
    - webhook: https://example.com/hook
      secret: s3cret
  repeatMinutes: 30
`,
    );
    const [first, other, quiet] = config.sites;
    expect(siteDestinations(config, first)).toEqual([
      { email: "ops@example.com" },
      { slack: "https://hooks.slack.com/services/x" },
      { webhook: "https://example.com/hook", secret: "s3cret" },
    ]);
    expect(siteRepeatMinutes(config, first)).toBe(30);
    expect(siteDestinations(config, other)).toEqual([
      { discord: "https://discord.com/api/webhooks/z" },
    ]);
    expect(siteRepeatMinutes(config, other)).toBe(15);
    expect(siteDestinations(config, quiet)).toEqual([]);
    expect(siteRepeatMinutes(config, quiet)).toBe(0);
  });

  it("rejects a destination it does not understand", () => {
    expect(() =>
      parseConfig(VALID + "alerts:\n  to:\n    - pager: 123\n"),
    ).toThrow(/alerts\.to\.0: A destination is one of/);
    expect(() =>
      parseConfig(VALID + "alerts:\n  to:\n    - webhook: https://x.example\n"),
    ).toThrow(/webhook needs a secret/);
    expect(() =>
      parseConfig(VALID + "alerts:\n  to:\n    - slack: not-a-url\n"),
    ).toThrow(/slack must be/);
  });

  it("requires SMTP when an email destination is used", () => {
    expect(() =>
      parseConfig(VALID + "alerts:\n  to:\n    - email: a@example.com\n"),
    ).toThrow(/alerts\.smtp: an email destination needs alerts\.smtp/);
  });

  it("parses maintenance windows and checks their monitors", () => {
    const config = parseConfig(
      VALID +
        `    maintenance:
      - title: Database upgrade
        start: 2026-09-20T01:00:00Z
        end: 2026-09-20 03:00
        monitors: [Main site]
        notes: Expect errors for a few minutes.
`,
    );
    expect(config.sites[0].maintenance[0]).toEqual({
      title: "Database upgrade",
      start: Date.UTC(2026, 8, 20, 1),
      end: Date.UTC(2026, 8, 20, 3),
      monitors: ["Main site"],
      notes: "Expect errors for a few minutes.",
    });
    expect(() =>
      parseConfig(
        VALID +
          "    maintenance:\n      - title: x\n        start: 2026-09-20T01:00:00Z\n        end: 2026-09-20T00:00:00Z\n",
      ),
    ).toThrow(/end must be after start/);
    expect(() =>
      parseConfig(
        VALID +
          "    maintenance:\n      - title: x\n        start: 2026-09-20T01:00:00Z\n        end: 2026-09-20T02:00:00Z\n        monitors: [Nope]\n",
      ),
    ).toThrow(/"Nope" is not a monitor or component of this site/);
  });

  it("reads a window that repeats, and refuses a bad rule", () => {
    const window = (lines: string) =>
      VALID +
      `    timezone: Europe/Copenhagen
    maintenance:
      - title: Backups
        start: 2026-10-04T02:00:00+02:00
        end: 2026-10-04T03:00:00+02:00
${lines}`;
    const config = parseConfig(
      window("        repeat: monthly-weekday\n        until: 2027-03-31\n"),
    );
    expect(config.sites[0].maintenance[0]).toEqual({
      title: "Backups",
      start: Date.UTC(2026, 9, 4),
      end: Date.UTC(2026, 9, 4, 1),
      repeat: "monthly-weekday",
      until: "2027-03-31",
    });
    // A day on its own, as the start is in Copenhagen: the 4th there.
    expect(() =>
      parseConfig(
        window("        repeat: weekly\n        until: 2026-10-04\n"),
      ),
    ).not.toThrow();
    expect(() => parseConfig(window("        repeat: daily\n"))).toThrow(
      /maintenance\.0\.repeat: must be weekly, monthly or monthly-weekday/,
    );
    expect(() => parseConfig(window("        until: 2027-03-31\n"))).toThrow(
      /maintenance\.0\.until: until is for a window that repeats; add repeat/,
    );
    expect(() =>
      parseConfig(
        window("        repeat: weekly\n        until: 2026-10-03\n"),
      ),
    ).toThrow(
      /maintenance\.0\.until: until is before the first window, which starts on 2026-10-04/,
    );
    expect(() =>
      parseConfig(
        window("        repeat: weekly\n        until: 2027-03-31\n").replace(
          "Europe/Copenhagen",
          "Mars/Olympus",
        ),
      ),
    ).toThrow(/timezone: is not a time zone/);
    for (const bad of ["31 March", "2027-02-30", "2027-03-31T00:00:00Z"])
      expect(() =>
        parseConfig(window(`        repeat: weekly\n        until: ${bad}\n`)),
      ).toThrow(`"${bad}" is not a date. Write it like 2027-03-31.`);
  });

  it("refuses a repeating window that would run into the next", () => {
    const window = (repeat: string, end: string) =>
      VALID +
      `    maintenance:
      - title: Move
        start: 2026-10-04T00:00:00Z
        end: ${end}
        repeat: ${repeat}
`;
    expect(() => parseConfig(window("weekly", "2026-10-11T00:00:00Z"))).toThrow(
      /maintenance\.0\.end: a window that repeats every week has to be shorter than a week/,
    );
    expect(() =>
      parseConfig(window("weekly", "2026-10-10T23:59:00Z")),
    ).not.toThrow();
    expect(() =>
      parseConfig(window("monthly", "2026-11-01T00:00:00Z")),
    ).toThrow(/has to be shorter than four weeks/);
    expect(() =>
      parseConfig(window("monthly-weekday", "2026-10-31T00:00:00Z")),
    ).not.toThrow();
  });

  it("rejects a config with no sites", () => {
    expect(() => parseConfig("sites: []")).toThrow(/sites/);
  });

  it("rejects an invalid monitor url with a useful path", () => {
    const bad = VALID.replace("https://webhooks.cc", "not-a-url");
    expect(() => parseConfig(bad)).toThrow(/sites\.0\.monitors\.0\.url/);
  });

  it("rejects two monitors with the same name in one site", () => {
    const bad = VALID.replace("name: Redirector", "name: Main site");
    expect(() => parseConfig(bad)).toThrow(
      /"Main site" is used more than once/,
    );
  });

  it("rejects two sites with the same host, ignoring case", () => {
    const twoSites =
      VALID +
      `
  - name: other
    host: STATUS.webhooks.cc
    monitors:
      - name: Home
        url: https://other.example.com
`;
    expect(() => parseConfig(twoSites)).toThrow(
      /"status.webhooks.cc" is used by more than one site/,
    );
  });

  it("rejects a missing site host", () => {
    const bad = VALID.replace("host: status.webhooks.cc", 'host: ""');
    expect(() => parseConfig(bad)).toThrow(/host/);
  });

  it("fills in environment variables and refuses unset ones", () => {
    const config = parseConfig(
      VALID + "alerts:\n  to:\n    - slack: ${SLACK_URL}\n",
      { SLACK_URL: "https://hooks.slack.com/services/abc" },
    );
    expect(siteDestinations(config, config.sites[0])).toEqual([
      { slack: "https://hooks.slack.com/services/abc" },
    ]);
    expect(() =>
      parseConfig(VALID + "alerts:\n  to:\n    - slack: ${SLACK_URL}\n", {}),
    ).toThrow(/SLACK_URL is used but not set/);
    expect(expandEnv("a ${X} b $Y ${x}", { X: "1" })).toBe("a 1 b $Y ${x}");
  });
});

describe("parseTimestamp", () => {
  it("reads ISO strings, bare UTC dates and Date objects", () => {
    expect(parseTimestamp("2026-09-20T01:00:00Z")).toBe(
      Date.UTC(2026, 8, 20, 1),
    );
    expect(parseTimestamp("2026-09-20T03:00:00+02:00")).toBe(
      Date.UTC(2026, 8, 20, 1),
    );
    expect(parseTimestamp("2026-09-20 01:00")).toBe(Date.UTC(2026, 8, 20, 1));
    expect(parseTimestamp("2026-09-20")).toBe(Date.UTC(2026, 8, 20));
    expect(parseTimestamp(new Date(5000))).toBe(5000);
    expect(parseTimestamp("soon")).toBeNull();
    expect(parseTimestamp(42)).toBeNull();
  });
});

describe("siteUrl", () => {
  it("uses the configured url, else https on the host", () => {
    expect(siteUrl({ host: "status.example.com", url: undefined })).toBe(
      "https://status.example.com",
    );
    expect(siteUrl({ host: "localhost:3000", url: undefined })).toBe(
      "http://localhost:3000",
    );
    expect(
      siteUrl({ host: "status.example.com", url: "http://a.example/s" }),
    ).toBe("http://a.example/s");
  });
});

describe("findSiteByHost", () => {
  const config = parseConfig(VALID);

  it("matches exact host", () => {
    expect(findSiteByHost(config, "status.webhooks.cc")?.name).toBe(
      "webhooks.cc",
    );
  });

  it("strips port and ignores case", () => {
    expect(findSiteByHost(config, "STATUS.webhooks.CC:3000")?.name).toBe(
      "webhooks.cc",
    );
  });

  it("returns undefined for unknown or missing host", () => {
    expect(findSiteByHost(config, "other.example.com")).toBeUndefined();
    expect(findSiteByHost(config, null)).toBeUndefined();
  });
});

describe("monitor types", () => {
  const site = (monitor: string) => `
sites:
  - name: s
    host: h
    monitors:
${monitor}
`;

  it("reads every type with its own fields", () => {
    const config = parseConfig(
      site(`      - name: Web
        url: https://example.com
      - name: DB
        type: tcp
        host: db.example.com
        port: 5432
      - name: Records
        type: dns
        host: example.com
        record: MX
        expect: mail.example.com
      - name: Router
        type: ping
        host: 192.0.2.1
      - name: Cert
        type: certificate
        host: example.com
        warnDays: 21
      - name: Domain
        type: domain
        host: example.com
      - name: Backup
        type: heartbeat
        token: abcdefgh1234
        intervalSeconds: 86400`),
    );
    const monitors = config.sites[0].monitors;
    expect(monitors.map((m) => m.type)).toEqual([
      "http",
      "tcp",
      "dns",
      "ping",
      "certificate",
      "domain",
      "heartbeat",
    ]);
    expect(monitors.map(monitorTarget)).toEqual([
      "https://example.com",
      "db.example.com:5432",
      "MX example.com",
      "192.0.2.1",
      "example.com",
      "example.com",
      "expects a ping",
    ]);
    // A heartbeat is judged every round; its own interval is when pings are due.
    expect(monitorIntervalSeconds(monitors[6], 60)).toBe(60);
  });

  it.each([
    ["      - name: a\n        type: tcp\n        host: x.example", "port"],
    ["      - name: a\n        type: ping", "host"],
    ["      - name: a\n        type: http", "url"],
    ["      - name: a\n        type: heartbeat", "token"],
    [
      "      - name: a\n        type: ping\n        host: x.example\n        keyword: ok",
      "takes no keyword",
    ],
    [
      "      - name: a\n        type: certificate\n        host: x.example\n        slowThresholdMs: 500",
      "takes no slowThresholdMs",
    ],
    [
      "      - name: a\n        url: https://example.com\n        slowThresholdMs: 10000",
      "slowThresholdMs",
    ],
    [
      "      - name: a\n        type: heartbeat\n        token: abcdefgh\n      - name: b\n        type: heartbeat\n        token: abcdefgh",
      "token is used by more than one",
    ],
  ])("rejects %s", (monitor, message) => {
    expect(() => parseConfig(site(monitor))).toThrow(message);
  });
});

describe("more destinations", () => {
  const withTo = (to: string) => `
alerts:
  to:
${to}
sites:
  - name: s
    host: h
    monitors:
      - name: m
        url: https://example.com
`;

  it("reads PagerDuty, Opsgenie and ntfy", () => {
    const config = parseConfig(
      withTo(`    - pagerduty: R0UT1NG
    - opsgenie: KEY
      region: eu
    - opsgenie: KEY2
    - ntfy: https://ntfy.sh/mytopic
      token: tk_1
    - ntfy: https://ntfy.example.com/ops`),
    );
    expect(config.alerts?.to).toEqual([
      { pagerduty: "R0UT1NG" },
      { opsgenie: "KEY", region: "eu" },
      { opsgenie: "KEY2", region: "us" },
      { ntfy: "https://ntfy.sh/mytopic", token: "tk_1" },
      { ntfy: "https://ntfy.example.com/ops" },
    ]);
    expect(siteSendsUpdates(config, config.sites[0])).toBe(true);
  });

  it.each([
    ["    - opsgenie: KEY\n      region: asia", "region: eu"],
    ["    - ntfy: mytopic", "topic's URL"],
    ["    - pagerduty: KEY\n      extra: 1", "pagerduty"],
  ])("rejects %s", (to, message) => {
    expect(() => parseConfig(withTo(to))).toThrow(message);
  });

  it("lets a site, or every site, keep updates to the page", () => {
    const config = parseConfig(`
alerts:
  to:
    - slack: https://hooks.slack.com/x
  updates: false
sites:
  - name: a
    host: a
    monitors:
      - name: m
        url: https://example.com
  - name: b
    host: b
    alerts:
      updates: true
    monitors:
      - name: m
        url: https://example.com
`);
    expect(config.sites.map((s) => siteSendsUpdates(config, s))).toEqual([
      false,
      true,
    ]);
  });

  it("tells of vendors unless a site, or every site, says vendors: false", () => {
    const config = parseConfig(`
alerts:
  to:
    - slack: https://hooks.slack.com/x
  vendors: false
sites:
  - name: a
    host: a
  - name: b
    host: b
    alerts:
      vendors: true
  - name: c
    host: c
    alerts: false
`);
    expect(config.sites.map((s) => siteSendsVendorAlerts(config, s))).toEqual([
      false,
      true,
      false,
    ]);
    const on = parseConfig(withTo("    - slack: https://hooks.slack.com/x"));
    expect(siteSendsVendorAlerts(on, on.sites[0])).toBe(true);
  });
});

describe("page settings", () => {
  const site = (extra: string) => `
sites:
  - name: s
    host: h
${extra}
    monitors:
      - name: m
        url: https://example.com
`;

  it("has defaults that change nothing", () => {
    expect(parseConfig(site("")).sites[0]).toMatchObject({
      theme: "auto",
      timezone: "UTC",
      noindex: false,
      defaultRange: "24h",
      foldGroups: false,
    });
  });

  it("reads the look, the zone, the range and the password", () => {
    const s = parseConfig(
      site(`    description: What we run.
    logo: logo.svg
    favicon: https://example.com/favicon.png
    accent: "#6D2A7A"
    theme: dark
    supportUrl: mailto:help@example.com
    timezone: Europe/Copenhagen
    noindex: true
    defaultRange: 90d
    foldGroups: true
    password: hunter22
    embedKey: embed-key-1`),
    ).sites[0];
    expect(s).toMatchObject({
      accent: "#6D2A7A",
      theme: "dark",
      supportUrl: "mailto:help@example.com",
      timezone: "Europe/Copenhagen",
      defaultRange: "90d",
      password: "hunter22",
    });
  });

  it.each([
    ["    accent: plum", "colour like"],
    ["    timezone: Europe/Copenhagn", "is not a time zone"],
    ["    supportUrl: javascript:alert(1)", "http(s) or mailto"],
    ["    defaultRange: 30d", "defaultRange"],
    ["    embedKey: short", "embedKey"],
  ])("rejects %s", (extra, message) => {
    expect(() => parseConfig(site(extra))).toThrow(message);
  });

  it("takes a site with components and no monitors", () => {
    const config = parseConfig(`
sites:
  - name: s
    host: h
    components:
      - name: Mobile app
`);
    expect(config.sites[0].monitors).toEqual([]);
    expect(config.sites[0].components[0].state).toBe("operational");
  });
});

describe("vendor components", () => {
  const withComponent = (component: string) => `
sites:
  - name: s
    host: h
    components:
${component}
`;

  it("follow a status page, or one part of it", () => {
    const c = parseConfig(
      withComponent(`      - name: GitHub
        vendor: https://www.githubstatus.com/
        part: Git Operations`),
    ).sites[0].components[0];
    expect(c).toMatchObject({
      vendor: "https://www.githubstatus.com",
      part: "Git Operations",
      state: "operational",
    });
  });

  it("follow the page when the feed's address is given, and Stripe where its feed is", () => {
    const vendors = parseConfig(
      withComponent(`      - name: Linear
        vendor: https://linearstatus.com/api/v2/summary.json
      - name: Stripe
        vendor: https://status.stripe.com`),
    ).sites[0].components.map((c) => c.vendor);
    expect(vendors).toEqual([
      "https://linearstatus.com",
      "https://www.stripestatus.com",
    ]);
  });

  it.each([
    ["      - name: x\n        part: API", "part needs a vendor"],
    ["      - name: x\n        vendor: githubstatus.com", "vendor"],
    ["      - name: x\n        vendor: ftp://example.com", "vendor"],
  ])("rejects %s", (component, message) => {
    expect(() => parseConfig(withComponent(component))).toThrow(message);
  });
});

describe("names and windows that would collide", () => {
  it("refuses row names that make the same anchor", () => {
    expect(() =>
      parseConfig(`
sites:
  - name: s
    host: h
    monitors:
      - name: API v2
        url: https://example.com
    components:
      - name: API-v2
`),
    ).toThrow('names "API v2" and "API-v2" are too alike');
  });

  it("refuses two windows with one title in one minute", () => {
    expect(() =>
      parseConfig(`
sites:
  - name: s
    host: h
    monitors:
      - name: m
        url: https://example.com
    maintenance:
      - title: Upgrade
        start: 2026-10-01T01:00:05Z
        end: 2026-10-01T02:00:00Z
      - title: Upgrade
        start: 2026-10-01T01:00:40Z
        end: 2026-10-01T03:00:00Z
`),
    ).toThrow("same title and start in the same minute");
  });
});
