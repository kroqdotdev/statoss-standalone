import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  isBetterStack,
  isHeroku,
  isInstatusSummary,
  isSlack,
  parseBetterStack,
  parseHeroku,
  parseInstatus,
  parseSlack,
  parseSorry,
  parseStatusIo,
  sorryOpenNotices,
  STATUS_IO_API,
  statusIoName,
} from "./vendor-formats";
import { fetchVendor, parseStatuspage } from "./vendors";

/**
 * Fixtures are the platforms' public answers on 2 October 2026, trimmed;
 * the -outage ones are those answers with an outage written in from each
 * platform's documented values, since the live pages were all green.
 */
const raw = (name: string): string =>
  readFileSync(join(__dirname, "vendor-fixtures", `${name}.json`), "utf8");
const fixture = (name: string): unknown => JSON.parse(raw(name));

const notUp = (r: { components: Array<{ name: string; state: string }> }) =>
  r.components
    .filter((c) => c.state !== "up")
    .map((c) => `${c.name}:${c.state}`);

describe("reading other status page platforms", () => {
  it("reads Instatus, members not group rows, and the incidents' components", () => {
    const r = parseInstatus(
      fixture("instatus-koyeb-summary-outage"),
      fixture("instatus-koyeb-components-outage"),
      "https://status.koyeb.com",
    );
    expect(r.name).toBe("Koyeb");
    expect(r.state).toBe("down");
    expect(notUp(r)).toEqual([
      "Frankfurt - FRA:down",
      "API:slow",
      "Build / Provisioning:slow",
    ]);
    expect(r.incidents[0]).toEqual({
      name: "Elevated API errors in Frankfurt",
      url: "https://status.koyeb.com/incident/cmg0000000000000000000001",
      components: ["Frankfurt - FRA", "API"],
    });
    const zed = parseInstatus(
      fixture("instatus-zed-summary"),
      fixture("instatus-zed-components"),
      "https://status.zed.dev",
    );
    expect(zed).toMatchObject({ name: "Zed", state: "up", incidents: [] });
    expect(zed.components.length).toBe(5);
  });

  it("tells Instatus's summary.json from Statuspage's", () => {
    expect(isInstatusSummary(fixture("instatus-zed-summary"))).toBe(true);
    expect(isInstatusSummary(fixture("stripe-summary"))).toBe(false);
    expect(() =>
      parseStatuspage(fixture("instatus-zed-summary"), "https://x.example"),
    ).toThrow("not a status page summary");
  });

  it("reads Stripe's status, which is Statuspage", () => {
    const r = parseStatuspage(
      fixture("stripe-summary"),
      "https://www.stripestatus.com",
    );
    expect(r).toMatchObject({ name: "Stripe", state: "up", incidents: [] });
    expect(r.components.map((c) => c.name)).toContain("Stripe API");
  });

  it("reads Better Stack, open reports only", () => {
    const r = parseBetterStack(
      fixture("betterstack-polar-index-outage"),
      "https://status.polar.sh",
    );
    expect(r).toMatchObject({ name: "Polar", state: "down" });
    expect(notUp(r)).toEqual(["API:down", "Checkout:slow"]);
    expect(r.incidents).toEqual([
      {
        name: "API returning 503 errors",
        url: "https://status.polar.sh/incident/1000001",
        components: ["API", "Checkout"],
      },
    ]);
    // Turso's report with no end but resolved is not open.
    const turso = parseBetterStack(
      fixture("betterstack-turso-index"),
      "https://status.turso.tech",
    );
    expect(turso).toMatchObject({ name: "Turso", state: "up", incidents: [] });
    expect(turso.components.every((c) => c.name === c.name.trim())).toBe(true);
    expect(isBetterStack(fixture("instatus-zed-summary"))).toBe(false);
  });

  it("reads Sorry, from the notices read on their own", () => {
    expect(
      sorryOpenNotices(fixture("postmark-notices-present-outage")),
    ).toEqual(["510500"]);
    expect(sorryOpenNotices(fixture("postmark-notices-present"))).toEqual([]);
    const r = parseSorry(
      fixture("postmark-status-outage"),
      fixture("postmark-components-outage"),
      [fixture("postmark-notice-detail-outage")],
      "https://status.postmarkapp.com",
    );
    expect(r).toMatchObject({ name: "Postmark Status", state: "slow" });
    expect(notUp(r)).toContain("Sending:slow");
    expect(r.incidents).toEqual([
      expect.objectContaining({
        name: "Delayed Message Delivery",
        components: ["Sending", "Inbound"],
      }),
    ]);
  });

  it("reads status.io, a component's containers as its parts", () => {
    const r = parseStatusIo(
      fixture("gitlab-status-outage"),
      "https://status.gitlab.com",
      "5b36dc6502d06804c08349f7",
      "GitLab",
    );
    expect(r).toMatchObject({ name: "GitLab", state: "down" });
    expect(notUp(r)).toEqual([
      "Git Operations:down",
      "CI/CD - Hosted runners on Linux:slow",
    ]);
    expect(r.incidents[0]).toEqual({
      name: "Git operations failing over SSH",
      url: "https://status.gitlab.com/pages/incident/5b36dc6502d06804c08349f7/6abea6ac2dc48705ab3d9c9e",
      components: ["Git Operations"],
    });
    const neon = parseStatusIo(
      fixture("neon-status"),
      "https://neonstatus.com",
      "6878fc85709daa75be6c7e3c",
      "Neon",
    );
    expect(neon.state).toBe("up");
    expect(
      neon.components.find(
        (c) => c.name === "Database Connectivity (AWS eu-central-1)",
      ),
    ).toMatchObject({ state: "up" });
    expect(statusIoName("<title>GitLab System Status</title>")).toBe("GitLab");
    expect(statusIoName("<title>Neon Status</title>")).toBe("Neon");
  });

  it("reads Heroku by its open incidents, never `resolved`", () => {
    const r = parseHeroku(
      fixture("heroku-current-status-outage"),
      "https://status.heroku.com",
    );
    expect(r).toMatchObject({ name: "Heroku", state: "down" });
    expect(notUp(r)).toEqual(["Apps:down", "Tools:slow"]);
    expect(r.incidents).toEqual([
      {
        name: "Heroku Feature Degradation",
        url: "https://status.heroku.com/incidents/2964",
        components: ["Apps", "Tools"],
      },
    ]);
    expect(
      parseHeroku(
        fixture("heroku-current-status"),
        "https://status.heroku.com",
      ),
    ).toMatchObject({ state: "up", incidents: [] });
    expect(isHeroku(fixture("slack-current"))).toBe(false);
  });

  it("reads Slack's services from its open incidents", () => {
    const r = parseSlack(
      fixture("slack-current-outage"),
      "https://status.slack.com",
    );
    expect(r).toMatchObject({ name: "Slack", state: "down" });
    expect(notUp(r)).toEqual([
      "Messaging:down",
      "Huddles:slow",
      "Search:slow",
      "Apps/Integrations/APIs:down",
    ]);
    expect(r.incidents).toHaveLength(3);
    const calm = parseSlack(
      fixture("slack-current"),
      "https://status.slack.com",
    );
    expect(calm).toMatchObject({ state: "up", incidents: [] });
    expect(calm.components).toHaveLength(11);
    expect(isSlack(fixture("heroku-current-status"))).toBe(false);
  });
});

