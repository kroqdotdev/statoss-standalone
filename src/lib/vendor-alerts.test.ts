import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeVendor } from "./alerts";
import { parseConfig } from "./config";
import { getVendorState, openDb } from "./db";
import {
  forgetUnfollowedVendors,
  vendorAlertHolds,
  vendorAlerts,
} from "./vendor-alerts";
import {
  clearVendors,
  refreshVendors,
  VENDOR_REFRESH_MS,
  VENDOR_STALE_MS,
} from "./vendors";

const URL_ = "https://status.acme.example";
const MIN = 60_000;

function summary(api: string, dashboard = "operational") {
  return {
    page: { name: "Acme Status" },
    status: {
      indicator:
        api === "major_outage"
          ? "critical"
          : api === "operational"
            ? "none"
            : "minor",
    },
    components: [
      { name: "REST API", status: api },
      { name: "Dashboard", status: dashboard },
    ],
    incidents:
      api === "operational"
        ? []
        : [
            {
              name: "Elevated errors",
              status: "investigating",
              shortlink: "https://stspg.io/abc",
              components: [{ name: "REST API" }],
            },
          ],
  };
}

function answering(body: unknown) {
  return vi.fn(async (input: string | URL | Request) =>
    new URL(String(input)).pathname === "/api/v2/summary.json"
      ? Response.json(body)
      : new Response("no", { status: 404 }),
  ) as unknown as typeof fetch;
}

const DESTINATIONS = `
  to:
    - email: ops@example.com
    - slack: https://hooks.slack.com/x
    - discord: https://discord.com/api/webhooks/y
    - ntfy: https://ntfy.sh/ops
    - telegram: "-1001234567890"
      token: 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw
    - pushover: uQiRzpo4DXghDmr9QzzfQu27cmVRsG
      token: azGDORePK8gMaC0QOYAMyEEuzJnyUi
    - teams: https://prod-12.westeurope.logic.azure.com/workflows/0a1b2c/triggers/manual/paths/invoke?sig=s1g
    - webhook: https://example.com/hook
      secret: s3cret
    - pagerduty: R0UT1NG
    - opsgenie: KEY`;

const config = (alerts = "", site = "", components = "") =>
  parseConfig(`
alerts:
  smtp:
    host: h
    port: 587
    user: u
    from: f@example.com
${DESTINATIONS}
${alerts}
sites:
  - name: shop
    host: status.shop.example
${site}
    components:
      - name: Acme API
        vendor: ${URL_}
        part: REST API
      - name: Acme
        vendor: ${URL_}
      - name: Own thing
${components}
`);

/** Reads the vendor with this answer, as the scheduler's round does. */
async function read(at: number, body: unknown) {
  await refreshVendors(CONFIG, at, answering(body));
}

const CONFIG = config();

