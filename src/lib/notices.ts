import type Database from "better-sqlite3";
import type { NoticeEvent } from "./alerts";
import { siteUrl, type SiteConfig } from "./config";
import { markNotified, wasNotified } from "./db";
import { STATUS_LABELS, type IncidentView } from "./incidents";

/**
 * Incident updates and maintenance windows, sent to a site's alert
 * destinations once each. What has been sent is kept in the database, so a
 * restart repeats nothing. An update dated more than an hour ago when it is
 * first seen is filed without a message: an incident entered once it is
 * over tells nobody, and neither does the folder as it stood before this
 * version first ran.
 */

/** How old an update may be and still be sent. */
export const NOTICE_WINDOW_MS = 60 * 60 * 1000;

interface Candidate {
  key: string;
  /** The moment the notice is about. */
  at: number;
  /**
   * What the marker is dated, which is how long it is kept: a window's
   * markers are dated by its end, so one planned far ahead is not
   * forgotten, and announced again, before it has happened.
   */
  keepFrom?: number;
  event: Omit<NoticeEvent, "site" | "pageUrl" | "now">;
}

function candidates(view: IncidentView, now: number): Candidate[] {
  const base = { id: view.id, title: view.title, monitors: view.monitors };
  if (view.kind === "maintenance") {
    const start = view.startedAt;
    const end = view.endsAt ?? start;
    const body = view.updates[0]?.body;
    const window = { ...base, start, end, body };
    const list: Candidate[] = [];
    const keepFrom = end;
    // Announced when it is first seen, whenever that is, while it is ahead.
    if (start > now)
      list.push({
        key: `${view.id}:scheduled`,
        at: now,
        keepFrom,
        event: { ...window, kind: "maintenance-scheduled", at: now },
      });
    if (start <= now)
      list.push({
        key: `${view.id}:started`,
        at: start,
        event: { ...window, kind: "maintenance-started", at: start },
      });
    if (end <= now)
      list.push({
        key: `${view.id}:ended`,
        at: end,
        event: { ...window, kind: "maintenance-ended", at: end },
      });
    return list;
  }
  // Outages the checker opened are already covered by its alerts.
  if (view.auto) return [];
  if (view.updates.length === 0)
    return view.startedAt > now
      ? []
      : [
          {
            key: `${view.id}:opened`,
            at: view.startedAt,
            event: {
              ...base,
              kind: "incident-update",
              status: STATUS_LABELS[view.status],
              at: view.startedAt,
            },
          },
        ];
  return view.updates
    .filter((u) => u.createdAt <= now)
    .map((u) => ({
      key: `${view.id}:${u.createdAt}:${u.status}`,
      at: u.createdAt,
      event: {
        ...base,
        kind: "incident-update" as const,
        status: STATUS_LABELS[u.status],
        body: u.body,
        at: u.createdAt,
      },
    }))
    .reverse();
}

/**
 * The notices that are due for a site, oldest first, each marked as sent
 * as it is returned. Anything too old to send is marked without one.
 */
export function dueNotices(
  db: Database.Database,
  site: Pick<SiteConfig, "name" | "host" | "url">,
  views: IncidentView[],
  now: number,
): NoticeEvent[] {
  const due: NoticeEvent[] = [];
  for (const view of views) {
    for (const c of candidates(view, now)) {
      if (wasNotified(db, site.name, c.key)) continue;
      markNotified(db, site.name, c.key, Math.max(now, c.keepFrom ?? now));
      if (now - c.at > NOTICE_WINDOW_MS) continue;
      due.push({ ...c.event, site: site.name, pageUrl: siteUrl(site), now });
    }
  }
  return due.sort((a, b) => a.at - b.at);
}
