import { headers } from "next/headers";
import { findSiteByHost, getConfig } from "./config";
import { getDb } from "./db";
import { openImpacts } from "./incidents";
import {
  badgeJson,
  badgeSvg,
  feedXml,
  statusJson,
  widgetJs,
} from "./public-feeds";
import { pageOverall } from "./state";
import { liveSite } from "./status-data";

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
  return Response.json(statusJson(getDb(), site, incidents, now), {
    headers: { ...CORS, "cache-control": "public, max-age=30" },
  });
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

export async function feedResponse(): Promise<Response> {
  const site = await currentSite();
  if (!site) return notFound();
  const now = Date.now();
  const { incidents } = liveSite(site, now);
  return new Response(feedXml(site, incidents, now), {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

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
