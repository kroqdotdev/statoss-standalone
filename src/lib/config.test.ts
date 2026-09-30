import { describe, expect, it } from "vitest";
import {
  expandEnv,
  monitorIntervalSeconds,
  monitorTarget,
  findSiteByHost,
  parseConfig,
  parseTimestamp,
  siteSendsUpdates,
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
    expect(monitorIntervalSeconds(monitors[6], 60)).toBe(86_400);
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
});
