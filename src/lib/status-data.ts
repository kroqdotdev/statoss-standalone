import type Database from "better-sqlite3";
import type { StripSpan } from "@/components/CheckStrip";
import type { MonitorView } from "@/components/MonitorSection";
import { errorBudget, monthTotals, type ErrorBudget } from "./budget";
import { cached, cachedFor } from "./cache";
import { componentBuckets } from "./component-history";
import { vendorView, type VendorView } from "./vendors";
import {
  getConfig,
  LATENCY_TYPES,
  monitorIntervalSeconds,
  type AppConfig,
  type ComponentState,
  type SiteConfig,
} from "./config";
import { autoIncidents, getDb, getState, lastCheckOk } from "./db";
import { readIncidentFiles } from "./incident-files";
import {
  autoIncidentView,
  maintenanceView,
  PAGE_INCIDENT_DAYS,
  splitIncidents,
  type IncidentView,
  type SiteIncidents,
} from "./incidents";
import {
  type Bucket,
  bucketSeries,
  failureRuns,
  rangeWindow,
  rollupSeries,
  rollupSummary,
  windowSummary,
} from "./queries";
import { RANGE_TTL_MS, RANGES, type RangeKey } from "./ranges";
import { checkLate, type MonitorStatus } from "./state";
import {
  componentState,
  componentStatus,
  statedByName,
  type Stated,
} from "./stated";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Everything the page shows for one monitor. The last 24 hours are read
 * from the checks themselves, once per check. The longer ranges are read
 * from the hourly totals and kept for minutes, not ticks; their list of
 * failed runs comes from the checks, as far back as those are kept, and is
 * read again as soon as the monitor's state or its latest result changes,
 * so a run never reads as ongoing after the monitor is back.
 */
export function monitorView(
  db: Database.Database,
  site: SiteConfig,
  cp: SiteConfig["monitors"][number],
  range: RangeKey,
  now: number,
  retentionDays = 90,
  checkIntervalSeconds = 60,
  views: IncidentView[] = [],
): MonitorView {
  const spec = RANGES[range];
  const { start, end } = rangeWindow(spec, now);
  const state = getState(db, site.name, cp.name);
  const threshold = cp.slowThresholdMs ?? null;
  const key = `${site.name}\0${cp.name}`;
  const last24h = cached(`${key}\0day`, () =>
    windowSummary(db, site.name, cp.name, now - DAY_MS, now + 1, threshold),
  );
  const runsSince = Math.max(start, now - retentionDays * DAY_MS);
  const data =
    RANGE_TTL_MS[range] === 0
      ? cached(`${key}\0${range}`, () => ({
          buckets: bucketSeries(db, site.name, cp.name, spec, now, threshold),
          summary: windowSummary(db, site.name, cp.name, start, end, threshold),
          runs: failureRuns(db, site.name, cp.name, start, end),
        }))
      : cachedFor(
          `${key}\0${range}`,
          `${end}\0${state?.status}\0${state?.since}\0${lastCheckOk(db, site.name, cp.name)}`,
          RANGE_TTL_MS[range],
          () => ({
            buckets: rollupSeries(db, site.name, cp.name, spec, now),
            summary: rollupSummary(db, site.name, cp.name, start, end),
            runs: failureRuns(db, site.name, cp.name, runsSince, end),
          }),
          now,
        );
  return {
    name: cp.name,
    type: cp.type,
    timed: LATENCY_TYPES.has(cp.type),
    expiresAt: state?.expiresAt ?? null,
    group: cp.group ?? null,
    slowThresholdMs: threshold,
    ...liveStatus(db, { checkIntervalSeconds }, site, cp, now),
    since: state?.since ?? null,
    ...data,
    last24h,
    spans: stripSpans(views, cp.name, start, end),
  };
}

/** A site's error budget for the month so far, or null without a target. */
export function siteBudget(
  db: Database.Database,
  site: SiteConfig,
  now: number,
): ErrorBudget | null {
  if (site.uptimeTarget === undefined) return null;
  const target = site.uptimeTarget;
  return cached(`budget\0${site.name}`, () =>
    errorBudget(
      monthTotals(
        db,
        site.name,
        site.monitors.map((m) => m.name),
        now,
      ),
      target,
      now,
    ),
  );
}

/**
 * The incidents and windows somebody wrote that touch a row inside a
 * window, for naming on the bars. One that names no rows covers them all.
 * Outages the checker opened are left out: the bar already shows them.
 */
export function stripSpans(
  views: IncidentView[],
  name: string,
  start: number,
  end: number,
): StripSpan[] {
  return views
    .filter((v) => {
      if (v.auto) return false;
      if (v.monitors.length > 0 && !v.monitors.includes(name)) return false;
      const to = v.kind === "maintenance" ? v.endsAt : v.resolvedAt;
      return v.startedAt < end && (to === null || to > start);
    })
    .map((v) => ({
      title: v.title,
      maintenance: v.kind === "maintenance",
      from: v.startedAt,
      to: v.kind === "maintenance" ? v.endsAt : v.resolvedAt,
    }));
}

/** A component as the page shows it. */
export interface ComponentView {
  name: string;
  group: string | null;
  description: string | null;
  state: ComponentState;
  /** The states it was in over the range, as bars. Absent when not asked for. */
  buckets?: Bucket[];
  spans?: StripSpan[];
  /** Set when it follows a vendor's status page. */
  vendor?: VendorView;
}

