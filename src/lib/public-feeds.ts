import type Database from "better-sqlite3";
import type { ErrorBudget } from "./budget";
import { siteUrl, type ComponentState, type SiteConfig } from "./config";
import { getState, type DeployRow } from "./db";
import { formatUtcStamp } from "./format";
import {
  openImpacts,
  STATUS_LABELS,
  type IncidentView,
  type SiteIncidents,
} from "./incidents";
import { windowSummary } from "./queries";
import { pageOverall, type MonitorStatus, type Overall } from "./state";
import { componentStatus, statedByName, statusWithStated } from "./stated";
import { componentViews, liveStatus, rowNames } from "./status-data";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The words and colours a badge uses for each headline state. */
export const BADGE: Record<
  Overall,
  { message: string; color: string; hex: string }
> = {
  operational: { message: "up", color: "brightgreen", hex: "#187a4f" },
  degraded: { message: "slow", color: "blue", hex: "#5b5fc7" },
  partial: { message: "partly down", color: "orange", hex: "#b8740f" },
  major: { message: "down", color: "red", hex: "#d24a32" },
  unknown: { message: "unknown", color: "lightgrey", hex: "#93a29a" },
};

export interface StatusJson {
  site: { name: string; url: string; status: Overall; updatedAt: string };
  /** The month's error budget, when the site has an uptime target. */
  budget?: {
    target: number;
    uptime: number | null;
    budgetMinutes: number;
    downMinutes: number;
    remainingMinutes: number;
  };
  monitors: Array<{
    name: string;
    type: string;
    group: string | null;
    /** The worse of what the checks say and what an open incident says. */
    status: MonitorStatus;
    since: string | null;
    /** When the last check ran. */
    lastCheckedAt: string | null;
    /** True when the checks have stopped arriving; the status is then unknown. */
    stale: boolean;
    /** Certificate and domain monitors: when it expires. */
    expiresAt: string | null;
    uptime24h: number | null;
    latencyMs24h: number | null;
  }>;
  /** The same list under its name before 0.2, so older scripts keep working. */
  checkpoints: StatusJson["monitors"];
  components: Array<{
    name: string;
    group: string | null;
    status: ComponentState;
    /**
     * The vendor status page it follows, when it does. A component with a
     * vendor does not count toward site.status.
     */
    vendor?: string;
  }>;
  /** The latest deploy markers, newest first. */
  deploys?: Array<{ version: string; at: string; url: string | null }>;
  incidents: IncidentView[];
  maintenance: IncidentView[];
}

