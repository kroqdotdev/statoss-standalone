import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "./config";
import {
  clearVendors,
  normalizeVendorUrl,
  parseStatoss,
  parseStatuspage,
  refreshVendors,
  VENDOR_REFRESH_MS,
  VENDOR_STALE_MS,
  vendorUrls,
  vendorView,
} from "./vendors";

const SUMMARY = {
  page: { name: "Acme" },
  status: { indicator: "minor" },
  components: [
    { id: "g", name: "API", group: true, status: "partial_outage" },
    { id: "1", name: "REST API", group_id: "g", status: "partial_outage" },
    { id: "2", name: "Webhooks", group_id: "g", status: "operational" },
    { id: "3", name: "Dashboard", status: "major_outage" },
  ],
  incidents: [
    {
      name: "Elevated errors",
      status: "investigating",
      shortlink: "https://stspg.io/abc",
      components: [{ name: "REST API" }],
    },
    { name: "Old", status: "resolved", components: [] },
    { name: "Odd link", status: "identified", shortlink: "javascript:x" },
  ],
};

const URL_ = "https://status.acme.example";

function answering(bodies: Record<string, unknown>) {
  return vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    return path in bodies
      ? Response.json(bodies[path])
      : new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
}

const CONFIG = parseConfig(`
sites:
  - name: s
    host: h
    components:
      - name: Acme API
        vendor: https://status.acme.example/
        part: REST API
      - name: Acme
        vendor: https://status.acme.example
      - name: Own thing
`);

describe("reading a vendor's page", () => {
  it("reads a Statuspage summary: members, not groups, and open incidents with safe links", () => {
    const reading = parseStatuspage(SUMMARY, URL_);
    expect(reading.name).toBe("Acme");
    expect(reading.state).toBe("slow");
    expect(reading.components).toEqual([
      { name: "REST API", state: "slow" },
      { name: "Webhooks", state: "up" },
      { name: "Dashboard", state: "down" },
    ]);
    expect(reading.incidents).toEqual([
      {
        name: "Elevated errors",
        url: "https://stspg.io/abc",
        components: ["REST API"],
      },
      { name: "Odd link", url: URL_, components: [] },
    ]);
    expect(() => parseStatuspage({ status: {} }, URL_)).toThrow();
  });

  it("reads a StatOSS status.json, hosted or standalone", () => {
    const standalone = parseStatoss(
      {
        site: { name: "Other", status: "partial", url: "https://s.example" },
        monitors: [
          { name: "Web", status: "down" },
          { name: "API", status: "up" },
        ],
        incidents: [
          { title: "Web is out", impact: "major", monitors: ["Web"] },
        ],
      },
      URL_,
    );
    expect(standalone.state).toBe("slow");
    expect(standalone.components[0]).toEqual({ name: "Web", state: "down" });
    expect(standalone.incidents[0]).toEqual({
      name: "Web is out",
      url: "https://s.example/",
      components: ["Web"],
    });
    const hosted = parseStatoss(
      {
        page: { name: "Hosted", status: "operational" },
        monitors: [],
        incidents: [
          { title: "x", impact: "degraded", monitors: [{ name: "A" }] },
        ],
      },
      URL_,
    );
    expect(hosted.incidents[0].components).toEqual(["A"]);
    expect(() => parseStatoss({ monitors: [] }, URL_)).toThrow();
  });
});

