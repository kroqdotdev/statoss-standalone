import { timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { findSiteByHost, getConfig } from "./config";
import { bumpDataVersion } from "./data-version";
import { getDb, recordHeartbeat } from "./db";
import { FEED_DAYS, openImpacts } from "./incidents";
import {
  badgeJson,
  badgeSvg,
  feedAtom,
  feedXml,
  statusJson,
  widgetJs,
} from "./public-feeds";
import { pageOverall } from "./state";
import { liveSite, siteBudget } from "./status-data";

/**
 * The route handlers that live next to a status page: status.json, the
 * badge, the feed and the widget. Each picks the site by the Host header,
 * like the page itself.
 */

const CORS = { "access-control-allow-origin": "*" };

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

async function currentSite() {
  return findSiteByHost(getConfig(), (await headers()).get("host"));
}

function label(request: Request): string {
  return (new URL(request.url).searchParams.get("label") ?? "status").slice(
    0,
    40,
  );
}

export async function statusJsonResponse(): Promise<Response> {
  const site = await currentSite();
  if (!site) return notFound();
  const now = Date.now();
  const { incidents } = liveSite(site, now);
  return Response.json(
    statusJson(getDb(), site, incidents, now, {
      budget: siteBudget(getDb(), site, now),
      checkIntervalSeconds: getConfig().checkIntervalSeconds,
    }),
    {
      headers: { ...CORS, "cache-control": "public, max-age=30" },
    },
  );
}

async function overallNow(
  site: NonNullable<Awaited<ReturnType<typeof currentSite>>>,
) {
  const { statuses, incidents } = liveSite(site, Date.now());
  return pageOverall(statuses, openImpacts(incidents.current));
}

export async function badgeSvgResponse(request: Request): Promise<Response> {
  const site = await currentSite();
  if (!site) return notFound();
  return new Response(badgeSvg(await overallNow(site), label(request)), {
    headers: {
      ...CORS,
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}

export async function badgeJsonResponse(request: Request): Promise<Response> {
  const site = await currentSite();
  if (!site) return notFound();
  return Response.json(badgeJson(await overallNow(site), label(request)), {
    headers: { ...CORS, "cache-control": "public, max-age=60" },
  });
}

async function feed(
  build: typeof feedXml,
  contentType: string,
): Promise<Response> {
  const site = await currentSite();
  if (!site) return notFound();
  const now = Date.now();
  const { incidents } = liveSite(site, now, FEED_DAYS);
  return new Response(build(site, incidents, now), {
    headers: {
      "content-type": `${contentType}; charset=utf-8`,
      "cache-control": "public, max-age=300",
    },
  });
}

export const feedResponse = () => feed(feedXml, "application/rss+xml");
export const feedAtomResponse = () => feed(feedAtom, "application/atom+xml");

export async function widgetResponse(): Promise<Response> {
  const site = await currentSite();
  if (!site) return notFound();
  return new Response(widgetJs(), {
    headers: {
      ...CORS,
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * A job's ping for a heartbeat monitor. The token names the monitor, on
 * whichever hostname the request came in, so a job needs no Host header.
 */
export async function heartbeatResponse(token: string): Promise<Response> {
  for (const site of getConfig().sites) {
    for (const monitor of site.monitors) {
      if (monitor.type !== "heartbeat" || !monitor.token) continue;
      if (!sameToken(monitor.token, token)) continue;
      recordHeartbeat(getDb(), site.name, monitor.name, Date.now());
      bumpDataVersion();
      return new Response("ok\n", {
        headers: { "cache-control": "no-store" },
      });
    }
  }
  return notFound();
}
