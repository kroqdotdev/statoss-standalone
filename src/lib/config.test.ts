import { describe, expect, it } from "vitest";
import {
  expandEnv,
  findSiteByHost,
  parseConfig,
  parseTimestamp,
  siteDestinations,
  siteRepeatMinutes,
  siteUrl,
} from "./config";

const VALID = `
sites:
  - name: webhooks.cc
    host: status.webhooks.cc
    checkpoints:
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
  it("parses a valid config and applies defaults", () => {
    const config = parseConfig(VALID);
    expect(config.checkIntervalSeconds).toBe(60);
    expect(config.alerts).toBeUndefined();
    expect(config.sites).toHaveLength(1);
    const [main, redirector] = config.sites[0].checkpoints;
    expect(main.expectStatus).toBeUndefined();
    expect(main.method).toBe("GET");
    expect(main.keywordMode).toBe("present");
    expect(main.group).toBeUndefined();
    expect(main.slowThresholdMs).toBeUndefined();
    expect(redirector.expectStatus).toBe(200);
    expect(config.sites[0].maintenance).toEqual([]);
  });

  it("parses every checkpoint option", () => {
    const config = parseConfig(
      `
sites:
  - name: s
    host: s.example.com
    checkpoints:
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
    expect(config.sites[0].checkpoints[0]).toMatchObject({
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
    checkpoints:
      - name: Home
        url: https://other.example
  - name: quiet
    host: status.quiet.example
    alerts: false
    checkpoints:
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

  it("parses maintenance windows and checks their checkpoints", () => {
    const config = parseConfig(
      VALID +
        `    maintenance:
      - title: Database upgrade
        start: 2026-09-20T01:00:00Z
        end: 2026-09-20 03:00
        checkpoints: [Main site]
        notes: Expect errors for a few minutes.
`,
    );
    expect(config.sites[0].maintenance[0]).toEqual({
      title: "Database upgrade",
      start: Date.UTC(2026, 8, 20, 1),
      end: Date.UTC(2026, 8, 20, 3),
      checkpoints: ["Main site"],
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
          "    maintenance:\n      - title: x\n        start: 2026-09-20T01:00:00Z\n        end: 2026-09-20T02:00:00Z\n        checkpoints: [Nope]\n",
      ),
    ).toThrow(/"Nope" is not a checkpoint of this site/);
  });

  it("rejects a config with no sites", () => {
    expect(() => parseConfig("sites: []")).toThrow(/sites/);
  });

  it("rejects an invalid checkpoint url with a useful path", () => {
    const bad = VALID.replace("https://webhooks.cc", "not-a-url");
    expect(() => parseConfig(bad)).toThrow(/sites\.0\.checkpoints\.0\.url/);
  });

  it("rejects two checkpoints with the same name in one site", () => {
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
    checkpoints:
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