export interface SiteRows {
  monitors: MonitorView[];
  components: ComponentView[];
  /** What open incidents and maintenance say about each row, by name. */
  stated: Map<string, Stated>;
}

/** A site's components, each in the worse of its own state and an open incident's. */
export function componentViews(
  site: SiteConfig,
  stated: Map<string, Stated>,
  /** With this, each component gets the strip of its states over the range. */
  history?: {
    db: Database.Database;
    views: IncidentView[];
    range: RangeKey;
    now: number;
  },
): ComponentView[] {
  // The clock is read only when a component follows a vendor.
  const at = history?.now ?? Date.now();
  return site.components.map((c) => {
    const vendor = c.vendor
      ? vendorView(c.vendor, c.part ?? null, at)
      : undefined;
    const view: ComponentView = {
      name: c.name,
      group: c.group ?? null,
      description: c.description ?? null,
      // The vendor's state, or the configured one while it cannot be read;
      // an incident of our own that names it can still say worse.
      state: componentState(vendor?.state ?? c.state, stated.get(c.name)),
      ...(vendor ? { vendor } : {}),
    };
    // A vendor's row is compact and draws no strip.
    if (!history || vendor) return view;
    const spec = RANGES[history.range];
    const { start, end } = rangeWindow(spec, history.now);
    return {
      ...view,
      buckets: componentBuckets(
        history.db,
        site.name,
        c.name,
        history.views,
        spec,
        history.now,
      ),
      spans: stripSpans(history.views, c.name, start, end),
    };
  });
}

/** Every name on a site that an incident or a window can cover. */
export function rowNames(site: SiteConfig): string[] {
  return [
    ...site.monitors.map((m) => m.name),
    ...site.components.map((c) => c.name),
  ];
}

/**
 * A monitor's status as the checks have it, or "unknown" once they have
 * stopped arriving: an old state is not shown as the current one.
 */
export function liveStatus(
  db: Database.Database,
  config: Pick<AppConfig, "checkIntervalSeconds">,
  site: SiteConfig,
  cp: SiteConfig["monitors"][number],
  now: number,
): { status: MonitorStatus; stale: boolean; checkedAt: number | null } {
  const state = getState(db, site.name, cp.name);
  const stale =
    state !== undefined &&
    checkLate(
      state.checkedAt,
      monitorIntervalSeconds(cp, config.checkIntervalSeconds),
      now,
    );
  return {
    status: stale ? "unknown" : (state?.status ?? "unknown"),
    stale,
    checkedAt: state?.checkedAt ?? null,
  };
}

/**
 * The statuses the headline, the badge and status.json's site status are
 * made from: every monitor's checks, and every component's state.
 */
export function siteStatuses(
  db: Database.Database,
  config: AppConfig,
  site: SiteConfig,
  current: IncidentView[],
  now: number,
): MonitorStatus[] {
  const stated = statedByName(current, rowNames(site), now);
  return [
    ...site.monitors.map((cp) => liveStatus(db, config, site, cp, now).status),
    // A vendor's trouble is the vendor's: it is shown, not counted.
    ...componentViews(site, stated)
      .filter((c) => !c.vendor)
      .map((c) => componentStatus(c.state)),
  ];
}

/**
 * Every incident and window of a site, from all three sources: files in
 * the incidents folder, maintenance windows in the configuration, and
 * outages the checker opened (open ones, and those started after `since`).
 */
export function siteIncidentViews(
  db: Database.Database,
  config: AppConfig,
  site: SiteConfig,
  since: number,
  /** Which window `since` is, for the cache: the page's and the feeds' differ. */
  window = since === 0 ? "all" : String(since),
): IncidentView[] {
  return [
    ...(readIncidentFiles(config).get(site.name) ?? []),
    ...site.maintenance.map((window) => maintenanceView(window)),
    ...cached(`incidents\0${site.name}\0${window}`, () =>
      autoIncidents(db, site.name, since).map(autoIncidentView),
    ),
  ];
}

/** What the page shows: current, and the last `days` of past ones. */
export function siteIncidents(
  db: Database.Database,
  config: AppConfig,
  site: SiteConfig,
  now: number,
  days = PAGE_INCIDENT_DAYS,
): SiteIncidents {
  // Rounded to the hour, so the cached list is not thrown away each request.
  const since = Math.floor((now - days * DAY_MS) / HOUR_MS) * HOUR_MS;
  return splitIncidents(
    siteIncidentViews(db, config, site, since, `${days}d`),
    now,
    days,
  );
}

/** One incident or window by its id, or undefined. */
export function findIncident(
  db: Database.Database,
  config: AppConfig,
  site: SiteConfig,
  id: string,
): IncidentView | undefined {
  return siteIncidentViews(db, config, site, 0).find((v) => v.id === id);
}

/** The live pieces the route handlers need for a site. */
export function liveSite(site: SiteConfig, now: number, days?: number) {
  const db = getDb();
  const config = getConfig();
  const incidents = siteIncidents(db, config, site, now, days);
  return {
    statuses: siteStatuses(db, config, site, incidents.current, now),
    incidents,
  };
}