/**
 * One server stands in for every vendor: each is a path prefix, and
 * api.status.io is one more. Pages answer only at their platform's paths.
 */
const PAGES: Record<string, Record<string, () => [number, string, object?]>> = {
  "/instatus": {
    // Instatus answers Statuspage's address too, in its own shape.
    "/api/v2/summary.json": () => [200, raw("instatus-koyeb-summary-outage")],
    "/summary.json": () => [200, raw("instatus-koyeb-summary-outage")],
    "/v2/components.json": () => [200, raw("instatus-koyeb-components-outage")],
  },
  "/betterstack": {
    "/index.json": () => [200, raw("betterstack-polar-index-outage")],
  },
  "/statusio": {
    "": () => [
      200,
      "<html><title>GitLab System Status</title></html>",
      { "x-status-page-id": "5b36dc6502d06804c08349f7" },
    ],
  },
  "/api.status.io": {
    "/5b36dc6502d06804c08349f7": () => [200, raw("gitlab-status-outage")],
  },
  "/sorry": {
    "/api/v1/status": () => [200, raw("postmark-status-outage")],
    "/api/v1/components": () => [200, raw("postmark-components-outage")],
    "/api/v1/notices": () => [200, raw("postmark-notices-present-outage")],
    "/api/v1/notices/510500": () => [200, raw("postmark-notice-detail-outage")],
  },
  "/heroku": {
    // A refusal at another platform's address is not the end of the round.
    "/api/v2/summary.json": () => [403, "forbidden"],
    "/api/v4/current-status": () => [200, raw("heroku-current-status-outage")],
  },
  "/slack": {
    "/api/v2.0.0/current": () => [200, raw("slack-current-outage")],
  },
  "/stripe": {
    "/api/v2/summary.json": () => [200, raw("stripe-summary")],
  },
};

