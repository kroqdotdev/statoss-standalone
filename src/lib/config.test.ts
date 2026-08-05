import { describe, expect, it } from "vitest";
import { findSiteByHost, parseConfig } from "./config";

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

describe("parseConfig", () => {
  it("parses a valid config and applies defaults", () => {
    const config = parseConfig(VALID);
    expect(config.checkIntervalSeconds).toBe(60);
    expect(config.alerts).toBeUndefined();
    expect(config.sites).toHaveLength(1);
    expect(config.sites[0].checkpoints[0].expectStatus).toBeUndefined();
    expect(config.sites[0].checkpoints[1].expectStatus).toBe(200);
  });

  it("parses an alerts block", () => {
    const config = parseConfig(
      VALID +
        `
alerts:
  smtp:
    host: smtp.example.com
    port: 587
    user: smtp-user@example.com
    from: status@example.com
    to: alerts@example.com
`,
    );
    expect(config.alerts?.smtp.host).toBe("smtp.example.com");
    expect(config.alerts?.smtp.port).toBe(587);
  });

  it("rejects a config with no sites", () => {
    expect(() => parseConfig("sites: []")).toThrow(/sites/);
  });

  it("rejects an invalid checkpoint url with a useful path", () => {
    const bad = VALID.replace("https://webhooks.cc", "not-a-url");
    expect(() => parseConfig(bad)).toThrow(/sites\.0\.checkpoints\.0\.url/);
  });

  it("rejects a missing site host", () => {
    const bad = VALID.replace("host: status.webhooks.cc", 'host: ""');
    expect(() => parseConfig(bad)).toThrow(/host/);
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