describe("following a vendor", () => {
  beforeEach(() => {
    clearVendors();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("takes a StatOSS page that does not know its state as no reading", async () => {
    await refreshVendors(
      CONFIG,
      0,
      answering({
        "/status.json": {
          site: { name: "Other", status: "unknown" },
          monitors: [{ name: "REST API", status: "unknown" }],
        },
      }),
    );
    expect(vendorView(URL_, null, 0)).toMatchObject({
      state: null,
      problem: "does not know its own state",
    });
    expect(vendorView(URL_, "REST API", 0).state).toBeNull();
  });

  it("keeps one address per vendor, without its trailing slash", () => {
    expect(vendorUrls(CONFIG)).toEqual([URL_]);
  });

  it("keeps the page's address when the feed's is given, and reads Stripe where its feed is", () => {
    expect(
      normalizeVendorUrl("https://status.acme.example/api/v2/summary.json?x=1"),
    ).toBe(URL_);
    expect(normalizeVendorUrl("https://status.acme.example/index.json")).toBe(
      URL_,
    );
    expect(normalizeVendorUrl("http://10.0.0.5:3000/status.json")).toBe(
      "http://10.0.0.5:3000",
    );
    expect(normalizeVendorUrl("https://status.acme.example/eu/")).toBe(
      `${URL_}/eu`,
    );
    expect(normalizeVendorUrl("https://status.stripe.com/")).toBe(
      "https://www.stripestatus.com",
    );
  });

  it("names the vendor by its page once read, and by its address before", async () => {
    expect(vendorView(URL_, null, 0).name).toBe("acme.example");
    await refreshVendors(
      CONFIG,
      0,
      answering({
        "/api/v2/summary.json": { ...SUMMARY, page: { name: "Acme Status" } },
      }),
    );
    expect(vendorView(URL_, null, 0).name).toBe("Acme");
  });

  it("says nothing before the first reading, then follows the page or one part of it", async () => {
    expect(vendorView(URL_, null, 0)).toMatchObject({
      state: null,
      problem: "not read yet",
      host: "status.acme.example",
    });
    const fetchFn = answering({ "/api/v2/summary.json": SUMMARY });
    expect(await refreshVendors(CONFIG, 1000, fetchFn)).toBe(true);
    expect(vendorView(URL_, null, 1000)).toMatchObject({
      state: "degraded",
      problem: null,
    });
    expect(vendorView(URL_, null, 1000).incidents).toHaveLength(2);
    // The part's own state, and only the incidents that touch it or name nothing.
    expect(vendorView(URL_, "rest api", 1000)).toMatchObject({
      state: "degraded",
      incidents: [
        { name: "Elevated errors", url: "https://stspg.io/abc" },
        { name: "Odd link", url: URL_ },
      ],
    });
    expect(vendorView(URL_, "Dashboard", 1000).state).toBe("major");
    expect(vendorView(URL_, "Webhooks", 1000)).toMatchObject({
      state: "operational",
      incidents: [],
    });
    expect(vendorView(URL_, "Nope", 1000)).toMatchObject({
      state: null,
      problem: 'has no part named "Nope"',
    });
  });

  it("takes the worse of two parts with one name, whichever comes first", async () => {
    await refreshVendors(
      CONFIG,
      0,
      answering({
        "/api/v2/summary.json": {
          ...SUMMARY,
          components: [
            { name: "REST API", status: "operational" },
            { name: "REST API", status: "major_outage" },
            { name: "REST API", status: "degraded_performance" },
          ],
        },
      }),
    );
    expect(vendorView(URL_, "REST API", 0)).toMatchObject({
      state: "major",
      incidents: [{ name: "Elevated errors" }, { name: "Odd link" }],
    });
  });

  it("reads a page again only every five minutes", async () => {
    const fetchFn = answering({ "/api/v2/summary.json": SUMMARY });
    await refreshVendors(CONFIG, 0, fetchFn);
    expect(await refreshVendors(CONFIG, VENDOR_REFRESH_MS - 1, fetchFn)).toBe(
      false,
    );
    expect(await refreshVendors(CONFIG, VENDOR_REFRESH_MS, fetchFn)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("tries each platform in turn, and asks the one that read first the next time", async () => {
    const fetchFn = answering({
      "/status.json": {
        site: { name: "Other", status: "major" },
        monitors: [],
      },
    });
    await refreshVendors(CONFIG, 0, fetchFn);
    expect(vendorView(URL_, null, 0).state).toBe("major");
    await refreshVendors(CONFIG, VENDOR_REFRESH_MS, fetchFn);
    const asked = (
      fetchFn as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => new URL(String(c[0])).pathname);
    expect(asked).toEqual([
      "/api/v2/summary.json",
      "/summary.json",
      "/status.json",
      "/status.json",
    ]);
  });

  it("keeps the last reading for half an hour when the vendor stops answering, then lets go", async () => {
    await refreshVendors(
      CONFIG,
      0,
      answering({ "/api/v2/summary.json": SUMMARY }),
    );
    const dead = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    await refreshVendors(CONFIG, VENDOR_REFRESH_MS, dead);
    expect(vendorView(URL_, null, VENDOR_REFRESH_MS).state).toBe("degraded");
    expect(vendorView(URL_, null, VENDOR_STALE_MS + 1)).toMatchObject({
      state: null,
      problem: "could not be read",
    });
  });
});
