import type Database from "better-sqlite3";
import type { VendorEvent } from "./alerts";
import {
  siteDestinations,
  siteSendsVendorAlerts,
  siteUrl,
  type AppConfig,
  type ComponentState,
  type Destination,
} from "./config";
import {
  deleteVendorState,
  getVendorState,
  setVendorState,
  vendorStates,
} from "./db";
import { vendorView } from "./vendors";

/**
 * Alerts for components that follow a vendor's status page. What each one
 * was last told is kept in the database, so a change is told once and a
 * restart repeats nothing. The first reading of a component only notes the
 * vendor's state: you have just pointed it at the vendor and know. A vendor
 * that cannot be read, or a part that is gone from its page, says nothing
 * new; the next reading is compared with the last one that did.
 */

/** The channels a person reads. A pager or a webhook is for your own outages. */
export function toldOfVendors(d: Destination): boolean {
  return "email" in d || "slack" in d || "discord" in d || "ntfy" in d;
}

export interface VendorAlert {
  destinations: Destination[];
  event: VendorEvent;
}

const key = (site: string, component: string) => `${site}\0${component}`;

/**
 * Notes what each vendor component's vendor says now, and returns an alert
 * for every one that moved since it was last noted and whose site wants to
 * hear of it. Forgets the components that no longer follow a vendor.
 */
export function vendorAlerts(
  config: Pick<AppConfig, "alerts" | "sites">,
  db: Database.Database,
  now: number,
): VendorAlert[] {
  const out: VendorAlert[] = [];
  const followed = new Set<string>();
  for (const site of config.sites) {
    const destinations = siteSendsVendorAlerts(config, site)
      ? siteDestinations(config, site).filter(toldOfVendors)
      : [];
    for (const c of site.components) {
      if (!c.vendor) continue;
      followed.add(key(site.name, c.name));
      const part = c.part ?? null;
      const view = vendorView(c.vendor, part, now);
      if (view.state === null) continue;
      const before = getVendorState(db, site.name, c.name);
      const same = before?.vendor === c.vendor && before.part === part;
      if (same && before.state === view.state) continue;
      setVendorState(db, {
        site: site.name,
        component: c.name,
        vendor: c.vendor,
        part,
        state: view.state,
        since: now,
      });
      if (!same || destinations.length === 0) continue;
      out.push({
        destinations,
        event: {
          kind: "vendor-changed",
          site: site.name,
          component: c.name,
          pageUrl: siteUrl(site),
          vendor: {
            name: view.name,
            url: view.url,
            part,
            state: view.state,
            incidents: view.incidents.slice(0, 3),
          },
          since: before.since,
          stateSince: now,
          now,
        },
      });
    }
  }
  for (const row of vendorStates(db))
    if (!followed.has(key(row.site, row.component)))
      deleteVendorState(db, row.site, row.component);
  return out;
}

/**
 * Whether a vendor alert is still true, asked before a retry: a vendor
 * that has moved again since says something else now.
 */
export function vendorAlertHolds(
  db: Database.Database,
  event: Pick<VendorEvent, "site" | "component" | "stateSince"> & {
    vendor: { state: ComponentState };
  },
): boolean {
  const row = getVendorState(db, event.site, event.component);
  return row?.state === event.vendor.state && row.since === event.stateSince;
}