describe("alerts when a vendor changes state", () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    clearVendors();
    db = openDb(":memory:");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("notes the first reading without a word, then tells a change to email, Slack, Discord, ntfy, Telegram, Pushover and Teams", async () => {
    await read(0, summary("partial_outage"));
    expect(vendorAlerts(CONFIG, db, 0)).toEqual([]);
    expect(getVendorState(db, "shop", "Acme API")).toMatchObject({
      state: "degraded",
      since: 0,
    });
    const later = VENDOR_REFRESH_MS;
    await read(later, summary("major_outage"));
    const alerts = vendorAlerts(CONFIG, db, later);
    expect(alerts.map((a) => a.event.component)).toEqual(["Acme API", "Acme"]);
    expect(alerts[0].destinations).toEqual([
      { email: "ops@example.com" },
      { slack: "https://hooks.slack.com/x" },
      { discord: "https://discord.com/api/webhooks/y" },
      { ntfy: "https://ntfy.sh/ops" },
      {
        telegram: "-1001234567890",
        token: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
      },
      {
        pushover: "uQiRzpo4DXghDmr9QzzfQu27cmVRsG",
        token: "azGDORePK8gMaC0QOYAMyEEuzJnyUi",
      },
      {
        teams:
          "https://prod-12.westeurope.logic.azure.com/workflows/0a1b2c/triggers/manual/paths/invoke?sig=s1g",
      },
    ]);
    expect(alerts[0].event).toEqual({
      kind: "vendor-changed",
      site: "shop",
      component: "Acme API",
      pageUrl: "https://status.shop.example",
      vendor: {
        name: "Acme",
        url: URL_,
        part: "REST API",
        state: "major",
        incidents: [{ name: "Elevated errors", url: "https://stspg.io/abc" }],
      },
      since: 0,
      stateSince: later,
      now: later,
    });
    expect(describeVendor(alerts[0].event).subject).toBe(
      "shop: Acme REST API reports an outage",
    );
  });

  it("says nothing while the vendor says the same, nor after a restart", async () => {
    await read(0, summary("partial_outage"));
    vendorAlerts(CONFIG, db, 0);
    await read(VENDOR_REFRESH_MS, summary("partial_outage"));
    expect(vendorAlerts(CONFIG, db, VENDOR_REFRESH_MS)).toEqual([]);
    // A restart reads every page again; the database remembers.
    clearVendors();
    await read(2 * VENDOR_REFRESH_MS, summary("partial_outage"));
    expect(vendorAlerts(CONFIG, db, 2 * VENDOR_REFRESH_MS)).toEqual([]);
    // A change while the server was off is told on the first reading after.
    clearVendors();
    await read(3 * VENDOR_REFRESH_MS, summary("operational"));
    const back = vendorAlerts(CONFIG, db, 3 * VENDOR_REFRESH_MS);
    expect(back.map((a) => a.event.vendor.state)).toEqual([
      "operational",
      "operational",
    ]);
  });

  it("says nothing while the vendor cannot be read, and compares the next reading with the last", async () => {
    await read(0, summary("major_outage"));
    vendorAlerts(CONFIG, db, 0);
    const dead = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const stale = VENDOR_STALE_MS + MIN;
    await refreshVendors(CONFIG, stale, dead);
    expect(vendorAlerts(CONFIG, db, stale)).toEqual([]);
    expect(getVendorState(db, "shop", "Acme")?.state).toBe("major");
    const back = stale + VENDOR_REFRESH_MS;
    await read(back, summary("operational"));
    const [alert] = vendorAlerts(CONFIG, db, back);
    expect(alert.event).toMatchObject({
      component: "Acme API",
      since: 0,
      vendor: { state: "operational", incidents: [] },
    });
    expect(describeVendor(alert.event).lines[0]).toBe(
      "Acme REST API reports it working again, after 36 min. Acme API on shop shows it.",
    );
  });

  it("keeps them to the page with vendors: false, for every site or for one", async () => {
    const off = config("  vendors: false");
    await refreshVendors(off, 0, answering(summary("partial_outage")));
    vendorAlerts(off, db, 0);
    await refreshVendors(
      off,
      VENDOR_REFRESH_MS,
      answering(summary("major_outage")),
    );
    expect(vendorAlerts(off, db, VENDOR_REFRESH_MS)).toEqual([]);
    // Noted all the same, so that turning them on tells only what is new.
    expect(getVendorState(db, "shop", "Acme")?.state).toBe("major");
    const site = config("  vendors: false", "    alerts:\n      vendors: true");
    await refreshVendors(
      site,
      2 * VENDOR_REFRESH_MS,
      answering(summary("partial_outage")),
    );
    expect(vendorAlerts(site, db, 2 * VENDOR_REFRESH_MS)).toHaveLength(2);
    const quiet = config("", "    alerts: false");
    await refreshVendors(
      quiet,
      3 * VENDOR_REFRESH_MS,
      answering(summary("major_outage")),
    );
    expect(vendorAlerts(quiet, db, 3 * VENDOR_REFRESH_MS)).toEqual([]);
  });

  it("forgets a component that no longer follows a vendor, and starts afresh on another part", async () => {
    await read(0, summary("partial_outage"));
    vendorAlerts(CONFIG, db, 0);
    const moved = parseConfig(`
sites:
  - name: shop
    host: status.shop.example
    components:
      - name: Acme API
        vendor: ${URL_}
        part: Dashboard
`);
    expect(vendorAlerts(moved, db, MIN)).toEqual([]);
    expect(getVendorState(db, "shop", "Acme")).toBeUndefined();
    expect(getVendorState(db, "shop", "Acme API")).toMatchObject({
      part: "Dashboard",
      state: "operational",
      since: MIN,
    });
  });

  it("forgets them all at start once no component follows a vendor", async () => {
    await read(0, summary("partial_outage"));
    vendorAlerts(CONFIG, db, 0);
    const none = parseConfig(`
sites:
  - name: shop
    host: status.shop.example
    components:
      - name: Acme API
`);
    // No vendor is due, so no round of alerts runs: the start tidies up.
    expect(await refreshVendors(none, VENDOR_REFRESH_MS)).toBe(false);
    forgetUnfollowedVendors(none, db);
    expect(getVendorState(db, "shop", "Acme API")).toBeUndefined();
    expect(getVendorState(db, "shop", "Acme")).toBeUndefined();
    // Added again later, the first reading is quiet once more.
    await read(2 * VENDOR_REFRESH_MS, summary("major_outage"));
    expect(vendorAlerts(CONFIG, db, 2 * VENDOR_REFRESH_MS)).toEqual([]);
  });

  it("drops a retry once the vendor has moved again", async () => {
    await read(0, summary("operational"));
    vendorAlerts(CONFIG, db, 0);
    await read(VENDOR_REFRESH_MS, summary("major_outage"));
    const [alert] = vendorAlerts(CONFIG, db, VENDOR_REFRESH_MS);
    expect(vendorAlertHolds(db, alert.event)).toBe(true);
    await read(2 * VENDOR_REFRESH_MS, summary("operational"));
    vendorAlerts(CONFIG, db, 2 * VENDOR_REFRESH_MS);
    expect(vendorAlertHolds(db, alert.event)).toBe(false);
  });
});
