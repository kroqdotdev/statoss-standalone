import type Database from "better-sqlite3";
import type { MonitorView } from "@/components/MonitorSection";
import { errorBudget, monthTotals, type ErrorBudget } from "./budget";
import { cached, cachedFor } from "./cache";
import {
  getConfig,
  LATENCY_TYPES,
  type AppConfig,
  type SiteConfig,
} from "./config";
import { autoIncidents, getDb, getState, lastCheckOk } from "./db";
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
  rollupSeries,
  rollupSummary,
  windowSummary,
} from "./queries";
import { RANGE_TTL_MS, RANGES, type RangeKey } from "./ranges";
import type { MonitorStatus } from "./state";

const DAY_MS = 24 * 60 * 60 * 1000;

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
    status: state?.status ?? "unknown",
    since: state?.since ?? null,
    ...data,
    last24h,
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