let server: Server;
let base: string;
const asked: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    asked.push(path);
    const prefix = Object.keys(PAGES).find(
      (p) => path === p || path.startsWith(`${p}/`),
    );
    const answer = prefix ? PAGES[prefix][path.slice(prefix.length)] : null;
    if (!answer) return void res.writeHead(404).end("not here");
    const [status, body, headers] = answer();
    res.writeHead(status, { "content-type": "text/plain", ...headers });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.close();
});

/** The real fetch, with api.status.io answered by the local server. */
const local: typeof fetch = (input, init) =>
  fetch(String(input).replace(STATUS_IO_API, `${base}/api.status.io`), init);

describe("finding a page's platform", () => {
  it.each([
    ["/instatus", "instatus", "Koyeb", "down"],
    ["/betterstack", "betterstack", "Polar", "down"],
    ["/statusio", "statusio", "GitLab", "down"],
    ["/sorry", "sorry", "Postmark Status", "slow"],
    ["/heroku", "heroku", "Heroku", "down"],
    ["/slack", "slack", "Slack", "down"],
    ["/stripe", "statuspage", "Stripe", "up"],
  ])("reads %s as %s", async (path, format, name, state) => {
    const found = await fetchVendor(`${base}${path}`, local);
    expect(found.format).toBe(format);
    expect(found.reading).toMatchObject({ name, state });
  });

  it("reads a Sorry page's open notices for the parts they touch", async () => {
    const { reading } = await fetchVendor(`${base}/sorry`, local);
    expect(reading.incidents[0].components).toEqual(["Sending", "Inbound"]);
  });

  it("asks the remembered format first, and every other once when it stops answering", async () => {
    asked.length = 0;
    await fetchVendor(`${base}/slack`, local, "slack");
    expect(asked).toEqual(["/slack/api/v2.0.0/current"]);
    asked.length = 0;
    await expect(
      fetchVendor(`${base}/nothing`, local, "slack"),
    ).rejects.toThrow("no status feed at that address");
    expect(asked).toEqual([
      "/nothing/api/v2.0.0/current",
      "/nothing/api/v2/summary.json",
      "/nothing/summary.json",
      "/nothing/status.json",
      "/nothing/index.json",
      "/nothing",
      "/nothing/api/v1/status",
      "/nothing/api/v4/current-status",
    ]);
  });

  it("stops at an address that cannot be reached", async () => {
    const dead = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    await expect(fetchVendor("https://gone.example", dead)).rejects.toThrow(
      /ENOTFOUND/,
    );
    expect(dead).toHaveBeenCalledTimes(1);
  });
});
