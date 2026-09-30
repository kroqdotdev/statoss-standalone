import type Database from "better-sqlite3";
import type { MonitorView } from "@/components/MonitorSection";
import { cached } from "./cache";
import {
  getConfig,
  LATENCY_TYPES,
  type AppConfig,
  type SiteConfig,
} from "./config";
import { autoIncidents, getDb, getState } from "./db";
import { readIncidentFiles } from "./incident-files";
import {
  autoIncidentView,
  INCIDENT_HISTORY_DAYS,
  maintenanceView,
  splitIncidents,
  type SiteIncidents,
} from "./incidents";
import {
  bucketSeries,
  failureRuns,
  rangeWindow,
  windowSummary,
} from "./queries";
import { RANGES, type RangeKey } from "./ranges";
import type { MonitorStatus } from "./state";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Everything the page shows for one monitor. The aggregate queries scan
 * the whole window, so they are computed once per scheduler tick and shared
 * by every request until new checks land.
 */
export function monitorView(
  db: Database.Database,
  site: SiteConfig,
  cp: SiteConfig["monitors"][number],
  range: RangeKey,
  now: number,
): MonitorView {
  const spec = RANGES[range];
  const { start, end } = rangeWindow(spec, now);
  const state = getState(db, site.name, cp.name);
  const threshold = cp.slowThresholdMs ?? null;
  const data = cached(`${site.name}\0${cp.name}\0${range}`, () => ({
    buckets: bucketSeries(db, site.name, cp.name, spec, now, threshold),
    summary: windowSummary(db, site.name, cp.name, start, end, threshold),
    runs: failureRuns(db, site.name, cp.name, start, end),
    last24h: windowSummary(
      db,
      site.name,
      cp.name,
      now - DAY_MS,
      now + 1,
      threshold,
    ),
  }));
  return {
    name: cp.name,
    type: cp.type,
    timed: LATENCY_TYPES.has(cp.type),
    expiresAt: state?.expiresAt ?? null,
    group: cp.group ?? null,
    slowThresholdMs: threshold,
    status: state?.status ?? "unknown",
    since: state?.since ?? null,
    ...data,
  };
}

/** The current status of every monitor on a site, in page order. */
export function monitorStatuses(
  db: Database.Database,
  site: SiteConfig,
): MonitorStatus[] {
  return site.monitors.map(
    (cp) => getState(db, site.name, cp.name)?.status ?? "unknown",
  );
}

/**
 * A site's incidents from all three sources: files in the incidents folder,
 * maintenance windows in the configuration, and outages the checker opened.
 */
export function siteIncidents(
  db: Database.Database,
  config: AppConfig,
  site: SiteConfig,
  now: number,
): SiteIncidents {
  const since = now - INCIDENT_HISTORY_DAYS * DAY_MS;
  const views = [
    ...(readIncidentFiles(config).get(site.name) ?? []),
    ...site.maintenance.map((window) => maintenanceView(window)),
    ...cached(`incidents\0${site.name}`, () =>
      autoIncidents(db, site.name, since).map(autoIncidentView),
    ),
  ];
  return splitIncidents(views, now);
}

/** The live pieces the route handlers need for a site. */
export function liveSite(site: SiteConfig, now: number) {
  const db = getDb();
  const config = getConfig();
  return {
    statuses: monitorStatuses(db, site),
    incidents: siteIncidents(db, config, site, now),
  };
}