/** Everything a program needs to know about a site right now. */
export function statusJson(
  db: Database.Database,
  site: SiteConfig,
  incidents: SiteIncidents,
  now: number,
  options: {
    budget?: ErrorBudget | null;
    checkIntervalSeconds?: number;
    deploys?: DeployRow[];
  } = {},
): StatusJson {
  const { budget = null, checkIntervalSeconds = 60, deploys = [] } = options;
  const stated = statedByName(incidents.current, rowNames(site), now);
  const live = site.monitors.map((cp) =>
    liveStatus(db, { checkIntervalSeconds }, site, cp, now),
  );
  const monitors = site.monitors.map((cp, i) => {
    const state = getState(db, site.name, cp.name);
    const day = windowSummary(
      db,
      site.name,
      cp.name,
      now - DAY_MS,
      now + 1,
      cp.slowThresholdMs ?? null,
    );
    return {
      name: cp.name,
      type: cp.type,
      group: cp.group ?? null,
      status: statusWithStated(live[i].status, stated.get(cp.name)),
      since: state ? new Date(state.since).toISOString() : null,
      lastCheckedAt: live[i].checkedAt
        ? new Date(live[i].checkedAt).toISOString()
        : null,
      stale: live[i].stale,
      expiresAt: state?.expiresAt
        ? new Date(state.expiresAt).toISOString()
        : null,
      uptime24h:
        day.total === 0 ? null : Math.round((day.up / day.total) * 10000) / 100,
      latencyMs24h: day.latencyMs,
    };
  });
  const components = componentViews(site, stated);
  return {
    site: {
      name: site.name,
      url: siteUrl(site),
      // The checks and the incidents' impacts, as the headline and the
      // badge read them; a row's stated state shows on the row.
      status: pageOverall(
        [
          ...live.map((l) => l.status),
          ...components
            .filter((c) => !c.vendor)
            .map((c) => componentStatus(c.state)),
        ],
        openImpacts(incidents.current),
      ),
      updatedAt: new Date(now).toISOString(),
    },
    ...(budget
      ? {
          budget: {
            target: budget.target,
            uptime:
              budget.uptime === null
                ? null
                : Math.floor(budget.uptime * 100) / 100,
            budgetMinutes: Math.round(budget.budgetMinutes * 100) / 100,
            downMinutes: Math.round(budget.downMinutes * 100) / 100,
            remainingMinutes: Math.round(budget.remainingMinutes * 100) / 100,
          },
        }
      : {}),
    monitors,
    checkpoints: monitors,
    components: components.map((c) => ({
      name: c.name,
      group: c.group,
      status: c.state,
      ...(c.vendor ? { vendor: c.vendor.url } : {}),
    })),
    ...(deploys.length > 0
      ? {
          deploys: deploys.map((d) => ({
            version: d.version,
            at: new Date(d.at).toISOString(),
            url: d.url,
          })),
        }
      : {}),
    incidents: incidents.current.filter((i) => i.kind === "incident"),
    maintenance: incidents.current.filter((i) => i.kind === "maintenance"),
  };
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Rough text width in Verdana 11px, the badge font. */
function textWidth(text: string): number {
  return Math.round(text.length * 6.4 + 10);
}

/** A flat badge in the shields.io style: "<label> | <message>". */
export function badgeSvg(overall: Overall, label = "status"): string {
  const { message, hex } = BADGE[overall];
  const lw = textWidth(label);
  const mw = textWidth(message);
  const w = lw + mw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${escapeXml(label)}: ${escapeXml(message)}">
<title>${escapeXml(label)}: ${escapeXml(message)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${hex}"/><rect width="${w}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text><text x="${lw / 2}" y="14">${escapeXml(label)}</text>
<text x="${lw + mw / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(message)}</text><text x="${lw + mw / 2}" y="14">${escapeXml(message)}</text>
</g></svg>`;
}

/** The shields.io endpoint format, so a README can style the badge itself. */
export function badgeJson(overall: Overall, label = "status") {
  const { message, color } = BADGE[overall];
  return { schemaVersion: 1, label, message, color };
}

/**
 * One feed entry's words, shared by RSS and Atom: the title, when it was
 * last touched, and a body that carries what the page shows. A planned
 * window says when it is; every update carries its status word; a
 * post-mortem comes last, and a planned window is dated by when the feed
 * first had it, not by a start in the future.
 */
export function feedEntry(
  view: IncidentView,
  now: number,
): { title: string; stamp: number; published: number; body: string } {
  const ahead = view.startedAt > now;
  const latest = view.kind === "incident" ? view.updates[0] : undefined;
  const stamp =
    latest?.createdAt ??
    (view.kind === "maintenance" && view.endsAt !== null && view.endsAt <= now
      ? view.endsAt
      : ahead
        ? now
        : view.startedAt);
  const title = `${view.kind === "maintenance" ? "Maintenance: " : ""}${view.title}`;
  const lines: string[] = [];
  if (view.kind === "maintenance" && view.endsAt !== null)
    lines.push(
      `${view.endsAt <= now ? "Was planned" : "Planned"} ${formatUtcStamp(view.startedAt)} to ${formatUtcStamp(view.endsAt)}.`,
    );
  if (view.monitors.length > 0)
    lines.push(`Affects ${view.monitors.join(", ")}.`);
  for (const u of view.updates.slice().reverse())
    lines.push(
      view.kind === "maintenance"
        ? u.body
        : `${formatUtcStamp(u.createdAt)}, ${STATUS_LABELS[u.status]}: ${u.body}`,
    );
  if (view.postmortem) lines.push(`Post-mortem: ${view.postmortem}`);
  return {
    title,
    stamp,
    published: ahead ? stamp : view.startedAt,
    body: lines.join("\n\n"),
  };
}

function feedItems(incidents: SiteIncidents): IncidentView[] {
  return [...incidents.current, ...incidents.past].sort(
    (a, b) => b.startedAt - a.startedAt,
  );
}

/** Where one incident or window has its own page. */
export function incidentUrl(site: SiteConfig, id: string): string {
  return `${siteUrl(site).replace(/\/$/, "")}/incidents/${encodeURIComponent(id)}`;
}

/** An RSS 2.0 feed of the site's incidents and maintenance, newest first. */
export function feedXml(
  site: SiteConfig,
  incidents: SiteIncidents,
  now: number,
): string {
  const url = siteUrl(site);
  const entries = feedItems(incidents)
    .map((view) => {
      const { title, stamp, body } = feedEntry(view, now);
      return `<item>
<title>${escapeXml(title)}</title>
<link>${escapeXml(incidentUrl(site, view.id))}</link>
<guid isPermaLink="false">${escapeXml(`urn:statoss:incident:${view.id}`)}</guid>
<pubDate>${new Date(stamp).toUTCString()}</pubDate>
<description>${escapeXml(body)}</description>
</item>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>${escapeXml(site.name)} status</title>
<link>${escapeXml(url)}</link>
<description>Incidents and maintenance on ${escapeXml(site.name)}</description>
<lastBuildDate>${new Date(now).toUTCString()}</lastBuildDate>
${entries}
</channel>
</rss>`;
}

/** The same incidents as an Atom feed, for readers that want one. */
export function feedAtom(
  site: SiteConfig,
  incidents: SiteIncidents,
  now: number,
): string {
  const url = siteUrl(site).replace(/\/$/, "");
  const entries = feedItems(incidents)
    .map((view) => {
      const { title, stamp, published, body } = feedEntry(view, now);
      return `<entry>
<title>${escapeXml(title)}</title>
<link href="${escapeXml(incidentUrl(site, view.id))}"/>
<id>${escapeXml(`urn:statoss:incident:${view.id}`)}</id>
<published>${new Date(published).toISOString()}</published>
<updated>${new Date(stamp).toISOString()}</updated>
<content type="text">${escapeXml(body)}</content>
</entry>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>${escapeXml(site.name)} status</title>
<link href="${escapeXml(url)}"/>
<link rel="self" href="${escapeXml(`${url}/feed.atom`)}"/>
<id>${escapeXml(`urn:statoss:site:${site.host.toLowerCase()}`)}</id>
<author><name>${escapeXml(site.name)}</name></author>
<updated>${new Date(now).toISOString()}</updated>
${entries}
</feed>`;
}

/**
 * A script tag that draws a dot, a few words and a link where it is placed.
 * It reads status.json from the same origin it was loaded from, passing on
 * a ?key= from its own address for password pages.
 */
export function widgetJs(): string {
  return `(function(){
var s=document.currentScript;if(!s||!s.parentNode)return;
var src=new URL(s.src);var base=src.origin+src.pathname.replace(/widget\\.js$/,"");
var key=src.searchParams.get("key");var q=key?"?key="+encodeURIComponent(key):"";
var el=document.createElement("a");el.href=base;el.target="_blank";el.rel="noopener";
el.style.cssText="display:inline-flex;align-items:center;gap:.5em;font:14px/1.2 system-ui,sans-serif;color:inherit;text-decoration:none;";
var dot=document.createElement("span");dot.style.cssText="display:inline-block;width:.6em;height:.6em;border-radius:50%;background:#93a29a;";
var text=document.createElement("span");text.textContent=s.getAttribute("data-loading")||"Checking status";
el.appendChild(dot);el.appendChild(text);s.parentNode.insertBefore(el,s);
var words={operational:"All systems up",degraded:"Running slowly",partial:"Partly down",major:"Down",unknown:"Status unknown"};
var colors={operational:"#187a4f",degraded:"#5b5fc7",partial:"#b8740f",major:"#d24a32",unknown:"#93a29a"};
function load(){fetch(base+"status.json"+q,{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){
var st=d.site.status;dot.style.background=colors[st]||colors.unknown;
text.textContent=s.getAttribute("data-"+st)||words[st]||words.unknown;}).catch(function(){});}
load();setInterval(load,60000);
})();`;
}
