import {
  HISTORY_DAYS,
  type MaintenanceConfig,
  type SiteConfig,
} from "./config";
import { localDate } from "./format";
import { maintenanceId, maintenanceView, type IncidentView } from "./incidents";
import { startsBetween } from "./repeats";

/**
 * A site's maintenance windows as they fall. A window in the configuration
 * stands for itself; one with `repeat` also stands for each repeat after
 * it. A repeat is planned a week before it starts: from then on it is
 * shown, announced and given a page like a window written by hand. Each
 * has the id a written window would have, from its start and title, so
 * feeds, notices and pages never take one for another.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far ahead the repeats of a window are planned. */
export const PLAN_AHEAD_MS = 7 * DAY_MS;

/** How far back repeats are kept, like the hourly totals. */
export const REPEATS_BACK_MS = HISTORY_DAYS * DAY_MS;

/** One window as it falls: one written in the configuration, or a repeat. */
export interface MaintenanceWindow {
  title: string;
  start: number;
  end: number;
  monitors?: string[];
  notes?: string;
  /** Written in the configuration, rather than a repeat of one that is. */
  written: boolean;
}

/**
 * The windows that end after `from`: each written one, however far ahead,
 * and the repeats that start up to `ahead` from now, none older than
 * REPEATS_BACK_MS. Two with one id (a title, starting in one minute) are
 * one window, and a written one comes before a repeat. Oldest first.
 */
export function maintenanceWindows(
  list: MaintenanceConfig[],
  zone: string,
  now: number,
  range: { from?: number; ahead?: number } = {},
): MaintenanceWindow[] {
  const from = range.from ?? 0;
  const until = now + (range.ahead ?? PLAN_AHEAD_MS);
  const out: MaintenanceWindow[] = [];
  const seen = new Set<string>();
  const add = (
    window: MaintenanceConfig,
    start: number,
    end: number,
    written: boolean,
  ) => {
    if (end <= from) return;
    const id = maintenanceId({ title: window.title, start });
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      title: window.title,
      start,
      end,
      ...(window.monitors ? { monitors: window.monitors } : {}),
      ...(window.notes !== undefined ? { notes: window.notes } : {}),
      written,
    });
  };
  for (const window of list) add(window, window.start, window.end, true);
  for (const window of list) {
    if (!window.repeat) continue;
    const length = window.end - window.start;
    // Starts after this end after `from`; the window as written is not a repeat.
    const after = Math.max(
      from - length,
      now - REPEATS_BACK_MS - length,
      window.start,
    );
    const starts = startsBetween(
      { repeat: window.repeat, zone, firstStartsAt: window.start },
      after,
      until,
    );
    for (const start of starts) {
      if (window.until !== undefined && localDate(start, zone) > window.until)
        break;
      add(window, start, start + length, false);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Every maintenance window of a site as the page has it: written ones,
 * and repeats from 400 days back to a week ahead, ending after `from`.
 */
export function siteMaintenanceViews(
  site: Pick<SiteConfig, "maintenance" | "timezone">,
  now: number,
  from = 0,
): IncidentView[] {
  return maintenanceWindows(site.maintenance, site.timezone, now, {
    from,
  }).map(maintenanceView);
}

/** Whether a monitor is inside one of its site's maintenance windows. */
export function inMaintenance(
  list: MaintenanceConfig[],
  monitor: string,
  now: number,
  zone = "UTC",
): boolean {
  return maintenanceWindows(list, zone, now, { from: now, ahead: 0 }).some(
    (w) =>
      w.start <= now &&
      (w.monitors === undefined || w.monitors.includes(monitor)),
  );
}
